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

export function appendNetworkBodyRead(entry: NetworkBodyLogEntry): void {
  if (!entry?.url) throw new Error('network body log requires url');
  const record = {
    timestamp: new Date().toISOString(),
    origin: String(entry.origin || ''),
    url: String(entry.url),
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
