import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcpAutoloadOption } from '../cli/commands/mcp.js';
import { runSetup } from '../cli/commands/setup.js';
import { isAutoloadEnabled } from '../server/env.js';
import { getInstalledExtensionPath, getUserConfigPath } from '../server/paths.js';
import { buildNextAction } from '../server/status-coaching.js';

const originalHome = process.env.HOME;
const originalAutoload = process.env.CHROME_BROWSER_CONTROL_AUTOLOAD;
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
  if (originalAutoload === undefined) {
    delete process.env.CHROME_BROWSER_CONTROL_AUTOLOAD;
  } else {
    process.env.CHROME_BROWSER_CONTROL_AUTOLOAD = originalAutoload;
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

  it('does not print duplicate NPX fallback when command is already npx', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'cbc-cli-setup-'));
    process.env.HOME = tempHome;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    try {
      await runSetup({ positional: ['setup'], flags: {} });
      const fallbackLines = logs.filter((line) => line.includes('NPX fallback'));
      expect(fallbackLines).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
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

describe('cli mcp autoload wiring', () => {
  it('lets CHROME_BROWSER_CONTROL_AUTOLOAD=1 enable autoload without --autoload', () => {
    process.env.CHROME_BROWSER_CONTROL_AUTOLOAD = '1';
    const option = mcpAutoloadOption({});
    expect(option).toBeUndefined();
    expect(isAutoloadEnabled(option)).toBe(true);
  });

  it('does not override env when --autoload is absent', () => {
    process.env.CHROME_BROWSER_CONTROL_AUTOLOAD = '1';
    // Regression: previously main({ autoload: false }) forced env off.
    expect(isAutoloadEnabled(false)).toBe(false);
    expect(isAutoloadEnabled(mcpAutoloadOption({}))).toBe(true);
  });

  it('forces autoload on when --autoload is present', () => {
    delete process.env.CHROME_BROWSER_CONTROL_AUTOLOAD;
    expect(isAutoloadEnabled(mcpAutoloadOption({ autoload: true }))).toBe(true);
  });

  it('keeps autoload off without flag or env', () => {
    delete process.env.CHROME_BROWSER_CONTROL_AUTOLOAD;
    expect(isAutoloadEnabled(mcpAutoloadOption({}))).toBe(false);
  });
});
