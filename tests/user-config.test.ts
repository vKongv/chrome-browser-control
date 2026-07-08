import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetEnvLoadForTests, resolveToken } from '../server/env.js';
import {
  getInstalledExtensionPath,
  getUserConfigDir,
  getUserConfigPath,
  getPackageRoot
} from '../server/paths.js';
import { writeEnvFile, DEFAULT_TOKEN_ENV, DEFAULT_PORT_ENV } from '../server/env-file.js';

const originalHome = process.env.HOME;
let tempHome = '';

afterEach(() => {
  resetEnvLoadForTests();
  delete process.env.CHROME_BROWSER_CONTROL_TOKEN;
  delete process.env.CHROME_BROWSER_CONTROL_PORT;
  delete process.env.CHROME_BROWSER_CONTROL_DISABLE_LOCAL_ENV;
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = '';
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  vi.unstubAllEnvs();
});

function withTempHome(): string {
  tempHome = mkdtempSync(join(tmpdir(), 'cbc-user-config-'));
  process.env.HOME = tempHome;
  process.env.CHROME_BROWSER_CONTROL_DISABLE_LOCAL_ENV = '1';
  return tempHome;
}

describe('user config paths and env load order', () => {
  it('resolves user config under HOME/.chrome-browser-control', () => {
    withTempHome();
    expect(getUserConfigDir()).toBe(join(tempHome, '.chrome-browser-control'));
    expect(getUserConfigPath()).toBe(join(tempHome, '.chrome-browser-control', 'config.env'));
    expect(getInstalledExtensionPath()).toBe(join(tempHome, '.chrome-browser-control', 'extension'));
  });

  it('loads user config before repo .env.local when process env is unset', () => {
    const home = withTempHome();
    mkdirSync(getUserConfigDir(), { recursive: true });
    writeEnvFile(getUserConfigPath(), {
      [DEFAULT_TOKEN_ENV]: 'user-config-token-123456789012345678901234567890',
      [DEFAULT_PORT_ENV]: '9001'
    });

    const repoRoot = getPackageRoot();
    const localEnvPath = join(repoRoot, '.env.local');
    const hadLocal = existsSync(localEnvPath);
    const previousLocal = hadLocal ? readFileSync(localEnvPath, 'utf8') : undefined;

    writeFileSync(
      localEnvPath,
      `${DEFAULT_TOKEN_ENV}=repo-local-token-123456789012345678901234567890\n${DEFAULT_PORT_ENV}=8765\n`,
      { mode: 0o600 }
    );

    try {
      resetEnvLoadForTests();
      delete process.env.CHROME_BROWSER_CONTROL_TOKEN;
      delete process.env.CHROME_BROWSER_CONTROL_PORT;
      expect(resolveToken().token).toBe('user-config-token-123456789012345678901234567890');
    } finally {
      if (hadLocal && previousLocal !== undefined) {
        writeFileSync(localEnvPath, previousLocal, { mode: 0o600 });
      } else {
        rmSync(localEnvPath, { force: true });
      }
    }
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
