import { brokerAlreadyRunning, readBrokerConfig, startBrokerProcess } from '../broker-process.js';
import type { ParsedArgs } from '../parse-args.js';

export async function runStart(_args: ParsedArgs): Promise<number> {
  const config = readBrokerConfig();
  if (await brokerAlreadyRunning(config)) {
    console.log(`Broker already running on ws://${config.host}:${config.port}`);
    return 0;
  }

  const child = startBrokerProcess(config, { detached: true });
  console.log(`Started broker on ws://${config.host}:${config.port} (pid ${child.pid})`);
  console.log('Connect MCP hosts with chrome-browser-control mcp after the broker is ready.');
  return 0;
}
