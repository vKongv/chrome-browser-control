import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import {
  BridgeAction,
  BridgeResponse,
  parseBridgeResponse,
  parseJsonMessage
} from './protocol.js';
import type { BridgeLike } from './tools.js';

export interface BrokerClientHelloMetadata {
  adapterProtocolVersion?: number;
  registeredToolCount?: number;
}

export interface BrokerClientOptions {
  url: string;
  token: string;
  requestTimeoutMs?: number;
  helloTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class BrokerClient extends EventEmitter implements BridgeLike {
  readonly url: string;
  readonly token: string;
  readonly requestTimeoutMs: number;
  readonly helloTimeoutMs: number;

  private socket?: WebSocket;
  private authenticated = false;
  private connecting?: Promise<void>;
  private pending = new Map<string, PendingRequest>();
  private helloMetadata: BrokerClientHelloMetadata = {};

  constructor(options: BrokerClientOptions) {
    super();
    this.url = options.url;
    this.token = options.token;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.helloTimeoutMs = options.helloTimeoutMs ?? 5_000;
  }

  get connected(): boolean {
    return this.authenticated && this.socket?.readyState === WebSocket.OPEN;
  }

  setHelloMetadata(metadata: BrokerClientHelloMetadata): void {
    this.helloMetadata = { ...metadata };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return await this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;

      const helloTimeout = setTimeout(() => {
        if (!this.authenticated) {
          socket.close(1008, 'Timed out waiting for broker auth');
          reject(new Error('Timed out waiting for broker authentication'));
        }
      }, this.helloTimeoutMs);

      socket.once('open', () => undefined);

      socket.on('message', (raw) => {
        let message: unknown;
        try {
          message = parseJsonMessage(raw as Buffer);
        } catch {
          return;
        }

        const kind = (message as { kind?: string }).kind;

        if (kind === 'auth_required') {
          socket.send(
            JSON.stringify({
              kind: 'hello',
              token: this.token,
              role: 'mcp_client',
              ...(this.helloMetadata.adapterProtocolVersion !== undefined
                ? { adapterProtocolVersion: this.helloMetadata.adapterProtocolVersion }
                : {}),
              ...(this.helloMetadata.registeredToolCount !== undefined
                ? { registeredToolCount: this.helloMetadata.registeredToolCount }
                : {})
            })
          );
          return;
        }

        if (kind === 'auth_ack') {
          clearTimeout(helloTimeout);
          this.authenticated = true;
          this.emit('connected');
          resolve();
          return;
        }

        if (this.authenticated) {
          this.handleMessage(raw);
        }
      });

      socket.once('error', (error) => {
        clearTimeout(helloTimeout);
        reject(error);
      });

      socket.once('close', (code, reason) => {
        clearTimeout(helloTimeout);
        if (!this.authenticated) {
          this.connecting = undefined;
          reject(new Error(`Broker closed connection before auth (${code}: ${reason.toString()})`));
          return;
        }
        this.authenticated = false;
        this.rejectAllPending(new Error('Disconnected from Chrome broker'));
        this.emit('disconnected');
      });
    });

    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async disconnect(): Promise<void> {
    this.authenticated = false;
    this.rejectAllPending(new Error('Broker client disconnected'));

    if (!this.socket) return;
    const socket = this.socket;
    this.socket = undefined;
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close(1000, 'Client disconnect');
    });
  }

  async call(action: BridgeAction, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.connected || !this.socket) {
      throw new Error('Not connected to Chrome broker');
    }

    const id = crypto.randomUUID();
    const payload = { kind: 'request', id, action, params };

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for broker response to ${action}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      this.socket?.send(JSON.stringify(payload), (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
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
      pending.reject(new Error(response.error ?? 'Broker error'));
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
