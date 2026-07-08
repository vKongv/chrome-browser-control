import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readEnvFile } from './env-file.js';
import { getPackageRoot, getUserConfigPath } from './paths.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const MIN_TOKEN_UNIQUE_CHARS = 8;
let localEnvLoaded = false;

function applyEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(readEnvFile(path))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function loadLocalEnvIfPresent(): void {
  if (localEnvLoaded) return;
  localEnvLoaded = true;

  applyEnvFile(getUserConfigPath());

  if (/^(1|true|yes|on)$/i.test(process.env.CHROME_BROWSER_CONTROL_DISABLE_LOCAL_ENV || '')) return;
  applyEnvFile(join(getPackageRoot(), '.env.local'));
}

export function resetEnvLoadForTests(): void {
  localEnvLoaded = false;
}

export function envNumber(name: string, fallback: number): number {
  loadLocalEnvIfPresent();
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

export function envBoolean(name: string, fallback = false): boolean {
  loadLocalEnvIfPresent();
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export function assertSafeHost(host: string): void {
  const loopback = new Set(['127.0.0.1', 'localhost', '::1']);
  if (loopback.has(host)) return;
  throw new Error(
    `Refusing to bind Chrome bridge to non-loopback host ${host}. Chrome Browser Control only supports loopback hosts.`
  );
}

function isTriviallyWeakToken(token: string): boolean {
  return new Set(token).size < MIN_TOKEN_UNIQUE_CHARS;
}

export type TokenIssue = 'missing' | 'invalid';

export interface ResolvedToken {
  token?: string;
  issue?: TokenIssue;
}

function tokenValidationError(token: string): string | undefined {
  const insecureDefaultToken = ['dev', 'token', 'change', 'me'].join('-');
  if (token === insecureDefaultToken) {
    return 'Refusing insecure default CHROME_BROWSER_CONTROL_TOKEN. Generate a unique high-entropy token.';
  }
  if (!TOKEN_PATTERN.test(token)) {
    return 'CHROME_BROWSER_CONTROL_TOKEN must be at least 32 URL-safe random characters.';
  }
  if (isTriviallyWeakToken(token)) {
    return 'CHROME_BROWSER_CONTROL_TOKEN must contain enough character variety.';
  }
  return undefined;
}

export function resolveToken(): ResolvedToken {
  loadLocalEnvIfPresent();
  const token = process.env.CHROME_BROWSER_CONTROL_TOKEN?.trim();
  if (!token) {
    return { issue: 'missing' };
  }
  if (tokenValidationError(token)) {
    return { issue: 'invalid' };
  }
  return { token };
}

export function getToken(): string {
  const resolved = resolveToken();
  if (resolved.issue === 'missing') {
    throw new Error('CHROME_BROWSER_CONTROL_TOKEN is required. Generate a high-entropy token and set it for both broker and MCP adapter.');
  }
  if (resolved.issue === 'invalid') {
    throw new Error(tokenValidationError(process.env.CHROME_BROWSER_CONTROL_TOKEN!.trim())!);
  }
  return resolved.token!;
}

export function getBrokerHost(): string {
  loadLocalEnvIfPresent();
  return process.env.CHROME_BROWSER_CONTROL_HOST ?? '127.0.0.1';
}

export function getBrokerPort(): number {
  return envNumber('CHROME_BROWSER_CONTROL_PORT', 8765);
}

export function getBrokerUrl(): string {
  const host = getBrokerHost();
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `ws://${formattedHost}:${getBrokerPort()}`;
}

export function isAutoloadEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return envBoolean('CHROME_BROWSER_CONTROL_AUTOLOAD', false);
}
