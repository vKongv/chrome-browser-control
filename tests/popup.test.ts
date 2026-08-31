import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-';

function loadPopupHarness({
  grantedOnRequest = true,
  hangRequest = false,
  stored = {}
}: {
  grantedOnRequest?: boolean;
  hangRequest?: boolean;
  stored?: Record<string, unknown>;
} = {}) {
  const events: Array<{ type: string; payload: unknown }> = [];
  const fields: Record<string, { value: string; textContent?: string; checked?: boolean }> = {
    bridgeUrl: { value: 'ws://127.0.0.1:8765' },
    token: { value: TOKEN },
    allowedOrigins: { value: 'https://example.com' },
    status: { value: '', textContent: 'unknown' },
    setupSnippet: { value: '' },
    save: { value: '' },
    copyJson: { value: '' },
    copyCursor: { value: '' },
    copyYaml: { value: '' },
    enableDebugger: { value: '', checked: false }
  };
  const listeners = new Map<string, Array<(event?: unknown) => unknown>>();

  const chrome = {
    storage: {
      local: {
        get: async (defaults: Record<string, unknown>) => ({
          ...defaults,
          bridgeUrl: 'ws://127.0.0.1:8765',
          token: TOKEN,
          allowedOrigins: ['https://example.com/*'],
          status: 'connected',
          ...stored
        }),
        set: async (items: Record<string, unknown>) => {
          events.push({ type: 'storage.set', payload: items });
        }
      },
      onChanged: {
        addListener: () => undefined
      }
    },
    permissions: {
      contains: (request: { origins?: string[]; permissions?: string[] }, callback?: (granted: boolean) => void) => {
        callback?.(false);
        return Promise.resolve(false);
      },
      request: (request: { origins?: string[]; permissions?: string[] }, callback?: (granted: boolean) => void) => {
        events.push({ type: 'permissions.request', payload: request });
        if (hangRequest) return;
        callback?.(grantedOnRequest);
        return Promise.resolve(grantedOnRequest);
      },
      remove: (request: { permissions?: string[] }, callback?: (removed: boolean) => void) => {
        events.push({ type: 'permissions.remove', payload: request });
        callback?.(true);
        return Promise.resolve(true);
      }
    },
    runtime: {
      sendMessage: (_message: Record<string, unknown>, callback?: (response: unknown) => void) => {
        events.push({ type: 'runtime.sendMessage', payload: _message });
        callback?.({ ok: true, status: 'connected' });
      }
    }
  };

  const document = {
    getElementById: (id: string) => {
      const field = fields[id] || { value: '' };
      return {
        get value() {
          return field.value;
        },
        set value(next: string) {
          field.value = next;
        },
        get textContent() {
          return field.textContent ?? field.value;
        },
        set textContent(next: string) {
          field.textContent = next;
        },
        addEventListener: (type: string, handler: (event?: unknown) => unknown) => {
          const key = `${id}:${type}`;
          const existing = listeners.get(key) || [];
          existing.push(handler);
          listeners.set(key, existing);
        },
        get checked() {
          return Boolean(field.checked);
        },
        set checked(next: boolean) {
          field.checked = Boolean(next);
        }
      };
    }
  };

  const context = vm.createContext({
    chrome,
    document,
    URL,
    navigator: {},
    globalThis: undefined,
    CBC_TEST_HARNESS: true
  });
  (context as any).globalThis = context;
  vm.runInContext(readFileSync(join(process.cwd(), 'extension/security.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(process.cwd(), 'extension/popup.js'), 'utf8'), context);

  async function flush() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  }

  return {
    events,
    fields,
    popup: (context as any).BrowserControlPopup,
    flush,
    async clickSave() {
      const handlers = listeners.get('save:click') || [];
      for (const handler of handlers) await handler();
    }
  };
}

describe('popup save ordering', () => {
  it('persists settings before requesting host and screenshot origins in one call', async () => {
    const harness = loadPopupHarness();
    await harness.flush();
    harness.events.length = 0;
    harness.fields.allowedOrigins.value = '*';

    await harness.clickSave();

    const types = harness.events.map((event) => event.type);
    expect(types.slice(0, 3)).toEqual(['storage.set', 'permissions.request', 'runtime.sendMessage']);
    expect(harness.events[0]).toEqual({
      type: 'storage.set',
      payload: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token: TOKEN,
        allowedOrigins: ['http://*/*', 'https://*/*'],
        enableCdp: false
      }
    });
    expect(harness.events[1]).toEqual({
      type: 'permissions.request',
      payload: {
        origins: ['http://*/*', 'https://*/*', '<all_urls>']
      }
    });
    expect(harness.events.some((event) => event.type === 'permissions.remove')).toBe(false);
    expect(harness.fields.status.textContent).toBe('connected');
  });

  it('keeps the saved settings when the permission dialog is refused', async () => {
    const harness = loadPopupHarness({ grantedOnRequest: false });
    await harness.flush();
    harness.events.length = 0;
    harness.fields.allowedOrigins.value = 'https://example.com';

    await harness.clickSave();

    expect(harness.events.map((event) => event.type)).toEqual(['storage.set', 'permissions.request']);
    expect(harness.events[0]?.payload).toEqual({
      bridgeUrl: 'ws://127.0.0.1:8765',
      token: TOKEN,
      allowedOrigins: ['https://example.com/*'],
      enableCdp: false
    });
    expect(harness.events[1]).toEqual({
      type: 'permissions.request',
      payload: { origins: ['https://example.com/*'] }
    });
    expect(harness.fields.status.textContent).toBe('saved; optional permission was not granted');
    expect(harness.events.some((event) => event.type === 'runtime.sendMessage' && (event.payload as { action?: string }).action === 'connect')).toBe(
      false
    );
  });

  it('persists enableCdp without requesting or removing the debugger permission', async () => {
    const harness = loadPopupHarness();
    await harness.flush();
    harness.events.length = 0;
    harness.fields.enableDebugger.checked = true;
    harness.fields.allowedOrigins.value = 'https://example.com';

    await harness.clickSave();

    expect(harness.events[0]).toEqual({
      type: 'storage.set',
      payload: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token: TOKEN,
        allowedOrigins: ['https://example.com/*'],
        enableCdp: true
      }
    });
    expect(harness.events[1]).toEqual({
      type: 'permissions.request',
      payload: { origins: ['https://example.com/*'] }
    });
    expect(
      harness.events.some(
        (event) =>
          (event.type === 'permissions.request' || event.type === 'permissions.remove') &&
          Array.isArray((event.payload as { permissions?: string[] })?.permissions) &&
          (event.payload as { permissions?: string[] }).permissions?.includes('debugger')
      )
    ).toBe(false);
  });

  it('loads the trusted-input checkbox from stored enableCdp, not from chrome.permissions', async () => {
    const harness = loadPopupHarness({ stored: { enableCdp: true } });
    await harness.flush();
    expect(harness.fields.enableDebugger.checked).toBe(true);
  });

  it('exposes persist-then-request so a closed popup cannot drop the save', async () => {
    const harness = loadPopupHarness();
    await harness.flush();
    harness.events.length = 0;

    const result = await harness.popup.persistSettingsThenRequestPermissions({
      settings: { allowedOrigins: ['https://example.com/*'] },
      origins: ['https://example.com/*']
    });

    expect(result).toEqual({ saved: true, granted: true });
    expect(harness.events.map((event) => event.type)).toEqual(['storage.set', 'permissions.request']);
    expect(harness.events[0]?.payload).toEqual({ allowedOrigins: ['https://example.com/*'] });
    expect(harness.events[1]?.payload).toEqual({ origins: ['https://example.com/*'] });
  });

  it('persists settings before a hanging origin permission dialog', async () => {
    const harness = loadPopupHarness({ hangRequest: true });
    await harness.flush();
    harness.events.length = 0;
    harness.fields.enableDebugger.checked = false;
    harness.fields.allowedOrigins.value = 'https://other.example';

    void harness.clickSave();
    await harness.flush();

    expect(harness.events.map((event) => event.type)).toEqual(['storage.set', 'permissions.request']);
    expect(harness.events[0]?.payload).toEqual({
      bridgeUrl: 'ws://127.0.0.1:8765',
      token: TOKEN,
      allowedOrigins: ['https://other.example/*'],
      enableCdp: false
    });
    expect(harness.events[1]).toEqual({
      type: 'permissions.request',
      payload: { origins: ['https://other.example/*'] }
    });
    expect(harness.events.some((event) => event.type === 'permissions.remove')).toBe(false);
  });
});
