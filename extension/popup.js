const bridgeUrl = document.getElementById('bridgeUrl');
const token = document.getElementById('token');
const allowedOrigins = document.getElementById('allowedOrigins');
const statusEl = document.getElementById('status');
const save = document.getElementById('save');
const setupSnippet = document.getElementById('setupSnippet');
const copyJson = document.getElementById('copyJson');
const copyHermes = document.getElementById('copyHermes');
const {
  DEFAULT_BRIDGE_URL,
  DEFAULT_ALLOWED_ORIGINS,
  formatAllowedOriginPatternsForDisplay,
  getHostPermissionOrigins,
  normalizeAllowedOriginPatterns,
  normalizeBridgeUrl,
  validatePairingToken
} = globalThis.HermesSecurity;

function showStatus(nextStatus) {
  statusEl.textContent = nextStatus;
}

function currentBridgePort() {
  try {
    return new URL(bridgeUrl.value).port || '8765';
  } catch (_error) {
    return '8765';
  }
}

function jsonConfigTemplate(currentToken = '<generated-token>', port = currentBridgePort()) {
  return JSON.stringify(
    {
      mcpServers: {
        chrome_browser: {
          command: '/absolute/path/to/chrome-browser-control/node_modules/.bin/tsx',
          args: ['/absolute/path/to/chrome-browser-control/server/index.ts'],
          env: {
            HERMES_CHROME_TOKEN: currentToken,
            HERMES_CHROME_PORT: port
          }
        }
      }
    },
    null,
    2
  );
}

function hermesConfigTemplate(currentToken = '<generated-token>', port = currentBridgePort()) {
  return [
    'mcp_servers:',
    '  chrome_browser:',
    '    command: "/absolute/path/to/chrome-browser-control/node_modules/.bin/tsx"',
    '    args: ["/absolute/path/to/chrome-browser-control/server/index.ts"]',
    '    env:',
    `      HERMES_CHROME_TOKEN: ${JSON.stringify(currentToken)}`,
    `      HERMES_CHROME_PORT: ${JSON.stringify(port)}`,
    '    timeout: 60',
    '    connect_timeout: 30'
  ].join('\n');
}

async function copySnippet(kind) {
  const snippet = kind === 'hermes' ? hermesConfigTemplate() : jsonConfigTemplate();
  setupSnippet.value = snippet;
  try {
    await navigator.clipboard?.writeText(snippet);
    showStatus(`copied ${kind} config template`);
  } catch (_error) {
    showStatus(`showing ${kind} config template`);
  }
}

function queryLiveStatus() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'status' }, (response) => resolve(response));
  });
}

async function refresh() {
  const settings = await chrome.storage.local.get({
    bridgeUrl: DEFAULT_BRIDGE_URL,
    token: '',
    allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
    status: 'unknown'
  });
  bridgeUrl.value = settings.bridgeUrl;
  token.value = settings.token;
  allowedOrigins.value = formatAllowedOriginPatternsForDisplay(settings.allowedOrigins).join('\n');
  setupSnippet.value = jsonConfigTemplate();
  showStatus(settings.status);
  const response = await queryLiveStatus();
  if (response?.ok) showStatus(response.status);
}

async function waitForSettledStatus(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await queryLiveStatus();
    const nextStatus = response?.ok ? response.status : null;
    if (nextStatus) showStatus(nextStatus);
    if (nextStatus && nextStatus !== 'connecting' && nextStatus !== 'authenticating') return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.status) return;
  showStatus(changes.status.newValue);
});

copyJson.addEventListener('click', () => copySnippet('json'));
copyHermes.addEventListener('click', () => copySnippet('hermes'));

function requestHostPermissions(origins) {
  if (!origins.length || !chrome.permissions?.request) return Promise.resolve(true);
  return new Promise((resolve) => {
    chrome.permissions.request({ origins }, (granted) => resolve(Boolean(granted)));
  });
}

save.addEventListener('click', async () => {
  try {
    const nextBridgeUrl = normalizeBridgeUrl(bridgeUrl.value);
    const nextToken = validatePairingToken(token.value);
    const nextAllowedOrigins = normalizeAllowedOriginPatterns(allowedOrigins.value);
    const granted = await requestHostPermissions(getHostPermissionOrigins(nextAllowedOrigins));
    if (!granted) {
      showStatus('error: allowed origin permission was not granted');
      return;
    }
    await chrome.storage.local.set({
      bridgeUrl: nextBridgeUrl,
      token: nextToken,
      allowedOrigins: nextAllowedOrigins
    });
    bridgeUrl.value = nextBridgeUrl;
    allowedOrigins.value = formatAllowedOriginPatternsForDisplay(nextAllowedOrigins).join('\n');
    showStatus('connecting');
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'connect' }, resolve);
    });
    if (!response?.ok) {
      showStatus(`error: ${response?.error || 'unknown'}`);
      return;
    }
    await waitForSettledStatus();
  } catch (error) {
    showStatus(`error: ${error.message}`);
  }
});

refresh().catch((error) => {
  statusEl.textContent = `error: ${error.message}`;
});
