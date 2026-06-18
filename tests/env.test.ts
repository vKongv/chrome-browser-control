import { afterEach, describe, expect, it } from 'vitest';
import { assertSafeHost, getBrokerUrl, getToken } from '../server/env.js';

const originalToken = process.env.HERMES_CHROME_TOKEN;
const originalHost = process.env.HERMES_CHROME_HOST;
const originalPort = process.env.HERMES_CHROME_PORT;
const originalDisableLocalEnv = process.env.HERMES_CHROME_DISABLE_LOCAL_ENV;
process.env.HERMES_CHROME_DISABLE_LOCAL_ENV = '1';

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.HERMES_CHROME_TOKEN;
  } else {
    process.env.HERMES_CHROME_TOKEN = originalToken;
  }
  if (originalHost === undefined) {
    delete process.env.HERMES_CHROME_HOST;
  } else {
    process.env.HERMES_CHROME_HOST = originalHost;
  }
  if (originalPort === undefined) {
    delete process.env.HERMES_CHROME_PORT;
  } else {
    process.env.HERMES_CHROME_PORT = originalPort;
  }
  if (originalDisableLocalEnv === undefined) {
    process.env.HERMES_CHROME_DISABLE_LOCAL_ENV = '1';
  } else {
    process.env.HERMES_CHROME_DISABLE_LOCAL_ENV = originalDisableLocalEnv;
  }
});

describe('environment hardening', () => {
  it('requires a non-default high entropy token', () => {
    delete process.env.HERMES_CHROME_TOKEN;
    expect(() => getToken()).toThrow('HERMES_CHROME_TOKEN is required');

    process.env.HERMES_CHROME_TOKEN = ['dev', 'token', 'change', 'me'].join('-');
    expect(() => getToken()).toThrow('Refusing insecure default');

    process.env.HERMES_CHROME_TOKEN = 'short';
    expect(() => getToken()).toThrow('at least 32');

    process.env.HERMES_CHROME_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(() => getToken()).toThrow('character variety');

    process.env.HERMES_CHROME_TOKEN = '11111111111111111111111111111111';
    expect(() => getToken()).toThrow('character variety');

    process.env.HERMES_CHROME_TOKEN = 'abababababababababababababababab';
    expect(() => getToken()).toThrow('character variety');

    process.env.HERMES_CHROME_TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-';
    expect(getToken()).toBe('abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-');
  });

  it('only allows loopback broker hosts', () => {
    expect(() => assertSafeHost('127.0.0.1')).not.toThrow();
    expect(() => assertSafeHost('localhost')).not.toThrow();
    expect(() => assertSafeHost('::1')).not.toThrow();
    expect(() => assertSafeHost('0.0.0.0')).toThrow('non-loopback');
  });

  it('formats broker URLs for IPv4, localhost, and IPv6 loopback hosts', () => {
    process.env.HERMES_CHROME_PORT = '8765';

    process.env.HERMES_CHROME_HOST = '127.0.0.1';
    expect(getBrokerUrl()).toBe('ws://127.0.0.1:8765');

    process.env.HERMES_CHROME_HOST = 'localhost';
    expect(getBrokerUrl()).toBe('ws://localhost:8765');

    process.env.HERMES_CHROME_HOST = '::1';
    expect(getBrokerUrl()).toBe('ws://[::1]:8765');
  });
});
