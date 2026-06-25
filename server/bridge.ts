import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import {
  BridgeAction,
  BridgeResponse,
  parseBridgeResponse,
  parseExtensionHello,
  parseJsonMessage
} from './protocol.js';

export interface BrowserBridgeOptions {
  host?: string;
  port?: number;
  token: string;
  requestTimeoutMs?: number;
  helloTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class BrowserBridge extends EventEmitter {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly requestTimeoutMs: number;
  readonly helloTimeoutMs: number;

  private server?: WebSocketServer;
  private activeSocket?: WebSocket;
  private pending = new Map<string, PendingRequest>();

  constructor(options: BrowserBridgeOptions) {
    super();
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 8765;
    this.token = options.token;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.helloTimeoutMs = options.helloTimeoutMs ?? 5_000;
  }

  get connected(): boolean {
    return this.activeSocket?.readyState === WebSocket.OPEN;
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
      pending.reject(new Error(`Bridge stopped before response for ${id}`));
    }
    this.pending.clear();

    this.activeSocket?.close();
    this.activeSocket = undefined;

    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async call(action: BridgeAction, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.connected || !this.activeSocket) {
      throw new Error('No Chrome extension connected to bridge');
    }

    const id = crypto.randomUUID();
    const payload = { kind: 'request', id, action, params };

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for extension response to ${action}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      this.activeSocket?.send(JSON.stringify(payload), (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private handleConnection(socket: WebSocket): void {
    let authenticated = false;
    const helloTimeout = setTimeout(() => {
      if (!authenticated && socket.readyState === WebSocket.OPEN) {
        socket.close(1008, 'Timed out waiting for extension hello');
      }
    }, this.helloTimeoutMs);

    socket.send(JSON.stringify({ kind: 'auth_required' }));

    socket.once('message', (raw) => {
      try {
        clearTimeout(helloTimeout);
        const hello = parseExtensionHello(parseJsonMessage(raw as Buffer));
        if (hello.token !== this.token) {
          socket.close(1008, 'Invalid pairing token');
          return;
        }

        authenticated = true;
        this.replaceActiveSocket(socket);
        socket.send(JSON.stringify({ kind: 'auth_ack', ok: true }));
        this.emit('connected', hello);

        socket.on('message', (message) => this.handleMessage(message));
      } catch (error) {
        clearTimeout(helloTimeout);
        socket.close(1008, (error as Error).message.slice(0, 120));
      }
    });

    socket.on('close', () => {
      clearTimeout(helloTimeout);
      if (authenticated && this.activeSocket === socket) {
        this.activeSocket = undefined;
        this.rejectAllPending(new Error('Chrome extension disconnected'));
        this.emit('disconnected');
      }
    });
  }

  private replaceActiveSocket(socket: WebSocket): void {
    if (this.activeSocket && this.activeSocket !== socket) {
      this.activeSocket.close(1000, 'Replaced by a newer extension connection');
    }
    this.activeSocket = socket;
  }

  private handleMessage(raw: WebSocket.RawData): void {
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
      pending.reject(new Error(response.error));
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
