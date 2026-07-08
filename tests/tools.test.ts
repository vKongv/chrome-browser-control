import { describe, expect, it } from 'vitest';
import { BridgeAction } from '../server/protocol.js';
import { ADAPTER_PROTOCOL_VERSION, registerBrowserTools, ToolRegistrar } from '../server/tools.js';
import { buildNextAction } from '../server/status-coaching.js';

class FakeServer implements ToolRegistrar {
  tools = new Map<string, (args: any) => Promise<any>>();
  configs = new Map<string, Record<string, unknown>>();

  registerTool(name: string, _config: Record<string, unknown>, cb: (args: any) => Promise<any>): unknown {
    this.configs.set(name, _config);
    this.tools.set(name, cb);
    return undefined;
  }
}

class FakeBridge {
  calls: Array<{ action: BridgeAction; params?: Record<string, unknown> }> = [];
  connected = true;
  result: unknown = null;
  error?: Error;
  connectCalls = 0;

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.connected = true;
  }

  async call(action: BridgeAction, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ action, params });
    if (this.error) throw this.error;
    return this.result ?? { action, params };
  }
}

describe('registerBrowserTools', () => {
  it('registers the required MCP tools and returns the tool count', () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    const count = registerBrowserTools(server, bridge);

    expect(count).toBe(22);
    expect([...server.tools.keys()].sort()).toEqual([
      'browser_status',
      'claim_tab',
      'click',
      'click_at',
      'collect_scroll',
      'console_logs',
      'extract_elements',
      'extract_feed_posts',
      'finalize_tabs',
      'keypress',
      'list_tabs',
      'name_session',
      'navigate',
      'page_status',
      'query_elements',
      'release_tab',
      'screenshot',
      'scroll',
      'snapshot',
      'type',
      'visible_snapshot',
      'wait_for'
    ]);
  });

  it('forwards navigate calls to the bridge', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    registerBrowserTools(server, bridge);

    const result = await server.tools.get('navigate')?.({ url: 'https://example.com', tabId: 7 });

    expect(bridge.calls).toEqual([
      { action: 'navigate', params: { url: 'https://example.com', tabId: 7 } }
    ]);
    expect(result.content[0].text).toContain('https://example.com');
  });

  it('forwards act-then-observe after payloads to the bridge', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    registerBrowserTools(server, bridge);

    await server.tools.get('click')?.({
      ref: 'h1',
      after: {
        waitFor: { selector: '.ready', timeoutMs: 1000 },
        snapshot: { mode: 'visible', limit: 25 },
        pageStatus: true
      },
      sessionTabId: 'tab-a'
    });
    await server.tools.get('navigate')?.({
      url: 'https://example.com',
      after: { snapshot: true }
    });

    expect(bridge.calls).toEqual([
      {
        action: 'click',
        params: {
          ref: 'h1',
          after: {
            waitFor: { selector: '.ready', timeoutMs: 1000 },
            snapshot: { mode: 'visible', limit: 25 },
            pageStatus: true
          },
          sessionTabId: 'tab-a'
        }
      },
      {
        action: 'navigate',
        params: {
          url: 'https://example.com',
          after: { snapshot: true }
        }
      }
    ]);
  });

  it('adds after schema to supported act tools only', () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    registerBrowserTools(server, bridge);

    for (const tool of ['navigate', 'click', 'type', 'scroll', 'keypress', 'click_at', 'collect_scroll']) {
      const inputSchema = server.configs.get(tool)?.inputSchema as Record<string, unknown>;
      expect(inputSchema.after).toBeTruthy();
    }
    for (const tool of ['snapshot', 'query_elements', 'extract_elements', 'wait_for', 'page_status']) {
      const inputSchema = server.configs.get(tool)?.inputSchema as Record<string, unknown>;
      expect(inputSchema.after).toBeUndefined();
    }
  });

  it('forwards snapshot textLimit to the bridge', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    registerBrowserTools(server, bridge);

    await server.tools.get('snapshot')?.({ mode: 'full', textLimit: 20_000, tabId: 3 });

    expect(bridge.calls).toEqual([
      { action: 'snapshot', params: { mode: 'full', textLimit: 20_000, tabId: 3 } }
    ]);
  });

  it('forwards visible snapshot and claimed tab targets to the bridge', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    registerBrowserTools(server, bridge);

    await server.tools.get('visible_snapshot')?.({ sessionTabId: 'tab-a', limit: 25 });
    await server.tools.get('snapshot')?.({ mode: 'visible', sessionTabId: 'tab-a' });

    expect(bridge.calls).toEqual([
      { action: 'visible_snapshot', params: { sessionTabId: 'tab-a', limit: 25 } },
      { action: 'snapshot', params: { mode: 'visible', sessionTabId: 'tab-a' } }
    ]);
  });

  it('forwards query, extract, wait, diagnostics, and collect helpers', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    registerBrowserTools(server, bridge);

    await server.tools.get('query_elements')?.({ selector: 'button', visible: true, limit: 5 });
    await server.tools.get('extract_elements')?.({ selector: 'article', includeText: true });
    await server.tools.get('wait_for')?.({ text: 'Ready', timeoutMs: 1000 });
    await server.tools.get('page_status')?.({ tabId: 4 });
    await server.tools.get('console_logs')?.({ levels: ['error'], limit: 10 });
    await server.tools.get('collect_scroll')?.({
      steps: 2,
      extract: { selector: 'article', includeText: true },
      dedupeBy: 'text'
    });

    expect(bridge.calls.map((call) => call.action)).toEqual([
      'query_elements',
      'extract_elements',
      'wait_for',
      'page_status',
      'console_logs',
      'collect_scroll'
    ]);
  });

  it('rejects wait_for without a condition before calling the bridge', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    registerBrowserTools(server, bridge);

    const result = await server.tools.get('wait_for')?.({ timeoutMs: 1000 });

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'wait_for requires at least one wait condition' }]
    });
    expect(bridge.calls).toEqual([]);
  });

  it('rejects empty after.waitFor before calling the bridge', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    registerBrowserTools(server, bridge);

    const result = await server.tools.get('scroll')?.({ deltaY: 200, after: { waitFor: { timeoutMs: 1000 } } });

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'after.waitFor requires at least one wait condition' }]
    });
    expect(bridge.calls).toEqual([]);
  });

  it('rejects invalid after.snapshot before calling the bridge', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    registerBrowserTools(server, bridge);

    const result = await server.tools.get('click')?.({ ref: 'h1', after: { snapshot: false } });

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'after.snapshot must be true or an object' }]
    });
    expect(bridge.calls).toEqual([]);
  });

  it('forwards session lifecycle and coordinate/key helpers', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    registerBrowserTools(server, bridge);

    await server.tools.get('name_session')?.({ name: 'docs task' });
    await server.tools.get('claim_tab')?.({ tabId: 3 });
    await server.tools.get('click_at')?.({ x: 10, y: 20, sessionTabId: 'tab-1' });
    await server.tools.get('keypress')?.({ keys: ['Tab', 'Enter'] });
    await server.tools.get('screenshot')?.({ format: 'jpeg' });
    await server.tools.get('release_tab')?.({ sessionTabId: 'tab-1' });
    await server.tools.get('finalize_tabs')?.({ keep: [{ tabId: 3, status: 'handoff' }] });

    expect(bridge.calls.map((call) => call.action)).toEqual([
      'name_session',
      'claim_tab',
      'click_at',
      'keypress',
      'screenshot',
      'release_tab',
      'finalize_tabs'
    ]);
  });

  it('forwards type calls with force=false by default when supplied by client schema', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    registerBrowserTools(server, bridge);

    await server.tools.get('type')?.({ ref: 'e1', text: 'hello', force: false });

    expect(bridge.calls).toEqual([
      { action: 'type', params: { ref: 'e1', text: 'hello', force: false } }
    ]);
  });

  it('reports browser_status ready when broker and extension answer ping', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    bridge.result = {
      pong: true,
      status: 'connected',
      protocolVersion: 1,
      features: ['navigate-pending-warning'],
      session: { name: 'Docs task', claimedTabs: [{ sessionTabId: 'tab-1', tabId: 2 }] }
    };
    registerBrowserTools(server, bridge, {
      getStatusContext: () => ({
        adapterProtocolVersion: ADAPTER_PROTOCOL_VERSION,
        registeredToolCount: 22,
        brokerOwnership: 'adopted'
      })
    });

    const result = await server.tools.get('browser_status')?.({});
    const status = JSON.parse(result.content[0].text);

    expect(bridge.calls).toEqual([{ action: 'ping', params: {} }]);
    expect(status).toMatchObject({
      ready: true,
      adapter: { connected: true, protocolVersion: ADAPTER_PROTOCOL_VERSION, registeredToolCount: 22 },
      broker: { reachable: true, ownership: 'adopted' },
      extension: {
        connected: true,
        status: 'connected',
        protocolVersion: 1,
        features: ['navigate-pending-warning'],
        session: { name: 'Docs task', claimedTabs: [{ sessionTabId: 'tab-1', tabId: 2 }] }
      },
      ping: {
        pong: true,
        status: 'connected',
        protocolVersion: 1,
        features: ['navigate-pending-warning'],
        session: { name: 'Docs task', claimedTabs: [{ sessionTabId: 'tab-1', tabId: 2 }] }
      }
    });
    expect(status.nextAction).toBeUndefined();
  });

  it('normalizes stale disconnected ping status when the extension answers ping', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    bridge.result = { pong: true, status: 'disconnected' };
    registerBrowserTools(server, bridge);

    const result = await server.tools.get('browser_status')?.({});
    const status = JSON.parse(result.content[0].text);

    expect(status).toMatchObject({
      ready: true,
      extension: { connected: true, status: 'connected' },
      ping: { pong: true, status: 'connected' }
    });
  });

  it('reports browser_status when broker is connected but extension is absent', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    bridge.error = new Error('No Chrome extension connected to broker');
    registerBrowserTools(server, bridge, {
      getStatusContext: () => ({ registeredToolCount: 22, brokerPort: 8765 })
    });

    const result = await server.tools.get('browser_status')?.({});
    const status = JSON.parse(result.content[0].text);

    expect(status).toMatchObject({
      ready: false,
      adapter: { connected: true, protocolVersion: ADAPTER_PROTOCOL_VERSION, registeredToolCount: 22 },
      broker: { reachable: true },
      extension: { connected: false },
      error: 'No Chrome extension connected to broker'
    });
    expect(status.nextAction).toContain('extension');
  });

  it('keeps broker reachable when connect fails after ensureBroker succeeded', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    bridge.connected = false;
    bridge.connect = async () => {
      bridge.connectCalls += 1;
      throw new Error('timed out waiting for broker authentication');
    };
    registerBrowserTools(server, bridge, {
      getStatusContext: () => ({
        brokerPort: 8765,
        ensureBroker: async () => ({
          reachable: true,
          authOk: true,
          ownership: 'adopted'
        })
      })
    });

    const result = await server.tools.get('browser_status')?.({});
    const status = JSON.parse(result.content[0].text);

    expect(bridge.connectCalls).toBe(1);
    expect(status.broker.reachable).toBe(true);
    expect(status.nextAction ?? '').not.toContain('not a Chrome Browser Control broker');
  });

  it('does not coach port-not-broker for handshake timeout lifecycle errors', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    bridge.connected = false;
    registerBrowserTools(server, bridge, {
      getStatusContext: () => ({
        brokerPort: 8765,
        ensureBroker: async () => ({
          reachable: true,
          authOk: false,
          error: 'Broker on port 8765 did not respond to handshake in time'
        })
      })
    });

    const result = await server.tools.get('browser_status')?.({});
    const status = JSON.parse(result.content[0].text);

    expect(bridge.connectCalls).toBe(0);
    expect(status.broker.reachable).toBe(true);
    expect(status.nextAction ?? '').not.toContain('not a Chrome Browser Control broker');
  });

  it('reports browser_status when the adapter is not connected to the broker', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    bridge.connected = false;
    bridge.connect = async () => {
      bridge.connectCalls += 1;
      throw new Error('connect ECONNREFUSED 127.0.0.1:8765');
    };
    registerBrowserTools(server, bridge, {
      getStatusContext: () => ({
        brokerPort: 8765,
        ensureBroker: async () => ({
          reachable: false,
          authOk: false,
          autoloadTimedOut: true,
          ownership: 'spawned',
          error: 'Timed out waiting for broker at ws://127.0.0.1:8765 after autoload'
        })
      })
    });

    const result = await server.tools.get('browser_status')?.({});
    const status = JSON.parse(result.content[0].text);

    expect(bridge.connectCalls).toBe(0);
    expect(status).toMatchObject({
      ready: false,
      adapter: { connected: false, protocolVersion: ADAPTER_PROTOCOL_VERSION },
      broker: { reachable: false, ownership: 'spawned' },
      extension: { connected: false },
      error: 'Timed out waiting for broker at ws://127.0.0.1:8765 after autoload'
    });
    expect(status.nextAction).toContain('autoload timed out');
  });

  it('coaches token and auth failures through nextAction', async () => {
    expect(buildNextAction({ ready: false, tokenMissing: true, brokerReachable: false, adapterConnected: false, extensionConnected: false })).toContain(
      'npm run setup'
    );
    expect(
      buildNextAction({
        ready: false,
        authFailed: true,
        brokerReachable: true,
        adapterConnected: false,
        extensionConnected: false,
        brokerPort: 8765
      })
    ).toContain('Token mismatch');
    expect(
      buildNextAction({
        ready: false,
        brokerReachable: false,
        adapterConnected: false,
        extensionConnected: false,
        brokerPort: 8765,
        portNotBroker: true
      })
    ).toContain('not a Chrome Browser Control broker');
    expect(
      buildNextAction({
        ready: false,
        brokerReachable: true,
        adapterConnected: false,
        extensionConnected: false,
        brokerPort: 8765,
        portNotBroker: true
      })
    ).toContain('not a Chrome Browser Control broker');
  });

  it('reports port-not-broker coaching from ensureBroker lifecycle', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    bridge.connected = false;
    registerBrowserTools(server, bridge, {
      getStatusContext: () => ({
        brokerPort: 8765,
        ensureBroker: async () => ({
          reachable: true,
          authOk: false,
          portNotBroker: true,
          error: 'Port 8765 is open but did not accept a Chrome Browser Control broker handshake'
        })
      })
    });

    const result = await server.tools.get('browser_status')?.({});
    const status = JSON.parse(result.content[0].text);

    expect(bridge.connectCalls).toBe(0);
    expect(status.broker.reachable).toBe(true);
    expect(status.nextAction).toContain('not a Chrome Browser Control broker');
  });

  it('reports missing token coaching through browser_status', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    registerBrowserTools(server, bridge, {
      getStatusContext: () => ({ tokenIssue: 'missing' })
    });

    const result = await server.tools.get('browser_status')?.({});
    const status = JSON.parse(result.content[0].text);

    expect(status.ready).toBe(false);
    expect(status.nextAction).toContain('npm run setup');
    expect(bridge.calls).toEqual([]);
  });

  it('forwards exclusive claim ownerId from adapter options', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    registerBrowserTools(server, bridge, { ownerId: 'adapter-owner-1' });

    await server.tools.get('claim_tab')?.({ tabId: 3, exclusive: true, owner: 'Audit bot' });

    expect(bridge.calls).toEqual([
      {
        action: 'claim_tab',
        params: { tabId: 3, exclusive: true, owner: 'Audit bot', ownerId: 'adapter-owner-1' }
      }
    ]);
  });

  it('forwards snapshot scope options to the bridge', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    registerBrowserTools(server, bridge);

    await server.tools.get('snapshot')?.({
      scope: 'main',
      excludeSelectors: ['nav'],
      ignoreRoles: ['dialog'],
      tabId: 3
    });

    expect(bridge.calls).toEqual([
      {
        action: 'snapshot',
        params: {
          scope: 'main',
          excludeSelectors: ['nav'],
          ignoreRoles: ['dialog'],
          tabId: 3
        }
      }
    ]);
  });
});
