import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BrokerClient } from './broker-client.js';
import { ensureBroker, getBrokerOwnership, stopSpawnedBrokerIfOwned } from './broker-lifecycle.js';
import {
  assertSafeHost,
  getBrokerHost,
  getBrokerPort,
  getBrokerUrl,
  isAutoloadEnabled,
  resolveToken
} from './env.js';
import { ADAPTER_PROTOCOL_VERSION, registerBrowserTools } from './tools.js';

export interface McpMainOptions {
  autoload?: boolean;
}

export async function main(options: McpMainOptions = {}): Promise<void> {
  const autoloadEnabled = isAutoloadEnabled(options.autoload);
  const { token, issue: tokenIssue } = resolveToken();
  const host = getBrokerHost();
  const port = getBrokerPort();
  const url = getBrokerUrl();
  assertSafeHost(host);

  const brokerClient = new BrokerClient({ url, token: token ?? '' });
  const lifecycleOptions = { url, token: token ?? '', host, port, autoloadEnabled };
  const ensureBrokerReady = () => ensureBroker(lifecycleOptions);

  const connectBridge = async () => {
    if (tokenIssue) {
      throw new Error('CHROME_BROWSER_CONTROL_TOKEN is not configured');
    }
    const lifecycle = await ensureBrokerReady();
    if (lifecycle.authFailed) {
      throw new Error(lifecycle.error || 'Broker rejected the configured pairing token');
    }
    if (!lifecycle.authOk) {
      throw new Error(lifecycle.error || 'Broker is not ready');
    }
    await brokerClient.connect();
  };

  console.error(
    '[chrome-browser-control] Trusted CDP input is opt-in via the extension debugger permission; the MCP adapter does not open a raw CDP socket.'
  );

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
  // initial adapter_status / browser_status registeredToolCount is non-zero.
  const registeredToolCount = registerBrowserTools(server, bridge, {
    ownerId,
    getStatusContext: () => ({
      adapterProtocolVersion: ADAPTER_PROTOCOL_VERSION,
      registeredToolCount,
      brokerOwnership: getBrokerOwnership(),
      brokerPort: port,
      ...(tokenIssue ? { tokenIssue } : {}),
      ensureBroker: tokenIssue ? undefined : ensureBrokerReady
    })
  });

  brokerClient.setHelloMetadata({
    adapterProtocolVersion: ADAPTER_PROTOCOL_VERSION,
    registeredToolCount
  });

  if (tokenIssue) {
    console.error(
      `[chrome-browser-control] CHROME_BROWSER_CONTROL_TOKEN is ${tokenIssue}. Call browser_status for setup coaching before using other tools.`
    );
  } else {
    try {
      await connectBridge();
      console.error(`[chrome-browser-control] Connected to Chrome broker at ws://${host}:${port}`);
    } catch (error) {
      console.error(
        `[chrome-browser-control] Could not connect to Chrome broker at ws://${host}:${port}: ${(error as Error).message}`
      );
      if (autoloadEnabled) {
        console.error('[chrome-browser-control] MCP tools will retry broker autoload on browser_status until the bridge is ready.');
      } else {
        console.error('[chrome-browser-control] Run cbctl start, then retry browser_status.');
      }
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Stay alive until signal or stdin close. CLI wrappers call process.exit after
  // main() resolves; returning here would tear down the stdio MCP server immediately.
  await new Promise<never>((_resolve) => {
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      stopSpawnedBrokerIfOwned();
      await brokerClient.disconnect();
      await server.close();
      process.exit(0);
    };

    process.on('SIGINT', () => {
      void shutdown();
    });
    process.on('SIGTERM', () => {
      void shutdown();
    });
    process.stdin.on('end', () => {
      void shutdown();
    });
    process.stdin.on('close', () => {
      void shutdown();
    });
    if (process.stdin.readableEnded || process.stdin.destroyed) {
      void shutdown();
    }
    // Hosts often close stdin without SIGTERM; still tear down an autoload broker.
    process.on('exit', () => {
      stopSpawnedBrokerIfOwned();
    });
  });
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((error) => {
    console.error('[chrome-browser-control] fatal:', error);
    process.exit(1);
  });
}
