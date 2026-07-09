import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcpAutoloadOption } from '../cli/commands/mcp.js';
import { runSetup } from '../cli/commands/setup.js';
import { isAutoloadEnabled } from '../server/env.js';
import * as mcpConfig from '../server/mcp-config.js';
import { getInstalledExtensionPath, getUserConfigPath } from '../server/paths.js';
import { buildNextAction } from '../server/status-coaching.js';

const originalHome = process.env.HOME;
const originalAutoload = process.env.CHROME_BROWSER_CONTROL_AUTOLOAD;
let tempHome = '';

afterEach(() => {
  vi.restoreAllMocks();
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

  it('does not print NPX fallback when resolveCliCommand already returns npx', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'cbc-cli-setup-'));
    process.env.HOME = tempHome;
    vi.spyOn(mcpConfig, 'resolveCliCommand').mockReturnValue({
      command: 'npx',
      args: ['-y', 'chrome-browser-control', 'mcp'],
      npxFallback: { command: 'npx', args: ['-y', 'chrome-browser-control', 'mcp'] }
    });
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    await runSetup({ positional: ['setup'], flags: {} });
    expect(logs.filter((line) => line.includes('NPX fallback'))).toHaveLength(0);
  });

  it('prints NPX fallback once when resolveCliCommand returns a global bin', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'cbc-cli-setup-'));
    process.env.HOME = tempHome;
    vi.spyOn(mcpConfig, 'resolveCliCommand').mockReturnValue({
      command: '/usr/local/bin/chrome-browser-control',
      args: ['mcp'],
      npxFallback: { command: 'npx', args: ['-y', 'chrome-browser-control', 'mcp'] }
    });
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    await runSetup({ positional: ['setup'], flags: {} });
    expect(logs.filter((line) => line.includes('NPX fallback'))).toHaveLength(1);
    expect(logs.some((line) => line.includes('"command": "npx"'))).toBe(true);
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

describe('cli broker process helpers', () => {
  it('treats a live PID without an open port as not running', async () => {
    const { createServer } = await import('node:net');
    const { mkdirSync } = await import('node:fs');
    const brokerProcess = await import('../cli/broker-process.js');
    const paths = await import('../server/paths.js');

    tempHome = mkdtempSync(join(tmpdir(), 'cbc-cli-broker-'));
    process.env.HOME = tempHome;
    mkdirSync(paths.getUserConfigDir(), { recursive: true });

    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    const port = address.port;
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));

    writeFileSync(paths.getBrokerPidPath(), `${process.pid}\n`);
    expect(await brokerProcess.brokerAlreadyRunning({ host: '127.0.0.1', port, token: 't' })).toBe(false);
  });

  it('waitForBrokerPort succeeds once the port accepts connections', async () => {
    const { createServer } = await import('node:net');
    const brokerProcess = await import('../cli/broker-process.js');

    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    const port = address.port;

    try {
      expect(await brokerProcess.waitForBrokerPort({ host: '127.0.0.1', port, token: 't' }, 2_000)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('waitForBrokerPort times out when the port never opens', async () => {
    const { createServer } = await import('node:net');
    const brokerProcess = await import('../cli/broker-process.js');

    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    const port = address.port;
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));

    expect(await brokerProcess.waitForBrokerPort({ host: '127.0.0.1', port, token: 't' }, 300)).toBe(false);
  });
});
