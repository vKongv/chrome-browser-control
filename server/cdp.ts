import { WebSocket } from 'ws';
import { BridgeAction } from './protocol.js';

interface CdpTarget {
  id: string;
  title?: string;
  url?: string;
  type?: string;
  webSocketDebuggerUrl?: string;
}

interface PendingCdpCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInspectableTarget(target: CdpTarget): boolean {
  return target.type === 'page' && !!target.webSocketDebuggerUrl;
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/$/, '');
}

export class CdpBrowser {
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;

  private idToTarget = new Map<number, string>();
  private targetToId = new Map<string, number>();

  constructor(options: { baseUrl?: string; requestTimeoutMs?: number } = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? 'http://127.0.0.1:9222');
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async available(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/json/version`, { signal: AbortSignal.timeout(750) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async call(action: BridgeAction, params: Record<string, unknown> = {}): Promise<unknown> {
    switch (action) {
      case 'list_tabs':
        return await this.listTabs();
      case 'navigate':
        return await this.navigate(params);
      case 'snapshot':
        return await this.snapshot(params);
      case 'click':
        return await this.click(params);
      case 'type':
        return await this.type(params);
      case 'scroll':
        return await this.scroll(params);
      default:
        throw new Error(`CDP fallback does not support action: ${action}`);
    }
  }

  private async fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(this.requestTimeoutMs) });
    if (!response.ok) throw new Error(`CDP ${path} failed: HTTP ${response.status}`);
    return await response.json() as T;
  }

  private rememberTargets(targets: CdpTarget[]): void {
    this.idToTarget.clear();
    this.targetToId.clear();
    let index = 1;
    for (const target of targets.filter(isInspectableTarget)) {
      this.idToTarget.set(index, target.id);
      this.targetToId.set(target.id, index);
      index += 1;
    }
  }

  private async targets(): Promise<CdpTarget[]> {
    const targets = await this.fetchJson<CdpTarget[]>('/json/list');
    this.rememberTargets(targets);
    return targets;
  }

  private async resolveTarget(tabId?: unknown): Promise<CdpTarget> {
    const targets = (await this.targets()).filter(isInspectableTarget);
    if (!targets.length) throw new Error('No inspectable CDP page targets found');

    if (typeof tabId === 'number') {
      const targetId = this.idToTarget.get(tabId);
      const target = targets.find((candidate) => candidate.id === targetId);
      if (target) return target;
      throw new Error(`No CDP tab found for numeric id ${tabId}; call list_tabs again and use one of its ids.`);
    }

    const nonInternal = targets.find((target) => !/^(chrome|chrome-untrusted|devtools):/.test(target.url || ''));
    return nonInternal ?? targets[0];
  }

  private async listTabs(): Promise<unknown> {
    const targets = (await this.targets()).filter(isInspectableTarget);
    return targets.map((target, index) => ({
      id: index + 1,
      cdpId: target.id,
      title: target.title,
      url: target.url,
      type: target.type,
      source: 'cdp'
    }));
  }

  private async navigate(params: Record<string, unknown>): Promise<unknown> {
    const url = String(params.url || '');
    if (!url) throw new Error('navigate requires url');

    const target = await this.resolveTarget(params.tabId);

    const client = await CdpClient.connect(target.webSocketDebuggerUrl!, this.requestTimeoutMs);
    try {
      await client.call('Page.enable');
      await client.call('Page.navigate', { url });
      await client.waitForLoad(15_000).catch(() => undefined);
    } finally {
      client.close();
    }

    await sleep(200);
    const refreshed = (await this.targets()).find((candidate) => candidate.id === target.id) ?? target;
    return { id: this.targetToId.get(refreshed.id) ?? 1, cdpId: refreshed.id, url: refreshed.url || url, title: refreshed.title, source: 'cdp' };
  }

  private async snapshot(params: Record<string, unknown>): Promise<unknown> {
    return await this.evaluateOnTarget(params.tabId, SNAPSHOT_SCRIPT);
  }

  private async click(params: Record<string, unknown>): Promise<unknown> {
    const ref = String(params.ref || '');
    if (!ref) throw new Error('click requires ref');
    return await this.evaluateOnTarget(params.tabId, CLICK_SCRIPT, { ref });
  }

  private async type(params: Record<string, unknown>): Promise<unknown> {
    const ref = String(params.ref || '');
    if (!ref) throw new Error('type requires ref');
    return await this.evaluateOnTarget(params.tabId, TYPE_SCRIPT, { ref, text: String(params.text ?? ''), force: params.force === true });
  }

  private async scroll(params: Record<string, unknown>): Promise<unknown> {
    return await this.evaluateOnTarget(params.tabId, SCROLL_SCRIPT, { deltaX: Number(params.deltaX ?? 0), deltaY: Number(params.deltaY ?? 600) });
  }

  private async evaluateOnTarget(tabId: unknown, fnSource: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const target = await this.resolveTarget(tabId);
    const client = await CdpClient.connect(target.webSocketDebuggerUrl!, this.requestTimeoutMs);
    try {
      await client.call('Runtime.enable');
      const expression = `(${fnSource})(${JSON.stringify(args)})`;
      const evaluation = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if ((evaluation as any).exceptionDetails) {
        throw new Error((evaluation as any).exceptionDetails.text || 'CDP evaluation failed');
      }
      const remote = (evaluation as any).result;
      if (remote?.subtype === 'error') throw new Error(remote.description || 'CDP evaluation failed');
      return remote?.value;
    } finally {
      client.close();
    }
  }
}

class CdpClient {
  private nextId = 1;
  private pending = new Map<number, PendingCdpCall>();
  private ws: WebSocket;
  private requestTimeoutMs: number;
  private loadResolvers: Array<() => void> = [];

  private constructor(ws: WebSocket, requestTimeoutMs: number) {
    this.ws = ws;
    this.requestTimeoutMs = requestTimeoutMs;
    this.ws.on('message', (raw) => this.handleMessage(raw.toString()));
    this.ws.on('close', () => this.rejectAll(new Error('CDP websocket closed')));
  }

  static async connect(url: string, requestTimeoutMs: number): Promise<CdpClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new CdpClient(ws, requestTimeoutMs);
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP response to ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(payload, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async waitForLoad(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.loadResolvers = this.loadResolvers.filter((candidate) => candidate !== done);
        reject(new Error('Timed out waiting for page load'));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.loadResolvers.push(done);
    });
  }

  close(): void {
    this.ws.close();
  }

  private handleMessage(text: string): void {
    const message = JSON.parse(text);
    if (message.method === 'Page.loadEventFired' || message.method === 'Page.domContentEventFired') {
      const resolvers = this.loadResolvers.splice(0);
      resolvers.forEach((resolve) => resolve());
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || 'CDP command failed'));
    else pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

const SNAPSHOT_SCRIPT = String.raw`function() {
  function roleFor(element) {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input' || tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    return tag;
  }
  function labelFor(element) {
    const aria = element.getAttribute('aria-label');
    if (aria) return aria.trim();
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) return placeholder.trim();
    const title = element.getAttribute('title');
    if (title) return title.trim();
    const value = element.tagName.toLowerCase() === 'input' ? element.getAttribute('value') : '';
    const text = value || element.innerText || element.textContent || '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  function isPasswordLike(element) {
    const type = String(element.getAttribute('type') || '').toLowerCase();
    const haystack = [type, element.getAttribute('autocomplete'), element.getAttribute('name'), element.getAttribute('id'), element.getAttribute('aria-label'), element.getAttribute('placeholder')].join(' ').toLowerCase();
    return type === 'password' || /password|passwd|passcode|one-time-code|otp|2fa|mfa/.test(haystack);
  }
  const elements = [...document.querySelectorAll('a,button,input,textarea,select,summary,[role],[contenteditable]')].slice(0, 250);
  return {
    title: document.title,
    url: document.location.href,
    source: 'cdp',
    elements: elements.map((element, index) => {
      const ref = 'e' + (index + 1);
      element.setAttribute('data-cbc-ref', ref);
      const rect = element.getBoundingClientRect();
      return { ref, role: roleFor(element), label: labelFor(element), tag: element.tagName.toLowerCase(), passwordLike: isPasswordLike(element), bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
    }),
    text: (document.body?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 4000)
  };
}`;

const CLICK_SCRIPT = String.raw`function(args) {
  const element = document.querySelector('[data-cbc-ref="' + String(args.ref).replace(/["\\]/g, '\\$&') + '"]');
  if (!element) throw new Error('No element found for ref ' + args.ref + '. Refresh snapshot and try again.');
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.click();
  return { clicked: args.ref, source: 'cdp' };
}`;

const TYPE_SCRIPT = String.raw`function(args) {
  const element = document.querySelector('[data-cbc-ref="' + String(args.ref).replace(/["\\]/g, '\\$&') + '"]');
  if (!element) throw new Error('No element found for ref ' + args.ref + '. Refresh snapshot and try again.');
  const haystack = [element.getAttribute('type'), element.getAttribute('autocomplete'), element.getAttribute('name'), element.getAttribute('id'), element.getAttribute('aria-label'), element.getAttribute('placeholder')].join(' ').toLowerCase();
  if (!args.force && /password|passwd|passcode|one-time-code|otp|2fa|mfa/.test(haystack)) throw new Error('Ref ' + args.ref + ' appears to be a password/2FA field.');
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.focus();
  if ('value' in element) {
    element.value = args.text;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: args.text, inputType: 'insertText' }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    element.textContent = args.text;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: args.text, inputType: 'insertText' }));
  }
  return { typed: String(args.text).length, ref: args.ref, source: 'cdp' };
}`;

const SCROLL_SCRIPT = String.raw`function(args) {
  window.scrollBy(Number(args.deltaX || 0), Number(args.deltaY || 600));
  return { scrolled: true, deltaX: Number(args.deltaX || 0), deltaY: Number(args.deltaY || 600), source: 'cdp' };
}`;
