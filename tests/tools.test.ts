import { describe, expect, it } from 'vitest';
import { BridgeAction } from '../server/protocol.js';
import { registerBrowserTools, ToolRegistrar } from '../server/tools.js';

class FakeServer implements ToolRegistrar {
  tools = new Map<string, (args: any) => Promise<any>>();

  registerTool(name: string, _config: Record<string, unknown>, cb: (args: any) => Promise<any>): unknown {
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
  it('registers the required MCP tools', () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    registerBrowserTools(server, bridge);

    expect([...server.tools.keys()].sort()).toEqual([
      'browser_status',
      'claim_tab',
      'click',
      'click_at',
      'collect_scroll',
      'console_logs',
      'extract_elements',
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
      content: [{ text: 'wait_for requires at least one of text, selector, or urlIncludes' }]
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
    registerBrowserTools(server, bridge);

    const result = await server.tools.get('browser_status')?.({});
    const status = JSON.parse(result.content[0].text);

    expect(bridge.calls).toEqual([{ action: 'ping', params: {} }]);
    expect(status).toMatchObject({
      ready: true,
      adapter: { connected: true },
      broker: { reachable: true },
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
    registerBrowserTools(server, bridge);

    const result = await server.tools.get('browser_status')?.({});
    const status = JSON.parse(result.content[0].text);

    expect(status).toMatchObject({
      ready: false,
      adapter: { connected: true },
      broker: { reachable: true },
      extension: { connected: false },
      error: 'No Chrome extension connected to broker'
    });
  });

  it('reports browser_status when the adapter is not connected to the broker', async () => {
    const server = new FakeServer();
    const bridge = new FakeBridge();
    bridge.connected = false;
    bridge.connect = async () => {
      bridge.connectCalls += 1;
      throw new Error('connect ECONNREFUSED 127.0.0.1:8765');
    };
    registerBrowserTools(server, bridge);

    const result = await server.tools.get('browser_status')?.({});
    const status = JSON.parse(result.content[0].text);

    expect(bridge.connectCalls).toBe(1);
    expect(status).toMatchObject({
      ready: false,
      adapter: { connected: false },
      broker: { reachable: false },
      extension: { connected: false },
      error: 'connect ECONNREFUSED 127.0.0.1:8765'
    });
  });
});
