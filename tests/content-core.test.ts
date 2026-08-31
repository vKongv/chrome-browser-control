import { Window as HappyWindow } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __testing,
  boundsForRef,
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
  prepareTrustedClickAt,
  prepareTrustedKeypress,
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

  it('fails trusted iframe coordinate mapping with CDP_CROSS_ORIGIN_FRAME', () => {
    const document = makeDocument('<button id="save">Save</button>');
    const view = document.defaultView as unknown as { top: unknown; frameElement: unknown };
    Object.defineProperty(view, 'top', { configurable: true, value: {} });
    Object.defineProperty(view, 'frameElement', { configurable: true, value: null });

    expect(() => prepareTrustedClickAt({ x: 12, y: 18 }, document as unknown as Document)).toThrow('CDP_CROSS_ORIGIN_FRAME');
  });

  it('focuses the targeted document before a trusted keypress', () => {
    const parent = makeDocument('<input id="parent-input" />');
    const child = makeDocument('<input id="child-input" />');
    const parentInput = parent.querySelector('#parent-input') as unknown as HTMLElement;
    const childInput = child.querySelector('#child-input') as unknown as HTMLElement;
    parentInput.focus();
    childInput.focus();

    const parentFocus = vi.spyOn(parentInput, 'focus');
    const childFocus = vi.spyOn(childInput, 'focus');
    const childWindowFocus = vi.spyOn(child.defaultView as unknown as { focus: () => void }, 'focus');

    expect(prepareTrustedKeypress({ keys: 'Enter' }, child as unknown as Document)).toEqual({
      prepared: true,
      keys: ['Enter']
    });
    expect(childWindowFocus).toHaveBeenCalled();
    expect(child.activeElement).toBe(childInput);
    expect(childFocus).not.toHaveBeenCalled();
    expect(parentFocus).not.toHaveBeenCalled();
  });

  it('does not move trusted-keypress focus off an inner shadow control', () => {
    const document = makeDocument('<div id="host"></div>');
    const host = document.querySelector('#host') as unknown as HTMLElement;
    host.tabIndex = 0;
    const shadow = host.attachShadow({ mode: 'open' });
    const first = document.createElement('input');
    first.id = 'first';
    const second = document.createElement('input');
    second.id = 'second';
    shadow.append(first, second);
    second.focus();

    expect(document.activeElement).toBe(host);
    expect(shadow.activeElement).toBe(second);

    expect(prepareTrustedKeypress({ keys: 'Enter' }, document as unknown as Document)).toEqual({
      prepared: true,
      keys: ['Enter']
    });

    expect(shadow.activeElement).toBe(second);
    expect(document.activeElement).toBe(host);
  });

  it('fails click, type, click_at, and keypress on hidden documents unless allowHidden is true', () => {
    const document = makeDocument('<button id="save">Save</button><input id="name" />');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const snapshot = buildSnapshotFromDocument(document as unknown as Document);
    const buttonRef = snapshot.elements[0].ref;
    const inputRef = snapshot.elements[1].ref;
    const button = document.querySelector('#save') as unknown as HTMLElement;
    const input = document.querySelector('#name') as unknown as HTMLElement;
    (document as any).elementFromPoint = () => button;
    let clicks = 0;
    const keys: string[] = [];
    button.addEventListener('click', () => clicks++);
    input.addEventListener('keydown', (event) => keys.push((event as KeyboardEvent).key));
    input.focus();

    const hiddenError = /DOCUMENT_HIDDEN:[\s\S]*activate_tab/;
    expect(() => performClick({ ref: buttonRef }, document as unknown as Document)).toThrow(hiddenError);
    expect(() => performType({ ref: inputRef, text: 'Ada' }, document as unknown as Document)).toThrow(hiddenError);
    expect(() => performClickAt({ x: 12, y: 18 }, document as unknown as Document)).toThrow(hiddenError);
    expect(() => performKeypress({ keys: 'Enter' }, document as unknown as Document)).toThrow(hiddenError);
    expect(clicks).toBe(0);
    expect(keys).toEqual([]);
    expect((document.querySelector('#name') as unknown as HTMLInputElement).value).toBe('');

    expect(performClick({ ref: buttonRef, allowHidden: true }, document as unknown as Document)).toEqual({
      clicked: buttonRef
    });
    expect(performType({ ref: inputRef, text: 'Ada', allowHidden: true }, document as unknown as Document)).toEqual({
      typed: 3,
      ref: inputRef
    });
    expect(performClickAt({ x: 12, y: 18, allowHidden: true }, document as unknown as Document)).toMatchObject({
      clicked: true,
      x: 12,
      y: 18
    });
    expect(performKeypress({ keys: 'Enter', allowHidden: true }, document as unknown as Document)).toEqual({
      pressed: ['Enter']
    });
    expect(clicks).toBe(2);
    expect(keys).toEqual(['Enter']);
    expect((document.querySelector('#name') as unknown as HTMLInputElement).value).toBe('Ada');
  });

  it('keeps read-shaped tools available on hidden documents', () => {
    const document = makeDocument('<main><button id="save">Save</button><article>Post</article></main>');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });

    const snapshot = buildSnapshotFromDocument(document as unknown as Document);
    expect(snapshot.elements[0]).toMatchObject({ role: 'button', label: 'Save' });
    expect(queryElements({ selector: 'button' }, document as unknown as Document).count).toBe(1);
    expect(extractElements({ selector: 'article' }, document as unknown as Document).items[0].text).toBe('Post');
    expect(pageStatus(document as unknown as Document)).toMatchObject({ visibilityState: 'hidden' });
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
    expect(result.stoppedReason).toBe('stepsExhausted');
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
    expect(result.truncatedCount).toBe(1);
    expect(result.omitted).toBe(1);
    expect(result.dedupedCount).toBe(0);
    expect(result.stepsRun).toBe(1);
    expect(result.stoppedReason).toBe('maxItems');
    expect(scrolls).toBe(0);
  });

  it('scrolls a nested overflow container when scroll x/y are provided', async () => {
    const document = makeDocument(`
      <div id="feed" style="overflow:auto;height:40px"><article>One</article></div>
    `);
    const feed = document.querySelector('#feed') as any;
    let containerScrolls = 0;
    feed.scrollBy = () => {
      containerScrolls += 1;
    };
    Object.defineProperty(feed, 'scrollHeight', { configurable: true, value: 200 });
    Object.defineProperty(feed, 'clientHeight', { configurable: true, value: 40 });
    (document as any).elementFromPoint = () => feed;
    const fakeWindow = {
      document,
      scrollBy: () => {
        throw new Error('window scroll should not run');
      },
      getComputedStyle: () => ({ overflow: 'auto', overflowY: 'auto', overflowX: 'hidden' })
    };

    const result = await collectScroll(
      {
        steps: 2,
        delayMs: 0,
        scroll: { x: 10, y: 10, deltaY: 80 },
        extract: { selector: 'article', includeText: true }
      },
      document as unknown as Document,
      fakeWindow as unknown as Window
    );

    expect(result.stepsRun).toBe(2);
    expect(result.stoppedReason).toBe('stepsExhausted');
    expect(containerScrolls).toBe(1);
  });

  it('stops collect_scroll early when until.noNewItemsForSteps is satisfied', async () => {
    const document = makeDocument('<article>One</article>');
    let scrolls = 0;
    const fakeWindow = {
      document,
      scrollBy: () => {
        scrolls += 1;
      }
    };

    const result = await collectScroll(
      {
        steps: 5,
        delayMs: 0,
        until: { noNewItemsForSteps: 2 },
        extract: { selector: 'article', includeText: true },
        dedupeBy: 'text'
      },
      document as unknown as Document,
      fakeWindow as unknown as Window
    );

    expect(result.count).toBe(1);
    expect(result.stepsRun).toBe(3);
    expect(result.stoppedReason).toBe('noNewItems');
    expect(scrolls).toBe(2);
  });

  it('stops collect_scroll on ISO date cutoff and requires includeTimes', async () => {
    const document = makeDocument(`
      <article><time datetime="2024-01-10T00:00:00.000Z">Jan 10</time>Newer</article>
      <article><time datetime="2023-12-01T00:00:00.000Z">Dec 1</time>Older</article>
    `);
    const fakeWindow = { document, scrollBy: () => undefined };

    await expect(
      collectScroll(
        {
          steps: 3,
          delayMs: 0,
          until: { stopBeforeDatetime: '2024-01-01T00:00:00.000Z' },
          extract: { selector: 'article', includeText: true }
        },
        document as unknown as Document,
        fakeWindow as unknown as Window
      )
    ).rejects.toThrow('includeTimes');

    const result = await collectScroll(
      {
        steps: 3,
        delayMs: 0,
        until: { stopBeforeDatetime: '2024-01-01T00:00:00.000Z' },
        extract: { selector: 'article', includeText: true, includeTimes: true }
      },
      document as unknown as Document,
      fakeWindow as unknown as Window
    );

    expect(result.stoppedReason).toBe('dateCutoff');
    expect(result.stepsRun).toBe(1);
    expect(result.count).toBe(2);
  });

  it('resolves viewport bounds for a snapshot ref', () => {
    const document = makeDocument('<button id="go">Go</button>');
    const button = document.querySelector('#go') as any;
    setRect(button, { x: 12, y: 24, width: 80, height: 20 });
    const snapshot = buildSnapshotFromDocument(document as unknown as Document, { mode: 'full' });
    const ref = snapshot.elements[0].ref;
    Object.defineProperty(document.defaultView, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(document.defaultView, 'innerHeight', { configurable: true, value: 768 });
    Object.defineProperty(document.defaultView, 'devicePixelRatio', { configurable: true, value: 2 });

    expect(boundsForRef(ref, document as unknown as Document)).toEqual({
      bounds: { x: 12, y: 24, width: 80, height: 20 },
      viewport: { width: 1024, height: 768, deviceScaleFactor: 2 }
    });
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

  it('still ignores zero-size dialog subtrees in compact main scope', () => {
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

  describe('compact snapshot dialog visibility', () => {
    const VISIBLE_RECT = { x: 20, y: 20, width: 400, height: 280 };

    function stubModalMatch(element: Element, isModal: boolean) {
      const original = element.matches.bind(element);
      element.matches = (selectors: string) => {
        if (selectors === ':modal') return isModal;
        return original(selectors);
      };
    }

    function showNativeDialog(element: any, modal: boolean) {
      if (modal) element.showModal();
      else element.show();
      stubModalMatch(element, modal);
      setRect(element, VISIBLE_RECT);
    }

    it('scopes compact snapshots to a visible aria-modal dialog, including when it sits outside main', () => {
      const document = makeDocument(`
        <main><p>Campaign list behind the wizard</p><button>Create</button></main>
        <div role="dialog" aria-modal="true"><p>Create campaign wizard</p><button>Next</button></div>
      `);
      setRect(document.querySelector('[role="dialog"]'), VISIBLE_RECT);

      const snapshot = buildSnapshotFromDocument(document as unknown as Document);

      expect(snapshot.scopeApplied).toBe('dialog');
      expect(snapshot.scopeRoot).toMatchObject({ role: 'dialog', selectorHint: '[role="dialog"]' });
      expect(snapshot.textPreview).toContain('Create campaign wizard');
      expect(snapshot.textPreview).not.toContain('Campaign list behind');
      expect(snapshot.elements.map((item) => item.label)).toContain('Next');
      expect(snapshot.elements.map((item) => item.label)).not.toContain('Create');
    });

    it('includes a visible non-modal role=dialog without stealing main scope', () => {
      const document = makeDocument(`
        <main>
          <p>Feed text</p>
          <button>Like</button>
          <div role="dialog"><p>Messenger chat noise</p><button>Close chat</button></div>
        </main>
      `);
      setRect(document.querySelector('[role="dialog"]'), VISIBLE_RECT);

      const snapshot = buildSnapshotFromDocument(document as unknown as Document);

      expect(snapshot.scopeApplied).toBe('main');
      expect(snapshot.textPreview).toContain('Feed text');
      expect(snapshot.textPreview).toContain('Messenger chat');
      expect(snapshot.elements.map((item) => item.label)).toEqual(expect.arrayContaining(['Like', 'Close chat']));
    });

    it('treats showModal() as modal and show() as non-modal; open alone does not steal scope', () => {
      const modalDoc = makeDocument(`
        <main><p>Page behind modal dialog</p><button>Page action</button></main>
        <dialog id="native-modal"><p>Native modal copy</p><button>Modal save</button></dialog>
      `);
      showNativeDialog(modalDoc.getElementById('native-modal'), true);

      const modalSnapshot = buildSnapshotFromDocument(modalDoc as unknown as Document);
      expect(modalSnapshot.scopeApplied).toBe('dialog');
      expect(modalSnapshot.scopeRoot?.tag).toBe('dialog');
      expect(modalSnapshot.textPreview).toContain('Native modal copy');
      expect(modalSnapshot.textPreview).not.toContain('Page behind modal dialog');

      const modelessDoc = makeDocument(`
        <main>
          <p>Page with modeless dialog</p>
          <button>Page action</button>
          <dialog id="native-show"><p>Modeless dialog copy</p><button>Modeless close</button></dialog>
        </main>
      `);
      showNativeDialog(modelessDoc.getElementById('native-show'), false);

      const modelessSnapshot = buildSnapshotFromDocument(modelessDoc as unknown as Document);
      expect(modelessSnapshot.scopeApplied).toBe('main');
      expect(modelessSnapshot.textPreview).toContain('Page with modeless dialog');
      expect(modelessSnapshot.textPreview).toContain('Modeless dialog copy');

      const openOnlyDoc = makeDocument(`
        <main>
          <p>Page with open attribute</p>
          <button>Page action</button>
          <dialog id="open-only" open><p>Open attribute copy</p><button>Open close</button></dialog>
        </main>
      `);
      setRect(openOnlyDoc.getElementById('open-only'), VISIBLE_RECT);

      const openOnlySnapshot = buildSnapshotFromDocument(openOnlyDoc as unknown as Document);
      expect(openOnlySnapshot.scopeApplied).toBe('main');
      expect(openOnlySnapshot.textPreview).toContain('Page with open attribute');
      expect(openOnlySnapshot.textPreview).toContain('Open attribute copy');
    });

    it('scopes to role=alertdialog only when it is genuinely modal', () => {
      const toastDoc = makeDocument(`
        <main>
          <p>Settings page</p>
          <button>Save settings</button>
          <div role="alertdialog"><p>Saved toast</p><button>Dismiss toast</button></div>
        </main>
      `);
      setRect(toastDoc.querySelector('[role="alertdialog"]'), VISIBLE_RECT);

      const toastSnapshot = buildSnapshotFromDocument(toastDoc as unknown as Document);
      expect(toastSnapshot.scopeApplied).toBe('main');
      expect(toastSnapshot.textPreview).toContain('Settings page');
      expect(toastSnapshot.textPreview).toContain('Saved toast');

      const modalDoc = makeDocument(`
        <main><p>Settings page</p><button>Save settings</button></main>
        <div role="alertdialog" aria-modal="true"><p>Confirm delete</p><button>Delete now</button></div>
      `);
      setRect(modalDoc.querySelector('[role="alertdialog"]'), VISIBLE_RECT);

      const modalSnapshot = buildSnapshotFromDocument(modalDoc as unknown as Document);
      expect(modalSnapshot.scopeApplied).toBe('dialog');
      expect(modalSnapshot.textPreview).toContain('Confirm delete');
      expect(modalSnapshot.textPreview).not.toContain('Settings page');
    });

    it('does not change compact output for hidden or closed dialogs', () => {
      const baseHtml = `
        <nav>Sidebar navigation noise</nav>
        <main><p>Main feed content for audit</p><button>Like</button></main>
        <footer>Footer legal copy</footer>
      `;
      const base = buildSnapshotFromDocument(makeDocument(baseHtml) as unknown as Document);

      const displayNone = makeDocument(`
        ${baseHtml}
        <div id="display-none" role="dialog" aria-modal="true" style="display:none"><p>Display none wizard</p><button>Hidden next</button></div>
      `);
      setRect(displayNone.getElementById('display-none'), VISIBLE_RECT);
      const hiddenAttr = makeDocument(`
        ${baseHtml}
        <div id="hidden-attr" role="dialog" aria-modal="true" hidden><p>Hidden attr wizard</p><button>Hidden next</button></div>
      `);
      setRect(hiddenAttr.getElementById('hidden-attr'), VISIBLE_RECT);
      const visibilityHidden = makeDocument(`
        ${baseHtml}
        <div id="vis-hidden" role="dialog" aria-modal="true" style="visibility:hidden"><p>Visibility hidden wizard</p><button>Hidden next</button></div>
      `);
      setRect(visibilityHidden.getElementById('vis-hidden'), VISIBLE_RECT);
      const zeroSize = makeDocument(`
        ${baseHtml}
        <div id="zero-dialog" role="dialog" aria-modal="true"><p>Zero size wizard</p><button>Hidden next</button></div>
      `);
      setRect(zeroSize.getElementById('zero-dialog'), { x: 20, y: 20, width: 0, height: 0 });
      const closedNative = makeDocument(`
        ${baseHtml}
        <dialog id="closed-native" aria-modal="true"><p>Closed dialog wizard</p><button>Hidden next</button></dialog>
      `);
      setRect(closedNative.getElementById('closed-native'), VISIBLE_RECT);

      for (const document of [displayNone, hiddenAttr, visibilityHidden, zeroSize, closedNative]) {
        const snapshot = buildSnapshotFromDocument(document as unknown as Document);
        expect(snapshot.scopeApplied).toBe('main');
        expect(snapshot.textPreview).toBe(base.textPreview);
        expect(snapshot.elements.map((item) => item.label)).toEqual(base.elements.map((item) => item.label));
        expect(JSON.stringify(snapshot)).not.toContain('wizard');
      }
    });

    it('keeps compact snapshots byte-identical when no dialog is present', () => {
      const html = `
        <nav>Sidebar navigation noise</nav>
        <main><p>Main feed content for audit</p><button>Like</button></main>
        <footer>Footer legal copy</footer>
      `;
      const snapshot = buildSnapshotFromDocument(makeDocument(html) as unknown as Document);
      expect(snapshot.scopeApplied).toBe('main');
      expect(snapshot.textPreview).toBe('Main feed content for auditLike');
      expect(snapshot.textPreview).not.toContain('Sidebar navigation');
      expect(snapshot.elements.map((item) => item.label)).toEqual(['Like']);
      expect(snapshot.excludedCount).toBe(0);
    });

    it('picks the last tree-order modal among siblings and the innermost nested modal', () => {
      const siblings = makeDocument(`
        <main><p>Page behind stacked modals</p></main>
        <div role="dialog" aria-modal="true"><p>First modal</p><button>First next</button></div>
        <div role="dialog" aria-modal="true"><p>Second modal</p><button>Second next</button></div>
      `);
      for (const dialog of siblings.querySelectorAll('[role="dialog"]')) setRect(dialog, VISIBLE_RECT);

      const siblingSnapshot = buildSnapshotFromDocument(siblings as unknown as Document);
      expect(siblingSnapshot.scopeApplied).toBe('dialog');
      expect(siblingSnapshot.textPreview).toContain('Second modal');
      expect(siblingSnapshot.textPreview).not.toContain('First modal');
      expect(siblingSnapshot.textPreview).not.toContain('Page behind stacked');

      const nested = makeDocument(`
        <main><p>Page behind nested modals</p></main>
        <div role="dialog" aria-modal="true">
          <p>Outer modal</p>
          <button>Outer next</button>
          <div role="dialog" aria-modal="true"><p>Inner modal</p><button>Inner next</button></div>
        </div>
      `);
      for (const dialog of nested.querySelectorAll('[role="dialog"]')) setRect(dialog, VISIBLE_RECT);

      const nestedSnapshot = buildSnapshotFromDocument(nested as unknown as Document);
      expect(nestedSnapshot.scopeApplied).toBe('dialog');
      expect(nestedSnapshot.textPreview).toContain('Inner modal');
      expect(nestedSnapshot.textPreview).not.toContain('Outer modal');
      expect(nestedSnapshot.textPreview).not.toContain('Page behind nested');
    });

    it('does not steal compact scope for a modal that lives in an iframe', () => {
      const document = makeDocument(`<main><p>Top feed</p><button>Top action</button></main>`);
      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      const iframeDoc = iframe.contentDocument!;
      iframeDoc.write('<div role="dialog" aria-modal="true"><p>Iframe wizard</p><button>Iframe next</button></div>');
      iframeDoc.close?.();
      setRect(iframeDoc.querySelector('[role="dialog"]'), VISIBLE_RECT);

      const snapshot = buildSnapshotFromDocument(document as unknown as Document);
      expect(snapshot.scopeApplied).toBe('main');
      expect(snapshot.textPreview).toContain('Top feed');
      expect(snapshot.textPreview).not.toContain('Iframe wizard');
    });

    it('keeps controls when a visible modal is nested inside a hidden dialog', () => {
      const document = makeDocument(`
        <main><p>Campaign list behind the wizard</p><button>Create</button></main>
        <div role="dialog" hidden>
          <div role="dialog" aria-modal="true"><p>Create campaign wizard</p><button>Next</button></div>
        </div>
      `);
      setRect(document.querySelector('[aria-modal="true"]'), VISIBLE_RECT);

      const snapshot = buildSnapshotFromDocument(document as unknown as Document);
      expect(snapshot.scopeApplied).toBe('dialog');
      expect(snapshot.textPreview).toContain('Create campaign wizard');
      expect(snapshot.elements.map((item) => item.label)).toContain('Next');
    });

    it('does not steal compact scope when an ancestor has opacity 0', () => {
      const document = makeDocument(`
        <main><p>Campaign list behind the wizard</p><button>Create</button></main>
        <div style="opacity:0">
          <div role="dialog" aria-modal="true"><p>Faded wizard</p><button>Next</button></div>
        </div>
      `);
      setRect(document.querySelector('[role="dialog"]'), VISIBLE_RECT);

      const snapshot = buildSnapshotFromDocument(document as unknown as Document);
      expect(snapshot.scopeApplied).toBe('main');
      expect(snapshot.textPreview).toContain('Campaign list behind');
      expect(snapshot.textPreview).not.toContain('Faded wizard');
    });

    it('still scopes to a native showModal() dialog under an opacity 0 ancestor', () => {
      const document = makeDocument(`
        <main><p>backgroundPage</p><button>Page action</button></main>
        <div style="opacity:0">
          <dialog id="top-layer-modal"><p>Top layer wizard</p><button>Modal next</button></dialog>
        </div>
      `);
      showNativeDialog(document.getElementById('top-layer-modal'), true);

      const snapshot = buildSnapshotFromDocument(document as unknown as Document);
      expect(snapshot.scopeApplied).toBe('dialog');
      expect(snapshot.textPreview).toContain('Top layer wizard');
      expect(snapshot.textPreview).not.toContain('backgroundPage');
      expect(snapshot.elements.map((item) => item.label)).toContain('Modal next');
    });

    it('scopes to the later-opened native modal when DOM order is reversed', () => {
      const document = makeDocument(`
        <main><p>Page behind stacked native modals</p></main>
        <dialog id="dialog-a"><p>First in DOM</p><button>A next</button></dialog>
        <dialog id="dialog-b"><p>Second in DOM</p><button>B next</button></dialog>
      `);
      const firstInDom = document.getElementById('dialog-a');
      const secondInDom = document.getElementById('dialog-b');
      showNativeDialog(secondInDom, true);
      showNativeDialog(firstInDom, true);
      document.getElementById('dialog-a')?.querySelector('button')?.focus();

      const snapshot = buildSnapshotFromDocument(document as unknown as Document);
      expect(snapshot.scopeApplied).toBe('dialog');
      expect(snapshot.textPreview).toContain('First in DOM');
      expect(snapshot.textPreview).not.toContain('Second in DOM');
      expect(snapshot.elements.map((item) => item.label)).toContain('A next');
    });

    it('hides a modal alertdialog when ignoreRoles includes dialog', () => {
      const document = makeDocument(`
        <main>
          <p>Settings page</p>
          <button>Save settings</button>
          <div role="alertdialog" aria-modal="true"><p>Confirm delete</p><button>Delete now</button></div>
        </main>
      `);
      setRect(document.querySelector('[role="alertdialog"]'), VISIBLE_RECT);

      const snapshot = buildSnapshotFromDocument(document as unknown as Document, { ignoreRoles: ['dialog'] });
      expect(snapshot.scopeApplied).toBe('main');
      expect(snapshot.textPreview).toContain('Settings page');
      expect(snapshot.textPreview).not.toContain('Confirm delete');
      expect(snapshot.elements.map((item) => item.label)).not.toContain('Delete now');
    });

    it('keeps ignoreRoles, scope, and mode escape hatches', () => {
      const document = makeDocument(`
        <main><p>Campaign list behind the wizard</p><button>Create</button></main>
        <div role="dialog" aria-modal="true"><p>Create campaign wizard</p><button>Next</button></div>
      `);
      setRect(document.querySelector('[role="dialog"]'), VISIBLE_RECT);

      const ignored = buildSnapshotFromDocument(document as unknown as Document, { ignoreRoles: ['dialog'] });
      expect(ignored.scopeApplied).toBe('main');
      expect(ignored.textPreview).toContain('Campaign list behind');
      expect(ignored.textPreview).not.toContain('Create campaign wizard');

      const fullDocument = buildSnapshotFromDocument(document as unknown as Document, { scope: 'document' });
      expect(fullDocument.scopeApplied).toBe('document');
      expect(fullDocument.textPreview).toContain('Campaign list behind');
      expect(fullDocument.textPreview).toContain('Create campaign wizard');

      const explicitMain = buildSnapshotFromDocument(document as unknown as Document, { scope: 'main' });
      expect(explicitMain.scopeApplied).toBe('main');
      expect(explicitMain.textPreview).toContain('Campaign list behind');
      expect(explicitMain.textPreview).not.toContain('Create campaign wizard');

      const fullMode = buildSnapshotFromDocument(document as unknown as Document, { mode: 'full' });
      expect(fullMode.scopeApplied).toBe('document');
      expect(fullMode.text).toContain('Campaign list behind');
      expect(fullMode.text).toContain('Create campaign wizard');
    });
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

    const result = extractFeedPosts({ maxPosts: 10 }, document as unknown as Document);

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

  it('dedupes nested article posts to root candidates only', () => {
    const document = makeDocument(`
      <main role="feed">
        <article>
          <h3>Outer</h3>
          <p>Outer post body</p>
          <article>
            <h3>Inner</h3>
            <p>Nested reply body</p>
          </article>
        </article>
        <article>
          <h3>Second</h3>
          <p>Second post body</p>
        </article>
      </main>
    `);

    const result = extractFeedPosts({ maxPosts: 10 }, document as unknown as Document);
    expect(result.count).toBe(2);
    expect(result.posts.map((post) => post.author)).toEqual(['Outer', 'Second']);
  });

  it('supports extended wait_for conditions', async () => {
    const document = makeDocument(`
      <main><p>Scoped ready text</p></main>
      <div id="spinner">Loading</div>
    `);

    await expect(
      waitForCondition({ textInScope: 'Scoped ready', scope: 'main', timeoutMs: 50 }, document as unknown as Document)
    ).resolves.toMatchObject({ matched: true, condition: 'textInScope' });

    await expect(
      waitForCondition({ selector: '#spinner', selectorAbsent: true, timeoutMs: 50 }, document as unknown as Document)
    ).resolves.toMatchObject({ matched: false, condition: 'timeout' });

    const spinner = document.getElementById('spinner');
    spinner?.remove();

    await expect(
      waitForCondition({ selector: '#spinner', selectorAbsent: true, timeoutMs: 50 }, document as unknown as Document)
    ).resolves.toMatchObject({ matched: true, condition: 'selectorAbsent' });
  });

  it('resets contentStableMs after scoped text drops below minimum length', async () => {
    vi.useFakeTimers();
    try {
      const stableText = 'a'.repeat(100);
      const document = makeDocument(`<main><p>${stableText}</p></main>`);

      const waitPromise = waitForCondition(
        { contentStableMs: 300, scope: 'main', timeoutMs: 5000 },
        document as unknown as Document
      );

      await vi.advanceTimersByTimeAsync(100);
      const main = document.querySelector('main');
      main!.innerHTML = '<p>x</p>';
      await vi.advanceTimersByTimeAsync(100);
      main!.innerHTML = `<p>${stableText}</p>`;

      await vi.advanceTimersByTimeAsync(200);
      let settled = false;
      waitPromise.then(() => {
        settled = true;
      });
      await vi.runOnlyPendingTimersAsync();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(200);
      await expect(waitPromise).resolves.toMatchObject({ matched: true, condition: 'contentStableMs' });
    } finally {
      vi.useRealTimers();
    }
  });
});
