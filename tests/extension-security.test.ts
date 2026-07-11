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

function withTopDocumentMetadata(expected: Record<string, unknown>, tabId = 1) {
  return {
    ...expected,
    documentId: `doc-${tabId}`,
    frameId: 0,
    isTopFrame: true,
    coordinateSpace: 'tabViewport'
  };
}

function successfulTopStep(index: number, action: string, params: Record<string, unknown>) {
  return { index, action, ok: true, result: withTopDocumentMetadata({ action, params }) };
}

function loadBackgroundHarness({
  settings,
  tabs,
  bridgeStatus = 'connected',
  staleActiveTab,
  contentResult = {},
  grantedOrigins,
  grantedPermissions = [],
  captureError,
  frames,
  contentReady = true,
  sendMessageError
}: {
  settings: Record<string, unknown>;
  tabs: Array<Record<string, unknown>>;
  bridgeStatus?: string;
  staleActiveTab?: Record<string, unknown>;
  contentResult?:
    | Record<string, unknown>
    | ((tabId: number, message: Record<string, unknown>, options: { documentId?: string }) => Record<string, unknown>);
  grantedOrigins?: string[];
  grantedPermissions?: string[];
  captureError?: Error;
  frames?: Array<Record<string, unknown>>;
  contentReady?: boolean;
  sendMessageError?: (message: Record<string, unknown>, options: { documentId?: string }) => Error | undefined;
}) {
  let now = 0;
  let nextTabId = Math.max(0, ...tabs.map((tab) => Number(tab.id) || 0)) + 1;
  let tabGetCount = 0;
  const sentMessages: Array<{ tabId: number; message: Record<string, unknown> }> = [];
  const messageTargets: Array<{ tabId: number; documentId?: string }> = [];
  const injectionTargets: Array<Record<string, unknown>> = [];
  let contentListenerReady = contentReady;
  const captures: Array<{ windowId: number; options: Record<string, unknown> }> = [];
  const tabRemovedListeners: Array<(tabId: number) => void> = [];
  const FakeDate = class extends Date {
    static now() {
      return now;
    }
  };
  const effectiveGrantedOrigins = grantedOrigins ?? (Array.isArray(settings.allowedOrigins) ? settings.allowedOrigins : []);
  const configuredFrames =
    frames ??
    tabs.map((tab) => ({
      tabId: tab.id,
      frameId: 0,
      parentFrameId: -1,
      documentId: `doc-${tab.id}`,
      url: tab.url,
      documentLifecycle: 'active',
      frameType: 'outermost_frame'
    }));
  const originMatches = (grant: string, requested: string) => {
    if (grant === '<all_urls>') return true;
    const escaped = grant.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${escaped}$`).test(requested);
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
        origins: effectiveGrantedOrigins,
        permissions: grantedPermissions
      }),
      contains: (request: { origins?: string[]; permissions?: string[] }, callback?: (granted: boolean) => void) => {
        const originsGranted = (request.origins || []).every((origin) =>
          effectiveGrantedOrigins.some((grant) => originMatches(grant, origin))
        );
        const permissionsGranted = (request.permissions || []).every((permission) => grantedPermissions.includes(permission));
        const granted = originsGranted && permissionsGranted;
        callback?.(granted);
        return Promise.resolve(granted);
      }
    },
    tabs: {
      onRemoved: {
        addListener: (listener: (tabId: number) => void) => {
          tabRemovedListeners.push(listener);
        }
      },
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
        tabGetCount += 1;
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
      sendMessage: async (tabId: number, message: Record<string, unknown>, options: { documentId?: string } = {}) => {
        sentMessages.push({ tabId, message });
        messageTargets.push({ tabId, documentId: options.documentId });
        const targetedError = sendMessageError?.(message, options);
        if (targetedError) throw targetedError;
        if (message?.action === 'ping') {
          if (!contentListenerReady) throw new Error('Could not establish connection. Receiving end does not exist.');
          return { ok: true, result: { ready: true } };
        }
        try {
          const result = typeof contentResult === 'function' ? contentResult(tabId, message, options) : contentResult;
          return { ok: true, result };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
      captureVisibleTab: async (windowId: number, options: Record<string, unknown>) => {
        captures.push({ windowId, options });
        if (captureError) throw captureError;
        return `data:image/${options.format};base64,ZmFrZQ==`;
      }
    },
    webNavigation: {
      getAllFrames: async ({ tabId }: { tabId: number }) =>
        configuredFrames
          .filter((frame) => frame.tabId === tabId)
          .map(({ tabId: _tabId, ...frame }) => frame),
      getFrame: async ({ tabId, frameId, documentId }: { tabId: number; frameId?: number; documentId?: string }) => {
        const found = configuredFrames.find(
          (frame) =>
            frame.tabId === tabId &&
            (documentId === undefined || frame.documentId === documentId) &&
            (frameId === undefined || frame.frameId === frameId)
        );
        if (!found) return null;
        const { tabId: _tabId, frameId: _frameId, ...frame } = found;
        return frame;
      }
    },
    scripting: {
      executeScript: async (details: Record<string, unknown>) => {
        injectionTargets.push(details);
        if ((details.files as string[] | undefined)?.includes('content.js')) contentListenerReady = true;
        return undefined;
      }
    }
  };
  const drawImageCalls: unknown[][] = [];
  class FakeOffscreenCanvas {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return {
        drawImage: (...args: unknown[]) => {
          drawImageCalls.push(args);
        }
      };
    }
    async convertToBlob({ type }: { type: string }) {
      return {
        type,
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer
      };
    }
  }
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
    clearTimeout,
    fetch: async () => ({
      blob: async () => ({})
    }),
    createImageBitmap: async () => ({
      width: 200,
      height: 200,
      close: () => undefined
    }),
    OffscreenCanvas: FakeOffscreenCanvas,
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    Uint8Array
  });
  (context as any).globalThis = context;
  vm.runInContext(readFileSync(join(process.cwd(), 'extension/security.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(process.cwd(), 'extension/background.js'), 'utf8'), context);
  return Object.assign((context as any).BrowserControlBackground, {
    sentMessages,
    messageTargets,
    injectionTargets,
    frames: configuredFrames,
    captures,
    drawImageCalls,
    tabs,
    tabGetCount: () => tabGetCount,
    resetTabGetCount() {
      tabGetCount = 0;
    },
    advanceTime(ms: number) {
      now += ms;
    },
    removeTab(tabId: number) {
      const index = tabs.findIndex((tab) => tab.id === tabId);
      if (index >= 0) tabs.splice(index, 1);
      for (const listener of tabRemovedListeners) listener(tabId);
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
      protocolVersion: 6,
      features: expect.arrayContaining([
        'document-targeting',
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

  it('discovers allowed same-origin and cross-origin frames and redacts blocked or unsupported rows', async () => {
    const frames = [
      {
        tabId: 1,
        frameId: 0,
        parentFrameId: -1,
        documentId: 'top-doc',
        url: 'https://allowed.example/',
        documentLifecycle: 'active',
        frameType: 'outermost_frame'
      },
      {
        tabId: 1,
        frameId: 2,
        parentFrameId: 0,
        documentId: 'same-doc',
        parentDocumentId: 'top-doc',
        url: 'https://allowed.example/frame',
        documentLifecycle: 'active',
        frameType: 'sub_frame'
      },
      {
        tabId: 1,
        frameId: 3,
        parentFrameId: 0,
        documentId: 'cross-doc',
        parentDocumentId: 'top-doc',
        url: 'https://cross.example/frame',
        documentLifecycle: 'active',
        frameType: 'sub_frame'
      },
      {
        tabId: 1,
        frameId: 4,
        parentFrameId: 0,
        documentId: 'blocked-secret-doc',
        parentDocumentId: 'top-doc',
        url: 'https://blocked.example/private',
        documentLifecycle: 'active',
        frameType: 'sub_frame'
      },
      {
        tabId: 1,
        frameId: 5,
        parentFrameId: 0,
        documentId: 'opaque-secret-doc',
        parentDocumentId: 'top-doc',
        url: 'about:blank',
        documentLifecycle: 'active',
        frameType: 'sub_frame'
      },
      {
        tabId: 1,
        frameId: 6,
        parentFrameId: 0,
        documentId: 'fenced-secret-doc',
        parentDocumentId: 'top-doc',
        url: 'https://allowed.example/fenced',
        documentLifecycle: 'active',
        frameType: 'fenced_frame'
      }
    ];
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*', 'https://cross.example/*']
      },
      tabs: [
        {
          id: 1,
          active: true,
          highlighted: true,
          title: 'Allowed',
          url: 'https://allowed.example/',
          windowId: 1,
          status: 'complete'
        }
      ],
      frames,
      grantedOrigins: ['https://allowed.example/*', 'https://cross.example/*']
    });

    const result = await background.handleBridgeRequest('list_frames', { tabId: 1 });
    expect(result.slice(0, 3)).toEqual([
      expect.objectContaining({ documentId: 'top-doc', url: 'https://allowed.example/', operable: true }),
      expect.objectContaining({ documentId: 'same-doc', parentDocumentId: 'top-doc', operable: true }),
      expect.objectContaining({ documentId: 'cross-doc', parentDocumentId: 'top-doc', operable: true })
    ]);
    for (const row of result.slice(3)) {
      expect(row).toMatchObject({ urlRedacted: true, operable: false });
      expect(row).not.toHaveProperty('url');
      expect(row).not.toHaveProperty('documentId');
      expect(row).not.toHaveProperty('parentDocumentId');
      expect(JSON.stringify(row)).not.toContain('secret');
    }
    expect(result[3]).toMatchObject({ allowedByPolicy: false, hostPermissionGranted: null, reason: 'policy_denied' });
    expect(result[4]).toMatchObject({ schemeSupported: false, allowedByPolicy: null, hostPermissionGranted: null });
    expect(result[5]).toMatchObject({ frameTypeSupported: false, allowedByPolicy: null, hostPermissionGranted: null });
  });

  it('uses wildcard-capable host permission checks and redacts host-denied documents', async () => {
    const frames = [
      {
        tabId: 1,
        frameId: 0,
        parentFrameId: -1,
        documentId: 'top-doc',
        url: 'https://allowed.example/',
        documentLifecycle: 'active',
        frameType: 'outermost_frame'
      },
      {
        tabId: 1,
        frameId: 2,
        parentFrameId: 0,
        documentId: 'wildcard-doc',
        parentDocumentId: 'top-doc',
        url: 'https://wildcard.example/frame',
        documentLifecycle: 'active',
        frameType: 'sub_frame'
      },
      {
        tabId: 1,
        frameId: 3,
        parentFrameId: 0,
        documentId: 'denied-secret-doc',
        parentDocumentId: 'top-doc',
        url: 'https://denied.example/frame',
        documentLifecycle: 'active',
        frameType: 'sub_frame'
      }
    ];
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['http://*/*', 'https://*/*']
      },
      tabs: [{ id: 1, active: true, url: 'https://allowed.example/', windowId: 1, status: 'complete' }],
      frames,
      grantedOrigins: ['https://allowed.example/*', 'https://wildcard.example/*']
    });

    const result = await background.handleBridgeRequest('list_frames', { tabId: 1 });
    expect(result[1]).toMatchObject({ documentId: 'wildcard-doc', hostPermissionGranted: true, operable: true });
    expect(result[2]).toMatchObject({ urlRedacted: true, allowedByPolicy: true, hostPermissionGranted: false });
    expect(result[2]).not.toHaveProperty('url');
    expect(result[2]).not.toHaveProperty('documentId');
  });

  it('routes every ping, injection, and message to the exact child document and strips routing params', async () => {
    const frames = [
      {
        tabId: 1,
        frameId: 0,
        parentFrameId: -1,
        documentId: 'top-doc',
        url: 'https://allowed.example/',
        documentLifecycle: 'active',
        frameType: 'outermost_frame'
      },
      {
        tabId: 1,
        frameId: 7,
        parentFrameId: 0,
        documentId: 'child-doc',
        parentDocumentId: 'top-doc',
        url: 'https://cross.example/frame',
        documentLifecycle: 'active',
        frameType: 'sub_frame'
      }
    ];
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*', 'https://cross.example/*']
      },
      tabs: [{ id: 1, active: true, url: 'https://allowed.example/', windowId: 1, status: 'complete' }],
      frames,
      contentReady: false,
      contentResult: (_tabId, message) => ({ action: message.action, params: message.params })
    });

    await expect(
      background.handleBridgeRequest('snapshot', { tabId: 1, documentId: 'child-doc', mode: 'visible' })
    ).resolves.toEqual(
      expect.objectContaining({ documentId: 'child-doc', frameId: 7, isTopFrame: false, coordinateSpace: 'frameViewport' })
    );
    expect(background.injectionTargets).toEqual([
      { target: { tabId: 1, documentIds: ['child-doc'] }, files: ['content-core.js'] },
      { target: { tabId: 1, documentIds: ['child-doc'] }, files: ['content.js'] }
    ]);
    expect(background.messageTargets.every((target: { documentId?: string }) => target.documentId === 'child-doc')).toBe(true);
    expect(background.sentMessages.at(-1)?.message.params).toEqual({ mode: 'visible' });
  });

  it('fails exact targets for wrong tabs, disappeared documents, replacements, and unsupported frames', async () => {
    const frames = [
      {
        tabId: 1,
        frameId: 0,
        parentFrameId: -1,
        documentId: 'top-doc',
        url: 'https://allowed.example/',
        documentLifecycle: 'active',
        frameType: 'outermost_frame'
      },
      {
        tabId: 1,
        frameId: 8,
        parentFrameId: 0,
        documentId: 'replacement-doc',
        url: 'https://allowed.example/replacement',
        documentLifecycle: 'active',
        frameType: 'sub_frame'
      },
      {
        tabId: 1,
        frameId: 9,
        parentFrameId: 0,
        documentId: 'fenced-doc',
        url: 'https://allowed.example/fenced',
        documentLifecycle: 'active',
        frameType: 'fenced_frame'
      },
      {
        tabId: 1,
        frameId: 10,
        parentFrameId: 0,
        documentId: 'inactive-doc',
        url: 'https://allowed.example/inactive',
        documentLifecycle: 'cached',
        frameType: 'sub_frame'
      },
      {
        tabId: 1,
        frameId: 11,
        parentFrameId: 0,
        documentId: 'policy-doc',
        url: 'https://blocked.example/private',
        documentLifecycle: 'active',
        frameType: 'sub_frame'
      },
      {
        tabId: 1,
        frameId: 12,
        parentFrameId: 0,
        documentId: 'host-denied-doc',
        url: 'https://host-denied.example/frame',
        documentLifecycle: 'active',
        frameType: 'sub_frame'
      },
      {
        tabId: 2,
        frameId: 4,
        parentFrameId: 0,
        documentId: 'other-tab-doc',
        url: 'https://allowed.example/other',
        documentLifecycle: 'active',
        frameType: 'sub_frame'
      }
    ];
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*', 'https://host-denied.example/*']
      },
      tabs: [
        { id: 1, active: true, url: 'https://allowed.example/', windowId: 1, status: 'complete' },
        { id: 2, active: false, url: 'https://allowed.example/other', windowId: 1, status: 'complete' }
      ],
      frames,
      grantedOrigins: ['https://allowed.example/*']
    });

    for (const documentId of ['other-tab-doc', 'missing-doc', 'old-document-for-frame-8']) {
      await expect(background.handleBridgeRequest('snapshot', { tabId: 1, documentId })).rejects.toThrow('DOCUMENT_STALE:');
    }
    await expect(background.handleBridgeRequest('snapshot', { tabId: 1, documentId: 'fenced-doc' })).rejects.toThrow(
      'DOCUMENT_UNSUPPORTED:'
    );
    await expect(background.handleBridgeRequest('snapshot', { tabId: 1, documentId: 'inactive-doc' })).rejects.toThrow(
      'DOCUMENT_STALE:'
    );
    await expect(background.handleBridgeRequest('snapshot', { tabId: 1, documentId: 'policy-doc' })).rejects.toThrow(
      'DOCUMENT_POLICY_DENIED:'
    );
    await expect(background.handleBridgeRequest('snapshot', { tabId: 1, documentId: 'host-denied-doc' })).rejects.toThrow(
      'DOCUMENT_HOST_PERMISSION_DENIED:'
    );
    expect(background.sentMessages).toEqual([]);
  });

  it('treats a retained old document as stale when its frame has an active replacement', async () => {
    const frames = [
      {
        tabId: 1,
        frameId: 0,
        parentFrameId: -1,
        documentId: 'top-doc',
        url: 'https://allowed.example/',
        documentLifecycle: 'active',
        frameType: 'outermost_frame'
      },
      {
        tabId: 1,
        frameId: 4,
        parentFrameId: 0,
        documentId: 'old-child-doc',
        url: 'https://allowed.example/old',
        documentLifecycle: 'pending_deletion',
        frameType: 'sub_frame'
      },
      {
        tabId: 1,
        frameId: 4,
        parentFrameId: 0,
        documentId: 'replacement-child-doc',
        url: 'https://allowed.example/new',
        documentLifecycle: 'active',
        frameType: 'sub_frame'
      }
    ];
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs: [{ id: 1, active: true, url: 'https://allowed.example/', windowId: 1, status: 'complete' }],
      frames,
      contentResult: { ref: 'h1' }
    });

    await expect(
      background.handleBridgeRequest('snapshot', { tabId: 1, documentId: 'old-child-doc' })
    ).rejects.toThrow('DOCUMENT_STALE:');
    await expect(
      background.handleBridgeRequest('snapshot', { tabId: 1, documentId: 'replacement-child-doc' })
    ).resolves.toMatchObject({
      documentId: 'replacement-child-doc',
      frameId: 4,
      isTopFrame: false,
      coordinateSpace: 'frameViewport'
    });
    expect(background.messageTargets.every((target: { documentId?: string }) => target.documentId === 'replacement-child-doc')).toBe(true);
  });

  it('reports host permission revocation during a targeted message with the stable permission prefix', async () => {
    const grantedOrigins = ['https://allowed.example/*'];
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs: [{ id: 1, active: true, url: 'https://allowed.example/', windowId: 1, status: 'complete' }],
      grantedOrigins,
      sendMessageError: (message) => {
        if (message.action !== 'snapshot') return undefined;
        grantedOrigins.splice(0);
        return new Error('Cannot access contents of the page');
      }
    });

    await expect(background.handleBridgeRequest('snapshot', { tabId: 1 })).rejects.toThrow(
      'DOCUMENT_HOST_PERMISSION_DENIED:'
    );
  });

  it('disambiguates colliding refs by exact document routing and target metadata', async () => {
    const frames = [
      {
        tabId: 1,
        frameId: 0,
        parentFrameId: -1,
        documentId: 'top-doc',
        url: 'https://allowed.example/',
        documentLifecycle: 'active',
        frameType: 'outermost_frame'
      },
      {
        tabId: 1,
        frameId: 2,
        parentFrameId: 0,
        documentId: 'child-doc',
        url: 'https://allowed.example/frame',
        documentLifecycle: 'active',
        frameType: 'sub_frame'
      }
    ];
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs: [{ id: 1, active: true, url: 'https://allowed.example/', windowId: 1, status: 'complete' }],
      frames,
      contentResult: (_tabId, _message, options) => ({ ref: 'h1', executionContext: options.documentId })
    });

    const top = await background.handleBridgeRequest('snapshot', { tabId: 1, documentId: 'top-doc' });
    const child = await background.handleBridgeRequest('snapshot', { tabId: 1, documentId: 'child-doc' });
    expect(top).toMatchObject({ ref: 'h1', executionContext: 'top-doc', documentId: 'top-doc', coordinateSpace: 'tabViewport' });
    expect(child).toMatchObject({ ref: 'h1', executionContext: 'child-doc', documentId: 'child-doc', coordinateSpace: 'frameViewport' });
  });

  it('revalidates fixed explicit documents across batches and after observations without changing stable prefixes', async () => {
    const frames = [
      {
        tabId: 1,
        frameId: 0,
        parentFrameId: -1,
        documentId: 'top-doc',
        url: 'https://allowed.example/',
        documentLifecycle: 'active',
        frameType: 'outermost_frame'
      },
      {
        tabId: 1,
        frameId: 2,
        parentFrameId: 0,
        documentId: 'child-doc',
        url: 'https://allowed.example/frame',
        documentLifecycle: 'active',
        frameType: 'sub_frame'
      }
    ];
    let replaceAfterAction = true;
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs: [{ id: 1, active: true, url: 'https://allowed.example/', windowId: 1, status: 'complete' }],
      frames,
      contentResult: (_tabId, message) => {
        if (replaceAfterAction && message.action === 'click') {
          const child = frames.find((frame) => frame.frameId === 2);
          if (child) child.documentId = 'replacement-doc';
          replaceAfterAction = false;
        }
        return { action: message.action };
      }
    });

    await expect(
      background.handleBridgeRequest('perform_actions', {
        tabId: 1,
        documentId: 'child-doc',
        actions: [
          { action: 'click', ref: 'h1' },
          { action: 'scroll', deltaY: 1 }
        ]
      })
    ).resolves.toMatchObject({
      ok: false,
      failedIndex: 1,
      steps: [{ ok: true }, { ok: false, error: expect.stringMatching(/^DOCUMENT_STALE:/) }]
    });

    frames[1].documentId = 'child-doc';
    replaceAfterAction = true;
    await expect(
      background.handleBridgeRequest('click', {
        tabId: 1,
        documentId: 'child-doc',
        ref: 'h1',
        after: { snapshot: true }
      })
    ).resolves.toMatchObject({
      documentId: 'child-doc',
      after: { ok: false, error: expect.stringMatching(/^DOCUMENT_STALE:/) }
    });
  });

  it('follows the current top document between omitted-target batch operations', async () => {
    const frames = [
      {
        tabId: 1,
        frameId: 0,
        parentFrameId: -1,
        documentId: 'top-a',
        url: 'https://allowed.example/',
        documentLifecycle: 'active',
        frameType: 'outermost_frame'
      }
    ];
    const background = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://allowed.example/*']
      },
      tabs: [{ id: 1, active: true, url: 'https://allowed.example/', windowId: 1, status: 'complete' }],
      frames,
      contentResult: (_tabId, message) => {
        if (message.action === 'click') frames[0].documentId = 'top-b';
        return { action: message.action };
      }
    });

    await expect(
      background.handleBridgeRequest('perform_actions', {
        tabId: 1,
        actions: [
          { action: 'click', ref: 'h1' },
          { action: 'scroll', deltaY: 1 }
        ],
        after: { pageStatus: true }
      })
    ).resolves.toMatchObject({
      ok: true,
      steps: [{ result: { documentId: 'top-a' } }, { result: { documentId: 'top-b' } }],
      after: { pageStatus: { documentId: 'top-b' } }
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
    ).resolves.toEqual(withTopDocumentMetadata({
      action: 'click',
      params: { ref: 'h1' },
      after: {
        waitFor: withTopDocumentMetadata({ action: 'wait_for', params: { selector: '.ready', timeoutMs: 1000 } }),
        snapshot: withTopDocumentMetadata({ action: 'snapshot', params: { mode: 'visible', limit: 2 } }),
        pageStatus: withTopDocumentMetadata({ action: 'page_status', params: {} })
      }
    }));
    expect(background.sentMessages.filter((entry: { message: Record<string, unknown> }) => entry.message.action !== 'ping')).toEqual([
      { tabId: 1, message: { target: 'cbc-content', action: 'click', params: { ref: 'h1' } } },
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
          snapshot: withTopDocumentMetadata({ action: 'snapshot', params: {} }),
          pageStatus: withTopDocumentMetadata({ action: 'page_status', params: {} })
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
    ).resolves.toEqual(withTopDocumentMetadata({
      action: 'scroll',
      params: { deltaY: 0 },
      after: {
        ok: false,
        error: 'snapshot failed'
      }
    }));
  });

  it('runs perform_actions sequentially and applies terminal after only on full success', async () => {
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
      background.handleBridgeRequest('perform_actions', {
        tabId: 1,
        actions: [
          { action: 'click', ref: 'h1' },
          { action: 'type', ref: 'h2', text: 'hello' },
          { action: 'scroll', deltaY: 200 }
        ],
        after: { snapshot: true, pageStatus: true }
      })
    ).resolves.toEqual({
      ok: true,
      completedCount: 3,
      steps: [
        successfulTopStep(0, 'click', { ref: 'h1' }),
        successfulTopStep(1, 'type', { ref: 'h2', text: 'hello' }),
        successfulTopStep(2, 'scroll', { deltaY: 200 })
      ],
      after: {
        snapshot: withTopDocumentMetadata({ action: 'snapshot', params: {} }),
        pageStatus: withTopDocumentMetadata({ action: 'page_status', params: {} })
      }
    });
    expect(background.sentMessages.filter((entry: { message: Record<string, unknown> }) => entry.message.action !== 'ping')).toEqual([
      { tabId: 1, message: { target: 'cbc-content', action: 'click', params: { ref: 'h1' } } },
      { tabId: 1, message: { target: 'cbc-content', action: 'type', params: { ref: 'h2', text: 'hello' } } },
      { tabId: 1, message: { target: 'cbc-content', action: 'scroll', params: { deltaY: 200 } } },
      { tabId: 1, message: { target: 'cbc-content', action: 'snapshot', params: {} } },
      { tabId: 1, message: { target: 'cbc-content', action: 'page_status', params: {} } }
    ]);
  });

  it('fail-fast perform_actions skips terminal after and returns partial step results', async () => {
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
        if (message.action === 'type') throw new Error('type failed');
        return { action: message.action, params: message.params };
      }
    });

    await expect(
      background.handleBridgeRequest('perform_actions', {
        tabId: 1,
        actions: [
          { action: 'click', ref: 'h1' },
          { action: 'type', ref: 'h2', text: 'hello' },
          { action: 'scroll', deltaY: 200 }
        ],
        after: { snapshot: true }
      })
    ).resolves.toEqual({
      ok: false,
      completedCount: 1,
      failedIndex: 1,
      steps: [
        successfulTopStep(0, 'click', { ref: 'h1' }),
        { index: 1, action: 'type', ok: false, error: 'type failed' }
      ]
    });
    expect(background.sentMessages.filter((entry: { message: Record<string, unknown> }) => entry.message.action !== 'ping')).toEqual([
      { tabId: 1, message: { target: 'cbc-content', action: 'click', params: { ref: 'h1' } } },
      { tabId: 1, message: { target: 'cbc-content', action: 'type', params: { ref: 'h2', text: 'hello' } } }
    ]);
  });

  it('waits for tab load only before the first perform_actions step', async () => {
    const tabBase = {
      id: 1,
      active: true,
      highlighted: true,
      title: 'Example Domain',
      url: 'https://example.com/',
      windowId: 1
    };
    const completeBackground = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://example.com/*']
      },
      tabs: [{ ...tabBase, status: 'complete' }],
      contentResult: (_tabId, message) => ({ action: message.action, params: message.params })
    });
    completeBackground.resetTabGetCount();
    await completeBackground.handleBridgeRequest('perform_actions', {
      tabId: 1,
      actions: [
        { action: 'click', ref: 'h1' },
        { action: 'click', ref: 'h2' }
      ]
    });
    const completeTabGets = completeBackground.tabGetCount();

    const loadingBackground = loadBackgroundHarness({
      settings: {
        bridgeUrl: 'ws://127.0.0.1:8765',
        token,
        allowedOrigins: ['https://example.com/*']
      },
      tabs: [
        {
          ...tabBase,
          status: 'loading',
          _navigateLoadsRemaining: 3,
          _navigateFinal: { title: 'Example Domain', url: 'https://example.com/', status: 'complete' }
        }
      ],
      contentResult: (_tabId, message) => ({ action: message.action, params: message.params })
    });
    loadingBackground.resetTabGetCount();

    await expect(
      loadingBackground.handleBridgeRequest('perform_actions', {
        tabId: 1,
        actions: [
          { action: 'click', ref: 'h1' },
          { action: 'click', ref: 'h2' }
        ]
      })
    ).resolves.toMatchObject({ ok: true, completedCount: 2 });

    expect(loadingBackground.tabGetCount()).toBeGreaterThan(completeTabGets);
  });

  it('rejects invalid perform_actions after before running any step', async () => {
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
      background.handleBridgeRequest('perform_actions', {
        tabId: 1,
        actions: [{ action: 'click', ref: 'h1' }],
        after: { waitFor: { timeoutMs: 1000 } }
      })
    ).rejects.toThrow('after.waitFor requires at least one wait condition');
    expect(background.sentMessages).toEqual([]);
  });

  it('fail-fast perform_actions when soft budget is exhausted before a later step', async () => {
    let advanceTime: (ms: number) => void = () => undefined;
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
        if (message.action === 'click') {
          advanceTime(54_500);
        }
        return { action: message.action, params: message.params };
      }
    });
    advanceTime = background.advanceTime;

    await expect(
      background.handleBridgeRequest('perform_actions', {
        tabId: 1,
        actions: [
          { action: 'click', ref: 'h1' },
          { action: 'type', ref: 'h2', text: 'hello' },
          { action: 'scroll', deltaY: 200 }
        ],
        after: { snapshot: true }
      })
    ).resolves.toEqual({
      ok: false,
      completedCount: 1,
      failedIndex: 1,
      steps: [
        successfulTopStep(0, 'click', { ref: 'h1' }),
        {
          index: 1,
          action: 'type',
          ok: false,
          error:
            'Action batch stopped at step 1 because the request time budget is nearly exhausted (500ms remaining)'
        }
      ]
    });
    expect(background.sentMessages.filter((entry: { message: Record<string, unknown> }) => entry.message.action !== 'ping')).toEqual([
      { tabId: 1, message: { target: 'cbc-content', action: 'click', params: { ref: 'h1' } } }
    ]);
  });

  it('fail-fast perform_actions when soft budget is exhausted before terminal after', async () => {
    let advanceTime: (ms: number) => void = () => undefined;
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
        if (message.action === 'click') {
          advanceTime(54_500);
        }
        return { action: message.action, params: message.params };
      }
    });
    advanceTime = background.advanceTime;

    await expect(
      background.handleBridgeRequest('perform_actions', {
        tabId: 1,
        actions: [{ action: 'click', ref: 'h1' }],
        after: { snapshot: true, pageStatus: true }
      })
    ).resolves.toEqual({
      ok: false,
      completedCount: 1,
      failedIndex: 1,
      steps: [successfulTopStep(0, 'click', { ref: 'h1' })],
      error: 'Action batch skipped after because the request time budget is nearly exhausted (500ms remaining)'
    });
    expect(background.sentMessages.filter((entry: { message: Record<string, unknown> }) => entry.message.action !== 'ping')).toEqual([
      { tabId: 1, message: { target: 'cbc-content', action: 'click', params: { ref: 'h1' } } }
    ]);
  });

  it('fail-fast perform_actions when soft budget cannot cover after.waitFor buffer', async () => {
    let advanceTime: (ms: number) => void = () => undefined;
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
        if (message.action === 'click') {
          advanceTime(52_000);
        }
        return { action: message.action, params: message.params };
      }
    });
    advanceTime = background.advanceTime;

    await expect(
      background.handleBridgeRequest('perform_actions', {
        tabId: 1,
        actions: [{ action: 'click', ref: 'h1' }],
        after: { waitFor: { text: 'Done', timeoutMs: 1000 } }
      })
    ).resolves.toEqual({
      ok: false,
      completedCount: 1,
      failedIndex: 1,
      steps: [successfulTopStep(0, 'click', { ref: 'h1' })],
      error: 'Action batch skipped after because the request time budget is nearly exhausted (3000ms remaining)'
    });
    expect(background.sentMessages.filter((entry: { message: Record<string, unknown> }) => entry.message.action !== 'ping')).toEqual([
      { tabId: 1, message: { target: 'cbc-content', action: 'click', params: { ref: 'h1' } } }
    ]);
  });

  it('does not soft-budget-fail perform_actions for empty after near exhaustion', async () => {
    let advanceTime: (ms: number) => void = () => undefined;
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
        if (message.action === 'click') {
          advanceTime(54_500);
        }
        return { action: message.action, params: message.params };
      }
    });
    advanceTime = background.advanceTime;

    await expect(
      background.handleBridgeRequest('perform_actions', {
        tabId: 1,
        actions: [{ action: 'click', ref: 'h1' }],
        after: {}
      })
    ).resolves.toEqual({
      ok: true,
      completedCount: 1,
      steps: [successfulTopStep(0, 'click', { ref: 'h1' })],
      after: {}
    });
    expect(background.sentMessages.filter((entry: { message: Record<string, unknown> }) => entry.message.action !== 'ping')).toEqual([
      { tabId: 1, message: { target: 'cbc-content', action: 'click', params: { ref: 'h1' } } }
    ]);
  });

  it('surfaces password-like type failures and allows force on perform_actions steps', async () => {
    const passwordError =
      'Ref pwd appears to be a password/2FA field. Re-run with force=true only if explicitly approved.';
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
        if (message.action === 'type' && message.params?.ref === 'pwd' && !message.params?.force) {
          throw new Error(passwordError);
        }
        return { action: message.action, params: message.params };
      }
    });

    await expect(
      background.handleBridgeRequest('perform_actions', {
        tabId: 1,
        actions: [
          { action: 'click', ref: 'h1' },
          { action: 'type', ref: 'pwd', text: 'secret' }
        ]
      })
    ).resolves.toEqual({
      ok: false,
      completedCount: 1,
      failedIndex: 1,
      steps: [
        successfulTopStep(0, 'click', { ref: 'h1' }),
        { index: 1, action: 'type', ok: false, error: passwordError }
      ]
    });

    await expect(
      background.handleBridgeRequest('perform_actions', {
        tabId: 1,
        actions: [{ action: 'type', ref: 'pwd', text: 'secret', force: true }]
      })
    ).resolves.toMatchObject({
      ok: true,
      completedCount: 1,
      steps: [{ index: 0, action: 'type', ok: true, result: { action: 'type', params: { ref: 'pwd', text: 'secret', force: true } } }]
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

  it('promotes another claim when the current claimed tab disappears', async () => {
    const tabs = [
      {
        id: 1,
        active: false,
        highlighted: false,
        status: 'complete',
        title: 'First claim',
        url: 'https://allowed.example/one',
        windowId: 1
      },
      {
        id: 2,
        active: false,
        highlighted: false,
        status: 'complete',
        title: 'Second claim',
        url: 'https://allowed.example/two',
        windowId: 1
      },
      {
        id: 3,
        active: true,
        highlighted: true,
        status: 'complete',
        title: 'Active fallback',
        url: 'https://allowed.example/active',
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
    tabs.splice(1, 1);

    await expect(background.handleBridgeRequest('page_status')).rejects.toThrow(
      'Claimed tab is no longer available'
    );

    await background.handleBridgeRequest('page_status');
    expect(background.sentMessages.at(-1)).toMatchObject({
      tabId: 1,
      message: { action: 'page_status' }
    });
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

  it('clears exclusive lease immediately when a tab is closed', async () => {
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
    background.removeTab(2);

    tabs.push({
      id: 2,
      active: false,
      highlighted: false,
      status: 'complete',
      title: 'Reused id',
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

  it('crops screenshots to bounds with padding and reports crop metadata', async () => {
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
          title: 'Allowed',
          url: 'https://allowed.example/',
          windowId: 1
        }
      ],
      contentResult: (_tabId, message) => {
        if (message.action === 'page_status') {
          return {
            viewport: { width: 200, height: 100, deviceScaleFactor: 2 }
          };
        }
        return {};
      }
    });

    const result = await background.handleBridgeRequest('screenshot', {
      tabId: 1,
      bounds: { x: 10, y: 10, width: 40, height: 20 },
      padding: 5
    });

    expect(result).toMatchObject({
      mimeType: 'image/png',
      visibleOnly: true,
      cropped: true,
      cropBounds: { x: 5, y: 5, width: 50, height: 30 },
      deviceScaleFactor: 2
    });
    expect(result).not.toHaveProperty('ref');
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.dataUrl).not.toBe('data:image/png;base64,ZmFrZQ==');
    expect(background.captures).toEqual([{ windowId: 1, options: { format: 'png' } }]);
    expect(background.drawImageCalls).toHaveLength(1);
    expect(background.drawImageCalls[0].slice(1)).toEqual([10, 10, 100, 60, 0, 0, 100, 60]);
    expect(background.sentMessages.some((entry: { message: { action?: string } }) => entry.message.action === 'page_status')).toBe(
      true
    );
  });

  it('rejects non-finite crop bounds before captureVisibleTab', async () => {
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
          title: 'Allowed',
          url: 'https://allowed.example/',
          windowId: 1
        }
      ],
      contentResult: (_tabId, message) => {
        if (message.action === 'page_status') {
          return { viewport: { width: 200, height: 100, deviceScaleFactor: 1 } };
        }
        return {};
      }
    });

    await expect(
      background.handleBridgeRequest('screenshot', {
        tabId: 1,
        bounds: { x: Number.NaN, y: 10, width: 40, height: 20 }
      })
    ).rejects.toThrow('outside the visible viewport');
    expect(background.captures).toHaveLength(0);
  });

  it('crops screenshots to a snapshot ref using content bounds', async () => {
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
          title: 'Allowed',
          url: 'https://allowed.example/',
          windowId: 1
        }
      ],
      contentResult: (_tabId, message) => {
        if (message.action === 'ref_bounds') {
          return {
            bounds: { x: 20, y: 30, width: 50, height: 25 },
            viewport: { width: 400, height: 300, deviceScaleFactor: 1 }
          };
        }
        return {};
      }
    });

    await expect(background.handleBridgeRequest('screenshot', { tabId: 1, ref: 'e12' })).resolves.toMatchObject({
      cropped: true,
      cropBounds: { x: 20, y: 30, width: 50, height: 25 },
      deviceScaleFactor: 1,
      ref: 'e12'
    });
    expect(background.sentMessages.some((entry: { message: { action?: string } }) => entry.message.action === 'ref_bounds')).toBe(
      true
    );
  });

  it('activates inactive tabs before resolving screenshot crop bounds', async () => {
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
      ],
      contentResult: (_tabId, message) => {
        if (message.action === 'ref_bounds') {
          expect(background.tabs[0].active).toBe(true);
          return {
            bounds: { x: 20, y: 30, width: 50, height: 25 },
            viewport: { width: 400, height: 300, deviceScaleFactor: 1 }
          };
        }
        return {};
      }
    });

    await expect(background.handleBridgeRequest('screenshot', { tabId: 1, ref: 'e12' })).resolves.toMatchObject({
      cropped: true,
      activated: true,
      ref: 'e12',
      cropBounds: { x: 20, y: 30, width: 50, height: 25 }
    });
    const refBoundsIndex = background.sentMessages.findIndex(
      (entry: { message: { action?: string } }) => entry.message.action === 'ref_bounds'
    );
    expect(refBoundsIndex).toBeGreaterThanOrEqual(0);
    expect(background.captures).toHaveLength(1);
  });

  it('rejects empty crop intersection before captureVisibleTab', async () => {
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
          title: 'Allowed',
          url: 'https://allowed.example/',
          windowId: 1
        }
      ],
      contentResult: (_tabId, message) => {
        if (message.action === 'page_status') {
          return { viewport: { width: 100, height: 100, deviceScaleFactor: 1 } };
        }
        return {};
      }
    });

    await expect(
      background.handleBridgeRequest('screenshot', {
        tabId: 1,
        bounds: { x: 200, y: 200, width: 40, height: 40 }
      })
    ).rejects.toThrow('outside the visible viewport');
    expect(background.captures).toHaveLength(0);
  });

  it('rejects stale screenshot refs before capture', async () => {
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
          title: 'Allowed',
          url: 'https://allowed.example/',
          windowId: 1
        }
      ],
      contentResult: (_tabId, message) => {
        if (message.action === 'ref_bounds') {
          throw new Error('No element found for ref stale. Refresh snapshot and try again.');
        }
        return {};
      }
    });

    await expect(background.handleBridgeRequest('screenshot', { tabId: 1, ref: 'stale' })).rejects.toThrow(
      'No element found for ref stale'
    );
    expect(background.captures).toHaveLength(0);
  });

  it('rejects screenshot requests that set both ref and bounds', async () => {
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
          title: 'Allowed',
          url: 'https://allowed.example/',
          windowId: 1
        }
      ]
    });

    await expect(
      background.handleBridgeRequest('screenshot', {
        tabId: 1,
        ref: 'e1',
        bounds: { x: 1, y: 1, width: 10, height: 10 }
      })
    ).rejects.toThrow('either ref or bounds');
    expect(background.captures).toHaveLength(0);
  });

  it('omits crop fields for uncropped screenshots', async () => {
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
          title: 'Allowed',
          url: 'https://allowed.example/',
          windowId: 1
        }
      ]
    });

    const result = await background.handleBridgeRequest('screenshot', { tabId: 1 });
    expect(result).toEqual({
      dataUrl: 'data:image/png;base64,ZmFrZQ==',
      mimeType: 'image/png',
      tabId: 1,
      windowId: 1,
      visibleOnly: true,
      activated: false
    });
    expect(result).not.toHaveProperty('cropped');
    expect(result).not.toHaveProperty('cropBounds');
    expect(result).not.toHaveProperty('deviceScaleFactor');
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

  it('does not reuse expired exclusive sessionTabId for advisory claims', async () => {
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

    const expiredExclusive = await background.handleBridgeRequest('claim_tab', {
      tabId: 2,
      exclusive: true,
      ownerId: 'owner-a',
      ttlMs: 1000
    });

    background.advanceTime(1500);

    const advisory = await background.handleBridgeRequest('claim_tab', { tabId: 2 });
    expect(advisory.sessionTabId).not.toBe(expiredExclusive.sessionTabId);

    await expect(
      background.handleBridgeRequest('release_tab', { sessionTabId: expiredExclusive.sessionTabId })
    ).rejects.toThrow('No matching claimed tab to release');

    await expect(background.handleBridgeRequest('ping')).resolves.toMatchObject({
      session: {
        claimedTabs: [expect.objectContaining({ tabId: 2, sessionTabId: advisory.sessionTabId })]
      }
    });
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
