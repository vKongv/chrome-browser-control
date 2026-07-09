import { existsSync } from 'node:fs';
import { readBrokerConfig } from '../broker-process.js';
import { flagBoolean, type ParsedArgs } from '../parse-args.js';
import { getCompiledBrokerMainPath } from '../../server/paths.js';
import { assertSafeHost } from '../../server/env.js';

export async function runBroker(_args: ParsedArgs): Promise<number> {
  const config = readBrokerConfig();
  assertSafeHost(config.host);

  const brokerMain = getCompiledBrokerMainPath();
  if (!existsSync(brokerMain)) {
    console.error(`Compiled broker entry missing at ${brokerMain}. Run npm run build first.`);
    return 1;
  }

  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [brokerMain], {
    stdio: 'inherit',
    env: {
      ...process.env,
      CHROME_BROWSER_CONTROL_HOST: config.host,
      CHROME_BROWSER_CONTROL_PORT: String(config.port),
      CHROME_BROWSER_CONTROL_TOKEN: config.token
    }
  });

  return await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

/** Pass `true` only when `--autoload` is set; otherwise leave undefined so env can enable. */
export function mcpAutoloadOption(flags: ParsedArgs['flags']): boolean | undefined {
  return flagBoolean(flags, 'autoload') ? true : undefined;
}

export async function runMcp(args: ParsedArgs): Promise<number> {
  const autoload = mcpAutoloadOption(args.flags);
  if (autoload) {
    process.env.CHROME_BROWSER_CONTROL_AUTOLOAD = '1';
  }
  const { main } = await import('../../server/index.js');
  await main(autoload === undefined ? {} : { autoload });
  return 0;
}
