import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BrowserBridge } from '../server/bridge.js';

const bridges: BrowserBridge[] = [];

async function makeBridge(): Promise<BrowserBridge> {
  const bridge = new BrowserBridge({ port: 0, token: 'secret', requestTimeoutMs: 200, helloTimeoutMs: 50 });
  bridges.push(bridge);
  await bridge.start();
  return bridge;
}

function bridgeUrl(bridge: BrowserBridge): string {
  const address = (bridge as any).server.address();
  return `ws://127.0.0.1:${address.port}`;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function waitForClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop().catch(() => undefined)));
});

describe('BrowserBridge', () => {
  it('requires a valid pairing token', async () => {
    const bridge = await makeBridge();
    const socket = new WebSocket(bridgeUrl(bridge));
    await waitForOpen(socket);
    socket.send(JSON.stringify({ kind: 'hello', token: 'wrong' }));
    await waitForClose(socket);
    expect(bridge.connected).toBe(false);
  });

  it('closes clients that never send hello', async () => {
    const bridge = await makeBridge();
    const socket = new WebSocket(bridgeUrl(bridge));
    await waitForOpen(socket);

    await waitForClose(socket);
    expect(bridge.connected).toBe(false);
  });

  it('forwards calls to the connected extension and resolves responses', async () => {
    const bridge = await makeBridge();
    const socket = new WebSocket(bridgeUrl(bridge));
    await waitForOpen(socket);

    socket.send(JSON.stringify({ kind: 'hello', token: 'secret' }));
    await new Promise((resolve) => bridge.once('connected', resolve));

    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.kind !== 'request') return;
      socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: true, result: ['tab-a'] }));
    });

    await expect(bridge.call('list_tabs')).resolves.toEqual(['tab-a']);
    socket.close();
  });

  it('rejects extension errors', async () => {
    const bridge = await makeBridge();
    const socket = new WebSocket(bridgeUrl(bridge));
    await waitForOpen(socket);

    socket.send(JSON.stringify({ kind: 'hello', token: 'secret' }));
    await new Promise((resolve) => bridge.once('connected', resolve));

    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.kind !== 'request') return;
      socket.send(JSON.stringify({ kind: 'response', id: request.id, ok: false, error: 'boom' }));
    });

    await expect(bridge.call('snapshot')).rejects.toThrow('boom');
    socket.close();
  });

  it('times out unanswered requests', async () => {
    const bridge = await makeBridge();
    const socket = new WebSocket(bridgeUrl(bridge));
    await waitForOpen(socket);
    socket.send(JSON.stringify({ kind: 'hello', token: 'secret' }));
    await new Promise((resolve) => bridge.once('connected', resolve));

    await expect(bridge.call('snapshot')).rejects.toThrow('Timed out');
    socket.close();
  });

  it('rejects pending requests when the active socket disconnects without replacement', async () => {
    const bridge = await makeBridge();
    const socket = new WebSocket(bridgeUrl(bridge));
    await waitForOpen(socket);
    socket.send(JSON.stringify({ kind: 'hello', token: 'secret' }));
    await new Promise((resolve) => bridge.once('connected', resolve));

    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.kind !== 'request' || request.action !== 'navigate') return;
      setTimeout(() => socket.close(), 20);
    });

    await expect(bridge.call('navigate', { url: 'https://example.com' })).rejects.toThrow(
      'Chrome extension disconnected'
    );
  });
});
