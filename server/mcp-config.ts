import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_MCP_KEY = 'chrome_browser_control';
export const DEFAULT_TOKEN_ENV = 'CHROME_BROWSER_CONTROL_TOKEN';
export const DEFAULT_PORT_ENV = 'CHROME_BROWSER_CONTROL_PORT';

export type McpHostFormat = 'json' | 'yaml' | 'codex' | 'cursor' | 'claude';

export interface McpServerObject {
  command: string;
  args: string[];
  env: Record<string, string>;
  timeout: number;
  connect_timeout: number;
}

export interface RenderConfigOptions {
  command?: string;
  args?: string[];
  token?: string;
  port?: string;
}

export function resolveCliCommand(): { command: string; args: string[]; npxFallback: { command: string; args: string[] } } {
  const binName = process.platform === 'win32' ? 'chrome-browser-control.cmd' : 'chrome-browser-control';
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const pathEntries = (process.env[pathKey] ?? '').split(process.platform === 'win32' ? ';' : ':');
  const globalBin = pathEntries.map((entry) => join(entry, binName)).find((candidate) => existsSync(candidate));

  const command = globalBin ?? 'npx';
  const args = globalBin ? ['mcp'] : ['-y', 'chrome-browser-control', 'mcp'];

  return {
    command,
    args,
    npxFallback: { command: 'npx', args: ['-y', 'chrome-browser-control', 'mcp'] }
  };
}

export function mcpServerObject(options: RenderConfigOptions = {}): McpServerObject {
  const resolved = options.command ? null : resolveCliCommand();
  const command = options.command ?? resolved!.command;
  const args = options.args ?? resolved!.args;
  const token = options.token ?? '<generated-token>';
  const port = options.port ?? '8765';

  return {
    command,
    args,
    env: {
      [DEFAULT_TOKEN_ENV]: token,
      [DEFAULT_PORT_ENV]: String(port)
    },
    timeout: 60,
    connect_timeout: 30
  };
}

export function renderJsonConfig(options: RenderConfigOptions = {}): string {
  return JSON.stringify({ mcpServers: { [DEFAULT_MCP_KEY]: mcpServerObject(options) } }, null, 2);
}

export function renderYamlConfig(options: RenderConfigOptions = {}): string {
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

export function renderCodexConfig(options: RenderConfigOptions = {}): string {
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

export function renderConfig(
  host: string,
  options: RenderConfigOptions = {}
): string {
  const normalized = String(host || 'json').toLowerCase();
  if (normalized === 'yaml') return renderYamlConfig(options);
  if (normalized === 'codex') return renderCodexConfig(options);
  if (['claude', 'claude-code', 'claude-desktop', 'cursor', 'json'].includes(normalized)) {
    return renderJsonConfig(options);
  }
  throw new Error(`Unsupported host: ${host}. Use yaml, claude, codex, cursor, or json.`);
}
