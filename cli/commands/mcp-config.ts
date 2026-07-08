import { existsSync } from 'node:fs';
import { readEnvFile } from '../../server/env-file.js';
import { renderConfig } from '../../server/mcp-config.js';
import { getUserConfigPath } from '../../server/paths.js';
import type { ParsedArgs } from '../parse-args.js';

export async function runMcpConfig(args: ParsedArgs): Promise<number> {
  const host = String(args.flags.host ?? 'json');
  const configPath = getUserConfigPath();
  if (!existsSync(configPath)) {
    console.error('Missing user config. Run chrome-browser-control setup first.');
    return 1;
  }
  const env = readEnvFile(configPath);
  const token = env.CHROME_BROWSER_CONTROL_TOKEN ?? '<generated-token>';
  const port = env.CHROME_BROWSER_CONTROL_PORT ?? '8765';
  console.log(renderConfig(host, { token, port }));
  return 0;
}
