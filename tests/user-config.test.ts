import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetEnvLoadForTests, resolveToken } from '../server/env.js';
import * as paths from '../server/paths.js';
import {
  getInstalledExtensionPath,
  getUserConfigDir,
  getUserConfigPath
} from '../server/paths.js';
import { writeEnvFile, DEFAULT_TOKEN_ENV, DEFAULT_PORT_ENV } from '../server/env-file.js';

const originalHome = process.env.HOME;
let tempDirs: string[] = [];
let packageRootSpy: ReturnType<typeof vi.spyOn> | undefined;

afterEach(() => {
  resetEnvLoadForTests();
  delete process.env.CHROME_BROWSER_CONTROL_TOKEN;
  delete process.env.CHROME_BROWSER_CONTROL_PORT;
  delete process.env.CHROME_BROWSER_CONTROL_DISABLE_LOCAL_ENV;
  packageRootSpy?.mockRestore();
  packageRootSpy = undefined;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  vi.unstubAllEnvs();
});

function withTempHome({ disableLocalEnv = true } = {}): string {
  const tempHome = mkdtempSync(join(tmpdir(), 'cbc-user-config-'));
  tempDirs.push(tempHome);
  process.env.HOME = tempHome;
  if (disableLocalEnv) {
    process.env.CHROME_BROWSER_CONTROL_DISABLE_LOCAL_ENV = '1';
  } else {
    delete process.env.CHROME_BROWSER_CONTROL_DISABLE_LOCAL_ENV;
  }
  return tempHome;
}

function withFakeRepoRoot(): string {
  const fakeRoot = mkdtempSync(join(tmpdir(), 'cbc-fake-repo-'));
  tempDirs.push(fakeRoot);
  writeFileSync(join(fakeRoot, 'package.json'), JSON.stringify({ name: 'chrome-browser-control' }));
  packageRootSpy = vi.spyOn(paths, 'getPackageRoot').mockReturnValue(fakeRoot);
  return fakeRoot;
}

describe('user config paths and env load order', () => {
  it('resolves user config under HOME/.chrome-browser-control', () => {
    const tempHome = withTempHome();
    expect(getUserConfigDir()).toBe(join(tempHome, '.chrome-browser-control'));
    expect(getUserConfigPath()).toBe(join(tempHome, '.chrome-browser-control', 'config.env'));
    expect(getInstalledExtensionPath()).toBe(join(tempHome, '.chrome-browser-control', 'extension'));
  });

  it('loads user config before repo .env.local when process env is unset', () => {
    withTempHome({ disableLocalEnv: false });
    mkdirSync(getUserConfigDir(), { recursive: true });
    writeEnvFile(getUserConfigPath(), {
      [DEFAULT_TOKEN_ENV]: 'user-config-token-123456789012345678901234567890',
      [DEFAULT_PORT_ENV]: '9001'
    });

    const fakeRoot = withFakeRepoRoot();
    writeFileSync(
      join(fakeRoot, '.env.local'),
      `${DEFAULT_TOKEN_ENV}=repo-local-token-123456789012345678901234567890\n${DEFAULT_PORT_ENV}=8765\n`,
      { mode: 0o600 }
    );

    resetEnvLoadForTests();
    delete process.env.CHROME_BROWSER_CONTROL_TOKEN;
    delete process.env.CHROME_BROWSER_CONTROL_PORT;
    expect(resolveToken().token).toBe('user-config-token-123456789012345678901234567890');
  });

  it('prefers process env over user config', () => {
    withTempHome();
    mkdirSync(getUserConfigDir(), { recursive: true });
    writeEnvFile(getUserConfigPath(), {
      [DEFAULT_TOKEN_ENV]: 'user-config-token-123456789012345678901234567890',
      [DEFAULT_PORT_ENV]: '9001'
    });
    process.env.CHROME_BROWSER_CONTROL_TOKEN = 'process-env-token-123456789012345678901234567890';
    resetEnvLoadForTests();
    expect(resolveToken().token).toBe('process-env-token-123456789012345678901234567890');
  });
});
