import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSetup } from '../cli/commands/setup.js';
import { getInstalledExtensionPath, getUserConfigPath } from '../server/paths.js';
import { buildNextAction } from '../server/status-coaching.js';

const originalHome = process.env.HOME;
let tempHome = '';

afterEach(() => {
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = '';
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe('cli setup', () => {
  it('creates user config and copies extension to a stable path', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'cbc-cli-setup-'));
    process.env.HOME = tempHome;

    const code = await runSetup({ positional: ['setup'], flags: {} });
    expect(code).toBe(0);
    expect(existsSync(getUserConfigPath())).toBe(true);
    expect(existsSync(join(getInstalledExtensionPath(), 'manifest.json'))).toBe(true);

    const config = readFileSync(getUserConfigPath(), 'utf8');
    expect(config).toContain('CHROME_BROWSER_CONTROL_TOKEN=');
    expect(config.length).toBeGreaterThan(40);
  });

  it('coaches start via status strings', () => {
    expect(
      buildNextAction({
        ready: false,
        brokerReachable: false,
        adapterConnected: false,
        extensionConnected: false,
        brokerPort: 8765
      })
    ).toContain('chrome-browser-control start');
  });
});
