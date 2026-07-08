import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { ChromeBroker } from '../server/broker.js';
import {
  BROKER_AUTOLOAD_TIMEOUT_MS,
  ensureBroker,
  resetBrokerLifecycleForTests
} from '../server/broker-lifecycle.js';

const brokers: ChromeBroker[] = [];
const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args)
}));

async function makeBroker(token = 'secret-token-for-broker-lifecycle-tests'): Promise<ChromeBroker> {
  const broker = new ChromeBroker({ port: 0, token, requestTimeoutMs: 500, helloTimeoutMs: 200 });
  brokers.push(broker);
  await broker.start();
  return broker;
}

function brokerUrl(broker: ChromeBroker): string {
  const address = (broker as any).server.address();
  return `ws://127.0.0.1:${address.port}`;
}

function brokerHostPort(broker: ChromeBroker): { host: string; port: number } {
  const address = (broker as any).server.address();
  return { host: '127.0.0.1', port: address.port };
}

afterEach(async () => {
  resetBrokerLifecycleForTests();
  spawnMock.mockReset();
  await Promise.all(brokers.splice(0).map((broker) => broker.stop().catch(() => undefined)));
});

describe('ensureBroker', () => {
  it('adopts an existing broker when the port accepts the configured token', async () => {
    const broker = await makeBroker();
    const { host, port } = brokerHostPort(broker);
    const url = brokerUrl(broker);

    const result = await ensureBroker({ url, token: 'secret-token-for-broker-lifecycle-tests', host, port });

    expect(result).toMatchObject({ ownership: 'adopted', reachable: true, authOk: true });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not spawn when the port is open but auth fails', async () => {
    const broker = await makeBroker('expected-token');
    const { host, port } = brokerHostPort(broker);
    const url = brokerUrl(broker);

    const result = await ensureBroker({ url, token: 'wrong-token', host, port });

    expect(result).toMatchObject({
      reachable: true,
      authOk: false,
      authFailed: true
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not spawn when autoload is disabled and the port is refused', async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    const host = '127.0.0.1';
    const port = address.port;
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));

    const url = `ws://${host}:${port}`;
    const result = await ensureBroker({
      url,
      token: 'spawn-token-123456789012345678901234',
      host,
      port,
      autoloadEnabled: false
    });

    expect(result).toMatchObject({ reachable: false, authOk: false });
    expect(result.error).toContain('chrome-browser-control start');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns exactly once per adapter process when autoload is enabled and the port is refused', async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    const host = '127.0.0.1';
    const port = address.port;
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));

    const url = `ws://${host}:${port}`;
    spawnMock.mockReturnValue({ unref: vi.fn(), on: vi.fn(), pid: 4242 });

    const first = ensureBroker({
      url,
      token: 'spawn-token-123456789012345678901234',
      host,
      port,
      spawnTimeoutMs: 50,
      autoloadEnabled: true
    });
    const second = ensureBroker({
      url,
      token: 'spawn-token-123456789012345678901234',
      host,
      port,
      spawnTimeoutMs: 50,
      autoloadEnabled: true
    });
    const [resultA, resultB] = await Promise.all([first, second]);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0]).toBe(process.execPath);
    expect(String(spawnMock.mock.calls[0]?.[1]?.[0] ?? '')).toContain('dist/server/broker-main.js');
    expect(resultA).toBe(resultB);
    expect(resultA).toMatchObject({ ownership: 'spawned', autoloadTimedOut: true, reachable: false, authOk: false });
  });

  it('uses a bounded autoload timeout constant', () => {
    expect(BROKER_AUTOLOAD_TIMEOUT_MS).toBe(15_000);
  });

  it('re-probes and recovers when a cached broker stops responding', async () => {
    const broker = await makeBroker();
    const { host, port } = brokerHostPort(broker);
    const url = brokerUrl(broker);
    const token = 'secret-token-for-broker-lifecycle-tests';

    const first = await ensureBroker({ url, token, host, port });
    expect(first).toMatchObject({ ownership: 'adopted', reachable: true, authOk: true });

    await broker.stop();

    spawnMock.mockReturnValue({ unref: vi.fn(), on: vi.fn(), pid: 5151 });

    const second = await ensureBroker({ url, token, host, port, spawnTimeoutMs: 50, autoloadEnabled: true });
    expect(second).toMatchObject({ ownership: 'spawned', autoloadTimedOut: true, reachable: false, authOk: false });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('respawns after a failed autoload when the port stays refused', async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    const host = '127.0.0.1';
    const port = address.port;
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));

    const url = `ws://${host}:${port}`;
    const token = 'spawn-token-123456789012345678901234';
    spawnMock.mockReturnValue({ unref: vi.fn(), on: vi.fn(), pid: 4242 });

    const first = await ensureBroker({ url, token, host, port, spawnTimeoutMs: 50, autoloadEnabled: true });
    expect(first).toMatchObject({ ownership: 'spawned', autoloadTimedOut: true, reachable: false, authOk: false });

    const second = await ensureBroker({ url, token, host, port, spawnTimeoutMs: 50, autoloadEnabled: true });
    expect(second).toMatchObject({ ownership: 'spawned', autoloadTimedOut: true, reachable: false, authOk: false });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
