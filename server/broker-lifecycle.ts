import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { WebSocket } from 'ws';
import { getCompiledBrokerMainPath } from './paths.js';

export type BrokerOwnership = 'adopted' | 'spawned' | 'external';

export const BROKER_AUTOLOAD_TIMEOUT_MS = 15_000;
export const BROKER_PROBE_TIMEOUT_MS = 2_000;

export interface EnsureBrokerOptions {
  url: string;
  token: string;
  host: string;
  port: number;
  spawnTimeoutMs?: number;
  autoloadEnabled?: boolean;
}

export interface EnsureBrokerResult {
  ownership?: BrokerOwnership;
  reachable: boolean;
  authOk: boolean;
  authFailed?: boolean;
  autoloadTimedOut?: boolean;
  portNotBroker?: boolean;
  error?: string;
}

let inFlightEnsure: Promise<EnsureBrokerResult> | undefined;
let cachedSuccess: EnsureBrokerResult | undefined;
let ownership: BrokerOwnership | undefined;
let spawnedChild: ChildProcess | undefined;

export function getBrokerOwnership(): BrokerOwnership | undefined {
  return ownership;
}

export function resetBrokerLifecycleForTests(): void {
  inFlightEnsure = undefined;
  cachedSuccess = undefined;
  ownership = undefined;
  spawnedChild = undefined;
}

async function probePortOpen(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(BROKER_PROBE_TIMEOUT_MS, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'EHOSTUNREACH') {
        finish(false);
        return;
      }
      finish(false);
    });
  });
}

export type BrokerProbeResult = 'ok' | 'auth_failed' | 'not_broker' | 'handshake_timeout' | 'unreachable';

export async function probeBrokerAuth(url: string, token: string, timeoutMs = 5_000): Promise<BrokerProbeResult> {
  return await new Promise((resolve) => {
    const socket = new WebSocket(url);
    let settled = false;
    let sawAuthRequired = false;
    let sawOpen = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      if (sawAuthRequired) {
        resolve('handshake_timeout');
        return;
      }
      if (sawOpen) {
        resolve('not_broker');
        return;
      }
      resolve('unreachable');
    }, timeoutMs);

    const cleanup = (result: BrokerProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      resolve(result);
    };

    socket.once('open', () => {
      sawOpen = true;
    });
    socket.once('error', () => {
      if (sawAuthRequired) {
        cleanup('handshake_timeout');
        return;
      }
      if (sawOpen) {
        cleanup('not_broker');
        return;
      }
      cleanup('unreachable');
    });
    socket.on('message', (raw) => {
      let message: { kind?: string; ok?: boolean };
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (message.kind === 'auth_required') {
        sawAuthRequired = true;
        socket.send(JSON.stringify({ kind: 'hello', token, role: 'mcp_client' }));
        return;
      }

      if (message.kind === 'auth_ack') {
        cleanup(message.ok ? 'ok' : 'auth_failed');
      }
    });

    socket.once('close', (code) => {
      if (code === 1008) cleanup('auth_failed');
    });
  });
}

function clearSpawnedBrokerState(): void {
  const child = spawnedChild;
  spawnedChild = undefined;
  if (child?.pid) {
    try {
      // Detached broker is its own process-group leader; signal the group so it dies with MCP exit.
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // Process may already have exited.
      }
    }
  }
  if (ownership === 'spawned') {
    ownership = undefined;
  }
  if (cachedSuccess?.ownership === 'spawned') {
    cachedSuccess = undefined;
  }
}

/** Kill MCP-spawned broker on adapter shutdown; leave adopted/CLI-started brokers alone. */
export function stopSpawnedBrokerIfOwned(): void {
  if (ownership !== 'spawned') return;
  console.error('[chrome-browser-control] stopping MCP-spawned broker on adapter shutdown');
  clearSpawnedBrokerState();
}

function spawnDetachedBroker(host: string, port: number, token: string): ChildProcess {
  const brokerMain = getCompiledBrokerMainPath();
  if (!existsSync(brokerMain)) {
    throw new Error(
      `Compiled broker entry missing at ${brokerMain}. Run npm run build before mcp --autoload (or use cbctl start).`
    );
  }
  const child = spawn(process.execPath, [brokerMain], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CHROME_BROWSER_CONTROL_HOST: host,
      CHROME_BROWSER_CONTROL_PORT: String(port),
      CHROME_BROWSER_CONTROL_TOKEN: token
    }
  });
  child.unref();
  child.on('exit', () => {
    if (spawnedChild === child) {
      clearSpawnedBrokerState();
    }
  });
  return child;
}

async function waitForBrokerReady(
  url: string,
  token: string,
  timeoutMs: number
): Promise<'ok' | 'auth_failed' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const auth = await probeBrokerAuth(url, token, Math.min(2_000, deadline - Date.now()));
    if (auth === 'ok') return 'ok';
    if (auth === 'auth_failed') return 'auth_failed';
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return 'timeout';
}

async function doEnsureBroker(options: EnsureBrokerOptions): Promise<EnsureBrokerResult> {
  const { url, token, host, port } = options;
  const spawnTimeoutMs = options.spawnTimeoutMs ?? BROKER_AUTOLOAD_TIMEOUT_MS;
  const autoloadEnabled = options.autoloadEnabled ?? false;

  const portOpen = await probePortOpen(host, port);

  if (portOpen) {
    const auth = await probeBrokerAuth(url, token);
    if (auth === 'ok') {
      ownership = 'adopted';
      console.error(`[chrome-browser-control] broker adopted ${url}`);
      return { ownership, reachable: true, authOk: true };
    }
    if (auth === 'auth_failed') {
      return {
        reachable: true,
        authOk: false,
        authFailed: true,
        error: `Broker on port ${port} rejected the configured pairing token`
      };
    }
    if (auth === 'handshake_timeout') {
      return {
        reachable: true,
        authOk: false,
        error: `Broker on port ${port} did not respond to handshake in time`
      };
    }
    return {
      reachable: true,
      authOk: false,
      portNotBroker: true,
      error: `Port ${port} is open but did not accept a Chrome Browser Control broker handshake`
    };
  }

  if (!autoloadEnabled) {
    return {
      reachable: false,
      authOk: false,
      error: `Broker is not reachable on port ${port}. Run cbctl start or use mcp --autoload.`
    };
  }

  if (!spawnedChild) {
    try {
      spawnedChild = spawnDetachedBroker(host, port, token);
    } catch (error) {
      return {
        reachable: false,
        authOk: false,
        error: (error as Error).message
      };
    }
    ownership = 'spawned';
    console.error(`[chrome-browser-control] broker spawned ${url}`);
  }

  const ready = await waitForBrokerReady(url, token, spawnTimeoutMs);
  if (ready === 'ok') {
    return { ownership, reachable: true, authOk: true };
  }

  const failedOwnership = ownership;
  clearSpawnedBrokerState();

  if (ready === 'auth_failed') {
    return {
      ownership: failedOwnership,
      reachable: true,
      authOk: false,
      authFailed: true,
      error: `Spawned broker on port ${port} rejected the configured pairing token`
    };
  }

  return {
    ownership: failedOwnership,
    reachable: false,
    authOk: false,
    autoloadTimedOut: true,
    error: `Timed out waiting for broker at ${url} after autoload`
  };
}

export async function ensureBroker(options: EnsureBrokerOptions): Promise<EnsureBrokerResult> {
  if (cachedSuccess?.authOk) {
    const auth = await probeBrokerAuth(options.url, options.token);
    if (auth === 'ok') {
      return cachedSuccess;
    }
    cachedSuccess = undefined;
    if (ownership === 'spawned') {
      clearSpawnedBrokerState();
    } else {
      ownership = undefined;
    }
  }

  if (!inFlightEnsure) {
    inFlightEnsure = doEnsureBroker(options)
      .then((result) => {
        if (result.authOk) {
          cachedSuccess = result;
        }
        return result;
      })
      .finally(() => {
        inFlightEnsure = undefined;
      });
  }

  return await inFlightEnsure;
}
