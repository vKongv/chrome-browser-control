import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const MIN_TOKEN_UNIQUE_CHARS = 8;
let localEnvLoaded = false;

function loadLocalEnvIfPresent(): void {
  if (localEnvLoaded) return;
  localEnvLoaded = true;
  if (/^(1|true|yes|on)$/i.test(process.env.HERMES_CHROME_DISABLE_LOCAL_ENV || '')) return;
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const localEnvPath = join(repoRoot, '.env.local');
  if (!existsSync(localEnvPath)) return;
  for (const line of readFileSync(localEnvPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
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

export function getToken(): string {
  loadLocalEnvIfPresent();
  const token = process.env.HERMES_CHROME_TOKEN?.trim();
  if (!token) {
    throw new Error('HERMES_CHROME_TOKEN is required. Generate a high-entropy token and set it for both broker and MCP adapter.');
  }
  const insecureDefaultToken = ['dev', 'token', 'change', 'me'].join('-');
  if (token === insecureDefaultToken) {
    throw new Error('Refusing insecure default HERMES_CHROME_TOKEN. Generate a unique high-entropy token.');
  }
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error('HERMES_CHROME_TOKEN must be at least 32 URL-safe random characters.');
  }
  if (isTriviallyWeakToken(token)) {
    throw new Error('HERMES_CHROME_TOKEN must contain enough character variety.');
  }
  return token;
}

export function getBrokerHost(): string {
  loadLocalEnvIfPresent();
  return process.env.HERMES_CHROME_HOST ?? '127.0.0.1';
}

export function getBrokerPort(): number {
  return envNumber('HERMES_CHROME_PORT', 8765);
}

export function getBrokerUrl(): string {
  const host = getBrokerHost();
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `ws://${formattedHost}:${getBrokerPort()}`;
}
