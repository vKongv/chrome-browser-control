import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mcpAutoloadOption, runMcp } from '../cli/commands/mcp.js';
import { runDoctor } from '../cli/commands/doctor.js';
import { runSetup } from '../cli/commands/setup.js';
import { runStatus } from '../cli/commands/status.js';
import { runStart } from '../cli/commands/start.js';
import { getExtensionCopyStatus } from '../cli/copy-extension.js';
import { flagBoolean, parseArgs } from '../cli/parse-args.js';
import * as brokerProcess from '../cli/broker-process.js';
import { isAutoloadEnabled } from '../server/env.js';
import { DEFAULT_PORT_ENV, DEFAULT_TOKEN_ENV, writeEnvFile } from '../server/env-file.js';
import * as mcpConfig from '../server/mcp-config.js';
import * as serverIndex from '../server/index.js';
import {
  getInstalledExtensionPath,
  getInstalledVersionPath,
  getPackageRoot,
  getPackagedExtensionPath,
  getUserConfigDir,
  getUserConfigPath,
  readPackageVersion
} from '../server/paths.js';
import { buildNextAction } from '../server/status-coaching.js';

const originalHome = process.env.HOME;
const originalAutoload = process.env.CHROME_BROWSER_CONTROL_AUTOLOAD;
let tempHome = '';

function useTempHome(prefix: string): void {
  tempHome = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = tempHome;
}

function installPackagedExtension(): void {
  cpSync(getPackagedExtensionPath(), getInstalledExtensionPath(), { recursive: true });
}

function captureConsole(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  return { logs, errors };
}

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

describe('cli version identity', () => {
  it('parseArgs treats --version and -V as version flags', () => {
    expect(flagBoolean(parseArgs(['--version']).flags, 'version')).toBe(true);
    expect(flagBoolean(parseArgs(['-V']).flags, 'version')).toBe(true);
    expect(parseArgs(['--version']).positional).toEqual([]);
    expect(parseArgs(['-V', 'doctor']).positional).toEqual(['doctor']);
  });

  it('readPackageVersion returns package.json semver', () => {
    const expected = JSON.parse(readFileSync(join(getPackageRoot(), 'package.json'), 'utf8')).version as string;
    expect(readPackageVersion()).toBe(expected);
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('doctor reports CLI version and package root without failing those checks', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'cbc-cli-doctor-'));
    process.env.HOME = tempHome;
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runDoctor({ positional: ['doctor'], flags: {} });
    const version = readPackageVersion();
    const root = getPackageRoot();
    expect(logs.some((line) => line.includes('CLI version') && line.includes(version))).toBe(true);
    expect(logs.some((line) => line.includes('Package root') && line.includes(root))).toBe(true);
    expect(logs.find((line) => line.includes('CLI version'))).toMatch(/^✅/);
    expect(logs.find((line) => line.includes('Package root'))).toMatch(/^✅/);
  });
});

describe('cli extension copy diagnostics', () => {
  it('T1: reports an absent installed copy as missing', async () => {
    useTempHome('cbc-cli-extension-absent-');
    const { logs } = captureConsole();

    expect(getExtensionCopyStatus()).toEqual({ state: 'absent', differingFiles: [] });
    const statusCode = await runStatus({ positional: ['status'], flags: {} });
    const doctorCode = await runDoctor({ positional: ['doctor'], flags: {} });

    expect(statusCode).toBe(0);
    expect(doctorCode).toBe(1);
    expect(logs).toContain('❌ Extension copy missing — run cbctl setup');
    expect(logs).toContain('❌ Extension copy — missing — run cbctl setup');
  });

  it('T2: reports a matching copy as current in both commands', async () => {
    useTempHome('cbc-cli-extension-current-');
    installPackagedExtension();
    const { logs } = captureConsole();

    expect(getExtensionCopyStatus()).toEqual({ state: 'current', differingFiles: [] });
    await runStatus({ positional: ['status'], flags: {} });
    await runDoctor({ positional: ['doctor'], flags: {} });

    expect(logs).toContain('✅ Extension copy present');
    expect(logs).toContain('✅ Extension copy — current');
  });

  it('T3: makes doctor fail and prints the stale remedy for changed content', async () => {
    useTempHome('cbc-cli-extension-stale-');
    installPackagedExtension();
    const manifestPath = join(getInstalledExtensionPath(), 'manifest.json');
    const { logs, errors } = captureConsole();

    const currentCode = await runDoctor({ positional: ['doctor'], flags: {} });
    const currentFailureCount = Number(errors.at(-1)?.match(/(\d+) check/)?.[1]);
    writeFileSync(manifestPath, `${readFileSync(manifestPath, 'utf8')}\nT3 mutation\n`);

    const staleCode = await runDoctor({ positional: ['doctor'], flags: {} });
    const extensionLine = logs.filter((line) => line.includes('Extension copy')).at(-1);
    const staleFailureCount = Number(errors.at(-1)?.match(/(\d+) check/)?.[1]);

    expect(currentCode).toBe(1);
    expect(staleCode).toBe(1);
    expect(staleFailureCount).toBe(currentFailureCount + 1);
    expect(extensionLine).toMatch(/^❌/);
    expect(extensionLine).toContain('stale');
    expect(extensionLine).toContain('manifest.json');
    expect(extensionLine).toContain('cbctl setup');
    expect(extensionLine).toContain('reload the unpacked extension');
  });

  it('T4: reports stale content even when the installed version matches', () => {
    useTempHome('cbc-cli-extension-version-match-');
    installPackagedExtension();
    writeFileSync(getInstalledVersionPath(), `${readPackageVersion()}\n`);
    const cdpPath = join(getInstalledExtensionPath(), 'cdp.js');
    writeFileSync(cdpPath, `${readFileSync(cdpPath, 'utf8')}\nT4 mutation\n`);

    const status = getExtensionCopyStatus();

    expect(status.state).toBe('stale');
    expect(status.differingFiles).toContain('cdp.js');
  });

  it('T5: reports a packaged file missing from the installed copy as stale', () => {
    useTempHome('cbc-cli-extension-missing-file-');
    installPackagedExtension();
    rmSync(join(getInstalledExtensionPath(), 'cdp.js'));

    const status = getExtensionCopyStatus();

    expect(status.state).toBe('stale');
    expect(status.differingFiles).toContain('cdp.js');
  });

  it('T6: does not print a green status tick for a stale copy', async () => {
    useTempHome('cbc-cli-extension-status-stale-');
    installPackagedExtension();
    const popupPath = join(getInstalledExtensionPath(), 'popup.js');
    writeFileSync(popupPath, `${readFileSync(popupPath, 'utf8')}\nT6 mutation\n`);
    const { logs } = captureConsole();

    await runStatus({ positional: ['status'], flags: {} });
    const extensionLine = logs.find((line) => line.includes('Extension copy'));

    expect(extensionLine).toMatch(/^❌/);
    expect(extensionLine).toContain('stale');
    expect(extensionLine).not.toMatch(/^✅/);
  });

  it('T7: surfaces every differing file name', async () => {
    useTempHome('cbc-cli-extension-differences-');
    installPackagedExtension();
    const backgroundPath = join(getInstalledExtensionPath(), 'background.js');
    const extraPath = join(getInstalledExtensionPath(), 'extra.js');
    writeFileSync(backgroundPath, `${readFileSync(backgroundPath, 'utf8')}\nT7 mutation\n`);
    rmSync(join(getInstalledExtensionPath(), 'cdp.js'));
    writeFileSync(extraPath, 'T7 extra file\n');
    const { logs } = captureConsole();

    await runStatus({ positional: ['status'], flags: {} });
    const extensionLine = logs.find((line) => line.includes('Extension copy'));

    expect(extensionLine).toContain('background.js');
    expect(extensionLine).toContain('cdp.js');
    expect(extensionLine).toContain('extra.js');
    expect(extensionLine).toContain('3 differing file(s)');
  });

  it('R8: diagnoses an unreadable installed file without aborting doctor', async () => {
    useTempHome('cbc-cli-extension-unreadable-');
    installPackagedExtension();
    const cdpPath = join(getInstalledExtensionPath(), 'cdp.js');
    chmodSync(cdpPath, 0o000);

    try {
      const { logs } = captureConsole();
      const status = getExtensionCopyStatus();
      const statusCode = await runStatus({ positional: ['status'], flags: {} });
      const doctorCode = await runDoctor({ positional: ['doctor'], flags: {} });
      const extensionLines = logs.filter((line) => line.includes('Extension copy'));

      expect(status.state).toBe('stale');
      expect(status.differingFiles).toContain('cdp.js');
      expect(status.inspectionProblems?.some((problem) => problem.includes('cdp.js') && problem.includes('EACCES'))).toBe(true);
      expect(statusCode).toBe(0);
      expect(doctorCode).toBe(1);
      expect(extensionLines[0]).toContain('cdp.js');
      expect(extensionLines[0]).toContain('EACCES');
      expect(extensionLines[0]).toContain('cbctl setup');
      expect(extensionLines[1]).toContain('cdp.js');
      expect(extensionLines[1]).toContain('EACCES');
      expect(extensionLines[1]).toContain('cbctl setup');
      expect(logs.some((line) => line.includes('CLI version'))).toBe(true);
      expect(logs.some((line) => line.includes('Compiled broker entry'))).toBe(true);
      expect(logs.some((line) => line.includes('User config'))).toBe(true);
      expect(logs.some((line) => line.includes('Pairing token configured'))).toBe(true);
    } finally {
      chmodSync(cdpPath, 0o644);
    }
  });

  it('R8: diagnoses an installed directory symlink as stale without following it', async () => {
    useTempHome('cbc-cli-extension-directory-symlink-');
    installPackagedExtension();
    const symlinkTarget = join(tempHome, 'directory-target');
    mkdirSync(symlinkTarget);
    writeFileSync(join(symlinkTarget, 'marker.txt'), 'R8 directory symlink\n');
    symlinkSync(symlinkTarget, join(getInstalledExtensionPath(), 'directory-link'), 'dir');
    const { logs } = captureConsole();

    const status = getExtensionCopyStatus();
    const statusCode = await runStatus({ positional: ['status'], flags: {} });
    const doctorCode = await runDoctor({ positional: ['doctor'], flags: {} });
    const extensionLines = logs.filter((line) => line.includes('Extension copy'));

    expect(status.state).toBe('stale');
    expect(status.differingFiles).toContain('directory-link');
    expect(status.inspectionProblems?.some((problem) => problem.includes('directory-link'))).toBe(true);
    expect(statusCode).toBe(0);
    expect(doctorCode).toBe(1);
    expect(extensionLines[0]).toContain('directory-link');
    expect(extensionLines[0]).toContain('cbctl setup');
    expect(extensionLines[1]).toContain('directory-link');
    expect(extensionLines[1]).toContain('cbctl setup');
  });

  it('R8: diagnoses a broken installed symlink as stale without throwing', async () => {
    useTempHome('cbc-cli-extension-broken-symlink-');
    installPackagedExtension();
    symlinkSync(join(tempHome, 'missing-target'), join(getInstalledExtensionPath(), 'broken-link'));
    const { logs } = captureConsole();

    const status = getExtensionCopyStatus();
    const statusCode = await runStatus({ positional: ['status'], flags: {} });
    const doctorCode = await runDoctor({ positional: ['doctor'], flags: {} });
    const extensionLines = logs.filter((line) => line.includes('Extension copy'));

    expect(status.state).toBe('stale');
    expect(status.differingFiles).toContain('broken-link');
    expect(status.inspectionProblems?.some((problem) => problem.includes('broken-link'))).toBe(true);
    expect(statusCode).toBe(0);
    expect(doctorCode).toBe(1);
    expect(extensionLines[0]).toContain('broken-link');
    expect(extensionLines[0]).toContain('cbctl setup');
    expect(extensionLines[1]).toContain('broken-link');
    expect(extensionLines[1]).toContain('cbctl setup');
  });
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

  it('waitForBrokerPort succeeds once the port accepts connections and auth probes ok', async () => {
    const { createServer } = await import('node:net');
    const brokerProcess = await import('../cli/broker-process.js');
    const lifecycle = await import('../server/broker-lifecycle.js');

    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    const port = address.port;

    try {
      vi.spyOn(lifecycle, 'probeBrokerAuth').mockResolvedValue('ok');
      expect(await brokerProcess.waitForBrokerPort({ host: '127.0.0.1', port, token: 't' }, 2_000)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('waitForBrokerPort keeps waiting when the port is open but auth is not ok', async () => {
    const { createServer } = await import('node:net');
    const brokerProcess = await import('../cli/broker-process.js');
    const lifecycle = await import('../server/broker-lifecycle.js');

    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    const port = address.port;

    try {
      vi.spyOn(lifecycle, 'probeBrokerAuth').mockResolvedValue('not_broker');
      expect(await brokerProcess.waitForBrokerPort({ host: '127.0.0.1', port, token: 't' }, 400)).toBe(false);
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
