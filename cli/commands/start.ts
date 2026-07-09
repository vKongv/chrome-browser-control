import {
  brokerAlreadyRunning,
  clearPidFile,
  isPortOpen,
  isProcessAlive,
  readBrokerConfig,
  startBrokerProcess,
  stopBrokerProcess,
  waitForBrokerPort
} from '../broker-process.js';
import { formatBrokerWsUrl } from '../../server/env.js';
import type { ParsedArgs } from '../parse-args.js';

export async function runStart(_args: ParsedArgs): Promise<number> {
  const config = readBrokerConfig();
  const brokerUrl = formatBrokerWsUrl(config.host, config.port);
  if (await brokerAlreadyRunning(config)) {
    console.log(`Broker already running on ${brokerUrl}`);
    return 0;
  }

  // Config host/port may have changed; a prior CLI-started broker can still be alive
  // on the old endpoint. Stop it before rewriting broker.pid.
  if ((await stopBrokerProcess()) === 'stopped') {
    console.log('Stopped previous broker (configured endpoint was not listening).');
  }

  if (await isPortOpen(config.host, config.port)) {
    console.error(
      `Port ${config.port} on ${config.host} is open but is not a Chrome Browser Control broker with the configured token. Free the port or fix config.env, then retry.`
    );
    return 1;
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
      `Broker failed to become ready on ${brokerUrl}. Check ~/.chrome-browser-control/broker.log and that the port is free.`
    );
    return 1;
  }

  console.log(`Started broker on ${brokerUrl} (pid ${child.pid})`);
  console.log('Connect MCP hosts with cbctl mcp.');
  return 0;
}
