import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import {
  BridgeRequest,
  BridgeResponse,
  ClientHello,
  parseBridgeRequest,
  parseBridgeResponse,
  parseClientHello,
  parseJsonMessage
} from './protocol.js';

export interface ChromeBrokerOptions {
  host?: string;
  port?: number;
  token: string;
  extensionId?: string;
  requestTimeoutMs?: number;
  helloTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  client: WebSocket;
}

export class ChromeBroker extends EventEmitter {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly extensionId?: string;
  readonly requestTimeoutMs: number;
  readonly helloTimeoutMs: number;

  private server?: WebSocketServer;
  private extensionSocket?: WebSocket;
  private mcpClients = new Set<WebSocket>();
  private pending = new Map<string, PendingRequest>();
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(options: ChromeBrokerOptions) {
    super();
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 8765;
    this.token = options.token;
    this.extensionId = options.extensionId?.trim() || undefined;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.helloTimeoutMs = options.helloTimeoutMs ?? 5_000;
  }

  get extensionConnected(): boolean {
    return this.extensionSocket?.readyState === WebSocket.OPEN;
  }

  get mcpClientCount(): number {
    return this.mcpClients.size;
  }

  async start(): Promise<void> {
    if (this.server) return;

    await new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({ host: this.host, port: this.port });
      server.once('error', reject);
      server.on('connection', (socket) => this.handleConnection(socket));
      server.once('listening', () => {
        this.server = server;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Broker stopped before response for ${id}`));
    }
    this.pending.clear();

    for (const client of this.mcpClients) {
      client.close(1001, 'Broker shutting down');
    }
    this.mcpClients.clear();

    this.extensionSocket?.close();
    this.extensionSocket = undefined;

    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private handleConnection(socket: WebSocket): void {
    let authenticated = false;
    const helloTimeout = setTimeout(() => {
      if (!authenticated && socket.readyState === WebSocket.OPEN) {
        socket.close(1008, 'Timed out waiting for hello');
      }
    }, this.helloTimeoutMs);

    socket.send(JSON.stringify({ kind: 'auth_required' }));

    socket.once('message', (raw) => {
      try {
        clearTimeout(helloTimeout);
        const hello = parseClientHello(parseJsonMessage(raw as Buffer));
        if (hello.token !== this.token) {
          socket.close(1008, 'Invalid pairing token');
          return;
        }

        authenticated = true;
        if (hello.role === 'extension') {
          if (this.extensionId && hello.extensionId !== this.extensionId) {
            socket.close(1008, 'Invalid Chrome extension id');
            return;
          }
          this.attachExtension(socket, hello);
        } else {
          this.attachMcpClient(socket);
        }
        socket.send(JSON.stringify({ kind: 'auth_ack', ok: true }));
      } catch (error) {
        clearTimeout(helloTimeout);
        socket.close(1008, (error as Error).message.slice(0, 120));
      }
    });

    socket.on('close', () => {
      clearTimeout(helloTimeout);
    });
  }

  private attachExtension(socket: WebSocket, hello: ClientHello): void {
    this.replaceExtensionSocket(socket);
    this.emit('extensionConnected', hello);

    socket.on('message', (message) => this.handleExtensionMessage(message));
    socket.on('close', () => {
      if (this.extensionSocket === socket) {
        this.extensionSocket = undefined;
        this.rejectAllPending(new Error('Chrome extension disconnected'));
        this.emit('extensionDisconnected');
      }
    });
  }

  private attachMcpClient(socket: WebSocket): void {
    this.mcpClients.add(socket);
    this.emit('mcpClientConnected');

    socket.on('message', (message) => this.handleMcpClientMessage(socket, message));
    socket.on('close', () => {
      this.mcpClients.delete(socket);
      this.rejectPendingForClient(socket, new Error('MCP client disconnected'));
      this.emit('mcpClientDisconnected');
    });
  }

  private replaceExtensionSocket(socket: WebSocket): void {
    if (this.extensionSocket && this.extensionSocket !== socket) {
      this.rejectAllPending(new Error('Chrome extension connection was replaced'));
      this.extensionSocket.close(1000, 'Replaced by a newer extension connection');
    }
    this.extensionSocket = socket;
  }

  private handleMcpClientMessage(client: WebSocket, raw: WebSocket.RawData): void {
    let request: BridgeRequest;
    try {
      request = parseBridgeRequest(parseJsonMessage(raw as Buffer));
    } catch (error) {
      this.emit('protocolError', error);
      this.sendToClient(client, {
        kind: 'response',
        id: this.extractRequestId(raw),
        ok: false,
        error: `Invalid broker request: ${(error as Error).message}`
      });
      return;
    }

    void this.runSerialized(() => this.forwardToExtension(client, request));
  }

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.commandQueue.then(fn);
    this.commandQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async forwardToExtension(client: WebSocket, request: BridgeRequest): Promise<void> {
    if (!this.extensionConnected || !this.extensionSocket) {
      this.sendToClient(client, {
        kind: 'response',
        id: request.id,
        ok: false,
        error: 'No Chrome extension connected to broker'
      });
      return;
    }

    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pending.delete(request.id);
          reject(new Error(`Timed out waiting for extension response to ${request.action}`));
        }, this.requestTimeoutMs);

        this.pending.set(request.id, { resolve, reject, timeout, client });
        this.extensionSocket?.send(
          JSON.stringify({
            kind: 'request',
            id: request.id,
            action: request.action,
            params: request.params ?? {}
          }),
          (error) => {
            if (!error) return;
            clearTimeout(timeout);
            this.pending.delete(request.id);
            reject(error);
          }
        );
      });

      this.sendToClient(client, { kind: 'response', id: request.id, ok: true, result });
    } catch (error) {
      this.sendToClient(client, {
        kind: 'response',
        id: request.id,
        ok: false,
        error: (error as Error).message
      });
    }
  }

  private handleExtensionMessage(raw: WebSocket.RawData): void {
    let response: BridgeResponse;
    try {
      response = parseBridgeResponse(parseJsonMessage(raw as Buffer));
    } catch (error) {
      this.emit('protocolError', error);
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(response.id);

    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(new Error(response.error ?? 'Extension error'));
    }
  }

  private sendToClient(client: WebSocket, response: BridgeResponse): void {
    if (client.readyState !== WebSocket.OPEN) return;
    client.send(JSON.stringify(response));
  }

  private extractRequestId(raw: WebSocket.RawData): string {
    try {
      const message = parseJsonMessage(raw as Buffer) as { id?: unknown };
      return typeof message?.id === 'string' && message.id ? message.id : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private rejectPendingForClient(client: WebSocket, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.client !== client) continue;
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
