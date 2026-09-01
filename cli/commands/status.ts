import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureBroker } from '../../server/broker-lifecycle.js';
import { formatBrokerWsUrl, resolveToken } from '../../server/env.js';
import { getExtensionCopyStatus } from '../copy-extension.js';
import {
  brokerAlreadyRunning,
  isPortOpen,
  readBrokerConfig,
  readPidFile
} from '../broker-process.js';
import type { ParsedArgs } from '../parse-args.js';
import { getUserConfigPath } from '../../server/paths.js';

export async function runStatus(_args: ParsedArgs): Promise<number> {
  const configPath = getUserConfigPath();
  const hasConfig = existsSync(configPath);
  const extensionCopy = getExtensionCopyStatus();
  let brokerRunning = false;
  let authOk = false;
  let pid: number | undefined;
  let portOpen = false;
  let host = '127.0.0.1';
  let port = 8765;
  let tokenIssue: string | undefined;

  if (hasConfig) {
    try {
      const config = readBrokerConfig();
      host = config.host;
      port = config.port;
      pid = readPidFile();
      brokerRunning = await brokerAlreadyRunning(config);
      portOpen = await isPortOpen(host, port);
      const resolved = resolveToken();
      if (resolved.issue) {
        tokenIssue = resolved.issue;
      } else {
        const lifecycle = await ensureBroker({
          url: formatBrokerWsUrl(host, port),
          token: resolved.token!,
          host,
          port,
          autoloadEnabled: false
        });
        authOk = lifecycle.authOk;
      }
    } catch (error) {
      console.log(`Config error: ${(error as Error).message}`);
    }
  }

  const brokerUrl = formatBrokerWsUrl(host, port);
  console.log('Chrome Browser Control status');
  console.log('=============================');
  console.log(`${hasConfig ? '✅' : '❌'} User config ${hasConfig ? getUserConfigPath() : 'missing — run cbctl setup'}`);
  const extensionDetail =
    extensionCopy.state === 'current'
      ? 'present'
      : extensionCopy.state === 'absent'
        ? 'missing — run cbctl setup'
        : `stale — ${extensionCopy.differingFiles.length} differing file(s): ${extensionCopy.differingFiles.join(', ')} — run cbctl setup, then reload the unpacked extension in chrome://extensions`;
  console.log(`${extensionCopy.state === 'current' ? '✅' : '❌'} Extension copy ${extensionDetail}`);
  if (tokenIssue) {
    console.log(`❌ Token ${tokenIssue}`);
  } else if (hasConfig) {
    console.log('✅ Token configured');
  }
  console.log(`${brokerRunning ? '✅' : '❌'} Broker ${brokerRunning ? `running${pid ? ` (pid ${pid})` : ''}` : 'stopped'} on ${brokerUrl}`);
  console.log(`${portOpen ? '✅' : '❌'} Port ${port} ${portOpen ? 'open' : 'closed'}`);
  if (hasConfig && portOpen) {
    console.log(`${authOk ? '✅' : '❌'} Broker auth ${authOk ? 'ok' : 'failed or unreachable'}`);
  }

  return 0;
}
