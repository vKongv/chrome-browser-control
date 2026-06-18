import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, '..');

export const DEFAULT_TOKEN_ENV = 'CHROME_BROWSER_CONTROL_TOKEN';
export const DEFAULT_PORT_ENV = 'CHROME_BROWSER_CONTROL_PORT';
export const DEFAULT_MCP_KEY = 'chrome_browser_control';
export const DEFAULT_PORT = '8765';
export const LOCAL_ENV_FILE = '.env.local';

export function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function readLocalEnv(root = repoRoot) {
  const path = join(root, LOCAL_ENV_FILE);
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}

export function ensureLocalEnv({ root = repoRoot, token = generateToken(), port = DEFAULT_PORT, force = false } = {}) {
  const path = join(root, LOCAL_ENV_FILE);
  const existed = existsSync(path);
  const existing = readLocalEnv(root);
  const nextToken = force || !existing[DEFAULT_TOKEN_ENV] ? token : existing[DEFAULT_TOKEN_ENV];
  const nextPort = existing[DEFAULT_PORT_ENV] || port;
  const content = [
    '# Local Chrome Browser Control setup. Do not commit this file.',
    `${DEFAULT_TOKEN_ENV}=${nextToken}`,
    `${DEFAULT_PORT_ENV}=${nextPort}`,
    ''
  ].join('\n');
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, token: nextToken, port: nextPort, created: !existed || force };
}

export function nodeBin(root = repoRoot) {
  return join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
}

export function serverEntry(root = repoRoot) {
  return join(root, 'server', 'index.ts');
}

export function extensionPath(root = repoRoot) {
  return join(root, 'extension');
}

export function mcpServerObject({ root = repoRoot, token = '<generated-token>', port = DEFAULT_PORT } = {}) {
  return {
    command: nodeBin(root),
    args: [serverEntry(root)],
    env: {
      [DEFAULT_TOKEN_ENV]: token,
      [DEFAULT_PORT_ENV]: String(port)
    },
    timeout: 60,
    connect_timeout: 30
  };
}

export function renderJsonConfig(options = {}) {
  return JSON.stringify({ mcpServers: { [DEFAULT_MCP_KEY]: mcpServerObject(options) } }, null, 2);
}

export function renderYamlConfig(options = {}) {
  const cfg = mcpServerObject(options);
  return [
    'mcp_servers:',
    `  ${DEFAULT_MCP_KEY}:`,
    `    command: ${JSON.stringify(cfg.command)}`,
    `    args: [${cfg.args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
    '    env:',
    `      ${DEFAULT_TOKEN_ENV}: ${JSON.stringify(cfg.env[DEFAULT_TOKEN_ENV])}`,
    `      ${DEFAULT_PORT_ENV}: ${JSON.stringify(cfg.env[DEFAULT_PORT_ENV])}`,
    `    timeout: ${cfg.timeout}`,
    `    connect_timeout: ${cfg.connect_timeout}`
  ].join('\n');
}

export function renderCodexConfig(options = {}) {
  const cfg = mcpServerObject(options);
  return [
    `[mcp_servers.${DEFAULT_MCP_KEY}]`,
    `command = ${JSON.stringify(cfg.command)}`,
    `args = [${cfg.args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
    `env = { ${DEFAULT_TOKEN_ENV} = ${JSON.stringify(cfg.env[DEFAULT_TOKEN_ENV])}, ${DEFAULT_PORT_ENV} = ${JSON.stringify(cfg.env[DEFAULT_PORT_ENV])} }`,
    `startup_timeout_sec = ${cfg.connect_timeout}`,
    `tool_timeout_sec = ${cfg.timeout}`
  ].join('\n');
}

export function renderConfig({ host = 'json', root = repoRoot, token = '<generated-token>', port = DEFAULT_PORT } = {}) {
  const normalized = String(host || 'json').toLowerCase();
  if (normalized === 'yaml') return renderYamlConfig({ root, token, port });
  if (normalized === 'codex') return renderCodexConfig({ root, token, port });
  if (['claude', 'claude-code', 'claude-desktop', 'cursor', 'json'].includes(normalized)) {
    return renderJsonConfig({ root, token, port });
  }
  throw new Error(`Unsupported host: ${host}. Use yaml, claude, codex, cursor, or json.`);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}
