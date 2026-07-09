import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mcpAutoloadOption, runMcp } from '../cli/commands/mcp.js';
import { runSetup } from '../cli/commands/setup.js';
import { runStart } from '../cli/commands/start.js';
import * as brokerProcess from '../cli/broker-process.js';
import { isAutoloadEnabled } from '../server/env.js';
import { DEFAULT_PORT_ENV, DEFAULT_TOKEN_ENV, writeEnvFile } from '../server/env-file.js';
import * as mcpConfig from '../server/mcp-config.js';
import * as serverIndex from '../server/index.js';
import { getInstalledExtensionPath, getUserConfigDir, getUserConfigPath } from '../server/paths.js';
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

  it('preserves custom config.env keys when setup is re-run', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'cbc-cli-setup-'));
    process.env.HOME = tempHome;
    mkdirSync(getUserConfigDir(), { recursive: true });
    writeEnvFile(getUserConfigPath(), {
      [DEFAULT_TOKEN_ENV]: 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-',
      [DEFAULT_PORT_ENV]: '8765',
      CHROME_BROWSER_CONTROL_EXTENSION_ID: 'abcdefghijklmnopqrstuvwxyzabcdef',
      CHROME_BROWSER_CONTROL_CUSTOM: 'keep-me'
    });

    const code = await runSetup({ positional: ['setup'], flags: {} });
    expect(code).toBe(0);
    const config = readFileSync(getUserConfigPath(), 'utf8');
    expect(config).toContain('CHROME_BROWSER_CONTROL_EXTENSION_ID=abcdefghijklmnopqrstuvwxyzabcdef');
    expect(config).toContain('CHROME_BROWSER_CONTROL_CUSTOM=keep-me');
    expect(config).toContain('CHROME_BROWSER_CONTROL_TOKEN=abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-');
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
      command: '/usr/local/bin/cbctl',
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
    ).toContain('cbctl start');
  });
});

describe('cli mcp keep-alive', () => {
  it('does not resolve while server main is still serving', async () => {
    let settleMain!: () => void;
    const pendingMain = new Promise<void>((resolve) => {
      settleMain = resolve;
    });
    vi.spyOn(serverIndex, 'main').mockImplementation(() => pendingMain);

    const resultPromise = runMcp({ positional: ['mcp'], flags: {} });
    const raced = await Promise.race([
      resultPromise.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50))
    ]);
    expect(raced).toBe('pending');

    settleMain();
    await expect(resultPromise).resolves.toBe(0);
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

describe('cli start', () => {
  it('stops a previous CLI broker before spawning when the configured port is closed', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'cbc-cli-start-'));
    process.env.HOME = tempHome;
    mkdirSync(getUserConfigDir(), { recursive: true });
    writeEnvFile(getUserConfigPath(), {
      [DEFAULT_TOKEN_ENV]: 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-',
      [DEFAULT_PORT_ENV]: '8765'
    });

    const child = Object.assign(new EventEmitter(), { pid: 4242, unref: () => undefined });
    const stopSpy = vi.spyOn(brokerProcess, 'stopBrokerProcess').mockResolvedValue('stopped');
    vi.spyOn(brokerProcess, 'brokerAlreadyRunning').mockResolvedValue(false);
    vi.spyOn(brokerProcess, 'isPortOpen').mockResolvedValue(false);
    vi.spyOn(brokerProcess, 'startBrokerProcess').mockReturnValue(child as never);
    vi.spyOn(brokerProcess, 'waitForBrokerPort').mockResolvedValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const code = await runStart({ positional: ['start'], flags: {} });
    expect(code).toBe(0);
    expect(stopSpy).toHaveBeenCalledOnce();
  });

  it('refuses to spawn when the port is open but not a valid broker', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'cbc-cli-start-'));
    process.env.HOME = tempHome;
    mkdirSync(getUserConfigDir(), { recursive: true });
    writeEnvFile(getUserConfigPath(), {
      [DEFAULT_TOKEN_ENV]: 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-',
      [DEFAULT_PORT_ENV]: '8765'
    });

    vi.spyOn(brokerProcess, 'brokerAlreadyRunning').mockResolvedValue(false);
    vi.spyOn(brokerProcess, 'stopBrokerProcess').mockResolvedValue('not_running');
    vi.spyOn(brokerProcess, 'isPortOpen').mockResolvedValue(true);
    const startSpy = vi.spyOn(brokerProcess, 'startBrokerProcess');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const code = await runStart({ positional: ['start'], flags: {} });
    expect(code).toBe(1);
    expect(startSpy).not.toHaveBeenCalled();
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

  it('treats an open port without broker auth as not running', async () => {
    const { createServer } = await import('node:net');
    const { mkdirSync } = await import('node:fs');
    const brokerProcess = await import('../cli/broker-process.js');
    const lifecycle = await import('../server/broker-lifecycle.js');
    const paths = await import('../server/paths.js');

    tempHome = mkdtempSync(join(tmpdir(), 'cbc-cli-broker-'));
    process.env.HOME = tempHome;
    mkdirSync(paths.getUserConfigDir(), { recursive: true });

    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    const port = address.port;

    try {
      vi.spyOn(lifecycle, 'probeBrokerAuth').mockResolvedValue('not_broker');
      expect(await brokerProcess.brokerAlreadyRunning({ host: '127.0.0.1', port, token: 't' })).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    }
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
