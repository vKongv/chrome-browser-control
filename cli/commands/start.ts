import {
  brokerAlreadyRunning,
  clearPidFile,
  isProcessAlive,
  readBrokerConfig,
  startBrokerProcess,
  waitForBrokerPort
} from '../broker-process.js';
import type { ParsedArgs } from '../parse-args.js';

export async function runStart(_args: ParsedArgs): Promise<number> {
  const config = readBrokerConfig();
  if (await brokerAlreadyRunning(config)) {
    console.log(`Broker already running on ws://${config.host}:${config.port}`);
    return 0;
  }

  const child = startBrokerProcess(config, { detached: true });
  const ready = await waitForBrokerPort(config, 15_000, child);
  if (!ready) {
    if (child.pid && isProcessAlive(child.pid)) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // Child may have exited between the alive check and kill.
      }
    }
    clearPidFile();
    console.error(
      `Broker failed to listen on ws://${config.host}:${config.port}. Check ~/.chrome-browser-control/broker.log and that the port is free.`
    );
    return 1;
  }

  console.log(`Started broker on ws://${config.host}:${config.port} (pid ${child.pid})`);
  console.log('Connect MCP hosts with chrome-browser-control mcp.');
  return 0;
}
