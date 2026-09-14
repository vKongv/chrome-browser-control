import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { getNetworkBodyLogPath, getUserConfigDir } from './paths.js';

export type NetworkBodyLogEntry = {
  origin: string;
  url: string;
  method: string;
  status: number | null;
  bytes: number;
  session?: string;
};

const REDACTED_QUERY_VALUE = '[redacted]';

function redactLoggedUrlQueryValues(urlInput: string): string {
  const raw = String(urlInput || '');
  const hashAt = raw.indexOf('#');
  const beforeHash = hashAt === -1 ? raw : raw.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : raw.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  if (queryAt === -1) return raw;
  const path = beforeHash.slice(0, queryAt);
  const query = beforeHash.slice(queryAt + 1);
  const redacted = query
    .split('&')
    .map((part) => {
      if (!part) return part;
      const eq = part.indexOf('=');
      if (eq === -1) return part;
      return `${part.slice(0, eq)}=${REDACTED_QUERY_VALUE}`;
    })
    .join('&');
  return `${path}?${redacted}${hash}`;
}

export function appendNetworkBodyRead(entry: NetworkBodyLogEntry): void {
  if (!entry?.url) throw new Error('network body log requires url');
  const record = {
    timestamp: new Date().toISOString(),
    origin: String(entry.origin || ''),
    url: redactLoggedUrlQueryValues(String(entry.url)),
    method: String(entry.method || ''),
    status: entry.status ?? null,
    bytes: Number(entry.bytes) || 0,
    session: entry.session ? String(entry.session) : ''
  };
  mkdirSync(getUserConfigDir(), { recursive: true, mode: 0o700 });
  const path = getNetworkBodyLogPath();
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function countNetworkBodyLogEntries(): number {
  const path = getNetworkBodyLogPath();
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim()).length;
}
