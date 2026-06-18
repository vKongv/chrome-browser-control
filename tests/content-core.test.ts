import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __testing,
  buildSnapshotFromDocument,
  cleanupRefStore,
  findByRef,
  isPasswordLike,
  performClick,
  performType
} from '../extension/content-core.module.js';

function makeDocument(html: string) {
  const window = new Window({ url: 'https://example.test/' });
  window.document.write(html);
  return window.document;
}

describe('extension content core', () => {
  afterEach(() => {
    __testing.resetRefStore();
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
    expect(document.querySelector(`[data-hermes-ref="${snapshot.elements[1].ref}"]`)?.textContent).toBe('Save');
  });

  it('supports full mode with the legacy verbose fields', () => {
    const document = makeDocument('<button>Save</button><p>Body text</p>');

    const snapshot = buildSnapshotFromDocument(document as unknown as Document, { mode: 'full' });

    expect(snapshot).not.toHaveProperty('mode');
    expect(snapshot.elements[0]).toMatchObject({ role: 'button', label: 'Save', tag: 'button', passwordLike: false });
    expect(snapshot.elements[0]).toHaveProperty('bounds');
    expect(snapshot.text).toContain('Body text');
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

    expect(document.querySelector(`[data-hermes-ref="${buttonRef}"]`)).toBeNull();
    expect(document.querySelector(`[data-hermes-ref="${inputRef}"]`)).toBeNull();
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
    expect(document.querySelector(`[data-hermes-ref="${firstRef}"]`)).toBeNull();
    expect(document.querySelector(`[data-hermes-ref="${secondRef}"]`)).toBeNull();
    expect(document.querySelector(`[data-hermes-ref="${thirdRef}"]`)).not.toBeNull();
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

  it('compact output is at least 50 percent smaller than full output on dense pages', () => {
    const controls = Array.from({ length: 120 }, (_, i) => `<button aria-label="Action ${i}">Action ${i}</button>`).join('');
    const text = '<p>' + 'Long marketing copy '.repeat(500) + '</p>';
    const document = makeDocument(`<main>${controls}${text}</main>`);

    const compactBytes = JSON.stringify(buildSnapshotFromDocument(document as unknown as Document)).length;
    const fullBytes = JSON.stringify(buildSnapshotFromDocument(document as unknown as Document, { mode: 'full' })).length;

    expect(compactBytes).toBeLessThan(fullBytes * 0.5);
  });
});
