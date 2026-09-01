import { existsSync } from 'node:fs';
import { getExtensionCopyStatus } from '../copy-extension.js';
import {
  getCompiledBrokerMainPath,
  getCompiledMcpMainPath,
  getPackageRoot,
  getUserConfigPath,
  readPackageVersion
} from '../../server/paths.js';
import { readEnvFile, DEFAULT_TOKEN_ENV } from '../../server/env-file.js';
import { formatBrokerWsUrl } from '../../server/env.js';
import { brokerAlreadyRunning, isPortOpen, readBrokerConfig } from '../broker-process.js';
import type { ParsedArgs } from '../parse-args.js';

export async function runDoctor(_args: ParsedArgs): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

  try {
    checks.push({ name: 'CLI version', ok: true, detail: readPackageVersion() });
    checks.push({ name: 'Package root', ok: true, detail: getPackageRoot() });
  } catch (error) {
    checks.push({ name: 'CLI version', ok: false, detail: (error as Error).message });
  }

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'Node.js >= 18', ok: nodeMajor >= 18, detail: process.version });

  const brokerMain = getCompiledBrokerMainPath();
  const mcpMain = getCompiledMcpMainPath();
  checks.push({ name: 'Compiled broker entry', ok: existsSync(brokerMain), detail: brokerMain });
  checks.push({ name: 'Compiled MCP entry', ok: existsSync(mcpMain), detail: mcpMain });
  const extensionCopy = getExtensionCopyStatus();
  const extensionDetail =
    extensionCopy.state === 'current'
      ? 'current'
      : extensionCopy.state === 'absent'
        ? 'missing — run cbctl setup'
        : `stale — ${extensionCopy.differingFiles.length} differing file(s): ${extensionCopy.differingFiles.join(', ')} — run cbctl setup, then reload the unpacked extension in chrome://extensions`;
  checks.push({ name: 'Extension copy', ok: extensionCopy.state === 'current', detail: extensionDetail });

  const configPath = getUserConfigPath();
  const hasConfig = existsSync(configPath);
  checks.push({ name: 'User config', ok: hasConfig, detail: configPath });

  let tokenOk = false;
  if (hasConfig) {
    const env = readEnvFile(configPath);
    tokenOk = typeof env[DEFAULT_TOKEN_ENV] === 'string' && env[DEFAULT_TOKEN_ENV].length >= 32;
  }
  checks.push({ name: 'Pairing token configured', ok: tokenOk, detail: configPath });

  if (hasConfig) {
    try {
      const config = readBrokerConfig();
      const running = await brokerAlreadyRunning(config);
      const open = await isPortOpen(config.host, config.port);
      checks.push({
        name: 'Broker running',
        ok: running,
        detail: running ? formatBrokerWsUrl(config.host, config.port) : 'Run cbctl start'
      });
      checks.push({ name: 'Broker port open', ok: open, detail: String(config.port) });
    } catch (error) {
      checks.push({ name: 'Broker config valid', ok: false, detail: (error as Error).message });
    }
  }

  let failures = 0;
  for (const item of checks) {
    if (!item.ok) failures += 1;
    console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed. Run cbctl setup and start, then reload/configure the extension.`);
    return 1;
  }

  console.log('\nInstall layout looks ready. Start the broker if needed, connect your MCP host, and run browser_status.');
  return 0;
}
