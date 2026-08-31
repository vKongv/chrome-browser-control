const bridgeUrl = document.getElementById('bridgeUrl');
const token = document.getElementById('token');
const allowedOrigins = document.getElementById('allowedOrigins');
const enableDebugger = document.getElementById('enableDebugger');
const statusEl = document.getElementById('status');
const save = document.getElementById('save');
const setupSnippet = document.getElementById('setupSnippet');
const copyJson = document.getElementById('copyJson');
const copyCursor = document.getElementById('copyCursor');
const copyYaml = document.getElementById('copyYaml');
const {
  DEFAULT_BRIDGE_URL,
  DEFAULT_ALLOWED_ORIGINS,
  formatAllowedOriginPatternsForDisplay,
  collectOptionalPermissionOrigins,
  normalizeAllowedOriginPatterns,
  normalizeBridgeUrl,
  validatePairingToken
} = globalThis.BrowserControlSecurity;

function showStatus(nextStatus) {
  statusEl.textContent = nextStatus;
}

function cursorConfigTemplate(currentToken = '<generated-token>', port = currentBridgePort()) {
  return jsonConfigTemplate(currentToken, port);
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
        chrome_browser_control: {
          command: 'chrome-browser-control',
          args: ['mcp'],
          env: {
            CHROME_BROWSER_CONTROL_TOKEN: currentToken,
            CHROME_BROWSER_CONTROL_PORT: port
          },
          timeout: 60,
          connect_timeout: 30
        }
      }
    },
    null,
    2
  );
}

function yamlConfigTemplate(currentToken = '<generated-token>', port = currentBridgePort()) {
  return [
    'mcp_servers:',
    '  chrome_browser_control:',
    '    command: "chrome-browser-control"',
    '    args: ["mcp"]',
    '    env:',
    `      CHROME_BROWSER_CONTROL_TOKEN: ${JSON.stringify(currentToken)}`,
    `      CHROME_BROWSER_CONTROL_PORT: ${JSON.stringify(port)}`,
    '    timeout: 60',
    '    connect_timeout: 30'
  ].join('\n');
}

async function copySnippet(kind) {
  const settings = await chrome.storage.local.get({ token: '' });
  const currentToken = settings.token || '<generated-token>';
  const snippet =
    kind === 'yaml'
      ? yamlConfigTemplate(currentToken)
      : kind === 'cursor'
        ? cursorConfigTemplate(currentToken)
        : jsonConfigTemplate(currentToken);
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
  setupSnippet.value = jsonConfigTemplate(settings.token || '<generated-token>');
  showStatus(settings.status);
  if (enableDebugger) {
    enableDebugger.checked = await containsPermission({ permissions: ['debugger'] });
  }
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
  if (area !== 'local') return;
  if (changes.status) showStatus(changes.status.newValue);
});

copyJson.addEventListener('click', () => copySnippet('json'));
copyCursor.addEventListener('click', () => copySnippet('cursor'));
copyYaml.addEventListener('click', () => copySnippet('yaml'));

function containsPermission(request) {
  if (!chrome.permissions?.contains) return Promise.resolve(false);
  return new Promise((resolve) => {
    chrome.permissions.contains(request, (granted) => resolve(Boolean(granted)));
  });
}

function removePermissions(request) {
  if (!chrome.permissions?.remove) return Promise.resolve(false);
  return new Promise((resolve) => {
    chrome.permissions.remove(request, (removed) => resolve(Boolean(removed)));
  });
}

function requestOptionalPermissions(request = {}) {
  const origins = Array.isArray(request.origins) ? request.origins : [];
  const permissions = Array.isArray(request.permissions) ? request.permissions : [];
  if ((!origins.length && !permissions.length) || !chrome.permissions?.request) return Promise.resolve(true);
  const payload = {};
  if (origins.length) payload.origins = origins;
  if (permissions.length) payload.permissions = permissions;
  return new Promise((resolve) => {
    chrome.permissions.request(payload, (granted) => resolve(Boolean(granted)));
  });
}

async function persistSettingsThenRequestPermissions({ settings, origins = [], permissions = [], revokePermissions = [] }) {
  await chrome.storage.local.set(settings);
  if (revokePermissions.length) await removePermissions({ permissions: revokePermissions });
  const granted = await requestOptionalPermissions({ origins, permissions });
  return { saved: true, granted };
}

save.addEventListener('click', async () => {
  try {
    const nextBridgeUrl = normalizeBridgeUrl(bridgeUrl.value);
    const nextToken = validatePairingToken(token.value);
    const nextAllowedOrigins = normalizeAllowedOriginPatterns(allowedOrigins.value);
    const settings = {
      bridgeUrl: nextBridgeUrl,
      token: nextToken,
      allowedOrigins: nextAllowedOrigins
    };
    const origins = collectOptionalPermissionOrigins(nextAllowedOrigins);
    const wantDebugger = enableDebugger?.checked === true;
    const permissions = wantDebugger ? ['debugger'] : [];
    const revokePermissions = wantDebugger ? [] : ['debugger'];
    const { granted } = await persistSettingsThenRequestPermissions({
      settings,
      origins,
      permissions,
      revokePermissions
    });
    bridgeUrl.value = nextBridgeUrl;
    allowedOrigins.value = formatAllowedOriginPatternsForDisplay(nextAllowedOrigins).join('\n');
    if (!granted) {
      showStatus('saved; optional permission was not granted');
      return;
    }
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

if (globalThis.CBC_TEST_HARNESS) {
  globalThis.BrowserControlPopup = {
    collectOptionalPermissionOrigins,
    persistSettingsThenRequestPermissions,
    requestOptionalPermissions
  };
}
