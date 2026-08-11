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
  protocolVersion: 6,
  features: [
    'document-targeting',
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
const PERFORM_ACTIONS_MIN_STEP_RESERVE_MS = 1_000;
const PERFORM_ACTION_STEP_ALLOWLIST = ['click', 'type', 'scroll', 'keypress'];
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

  const shouldActivate = params.active === true;
  const created = await chrome.tabs.create({ url, active: shouldActivate });
  if (!created?.id) throw new Error('Failed to create a tab for navigation');
  return created.id;
}

async function resolvePageActionTabId(params = {}, allowedOrigins) {
  if (params.sessionTabId) return await resolveSessionTabId(params.sessionTabId, allowedOrigins);
  if (params.tabId) {
    const tabId = await resolveExplicitTabId(params.tabId);
    const tab = await chrome.tabs.get(tabId);
    if (!isInjectableUrl(tab.url || '')) {
      throw new Error(`Cannot inspect this Chrome internal or restricted page: ${tab.url || 'unknown URL'}`);
    }
    assertAllowedUrl(tab.url || '', allowedOrigins, 'Page action');
    return tabId;
  }
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

const SUPPORTED_DOCUMENT_LIFECYCLE = 'active';
const SUPPORTED_FRAME_TYPES = new Set(['outermost_frame', 'sub_frame']);

function documentError(prefix, detail) {
  return new Error(`${prefix}: ${detail}`);
}

function documentOriginPattern(url) {
  const parsed = new URL(url);
  return `${parsed.origin}/*`;
}

async function hasDocumentHostPermission(url) {
  if (!chrome.permissions?.contains) return true;
  return Boolean(await chrome.permissions.contains({ origins: [documentOriginPattern(url)] }));
}

function documentSupport(frame) {
  const lifecycleSupported = frame?.documentLifecycle === SUPPORTED_DOCUMENT_LIFECYCLE;
  const frameTypeSupported = SUPPORTED_FRAME_TYPES.has(frame?.frameType);
  const schemeSupported = isInjectableUrl(frame?.url || '');
  return { lifecycleSupported, frameTypeSupported, schemeSupported };
}

async function validateDocumentFrame(frame, tabId, allowedOrigins) {
  if (!frame || !frame.documentId) {
    throw documentError('DOCUMENT_STALE', 'the selected document is no longer present in the target tab');
  }
  const support = documentSupport(frame);
  if (!support.lifecycleSupported) {
    throw documentError('DOCUMENT_UNSUPPORTED', 'the selected document is not active');
  }
  if (!support.frameTypeSupported) {
    throw documentError('DOCUMENT_UNSUPPORTED', 'the selected frame type is not supported');
  }
  if (!support.schemeSupported) {
    throw documentError('DOCUMENT_UNSUPPORTED', 'only active HTTP(S) documents are supported');
  }
  if (!isUrlAllowed(frame.url, allowedOrigins)) {
    throw documentError('DOCUMENT_POLICY_DENIED', 'the selected document is outside Allowed Origins');
  }
  if (!(await hasDocumentHostPermission(frame.url))) {
    throw documentError('DOCUMENT_HOST_PERMISSION_DENIED', 'Chrome host permission is not granted for the selected document');
  }
  return {
    tabId,
    frameId: frame.frameId,
    documentId: frame.documentId,
    url: frame.url,
    isTopFrame: frame.frameId === 0,
    coordinateSpace: frame.frameId === 0 ? 'tabViewport' : 'frameViewport'
  };
}

async function resolveDocumentTarget(tabId, documentId, allowedOrigins) {
  if (!documentId) {
    let topFrame;
    try {
      topFrame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    } catch (_error) {
      throw documentError('DOCUMENT_STALE', 'the top document is no longer present in the target tab');
    }
    return await validateDocumentFrame(topFrame ? { ...topFrame, frameId: 0 } : null, tabId, allowedOrigins);
  }

  let candidate;
  try {
    const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
    candidate = frames.find((frame) => frame.documentId === documentId);
  } catch (_error) {
    throw documentError('DOCUMENT_STALE', 'the selected document is no longer present in the target tab');
  }
  if (!candidate || candidate.documentLifecycle !== SUPPORTED_DOCUMENT_LIFECYCLE) {
    throw documentError('DOCUMENT_STALE', 'the selected document is no longer the active document for its frame');
  }

  let confirmed;
  try {
    confirmed = await chrome.webNavigation.getFrame({ tabId, frameId: candidate.frameId, documentId });
  } catch (_error) {
    throw documentError('DOCUMENT_STALE', 'the selected document was replaced');
  }
  if (confirmed?.documentId !== documentId || confirmed.documentLifecycle !== SUPPORTED_DOCUMENT_LIFECYCLE) {
    throw documentError('DOCUMENT_STALE', 'the selected document was replaced');
  }
  return await validateDocumentFrame({ ...confirmed, frameId: candidate.frameId }, tabId, allowedOrigins);
}

function documentTargetMetadata(target) {
  return {
    documentId: target.documentId,
    frameId: target.frameId,
    isTopFrame: target.isTopFrame,
    coordinateSpace: target.coordinateSpace
  };
}

function decorateContentResult(result, target) {
  const metadata = documentTargetMetadata(target);
  if (result && typeof result === 'object' && !Array.isArray(result)) return { ...result, ...metadata };
  return { result, ...metadata };
}

function stripRoutingParams(params = {}) {
  const { tabId: _tabId, sessionTabId: _sessionTabId, documentId: _documentId, ...contentParams } = params;
  return contentParams;
}

async function rethrowTargetedChromeFailure(tabId, requestedDocumentId, allowedOrigins, chromeError) {
  await resolveDocumentTarget(tabId, requestedDocumentId, allowedOrigins);
  throw chromeError;
}

async function sendTargetedMessage(target, message, requestedDocumentId, allowedOrigins, { mapFailure = true } = {}) {
  try {
    return await chrome.tabs.sendMessage(target.tabId, message, { documentId: target.documentId });
  } catch (error) {
    if (!mapFailure) throw error;
    return await rethrowTargetedChromeFailure(target.tabId, requestedDocumentId, allowedOrigins, error);
  }
}

async function injectTargetedScript(target, file, requestedDocumentId, allowedOrigins) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: target.tabId, documentIds: [target.documentId] },
      files: [file]
    });
  } catch (error) {
    return await rethrowTargetedChromeFailure(target.tabId, requestedDocumentId, allowedOrigins, error);
  }
}

async function ensureContentScripts(tabId, requestedDocumentId, allowedOrigins) {
  const pingTarget = await resolveDocumentTarget(tabId, requestedDocumentId, allowedOrigins);
  try {
    const existing = await sendTargetedMessage(
      pingTarget,
      { target: 'cbc-content', action: 'ping', params: {} },
      requestedDocumentId,
      allowedOrigins,
      { mapFailure: false }
    );
    if (existing?.ok) return;
  } catch (_error) {
    // No listener yet; re-resolve the document before each injection below.
  }

  const coreTarget = await resolveDocumentTarget(tabId, requestedDocumentId, allowedOrigins);
  await injectTargetedScript(coreTarget, 'content-core.js', requestedDocumentId, allowedOrigins);
  const listenerTarget = await resolveDocumentTarget(tabId, requestedDocumentId, allowedOrigins);
  await injectTargetedScript(listenerTarget, 'content.js', requestedDocumentId, allowedOrigins);

  const finalPingTarget = await resolveDocumentTarget(tabId, requestedDocumentId, allowedOrigins);
  const injected = await sendTargetedMessage(
    finalPingTarget,
    { target: 'cbc-content', action: 'ping', params: {} },
    requestedDocumentId,
    allowedOrigins
  );
  if (!injected?.ok) throw new Error(injected?.error || 'Browser content script did not become ready after injection');
}

async function sendToContent(tabId, action, params = {}, allowedOrigins = [], { waitForLoad = true, documentId } = {}) {
  if (waitForLoad) await waitForTabComplete(tabId);
  await ensureContentScripts(tabId, documentId, allowedOrigins);
  const target = await resolveDocumentTarget(tabId, documentId, allowedOrigins);
  const response = await sendTargetedMessage(
    target,
    { target: 'cbc-content', action, params: stripRoutingParams(params) },
    documentId,
    allowedOrigins
  );
  if (!response?.ok) throw new Error(response?.error || `Content action failed: ${action}`);
  return decorateContentResult(response.result, target);
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

function afterHasObservations(after) {
  if (after === undefined || !after || typeof after !== 'object' || Array.isArray(after)) return false;
  return after.waitFor !== undefined || after.snapshot !== undefined || after.pageStatus === true;
}

function afterSoftBudgetReserveMs(after) {
  if (!afterHasObservations(after)) return 0;
  // waitFor uses budgetAfterWaitForParams, which needs AFTER_OBSERVATION_BUFFER_MS headroom.
  if (after.waitFor !== undefined) return AFTER_OBSERVATION_BUFFER_MS + 1;
  return PERFORM_ACTIONS_MIN_STEP_RESERVE_MS;
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

async function runAfterObservations(tabId, after = {}, allowedOrigins = [], { startedAt = Date.now(), documentId } = {}) {
  const observations = {};
  await waitForTabComplete(tabId);
  if (after.waitFor !== undefined) {
    observations.waitFor = await sendToContent(
      tabId,
      'wait_for',
      budgetAfterWaitForParams(after.waitFor, startedAt),
      allowedOrigins,
      { waitForLoad: false, documentId }
    );
  }
  if (after.snapshot !== undefined) {
    observations.snapshot = await sendToContent(tabId, 'snapshot', normalizeSnapshotAfter(after.snapshot), allowedOrigins, {
      waitForLoad: false,
      documentId
    });
  }
  if (after.pageStatus === true) {
    observations.pageStatus = await sendToContent(tabId, 'page_status', {}, allowedOrigins, { waitForLoad: false, documentId });
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
  const documentId = baseParams.documentId;
  const result = await sendToContent(tabId, action, baseParams, allowedOrigins, { documentId });
  return await withAfterResult(result, tabId, after, allowedOrigins, { startedAt, documentId });
}

function validatePerformActionStep(step, index) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    throw new Error(`actions[${index}] must be an object`);
  }
  const action = step.action;
  if (!PERFORM_ACTION_STEP_ALLOWLIST.includes(action)) {
    throw new Error(`actions[${index}] has unsupported action: ${action || 'missing'}`);
  }
}

function performActionStepParams(step) {
  const { action: _action, ...stepParams } = step;
  return stepParams;
}

function remainingSoftBudgetMs(startedAt) {
  return BRIDGE_REQUEST_SOFT_BUDGET_MS - Math.max(0, Date.now() - startedAt);
}

async function runPerformActionsWithAfter(params, allowedOrigins) {
  const startedAt = Date.now();
  const { after, baseParams } = splitAfterParams(params);
  validateAfterRequest(after);
  const actions = baseParams.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('perform_actions requires a non-empty actions array');
  }
  if (actions.length > 10) {
    throw new Error('perform_actions supports at most 10 actions');
  }
  for (let index = 0; index < actions.length; index += 1) {
    validatePerformActionStep(actions[index], index);
  }
  const tabId = await resolvePageActionTabId(
    { tabId: baseParams.tabId, sessionTabId: baseParams.sessionTabId },
    allowedOrigins
  );
  const documentId = baseParams.documentId;
  const steps = [];
  for (let index = 0; index < actions.length; index += 1) {
    const step = actions[index];
    const stepAction = step.action;
    if (index > 0) {
      const remainingMs = remainingSoftBudgetMs(startedAt);
      if (remainingMs < PERFORM_ACTIONS_MIN_STEP_RESERVE_MS) {
        const error = `Action batch stopped at step ${index} because the request time budget is nearly exhausted (${remainingMs}ms remaining)`;
        steps.push({ index, action: stepAction, ok: false, error });
        return { ok: false, completedCount: index, failedIndex: index, steps };
      }
    }
    try {
      const result = await sendToContent(tabId, stepAction, performActionStepParams(step), allowedOrigins, {
        waitForLoad: index === 0,
        documentId
      });
      steps.push({ index, action: stepAction, ok: true, result });
    } catch (error) {
      steps.push({
        index,
        action: stepAction,
        ok: false,
        error: (error && error.message) || String(error)
      });
      return { ok: false, completedCount: index, failedIndex: index, steps };
    }
  }
  const batchSummary = { ok: true, completedCount: actions.length, steps };
  const afterReserveMs = afterSoftBudgetReserveMs(after);
  if (afterReserveMs > 0) {
    const remainingMs = remainingSoftBudgetMs(startedAt);
    if (remainingMs < afterReserveMs) {
      return {
        ok: false,
        completedCount: actions.length,
        failedIndex: actions.length,
        steps,
        error: `Action batch skipped after because the request time budget is nearly exhausted (${remainingMs}ms remaining)`
      };
    }
  }
  return await withAfterResult(batchSummary, tabId, after, allowedOrigins, { startedAt, documentId });
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

function intersectCropBounds(bounds, viewport, padding = 0) {
  const pad = Math.max(0, Number(padding) || 0);
  const left = Number(bounds.x) - pad;
  const top = Number(bounds.y) - pad;
  const right = Number(bounds.x) + Number(bounds.width) + pad;
  const bottom = Number(bounds.y) + Number(bounds.height) + pad;
  const x = Math.max(0, left);
  const y = Math.max(0, top);
  const maxX = Math.max(0, Number(viewport.width) || 0);
  const maxY = Math.max(0, Number(viewport.height) || 0);
  const width = Math.min(right, maxX) - x;
  const height = Math.min(bottom, maxY) - y;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  };
}

async function cropDataUrl(dataUrl, cropBounds, deviceScaleFactor, format) {
  const scale = Number(deviceScaleFactor) > 0 ? Number(deviceScaleFactor) : 1;
  const sx = Math.round(cropBounds.x * scale);
  const sy = Math.round(cropBounds.y * scale);
  const sw = Math.max(1, Math.round(cropBounds.width * scale));
  const sh = Math.max(1, Math.round(cropBounds.height * scale));
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('screenshot crop failed: OffscreenCanvas 2d context unavailable');
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const croppedBlob = await canvas.convertToBlob({ type: mimeType, ...(format === 'jpeg' ? { quality: 0.92 } : {}) });
    const buffer = await croppedBlob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return `data:${mimeType};base64,${btoa(binary)}`;
  } finally {
    bitmap.close?.();
  }
}

async function captureVisibleScreenshot(tabId, params = {}, allowedOrigins = []) {
  let tab = await chrome.tabs.get(tabId);
  if (!isInjectableUrl(tab.url || '')) {
    throw new Error(`Cannot screenshot this Chrome internal or restricted page: ${tab.url || 'unknown URL'}`);
  }
  assertAllowedUrl(tab.url || '', allowedOrigins, 'screenshot');
  await assertScreenshotPermission(allowedOrigins);

  const hasRef = params.ref !== undefined && params.ref !== null && String(params.ref).length > 0;
  const hasBounds = params.bounds && typeof params.bounds === 'object' && !Array.isArray(params.bounds);
  if (hasRef && hasBounds) {
    throw new Error('screenshot accepts either ref or bounds, not both');
  }
  const wantsCrop = hasRef || hasBounds;

  // Activate before crop resolution so viewport-relative bounds match captureVisibleTab.
  const format = params.format === 'jpeg' ? 'jpeg' : 'png';
  let activated = false;
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    tab = await waitForTabActive(tabId);
    activated = true;
  }

  let cropBounds;
  let deviceScaleFactor = 1;
  let cropRef;
  if (wantsCrop) {
    let sourceBounds;
    let viewport;
    if (hasRef) {
      cropRef = String(params.ref);
      const resolved = await sendToContent(tabId, 'ref_bounds', { ref: cropRef }, allowedOrigins);
      sourceBounds = resolved?.bounds;
      viewport = resolved?.viewport;
      if (!sourceBounds || typeof sourceBounds.width !== 'number' || typeof sourceBounds.height !== 'number') {
        throw new Error(`No viewport bounds available for ref ${cropRef}. Refresh snapshot and try again.`);
      }
    } else {
      sourceBounds = {
        x: Number(params.bounds.x),
        y: Number(params.bounds.y),
        width: Number(params.bounds.width),
        height: Number(params.bounds.height)
      };
      const status = await sendToContent(tabId, 'page_status', {}, allowedOrigins);
      viewport = status?.viewport;
    }
    if (!viewport || typeof viewport.width !== 'number' || typeof viewport.height !== 'number') {
      throw new Error('screenshot crop requires page viewport dimensions');
    }
    deviceScaleFactor = Number(viewport.deviceScaleFactor) > 0 ? Number(viewport.deviceScaleFactor) : 1;
    cropBounds = intersectCropBounds(sourceBounds, viewport, params.padding);
    const cropFinite = [cropBounds.x, cropBounds.y, cropBounds.width, cropBounds.height].every(Number.isFinite);
    if (!cropFinite || cropBounds.width <= 0 || cropBounds.height <= 0) {
      throw new Error('screenshot crop is outside the visible viewport (empty intersection after padding)');
    }
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

  if (!wantsCrop) {
    return {
      dataUrl,
      mimeType: `image/${format}`,
      tabId,
      windowId: tab.windowId,
      visibleOnly: true,
      activated
    };
  }

  const croppedDataUrl = await cropDataUrl(dataUrl, cropBounds, deviceScaleFactor, format);
  return {
    dataUrl: croppedDataUrl,
    mimeType: `image/${format}`,
    tabId,
    windowId: tab.windowId,
    visibleOnly: true,
    activated,
    cropped: true,
    cropBounds,
    deviceScaleFactor,
    ...(cropRef ? { ref: cropRef } : {})
  };
}

function redactedFrameRow(frame, support, details) {
  return {
    frameId: frame.frameId,
    parentFrameId: frame.parentFrameId,
    isTopFrame: frame.frameId === 0,
    urlRedacted: true,
    ...support,
    allowedByPolicy: details.allowedByPolicy ?? null,
    hostPermissionGranted: details.hostPermissionGranted ?? null,
    operable: false,
    reason: details.reason
  };
}

async function listFrames(tabId, allowedOrigins) {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  const shaped = [];
  const disclosedDocumentIds = new Set();
  for (const frame of frames) {
    const support = documentSupport(frame);
    if (!support.lifecycleSupported) {
      shaped.push(redactedFrameRow(frame, support, { reason: 'lifecycle_unsupported' }));
      continue;
    }
    if (!support.frameTypeSupported) {
      shaped.push(redactedFrameRow(frame, support, { reason: 'frame_type_unsupported' }));
      continue;
    }
    if (!support.schemeSupported) {
      shaped.push(redactedFrameRow(frame, support, { reason: 'scheme_unsupported' }));
      continue;
    }
    if (!isUrlAllowed(frame.url, allowedOrigins)) {
      shaped.push(redactedFrameRow(frame, support, { allowedByPolicy: false, reason: 'policy_denied' }));
      continue;
    }
    if (!(await hasDocumentHostPermission(frame.url))) {
      shaped.push(
        redactedFrameRow(frame, support, {
          allowedByPolicy: true,
          hostPermissionGranted: false,
          reason: 'host_permission_denied'
        })
      );
      continue;
    }
    if (!frame.documentId) {
      shaped.push(redactedFrameRow(frame, support, { allowedByPolicy: true, reason: 'document_identity_unavailable' }));
      continue;
    }
    disclosedDocumentIds.add(frame.documentId);
    shaped.push({
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      documentId: frame.documentId,
      ...(frame.parentDocumentId ? { parentDocumentId: frame.parentDocumentId } : {}),
      url: frame.url,
      isTopFrame: frame.frameId === 0,
      ...support,
      allowedByPolicy: true,
      hostPermissionGranted: true,
      operable: true
    });
  }
  return shaped.map((row) => {
    if (!row.parentDocumentId || disclosedDocumentIds.has(row.parentDocumentId)) return row;
    const { parentDocumentId: _parentDocumentId, ...withoutBlockedParentIdentity } = row;
    return withoutBlockedParentIdentity;
  });
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
    case 'list_frames': {
      const tabId = await resolvePageActionTabId(params, settings.allowedOrigins);
      return await listFrames(tabId, settings.allowedOrigins);
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
      const shouldActivate = baseParams.active === true;
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
      const tabId = await resolvePageActionTabId(params, settings.allowedOrigins);
      return await sendToContent(
        tabId,
        'snapshot',
        { ...params, mode: 'visible' },
        settings.allowedOrigins,
        { documentId: params.documentId }
      );
    }
    case 'screenshot':
      return await captureVisibleScreenshot(await resolvePageActionTabId(params, settings.allowedOrigins), params, settings.allowedOrigins);
    case 'snapshot':
      return await sendToContent(await resolvePageActionTabId(params, settings.allowedOrigins), action, params, settings.allowedOrigins, {
        documentId: params.documentId
      });
    case 'click':
    case 'type':
    case 'scroll':
      return await runPageActionWithAfter(action, params, settings.allowedOrigins);
    case 'query_elements':
    case 'extract_elements':
    case 'extract_feed_posts':
      return await sendToContent(await resolvePageActionTabId(params, settings.allowedOrigins), action, params, settings.allowedOrigins, {
        documentId: params.documentId
      });
    case 'keypress':
    case 'click_at':
      return await runPageActionWithAfter(action, params, settings.allowedOrigins);
    case 'wait_for':
    case 'page_status':
    case 'console_logs':
      return await sendToContent(await resolvePageActionTabId(params, settings.allowedOrigins), action, params, settings.allowedOrigins, {
        documentId: params.documentId
      });
    case 'collect_scroll':
      return await runPageActionWithAfter(action, params, settings.allowedOrigins);
    case 'perform_actions':
      return await runPerformActionsWithAfter(params, settings.allowedOrigins);
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
    getBridgeStatus()
      .then((response) =>
        chrome.storage.local
          .get({
            adapterStatus: null
          })
          .then((stored) =>
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
