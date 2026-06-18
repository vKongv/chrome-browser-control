import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadSecurity() {
  const context = vm.createContext({ URL });
  const code = readFileSync(join(process.cwd(), 'extension/security.js'), 'utf8');
  vm.runInContext(code, context);
  return (context as any).HermesSecurity;
}

function loadBackgroundHarness({
  settings,
  tabs,
  bridgeStatus = 'connected',
  staleActiveTab
}: {
  settings: Record<string, unknown>;
  tabs: Array<Record<string, unknown>>;
  bridgeStatus?: string;
  staleActiveTab?: Record<string, unknown>;
}) {
  let now = 0;
  let nextTabId = Math.max(0, ...tabs.map((tab) => Number(tab.id) || 0)) + 1;
  const FakeDate = class extends Date {
    static now() {
      return now;
    }
  };
  const chrome = {
    storage: {
      local: {
        get: async (defaults: Record<string, unknown>) => ({ ...defaults, ...settings }),
        set: async () => undefined
      }
    },
    runtime: {
      getContexts: async () => [],
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onInstalled: { addListener: () => undefined },
      onStartup: { addListener: () => undefined },
      onMessage: { addListener: () => undefined },
      sendMessage: async (message: Record<string, unknown>) => {
        if (message?.target === 'hermes-offscreen' && message?.action === 'status') {
          return { ok: true, status: bridgeStatus };
        }
        return { ok: true };
      }
    },
    offscreen: {
      createDocument: async () => undefined
    },
    tabs: {
      query: async (query: Record<string, unknown> = {}) => {
        if (query.active && query.currentWindow && staleActiveTab) {
          return [staleActiveTab];
        }
        let result = [...tabs];
        if (query.active) result = result.filter((tab) => tab.active);
        if (query.currentWindow) result = result.filter((tab) => tab.windowId === 1);
        return result;
      },
      get: async (tabId: number) => {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        const loadsRemaining = Number(tab._navigateLoadsRemaining ?? -1);
        if (loadsRemaining > 0) {
          tab._navigateLoadsRemaining = loadsRemaining - 1;
          return { ...tab, status: 'loading' };
        }
        if (loadsRemaining === 0 && tab._navigateFinal) {
          return { ...tab, ...tab._navigateFinal, status: 'complete' };
        }
        return tab;
      },
      update: async (tabId: number, update: Record<string, unknown>) => {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        Object.assign(tab, update, { status: 'loading', _navigateLoadsRemaining: 1 });
        return tab;
      },
      create: async (createInfo: Record<string, unknown>) => {
        const tab = {
          id: nextTabId++,
          active: createInfo.active ?? false,
          highlighted: false,
          title: '',
          url: createInfo.url,
          windowId: 1,
          status: 'loading',
          _navigateLoadsRemaining: 1,
          _navigateFinal: {
            title: 'New Tab',
            url: createInfo.url,
            status: 'complete'
          }
        };
        tabs.push(tab);
        return tab;
      },
      sendMessage: async () => ({ ok: true, result: {} })
    },
    scripting: {
      executeScript: async () => undefined
    }
  };
  const context = vm.createContext({
    URL,
    chrome,
    Date: FakeDate,
    globalThis: undefined,
    HERMES_TEST_HARNESS: true,
    importScripts: () => undefined,
    setTimeout: (callback: () => void, delay = 0) => {
      now += Number(delay);
      callback();
      return 0;
    },
    clearTimeout
  });
  (context as any).globalThis = context;
  vm.runInContext(readFileSync(join(process.cwd(), 'extension/security.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(process.cwd(), 'extension/background.js'), 'utf8'), context);
  return (context as any).HermesBackground;
}

describe('extension security helpers', () => {
  const security = loadSecurity();

  it('allows only loopback ws bridge URLs without paths', () => {
    expect(security.normalizeBridgeUrl('ws://127.0.0.1:8765')).toBe('ws://127.0.0.1:8765');
    expect(security.normalizeBridgeUrl('ws://localhost')).toBe('ws://localhost');
    expect(security.normalizeBridgeUrl('ws://[::1]:8765')).toBe('ws://[::1]:8765');
    expect(() => security.normalizeBridgeUrl('wss://127.0.0.1:8765')).toThrow('ws://');
    expect(() => security.normalizeBridgeUrl('ws://192.168.1.2:8765')).toThrow('127.0.0.1');
    expect(() => security.normalizeBridgeUrl('ws://127.0.0.1:8765/path')).toThrow('optional port');
  });

  it('requires a non-default high entropy-looking pairing token', () => {
    expect(() => security.validatePairingToken('')).toThrow('required');
    expect(() => security.validatePairingToken(['dev', 'token', 'change', 'me'].join('-'))).toThrow('default');
    expect(() => security.validatePairingToken('short')).toThrow('32');
    expect(() => security.validatePairingToken('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toThrow('character variety');
    expect(() => security.validatePairingToken('11111111111111111111111111111111')).toThrow('character variety');
    expect(() => security.validatePairingToken('abababababababababababababababab')).toThrow('character variety');
    expect(security.validatePairingToken('abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-')).toBe(
      'abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-'
    );
  });

  it('normalizes explicit allowed origins and rejects partial wildcards', () => {
    expect(security.normalizeAllowedOriginPatterns('https://example.com\nhttp://localhost:3000')).toEqual([
      'https://example.com/*',
      'http://localhost:3000/*'
    ]);
    expect(security.isUrlAllowed('https://example.com/docs', ['https://example.com/*'])).toBe(true);
    expect(security.isUrlAllowed('https://evil.example/docs', ['https://example.com/*'])).toBe(false);
    expect(() => security.normalizeAllowedOriginPatterns('https://*.example.com')).toThrow('wildcard');
  });

  it('accepts * as an alias for all http/https web origins', () => {
    expect(security.normalizeAllowedOriginPatterns('*')).toEqual(['http://*/*', 'https://*/*']);
    expect(security.normalizeAllowedOriginPatterns(['http://*/*', 'https://*/*'])).toEqual(['http://*/*', 'https://*/*']);
    expect(security.formatAllowedOriginPatternsForDisplay(['http://*/*', 'https://*/*'])).toEqual(['*']);
    expect(security.describeAllowedOrigins(['http://*/*', 'https://*/*'])).toEqual(['* (all http/https web origins)']);
    expect(security.getHostPermissionOrigins(['http://*/*', 'https://*/*'])).toEqual(['http://*/*', 'https://*/*']);
    expect(security.isUrlAllowed('https://example.com/docs', ['*'])).toBe(true);
    expect(security.isUrlAllowed('http://localhost:3000/app', ['http://*/*', 'https://*/*'])).toBe(true);
    expect(security.isUrlAllowed('chrome://extensions', ['*'])).toBe(false);
    expect(security.isUrlAllowed('file:///tmp/page.html', ['*'])).toBe(false);
    expect(security.isUrlAllowed('chrome-extension://abc/popup.html', ['*'])).toBe(false);
  });

  it('deduplicates mixed wildcard and explicit origin inputs', () => {
    expect(security.normalizeAllowedOriginPatterns('*\nhttps://example.com\n*\nhttp://localhost:3000')).toEqual([
      'http://*/*',
      'https://*/*'
    ]);
    expect(security.normalizeAllowedOriginPatterns('https://example.com/*\nhttps://example.com')).toEqual([
      'https://example.com/*'
    ]);
  });
});

describe('extension background origin enforcement', () => {
  const token = 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-';

  it('filters disallowed tabs at the bridge request boundary', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs: [
        { id: 1, active: true, highlighted: true, title: 'Allowed', url: 'https://allowed.example/docs', windowId: 1 },
        { id: 2, active: false, highlighted: false, title: 'Blocked', url: 'https://blocked.example/docs', windowId: 1 }
      ]
    });

    await expect(background.handleBridgeRequest('list_tabs')).resolves.toEqual([
      {
        id: 1,
        active: true,
        highlighted: true,
        title: 'Allowed',
        url: 'https://allowed.example/docs',
        windowId: 1,
        source: 'extension'
      }
    ]);
  });

  it('rejects navigate requests to disallowed origins', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs: [{ id: 1, active: true, highlighted: true, title: 'Allowed', url: 'https://allowed.example/docs', windowId: 1 }]
    });

    await expect(background.handleBridgeRequest('navigate', { tabId: 1, url: 'https://blocked.example/docs' })).rejects.toThrow(
      'unapproved origin'
    );
  });

  it('rejects page actions against disallowed tab origins', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs: [
        {
          id: 2,
          active: true,
          highlighted: true,
          status: 'complete',
          title: 'Blocked',
          url: 'https://blocked.example/docs',
          windowId: 1
        }
      ]
    });

    await expect(background.handleBridgeRequest('snapshot', { tabId: 2 })).rejects.toThrow('unapproved origin');
  });

  it('reports live bridge status on ping instead of a stale disconnected default', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs: [],
      bridgeStatus: 'connected'
    });

    await expect(background.handleBridgeRequest('ping')).resolves.toEqual({
      pong: true,
      status: 'connected',
      allowedOrigins: ['https://allowed.example/*'],
      protocolVersion: 1,
      features: ['navigate-pending-warning']
    });
  });

  it('explains when list_tabs is empty because no allowed origins are configured', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: []
      },
      tabs: [
        {
          id: 1,
          active: true,
          highlighted: true,
          title: 'Example',
          url: 'https://example.com/',
          windowId: 1
        }
      ]
    });

    await expect(background.handleBridgeRequest('list_tabs')).resolves.toEqual({
      tabs: [],
      detail:
        'No allowed origins are configured in the extension. Add allowed origins in the extension popup, then open or navigate to a matching site.',
      hiddenTabCount: 1
    });
  });

  it('explains when list_tabs is empty because allowed-origin filtering hid every tab', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs: [
        {
          id: 1,
          active: true,
          highlighted: true,
          title: 'Extensions',
          url: 'chrome://extensions',
          windowId: 1
        }
      ]
    });

    await expect(background.handleBridgeRequest('list_tabs')).resolves.toEqual({
      tabs: [],
      detail:
        'No open tabs match the allowed origins configured in the extension. Add origins in the extension popup or navigate to an allowed site.',
      hiddenTabCount: 1,
      allowedOrigins: ['https://allowed.example/*']
    });
  });

  it('waits for navigate to finish loading before returning final tab state', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://example.com/*']
      },
      tabs: [
        {
          id: 1,
          active: true,
          highlighted: true,
          title: 'Extensions',
          url: 'chrome://extensions',
          windowId: 1,
          _navigateFinal: { title: 'Example Domain', url: 'https://example.com/' }
        }
      ]
    });

    await expect(
      background.handleBridgeRequest('navigate', { tabId: 1, url: 'https://example.com/' })
    ).resolves.toEqual({
      id: 1,
      url: 'https://example.com/',
      title: 'Example Domain',
      status: 'complete',
      source: 'extension'
    });
  });

  it('lists all http/https tabs when wildcard origins are configured', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['http://*/*', 'https://*/*']
      },
      tabs: [
        {
          id: 1,
          active: true,
          highlighted: true,
          title: 'Example',
          url: 'https://example.com/',
          windowId: 1
        },
        {
          id: 2,
          active: false,
          highlighted: false,
          title: 'Extensions',
          url: 'chrome://extensions',
          windowId: 1
        }
      ]
    });

    await expect(background.handleBridgeRequest('list_tabs')).resolves.toEqual([
      {
        id: 1,
        active: true,
        highlighted: true,
        title: 'Example',
        url: 'https://example.com/',
        windowId: 1,
        source: 'extension'
      }
    ]);
    await expect(background.handleBridgeRequest('ping')).resolves.toMatchObject({
      allowedOrigins: ['* (all http/https web origins)']
    });
  });

  it('marks navigate results pending when the tab does not finish loading', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://example.com/*']
      },
      tabs: [
        {
          id: 1,
          active: true,
          highlighted: true,
          title: 'Example Domain',
          url: 'https://example.com/',
          windowId: 1,
          status: 'complete'
        }
      ]
    });

    await expect(
      background.handleBridgeRequest('navigate', { tabId: 1, url: 'https://example.com/' })
    ).resolves.toEqual({
      id: 1,
      url: 'https://example.com/',
      title: 'Example Domain',
      status: 'loading',
      source: 'extension',
      warning: 'Navigation did not finish loading within 15s; tab may still be loading.',
      pending: true
    });
  });

  it('creates a new tab for navigate without tabId when the active tab id is stale', async () => {
    const tabs = [
      {
        id: 2,
        active: false,
        highlighted: false,
        title: 'Allowed',
        url: 'https://allowed.example/docs',
        windowId: 1,
        status: 'complete'
      }
    ];
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs,
      staleActiveTab: {
        id: 99,
        active: true,
        highlighted: true,
        url: 'https://allowed.example/stale',
        windowId: 1
      }
    });

    await expect(background.handleBridgeRequest('navigate', { url: 'https://allowed.example/next' })).resolves.toEqual({
      id: 3,
      url: 'https://allowed.example/next',
      title: 'New Tab',
      status: 'complete',
      source: 'extension'
    });
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toMatchObject({ id: 2, url: 'https://allowed.example/docs' });
    expect(tabs[1]).toMatchObject({ id: 3, url: 'https://allowed.example/next' });
  });

  it('reuses the active tab for navigate without tabId when the active tab is operable', async () => {
    const tabs = [
      {
        id: 1,
        active: true,
        highlighted: true,
        title: 'Allowed',
        url: 'https://allowed.example/docs',
        windowId: 1,
        status: 'complete',
        _navigateFinal: { title: 'Allowed', url: 'https://allowed.example/next' }
      },
      {
        id: 2,
        active: false,
        highlighted: false,
        title: 'Other',
        url: 'https://allowed.example/other',
        windowId: 1,
        status: 'complete'
      }
    ];
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs
    });

    await expect(background.handleBridgeRequest('navigate', { url: 'https://allowed.example/next' })).resolves.toEqual({
      id: 1,
      url: 'https://allowed.example/next',
      title: 'Allowed',
      status: 'complete',
      source: 'extension'
    });
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toMatchObject({ id: 2, url: 'https://allowed.example/other' });
  });

  it('creates a tab for navigate without tabId when no allowed operable tab exists', async () => {
    const tabs: Array<Record<string, unknown>> = [
      {
        id: 1,
        active: true,
        highlighted: true,
        title: 'Extensions',
        url: 'chrome://extensions',
        windowId: 1
      }
    ];
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://example.com/*']
      },
      tabs
    });

    await expect(background.handleBridgeRequest('navigate', { url: 'https://example.com/start' })).resolves.toEqual({
      id: 2,
      url: 'https://example.com/start',
      title: 'New Tab',
      status: 'complete',
      source: 'extension'
    });
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toMatchObject({ id: 2, url: 'https://example.com/start' });
  });

  it('returns a clear error when an explicit navigate tabId is missing', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://example.com/*']
      },
      tabs: [
        {
          id: 1,
          active: true,
          highlighted: true,
          title: 'Example',
          url: 'https://example.com/',
          windowId: 1
        }
      ]
    });

    await expect(
      background.handleBridgeRequest('navigate', { tabId: 404, url: 'https://example.com/next' })
    ).rejects.toThrow('No tab with id: 404');
  });

  it('rejects page actions without tabId when the active tab is restricted under wildcard origins', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['http://*/*', 'https://*/*']
      },
      tabs: [
        {
          id: 1,
          active: true,
          highlighted: true,
          status: 'complete',
          title: 'Extensions',
          url: 'chrome://extensions',
          windowId: 1
        },
        {
          id: 2,
          active: false,
          highlighted: false,
          status: 'complete',
          title: 'Example',
          url: 'https://example.com/',
          windowId: 1
        }
      ]
    });

    await expect(background.handleBridgeRequest('snapshot')).rejects.toThrow(
      'Cannot inspect this Chrome internal or restricted page: chrome://extensions'
    );
  });

  it('rejects page actions without tabId when the active tab origin is not allowed', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs: [
        {
          id: 1,
          active: true,
          highlighted: true,
          status: 'complete',
          title: 'Blocked',
          url: 'https://blocked.example/docs',
          windowId: 1
        },
        {
          id: 2,
          active: false,
          highlighted: false,
          status: 'complete',
          title: 'Allowed',
          url: 'https://allowed.example/docs',
          windowId: 1
        }
      ]
    });

    await expect(background.handleBridgeRequest('snapshot')).rejects.toThrow(
      'Page action is blocked for unapproved origin: https://blocked.example/docs'
    );
  });

  it('rejects page actions without tabId when the active tab id is stale', async () => {
    const tabs = [
      {
        id: 2,
        active: false,
        highlighted: false,
        status: 'complete',
        title: 'Allowed',
        url: 'https://allowed.example/docs',
        windowId: 1
      }
    ];
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs,
      staleActiveTab: {
        id: 99,
        active: true,
        highlighted: true,
        status: 'complete',
        title: 'Stale',
        url: 'https://allowed.example/stale',
        windowId: 1
      }
    });

    await expect(background.handleBridgeRequest('snapshot')).rejects.toThrow(
      'The active Chrome tab is no longer available'
    );
  });

  it('returns a clear error when an explicit page-action tabId is missing', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://example.com/*']
      },
      tabs: [
        {
          id: 1,
          active: true,
          highlighted: true,
          status: 'complete',
          title: 'Example',
          url: 'https://example.com/',
          windowId: 1
        }
      ]
    });

    await expect(background.handleBridgeRequest('snapshot', { tabId: 404 })).rejects.toThrow('No tab with id: 404');
  });
});
