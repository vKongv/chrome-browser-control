if (typeof importScripts === 'function') importScripts('security.js');

const {
  DEFAULT_BRIDGE_URL,
  DEFAULT_ALLOWED_ORIGINS,
  describeAllowedOrigins,
  isUrlAllowed,
  normalizeAllowedOriginPatterns,
  normalizeBridgeUrl,
  validatePairingToken
} = globalThis.BrowserControlSecurity;

const DEFAULTS = {
  bridgeUrl: DEFAULT_BRIDGE_URL,
  token: '',
  allowedOrigins: DEFAULT_ALLOWED_ORIGINS
};

const EXTENSION_PROTOCOL_MARKER = {
  protocolVersion: 2,
  features: ['navigate-pending-warning', 'snapshot-text-limit']
};

let status = 'disconnected';

async function getSettings() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  return {
    bridgeUrl: normalizeBridgeUrl(settings.bridgeUrl),
    token: validatePairingToken(settings.token),
    allowedOrigins: normalizeAllowedOriginPatterns(settings.allowedOrigins)
  };
}

function setStatus(nextStatus) {
  status = nextStatus;
  chrome.storage.local.set({ status }).catch(() => undefined);
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_SCRAPING'],
    justification: 'Keep the local Chrome Browser Control WebSocket bridge connected to the current Chrome profile.'
  });
}

async function connectBridge({ force = false } = {}) {
  await ensureOffscreenDocument();
  const settings = await getSettings();
  const response = await chrome.runtime.sendMessage({
    target: 'cbc-offscreen',
    action: 'connect',
    force,
    settings
  });
  return response;
}

async function getBridgeStatus() {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ target: 'cbc-offscreen', action: 'status' });
  if (response?.ok) setStatus(response.status);
  return response;
}

function isInjectableUrl(url = '') {
  return /^https?:/i.test(url);
}

function assertAllowedUrl(url, allowedOrigins, action) {
  if (isUrlAllowed(url, allowedOrigins)) return;
  throw new Error(`${action} is blocked for unapproved origin: ${url || 'unknown URL'}`);
}

function sanitizeTab(tab) {
  return {
    id: tab.id,
    active: tab.active,
    highlighted: tab.highlighted,
    title: tab.title,
    url: tab.url,
    windowId: tab.windowId,
    source: 'extension'
  };
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return tab;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return await chrome.tabs.get(tabId);
}

async function getTabIfExists(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (_error) {
    return null;
  }
}

function isOperableTab(tab, allowedOrigins) {
  const url = tab.url || '';
  return isInjectableUrl(url) && isUrlAllowed(url, allowedOrigins);
}

async function activeTabFromQuery() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function resolveExplicitTabId(tabId) {
  const tab = await getTabIfExists(tabId);
  if (!tab) throw new Error(`No tab with id: ${tabId}`);
  return tabId;
}

async function resolveNavigateTabId(params = {}, url, allowedOrigins) {
  if (params.tabId) return await resolveExplicitTabId(params.tabId);

  const active = await activeTabFromQuery();
  if (active?.id) {
    const live = await getTabIfExists(active.id);
    if (live && isOperableTab(live, allowedOrigins)) return live.id;
  }

  const created = await chrome.tabs.create({ url, active: true });
  if (!created?.id) throw new Error('Failed to create a tab for navigation');
  return created.id;
}

async function resolvePageActionTabId(params = {}, allowedOrigins) {
  if (params.tabId) return await resolveExplicitTabId(params.tabId);

  const active = await activeTabFromQuery();
  if (!active?.id) throw new Error('No active Chrome tab found');

  const live = await getTabIfExists(active.id);
  if (!live) throw new Error('The active Chrome tab is no longer available');

  const url = live.url || '';
  if (!isInjectableUrl(url)) {
    throw new Error(`Cannot inspect this Chrome internal or restricted page: ${url || 'unknown URL'}`);
  }
  if (!isUrlAllowed(url, allowedOrigins)) {
    throw new Error(`Page action is blocked for unapproved origin: ${url || 'unknown URL'}`);
  }

  return live.id;
}

async function ensureContentScripts(tabId, allowedOrigins) {
  const tab = await chrome.tabs.get(tabId);
  if (!isInjectableUrl(tab.url || '')) {
    throw new Error(`Cannot inspect this Chrome internal or restricted page: ${tab.url || 'unknown URL'}`);
  }
  assertAllowedUrl(tab.url || '', allowedOrigins, 'Page action');

  try {
    const existing = await chrome.tabs.sendMessage(tabId, {
      target: 'cbc-content',
      action: 'ping',
      params: {}
    });
    if (existing?.ok) return;
  } catch (_error) {
    // No listener yet; inject below.
  }

  await chrome.scripting.executeScript({ target: { tabId }, files: ['content-core.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });

  const injected = await chrome.tabs.sendMessage(tabId, {
    target: 'cbc-content',
    action: 'ping',
    params: {}
  });
  if (!injected?.ok) throw new Error(injected?.error || 'Browser content script did not become ready after injection');
}

async function sendToContent(tabId, action, params = {}, allowedOrigins = []) {
  await waitForTabComplete(tabId);
  await ensureContentScripts(tabId, allowedOrigins);
  const response = await chrome.tabs.sendMessage(tabId, {
    target: 'cbc-content',
    action,
    params
  });
  if (!response?.ok) throw new Error(response?.error || `Content action failed: ${action}`);
  return response.result;
}

async function handleBridgeRequest(action, params = {}) {
  const settings = await getSettings();
  switch (action) {
    case 'ping': {
      const refreshed = await getBridgeStatus();
      const liveStatus = refreshed?.ok && refreshed.status ? refreshed.status : status;
      return {
        pong: true,
        status: liveStatus,
        allowedOrigins: describeAllowedOrigins(settings.allowedOrigins),
        ...EXTENSION_PROTOCOL_MARKER
      };
    }
    case 'list_tabs': {
      const allTabs = await chrome.tabs.query({});
      const tabs = allTabs.filter((tab) => isUrlAllowed(tab.url, settings.allowedOrigins)).map(sanitizeTab);
      if (tabs.length > 0) return tabs;

      if (allTabs.length === 0) {
        return { tabs: [], detail: 'No browser tabs are open in this Chrome profile.' };
      }
      if (settings.allowedOrigins.length === 0) {
        return {
          tabs: [],
          detail:
            'No allowed origins are configured in the extension. Add allowed origins in the extension popup, then open or navigate to a matching site.',
          hiddenTabCount: allTabs.length
        };
      }
      return {
        tabs: [],
        detail:
          'No open tabs match the allowed origins configured in the extension. Add origins in the extension popup or navigate to an allowed site.',
        hiddenTabCount: allTabs.length,
        allowedOrigins: describeAllowedOrigins(settings.allowedOrigins)
      };
    }
    case 'navigate': {
      if (!params.url) throw new Error('navigate requires url');
      assertAllowedUrl(params.url, settings.allowedOrigins, 'navigate');
      const tabId = await resolveNavigateTabId(params, params.url, settings.allowedOrigins);
      await chrome.tabs.update(tabId, { url: params.url, active: true });
      const tab = await waitForTabComplete(tabId);
      const result = {
        id: tab.id,
        url: tab.url || params.url,
        title: tab.title,
        status: tab.status,
        source: 'extension'
      };
      if (tab.status !== 'complete') {
        result.warning = 'Navigation did not finish loading within 15s; tab may still be loading.';
        result.pending = true;
      }
      return result;
    }
    case 'snapshot':
    case 'click':
    case 'type':
    case 'scroll':
      return await sendToContent(await resolvePageActionTabId(params, settings.allowedOrigins), action, params, settings.allowedOrigins);
    default:
      throw new Error(`Unsupported bridge action: ${action}`);
  }
}

chrome.runtime.onInstalled.addListener(() => connectBridge().catch(() => undefined));
chrome.runtime.onStartup.addListener(() => connectBridge().catch(() => undefined));
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === 'cbc-background' && message?.kind === 'status-update') {
    setStatus(message.status || 'unknown');
    sendResponse({ ok: true });
    return true;
  }

  if (message?.target === 'cbc-background' && message?.kind === 'bridge-request') {
    handleBridgeRequest(message.action, message.params || {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.action === 'connect') {
    connectBridge({ force: true })
      .then((response) => sendResponse(response?.ok ? { ok: true, status } : { ok: false, error: response?.error || 'connect failed' }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.action === 'status') {
    getBridgeStatus()
      .then((response) => sendResponse(response?.ok ? { ok: true, status } : { ok: true, status }))
      .catch(() => sendResponse({ ok: true, status }));
    return true;
  }
  return false;
});

if (globalThis.CBC_TEST_HARNESS) {
  globalThis.BrowserControlBackground = {
    handleBridgeRequest
  };
}

// Avoid force-reconnect on cold start: this handler also runs when the service worker
// wakes for in-flight bridge requests, and a forced reconnect drops the active socket.
connectBridge().catch(() => undefined);
