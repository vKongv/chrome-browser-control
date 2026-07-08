import { Window as HappyWindow } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __testing,
  buildSnapshotFromDocument,
  buildVisibleSnapshotFromDocument,
  collectScroll,
  cleanupRefStore,
  extractElements,
  extractFeedPosts,
  findByRef,
  getConsoleLogs,
  installConsoleCapture,
  isPasswordLike,
  pageStatus,
  performClick,
  performClickAt,
  performKeypress,
  queryElements,
  waitForCondition,
  performType
} from '../extension/content-core.module.js';

function makeDocument(html: string) {
  const window = new HappyWindow({ url: 'https://example.test/' });
  window.document.write(html);
  return window.document;
}

function setRect(element: any, rect: { x: number; y: number; width: number; height: number }) {
  if (!element) throw new Error('missing test element');
  const full = {
    ...rect,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height
  };
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => full
  });
}

describe('extension content core', () => {
  afterEach(() => {
    __testing.resetRefStore();
    __testing.clearConsoleLogs();
  });

  it('builds a compact snapshot with stable refs for interactive elements by default', () => {
    const document = makeDocument(`
      <title>Demo</title>
      <main>
        <a href="/next">Next page</a>
        <button aria-label="Save changes">Save</button>
        <input placeholder="Email address" />
      </main>
    `);

    const snapshot = buildSnapshotFromDocument(document as unknown as Document);

    expect(snapshot.title).toBe('Demo');
    expect(snapshot.mode).toBe('compact');
    expect(snapshot.elements).toMatchObject([
      { role: 'link', label: 'Next page' },
      { role: 'button', label: 'Save changes' },
      { role: 'textbox', label: 'Email address' }
    ]);
    expect(snapshot.elements[1].ref).toMatch(/^h[0-9a-z]+$/);
    expect(document.querySelector(`[data-cbc-ref="${snapshot.elements[1].ref}"]`)?.textContent).toBe('Save');
  });

  it('supports full mode with the legacy verbose fields', () => {
    const document = makeDocument('<button>Save</button><p>Body text</p>');

    const snapshot = buildSnapshotFromDocument(document as unknown as Document, { mode: 'full' });

    expect(snapshot).not.toHaveProperty('mode');
    expect(snapshot.elements[0]).toMatchObject({ role: 'button', label: 'Save', tag: 'button', passwordLike: false });
    expect(snapshot.elements[0]).toHaveProperty('bounds');
    expect(snapshot.text).toContain('Body text');
  });

  it('builds a visible snapshot with viewport metadata and visible bounds only', () => {
    const document = makeDocument(`
      <button id="visible">Visible</button>
      <button id="offscreen">Offscreen</button>
      <button id="zero">Zero</button>
    `);
    Object.defineProperty(document.defaultView, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(document.defaultView, 'innerHeight', { configurable: true, value: 600 });
    setRect(document.querySelector('#visible'), { x: 10, y: 20, width: 100, height: 30 });
    setRect(document.querySelector('#offscreen'), { x: 10, y: 800, width: 100, height: 30 });
    setRect(document.querySelector('#zero'), { x: 10, y: 20, width: 0, height: 0 });

    const snapshot = buildVisibleSnapshotFromDocument(document as unknown as Document);
    const viaMode = buildSnapshotFromDocument(document as unknown as Document, { mode: 'visible' });

    expect(snapshot.mode).toBe('visible');
    expect(snapshot.viewport).toMatchObject({ width: 800, height: 600 });
    expect(snapshot.elements).toHaveLength(1);
    expect(snapshot.elements[0]).toMatchObject({ role: 'button', label: 'Visible', bounds: { x: 10, y: 20, width: 100, height: 30 } });
    expect(viaMode.elements).toHaveLength(1);
  });

  it('honors a custom textLimit in compact and full modes', () => {
    const body = 'abcdefghij'.repeat(500);
    const document = makeDocument(`<main><p>${body}</p></main>`);

    const compact = buildSnapshotFromDocument(document as unknown as Document, { textLimit: 1200 });
    expect(compact.textPreview).toHaveLength(1200);
    expect(compact.textBytesOmitted).toBeGreaterThan(0);

    const full = buildSnapshotFromDocument(document as unknown as Document, { mode: 'full', textLimit: 2500 });
    expect(full.text).toHaveLength(2500);
    expect(full.textLimitApplied).toBe(2500);
    expect(full.textBytesOmitted).toBeGreaterThan(0);
  });

  it('keeps default text limits when textLimit is omitted', () => {
    const body = 'x'.repeat(10_000);
    const document = makeDocument(`<main><p>${body}</p></main>`);

    const compact = buildSnapshotFromDocument(document as unknown as Document);
    expect(compact.textPreview).toHaveLength(500);
    expect(compact.textBytesOmitted).toBe(9500);
    expect(compact.textTotalLength).toBe(10_000);
    expect(compact.warning).toContain('textLimit');

    const full = buildSnapshotFromDocument(document as unknown as Document, { mode: 'full' });
    expect(full.text).toHaveLength(4000);
    expect(full.textBytesOmitted).toBe(6000);
    expect(full.textTotalLength).toBe(10_000);
    expect(full.warning).toContain('textLimit');
  });

  it('omits truncation warning when textLimit is explicitly requested', () => {
    const body = 'x'.repeat(10_000);
    const document = makeDocument(`<main><p>${body}</p></main>`);

    const snapshot = buildSnapshotFromDocument(document as unknown as Document, { mode: 'full', textLimit: 4000 });
    expect(snapshot.textBytesOmitted).toBe(6000);
    expect(snapshot).not.toHaveProperty('warning');
  });

  it('clamps textLimit to the maximum allowed value', () => {
    const body = 'y'.repeat(150_000);
    const document = makeDocument(`<main><p>${body}</p></main>`);

    const snapshot = buildSnapshotFromDocument(document as unknown as Document, { textLimit: 200_000 });
    expect(snapshot.textPreview).toHaveLength(100_000);
    expect(snapshot.textBytesOmitted).toBe(50_000);
  });

  it('detects password and one-time-code fields', () => {
    const document = makeDocument(`
      <input id="password" type="password" />
      <input id="otp" autocomplete="one-time-code" />
      <input id="normal" placeholder="Email" />
    `);

    expect(isPasswordLike(document.querySelector('#password') as unknown as Element)).toBe(true);
    expect(isPasswordLike(document.querySelector('#otp') as unknown as Element)).toBe(true);
    expect(isPasswordLike(document.querySelector('#normal') as unknown as Element)).toBe(false);
  });

  it('queries elements by selector, role, text, visibility, and limit', () => {
    const document = makeDocument(`
      <button id="save">Save changes</button>
      <button id="cancel">Cancel</button>
      <a id="docs" href="/docs">Docs</a>
    `);
    Object.defineProperty(document.defaultView, 'innerWidth', { configurable: true, value: 300 });
    Object.defineProperty(document.defaultView, 'innerHeight', { configurable: true, value: 200 });
    setRect(document.querySelector('#save'), { x: 10, y: 10, width: 80, height: 20 });
    setRect(document.querySelector('#cancel'), { x: 10, y: 250, width: 80, height: 20 });
    setRect(document.querySelector('#docs'), { x: 20, y: 20, width: 40, height: 20 });

    const buttons = queryElements({ role: 'button', visible: true, limit: 1 }, document as unknown as Document);
    expect(buttons.count).toBe(1);
    expect(buttons.omitted).toBe(0);
    expect(buttons.matches[0]).toMatchObject({ label: 'Save changes', visible: true });

    const text = queryElements({ text: 'docs' }, document as unknown as Document);
    expect(text.matches[0]).toMatchObject({ role: 'link', href: 'https://example.test/docs' });
  });

  it('extracts bounded element data and omitted counts', () => {
    const document = makeDocument(`
      <article><a href="/a">Alpha</a><time datetime="2026-01-01">Jan 1</time><p>${'A'.repeat(2000)}</p></article>
      <article><a href="/b">Beta</a><p>Second</p></article>
    `);

    const result = extractElements(
      { selector: 'article', limit: 1, includeText: true, includeHtml: true, includeLinks: true, includeTimes: true },
      document as unknown as Document
    );

    expect(result.count).toBe(2);
    expect(result.omitted).toBe(1);
    expect(result.items[0].text).toHaveLength(1000);
    expect(result.items[0].html).toHaveLength(2000);
    expect(result.items[0].links).toEqual([{ href: 'https://example.test/a', text: 'Alpha' }]);
    expect(result.items[0].time).toEqual({ datetime: '2026-01-01', text: 'Jan 1' });
  });

  it('redacts sensitive attributes from extracted html and marks sensitive items', () => {
    const document = makeDocument(`
      <form
        data-secret="form-secret"
        data-public="safe"
      >
        <input type="hidden" name="csrf_token" value="csrf-secret" />
        <input type="password" name="password" value="password-secret" autocomplete="current-password" />
        <input autocomplete="one-time-code" value="123456" />
      </form>
    `);

    const result = extractElements(
      { selector: 'form', includeHtml: true, includeText: false },
      document as unknown as Document
    );

    expect(result.items[0]).toMatchObject({
      sensitive: true,
      passwordLike: true,
      redactedAttributes: expect.any(Number)
    });
    expect(result.items[0].redactedAttributes).toBeGreaterThanOrEqual(4);
    expect(result.items[0].html).toContain('data-public="safe"');
    expect(result.items[0].html).toContain('value="[redacted]"');
    expect(result.items[0].html).toContain('data-secret="[redacted]"');
    expect(result.items[0].html).not.toContain('form-secret');
    expect(result.items[0].html).not.toContain('csrf-secret');
    expect(result.items[0].html).not.toContain('password-secret');
    expect(result.items[0].html).not.toContain('123456');
    expect(result.items[0].text).toBeUndefined();
  });

  it('respects includeText false and only defaults text when no extract fields are requested', () => {
    const document = makeDocument('<article><a href="/a">Alpha</a><time datetime="2026-01-01">Jan 1</time></article>');

    const defaultResult = extractElements({ selector: 'article' }, document as unknown as Document);
    const htmlOnly = extractElements({ selector: 'article', includeHtml: true }, document as unknown as Document);
    const linksOnly = extractElements({ selector: 'article', includeLinks: true, includeText: false }, document as unknown as Document);

    expect(defaultResult.items[0].text).toBe('AlphaJan 1');
    expect(htmlOnly.items[0].html).toContain('<article');
    expect(htmlOnly.items[0].text).toBeUndefined();
    expect(linksOnly.items[0].links).toEqual([{ href: 'https://example.test/a', text: 'Alpha' }]);
    expect(linksOnly.items[0].text).toBeUndefined();
  });

  it('blocks typing into password-like fields unless force=true', () => {
    const document = makeDocument('<input type="password" placeholder="Password" />');
    const snapshot = buildSnapshotFromDocument(document as unknown as Document);
    const ref = snapshot.elements[0].ref;

    expect(() => performType({ ref, text: 'secret' }, document as unknown as Document)).toThrow('password/2FA');

    const result = performType({ ref, text: 'secret', force: true }, document as unknown as Document);
    expect(result).toEqual({ typed: 6, ref });
    const input = document.querySelector('input') as unknown as HTMLInputElement;
    expect(input.value).toBe('secret');
  });

  it('keeps refs stable when DOM order changes before an existing control', () => {
    const document = makeDocument('<main><button id="save">Save</button></main>');
    const first = buildSnapshotFromDocument(document as unknown as Document);
    const saveRef = first.elements[0].ref;

    document.querySelector('main')?.insertAdjacentHTML('afterbegin', '<button id="new">New</button>');
    const second = buildSnapshotFromDocument(document as unknown as Document);

    expect(second.elements.find((item) => item.label === 'Save')?.ref).toBe(saveRef);
    expect(second.elements.find((item) => item.label === 'New')?.ref).not.toBe(saveRef);
  });

  it('fails cleanly for stale refs after element removal and cleanup', () => {
    const document = makeDocument('<button id="save">Save</button>');
    const ref = buildSnapshotFromDocument(document as unknown as Document).elements[0].ref;
    document.querySelector('#save')?.remove();

    cleanupRefStore(document as unknown as Document);

    expect(findByRef(ref, document as unknown as Document)).toBeNull();
    expect(() => performType({ ref, text: 'x', force: true }, document as unknown as Document)).toThrow('Refresh snapshot');
  });

  it('prunes refs by TTL and max cap', () => {
    const document = makeDocument('<button>A</button><button>B</button><button>C</button>');
    __testing.configureRefStore({ ttlMs: 5, max: 2 });

    buildSnapshotFromDocument(document as unknown as Document, { now: 100 });
    expect(__testing.refStoreSize()).toBe(2);

    cleanupRefStore(document as unknown as Document, 106);
    expect(__testing.refStoreSize()).toBe(0);
  });

  it('rejects click/type for TTL-pruned refs until a fresh snapshot creates a new ref', () => {
    const document = makeDocument('<button id="save">Save</button><input id="name" />');
    __testing.configureRefStore({ ttlMs: 5, max: 10 });
    const snapshot = buildSnapshotFromDocument(document as unknown as Document, { now: 100 });
    const buttonRef = snapshot.elements[0].ref;
    const inputRef = snapshot.elements[1].ref;
    let clicks = 0;
    document.querySelector('#save')?.addEventListener('click', () => clicks++);

    cleanupRefStore(document as unknown as Document, 106);

    expect(document.querySelector(`[data-cbc-ref="${buttonRef}"]`)).toBeNull();
    expect(document.querySelector(`[data-cbc-ref="${inputRef}"]`)).toBeNull();
    expect(findByRef(buttonRef, document as unknown as Document)).toBeNull();
    expect(() => performClick({ ref: buttonRef }, document as unknown as Document)).toThrow('Refresh snapshot');
    expect(() => performType({ ref: inputRef, text: 'Ada' }, document as unknown as Document)).toThrow('Refresh snapshot');
    expect(clicks).toBe(0);

    __testing.configureRefStore({ ttlMs: 10_000, max: 10 });
    const fresh = buildSnapshotFromDocument(document as unknown as Document);
    const freshButtonRef = fresh.elements[0].ref;
    expect(freshButtonRef).not.toBe(buttonRef);
    expect(performClick({ ref: freshButtonRef }, document as unknown as Document)).toEqual({ clicked: freshButtonRef });
    expect(clicks).toBe(1);
  });

  it('rejects click/type for max-cap-pruned refs until a fresh snapshot creates a new ref', () => {
    const document = makeDocument('<button id="first">First</button><input id="second" /><button id="third">Third</button>');
    __testing.configureRefStore({ ttlMs: 10_000, max: 1 });
    const snapshot = buildSnapshotFromDocument(document as unknown as Document, { now: 100 });
    const firstRef = snapshot.elements[0].ref;
    const secondRef = snapshot.elements[1].ref;
    const thirdRef = snapshot.elements[2].ref;
    let clicks = 0;
    document.querySelector('#first')?.addEventListener('click', () => clicks++);

    expect(__testing.refStoreSize()).toBe(1);
    expect(document.querySelector(`[data-cbc-ref="${firstRef}"]`)).toBeNull();
    expect(document.querySelector(`[data-cbc-ref="${secondRef}"]`)).toBeNull();
    expect(document.querySelector(`[data-cbc-ref="${thirdRef}"]`)).not.toBeNull();
    expect(() => performClick({ ref: firstRef }, document as unknown as Document)).toThrow('Refresh snapshot');
    expect(() => performType({ ref: secondRef, text: 'Ada' }, document as unknown as Document)).toThrow('Refresh snapshot');
    expect(clicks).toBe(0);

    __testing.configureRefStore({ ttlMs: 10_000, max: 10 });
    const fresh = buildSnapshotFromDocument(document as unknown as Document);
    const freshFirstRef = fresh.elements[0].ref;
    expect(freshFirstRef).not.toBe(firstRef);
    expect(performClick({ ref: freshFirstRef }, document as unknown as Document)).toEqual({ clicked: freshFirstRef });
    expect(clicks).toBe(1);
  });

  it('clicks viewport coordinates and dispatches keyboard events', () => {
    const document = makeDocument('<button id="save">Save</button><input id="name" />');
    const button = document.querySelector('#save') as unknown as HTMLElement;
    const input = document.querySelector('#name') as unknown as HTMLElement;
    (document as any).elementFromPoint = () => button;
    let clicks = 0;
    const keys: string[] = [];
    button.addEventListener('click', () => clicks++);
    input.addEventListener('keydown', (event) => keys.push((event as KeyboardEvent).key));
    input.focus();

    expect(performClickAt({ x: 12, y: 18 }, document as unknown as Document)).toMatchObject({ clicked: true, x: 12, y: 18 });
    expect(clicks).toBe(1);

    expect(performKeypress({ keys: ['Tab', 'Control+Enter'] }, document as unknown as Document)).toEqual({ pressed: ['Tab', 'Control+Enter'] });
    expect(keys).toEqual(['Tab', 'Enter']);
  });

  it('waits for immediate matches and timeout evidence', async () => {
    const document = makeDocument('<main><p>Ready now</p></main>');

    await expect(waitForCondition({ text: 'Ready', timeoutMs: 50 }, document as unknown as Document)).resolves.toMatchObject({
      matched: true,
      reason: 'text'
    });
    await expect(waitForCondition({ selector: '.missing', timeoutMs: 1 }, document as unknown as Document)).resolves.toMatchObject({
      matched: false,
      reason: 'timeout'
    });
  });

  it('returns lightweight page status with resource summary counts', () => {
    const document = makeDocument('<main>Status</main>');
    Object.defineProperty(document.defaultView, 'performance', {
      configurable: true,
      value: {
        getEntriesByType: () => [
          { initiatorType: 'script' },
          { initiatorType: 'script' },
          { initiatorType: 'img' }
        ]
      }
    });

    expect(pageStatus(document as unknown as Document)).toMatchObject({
      title: '',
      url: 'https://example.test/',
      resourceSummary: { count: 3, omitted: 0, byType: { script: 2, img: 1 } }
    });
  });

  it('captures bounded console logs after capture installation', () => {
    const writes: string[] = [];
    const fakeWindow = {
      console: {
        log: (...args: unknown[]) => writes.push(args.join(' ')),
        error: (...args: unknown[]) => writes.push(args.join(' '))
      }
    };

    installConsoleCapture(fakeWindow as unknown as Window);
    (fakeWindow.console as any).log('hello', { ok: true });
    (fakeWindow.console as any).error('boom');

    expect(getConsoleLogs({ levels: ['error'], limit: 1 })).toMatchObject({
      logs: [{ level: 'error', text: 'boom' }],
      omitted: 0,
      capture: 'after-content-script-injection'
    });
    expect(writes).toEqual(['hello [object Object]', 'boom']);
  });

  it('collects while scrolling with caps and dedupe', async () => {
    const document = makeDocument(`
      <article><a href="/a">Alpha</a><p>Alpha text</p></article>
      <article><a href="/b">Beta</a><p>Beta text</p></article>
    `);
    let scrolls = 0;
    const fakeWindow = {
      document,
      scrollBy: () => {
        scrolls += 1;
      }
    };

    const result = await collectScroll(
      {
        steps: 2,
        delayMs: 0,
        extract: { selector: 'article', includeText: true, includeLinks: true, limitPerStep: 5 },
        dedupeBy: 'href'
      },
      document as unknown as Document,
      fakeWindow as unknown as Window
    );

    expect(result.count).toBe(2);
    expect(result.dedupedCount).toBe(2);
    expect(result.stepsRun).toBe(2);
    expect(scrolls).toBe(1);
  });

  it('caps aggregate collect_scroll output and reports truncated items', async () => {
    const document = makeDocument(`
      <article>One</article>
      <article>Two</article>
      <article>Three</article>
      <article>Four</article>
    `);
    let scrolls = 0;
    const fakeWindow = {
      document,
      scrollBy: () => {
        scrolls += 1;
      }
    };

    const result = await collectScroll(
      {
        steps: 3,
        delayMs: 0,
        maxItems: 3,
        extract: { selector: 'article', includeText: true, limitPerStep: 4 },
        dedupeBy: 'none'
      },
      document as unknown as Document,
      fakeWindow as unknown as Window
    );

    expect(result.items).toHaveLength(3);
    expect(result.count).toBe(3);
    expect(result.maxItems).toBe(3);
    expect(result.truncatedCount).toBe(9);
    expect(result.omitted).toBe(9);
    expect(result.dedupedCount).toBe(0);
    expect(result.stepsRun).toBe(3);
    expect(scrolls).toBe(2);
  });

  it('caps collect_scroll delay to stay within the broker timeout budget', async () => {
    const document = makeDocument('<article>One</article>');
    const delays: number[] = [];
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler, delay?: number) => {
      delays.push(Number(delay));
      if (typeof callback === 'function') callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    try {
      await collectScroll(
        {
          steps: 2,
          delayMs: 5000,
          extract: { selector: 'article', includeText: true }
        },
        document as unknown as Document,
        { document, scrollBy: () => undefined } as unknown as Window
      );
    } finally {
      timer.mockRestore();
    }

    expect(delays).toEqual([1000]);
  });

  it('compact output is at least 50 percent smaller than full output on dense pages', () => {
    const controls = Array.from({ length: 120 }, (_, i) => `<button aria-label="Action ${i}">Action ${i}</button>`).join('');
    const text = '<p>' + 'Long marketing copy '.repeat(500) + '</p>';
    const document = makeDocument(`<main>${controls}${text}</main>`);

    const compactBytes = JSON.stringify(buildSnapshotFromDocument(document as unknown as Document)).length;
    const fullBytes = JSON.stringify(buildSnapshotFromDocument(document as unknown as Document, { mode: 'full' })).length;

    expect(compactBytes).toBeLessThan(fullBytes * 0.5);
  });

  it('defaults compact snapshots to main scope and omits nav/footer text', () => {
    const document = makeDocument(`
      <nav>Sidebar navigation noise</nav>
      <main><p>Main feed content for audit</p><button>Like</button></main>
      <footer>Footer legal copy</footer>
    `);

    const snapshot = buildSnapshotFromDocument(document as unknown as Document);

    expect(snapshot.scopeApplied).toBe('main');
    expect(snapshot.textPreview).toContain('Main feed content');
    expect(snapshot.textPreview).not.toContain('Sidebar navigation');
    expect(snapshot.textPreview).not.toContain('Footer legal');
  });

  it('uses document scope when explicitly requested', () => {
    const document = makeDocument(`
      <nav>Sidebar navigation noise</nav>
      <main><p>Main feed content</p></main>
    `);

    const snapshot = buildSnapshotFromDocument(document as unknown as Document, { scope: 'document' });

    expect(snapshot.scopeApplied).toBe('document');
    expect(snapshot.textPreview).toContain('Sidebar navigation');
  });

  it('excludes dialog role subtrees from scoped compact snapshots by default', () => {
    const document = makeDocument(`
      <main>
        <p>Feed text</p>
        <div role="dialog"><p>Messenger chat noise</p><button>Close chat</button></div>
      </main>
    `);

    const snapshot = buildSnapshotFromDocument(document as unknown as Document);

    expect(snapshot.textPreview).toContain('Feed text');
    expect(snapshot.textPreview).not.toContain('Messenger chat');
    expect(snapshot.excludedCount).toBeGreaterThan(0);
  });

  it('extracts structured feed posts with times when present', () => {
    const document = makeDocument(`
      <main role="feed">
        <article>
          <h3>Alice</h3>
          <p>First post body</p>
          <time datetime="2026-07-08T10:00:00Z">2h</time>
        </article>
        <article>
          <h3>Bob</h3>
          <p>Second post body</p>
          <time datetime="2026-07-08T08:00:00Z">4h</time>
        </article>
        <article>
          <h3>Carol</h3>
          <p>Third post body <span aria-label="Live now">LIVE</span></p>
        </article>
      </main>
    `);

    const result = extractFeedPosts(document as unknown as Document, { maxPosts: 10 });

    expect(result.count).toBeGreaterThanOrEqual(3);
    expect(result.posts[0]).toMatchObject({
      author: 'Alice',
      text: expect.stringContaining('First post body'),
      absoluteTime: '2026-07-08T10:00:00Z',
      relativeTime: '2h'
    });
    expect(result.posts[2].isLive).toBe(true);
    expect(result.scopeApplied).toBe('feed');
  });

  it('supports extended wait_for conditions', async () => {
    const document = makeDocument(`
      <main><p>Scoped ready text</p></main>
      <div id="spinner">Loading</div>
    `);

    await expect(
      waitForCondition({ textInScope: 'Scoped ready', scope: 'main', timeoutMs: 50 }, document as unknown as Document)
    ).resolves.toMatchObject({ matched: true, condition: 'textInScope' });

    const spinner = document.getElementById('spinner');
    spinner?.remove();

    await expect(
      waitForCondition({ selector: '#spinner', selectorAbsent: true, timeoutMs: 50 }, document as unknown as Document)
    ).resolves.toMatchObject({ matched: true, condition: 'selectorAbsent' });
  });
});
