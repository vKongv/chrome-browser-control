import { describe, expect, it, vi, afterEach } from 'vitest';
import { CdpBrowser } from '../server/cdp.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CdpBrowser', () => {
  it('lists inspectable CDP targets with explicit source and without fake active state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { id: 'internal', type: 'browser', title: 'Browser' },
      { id: 'a', type: 'page', title: 'Example', url: 'https://example.com', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/a' },
      { id: 'b', type: 'page', title: 'Other', url: 'https://other.example', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/b' }
    ]), { status: 200 })) as any);

    const browser = new CdpBrowser({ baseUrl: 'http://127.0.0.1:9222' });
    const tabs = await (browser as any).listTabs();

    expect(tabs).toEqual([
      { id: 1, cdpId: 'a', title: 'Example', url: 'https://example.com', type: 'page', source: 'cdp' },
      { id: 2, cdpId: 'b', title: 'Other', url: 'https://other.example', type: 'page', source: 'cdp' }
    ]);
    expect(tabs[0]).not.toHaveProperty('active');
    expect(tabs[0]).not.toHaveProperty('highlighted');
  });
});
