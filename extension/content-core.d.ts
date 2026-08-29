export function isPasswordLike(element: any): boolean;
export type SnapshotMode = 'compact' | 'full' | 'visible';
export type SnapshotScope = 'document' | 'main' | 'article' | 'feed';
export type AppliedSnapshotScope = SnapshotScope | 'dialog';
export interface SnapshotScopeOptions {
  scope?: SnapshotScope;
  excludeSelectors?: string[];
  ignoreRoles?: string[];
}
export interface SnapshotOptions extends SnapshotScopeOptions {
  mode?: SnapshotMode;
  now?: number;
  textLimit?: number;
  limit?: number;
}
export interface ScopeRootHint {
  tag: string;
  role?: string;
  selectorHint?: string;
}
export interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ElementMatch {
  ref: string;
  role: string;
  label: string;
  tag?: string;
  passwordLike?: boolean;
  bounds?: ElementBounds;
  href?: string;
  value?: string;
  visible?: boolean;
}
export interface FeedPost {
  author?: string;
  text: string;
  relativeTime?: string;
  absoluteTime?: string;
  isLive?: boolean;
  wasLive?: boolean;
  postUrl?: string;
}
export function resolveScopeRoot(documentRef?: Document, scope?: SnapshotScope): Element;
export function scopedBodyText(
  documentRef?: Document,
  options?: SnapshotOptions
): {
  text: string;
  scopeRoot: Element;
  scopeApplied: AppliedSnapshotScope;
  excludeSelectors: string[];
  ignoreRoles: string[];
};
export function cleanupRefStore(documentRef?: Document, now?: number): { retained: number; ttlMs: number; maxRefs: number };
export function buildSnapshotFromDocument(documentRef?: Document, options?: SnapshotOptions): {
  title: string;
  url?: string;
  mode?: 'compact' | 'visible';
  viewport?: { width: number; height: number; deviceScaleFactor: number };
  scroll?: { x: number; y: number; width: number; height: number };
  elements: ElementMatch[];
  omittedElements?: number;
  text?: string;
  textPreview?: string;
  textLimitApplied?: number;
  textTotalLength?: number;
  textBytesOmitted?: number;
  warning?: string;
  regions?: Array<Record<string, unknown>>;
  scopeApplied?: AppliedSnapshotScope;
  scopeRoot?: ScopeRootHint;
  excludedCount?: number;
};
export function buildVisibleSnapshotFromDocument(documentRef?: Document, options?: SnapshotOptions): {
  title: string;
  url?: string;
  mode: 'visible';
  viewport: { width: number; height: number; deviceScaleFactor: number };
  scroll: { x: number; y: number; width: number; height: number };
  elements: ElementMatch[];
  omittedElements: number;
};
export function findByRef(ref: string, documentRef?: Document): Element | null;
export function boundsForRef(
  ref: string,
  documentRef?: Document
): {
  bounds: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number; deviceScaleFactor: number };
};
export function performClick(params: { ref: string; allowHidden?: boolean }, documentRef?: Document): { clicked: string };
export function performType(
  params: { ref: string; text: string; force?: boolean; allowHidden?: boolean },
  documentRef?: Document
): { typed: number; ref: string };
export function performScroll(
  params?: { deltaX?: number; deltaY?: number; x?: number; y?: number },
  windowRef?: Window
): { scrolled: boolean; deltaX: number; deltaY: number; x?: number; y?: number; target?: string };
export function queryElements(
  params?: { selector?: string; role?: string; text?: string; visible?: boolean; limit?: number; now?: number },
  documentRef?: Document
): { matches: ElementMatch[]; count: number; omitted: number };
export function extractElements(
  params?: {
    selector: string;
    limit?: number;
    includeText?: boolean;
    includeHtml?: boolean;
    includeLinks?: boolean;
    includeTimes?: boolean;
    visible?: boolean;
    now?: number;
  },
  documentRef?: Document
): {
  items: Array<
    Record<string, unknown> & {
      passwordLike?: boolean;
      sensitive?: boolean;
      redactedAttributes?: number;
    }
  >;
  count: number;
  omitted: number;
};
export function extractFeedPosts(
  options?: SnapshotScopeOptions & { maxPosts?: number },
  documentRef?: Document
): {
  posts: FeedPost[];
  count: number;
  omitted?: number;
  scopeApplied: AppliedSnapshotScope;
};
export function performClickAt(
  params: { x: number; y: number; allowHidden?: boolean },
  documentRef?: Document
): { clicked: boolean; x: number; y: number; ref: string };
export function performKeypress(
  params: { keys: string | string[]; allowHidden?: boolean },
  documentRef?: Document
): { pressed: string[] };
export function waitForCondition(
  params?: SnapshotScopeOptions & {
    text?: string;
    selector?: string;
    urlIncludes?: string;
    selectorAbsent?: boolean;
    textInScope?: string;
    contentStableMs?: number;
    timeoutMs?: number;
  },
  documentRef?: Document
): Promise<{ matched: boolean; reason: string; condition: string; elapsedMs: number; title?: string; url?: string }>;
export function pageStatus(documentRef?: Document): Record<string, unknown>;
export function installConsoleCapture(windowRef?: Window): { installed: boolean };
export function getConsoleLogs(params?: { levels?: string[]; limit?: number }): {
  logs: Array<{ level: string; text: string; timestamp: string }>;
  omitted: number;
  capture: string;
};
export function collectScroll(
  params: {
    steps?: number;
    deltaY?: number;
    delayMs?: number;
    maxItems?: number;
    scroll?: { x?: number; y?: number; deltaX?: number; deltaY?: number };
    until?: { noNewItemsForSteps?: number; stopBeforeDatetime?: string };
    extract: { selector: string; includeText?: boolean; includeLinks?: boolean; includeTimes?: boolean; visible?: boolean; limitPerStep?: number };
    dedupeBy?: 'text' | 'href' | 'statusHref' | 'none';
  },
  documentRef?: Document,
  windowRef?: Window
): Promise<{
  stepsRun: number;
  items: Array<Record<string, unknown>>;
  count: number;
  dedupedCount: number;
  omitted: number;
  truncatedCount: number;
  maxItems: number;
  stoppedReason: 'maxItems' | 'noNewItems' | 'dateCutoff' | 'stepsExhausted' | 'budget';
}>;
export const __testing: {
  configureRefStore(options?: { ttlMs?: number; max?: number }): void;
  resetRefStore(): void;
  refStoreSize(): number;
  clearConsoleLogs(): void;
};
