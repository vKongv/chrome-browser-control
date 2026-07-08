if (typeof importScripts === 'function') importScripts('security.js');

const {
  DEFAULT_BRIDGE_URL,
  DEFAULT_ALLOWED_ORIGINS,
  SCREENSHOT_ALL_URLS_PERMISSION,
  describeAllowedOrigins,
  getScreenshotPermissionOrigins,
  isUrlAllowed,
  normalizeAllowedOriginPatterns,
  normalizeBridgeUrl,
  urlsEquivalent,
  validatePairingToken
} = globalThis.BrowserControlSecurity;

const DEFAULTS = {
  bridgeUrl: DEFAULT_BRIDGE_URL,
  token: '',
  allowedOrigins: DEFAULT_ALLOWED_ORIGINS
};

const EXTENSION_PROTOCOL_MARKER = {
  protocolVersion: 5,
  features: [
    'act-observe-budget',
    'act-observe',
    'navigate-pending-warning',
    'snapshot-text-limit',
    'snapshot-scope',
    'session-tabs',
    'exclusive-claims',
    'extract-feed-posts',
    'navigate-active',
    'navigate-redirect-metadata',
    'wait-for-extended',
    'visible-snapshot',
    'query-elements',
    'extract-elements',
    'visible-screenshot',
    'keypress',
    'click-at',
    'wait-for',
    'page-status',
    'console-logs',
    'collect-scroll'
  ]
};

const BRIDGE_REQUEST_SOFT_BUDGET_MS = 55_000;
const AFTER_OBSERVATION_BUFFER_MS = 5_000;
const MAX_AFTER_WAIT_TIMEOUT_MS = 20_000;
const DEFAULT_EXCLUSIVE_LEASE_TTL_MS = 300_000;
const MAX_EXCLUSIVE_LEASE_TTL_MS = 3_600_000;

let status = 'disconnected';
let sessionName = '';
let nextClaimId = 1;
let currentSessionTabId = '';
const claimedTabs = new Map();
const tabLeases = new Map();

function sweepExpiredLeases(now = Date.now()) {
  for (const [tabId, lease] of tabLeases) {
    if (!lease?.expiresAt || lease.expiresAt <= now) {
      tabLeases.delete(tabId);
      for (const [sessionTabId, claim] of [...claimedTabs.entries()]) {
        if (claim.tabId !== tabId || !claim.exclusive || claim.ownerId !== lease.ownerId) continue;
        claimedTabs.delete(sessionTabId);
        if (currentSessionTabId === sessionTabId) currentSessionTabId = claimedTabs.keys().next().value || '';
      }
    }
  }
}

function getLeaseForTab(tabId) {
  sweepExpiredLeases();
  return tabLeases.get(tabId);
}

function boundedExclusiveLeaseTtl(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_EXCLUSIVE_LEASE_TTL_MS;
  return Math.max(1000, Math.min(Math.floor(value), MAX_EXCLUSIVE_LEASE_TTL_MS));
}

function clearLeaseForTab(tabId) {
  tabLeases.delete(tabId);
}

function clearLeaseIfHeldByClaim(claim) {
  if (!claim?.tabId || !claim.exclusive || !claim.ownerId) return;
  const lease = getLeaseForTab(claim.tabId);
  if (!lease || lease.ownerId !== claim.ownerId) return;
  clearLeaseForTab(claim.tabId);
}

function exclusiveLeaseConflictError(tabId, lease) {
  const payload = {
    code: 'TAB_EXCLUSIVE_CLAIM_CONFLICT',
    tabId,
    holder: {
      ownerId: lease.ownerId,
      owner: lease.ownerLabel || undefined,
      sessionName: lease.sessionName || undefined,
      expiresAt: lease.expiresAt
    }
  };
  return new Error(JSON.stringify(payload));
}

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
  const lease = getLeaseForTab(tab.id);
  const sanitized = {
    id: tab.id,
    active: tab.active,
    highlighted: tab.highlighted,
    title: tab.title,
    url: tab.url,
    windowId: tab.windowId,
    source: 'extension'
  };
  if (lease) {
    sanitized.exclusiveLease = {
      ownerId: lease.ownerId,
      owner: lease.ownerLabel || undefined,
      expiresAt: lease.expiresAt
    };
  }
  return sanitized;
}

function sanitizeClaim(tab, sessionTabId, claim = {}) {
  const result = {
    sessionTabId,
    tabId: tab.id,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    windowId: tab.windowId
  };
  if (claim.exclusive) {
    result.exclusive = true;
    result.ownerId = claim.ownerId;
    if (claim.ownerLabel) result.owner = claim.ownerLabel;
    if (claim.expiresAt) result.expiresAt = claim.expiresAt;
    if (claim.leaseRenewed) result.leaseRenewed = true;
  }
  return result;
}

function sessionState() {
  sweepExpiredLeases();
  return {
    name: sessionName || undefined,
    claimedTabs: [...claimedTabs.values()].map((claim) => ({
      sessionTabId: claim.sessionTabId,
      tabId: claim.tabId,
      status: claim.status,
      exclusive: claim.exclusive || undefined,
      ownerId: claim.ownerId || undefined,
      owner: claim.ownerLabel || undefined,
      expiresAt: claim.expiresAt || undefined
    }))
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

async function resolveSessionTabId(sessionTabId, allowedOrigins, { requireOperable = true } = {}) {
  const claim = claimedTabs.get(sessionTabId);
  if (!claim) throw new Error(`No claimed tab for sessionTabId: ${sessionTabId}`);
  const tab = await getTabIfExists(claim.tabId);
  if (!tab) {
    claimedTabs.delete(sessionTabId);
    clearLeaseIfHeldByClaim(claim);
    if (currentSessionTabId === sessionTabId) currentSessionTabId = claimedTabs.keys().next().value || '';
    throw new Error(`Claimed tab is no longer available for sessionTabId: ${sessionTabId}`);
  }
  if (requireOperable && !isOperableTab(tab, allowedOrigins)) {
    throw new Error(`Claimed tab is no longer operable or allowed: ${tab.url || 'unknown URL'}`);
  }
  return claim.tabId;
}

async function resolveCurrentClaimedTabId(allowedOrigins, options) {
  if (!currentSessionTabId) return null;
  return await resolveSessionTabId(currentSessionTabId, allowedOrigins, options);
}

async function resolveNavigateTabId(params = {}, url, allowedOrigins) {
  if (params.sessionTabId) return await resolveSessionTabId(params.sessionTabId, allowedOrigins, { requireOperable: false });
  if (params.tabId) return await resolveExplicitTabId(params.tabId);
  const claimedTabId = await resolveCurrentClaimedTabId(allowedOrigins, { requireOperable: false });
  if (claimedTabId) return claimedTabId;

  const active = await activeTabFromQuery();
  if (active?.id) {
    const live = await getTabIfExists(active.id);
    if (live && isOperableTab(live, allowedOrigins)) return live.id;
  }

  const shouldActivate = params.active !== false;
  const created = await chrome.tabs.create({ url, active: shouldActivate });
  if (!created?.id) throw new Error('Failed to create a tab for navigation');
  return created.id;
}

async function resolvePageActionTabId(params = {}, allowedOrigins) {
  if (params.sessionTabId) return await resolveSessionTabId(params.sessionTabId, allowedOrigins);
  if (params.tabId) return await resolveExplicitTabId(params.tabId);
  const claimedTabId = await resolveCurrentClaimedTabId(allowedOrigins);
  if (claimedTabId) return claimedTabId;

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

async function sendToContent(tabId, action, params = {}, allowedOrigins = [], { waitForLoad = true } = {}) {
  if (waitForLoad) await waitForTabComplete(tabId);
  await ensureContentScripts(tabId, allowedOrigins);
  const response = await chrome.tabs.sendMessage(tabId, {
    target: 'cbc-content',
    action,
    params
  });
  if (!response?.ok) throw new Error(response?.error || `Content action failed: ${action}`);
  return response.result;
}

function splitAfterParams(params = {}) {
  const { after, ...baseParams } = params || {};
  return { after, baseParams };
}

function hasWaitCondition(args = {}) {
  if (args.selectorAbsent === true && typeof args.selector === 'string' && args.selector.trim().length > 0) return true;
  if (typeof args.textInScope === 'string' && args.textInScope.trim().length > 0) return true;
  if (typeof args.contentStableMs === 'number' && Number.isFinite(args.contentStableMs) && args.contentStableMs > 0) return true;
  return ['text', 'selector', 'urlIncludes'].some((key) => typeof args[key] === 'string' && args[key].trim().length > 0);
}

function boundedAfterWaitTimeout(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(Math.floor(value), MAX_AFTER_WAIT_TIMEOUT_MS));
}

function normalizeSnapshotAfter(snapshot) {
  if (snapshot === true) return {};
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) return snapshot;
  throw new Error('after.snapshot must be true or an object');
}

function validateAfterRequest(after) {
  if (after === undefined) return;
  if (!after || typeof after !== 'object' || Array.isArray(after)) {
    throw new Error('after must be an object');
  }
  if (after.waitFor !== undefined) {
    if (!after.waitFor || typeof after.waitFor !== 'object' || Array.isArray(after.waitFor)) {
      throw new Error('after.waitFor must be an object');
    }
    if (!hasWaitCondition(after.waitFor)) {
      throw new Error('after.waitFor requires at least one wait condition');
    }
  }
  if (after.snapshot !== undefined) normalizeSnapshotAfter(after.snapshot);
  if (after.pageStatus !== undefined && typeof after.pageStatus !== 'boolean') {
    throw new Error('after.pageStatus must be a boolean');
  }
}

function budgetAfterWaitForParams(waitFor, startedAt = Date.now()) {
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const remainingMs = BRIDGE_REQUEST_SOFT_BUDGET_MS - elapsedMs - AFTER_OBSERVATION_BUFFER_MS;
  if (remainingMs <= 0) {
    throw new Error('after.waitFor cannot run because the base action used the act-observe time budget');
  }
  const requestedTimeout = boundedAfterWaitTimeout(waitFor.timeoutMs) ?? 5000;
  const timeoutMs = Math.max(1, Math.min(requestedTimeout, remainingMs));
  const next = {
    ...waitFor,
    timeoutMs
  };
  if (typeof waitFor.contentStableMs === 'number' && Number.isFinite(waitFor.contentStableMs)) {
    next.contentStableMs = Math.max(1, Math.min(Math.floor(waitFor.contentStableMs), timeoutMs));
  }
  return next;
}

async function runAfterObservations(tabId, after = {}, allowedOrigins = [], { startedAt = Date.now() } = {}) {
  const observations = {};
  await waitForTabComplete(tabId);
  if (after.waitFor !== undefined) {
    observations.waitFor = await sendToContent(
      tabId,
      'wait_for',
      budgetAfterWaitForParams(after.waitFor, startedAt),
      allowedOrigins,
      { waitForLoad: false }
    );
  }
  if (after.snapshot !== undefined) {
    observations.snapshot = await sendToContent(tabId, 'snapshot', normalizeSnapshotAfter(after.snapshot), allowedOrigins, { waitForLoad: false });
  }
  if (after.pageStatus === true) {
    observations.pageStatus = await sendToContent(tabId, 'page_status', {}, allowedOrigins, { waitForLoad: false });
  }
  return observations;
}

async function withAfterResult(result, tabId, after, allowedOrigins, options = {}) {
  if (after === undefined) return result;
  let afterResult;
  try {
    afterResult = await runAfterObservations(tabId, after, allowedOrigins, options);
  } catch (error) {
    afterResult = {
      ok: false,
      error: (error && error.message) || String(error)
    };
  }
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...result, after: afterResult };
  }
  return { result, after: afterResult };
}

async function runPageActionWithAfter(action, params, allowedOrigins) {
  const startedAt = Date.now();
  const { after, baseParams } = splitAfterParams(params);
  validateAfterRequest(after);
  const tabId = await resolvePageActionTabId(baseParams, allowedOrigins);
  const result = await sendToContent(tabId, action, baseParams, allowedOrigins);
  return await withAfterResult(result, tabId, after, allowedOrigins, { startedAt });
}

async function hasExactHostPermission(origin) {
  if (chrome.permissions?.getAll) {
    const permissions = await chrome.permissions.getAll();
    return Array.isArray(permissions?.origins) && permissions.origins.includes(origin);
  }
  if (!chrome.permissions?.contains) return true;
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins: [origin] }, (granted) => resolve(Boolean(granted)));
  });
}

async function assertScreenshotPermission(allowedOrigins) {
  const screenshotOrigins = getScreenshotPermissionOrigins(allowedOrigins);
  if (!screenshotOrigins.includes(SCREENSHOT_ALL_URLS_PERMISSION)) return;
  if (await hasExactHostPermission(SCREENSHOT_ALL_URLS_PERMISSION)) return;
  throw new Error(
    'screenshot requires the optional <all_urls> host permission when allowed origins are wildcard. Reload the extension after manifest changes, then open the extension popup, save settings, and grant the requested screenshot permission.'
  );
}

async function waitForTabActive(tabId, timeoutMs = 1500) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active) return tab;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for Chrome tab activation before screenshot capture');
}

async function captureVisibleScreenshot(tabId, params = {}, allowedOrigins = []) {
  let tab = await chrome.tabs.get(tabId);
  if (!isInjectableUrl(tab.url || '')) {
    throw new Error(`Cannot screenshot this Chrome internal or restricted page: ${tab.url || 'unknown URL'}`);
  }
  assertAllowedUrl(tab.url || '', allowedOrigins, 'screenshot');
  await assertScreenshotPermission(allowedOrigins);
  const format = params.format === 'jpeg' ? 'jpeg' : 'png';
  let activated = false;
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    tab = await waitForTabActive(tabId);
    activated = true;
  }
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format });
  } catch (error) {
    const message = String(error?.message || error || '');
    if (message.includes('<all_urls>') || message.includes('activeTab')) {
      throw new Error(
        'screenshot capture was blocked by Chrome permissions. Reload the extension after manifest changes, then open the extension popup, save settings, and grant the optional <all_urls> host permission for wildcard screenshot mode.'
      );
    }
    throw error;
  }
  return {
    dataUrl,
    mimeType: `image/${format}`,
    tabId,
    windowId: tab.windowId,
    visibleOnly: true,
    activated
  };
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
        session: sessionState(),
        ...EXTENSION_PROTOCOL_MARKER
      };
    }
    case 'name_session': {
      const name = String(params.name || '').trim();
      if (!name) throw new Error('name_session requires name');
      sessionName = name.slice(0, 120);
      return { name: sessionName };
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
    case 'claim_tab': {
      if (!params.tabId) throw new Error('claim_tab requires tabId');
      sweepExpiredLeases();
      const tab = await getTabIfExists(params.tabId);
      if (!tab) throw new Error(`No tab with id: ${params.tabId}`);
      if (!isInjectableUrl(tab.url || '')) {
        throw new Error(`Cannot claim this Chrome internal or restricted page: ${tab.url || 'unknown URL'}`);
      }
      assertAllowedUrl(tab.url || '', settings.allowedOrigins, 'claim_tab');
      const exclusive = params.exclusive === true;
      if (exclusive && !params.ownerId) throw new Error('exclusive claim_tab requires ownerId');
      const existingLease = getLeaseForTab(tab.id);
      // Advisory claims must not overwrite an active exclusive lease holder's claim metadata
      // (that would prevent the holder from clearing tabLeases on release).
      if (!exclusive && existingLease) {
        throw exclusiveLeaseConflictError(tab.id, existingLease);
      }
      if (exclusive && existingLease && existingLease.ownerId !== params.ownerId) {
        throw exclusiveLeaseConflictError(tab.id, existingLease);
      }
      const existing = [...claimedTabs.values()].find((claim) => claim.tabId === tab.id);
      let sessionTabId;
      if (
        existing &&
        exclusive &&
        (!existing.exclusive || (existing.ownerId && existing.ownerId !== params.ownerId))
      ) {
        // Do not reuse an advisory (or other-owner) sessionTabId for a new exclusive lease;
        // the prior caller could release and clear the lease.
        claimedTabs.delete(existing.sessionTabId);
        if (currentSessionTabId === existing.sessionTabId) currentSessionTabId = '';
        sessionTabId = `tab-${(nextClaimId++).toString(36)}`;
      } else if (existing?.exclusive && !existingLease) {
        // Expired exclusive claim row; do not reuse sessionTabId for a new caller.
        claimedTabs.delete(existing.sessionTabId);
        if (currentSessionTabId === existing.sessionTabId) currentSessionTabId = '';
        sessionTabId = `tab-${(nextClaimId++).toString(36)}`;
      } else {
        sessionTabId = existing?.sessionTabId || `tab-${(nextClaimId++).toString(36)}`;
      }
      const ttlMs = boundedExclusiveLeaseTtl(params.ttlMs);
      const leaseRenewed = exclusive && existingLease?.ownerId === params.ownerId;
      const expiresAt = exclusive ? Date.now() + ttlMs : undefined;
      const claim = {
        sessionTabId,
        tabId: tab.id,
        claimedAt: Date.now(),
        exclusive: exclusive || undefined,
        ownerId: exclusive ? String(params.ownerId) : undefined,
        ownerLabel: exclusive && params.owner ? String(params.owner).slice(0, 120) : undefined,
        expiresAt,
        leaseRenewed: leaseRenewed || undefined
      };
      claimedTabs.set(sessionTabId, claim);
      if (exclusive) {
        tabLeases.set(tab.id, {
          ownerId: claim.ownerId,
          ownerLabel: claim.ownerLabel,
          sessionName: sessionName || undefined,
          expiresAt
        });
      }
      currentSessionTabId = sessionTabId;
      return sanitizeClaim(tab, sessionTabId, claim);
    }
    case 'release_tab': {
      const sessionTabId = params.sessionTabId || (params.tabId ? [...claimedTabs.values()].find((claim) => claim.tabId === params.tabId)?.sessionTabId : currentSessionTabId);
      if (!sessionTabId || !claimedTabs.has(sessionTabId)) {
        throw new Error('No matching claimed tab to release');
      }
      const claim = claimedTabs.get(sessionTabId);
      claimedTabs.delete(sessionTabId);
      clearLeaseIfHeldByClaim(claim);
      if (currentSessionTabId === sessionTabId) currentSessionTabId = claimedTabs.keys().next().value || '';
      return { released: true, sessionTabId, tabId: claim?.tabId };
    }
    case 'finalize_tabs': {
      const keep = Array.isArray(params.keep) ? params.keep : [];
      const keepIds = new Set();
      for (const entry of keep) {
        const sessionTabId = entry?.sessionTabId || (entry?.tabId ? [...claimedTabs.values()].find((claim) => claim.tabId === entry.tabId)?.sessionTabId : undefined);
        if (!sessionTabId || !claimedTabs.has(sessionTabId)) continue;
        keepIds.add(sessionTabId);
        const claim = claimedTabs.get(sessionTabId);
        claim.status = entry.status;
        claimedTabs.set(sessionTabId, claim);
      }
      let released = 0;
      for (const sessionTabId of [...claimedTabs.keys()]) {
        if (keepIds.has(sessionTabId)) continue;
        const claim = claimedTabs.get(sessionTabId);
        clearLeaseIfHeldByClaim(claim);
        claimedTabs.delete(sessionTabId);
        released += 1;
      }
      if (!claimedTabs.has(currentSessionTabId)) currentSessionTabId = keepIds.values().next().value || '';
      return { released, kept: claimedTabs.size };
    }
    case 'navigate': {
      const startedAt = Date.now();
      const { after, baseParams } = splitAfterParams(params);
      validateAfterRequest(after);
      if (!baseParams.url) throw new Error('navigate requires url');
      assertAllowedUrl(baseParams.url, settings.allowedOrigins, 'navigate');
      const tabId = await resolveNavigateTabId(baseParams, baseParams.url, settings.allowedOrigins);
      const requestedUrl = baseParams.url;
      const shouldActivate = baseParams.active !== false;
      await chrome.tabs.update(tabId, { url: requestedUrl, active: shouldActivate });
      const tab = await waitForTabComplete(tabId);
      const finalUrl = tab.url || requestedUrl;
      const result = {
        id: tab.id,
        url: finalUrl,
        requestedUrl,
        finalUrl,
        redirected: !urlsEquivalent(requestedUrl, finalUrl),
        title: tab.title,
        status: tab.status,
        source: 'extension'
      };
      if (tab.status !== 'complete') {
        result.warning = 'Navigation did not finish loading within 15s; tab may still be loading.';
        result.pending = true;
      }
      return await withAfterResult(result, tabId, after, settings.allowedOrigins, { startedAt });
    }
    case 'visible_snapshot': {
      return await sendToContent(
        await resolvePageActionTabId(params, settings.allowedOrigins),
        'snapshot',
        { ...params, mode: 'visible' },
        settings.allowedOrigins
      );
    }
    case 'screenshot':
      return await captureVisibleScreenshot(await resolvePageActionTabId(params, settings.allowedOrigins), params, settings.allowedOrigins);
    case 'snapshot':
      return await sendToContent(await resolvePageActionTabId(params, settings.allowedOrigins), action, params, settings.allowedOrigins);
    case 'click':
    case 'type':
    case 'scroll':
      return await runPageActionWithAfter(action, params, settings.allowedOrigins);
    case 'query_elements':
    case 'extract_elements':
    case 'extract_feed_posts':
      return await sendToContent(await resolvePageActionTabId(params, settings.allowedOrigins), action, params, settings.allowedOrigins);
    case 'keypress':
    case 'click_at':
      return await runPageActionWithAfter(action, params, settings.allowedOrigins);
    case 'wait_for':
    case 'page_status':
    case 'console_logs':
      return await sendToContent(await resolvePageActionTabId(params, settings.allowedOrigins), action, params, settings.allowedOrigins);
    case 'collect_scroll':
      return await runPageActionWithAfter(action, params, settings.allowedOrigins);
    default:
      throw new Error(`Unsupported bridge action: ${action}`);
  }
}

chrome.runtime.onInstalled.addListener(() => connectBridge().catch(() => undefined));
chrome.runtime.onStartup.addListener(() => connectBridge().catch(() => undefined));
chrome.tabs.onRemoved.addListener((tabId) => {
  clearLeaseForTab(tabId);
  for (const [sessionTabId, claim] of [...claimedTabs.entries()]) {
    if (claim.tabId !== tabId) continue;
    claimedTabs.delete(sessionTabId);
    if (currentSessionTabId === sessionTabId) currentSessionTabId = claimedTabs.keys().next().value || '';
  }
});
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
    chrome.storage.local
      .get({
        adapterStatus: null
      })
      .then((stored) =>
        getBridgeStatus().then((response) =>
          sendResponse({
            ok: true,
            status: response?.ok ? response.status : status,
            adapterStatus: stored.adapterStatus
          })
        )
      )
      .catch(() => sendResponse({ ok: true, status, adapterStatus: null }));
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
