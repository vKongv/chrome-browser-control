import { ChromeBroker } from './broker.js';
import { assertSafeHost, getBrokerHost, getBrokerPort, getToken } from './env.js';

export async function main(): Promise<void> {
  const token = getToken();
  const host = getBrokerHost();
  const port = getBrokerPort();
  assertSafeHost(host);
  const extensionId = process.env.HERMES_CHROME_EXTENSION_ID?.trim() || undefined;

  const broker = new ChromeBroker({ host, port, token, extensionId });
  await broker.start();

  console.error(`[chrome-browser-broker] WebSocket broker listening on ws://${host}:${port}`);
  console.error('[chrome-browser-broker] Load the Chrome extension and set the same token in its popup.');
  if (extensionId) {
    console.error('[chrome-browser-broker] Extension ID pinning is enabled with HERMES_CHROME_EXTENSION_ID.');
  }
  console.error('[chrome-browser-broker] Start MCP stdio adapters with: npm run mcp');
  console.error(
    '[chrome-browser-broker] Browser tool calls from all MCP clients are serialized globally at the broker.'
  );

  const shutdown = async () => {
    await broker.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[chrome-browser-broker] fatal:', error);
  process.exit(1);
});
