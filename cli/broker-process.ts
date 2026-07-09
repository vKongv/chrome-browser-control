import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import {
  getBrokerLogPath,
  getBrokerPidPath,
  getCompiledBrokerMainPath,
  getUserConfigDir,
  getUserConfigPath
} from '../server/paths.js';
import { readEnvFile } from '../server/env-file.js';
import { assertSafeHost } from '../server/env.js';

export interface BrokerConfig {
  host: string;
  port: number;
  token: string;
}

export function readBrokerConfig(): BrokerConfig {
  const configPath = getUserConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`Missing user config at ${configPath}. Run chrome-browser-control setup first.`);
  }
  const env = readEnvFile(configPath);
  const host = env.CHROME_BROWSER_CONTROL_HOST ?? '127.0.0.1';
  const port = Number(env.CHROME_BROWSER_CONTROL_PORT ?? 8765);
  const token = env.CHROME_BROWSER_CONTROL_TOKEN ?? '';
  assertSafeHost(host);
  return { host, port, token };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPidFile(): number | undefined {
  const pidPath = getBrokerPidPath();
  if (!existsSync(pidPath)) return undefined;
  const raw = readFileSync(pidPath, 'utf8').trim();
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function clearPidFile(): void {
  const pidPath = getBrokerPidPath();
  if (existsSync(pidPath)) unlinkSync(pidPath);
}

export async function isPortOpen(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(2_000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export interface StartBrokerOptions {
  detached?: boolean;
  logFile?: string;
}

export function startBrokerProcess(config: BrokerConfig, options: StartBrokerOptions = {}): ChildProcess {
  mkdirSync(getUserConfigDir(), { recursive: true });
  const brokerMain = getCompiledBrokerMainPath();
  if (!existsSync(brokerMain)) {
    throw new Error(`Compiled broker entry missing at ${brokerMain}. Run npm run build first.`);
  }

  const logPath = options.logFile ?? getBrokerLogPath();
  const logFd = openSync(logPath, 'a');

  const child = spawn(process.execPath, [brokerMain], {
    detached: options.detached ?? true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      CHROME_BROWSER_CONTROL_HOST: config.host,
      CHROME_BROWSER_CONTROL_PORT: String(config.port),
      CHROME_BROWSER_CONTROL_TOKEN: config.token
    }
  });

  if (options.detached ?? true) {
    child.unref();
  }

  if (child.pid) {
    writeFileSync(getBrokerPidPath(), `${child.pid}\n`);
  }

  return child;
}

export async function stopBrokerProcess(): Promise<'stopped' | 'not_running'> {
  const pid = readPidFile();
  if (!pid || !isProcessAlive(pid)) {
    clearPidFile();
    return 'not_running';
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    clearPidFile();
    return 'not_running';
  }

  clearPidFile();
  return 'stopped';
}

export async function brokerAlreadyRunning(config: BrokerConfig): Promise<boolean> {
  const pid = readPidFile();
  if (pid && !isProcessAlive(pid)) {
    clearPidFile();
  }
  // A live PID alone is not enough — require the configured port to be accepting connections.
  return await isPortOpen(config.host, config.port);
}

export async function waitForBrokerPort(
  config: BrokerConfig,
  timeoutMs = 15_000,
  child?: ChildProcess
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.pid && !isProcessAlive(child.pid)) {
      return false;
    }
    if (await isPortOpen(config.host, config.port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
