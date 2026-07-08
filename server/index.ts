import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BrokerClient } from './broker-client.js';
import { ensureBroker, getBrokerOwnership } from './broker-lifecycle.js';
import { assertSafeHost, getBrokerHost, getBrokerPort, getBrokerUrl, getToken } from './env.js';
import { ADAPTER_PROTOCOL_VERSION, registerBrowserTools } from './tools.js';

export async function main(): Promise<void> {
  const token = getToken();
  const host = getBrokerHost();
  const port = getBrokerPort();
  const url = getBrokerUrl();
  assertSafeHost(host);

  const brokerClient = new BrokerClient({ url, token });
  const lifecycleOptions = { url, token, host, port };
  const ensureBrokerReady = () => ensureBroker(lifecycleOptions);

  const connectBridge = async () => {
    const lifecycle = await ensureBrokerReady();
    if (lifecycle.authFailed) {
      throw new Error(lifecycle.error || 'Broker rejected the configured pairing token');
    }
    if (!lifecycle.authOk) {
      throw new Error(lifecycle.error || 'Broker is not ready');
    }
    await brokerClient.connect();
  };

  console.error('[chrome-browser-control] CDP fallback is unsupported in the MCP adapter; use the extension bridge.');

  const ownerId = crypto.randomUUID();

  const server = new McpServer({
    name: 'chrome-browser-control',
    version: '0.1.0'
  });

  const bridge = {
    get connected() {
      return brokerClient.connected;
    },
    connect: connectBridge,
    call: (action: Parameters<typeof brokerClient.call>[0], params?: Record<string, unknown>) =>
      brokerClient.call(action, params)
  };

  // Register tools and set hello metadata before the first broker connect so the
  // initial adapter_status push (and popup tool count) is non-zero.
  const registeredToolCount = registerBrowserTools(server, bridge, {
    ownerId,
    getStatusContext: () => ({
      adapterProtocolVersion: ADAPTER_PROTOCOL_VERSION,
      registeredToolCount,
      brokerOwnership: getBrokerOwnership(),
      brokerPort: port,
      ensureBroker: ensureBrokerReady
    })
  });

  brokerClient.setHelloMetadata({
    adapterProtocolVersion: ADAPTER_PROTOCOL_VERSION,
    registeredToolCount
  });

  try {
    await connectBridge();
    console.error(`[chrome-browser-control] Connected to Chrome broker at ws://${host}:${port}`);
  } catch (error) {
    console.error(
      `[chrome-browser-control] Could not connect to Chrome broker at ws://${host}:${port}: ${(error as Error).message}`
    );
    console.error('[chrome-browser-control] MCP tools will retry broker autoload on browser_status until the bridge is ready.');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await brokerClient.disconnect();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[chrome-browser-control] fatal:', error);
  process.exit(1);
});
