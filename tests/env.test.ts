import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSafeHost,
  formatBrokerWsUrl,
  getBrokerHost,
  getBrokerPort,
  getBrokerUrl,
  getToken,
  resetEnvLoadForTests,
  resolveToken
} from '../server/env.js';

const originalToken = process.env.CHROME_BROWSER_CONTROL_TOKEN;
const originalHost = process.env.CHROME_BROWSER_CONTROL_HOST;
const originalPort = process.env.CHROME_BROWSER_CONTROL_PORT;
const originalDisableLocalEnv = process.env.CHROME_BROWSER_CONTROL_DISABLE_LOCAL_ENV;
const originalHome = process.env.HOME;
let tempHome = '';

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'cbc-env-test-'));
  process.env.HOME = tempHome;
  process.env.CHROME_BROWSER_CONTROL_DISABLE_LOCAL_ENV = '1';
  resetEnvLoadForTests();
});

afterEach(() => {
  resetEnvLoadForTests();
  if (originalToken === undefined) {
    delete process.env.CHROME_BROWSER_CONTROL_TOKEN;
  } else {
    process.env.CHROME_BROWSER_CONTROL_TOKEN = originalToken;
  }
  if (originalHost === undefined) {
    delete process.env.CHROME_BROWSER_CONTROL_HOST;
  } else {
    process.env.CHROME_BROWSER_CONTROL_HOST = originalHost;
  }
  if (originalPort === undefined) {
    delete process.env.CHROME_BROWSER_CONTROL_PORT;
  } else {
    process.env.CHROME_BROWSER_CONTROL_PORT = originalPort;
  }
  if (originalDisableLocalEnv === undefined) {
    delete process.env.CHROME_BROWSER_CONTROL_DISABLE_LOCAL_ENV;
  } else {
    process.env.CHROME_BROWSER_CONTROL_DISABLE_LOCAL_ENV = originalDisableLocalEnv;
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = '';
  }
});

describe('env helpers', () => {
  it('resolves token issues without throwing', () => {
    delete process.env.CHROME_BROWSER_CONTROL_TOKEN;
    expect(resolveToken()).toEqual({ issue: 'missing' });

    process.env.CHROME_BROWSER_CONTROL_TOKEN = 'short';
    expect(resolveToken()).toEqual({ issue: 'invalid' });

    process.env.CHROME_BROWSER_CONTROL_TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-';
    expect(resolveToken()).toEqual({ token: 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-' });
  });

  it('requires a configured token', () => {
    delete process.env.CHROME_BROWSER_CONTROL_TOKEN;
    expect(() => getToken()).toThrow('CHROME_BROWSER_CONTROL_TOKEN is required');

    process.env.CHROME_BROWSER_CONTROL_TOKEN = ['dev', 'token', 'change', 'me'].join('-');
    expect(() => getToken()).toThrow('Refusing insecure default');

    process.env.CHROME_BROWSER_CONTROL_TOKEN = 'short';
    expect(() => getToken()).toThrow('at least 32 URL-safe random characters');

    process.env.CHROME_BROWSER_CONTROL_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(() => getToken()).toThrow('enough character variety');

    process.env.CHROME_BROWSER_CONTROL_TOKEN = '11111111111111111111111111111111';
    expect(() => getToken()).toThrow('enough character variety');

    process.env.CHROME_BROWSER_CONTROL_TOKEN = 'abababababababababababababababab';
    expect(() => getToken()).toThrow('enough character variety');

    process.env.CHROME_BROWSER_CONTROL_TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-';
    expect(getToken()).toBe('abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-');
  });

  it('defaults broker host and port', () => {
    delete process.env.CHROME_BROWSER_CONTROL_PORT;
    delete process.env.CHROME_BROWSER_CONTROL_HOST;
    expect(getBrokerPort()).toBe(8765);

    process.env.CHROME_BROWSER_CONTROL_PORT = '8765';
    expect(getBrokerPort()).toBe(8765);
    process.env.CHROME_BROWSER_CONTROL_HOST = '127.0.0.1';
    expect(getBrokerHost()).toBe('127.0.0.1');

    process.env.CHROME_BROWSER_CONTROL_HOST = 'localhost';
    expect(getBrokerUrl()).toBe('ws://localhost:8765');

    process.env.CHROME_BROWSER_CONTROL_HOST = '::1';
    expect(getBrokerUrl()).toBe('ws://[::1]:8765');
  });

  it('brackets IPv6 hosts in formatBrokerWsUrl', () => {
    expect(formatBrokerWsUrl('::1', 8765)).toBe('ws://[::1]:8765');
    expect(formatBrokerWsUrl('[::1]', 8765)).toBe('ws://[::1]:8765');
    expect(formatBrokerWsUrl('127.0.0.1', 8765)).toBe('ws://127.0.0.1:8765');
  });

  it('rejects non-loopback broker hosts', () => {
    expect(() => assertSafeHost('0.0.0.0')).toThrow('non-loopback host');
  });
});
