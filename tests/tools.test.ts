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
      'click',
      'list_tabs',
      'navigate',
      'scroll',
      'snapshot',
      'type'
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
    bridge.result = { pong: true, status: 'connected', protocolVersion: 1, features: ['navigate-pending-warning'] };
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
        features: ['navigate-pending-warning']
      },
      ping: { pong: true, status: 'connected', protocolVersion: 1, features: ['navigate-pending-warning'] }
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
