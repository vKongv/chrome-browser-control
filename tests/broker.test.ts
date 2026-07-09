import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BrokerClient } from '../server/broker-client.js';
import { ChromeBroker } from '../server/broker.js';

const brokers: ChromeBroker[] = [];

async function makeBroker(token = 'secret'): Promise<ChromeBroker> {
  const broker = new ChromeBroker({ port: 0, token, requestTimeoutMs: 500, helloTimeoutMs: 50 });
  brokers.push(broker);
  await broker.start();
  return broker;
}

function brokerUrl(broker: ChromeBroker): string {
  const address = (broker as any).server.address();
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

async function connectExtension(url: string, token: string): Promise<WebSocket> {
  const socket = new WebSocket(url);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for extension auth')), 1000);

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind === 'auth_required') {
        socket.send(JSON.stringify({ kind: 'hello', token, role: 'extension', extensionId: 'test-extension' }));
        return;
      }
      if (message.kind === 'auth_ack' && message.ok) {
        clearTimeout(timeout);
        resolve();
      }
    });

    socket.once('open', () => undefined);
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  return socket;
}

async function makeMcpClient(broker: ChromeBroker, token = 'secret'): Promise<BrokerClient> {
  const client = new BrokerClient({ url: brokerUrl(broker), token, requestTimeoutMs: 500, helloTimeoutMs: 200 });
  await client.connect();
  return client;
}

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.stop().catch(() => undefined)));
});

describe('ChromeBroker', () => {
  it('defaults request timeouts long enough for bounded page waits', () => {
    const broker = new ChromeBroker({ port: 0, token: 'secret' });
    const client = new BrokerClient({ url: 'ws://127.0.0.1:8765', token: 'secret' });

    expect(broker.requestTimeoutMs).toBe(60_000);
    expect(client.requestTimeoutMs).toBe(60_000);
  });

  it('rejects MCP clients with an invalid pairing token', async () => {
    const broker = await makeBroker();
    const socket = new WebSocket(brokerUrl(broker));
    await waitForOpen(socket);

    socket.once('message', () => {
      socket.send(JSON.stringify({ kind: 'hello', token: 'wrong', role: 'mcp_client' }));
    });

    await waitForClose(socket);
    expect(broker.mcpClientCount).toBe(0);
  });

  it('rejects extension hello without an explicit role', async () => {
    const broker = await makeBroker();
    const socket = new WebSocket(brokerUrl(broker));
    await waitForOpen(socket);

    socket.once('message', () => {
      socket.send(JSON.stringify({ kind: 'hello', token: 'secret' }));
    });

    await waitForClose(socket);
    expect(broker.extensionConnected).toBe(false);
    socket.close();
  });

  it('rejects extension hello when configured extension id does not match', async () => {
    const broker = new ChromeBroker({
      port: 0,
      token: 'secret',
      extensionId: 'expected-extension',
      requestTimeoutMs: 500,
      helloTimeoutMs: 50
    });
    brokers.push(broker);
    await broker.start();
    const socket = new WebSocket(brokerUrl(broker));
    await waitForOpen(socket);

    socket.once('message', () => {
      socket.send(
        JSON.stringify({ kind: 'hello', token: 'secret', role: 'extension', extensionId: 'different-extension' })
      );
    });

    await waitForClose(socket);
    expect(broker.extensionConnected).toBe(false);
  });

  it('lets two MCP clients share one extension bridge', async () => {
    const broker = await makeBroker();
    const extension = await connectExtension(brokerUrl(broker), 'secret');

    extension.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.kind !== 'request') return;
      extension.send(
        JSON.stringify({
          kind: 'response',
          id: request.id,
          ok: true,
          result: { from: request.action, client: request.params?.client }
        })
      );
    });

    const clientA = await makeMcpClient(broker);
    const clientB = await makeMcpClient(broker);

    await expect(clientA.call('list_tabs', { client: 'a' })).resolves.toEqual({
      from: 'list_tabs',
      client: 'a'
    });
    await expect(clientB.call('snapshot', { client: 'b' })).resolves.toEqual({
      from: 'snapshot',
      client: 'b'
    });

    expect(broker.mcpClientCount).toBe(2);
    extension.close();
  });

  it('serializes concurrent browser tool calls globally', async () => {
    const broker = await makeBroker();
    const extension = await connectExtension(brokerUrl(broker), 'secret');
    const order: string[] = [];

    extension.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.kind !== 'request') return;

      order.push(`start:${request.params?.label}`);
      setTimeout(() => {
        order.push(`end:${request.params?.label}`);
        extension.send(
          JSON.stringify({
            kind: 'response',
            id: request.id,
            ok: true,
            result: request.params?.label
          })
        );
      }, 30);
    });

    const clientA = await makeMcpClient(broker);
    const clientB = await makeMcpClient(broker);

    const first = clientA.call('navigate', { label: 'a', url: 'https://example.com/a' });
    const second = clientB.call('click', { label: 'b', ref: 'e1' });

    await Promise.all([first, second]);

    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
    extension.close();
  });

  it('rejects in-flight calls when the extension connection is replaced', async () => {
    const broker = await makeBroker();
    const firstExtension = await connectExtension(brokerUrl(broker), 'secret');
    const client = await makeMcpClient(broker);

    const sawRequest = new Promise<void>((resolve) => {
      firstExtension.on('message', (raw) => {
        const request = JSON.parse(raw.toString());
        if (request.kind === 'request') resolve();
      });
    });

    const pending = client.call('snapshot');
    await sawRequest;

    const replacementExtension = await connectExtension(brokerUrl(broker), 'secret');

    await expect(pending).rejects.toThrow('Chrome extension connection was replaced');
    firstExtension.close();
    replacementExtension.close();
  });

  it('returns a structured error for invalid MCP client requests', async () => {
    const broker = await makeBroker();
    const socket = new WebSocket(brokerUrl(broker));

    const response = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for broker response')), 1000);
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.kind === 'auth_required') {
          socket.send(JSON.stringify({ kind: 'hello', token: 'secret', role: 'mcp_client' }));
          return;
        }
        if (message.kind === 'auth_ack') {
          socket.send(JSON.stringify({ kind: 'request', id: 'bad-action', action: 'steal_cookies' }));
          return;
        }
        if (message.kind === 'response') {
          clearTimeout(timeout);
          resolve(message);
        }
      });
      socket.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    expect(response).toMatchObject({
      kind: 'response',
      id: 'bad-action',
      ok: false
    });
    expect(response.error).toContain('Invalid broker request');
    socket.close();
  });

  it('returns an error when no extension is connected', async () => {
    const broker = await makeBroker();
    const client = await makeMcpClient(broker);

    await expect(client.call('list_tabs')).rejects.toThrow('No Chrome extension connected to broker');
  });

  it('pushes adapter_status to the extension when an MCP client connects', async () => {
    const broker = await makeBroker();
    const extension = await connectExtension(brokerUrl(broker), 'secret');
    const adapterStatuses: Array<Record<string, unknown>> = [];

    extension.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind === 'adapter_status') adapterStatuses.push(message);
    });

    const client = new BrokerClient({
      url: brokerUrl(broker),
      token: 'secret',
      requestTimeoutMs: 500,
      helloTimeoutMs: 200
    });
    client.setHelloMetadata({ adapterProtocolVersion: 1, registeredToolCount: 22 });
    await client.connect();

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(adapterStatuses.at(-1)).toMatchObject({
      kind: 'adapter_status',
      adapterProtocolVersion: 1,
      registeredToolCount: 22,
      mcpClientCount: 1
    });

    await client.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(adapterStatuses.at(-1)).toMatchObject({
      kind: 'adapter_status',
      registeredToolCount: 0,
      mcpClientCount: 0
    });

    extension.close();
  });

  it('includes hello metadata on the first adapter_status after connect', async () => {
    const broker = await makeBroker();
    const extension = await connectExtension(brokerUrl(broker), 'secret');

    const firstAdapterStatus = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for first adapter_status')), 1000);
      extension.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.kind !== 'adapter_status') return;
        clearTimeout(timeout);
        resolve(message);
      });
    });

    const client = new BrokerClient({
      url: brokerUrl(broker),
      token: 'secret',
      requestTimeoutMs: 500,
      helloTimeoutMs: 200
    });
    // Startup order contract: setHelloMetadata before first connect so adapter registeredToolCount is non-zero.
    client.setHelloMetadata({ adapterProtocolVersion: 1, registeredToolCount: 22 });
    await client.connect();

    await expect(firstAdapterStatus).resolves.toMatchObject({
      kind: 'adapter_status',
      adapterProtocolVersion: 1,
      registeredToolCount: 22,
      mcpClientCount: 1
    });

    await client.disconnect();
    extension.close();
  });

  it('pushes zero registeredToolCount on first connect when hello metadata is missing', async () => {
    const broker = await makeBroker();
    const extension = await connectExtension(brokerUrl(broker), 'secret');

    const firstAdapterStatus = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for first adapter_status')), 1000);
      extension.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.kind !== 'adapter_status') return;
        clearTimeout(timeout);
        resolve(message);
      });
    });

    const client = await makeMcpClient(broker);

    await expect(firstAdapterStatus).resolves.toMatchObject({
      kind: 'adapter_status',
      registeredToolCount: 0,
      mcpClientCount: 1
    });

    await client.disconnect();
    extension.close();
  });
});
