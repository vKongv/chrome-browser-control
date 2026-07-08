import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadSecurity() {
  const context = vm.createContext({ URL });
  const code = readFileSync(join(process.cwd(), 'extension/security.js'), 'utf8');
  vm.runInContext(code, context);
  return (context as any).BrowserControlSecurity;
}

function withNavigateMetadata(expected: Record<string, unknown>, requestedUrl?: string) {
  const security = loadSecurity();
  const requested = requestedUrl ?? String(expected.url ?? '');
  const finalUrl = String(expected.url ?? requested);
  return {
    ...expected,
    requestedUrl: requested,
    finalUrl,
    redirected: !security.urlsEquivalent(requested, finalUrl),
    url: finalUrl
  };
}

function loadBackgroundHarness({
  settings,
  tabs,
  bridgeStatus = 'connected',
  staleActiveTab,
  contentResult = {},
  grantedOrigins = [],
  grantedPermissions = [],
  captureError
}: {
  settings: Record<string, unknown>;
  tabs: Array<Record<string, unknown>>;
  bridgeStatus?: string;
  staleActiveTab?: Record<string, unknown>;
  contentResult?: Record<string, unknown> | ((tabId: number, message: Record<string, unknown>) => Record<string, unknown>);
  grantedOrigins?: string[];
  grantedPermissions?: string[];
  captureError?: Error;
}) {
  let now = 0;
  let nextTabId = Math.max(0, ...tabs.map((tab) => Number(tab.id) || 0)) + 1;
  const sentMessages: Array<{ tabId: number; message: Record<string, unknown> }> = [];
  const captures: Array<{ windowId: number; options: Record<string, unknown> }> = [];
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
        if (message?.target === 'cbc-offscreen' && message?.action === 'status') {
          return { ok: true, status: bridgeStatus };
        }
        return { ok: true };
      }
    },
    offscreen: {
      createDocument: async () => undefined
    },
    permissions: {
      getAll: async () => ({
        origins: grantedOrigins,
        permissions: grantedPermissions
      }),
      contains: (request: { origins?: string[]; permissions?: string[] }, callback?: (granted: boolean) => void) => {
        const originsGranted = (request.origins || []).every((origin) => grantedOrigins.includes(origin));
        const permissionsGranted = (request.permissions || []).every((permission) => grantedPermissions.includes(permission));
        const granted = originsGranted && permissionsGranted;
        callback?.(granted);
        return Promise.resolve(granted);
      }
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
        const activationReads = Number(tab._activateAfterGets ?? -1);
        if (tab._pendingActive && activationReads > 0) {
          tab._activateAfterGets = activationReads - 1;
          return { ...tab, active: false };
        }
        if (tab._pendingActive) {
          Object.assign(tab, { active: true, _pendingActive: false });
        }
        return tab;
      },
      update: async (tabId: number, update: Record<string, unknown>) => {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        if (update.url) {
          Object.assign(tab, update, { status: 'loading', _navigateLoadsRemaining: 1 });
        } else if (update.active === true && tab._activateAfterGets !== undefined) {
          Object.assign(tab, update, { active: false, _pendingActive: true });
        } else {
          Object.assign(tab, update);
        }
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
      sendMessage: async (tabId: number, message: Record<string, unknown>) => {
        sentMessages.push({ tabId, message });
        if (message?.action === 'ping') return { ok: true, result: { ready: true } };
        return { ok: true, result: typeof contentResult === 'function' ? contentResult(tabId, message) : contentResult };
      },
      captureVisibleTab: async (windowId: number, options: Record<string, unknown>) => {
        captures.push({ windowId, options });
        if (captureError) throw captureError;
        return `data:image/${options.format};base64,ZmFrZQ==`;
      }
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
    CBC_TEST_HARNESS: true,
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
  return Object.assign((context as any).BrowserControlBackground, {
    sentMessages,
    captures,
    tabs,
    advanceTime(ms: number) {
      now += ms;
    }
  });
}

describe('extension security helpers', () => {
  const security = loadSecurity();

  it('declares <all_urls> only as an optional host permission for wildcard screenshots', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'extension/manifest.json'), 'utf8'));

    expect(manifest.permissions).not.toContain('<all_urls>');
    expect(manifest.optional_permissions || []).not.toContain('<all_urls>');
    expect(manifest.optional_host_permissions).toContain('<all_urls>');
  });

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
    expect(security.getScreenshotPermissionOrigins(['http://*/*', 'https://*/*'])).toEqual(['<all_urls>']);
    expect(security.getScreenshotPermissionOrigins(['https://example.com/*'])).toEqual([]);
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

    await expect(background.handleBridgeRequest('ping')).resolves.toMatchObject({
      pong: true,
      status: 'connected',
      allowedOrigins: ['https://allowed.example/*'],
      protocolVersion: 5,
      features: expect.arrayContaining([
        'act-observe',
        'navigate-pending-warning',
        'snapshot-text-limit',
        'snapshot-scope',
        'exclusive-claims',
        'extract-feed-posts',
        'session-tabs',
        'visible-snapshot'
      ])
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
    ).resolves.toEqual(
      withNavigateMetadata({
        id: 1,
        url: 'https://example.com/',
        title: 'Example Domain',
        status: 'complete',
        source: 'extension'
      })
    );
  });

  it('runs requested after observations after a page action without forwarding after to content', async () => {
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
      ],
      contentResult: (_tabId, message) => ({ action: message.action, params: message.params })
    });

    await expect(
      background.handleBridgeRequest('click', {
        tabId: 1,
        ref: 'h1',
        after: {
          waitFor: { selector: '.ready', timeoutMs: 1000 },
          snapshot: { mode: 'visible', limit: 2 },
          pageStatus: true
        }
      })
    ).resolves.toEqual({
      action: 'click',
      params: { tabId: 1, ref: 'h1' },
      after: {
        waitFor: { action: 'wait_for', params: { selector: '.ready', timeoutMs: 1000 } },
        snapshot: { action: 'snapshot', params: { mode: 'visible', limit: 2 } },
        pageStatus: { action: 'page_status', params: {} }
      }
    });
    expect(background.sentMessages.filter((entry: { message: Record<string, unknown> }) => entry.message.action !== 'ping')).toEqual([
      { tabId: 1, message: { target: 'cbc-content', action: 'click', params: { tabId: 1, ref: 'h1' } } },
      { tabId: 1, message: { target: 'cbc-content', action: 'wait_for', params: { selector: '.ready', timeoutMs: 1000 } } },
      { tabId: 1, message: { target: 'cbc-content', action: 'snapshot', params: { mode: 'visible', limit: 2 } } },
      { tabId: 1, message: { target: 'cbc-content', action: 'page_status', params: {} } }
    ]);
  });

  it('runs navigate after observations only after navigation finishes loading', async () => {
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
          title: 'Old',
          url: 'https://example.com/old',
          windowId: 1,
          _navigateFinal: { title: 'Example Domain', url: 'https://example.com/' }
        }
      ],
      contentResult: (_tabId, message) => ({ action: message.action, params: message.params })
    });

    await expect(
      background.handleBridgeRequest('navigate', {
        tabId: 1,
        url: 'https://example.com/',
        after: {
          snapshot: true,
          pageStatus: true
        }
      })
    ).resolves.toEqual(
      withNavigateMetadata({
        id: 1,
        url: 'https://example.com/',
        title: 'Example Domain',
        status: 'complete',
        source: 'extension',
        after: {
          snapshot: { action: 'snapshot', params: {} },
          pageStatus: { action: 'page_status', params: {} }
        }
      })
    );
    expect(background.sentMessages.filter((entry: { message: Record<string, unknown> }) => entry.message.action !== 'ping')).toEqual([
      { tabId: 1, message: { target: 'cbc-content', action: 'snapshot', params: {} } },
      { tabId: 1, message: { target: 'cbc-content', action: 'page_status', params: {} } }
    ]);
  });

  it('rejects empty after.waitFor before running an action or observations', async () => {
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
      background.handleBridgeRequest('click', { tabId: 1, ref: 'h1', after: { waitFor: { timeoutMs: 1000 } } })
    ).rejects.toThrow('after.waitFor requires at least one wait condition');
    expect(background.sentMessages).toEqual([]);
  });

  it('rejects invalid after.snapshot before running an action or observations', async () => {
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
      background.handleBridgeRequest('click', { tabId: 1, ref: 'h1', after: { snapshot: false } })
    ).rejects.toThrow('after.snapshot must be true or an object');
    expect(background.sentMessages).toEqual([]);
  });

  it('caps after.waitFor and waits for page load once before observations', async () => {
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
      ],
      contentResult: (_tabId, message) => ({ action: message.action, params: message.params })
    });

    await expect(
      background.handleBridgeRequest('scroll', {
        tabId: 1,
        deltaY: 0,
        after: { waitFor: { text: 'Done', timeoutMs: 30_000 }, snapshot: true, pageStatus: true }
      })
    ).resolves.toMatchObject({
      after: {
        waitFor: { action: 'wait_for', params: { text: 'Done', timeoutMs: 20_000 } },
        snapshot: { action: 'snapshot', params: {} },
        pageStatus: { action: 'page_status', params: {} }
      }
    });
  });

  it('returns the base action result when an after observation fails', async () => {
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
      ],
      contentResult: (_tabId, message) => {
        if (message.action === 'snapshot') throw new Error('snapshot failed');
        return { action: message.action, params: message.params };
      }
    });

    await expect(
      background.handleBridgeRequest('scroll', { tabId: 1, deltaY: 0, after: { snapshot: true } })
    ).resolves.toEqual({
      action: 'scroll',
      params: { tabId: 1, deltaY: 0 },
      after: {
        ok: false,
        error: 'snapshot failed'
      }
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
    ).resolves.toEqual(
      withNavigateMetadata({
        id: 1,
        url: 'https://example.com/',
        title: 'Example Domain',
        status: 'loading',
        source: 'extension',
        warning: 'Navigation did not finish loading within 15s; tab may still be loading.',
        pending: true
      })
    );
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

    await expect(background.handleBridgeRequest('navigate', { url: 'https://allowed.example/next' })).resolves.toEqual(
      withNavigateMetadata({
        id: 3,
        url: 'https://allowed.example/next',
        title: 'New Tab',
        status: 'complete',
        source: 'extension'
      })
    );
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

    await expect(background.handleBridgeRequest('navigate', { url: 'https://allowed.example/next' })).resolves.toEqual(
      withNavigateMetadata({
        id: 1,
        url: 'https://allowed.example/next',
        title: 'Allowed',
        status: 'complete',
        source: 'extension'
      })
    );
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toMatchObject({ id: 2, url: 'https://allowed.example/other' });
  });

  it('navigates a claimed tab to an allowed URL even if its current URL drifted out of scope', async () => {
    const tabs = [
      {
        id: 1,
        active: true,
        highlighted: true,
        title: 'Allowed',
        url: 'https://allowed.example/start',
        windowId: 1,
        status: 'complete',
        _navigateFinal: { title: 'Allowed', url: 'https://allowed.example/next' }
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

    await background.handleBridgeRequest('claim_tab', { tabId: 1 });
    tabs[0].url = 'https://blocked.example/drifted';

    await expect(background.handleBridgeRequest('navigate', { sessionTabId: 'tab-1', url: 'https://allowed.example/next' })).resolves.toEqual(
      withNavigateMetadata({
        id: 1,
        url: 'https://allowed.example/next',
        title: 'Allowed',
        status: 'complete',
        source: 'extension'
      })
    );
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

    await expect(background.handleBridgeRequest('navigate', { url: 'https://example.com/start' })).resolves.toEqual(
      withNavigateMetadata({
        id: 2,
        url: 'https://example.com/start',
        title: 'New Tab',
        status: 'complete',
        source: 'extension'
      })
    );
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toMatchObject({ id: 2, url: 'https://example.com/start' });
  });

  it('creates a background tab when navigate has no target and active is false', async () => {
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

    await expect(
      background.handleBridgeRequest('navigate', { url: 'https://example.com/start', active: false })
    ).resolves.toMatchObject({
      id: 2,
      finalUrl: 'https://example.com/start'
    });
    expect(tabs[0]).toMatchObject({ id: 1, active: true });
    expect(tabs[1]).toMatchObject({ id: 2, url: 'https://example.com/start', active: false });
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

  it('names sessions, claims tabs, and routes default page actions to the claimed tab', async () => {
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
          title: 'Active',
          url: 'https://allowed.example/active',
          windowId: 1
        },
        {
          id: 2,
          active: false,
          highlighted: false,
          status: 'complete',
          title: 'Claimed',
          url: 'https://allowed.example/claimed',
          windowId: 1
        }
      ],
      contentResult: (_tabId, message) => ({ action: message.action, params: message.params })
    });

    await expect(background.handleBridgeRequest('name_session', { name: ' Docs task ' })).resolves.toEqual({ name: 'Docs task' });
    await expect(background.handleBridgeRequest('claim_tab', { tabId: 2 })).resolves.toMatchObject({
      sessionTabId: 'tab-1',
      tabId: 2,
      title: 'Claimed'
    });
    await expect(background.handleBridgeRequest('snapshot')).resolves.toMatchObject({
      action: 'snapshot'
    });
    expect(background.sentMessages.at(-1)).toMatchObject({
      tabId: 2,
      message: { action: 'snapshot' }
    });
    await expect(background.handleBridgeRequest('ping')).resolves.toMatchObject({
      session: { name: 'Docs task', claimedTabs: [{ sessionTabId: 'tab-1', tabId: 2 }] }
    });
  });

  it('rejects stale claimed tabs instead of falling back to the active tab', async () => {
    const tabs = [
      {
        id: 2,
        active: false,
        highlighted: false,
        status: 'complete',
        title: 'Claimed',
        url: 'https://allowed.example/claimed',
        windowId: 1
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

    await background.handleBridgeRequest('claim_tab', { tabId: 2 });
    tabs.pop();

    await expect(background.handleBridgeRequest('page_status')).rejects.toThrow(
      'Claimed tab is no longer available'
    );
  });

  it('clears exclusive lease when a claimed tab disappears', async () => {
    const tabs = [
      {
        id: 2,
        active: false,
        highlighted: false,
        status: 'complete',
        title: 'Claimed',
        url: 'https://allowed.example/claimed',
        windowId: 1
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

    await background.handleBridgeRequest('claim_tab', {
      tabId: 2,
      exclusive: true,
      ownerId: 'owner-a',
      ttlMs: 60_000
    });
    tabs.pop();

    await expect(background.handleBridgeRequest('page_status')).rejects.toThrow(
      'Claimed tab is no longer available'
    );

    tabs.push({
      id: 2,
      active: false,
      highlighted: false,
      status: 'complete',
      title: 'Reopened',
      url: 'https://allowed.example/claimed',
      windowId: 1
    });

    await expect(
      background.handleBridgeRequest('claim_tab', {
        tabId: 2,
        exclusive: true,
        ownerId: 'owner-b',
        ttlMs: 60_000
      })
    ).resolves.toMatchObject({ exclusive: true, ownerId: 'owner-b' });
  });

  it('releases and finalizes claimed tabs without closing user tabs', async () => {
    const tabs = [
      {
        id: 1,
        active: true,
        highlighted: true,
        status: 'complete',
        title: 'One',
        url: 'https://allowed.example/one',
        windowId: 1
      },
      {
        id: 2,
        active: false,
        highlighted: false,
        status: 'complete',
        title: 'Two',
        url: 'https://allowed.example/two',
        windowId: 1
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

    await background.handleBridgeRequest('claim_tab', { tabId: 1 });
    await background.handleBridgeRequest('claim_tab', { tabId: 2 });
    await expect(background.handleBridgeRequest('release_tab', { tabId: 1 })).resolves.toEqual({
      released: true,
      sessionTabId: 'tab-1',
      tabId: 1
    });
    await background.handleBridgeRequest('page_status');
    expect(background.sentMessages.at(-1)).toMatchObject({
      tabId: 2,
      message: { action: 'page_status' }
    });
    await expect(background.handleBridgeRequest('finalize_tabs', { keep: [{ tabId: 2, status: 'handoff' }] })).resolves.toEqual({
      released: 0,
      kept: 1
    });
    expect(tabs).toHaveLength(2);
    await expect(background.handleBridgeRequest('finalize_tabs')).resolves.toEqual({ released: 1, kept: 0 });
    expect(tabs).toHaveLength(2);
  });

  it('keeps allowed-origin enforcement before claim and screenshot actions', async () => {
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
          url: 'https://blocked.example/',
          windowId: 1
        }
      ]
    });

    await expect(background.handleBridgeRequest('claim_tab', { tabId: 1 })).rejects.toThrow('unapproved origin');
    await expect(background.handleBridgeRequest('screenshot', { tabId: 1 })).rejects.toThrow('unapproved origin');
    expect(background.captures).toHaveLength(0);
  });

  it('captures a visible viewport screenshot for an allowed tab', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs: [
        {
          id: 1,
          active: false,
          highlighted: false,
          status: 'complete',
          title: 'Allowed',
          url: 'https://allowed.example/',
          windowId: 1
        }
      ]
    });

    await expect(background.handleBridgeRequest('screenshot', { tabId: 1, format: 'jpeg' })).resolves.toEqual({
      dataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
      mimeType: 'image/jpeg',
      tabId: 1,
      windowId: 1,
      visibleOnly: true,
      activated: true
    });
    expect(background.captures).toEqual([{ windowId: 1, options: { format: 'jpeg' } }]);
  });

  it('waits for inactive screenshot targets to become active before capture', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs: [
        {
          id: 1,
          active: false,
          highlighted: false,
          status: 'complete',
          title: 'Allowed',
          url: 'https://allowed.example/',
          windowId: 1,
          _activateAfterGets: 2
        }
      ]
    });

    await expect(background.handleBridgeRequest('screenshot', { tabId: 1 })).resolves.toMatchObject({
      mimeType: 'image/png',
      activated: true
    });
    expect(background.tabs[0].active).toBe(true);
    expect(background.captures).toEqual([{ windowId: 1, options: { format: 'png' } }]);
  });

  it('requires optional <all_urls> permission for wildcard screenshots before capture', async () => {
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
          title: 'Allowed',
          url: 'https://example.com/',
          windowId: 1
        }
      ]
    });

    await expect(background.handleBridgeRequest('screenshot', { tabId: 1 })).rejects.toThrow('optional <all_urls> host permission');
    expect(background.captures).toHaveLength(0);
  });

  it('does not treat http/https wildcard host grants as sufficient for wildcard screenshots', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['http://*/*', 'https://*/*']
      },
      grantedOrigins: ['http://*/*', 'https://*/*'],
      tabs: [
        {
          id: 1,
          active: true,
          highlighted: true,
          status: 'complete',
          title: 'Allowed',
          url: 'https://example.com/',
          windowId: 1
        }
      ]
    });

    await expect(background.handleBridgeRequest('screenshot', { tabId: 1 })).rejects.toThrow('optional <all_urls> host permission');
    expect(background.captures).toHaveLength(0);
  });

  it('does not treat a named optional <all_urls> permission as valid manifest placement', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['http://*/*', 'https://*/*']
      },
      grantedPermissions: ['<all_urls>'],
      tabs: [
        {
          id: 1,
          active: true,
          highlighted: true,
          status: 'complete',
          title: 'Allowed',
          url: 'https://example.com/',
          windowId: 1
        }
      ]
    });

    await expect(background.handleBridgeRequest('screenshot', { tabId: 1 })).rejects.toThrow('optional <all_urls> host permission');
    expect(background.captures).toHaveLength(0);
  });

  it('captures wildcard screenshots after optional <all_urls> host permission is granted', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['http://*/*', 'https://*/*']
      },
      grantedOrigins: ['<all_urls>'],
      tabs: [
        {
          id: 1,
          active: true,
          highlighted: true,
          status: 'complete',
          title: 'Allowed',
          url: 'https://example.com/',
          windowId: 1
        }
      ]
    });

    await expect(background.handleBridgeRequest('screenshot', { tabId: 1 })).resolves.toMatchObject({
      mimeType: 'image/png',
      visibleOnly: true
    });
    expect(background.captures).toEqual([{ windowId: 1, options: { format: 'png' } }]);
  });

  it('maps native Chrome screenshot permission failures to an actionable project error', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['http://*/*', 'https://*/*']
      },
      grantedOrigins: ['<all_urls>'],
      captureError: new Error("Either the '<all_urls>' or 'activeTab' permission is required."),
      tabs: [
        {
          id: 1,
          active: true,
          highlighted: true,
          status: 'complete',
          title: 'Allowed',
          url: 'https://example.com/',
          windowId: 1
        }
      ]
    });

    await expect(background.handleBridgeRequest('screenshot', { tabId: 1 })).rejects.toThrow(
      'screenshot capture was blocked by Chrome permissions'
    );
    expect(background.captures).toEqual([{ windowId: 1, options: { format: 'png' } }]);
  });

  it('rejects exclusive claim conflicts with structured holder metadata', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs: [
        {
          id: 2,
          active: false,
          highlighted: false,
          status: 'complete',
          title: 'Claimed',
          url: 'https://allowed.example/claimed',
          windowId: 1
        }
      ]
    });

    await background.handleBridgeRequest('name_session', { name: 'Audit A' });
    await expect(
      background.handleBridgeRequest('claim_tab', {
        tabId: 2,
        exclusive: true,
        ownerId: 'owner-a',
        owner: 'Agent A',
        ttlMs: 60_000
      })
    ).resolves.toMatchObject({ exclusive: true, ownerId: 'owner-a', owner: 'Agent A' });

    await background.handleBridgeRequest('name_session', { name: 'Caller B' });

    try {
      await background.handleBridgeRequest('claim_tab', {
        tabId: 2,
        exclusive: true,
        ownerId: 'owner-b',
        ttlMs: 60_000
      });
      throw new Error('expected conflict');
    } catch (error) {
      expect((error as Error).message).toContain('TAB_EXCLUSIVE_CLAIM_CONFLICT');
      const payload = JSON.parse((error as Error).message);
      expect(payload).toMatchObject({
        code: 'TAB_EXCLUSIVE_CLAIM_CONFLICT',
        tabId: 2,
        holder: { ownerId: 'owner-a', owner: 'Agent A', sessionName: 'Audit A' }
      });
      expect(payload.holder.sessionName).not.toBe('Caller B');
    }
  });

  it('allows same-owner exclusive lease renewal and expiry release', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs: [
        {
          id: 2,
          active: false,
          highlighted: false,
          status: 'complete',
          title: 'Claimed',
          url: 'https://allowed.example/claimed',
          windowId: 1
        }
      ]
    });

    await expect(
      background.handleBridgeRequest('claim_tab', { tabId: 2, exclusive: true, ownerId: 'owner-a', ttlMs: 1000 })
    ).resolves.toMatchObject({ exclusive: true, ownerId: 'owner-a' });

    background.advanceTime(1500);

    await expect(
      background.handleBridgeRequest('claim_tab', { tabId: 2, exclusive: true, ownerId: 'owner-b', ttlMs: 1000 })
    ).resolves.toMatchObject({ exclusive: true, ownerId: 'owner-b' });
  });

  it('does not let advisory claim overwrite exclusive lease metadata', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs: [
        {
          id: 2,
          active: false,
          highlighted: false,
          status: 'complete',
          title: 'Claimed',
          url: 'https://allowed.example/claimed',
          windowId: 1
        }
      ]
    });

    await background.handleBridgeRequest('name_session', { name: 'Holder A' });
    await background.handleBridgeRequest('claim_tab', {
      tabId: 2,
      exclusive: true,
      ownerId: 'owner-a',
      owner: 'Agent A',
      ttlMs: 60_000
    });

    await background.handleBridgeRequest('name_session', { name: 'Caller B' });
    try {
      await background.handleBridgeRequest('claim_tab', { tabId: 2 });
      throw new Error('expected conflict');
    } catch (error) {
      const payload = JSON.parse((error as Error).message);
      expect(payload).toMatchObject({
        code: 'TAB_EXCLUSIVE_CLAIM_CONFLICT',
        tabId: 2,
        holder: { ownerId: 'owner-a', owner: 'Agent A', sessionName: 'Holder A' }
      });
    }

    await expect(background.handleBridgeRequest('list_tabs')).resolves.toEqual([
      expect.objectContaining({
        id: 2,
        exclusiveLease: expect.objectContaining({ ownerId: 'owner-a' })
      })
    ]);

    await expect(
      background.handleBridgeRequest('claim_tab', {
        tabId: 2,
        exclusive: true,
        ownerId: 'owner-a',
        ttlMs: 60_000
      })
    ).resolves.toMatchObject({ exclusive: true, ownerId: 'owner-a', leaseRenewed: true });

    await expect(background.handleBridgeRequest('release_tab', { tabId: 2 })).resolves.toMatchObject({
      released: true,
      tabId: 2
    });

    await expect(
      background.handleBridgeRequest('claim_tab', {
        tabId: 2,
        exclusive: true,
        ownerId: 'owner-c',
        ttlMs: 60_000
      })
    ).resolves.toMatchObject({ exclusive: true, ownerId: 'owner-c' });
  });

  it('does not let an advisory sessionTabId release a later exclusive lease', async () => {
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs: [
        {
          id: 2,
          active: false,
          highlighted: false,
          status: 'complete',
          title: 'Claimed',
          url: 'https://allowed.example/claimed',
          windowId: 1
        }
      ]
    });

    const advisory = await background.handleBridgeRequest('claim_tab', { tabId: 2 });
    expect(advisory.sessionTabId).toBe('tab-1');

    const exclusive = await background.handleBridgeRequest('claim_tab', {
      tabId: 2,
      exclusive: true,
      ownerId: 'owner-a',
      ttlMs: 60_000
    });
    expect(exclusive.sessionTabId).not.toBe(advisory.sessionTabId);

    await expect(background.handleBridgeRequest('release_tab', { sessionTabId: advisory.sessionTabId })).rejects.toThrow(
      'No matching claimed tab to release'
    );

    await expect(background.handleBridgeRequest('list_tabs')).resolves.toEqual([
      expect.objectContaining({
        id: 2,
        exclusiveLease: expect.objectContaining({ ownerId: 'owner-a' })
      })
    ]);

    await expect(
      background.handleBridgeRequest('release_tab', { sessionTabId: exclusive.sessionTabId })
    ).resolves.toMatchObject({ released: true, tabId: 2 });
  });

  it('navigates with active:false without activating the tab', async () => {
    const tabs = [
      {
        id: 1,
        active: false,
        highlighted: false,
        title: 'Background',
        url: 'https://allowed.example/docs',
        windowId: 1,
        status: 'complete',
        _activateAfterGets: 2,
        _navigateFinal: { title: 'Next', url: 'https://allowed.example/next' }
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

    await expect(
      background.handleBridgeRequest('navigate', { tabId: 1, url: 'https://allowed.example/next', active: false })
    ).resolves.toMatchObject({
      finalUrl: 'https://allowed.example/next',
      redirected: false
    });
    expect(tabs[0].active).toBe(false);
  });

  it('reports redirected=true when final URL differs from requested URL', async () => {
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
          title: 'Allowed',
          url: 'https://allowed.example/docs',
          windowId: 1,
          status: 'complete',
          _navigateFinal: { title: 'Canonical', url: 'https://allowed.example/canonical/' }
        }
      ]
    });

    await expect(
      background.handleBridgeRequest('navigate', { tabId: 1, url: 'https://allowed.example/vanity' })
    ).resolves.toMatchObject({
      requestedUrl: 'https://allowed.example/vanity',
      finalUrl: 'https://allowed.example/canonical/',
      redirected: true,
      url: 'https://allowed.example/canonical/'
    });
  });
});
