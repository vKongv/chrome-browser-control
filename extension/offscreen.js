const CONNECT_TIMEOUT_MS = 10_000;
const {
  normalizeAllowedOriginPatterns,
  normalizeBridgeUrl,
  validatePairingToken
} = globalThis.BrowserControlSecurity;

let socket = null;
let reconnectTimer = null;
let connectTimeout = null;
let status = 'disconnected';
let activeSettings = null;
let requestQueue = Promise.resolve();

function sendRuntimeMessage(message) {
  try {
    return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => undefined);
  } catch (_error) {
    return Promise.resolve(undefined);
  }
}

function clearConnectTimeout() {
  if (!connectTimeout) return;
  clearTimeout(connectTimeout);
  connectTimeout = null;
}

async function setStatus(nextStatus) {
  status = nextStatus;
  await sendRuntimeMessage({ target: 'cbc-background', kind: 'status-update', status: nextStatus });
}

function cancelReconnect() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(() => undefined);
  }, 2000);
}

function sameSettings(a, b) {
  return a?.bridgeUrl === b?.bridgeUrl && a?.token === b?.token;
}

function closeSocket(reason = 'Reconnecting with updated settings') {
  if (!socket) return;
  const closing = socket;
  socket = null;
  try {
    closing.close(1000, reason);
  } catch (_error) {
    // Ignore close races; reconnect will create a fresh socket.
  }
}

async function connect(options = {}) {
  const settings = options.settings || activeSettings;
  if (!settings?.bridgeUrl) {
    throw new Error('Bridge settings are unavailable');
  }
  const validatedSettings = {
    ...settings,
    bridgeUrl: normalizeBridgeUrl(settings.bridgeUrl),
    token: validatePairingToken(settings.token),
    allowedOrigins: normalizeAllowedOriginPatterns(settings.allowedOrigins || [])
  };
  cancelReconnect();
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) {
    if (!options.force && sameSettings(validatedSettings, activeSettings)) return { status };
    closeSocket('Settings changed; reconnecting');
  }

  activeSettings = validatedSettings;
  clearConnectTimeout();
  const ws = new WebSocket(validatedSettings.bridgeUrl);
  let opened = false;
  socket = ws;
  setStatus('connecting').catch(() => undefined);
  connectTimeout = setTimeout(() => {
    if (socket !== ws || ws.readyState !== WebSocket.CONNECTING) return;
    closeSocket('Timed out waiting for bridge connection');
    setStatus('error').catch(() => undefined);
  }, CONNECT_TIMEOUT_MS);

  function buildHelloBody() {
    const manifest =
      typeof chrome.runtime.getManifest === 'function' ? chrome.runtime.getManifest() : null;
    return {
      kind: 'hello',
      token: validatedSettings.token,
      role: 'extension',
      extensionId: chrome.runtime.id,
      ...(manifest?.version ? { version: manifest.version } : {})
    };
  }

  function sendHello(source, retried = false) {
    const canSend = socket === ws && ws.readyState === WebSocket.OPEN;
    if (!canSend) return false;
    try {
      ws.send(JSON.stringify(buildHelloBody()));
      setStatus('authenticating').catch(() => undefined);
      return true;
    } catch (error) {
      if (!retried && error.name === 'InvalidStateError') {
        queueMicrotask(() => sendHello(source, true));
        return false;
      }
      setStatus(`error: failed to send hello: ${error.message}`).catch(() => undefined);
      if (socket === ws) closeSocket('Failed to send extension hello');
      return false;
    }
  }

  ws.addEventListener('open', () => {
    if (socket !== ws) return;
    opened = true;
    clearConnectTimeout();
    sendHello('open');
  });

  ws.addEventListener('close', (event) => {
    if (socket !== ws) return;
    socket = null;
    clearConnectTimeout();
    sendRuntimeMessage({ target: 'cbc-background', kind: 'adapter-status', adapterStatus: null });
    if (event.code === 1008) {
      setStatus(`auth_failed: ${event.reason || 'bridge rejected pairing'}`).catch(() => undefined);
    } else if (!opened && event.code === 1006) {
      setStatus('error: broker not running — start npm run broker').catch(() => undefined);
    } else if (
      status !== 'error' &&
      !status.startsWith('error:') &&
      !status.startsWith('auth_failed')
    ) {
      setStatus('disconnected').catch(() => undefined);
    }
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    if (socket !== ws) return;
    clearConnectTimeout();
    if (!opened) {
      setStatus('error: bridge not reachable at ' + validatedSettings.bridgeUrl).catch(() => undefined);
      return;
    }
    setStatus('error').catch(() => undefined);
  });

  ws.addEventListener('message', (event) => {
    if (socket !== ws) return;
    try {
      const message = JSON.parse(event.data);
      if (message?.kind === 'auth_required') {
        sendHello('auth_required');
        return;
      }
      if (message?.kind === 'auth_ack' && message?.ok) {
        setStatus('connected').catch(() => undefined);
        return;
      }
      if (message?.kind === 'adapter_status') {
        const adapterStatus = {
          adapterProtocolVersion:
            typeof message.adapterProtocolVersion === 'number' ? message.adapterProtocolVersion : null,
          registeredToolCount:
            typeof message.registeredToolCount === 'number' ? message.registeredToolCount : 0,
          mcpClientCount: typeof message.mcpClientCount === 'number' ? message.mcpClientCount : 0,
          updatedAt: typeof message.updatedAt === 'number' ? message.updatedAt : Date.now()
        };
        sendRuntimeMessage({ target: 'cbc-background', kind: 'adapter-status', adapterStatus });
        return;
      }
    } catch (_error) {
      // Let the normal bridge request handler return a structured error.
    }
    requestQueue = requestQueue.then(() => handleBridgeMessage(event.data)).catch(() => undefined);
  });

  return { status };
}

async function handleBridgeMessage(raw) {
  let request;
  let response = { kind: 'response', id: 'unknown', ok: false, error: 'Unknown bridge request error' };
  try {
    request = JSON.parse(raw);
    if (!request || request.kind !== 'request' || typeof request.id !== 'string' || !request.id || typeof request.action !== 'string') {
      throw new Error('Invalid bridge request');
    }
    response = { kind: 'response', id: request.id, ok: true };
    try {
      const backgroundResponse = await sendRuntimeMessage({
        target: 'cbc-background',
        kind: 'bridge-request',
        action: request.action,
        params: request.params || {}
      });
      if (!backgroundResponse?.ok) {
        throw new Error(backgroundResponse?.error || 'Background bridge request failed');
      }
      response.result = backgroundResponse.result;
    } catch (error) {
      response.ok = false;
      response.error = error.message;
    }
  } catch (error) {
    response.error = error.message;
    if (request?.id && typeof request.id === 'string') response.id = request.id;
  }

  socket?.send(JSON.stringify(response));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'cbc-offscreen') return false;

  if (message.action === 'connect') {
    connect({ force: Boolean(message.force), settings: message.settings })
      .then((result) => sendResponse({ ok: true, status: result.status }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.action === 'status') {
    sendResponse({ ok: true, status });
    return true;
  }

  return false;
});
