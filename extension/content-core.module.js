const REF_ATTR = 'data-cbc-ref';
const INTERESTING_SELECTOR = 'a,button,input,textarea,select,summary,[role],[contenteditable]';
const FULL_ELEMENT_LIMIT = 250;
const COMPACT_ELEMENT_LIMIT = 100;
const DEFAULT_COMPACT_TEXT_LIMIT = 500;
const DEFAULT_FULL_TEXT_LIMIT = 4000;
const MAX_TEXT_LIMIT = 100_000;
const DEFAULT_REF_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_REFS = 500;

let refTtlMs = DEFAULT_REF_TTL_MS;
let maxRefs = DEFAULT_MAX_REFS;
let nextRefId = 1;
const elementRefs = new WeakMap();
const refRecords = new Map();

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

function compactItemFor(element, ref) {
  const item = {
    ref,
    role: roleFor(element),
    label: labelFor(element, 80)
  };
  if (isPasswordLike(element)) item.passwordLike = true;
  return item;
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

function bodyTextFor(documentRef) {
  return (documentRef.body?.innerText || documentRef.body?.textContent || '').replace(/\s+/g, ' ').trim();
}

export function buildSnapshotFromDocument(documentRef = document, options = {}) {
  const mode = options?.mode === 'full' ? 'full' : 'compact';
  const textLimit = resolveTextLimit(options, mode);
  const now = typeof options?.now === 'number' ? options.now : nowMs();
  cleanupRefStore(documentRef, now);

  const elements = interestingElements(documentRef);
  const limit = mode === 'full' ? FULL_ELEMENT_LIMIT : COMPACT_ELEMENT_LIMIT;
  const selected = elements.slice(0, limit);
  const items = selected.map((element) => {
    const ref = refForElement(element, documentRef, now);
    return mode === 'full' ? fullItemFor(element, ref) : compactItemFor(element, ref);
  });
  cleanupRefStore(documentRef, now);

  const bodyText = bodyTextFor(documentRef);
  const textBytesOmitted = Math.max(0, bodyText.length - textLimit);

  if (mode === 'full') {
    return {
      title: documentRef.title,
      url: documentRef.location?.href,
      elements: items,
      omittedElements: Math.max(0, elements.length - selected.length),
      text: bodyText.slice(0, textLimit),
      textLimitApplied: textLimit,
      ...(textBytesOmitted > 0 ? { textBytesOmitted } : {})
    };
  }

  return {
    title: documentRef.title,
    url: documentRef.location?.href,
    mode: 'compact',
    elements: items,
    omittedElements: Math.max(0, elements.length - selected.length),
    textPreview: bodyText.slice(0, textLimit),
    textBytesOmitted,
    textLimitApplied: textLimit,
    regions: regionSummaries(documentRef, selected)
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

export function performClick({ ref }, documentRef = document) {
  const element = findByRef(ref, documentRef);
  if (!element) throw new Error(`No element found for ref ${ref}. Refresh snapshot and try again.`);
  element.scrollIntoView?.({ block: 'center', inline: 'center' });
  element.click();
  return { clicked: ref };
}

export function performType({ ref, text, force = false }, documentRef = document) {
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

export function performScroll({ deltaX = 0, deltaY = 600 } = {}, windowRef = window) {
  windowRef.scrollBy(deltaX, deltaY);
  return { scrolled: true, deltaX, deltaY };
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
  }
};

globalThis.BrowserControlContentCore = {
  buildSnapshotFromDocument,
  isPasswordLike,
  findByRef,
  performClick,
  performType,
  performScroll,
  cleanupRefStore
};
