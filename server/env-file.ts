import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';

export const DEFAULT_TOKEN_ENV = 'CHROME_BROWSER_CONTROL_TOKEN';
export const DEFAULT_PORT_ENV = 'CHROME_BROWSER_CONTROL_PORT';
export const DEFAULT_HOST_ENV = 'CHROME_BROWSER_CONTROL_HOST';
export const DEFAULT_PORT = '8765';

export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseEnvFile(readFileSync(path, 'utf8'));
}

export function writeEnvFile(
  path: string,
  entries: Record<string, string>,
  { header = '# Chrome Browser Control user config.' } = {}
): void {
  const lines = [
    header,
    ...Object.entries(entries).map(([key, value]) => `${key}=${value}`),
    ''
  ];
  writeFileSync(path, lines.join('\n'), { mode: 0o600 });
  chmodSync(path, 0o600);
}
