import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadCdp() {
  const context = vm.createContext({ URL });
  vm.runInContext(readFileSync(join(process.cwd(), 'extension/cdp.js'), 'utf8'), context);
  return (context as { BrowserControlCdp: any }).BrowserControlCdp;
}

describe('CDP method allowlist', () => {
  const cdp = loadCdp();

  it('permits only Input.dispatchMouseEvent and Input.dispatchKeyEvent', () => {
    expect(cdp.ALLOWED_METHODS).toEqual(['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent']);
    expect(() => cdp.assertCdpMethod('Input.dispatchMouseEvent')).not.toThrow();
    expect(() => cdp.assertCdpMethod('Input.dispatchKeyEvent')).not.toThrow();
  });

  it('rejects forbidden and unimplemented CDP methods before send', () => {
    for (const method of [
      'Network.enable',
      'Network.getResponseBody',
      'Fetch.enable',
      'Network.setRequestInterception',
      'Network.continueInterceptedRequest',
      'Runtime.evaluate'
    ]) {
      expect(() => cdp.assertCdpMethod(method)).toThrow(`CDP_METHOD_NOT_PERMITTED: ${method}`);
    }
  });

  it('builds mouse and key command lists on the allowlist', () => {
    for (const command of [...cdp.clickCommands(10, 20), ...cdp.typeTextCommands('Hi'), ...cdp.keypressCommands('Enter')]) {
      expect(cdp.ALLOWED_METHODS).toContain(command.method);
    }
  });
});
