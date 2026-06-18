import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BrokerClient } from './broker-client.js';
import { assertSafeHost, getBrokerHost, getBrokerPort, getBrokerUrl, getToken } from './env.js';
import { registerBrowserTools } from './tools.js';

export async function main(): Promise<void> {
  const token = getToken();
  const host = getBrokerHost();
  const port = getBrokerPort();
  assertSafeHost(host);

  const brokerClient = new BrokerClient({ url: getBrokerUrl(), token });

  try {
    await brokerClient.connect();
    console.error(`[chrome-browser-control] Connected to Chrome broker at ws://${host}:${port}`);
  } catch (error) {
    console.error(
      `[chrome-browser-control] Could not connect to Chrome broker at ws://${host}:${port}: ${(error as Error).message}`
    );
    console.error('[chrome-browser-control] Start the broker once with: npm run broker');
    console.error('[chrome-browser-control] MCP tools will fail until the broker is running and the extension is connected.');
  }

  console.error('[chrome-browser-control] CDP fallback is unsupported in the MCP adapter; use the extension bridge.');

  const server = new McpServer({
    name: 'chrome-browser-control',
    version: '0.1.0'
  });

  registerBrowserTools(server, brokerClient);

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
