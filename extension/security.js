(function (global) {
  const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8765';
  const DEFAULT_ALLOWED_ORIGINS = [];
  const WILDCARD_ORIGIN_INPUT = '*';
  const WILDCARD_ORIGIN_PATTERNS = ['http://*/*', 'https://*/*'];
  const SCREENSHOT_ALL_URLS_PERMISSION = '<all_urls>';
  const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
  const MIN_TOKEN_UNIQUE_CHARS = 8;
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

  function normalizeBridgeUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('Bridge URL is required');

    let url;
    try {
      url = new URL(raw);
    } catch (_error) {
      throw new Error('Bridge URL must be a valid local ws:// URL');
    }

    if (url.protocol !== 'ws:') {
      throw new Error('Bridge URL must use ws://, not wss:// or http(s)://');
    }
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error('Bridge URL host must be 127.0.0.1, localhost, or [::1]');
    }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Bridge URL may only include a loopback host and optional port');
    }
    return url.origin;
  }

  function validatePairingToken(input) {
    const token = String(input || '').trim();
    const insecureDefaultToken = ['dev', 'token', 'change', 'me'].join('-');
    if (!token) throw new Error('Pairing token is required');
    if (token === insecureDefaultToken) throw new Error('Refusing the insecure default pairing token');
    if (!TOKEN_PATTERN.test(token)) {
      throw new Error('Pairing token must be at least 32 URL-safe random characters');
    }
    if (new Set(token).size < MIN_TOKEN_UNIQUE_CHARS) {
      throw new Error('Pairing token must contain enough character variety');
    }
    return token;
  }

  function splitAllowedOriginInput(input) {
    if (Array.isArray(input)) return input;
    return String(input || '')
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function isWildcardOriginInput(input) {
    return String(input || '').trim() === WILDCARD_ORIGIN_INPUT;
  }

  function isWildcardOriginPattern(pattern) {
    return WILDCARD_ORIGIN_PATTERNS.includes(String(pattern || '').trim());
  }

  function isWildcardOriginPatterns(patterns) {
    const normalized = normalizeAllowedOriginPatterns(patterns);
    return (
      normalized.length === WILDCARD_ORIGIN_PATTERNS.length &&
      WILDCARD_ORIGIN_PATTERNS.every((pattern) => normalized.includes(pattern))
    );
  }

  function normalizeAllowedOriginPattern(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('Allowed origin cannot be blank');
    if (isWildcardOriginInput(raw)) return null;
    if (isWildcardOriginPattern(raw)) return raw;

    let candidate = raw.endsWith('/*') ? raw.slice(0, -2) : raw;
    if (candidate.includes('*')) throw new Error(`Allowed origin must be explicit, not wildcard: ${raw}`);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
      candidate = `https://${candidate}`;
    }

    let url;
    try {
      url = new URL(candidate);
    } catch (_error) {
      throw new Error(`Allowed origin must be a valid http(s) origin: ${raw}`);
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`Allowed origin must use http:// or https://: ${raw}`);
    }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`Allowed origin must not include credentials, paths, queries, or fragments: ${raw}`);
    }
    return `${url.origin}/*`;
  }

  function normalizeAllowedOriginPatterns(input) {
    let wildcard = false;
    const seen = new Set();
    const patterns = [];
    for (const item of splitAllowedOriginInput(input)) {
      const raw = String(item || '').trim();
      if (isWildcardOriginInput(raw) || isWildcardOriginPattern(raw)) {
        wildcard = true;
        continue;
      }
      const pattern = normalizeAllowedOriginPattern(item);
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      patterns.push(pattern);
    }
    if (wildcard) return [...WILDCARD_ORIGIN_PATTERNS];
    return patterns;
  }

  function formatAllowedOriginPatternsForDisplay(patterns) {
    if (isWildcardOriginPatterns(patterns)) return [WILDCARD_ORIGIN_INPUT];
    return normalizeAllowedOriginPatterns(patterns);
  }

  function describeAllowedOrigins(patterns) {
    if (isWildcardOriginPatterns(patterns)) {
      return [`${WILDCARD_ORIGIN_INPUT} (all http/https web origins)`];
    }
    return normalizeAllowedOriginPatterns(patterns);
  }

  function getHostPermissionOrigins(patterns) {
    return normalizeAllowedOriginPatterns(patterns);
  }

  function getScreenshotPermissionOrigins(patterns) {
    return isWildcardOriginPatterns(patterns) ? [SCREENSHOT_ALL_URLS_PERMISSION] : [];
  }

  function patternOrigin(pattern) {
    return String(pattern || '').endsWith('/*') ? String(pattern).slice(0, -2) : String(pattern || '');
  }

  function isUrlAllowed(urlInput, patterns) {
    let url;
    try {
      url = new URL(String(urlInput || ''));
    } catch (_error) {
      return false;
    }
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const allowed = normalizeAllowedOriginPatterns(patterns);
    if (isWildcardOriginPatterns(allowed)) return true;
    return allowed.some((pattern) => patternOrigin(pattern) === url.origin);
  }

  function normalizeUrlForCompare(input) {
    try {
      const url = new URL(String(input || ''));
      let pathname = url.pathname;
      if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
      return `${url.origin}${pathname}${url.search}`;
    } catch (_error) {
      return String(input || '');
    }
  }

  function urlsEquivalent(a, b) {
    return normalizeUrlForCompare(a) === normalizeUrlForCompare(b);
  }

  global.BrowserControlSecurity = {
    DEFAULT_BRIDGE_URL,
    DEFAULT_ALLOWED_ORIGINS,
    WILDCARD_ORIGIN_INPUT,
    WILDCARD_ORIGIN_PATTERNS,
    SCREENSHOT_ALL_URLS_PERMISSION,
    normalizeBridgeUrl,
    validatePairingToken,
    normalizeAllowedOriginPattern,
    normalizeAllowedOriginPatterns,
    formatAllowedOriginPatternsForDisplay,
    describeAllowedOrigins,
    getHostPermissionOrigins,
    getScreenshotPermissionOrigins,
    isWildcardOriginPatterns,
    isUrlAllowed,
    urlsEquivalent
  };
})(globalThis);
