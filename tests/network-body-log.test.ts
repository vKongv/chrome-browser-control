import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendNetworkBodyRead, countNetworkBodyLogEntries } from '../server/network-body-log.js';
import { getNetworkBodyLogPath } from '../server/paths.js';

const originalHome = process.env.HOME;
let tempHome = '';

afterEach(() => {
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = '';
  }
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function useTempHome(): void {
  tempHome = mkdtempSync(join(tmpdir(), 'cbc-body-log-'));
  process.env.HOME = tempHome;
}

describe('network body metadata log', () => {
  it('appends metadata only, never bodies or hashes, at mode 0600', () => {
    useTempHome();
    appendNetworkBodyRead({
      origin: 'https://graph.facebook.com',
      url: 'https://graph.facebook.com/v19.0/me',
      method: 'GET',
      status: 200,
      bytes: 32,
      session: 'owner-1'
    });
    appendNetworkBodyRead({
      origin: 'https://graph.facebook.com',
      url: 'https://graph.facebook.com/v19.0/act',
      method: 'POST',
      status: 201,
      bytes: 8,
      session: 'owner-1'
    });

    const path = getNetworkBodyLogPath();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim());
    expect(lines).toHaveLength(2);
    expect(countNetworkBodyLogEntries()).toBe(2);

    const first = JSON.parse(lines[0]);
    expect(Object.keys(first).sort()).toEqual([
      'bytes',
      'method',
      'origin',
      'session',
      'status',
      'timestamp',
      'url'
    ]);
    expect(first).toMatchObject({
      origin: 'https://graph.facebook.com',
      url: 'https://graph.facebook.com/v19.0/me',
      method: 'GET',
      status: 200,
      bytes: 32,
      session: 'owner-1'
    });
    expect(readFileSync(path, 'utf8')).not.toMatch(/bodyHash|"body"/);
  });

  it('counts zero when the log file is absent', () => {
    useTempHome();
    expect(countNetworkBodyLogEntries()).toBe(0);
  });
});
