import { describe, expect, it } from 'vitest';
import {
  parseBridgeRequest,
  parseBridgeResponse,
  parseClientHello,
  parseExtensionHello,
  parseJsonMessage
} from '../server/protocol.js';

describe('protocol validation', () => {
  it('accepts a token-bearing extension hello', () => {
    expect(parseExtensionHello({ kind: 'hello', token: 'dev-token', extensionId: 'abc' })).toEqual({
      kind: 'hello',
      token: 'dev-token',
      extensionId: 'abc'
    });
  });

  it('requires an explicit client hello role', () => {
    expect(() => parseClientHello({ kind: 'hello', token: 'dev-token' })).toThrow();
  });

  it('accepts MCP client hello role', () => {
    expect(parseClientHello({ kind: 'hello', token: 'dev-token', role: 'mcp_client' })).toEqual({
      kind: 'hello',
      token: 'dev-token',
      role: 'mcp_client'
    });
  });

  it('rejects hello messages without a token', () => {
    expect(() => parseExtensionHello({ kind: 'hello', token: '' })).toThrow();
  });

  it('accepts known request actions', () => {
    expect(parseBridgeRequest({ kind: 'request', id: '1', action: 'snapshot' })).toMatchObject({
      kind: 'request',
      id: '1',
      action: 'snapshot',
      params: {}
    });
  });

  it('rejects unknown request actions', () => {
    expect(() => parseBridgeRequest({ kind: 'request', id: '1', action: 'steal_cookies' })).toThrow();
  });

  it('requires an error message for failed responses', () => {
    expect(() => parseBridgeResponse({ kind: 'response', id: '1', ok: false })).toThrow();
  });

  it('parses valid JSON messages and rejects malformed JSON', () => {
    expect(parseJsonMessage('{"kind":"hello","token":"x"}')).toEqual({ kind: 'hello', token: 'x' });
    expect(() => parseJsonMessage('{nope')).toThrow('Invalid JSON message');
  });
});
