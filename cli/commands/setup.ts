import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyExtensionToUserDir } from '../copy-extension.js';
import { flagBoolean, type ParsedArgs } from '../parse-args.js';
import {
  DEFAULT_HOST_ENV,
  DEFAULT_PORT,
  DEFAULT_PORT_ENV,
  DEFAULT_TOKEN_ENV,
  generateToken,
  readEnvFile,
  writeEnvFile
} from '../../server/env-file.js';
import { renderConfig, resolveCliCommand } from '../../server/mcp-config.js';
import { getInstalledExtensionPath, getPackageRoot, getUserConfigDir, getUserConfigPath } from '../../server/paths.js';

function packageVersion(): string {
  const packageJson = join(getPackageRoot(), 'package.json');
  return JSON.parse(readFileSync(packageJson, 'utf8')).version as string;
}

export async function runSetup(args: ParsedArgs): Promise<number> {
  const forceToken = flagBoolean(args.flags, 'force-token');
  const startAfter = flagBoolean(args.flags, 'start');

  mkdirSync(getUserConfigDir(), { recursive: true });
  const configPath = getUserConfigPath();
  const existing = readEnvFile(configPath);
  const token = forceToken || !existing[DEFAULT_TOKEN_ENV] ? generateToken() : existing[DEFAULT_TOKEN_ENV];
  const port = existing[DEFAULT_PORT_ENV] || DEFAULT_PORT;

  // Preserve unknown keys (e.g. CHROME_BROWSER_CONTROL_EXTENSION_ID) across setup refreshes.
  writeEnvFile(configPath, {
    ...existing,
    [DEFAULT_TOKEN_ENV]: token,
    [DEFAULT_PORT_ENV]: port,
    ...(existing[DEFAULT_HOST_ENV] ? { [DEFAULT_HOST_ENV]: existing[DEFAULT_HOST_ENV] } : {})
  });

  const extension = copyExtensionToUserDir(packageVersion());
  const cli = resolveCliCommand();

  console.log('Chrome Browser Control setup');
  console.log('============================');
  console.log(`User config: ${configPath}`);
  console.log(`Extension path: ${extension.path}${extension.refreshed ? ' (copied/refreshed)' : ''}`);
  if (extension.previousVersion && extension.previousVersion !== extension.version) {
    console.log(`Extension updated from ${extension.previousVersion} to ${extension.version}. Reload it in chrome://extensions.`);
  }
  console.log('');
  console.log('1. Load/reload the Chrome extension from the extension path above.');
  console.log('2. Open the extension popup and paste this pairing token:');
  console.log(`   ${token}`);
  console.log('3. Add allowed origins, for example: https://example.com or * for all http/https web pages.');
  console.log('4. Start the shared broker: cbctl start');
  console.log('5. Add one of these MCP config snippets to your agent.');
  console.log('');
  console.log('YAML config:');
  console.log(renderConfig('yaml', { command: cli.command, args: cli.args, token, port }));
  console.log('');
  console.log('Claude / Cursor JSON config:');
  console.log(renderConfig('json', { command: cli.command, args: cli.args, token, port }));
  console.log('');
  console.log('Codex TOML config:');
  console.log(renderConfig('codex', { command: cli.command, args: cli.args, token, port }));
  if (cli.command !== 'npx') {
    console.log('');
    console.log('NPX fallback (slower cold start):');
    console.log(renderConfig('json', { command: 'npx', args: ['-y', 'chrome-browser-control', 'mcp'], token, port }));
  }
  console.log('');
  console.log('Then run: cbctl doctor');

  if (startAfter) {
    const { runStart } = await import('./start.js');
    console.log('');
    return await runStart({ positional: ['start'], flags: {} });
  }

  return 0;
}

export function setupLooksComplete(): boolean {
  return existsSync(getUserConfigPath()) && existsSync(join(getInstalledExtensionPath(), 'manifest.json'));
}
