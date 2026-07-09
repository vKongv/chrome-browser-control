import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const USER_CONFIG_DIR_NAME = '.chrome-browser-control';
export const USER_CONFIG_FILE = 'config.env';
export const BROKER_PID_FILE = 'broker.pid';
export const BROKER_LOG_FILE = 'broker.log';
export const INSTALLED_EXTENSION_DIR = 'extension';
export const INSTALLED_VERSION_FILE = '.installed-version';

export function getUserConfigDir(): string {
  return join(homedir(), USER_CONFIG_DIR_NAME);
}

export function getUserConfigPath(): string {
  return join(getUserConfigDir(), USER_CONFIG_FILE);
}

export function getInstalledExtensionPath(): string {
  return join(getUserConfigDir(), INSTALLED_EXTENSION_DIR);
}

export function getBrokerPidPath(): string {
  return join(getUserConfigDir(), BROKER_PID_FILE);
}

export function getBrokerLogPath(): string {
  return join(getUserConfigDir(), BROKER_LOG_FILE);
}

export function getInstalledVersionPath(): string {
  return join(getUserConfigDir(), INSTALLED_VERSION_FILE);
}

/** Package root (directory containing package.json), from any module in the package. */
export function getPackageRoot(moduleUrl = import.meta.url): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  while (dir !== dirname(dir)) {
    const packageJsonPath = join(dir, 'package.json');
    if (existsSync(packageJsonPath)) {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: string };
      if (pkg.name === 'chrome-browser-control') return dir;
    }
    dir = dirname(dir);
  }
  throw new Error('Could not find chrome-browser-control package root');
}

/** Semver from package.json at the resolved package root. */
export function readPackageVersion(moduleUrl = import.meta.url): string {
  const packageJsonPath = join(getPackageRoot(moduleUrl), 'package.json');
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')).version as string;
}

export function getPackagedExtensionPath(moduleUrl = import.meta.url): string {
  return join(getPackageRoot(moduleUrl), 'extension');
}

export function getCompiledBrokerMainPath(moduleUrl = import.meta.url): string {
  return join(getPackageRoot(moduleUrl), 'dist', 'server', 'broker-main.js');
}

export function getCompiledMcpMainPath(moduleUrl = import.meta.url): string {
  return join(getPackageRoot(moduleUrl), 'dist', 'server', 'index.js');
}
