import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type FakeTimer = {
  callback: () => void;
  delay: number;
  active: boolean;
};

type FakeSocket = {
  emit: (type: string, event: Record<string, unknown>) => void;
  readyState: number;
};

type OffscreenHarness = {
  chrome: { runtime: Record<string, unknown> };
  runtimeListeners: Array<
    (message: Record<string, unknown>, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void
  >;
  sentMessages: Array<Record<string, unknown>>;
  sockets: Array<FakeSocket>;
  timers: Array<FakeTimer>;
};

const settings = {
  bridgeUrl: 'ws://127.0.0.1:8765',
  token: 'test-token',
  allowedOrigins: []
};

function loadOffscreenHarness(): OffscreenHarness {
  const runtimeListeners: OffscreenHarness['runtimeListeners'] = [];
  const sentMessages: Array<Record<string, unknown>> = [];
  const sockets: Array<FakeSocket> = [];
  const timers: Array<FakeTimer> = [];

  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = FakeWebSocket.CONNECTING;
    private readonly listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();

    constructor(readonly url: string) {
      sockets.push(this);
    }

    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type: string, event: Record<string, unknown>) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }

    close(code = 1000, reason = '') {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close', { code, reason });
    }

    send(_data: string) {}
  }

  const chrome = {
    runtime: {
      id: 'test-extension',
      getManifest: () => ({ version: '1.0.0' }),
      onMessage: {
        addListener: (
          listener: (message: Record<string, unknown>, sender: unknown, sendResponse: (response: unknown) => void) =>
            boolean | void
        ) => {
          runtimeListeners.push(listener);
        }
      },
      sendMessage: (message: Record<string, unknown>) => {
        sentMessages.push(message);
        return Promise.resolve({ ok: true });
      }
    }
  };

  const context = vm.createContext({
    BrowserControlSecurity: {
      normalizeAllowedOriginPatterns: (value: unknown) => value,
      normalizeBridgeUrl: (value: string) => value,
      validatePairingToken: (value: string) => value
    },
    chrome,
    WebSocket: FakeWebSocket,
    Date: class extends Date {
      static now() {
        return 4321;
      }
    },
    setTimeout: (callback: () => void, delay = 0) => {
      const timer = { callback, delay, active: true };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer: FakeTimer | null | undefined) => {
      if (timer) timer.active = false;
    }
  });
  (context as any).globalThis = context;
  vm.runInContext(readFileSync(join(process.cwd(), 'extension/offscreen.js'), 'utf8'), context);

  return { chrome, runtimeListeners, sentMessages, sockets, timers };
}

async function connect(harness: OffscreenHarness) {
  return new Promise((resolve) => {
    const keepAlive = harness.runtimeListeners[0](
      { target: 'cbc-offscreen', action: 'connect', settings },
      {},
      resolve
    );
    expect(keepAlive).toBe(true);
  });
}

function adapterStatusMessages(harness: OffscreenHarness) {
  return harness.sentMessages.filter((message) => message.kind === 'adapter-status');
}

function statusMessages(harness: OffscreenHarness) {
  return harness.sentMessages.filter((message) => message.kind === 'status-update');
}

describe('offscreen adapter status routing', () => {
  it('T1: closing the socket sends an adapter-status null payload without chrome.storage', async () => {
    const harness = loadOffscreenHarness();
    await connect(harness);

    expect(harness.chrome).not.toHaveProperty('storage');
    expect(() => harness.sockets[0].emit('close', { code: 1000, reason: 'normal' })).not.toThrow();
    expect(adapterStatusMessages(harness)).toEqual([
      { target: 'cbc-background', kind: 'adapter-status', adapterStatus: null }
    ]);
  });

  it('R1: a synchronous sendMessage failure does not stop reconnect scheduling', async () => {
    const harness = loadOffscreenHarness();
    await connect(harness);

    harness.chrome.runtime.sendMessage = () => {
      throw new Error('runtime unavailable');
    };

    expect(() => harness.sockets[0].emit('close', { code: 1000, reason: 'normal' })).not.toThrow();
    expect(harness.timers.some((timer) => timer.active && timer.delay === 2000)).toBe(true);
  });

  it('T2: closing the socket arms the reconnect timer', async () => {
    const harness = loadOffscreenHarness();
    await connect(harness);

    harness.sockets[0].emit('close', { code: 1000, reason: 'normal' });
    expect(harness.timers.some((timer) => timer.active && timer.delay === 2000)).toBe(true);
  });

  it('T3: close code 1008 reports auth_failed', async () => {
    const harness = loadOffscreenHarness();
    await connect(harness);

    harness.sockets[0].emit('close', { code: 1008, reason: 'invalid token' });
    expect(statusMessages(harness).at(-1)).toEqual({
      target: 'cbc-background',
      kind: 'status-update',
      status: 'auth_failed: invalid token'
    });
    expect(harness.timers.some((timer) => timer.active && timer.delay === 2000)).toBe(true);
  });

  it('T4: close code 1006 before open reports the broker-not-running status', async () => {
    const harness = loadOffscreenHarness();
    await connect(harness);

    harness.sockets[0].emit('close', { code: 1006, reason: '' });
    expect(statusMessages(harness).at(-1)).toEqual({
      target: 'cbc-background',
      kind: 'status-update',
      status: 'error: broker not running — start npm run broker'
    });
    expect(harness.timers.some((timer) => timer.active && timer.delay === 2000)).toBe(true);
  });

  it('T5: adapter_status sends the normalised payload to the worker', async () => {
    const harness = loadOffscreenHarness();
    await connect(harness);

    harness.sockets[0].emit('message', {
      data: JSON.stringify({
        kind: 'adapter_status',
        adapterProtocolVersion: 7,
        registeredToolCount: 12,
        mcpClientCount: 3,
        updatedAt: 9876
      })
    });
    harness.sockets[0].emit('message', {
      data: JSON.stringify({
        kind: 'adapter_status',
        adapterProtocolVersion: '7',
        registeredToolCount: '12',
        mcpClientCount: '3',
        updatedAt: 'not-a-timestamp'
      })
    });

    expect(adapterStatusMessages(harness)).toEqual([
      {
        target: 'cbc-background',
        kind: 'adapter-status',
        adapterStatus: {
          adapterProtocolVersion: 7,
          registeredToolCount: 12,
          mcpClientCount: 3,
          updatedAt: 9876
        }
      },
      {
        target: 'cbc-background',
        kind: 'adapter-status',
        adapterStatus: {
          adapterProtocolVersion: null,
          registeredToolCount: 0,
          mcpClientCount: 0,
          updatedAt: 4321
        }
      }
    ]);
  });

  it('T7: the offscreen file references only chrome.runtime', () => {
    const source = readFileSync(join(process.cwd(), 'extension/offscreen.js'), 'utf8');
    const apis = [...source.matchAll(/\bchrome\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
    const offendingApis = [...new Set(apis.filter((api) => api !== 'runtime'))];

    if (offendingApis.length > 0) {
      throw new Error(
        `extension/offscreen.js references unsupported chrome API(s): ${offendingApis
          .map((api) => `chrome.${api}`)
          .join(', ')}`
      );
    }
  });

  it('T8: runtime-only chrome supports the close and bridge-message paths', async () => {
    const harness = loadOffscreenHarness();
    await connect(harness);

    expect(Object.keys(harness.chrome)).toEqual(['runtime']);
    expect(() => {
      harness.sockets[0].emit('message', {
        data: JSON.stringify({
          kind: 'adapter_status',
          adapterProtocolVersion: 7,
          registeredToolCount: 12,
          mcpClientCount: 3,
          updatedAt: 9876
        })
      });
    }).not.toThrow();
    expect(adapterStatusMessages(harness)).toEqual([
      {
        target: 'cbc-background',
        kind: 'adapter-status',
        adapterStatus: {
          adapterProtocolVersion: 7,
          registeredToolCount: 12,
          mcpClientCount: 3,
          updatedAt: 9876
        }
      }
    ]);
    expect(() => {
      harness.sockets[0].emit('close', { code: 1000, reason: 'normal' });
    }).not.toThrow();
  });
});
