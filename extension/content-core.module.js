const REF_ATTR = 'data-cbc-ref';
const INTERESTING_SELECTOR = 'a,button,input,textarea,select,summary,[role],[contenteditable]';
const FULL_ELEMENT_LIMIT = 250;
const COMPACT_ELEMENT_LIMIT = 100;
const DEFAULT_COMPACT_TEXT_LIMIT = 500;
const DEFAULT_FULL_TEXT_LIMIT = 4000;
const MAX_TEXT_LIMIT = 100_000;
const DEFAULT_REF_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_REFS = 500;
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 500;
const DEFAULT_EXTRACT_LIMIT = 100;
const MAX_EXTRACT_LIMIT = 500;
const MAX_EXTRACT_TEXT = 1000;
const MAX_EXTRACT_HTML = 2000;
const MAX_LINKS_PER_ITEM = 20;
const MAX_CONSOLE_LOGS = 200;
const DEFAULT_WAIT_TIMEOUT_MS = 5000;
const MAX_WAIT_TIMEOUT_MS = 30000;
const DEFAULT_COLLECT_STEPS = 3;
const MAX_COLLECT_STEPS = 20;
const DEFAULT_COLLECT_DELAY_MS = 200;
const MAX_COLLECT_DELAY_MS = 1000;
const DEFAULT_COLLECT_ITEM_LIMIT = 100;
const MAX_COLLECT_ITEM_LIMIT = 500;
const SENSITIVE_ATTR_PATTERN = /password|passwd|passcode|one-time-code|otp|2fa|mfa|token|csrf|xsrf|secret|credential|authorization|session|nonce/i;
const HIDDEN_TOKEN_PATTERN = /token|csrf|xsrf|auth|secret|session|credential|nonce/i;
const SCOPE_VALUES = new Set(['document', 'main', 'article', 'feed']);
const MAX_EXCLUDE_SELECTORS = 20;
const MAX_EXCLUDE_SELECTOR_LENGTH = 500;
const MAX_IGNORE_ROLES = 20;
const DEFAULT_IGNORE_ROLES = ['dialog'];
const DIALOG_SELECTOR = 'dialog, [role="dialog"], [role="alertdialog"]';
const MIN_CONTENT_STABLE_TEXT_LENGTH = 50;

let refTtlMs = DEFAULT_REF_TTL_MS;
let maxRefs = DEFAULT_MAX_REFS;
let nextRefId = 1;
const elementRefs = new WeakMap();
const refRecords = new Map();
const consoleState = {
  installed: false,
  logs: []
};

export function isPasswordLike(element) {
  const type = String(element?.getAttribute?.('type') ?? '').toLowerCase();
  const autocomplete = String(element?.getAttribute?.('autocomplete') ?? '').toLowerCase();
  const name = String(element?.getAttribute?.('name') ?? '').toLowerCase();
  const id = String(element?.getAttribute?.('id') ?? '').toLowerCase();
  const aria = String(element?.getAttribute?.('aria-label') ?? '').toLowerCase();
  const placeholder = String(element?.getAttribute?.('placeholder') ?? '').toLowerCase();
  const haystack = `${type} ${autocomplete} ${name} ${id} ${aria} ${placeholder}`;
  return type === 'password' || /password|passwd|passcode|one-time-code|otp|2fa|mfa/.test(haystack);
}

function isHiddenTokenLike(element) {
  const tag = String(element?.tagName || '').toLowerCase();
  if (tag !== 'input') return false;
  const type = String(element?.getAttribute?.('type') ?? '').toLowerCase();
  if (type !== 'hidden') return false;
  const name = String(element?.getAttribute?.('name') ?? '').toLowerCase();
  const id = String(element?.getAttribute?.('id') ?? '').toLowerCase();
  const aria = String(element?.getAttribute?.('aria-label') ?? '').toLowerCase();
  return HIDDEN_TOKEN_PATTERN.test(`${name} ${id} ${aria}`);
}

function roleFor(element) {
  const explicit = element.getAttribute('role');
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'input' || tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  return tag;
}

function labelFor(element, limit = 160) {
  const aria = element.getAttribute('aria-label');
  if (aria) return aria.trim().slice(0, limit);
  const placeholder = element.getAttribute('placeholder');
  if (placeholder) return placeholder.trim().slice(0, limit);
  const title = element.getAttribute('title');
  if (title) return title.trim().slice(0, limit);
  const value = element.tagName.toLowerCase() === 'input' ? element.getAttribute('value') : '';
  const text = value || element.innerText || element.textContent || '';
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function isInteresting(element) {
  const tag = element.tagName.toLowerCase();
  if (['a', 'button', 'input', 'textarea', 'select', 'summary'].includes(tag)) return true;
  if (element.getAttribute('role')) return true;
  if (element.hasAttribute('contenteditable')) return true;
  if (typeof element.onclick === 'function') return true;
  return false;
}

function nowMs() {
  return Date.now();
}

function isConnectedToDocument(element, documentRef) {
  return element?.ownerDocument === documentRef && element.isConnected !== false && documentRef.contains(element);
}

function deleteRefRecord(ref, record) {
  if (record?.element?.getAttribute?.(REF_ATTR) === ref) record.element.removeAttribute(REF_ATTR);
  if (record?.element) elementRefs.delete(record.element);
  refRecords.delete(ref);
}

export function cleanupRefStore(documentRef = document, now = nowMs()) {
  for (const [ref, record] of refRecords) {
    if (record.documentRef !== documentRef || !isConnectedToDocument(record.element, documentRef) || now - record.lastSeen > refTtlMs) {
      deleteRefRecord(ref, record);
    }
  }

  while (refRecords.size > maxRefs) {
    let oldestRef;
    let oldestSeen = Infinity;
    for (const [ref, record] of refRecords) {
      if (record.lastSeen < oldestSeen) {
        oldestSeen = record.lastSeen;
        oldestRef = ref;
      }
    }
    if (!oldestRef) break;
    deleteRefRecord(oldestRef, refRecords.get(oldestRef));
  }

  return { retained: refRecords.size, ttlMs: refTtlMs, maxRefs };
}

function refForElement(element, documentRef, now) {
  const existingRef = elementRefs.get(element);
  const existing = existingRef ? refRecords.get(existingRef) : undefined;
  if (existing && existing.element === element && existing.documentRef === documentRef) {
    existing.lastSeen = now;
    element.setAttribute(REF_ATTR, existingRef);
    return existingRef;
  }

  const ref = `h${(nextRefId++).toString(36)}`;
  elementRefs.set(element, ref);
  refRecords.set(ref, { ref, element, documentRef, createdAt: now, lastSeen: now });
  element.setAttribute(REF_ATTR, ref);
  return ref;
}

function interestingElements(documentRef) {
  return [...documentRef.querySelectorAll(INTERESTING_SELECTOR)].filter(isInteresting);
}

function hasMainLandmark(documentRef) {
  return !!documentRef.querySelector?.('main, [role="main"]');
}

function normalizeStringArray(value, maxItems, maxLen) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLen));
}

function isExcludedByRole(element, ignoreRoles) {
  const role = roleFor(element).toLowerCase();
  return ignoreRoles.some((ignored) => ignored.toLowerCase() === role);
}

function isInsideIgnoredRoleSubtree(element, ignoreRoles) {
  let current = element;
  while (current) {
    if (isExcludedByRole(current, ignoreRoles)) return true;
    current = current.parentElement;
  }
  return false;
}

function isInsideExcludedSubtree(element, excludeSelectors, documentRef) {
  for (const selector of excludeSelectors) {
    try {
      for (const root of documentRef.querySelectorAll(selector)) {
        if (root === element || root.contains(element)) return true;
      }
    } catch (_error) {
      // ignore invalid selectors
    }
  }
  return false;
}

function isDialogFamilyRole(role) {
  const normalized = String(role || '').toLowerCase();
  return normalized === 'dialog' || normalized === 'alertdialog';
}

function expandExplicitDialogIgnoreRoles(ignoreRoles) {
  if (!ignoreRoles.some((role) => isDialogFamilyRole(role))) return ignoreRoles;
  const expanded = [...ignoreRoles];
  if (!expanded.some((role) => role.toLowerCase() === 'dialog')) expanded.push('dialog');
  if (!expanded.some((role) => role.toLowerCase() === 'alertdialog')) expanded.push('alertdialog');
  return expanded;
}

function isDialogLike(element) {
  const role = String(element?.getAttribute?.('role') || '').toLowerCase();
  if (isDialogFamilyRole(role)) return true;
  return String(element?.tagName || '').toLowerCase() === 'dialog';
}

function isNativeModalDialog(element) {
  if (String(element.tagName || '').toLowerCase() !== 'dialog' || element.open !== true) return false;
  try {
    // :modal is the only reliable showModal() vs show() signal. [open] is shared by both.
    return element.matches(':modal');
  } catch {
    return false;
  }
}

function hasAncestorOpacityZero(element) {
  const windowRef = element.ownerDocument?.defaultView || window;
  let current = element.parentElement;
  while (current) {
    const style = windowRef.getComputedStyle?.(current);
    if (style && style.opacity === '0') return true;
    current = current.parentElement;
  }
  return false;
}

function isDialogSubtreeVisible(element) {
  if (!element || element.hidden === true) return false;
  if (String(element.tagName || '').toLowerCase() === 'dialog' && element.open !== true) return false;
  if (!isVisibleElement(element)) return false;
  // Top-layer :modal dialogs paint as a root sibling; ancestor opacity cannot hide them.
  if (isNativeModalDialog(element)) return true;
  return !hasAncestorOpacityZero(element);
}

function isGenuinelyModalDialog(element) {
  if (!isDialogLike(element) || !isDialogSubtreeVisible(element)) return false;
  if (isNativeModalDialog(element)) return true;
  return String(element.getAttribute('aria-modal') || '').toLowerCase() === 'true';
}

function findVisibleModalDialog(documentRef) {
  const modals = [...documentRef.querySelectorAll(DIALOG_SELECTOR)].filter(
    isGenuinelyModalDialog
  );
  if (!modals.length) return null;
  // No public API exposes top-layer stack order, and implicit showModal() inertness
  // is not reflected in element.inert. Prefer the modal that contains focus
  // (where showModal() moved it). Otherwise last in tree order among non-inert
  // candidates: innermost nested, or the later sibling.
  const focus = documentRef.activeElement;
  if (focus) {
    for (let i = modals.length - 1; i >= 0; i -= 1) {
      if (modals[i] === focus || modals[i].contains(focus)) return modals[i];
    }
  }
  const live = modals.filter((element) => element.inert !== true);
  const pool = live.length ? live : modals;
  return pool[pool.length - 1];
}

function hasVisibleDialogRole(documentRef) {
  for (const element of documentRef.querySelectorAll(DIALOG_SELECTOR)) {
    if (isDialogSubtreeVisible(element) && roleFor(element).toLowerCase() === 'dialog') return true;
  }
  return false;
}

function isInsideHiddenDialogSubtree(element, scopeRoot) {
  let current = element;
  while (current && current !== scopeRoot) {
    if (isDialogLike(current) && !isDialogSubtreeVisible(current)) return true;
    current = current.parentElement;
  }
  return false;
}

function pruneHiddenDialogSubtrees(originalRoot, cloneRoot) {
  if (!originalRoot || !cloneRoot) return;
  const originals = [originalRoot, ...originalRoot.querySelectorAll('*')];
  const clones = [cloneRoot, ...cloneRoot.querySelectorAll('*')];
  if (originals.length !== clones.length) return;
  for (let i = clones.length - 1; i >= 1; i -= 1) {
    if (roleFor(originals[i]).toLowerCase() !== 'dialog') continue;
    if (isDialogSubtreeVisible(originals[i])) continue;
    clones[i].remove();
  }
}

export function resolveScopeRoot(documentRef = document, scope = 'document') {
  const body = documentRef.body || documentRef.documentElement;
  if (!body) return body;
  const normalized = SCOPE_VALUES.has(scope) ? scope : 'document';
  if (normalized === 'document') return body;
  if (normalized === 'main') {
    return documentRef.querySelector('main, [role="main"]') || documentRef.querySelector('article, [role="article"]') || body;
  }
  if (normalized === 'article') {
    const articles = [...documentRef.querySelectorAll('article, [role="article"]')];
    if (!articles.length) {
      return documentRef.querySelector('main, [role="main"]') || body;
    }
    if (articles.length === 1) return articles[0];
    let largest = articles[0];
    let maxLen = 0;
    for (const article of articles) {
      const len = (article.innerText || article.textContent || '').length;
      if (len > maxLen) {
        maxLen = len;
        largest = article;
      }
    }
    return largest;
  }
  const feed = documentRef.querySelector('[role="feed"]');
  if (feed) return feed;
  const main = documentRef.querySelector('main, [role="main"]');
  if (main && main.querySelectorAll('article, [role="article"]').length >= 2) return main;
  return main || body;
}

function resolveSnapshotScopeOptions(documentRef, options = {}, mode = 'compact') {
  const explicitScope = typeof options.scope === 'string' ? options.scope : undefined;
  let scopeApplied = 'document';
  if (explicitScope && SCOPE_VALUES.has(explicitScope)) {
    scopeApplied = explicitScope;
  } else if (mode !== 'full' && hasMainLandmark(documentRef)) {
    scopeApplied = 'main';
  }
  let ignoreRoles =
    options.ignoreRoles !== undefined
      ? normalizeStringArray(options.ignoreRoles, MAX_IGNORE_ROLES, 80)
      : scopeApplied === 'document'
        ? []
        : [...DEFAULT_IGNORE_ROLES];
  if (options.ignoreRoles !== undefined) ignoreRoles = expandExplicitDialogIgnoreRoles(ignoreRoles);
  const excludeSelectors = normalizeStringArray(options.excludeSelectors, MAX_EXCLUDE_SELECTORS, MAX_EXCLUDE_SELECTOR_LENGTH);
  let scopeRoot = resolveScopeRoot(documentRef, scopeApplied);
  const userIgnoresDialog = options.ignoreRoles !== undefined && ignoreRoles.some((role) => isDialogFamilyRole(role));
  const modalRoot = findVisibleModalDialog(documentRef);
  const allowAutoModalScope = mode !== 'full' && !explicitScope && !userIgnoresDialog && modalRoot;
  let pruneHiddenDialogs = false;

  if (allowAutoModalScope) {
    scopeApplied = 'dialog';
    scopeRoot = modalRoot;
    pruneHiddenDialogs = true;
    return {
      scopeApplied,
      excludeSelectors,
      ignoreRoles: ignoreRoles.filter((role) => !isDialogFamilyRole(role)),
      scopeRoot,
      pruneHiddenDialogs
    };
  }

  if (options.ignoreRoles === undefined && scopeApplied !== 'document' && hasVisibleDialogRole(documentRef)) {
    pruneHiddenDialogs = true;
    return {
      scopeApplied,
      excludeSelectors,
      ignoreRoles: ignoreRoles.filter((role) => !isDialogFamilyRole(role)),
      scopeRoot,
      pruneHiddenDialogs
    };
  }

  return { scopeApplied, excludeSelectors, ignoreRoles, scopeRoot, pruneHiddenDialogs };
}

function scopeHintFor(root) {
  if (!root) return undefined;
  const tag = root.tagName?.toLowerCase() || 'body';
  const role = root.getAttribute?.('role') || undefined;
  const selectorHint = tag === 'main' ? 'main' : role ? `[role="${role}"]` : tag;
  return { tag, role, selectorHint };
}

function pruneScopedClone(clone, excludeSelectors, ignoreRoles, originalRoot, pruneHiddenDialogs = false) {
  if (pruneHiddenDialogs) pruneHiddenDialogSubtrees(originalRoot, clone);
  for (const selector of excludeSelectors) {
    try {
      for (const element of [...clone.querySelectorAll(selector)]) {
        element.remove();
      }
    } catch (_error) {
      // ignore invalid selectors
    }
  }
  for (const element of [...clone.querySelectorAll('*')]) {
    if (isExcludedByRole(element, ignoreRoles)) element.remove();
  }
  return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
}

export function scopedBodyText(documentRef = document, options = {}) {
  const mode = options?.mode === 'full' ? 'full' : 'compact';
  const scopeOptions = resolveSnapshotScopeOptions(documentRef, options, mode);
  const scopeRoot = scopeOptions.scopeRoot;
  const clone = scopeRoot.cloneNode(true);
  const text = pruneScopedClone(
    clone,
    scopeOptions.excludeSelectors,
    scopeOptions.ignoreRoles,
    scopeRoot,
    scopeOptions.pruneHiddenDialogs
  );
  return {
    text,
    scopeRoot,
    scopeApplied: scopeOptions.scopeApplied,
    excludeSelectors: scopeOptions.excludeSelectors,
    ignoreRoles: scopeOptions.ignoreRoles
  };
}

function interestingElementsInScope(documentRef, scopeRoot, scopeOptions) {
  const { excludeSelectors, ignoreRoles, pruneHiddenDialogs } = scopeOptions;
  const allInScope = [...scopeRoot.querySelectorAll(INTERESTING_SELECTOR)].filter(isInteresting);
  const filtered = allInScope.filter(
    (element) =>
      scopeRoot.contains(element) &&
      !isInsideExcludedSubtree(element, excludeSelectors, documentRef) &&
      !isInsideIgnoredRoleSubtree(element, ignoreRoles) &&
      (!pruneHiddenDialogs || !isInsideHiddenDialogSubtree(element, scopeRoot))
  );
  return {
    elements: filtered,
    excludedCount: Math.max(0, allInScope.length - filtered.length)
  };
}

function fullItemFor(element, ref) {
  const rect = element.getBoundingClientRect?.();
  return {
    ref,
    role: roleFor(element),
    label: labelFor(element),
    tag: element.tagName.toLowerCase(),
    passwordLike: isPasswordLike(element),
    bounds: rect
      ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      : undefined
  };
}

function viewportFor(windowRef = window) {
  return {
    width: Math.round(windowRef.innerWidth || 0),
    height: Math.round(windowRef.innerHeight || 0),
    deviceScaleFactor: Number(windowRef.devicePixelRatio || 1)
  };
}

function scrollFor(windowRef = window, documentRef = windowRef.document || document) {
  const root = documentRef.documentElement || {};
  const body = documentRef.body || {};
  return {
    x: Math.round(windowRef.scrollX || root.scrollLeft || body.scrollLeft || 0),
    y: Math.round(windowRef.scrollY || root.scrollTop || body.scrollTop || 0),
    width: Math.round(root.scrollWidth || body.scrollWidth || 0),
    height: Math.round(root.scrollHeight || body.scrollHeight || 0)
  };
}

function boundsForElement(element) {
  const rect = element.getBoundingClientRect?.();
  if (!rect) return undefined;
  return {
    x: Math.round(rect.x ?? rect.left ?? 0),
    y: Math.round(rect.y ?? rect.top ?? 0),
    width: Math.round(rect.width ?? Math.max(0, (rect.right || 0) - (rect.left || 0))),
    height: Math.round(rect.height ?? Math.max(0, (rect.bottom || 0) - (rect.top || 0)))
  };
}

export function boundsForRef(ref, documentRef = document) {
  const element = findByRef(ref, documentRef);
  if (!element) throw new Error(`No element found for ref ${ref}. Refresh snapshot and try again.`);
  const bounds = boundsForElement(element);
  if (!bounds) throw new Error(`No viewport bounds available for ref ${ref}. Refresh snapshot and try again.`);
  const windowRef = documentRef.defaultView || window;
  return {
    bounds,
    viewport: viewportFor(windowRef)
  };
}

function elementHref(element) {
  if (element.href) return String(element.href).slice(0, 500);
  const link = element.closest?.('a[href]') || element.querySelector?.('a[href]');
  return link?.href ? String(link.href).slice(0, 500) : undefined;
}

function elementValue(element) {
  if (!('value' in element) || isPasswordLike(element)) return undefined;
  return String(element.value ?? '').slice(0, 500);
}

function isVisibleElement(element, windowRef = element.ownerDocument?.defaultView || window) {
  const rect = element.getBoundingClientRect?.();
  if (!rect) return true;
  const width = rect.width ?? Math.max(0, (rect.right || 0) - (rect.left || 0));
  const height = rect.height ?? Math.max(0, (rect.bottom || 0) - (rect.top || 0));
  if (width <= 0 || height <= 0) return false;
  const view = viewportFor(windowRef);
  const left = rect.left ?? rect.x ?? 0;
  const top = rect.top ?? rect.y ?? 0;
  const right = rect.right ?? left + width;
  const bottom = rect.bottom ?? top + height;
  if (right < 0 || bottom < 0 || left > view.width || top > view.height) return false;
  const style = windowRef.getComputedStyle?.(element);
  if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
  return true;
}

function visibleItemFor(element, ref, windowRef) {
  const item = {
    ref,
    role: roleFor(element),
    label: labelFor(element, 120),
    tag: element.tagName.toLowerCase(),
    bounds: boundsForElement(element),
    visible: isVisibleElement(element, windowRef)
  };
  const href = elementHref(element);
  const value = elementValue(element);
  if (href) item.href = href;
  if (value) item.value = value;
  if (isPasswordLike(element)) item.passwordLike = true;
  return item;
}

function compactItemFor(element, ref) {
  const item = {
    ref,
    role: roleFor(element),
    label: labelFor(element, 80)
  };
  if (isPasswordLike(element)) item.passwordLike = true;
  return item;
}

function boundedLimit(value, fallback, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

export function buildVisibleSnapshotFromDocument(documentRef = document, options = {}) {
  const windowRef = documentRef.defaultView || window;
  const now = typeof options?.now === 'number' ? options.now : nowMs();
  cleanupRefStore(documentRef, now);
  const limit = boundedLimit(options.limit, COMPACT_ELEMENT_LIMIT, 250);
  const elements = interestingElements(documentRef).filter((element) => isVisibleElement(element, windowRef));
  const selected = elements.slice(0, limit);
  const items = selected.map((element) => visibleItemFor(element, refForElement(element, documentRef, now), windowRef));
  cleanupRefStore(documentRef, now);
  return {
    title: documentRef.title,
    url: documentRef.location?.href,
    mode: 'visible',
    viewport: viewportFor(windowRef),
    scroll: scrollFor(windowRef, documentRef),
    elements: items,
    omittedElements: Math.max(0, elements.length - selected.length)
  };
}

function regionSummaries(documentRef, elements) {
  const roots = [...documentRef.querySelectorAll('main,nav,header,footer,aside,section,form,[role="main"],[role="navigation"],[role="search"],[role="form"]')].slice(0, 20);
  return roots
    .map((root) => {
      const contained = elements.filter((element) => root.contains(element));
      if (!contained.length) return undefined;
      const counts = {};
      for (const element of contained) {
        const role = roleFor(element);
        counts[role] = (counts[role] || 0) + 1;
      }
      return {
        region: roleFor(root),
        label: labelFor(root, 60),
        counts
      };
    })
    .filter(Boolean);
}

function resolveTextLimit(options, mode) {
  const defaultLimit = mode === 'full' ? DEFAULT_FULL_TEXT_LIMIT : DEFAULT_COMPACT_TEXT_LIMIT;
  const requested = options?.textLimit ?? options?.text_limit;
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return defaultLimit;
  return Math.max(1, Math.min(Math.floor(requested), MAX_TEXT_LIMIT));
}

function hadExplicitTextLimit(options) {
  const requested = options?.textLimit ?? options?.text_limit;
  return typeof requested === 'number' && Number.isFinite(requested);
}

function bodyTextFor(documentRef) {
  return (documentRef.body?.innerText || documentRef.body?.textContent || '').replace(/\s+/g, ' ').trim();
}

function textSnapshotMeta(bodyText, textLimit, options) {
  const textBytesOmitted = Math.max(0, bodyText.length - textLimit);
  const meta = {
    textLimitApplied: textLimit,
    textTotalLength: bodyText.length,
    textBytesOmitted
  };
  if (textBytesOmitted > 0 && !hadExplicitTextLimit(options)) {
    meta.warning = `Body text truncated at ${textLimit} characters (${textBytesOmitted} omitted). Pass textLimit (max ${MAX_TEXT_LIMIT}) for more.`;
  }
  return meta;
}

export function buildSnapshotFromDocument(documentRef = document, options = {}) {
  const mode = options?.mode === 'full' ? 'full' : options?.mode === 'visible' ? 'visible' : 'compact';
  if (mode === 'visible') return buildVisibleSnapshotFromDocument(documentRef, options);
  const textLimit = resolveTextLimit(options, mode);
  const now = typeof options?.now === 'number' ? options.now : nowMs();
  cleanupRefStore(documentRef, now);

  const scopeOptions = resolveSnapshotScopeOptions(documentRef, options, mode);
  const scopeRoot = scopeOptions.scopeRoot;
  const scoped = interestingElementsInScope(documentRef, scopeRoot, scopeOptions);
  const elements = scoped.elements;
  const limit = mode === 'full' ? FULL_ELEMENT_LIMIT : COMPACT_ELEMENT_LIMIT;
  const selected = elements.slice(0, limit);
  const items = selected.map((element) => {
    const ref = refForElement(element, documentRef, now);
    return mode === 'full' ? fullItemFor(element, ref) : compactItemFor(element, ref);
  });
  cleanupRefStore(documentRef, now);

  const bodyText = pruneScopedClone(
    scopeRoot.cloneNode(true),
    scopeOptions.excludeSelectors,
    scopeOptions.ignoreRoles,
    scopeRoot,
    scopeOptions.pruneHiddenDialogs
  );
  const textMeta = textSnapshotMeta(bodyText, textLimit, options);
  const scopeMeta = {
    scopeApplied: scopeOptions.scopeApplied,
    scopeRoot: scopeHintFor(scopeRoot),
    excludedCount: scoped.excludedCount
  };

  if (mode === 'full') {
    return {
      title: documentRef.title,
      url: documentRef.location?.href,
      elements: items,
      omittedElements: Math.max(0, elements.length - selected.length),
      text: bodyText.slice(0, textLimit),
      ...textMeta,
      ...scopeMeta
    };
  }

  return {
    title: documentRef.title,
    url: documentRef.location?.href,
    mode: 'compact',
    elements: items,
    omittedElements: Math.max(0, elements.length - selected.length),
    textPreview: bodyText.slice(0, textLimit),
    ...textMeta,
    regions: regionSummaries(documentRef, selected),
    ...scopeMeta
  };
}

function escapeRef(ref) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(ref);
  return String(ref).replace(/["\\]/g, '\\$&');
}

export function findByRef(ref, documentRef = document) {
  cleanupRefStore(documentRef);
  const record = refRecords.get(ref);
  if (record && isConnectedToDocument(record.element, documentRef)) {
    record.lastSeen = nowMs();
    return record.element;
  }

  const fallback = documentRef.querySelector(`[${REF_ATTR}="${escapeRef(ref)}"]`);
  if (fallback && elementRefs.get(fallback) === ref) {
    return fallback;
  }
  return null;
}

function assertDocumentVisible(documentRef, allowHidden) {
  if (allowHidden === true) return;
  if (documentRef.visibilityState === 'hidden') {
    throw new Error(
      'DOCUMENT_HIDDEN: document.visibilityState is hidden. Call activate_tab to focus the tab and its window, or pass allowHidden=true to keep working in the background.'
    );
  }
}

export function performClick({ ref, allowHidden = false }, documentRef = document) {
  assertDocumentVisible(documentRef, allowHidden);
  const element = findByRef(ref, documentRef);
  if (!element) throw new Error(`No element found for ref ${ref}. Refresh snapshot and try again.`);
  element.scrollIntoView?.({ block: 'center', inline: 'center' });
  element.click();
  return { clicked: ref };
}

export function performType({ ref, text, force = false, allowHidden = false }, documentRef = document) {
  assertDocumentVisible(documentRef, allowHidden);
  const element = findByRef(ref, documentRef);
  if (!element) throw new Error(`No element found for ref ${ref}. Refresh snapshot and try again.`);
  if (isPasswordLike(element) && !force) {
    throw new Error(`Ref ${ref} appears to be a password/2FA field. Re-run with force=true only if explicitly approved.`);
  }
  element.scrollIntoView?.({ block: 'center', inline: 'center' });
  element.focus?.();

  const view = element.ownerDocument?.defaultView || globalThis;
  const InputEventCtor = view.InputEvent || view.Event;
  const EventCtor = view.Event || Event;

  if ('value' in element) {
    element.value = text;
    element.dispatchEvent(new InputEventCtor('input', { bubbles: true, data: text, inputType: 'insertText' }));
    element.dispatchEvent(new EventCtor('change', { bubbles: true }));
  } else {
    element.textContent = text;
    element.dispatchEvent(new InputEventCtor('input', { bubbles: true, data: text, inputType: 'insertText' }));
  }
  return { typed: String(text).length, ref };
}

export function performScroll({ deltaX = 0, deltaY = 600, x, y } = {}, windowRef = window) {
  if (typeof x === 'number' && typeof y === 'number') {
    const target = windowRef.document?.elementFromPoint?.(x, y);
    const scrollable = scrollableAncestor(target, windowRef);
    if (scrollable) {
      scrollable.scrollBy?.(deltaX, deltaY);
      return { scrolled: true, deltaX, deltaY, x, y, target: 'element' };
    }
  }
  windowRef.scrollBy(deltaX, deltaY);
  return { scrolled: true, deltaX, deltaY, ...(typeof x === 'number' ? { x } : {}), ...(typeof y === 'number' ? { y } : {}), target: 'window' };
}

function scrollableAncestor(element, windowRef = window) {
  let current = element;
  while (current && current !== windowRef.document?.body && current !== windowRef.document?.documentElement) {
    const style = windowRef.getComputedStyle?.(current);
    const overflow = `${style?.overflow || ''} ${style?.overflowY || ''} ${style?.overflowX || ''}`;
    if (/(auto|scroll)/.test(overflow) && (current.scrollHeight > current.clientHeight || current.scrollWidth > current.clientWidth)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function elementsForQuery(documentRef, options = {}) {
  let elements;
  if (options.selector) {
    elements = [...documentRef.querySelectorAll(String(options.selector))];
  } else {
    elements = interestingElements(documentRef);
  }
  const windowRef = documentRef.defaultView || window;
  return elements.filter((element) => {
    if (options.visible === true && !isVisibleElement(element, windowRef)) return false;
    if (options.role && roleFor(element).toLowerCase() !== String(options.role).toLowerCase()) return false;
    if (options.text) {
      const needle = String(options.text).toLowerCase();
      const haystack = `${labelFor(element, 500)} ${element.textContent || ''}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

export function queryElements(options = {}, documentRef = document) {
  const now = typeof options?.now === 'number' ? options.now : nowMs();
  cleanupRefStore(documentRef, now);
  const windowRef = documentRef.defaultView || window;
  const limit = boundedLimit(options.limit, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
  const elements = elementsForQuery(documentRef, options);
  const selected = elements.slice(0, limit);
  const matches = selected.map((element) => visibleItemFor(element, refForElement(element, documentRef, now), windowRef));
  cleanupRefStore(documentRef, now);
  return {
    matches,
    count: elements.length,
    omitted: Math.max(0, elements.length - selected.length)
  };
}

function linksForElement(element) {
  const links = [];
  const nested = [...(element.querySelectorAll?.('a[href]') || [])];
  const candidates = element.matches?.('a[href]') ? [element, ...nested] : nested;
  for (const link of candidates.slice(0, MAX_LINKS_PER_ITEM)) {
    links.push({
      href: String(link.href || link.getAttribute('href') || '').slice(0, 500),
      text: labelFor(link, 160)
    });
  }
  return links;
}

function timeForElement(element) {
  const time = element.matches?.('time') ? element : element.querySelector?.('time');
  if (!time) return undefined;
  return {
    datetime: time.getAttribute('datetime') || undefined,
    text: labelFor(time, 160)
  };
}

function sanitizeHtmlForExtraction(element) {
  const clone = element.cloneNode(true);
  let redactedAttributes = 0;
  let sensitive = false;
  let passwordLike = false;
  const nodes = [clone, ...(clone.querySelectorAll?.('*') || [])];
  for (const node of nodes) {
    const original = node === clone ? element : undefined;
    const source =
      original ||
      (node.getAttribute?.(REF_ATTR) ? element.ownerDocument?.querySelector?.(`[${REF_ATTR}="${escapeRef(node.getAttribute(REF_ATTR))}"]`) : null);
    const nodePasswordLike = isPasswordLike(node) || (source ? isPasswordLike(source) : false);
    const nodeSensitive = nodePasswordLike || isHiddenTokenLike(node) || (source ? isHiddenTokenLike(source) : false);
    if (nodePasswordLike) passwordLike = true;
    if (nodeSensitive) sensitive = true;
    for (const attr of [...(node.attributes || [])]) {
      const shouldRedact = SENSITIVE_ATTR_PATTERN.test(attr.name) || (nodeSensitive && attr.name.toLowerCase() === 'value');
      if (!shouldRedact) continue;
      node.setAttribute(attr.name, '[redacted]');
      redactedAttributes += 1;
    }
  }
  return {
    html: String(clone.outerHTML || '').slice(0, MAX_EXTRACT_HTML),
    passwordLike,
    sensitive,
    redactedAttributes
  };
}

export function extractElements(options = {}, documentRef = document) {
  if (!options.selector) throw new Error('extract_elements requires selector');
  const now = typeof options?.now === 'number' ? options.now : nowMs();
  cleanupRefStore(documentRef, now);
  const windowRef = documentRef.defaultView || window;
  const limit = boundedLimit(options.limit, DEFAULT_EXTRACT_LIMIT, MAX_EXTRACT_LIMIT);
  const includeText =
    options.includeText === true || (options.includeText === undefined && !options.includeHtml && !options.includeLinks && !options.includeTimes);
  const elements = elementsForQuery(documentRef, { selector: options.selector, visible: options.visible });
  const selected = elements.slice(0, limit);
  const items = selected.map((element) => {
    const item = { ref: refForElement(element, documentRef, now) };
    if (includeText) item.text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, MAX_EXTRACT_TEXT);
    const directPasswordLike = isPasswordLike(element);
    const directSensitive = directPasswordLike || isHiddenTokenLike(element);
    if (directPasswordLike) item.passwordLike = true;
    if (directSensitive) item.sensitive = true;
    if (options.includeHtml) {
      const sanitized = sanitizeHtmlForExtraction(element);
      item.html = sanitized.html;
      if (sanitized.passwordLike) item.passwordLike = true;
      if (sanitized.sensitive) item.sensitive = true;
      if (sanitized.redactedAttributes > 0) item.redactedAttributes = sanitized.redactedAttributes;
    }
    if (options.includeLinks) item.links = linksForElement(element);
    if (options.includeTimes) item.time = timeForElement(element);
    if (options.visible === true) item.bounds = boundsForElement(element);
    if (isVisibleElement(element, windowRef) === false) item.visible = false;
    return item;
  });
  cleanupRefStore(documentRef, now);
  return {
    items,
    count: elements.length,
    omitted: Math.max(0, elements.length - selected.length)
  };
}

export function performClickAt({ x, y, allowHidden = false } = {}, documentRef = document) {
  assertDocumentVisible(documentRef, allowHidden);
  if (typeof x !== 'number' || typeof y !== 'number') throw new Error('click_at requires numeric x and y');
  const element = documentRef.elementFromPoint?.(x, y);
  if (!element) throw new Error(`No element found at viewport coordinates ${x},${y}`);
  const view = documentRef.defaultView || window;
  const MouseEventCtor = view.MouseEvent || view.Event;
  const ref = refForElement(element, documentRef, nowMs());
  for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
    element.dispatchEvent(new MouseEventCtor(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  }
  return { clicked: true, x, y, ref };
}

function parseKeySpec(spec) {
  const parts = String(spec).split('+').filter(Boolean);
  const key = parts.pop() || spec;
  const modifiers = new Set(parts.map((part) => part.toLowerCase()));
  return {
    key,
    ctrlKey: modifiers.has('ctrl') || modifiers.has('control'),
    metaKey: modifiers.has('meta') || modifiers.has('cmd') || modifiers.has('command'),
    altKey: modifiers.has('alt') || modifiers.has('option'),
    shiftKey: modifiers.has('shift')
  };
}

export function performKeypress({ keys, allowHidden = false } = {}, documentRef = document) {
  assertDocumentVisible(documentRef, allowHidden);
  const keyList = Array.isArray(keys) ? keys : [keys];
  if (!keyList.length || keyList.some((key) => !key)) throw new Error('keypress requires keys');
  const view = documentRef.defaultView || window;
  const KeyboardEventCtor = view.KeyboardEvent || view.Event;
  const target = documentRef.activeElement || documentRef.body || documentRef.documentElement;
  const pressed = [];
  for (const spec of keyList.slice(0, 20)) {
    const eventInit = { ...parseKeySpec(spec), bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEventCtor('keydown', eventInit));
    target.dispatchEvent(new KeyboardEventCtor('keyup', eventInit));
    pressed.push(String(spec));
  }
  return { pressed };
}

export function pageStatus(documentRef = document) {
  const windowRef = documentRef.defaultView || window;
  const resources = windowRef.performance?.getEntriesByType?.('resource') || [];
  const byType = {};
  for (const entry of resources.slice(-500)) {
    const type = entry.initiatorType || 'unknown';
    byType[type] = (byType[type] || 0) + 1;
  }
  return {
    title: documentRef.title,
    url: documentRef.location?.href,
    readyState: documentRef.readyState,
    visibilityState: documentRef.visibilityState,
    scroll: scrollFor(windowRef, documentRef),
    viewport: viewportFor(windowRef),
    resourceSummary: {
      count: resources.length,
      omitted: Math.max(0, resources.length - 500),
      byType
    }
  };
}

export function waitForCondition(options = {}, documentRef = document) {
  const timeoutMs = boundedLimit(options.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS);
  const started = Date.now();
  let contentStableLastLength = -1;
  let contentStableSince = 0;
  const contentStableMs =
    typeof options.contentStableMs === 'number' && Number.isFinite(options.contentStableMs)
      ? Math.max(1, Math.floor(options.contentStableMs))
      : undefined;

  return new Promise((resolve) => {
    const check = () => {
      let matched = false;
      let reason = 'timeout';
      let condition = 'timeout';

      if (options.urlIncludes && String(documentRef.location?.href || '').includes(String(options.urlIncludes))) {
        matched = true;
        reason = 'urlIncludes';
        condition = 'urlIncludes';
      } else if (options.selectorAbsent === true) {
        if (options.selector && !documentRef.querySelector(String(options.selector))) {
          matched = true;
          reason = 'selectorAbsent';
          condition = 'selectorAbsent';
        }
      } else if (options.selector && documentRef.querySelector(String(options.selector))) {
        matched = true;
        reason = 'selector';
        condition = 'selector';
      } else if (options.textInScope) {
        const scopeOptions = resolveSnapshotScopeOptions(documentRef, options, 'compact');
        const scopeRoot = scopeOptions.scopeRoot;
        const scopedText = pruneScopedClone(
          scopeRoot.cloneNode(true),
          scopeOptions.excludeSelectors,
          scopeOptions.ignoreRoles,
          scopeRoot,
          scopeOptions.pruneHiddenDialogs
        );
        if (scopedText.includes(String(options.textInScope))) {
          matched = true;
          reason = 'textInScope';
          condition = 'textInScope';
        }
      } else if (options.text && bodyTextFor(documentRef).includes(String(options.text))) {
        matched = true;
        reason = 'text';
        condition = 'text';
      } else if (contentStableMs) {
        const scopeOptions = resolveSnapshotScopeOptions(documentRef, options, 'compact');
        const scopeRoot = scopeOptions.scopeRoot;
        const scopedText = pruneScopedClone(
          scopeRoot.cloneNode(true),
          scopeOptions.excludeSelectors,
          scopeOptions.ignoreRoles,
          scopeRoot,
          scopeOptions.pruneHiddenDialogs
        );
        const length = scopedText.length;
        if (length >= MIN_CONTENT_STABLE_TEXT_LENGTH) {
          if (length === contentStableLastLength) {
            if (Date.now() - contentStableSince >= contentStableMs) {
              matched = true;
              reason = 'contentStableMs';
              condition = 'contentStableMs';
            }
          } else {
            contentStableLastLength = length;
            contentStableSince = Date.now();
          }
        } else {
          contentStableLastLength = -1;
          contentStableSince = 0;
        }
      }

      const elapsedMs = Date.now() - started;
      if (matched || elapsedMs >= timeoutMs) {
        resolve({
          matched,
          reason,
          condition,
          elapsedMs,
          title: documentRef.title,
          url: documentRef.location?.href
        });
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

function stringifyConsoleArg(arg) {
  if (typeof arg === 'string') return arg.slice(0, 1000);
  try {
    return JSON.stringify(arg).slice(0, 1000);
  } catch (_error) {
    return String(arg).slice(0, 1000);
  }
}

export function installConsoleCapture(windowRef = window) {
  if (consoleState.installed) return { installed: true };
  const consoleRef = windowRef.console || console;
  for (const level of ['debug', 'info', 'log', 'warn', 'error']) {
    const original = consoleRef[level]?.bind(consoleRef);
    if (!original) continue;
    consoleRef[level] = (...args) => {
      consoleState.logs.push({
        level,
        text: args.map(stringifyConsoleArg).join(' '),
        timestamp: new Date().toISOString()
      });
      if (consoleState.logs.length > MAX_CONSOLE_LOGS) consoleState.logs.splice(0, consoleState.logs.length - MAX_CONSOLE_LOGS);
      return original(...args);
    };
  }
  consoleState.installed = true;
  return { installed: true };
}

export function getConsoleLogs({ levels, limit } = {}) {
  const allowed = Array.isArray(levels) && levels.length ? new Set(levels.map((level) => String(level).toLowerCase())) : null;
  const filtered = allowed ? consoleState.logs.filter((entry) => allowed.has(entry.level)) : consoleState.logs;
  const appliedLimit = boundedLimit(limit, 50, MAX_CONSOLE_LOGS);
  return {
    logs: filtered.slice(-appliedLimit),
    omitted: Math.max(0, filtered.length - appliedLimit),
    capture: 'after-content-script-injection'
  };
}

function extractAuthor(element) {
  const heading = element.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
  if (heading) {
    const text = labelFor(heading, 160);
    if (text) return text;
  }
  const link = element.querySelector('a[href]');
  if (link) {
    const text = labelFor(link, 160);
    if (text) return text;
  }
  return undefined;
}

function extractPostText(element) {
  const paragraphs = [...element.querySelectorAll('p')];
  if (paragraphs.length) {
    return paragraphs
      .map((paragraph) => (paragraph.innerText || paragraph.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, MAX_EXTRACT_TEXT);
  }
  return (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, MAX_EXTRACT_TEXT);
}

function extractAllTimes(element) {
  const times = [...element.querySelectorAll('time')];
  let relativeTime;
  let absoluteTime;
  for (const time of times) {
    const datetime = time.getAttribute('datetime');
    const text = labelFor(time, 160);
    if (datetime && !absoluteTime) absoluteTime = datetime;
    if (text && !relativeTime) relativeTime = text;
  }
  return { relativeTime, absoluteTime };
}

function extractLiveFlags(element) {
  const liveLabel = element.querySelector('[aria-label*="Live" i], [aria-label*="live" i]');
  const text = element.innerText || element.textContent || '';
  const isLive = !!liveLabel || /\bLIVE\b/.test(text);
  const wasLive = /\bwas live\b/i.test(text);
  return {
    isLive: isLive ? true : undefined,
    wasLive: wasLive ? true : undefined
  };
}

function extractPostUrl(element) {
  const link = element.querySelector('a[href][aria-label*="post" i], a[href][role="link"]') || element.querySelector('a[href]');
  if (!link?.href) return undefined;
  return String(link.href).slice(0, 500);
}

function postCandidatesInScope(documentRef, scopeRoot) {
  const selector = 'article, [role="article"], [data-testid*="post"]';
  const matches = [...scopeRoot.querySelectorAll(selector)].filter((element) => scopeRoot.contains(element));
  // Prefer root-level posts only so nested articles do not duplicate the parent post.
  return matches.filter((element) => !matches.some((other) => other !== element && other.contains(element)));
}

export function extractFeedPosts(options = {}, documentRef = document) {
  const maxPosts = boundedLimit(options.maxPosts, 10, 50);
  const scopeOptions = resolveSnapshotScopeOptions(documentRef, { ...options, scope: options.scope || 'feed' }, 'compact');
  const scopeRoot = scopeOptions.scopeRoot;
  const candidates = postCandidatesInScope(documentRef, scopeRoot);
  const posts = [];
  for (const candidate of candidates) {
    if (posts.length >= maxPosts) break;
    const times = extractAllTimes(candidate);
    const live = extractLiveFlags(candidate);
    const text = extractPostText(candidate);
    if (!text) continue;
    const post = {
      text,
      author: extractAuthor(candidate),
      relativeTime: times.relativeTime,
      absoluteTime: times.absoluteTime,
      isLive: live.isLive,
      wasLive: live.wasLive,
      postUrl: extractPostUrl(candidate)
    };
    posts.push(post);
  }
  return {
    posts,
    count: posts.length,
    omitted: Math.max(0, candidates.length - posts.length),
    scopeApplied: scopeOptions.scopeApplied
  };
}

function dedupeKeyForItem(item, mode) {
  if (mode === 'none') return undefined;
  if (mode === 'text') return item.text;
  const href = item.href || item.links?.[0]?.href;
  if (mode === 'href' || mode === 'statusHref') return href || item.text;
  return item.text;
}

export async function collectScroll(options = {}, documentRef = document, windowRef = documentRef.defaultView || window) {
  const steps = boundedLimit(options.steps, DEFAULT_COLLECT_STEPS, MAX_COLLECT_STEPS);
  const delayMs = Math.min(MAX_COLLECT_DELAY_MS, Math.max(0, Number(options.delayMs ?? DEFAULT_COLLECT_DELAY_MS)));
  const deltaY = typeof options.deltaY === 'number' ? options.deltaY : 600;
  const scrollParams =
    options.scroll && typeof options.scroll === 'object' && !Array.isArray(options.scroll) ? options.scroll : { deltaY };
  const maxItems = boundedLimit(options.maxItems, DEFAULT_COLLECT_ITEM_LIMIT, MAX_COLLECT_ITEM_LIMIT);
  const extract = options.extract || {};
  if (!extract.selector) throw new Error('collect_scroll requires extract.selector');
  const until = options.until && typeof options.until === 'object' && !Array.isArray(options.until) ? options.until : undefined;
  const noNewItemsForSteps =
    until && typeof until.noNewItemsForSteps === 'number' && Number.isFinite(until.noNewItemsForSteps)
      ? Math.max(1, Math.floor(until.noNewItemsForSteps))
      : undefined;
  const stopBeforeDatetime = until?.stopBeforeDatetime != null ? String(until.stopBeforeDatetime) : undefined;
  let stopBeforeMs;
  if (stopBeforeDatetime) {
    if (!extract.includeTimes) {
      throw new Error('collect_scroll until.stopBeforeDatetime requires extract.includeTimes: true');
    }
    stopBeforeMs = Date.parse(stopBeforeDatetime);
    if (!Number.isFinite(stopBeforeMs)) {
      throw new Error('collect_scroll until.stopBeforeDatetime must be a valid ISO-8601 datetime');
    }
  }
  const dedupeBy = options.dedupeBy || 'none';
  const seen = new Set();
  const items = [];
  let dedupedCount = 0;
  let omitted = 0;
  let truncatedCount = 0;
  let consecutiveEmptySteps = 0;
  let stoppedReason = 'stepsExhausted';
  let stepsRun = 0;
  for (let step = 0; step < steps; step += 1) {
    stepsRun = step + 1;
    const beforeCount = items.length;
    const result = extractElements(
      {
        selector: extract.selector,
        includeText: extract.includeText,
        includeLinks: extract.includeLinks || dedupeBy === 'href' || dedupeBy === 'statusHref',
        includeTimes: extract.includeTimes,
        visible: extract.visible,
        limit: boundedLimit(extract.limitPerStep, 20, 100)
      },
      documentRef
    );
    omitted += result.omitted || 0;
    let hitDateCutoff = false;
    for (const item of result.items) {
      const key = dedupeKeyForItem(item, dedupeBy);
      if (key && seen.has(key)) {
        dedupedCount += 1;
        continue;
      }
      if (key) seen.add(key);
      if (items.length < maxItems) {
        items.push(item);
        if (stopBeforeMs !== undefined) {
          const datetime = item.time?.datetime;
          if (datetime) {
            const itemMs = Date.parse(String(datetime));
            if (Number.isFinite(itemMs) && itemMs < stopBeforeMs) {
              hitDateCutoff = true;
              break;
            }
          }
        }
      } else {
        truncatedCount += 1;
      }
    }
    if (hitDateCutoff) {
      stoppedReason = 'dateCutoff';
      break;
    }
    if (items.length >= maxItems) {
      stoppedReason = 'maxItems';
      break;
    }
    const newItemsThisStep = items.length - beforeCount;
    if (noNewItemsForSteps !== undefined) {
      if (newItemsThisStep === 0) {
        consecutiveEmptySteps += 1;
        if (consecutiveEmptySteps >= noNewItemsForSteps) {
          stoppedReason = 'noNewItems';
          break;
        }
      } else {
        consecutiveEmptySteps = 0;
      }
    }
    if (step < steps - 1) {
      performScroll(scrollParams, windowRef);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return {
    stepsRun,
    items,
    count: items.length,
    dedupedCount,
    omitted: omitted + truncatedCount,
    truncatedCount,
    maxItems,
    stoppedReason
  };
}

export const __testing = {
  configureRefStore({ ttlMs = DEFAULT_REF_TTL_MS, max = DEFAULT_MAX_REFS } = {}) {
    refTtlMs = ttlMs;
    maxRefs = max;
  },
  resetRefStore() {
    refRecords.clear();
    nextRefId = 1;
    refTtlMs = DEFAULT_REF_TTL_MS;
    maxRefs = DEFAULT_MAX_REFS;
  },
  refStoreSize() {
    return refRecords.size;
  },
  clearConsoleLogs() {
    consoleState.logs = [];
  }
};

globalThis.BrowserControlContentCore = {
  buildSnapshotFromDocument,
  buildVisibleSnapshotFromDocument,
  isPasswordLike,
  findByRef,
  boundsForRef,
  performClick,
  performType,
  performScroll,
  queryElements,
  extractElements,
  extractFeedPosts,
  performClickAt,
  performKeypress,
  waitForCondition,
  pageStatus,
  installConsoleCapture,
  getConsoleLogs,
  collectScroll,
  cleanupRefStore
};
