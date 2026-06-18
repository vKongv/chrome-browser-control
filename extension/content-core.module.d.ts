export function isPasswordLike(element: any): boolean;
export type SnapshotMode = 'compact' | 'full';
export interface SnapshotOptions {
  mode?: SnapshotMode;
  now?: number;
}
export function cleanupRefStore(documentRef?: Document, now?: number): { retained: number; ttlMs: number; maxRefs: number };
export function buildSnapshotFromDocument(documentRef?: Document, options?: SnapshotOptions): {
  title: string;
  url?: string;
  mode?: 'compact';
  elements: Array<{
    ref: string;
    role: string;
    label: string;
    tag?: string;
    passwordLike?: boolean;
    bounds?: { x: number; y: number; width: number; height: number };
  }>;
  omittedElements?: number;
  text?: string;
  textPreview?: string;
  textBytesOmitted?: number;
  regions?: Array<Record<string, unknown>>;
};
export function findByRef(ref: string, documentRef?: Document): Element | null;
export function performClick(params: { ref: string }, documentRef?: Document): { clicked: string };
export function performType(
  params: { ref: string; text: string; force?: boolean },
  documentRef?: Document
): { typed: number; ref: string };
export function performScroll(
  params?: { deltaX?: number; deltaY?: number },
  windowRef?: Window
): { scrolled: boolean; deltaX: number; deltaY: number };
export const __testing: {
  configureRefStore(options?: { ttlMs?: number; max?: number }): void;
  resetRefStore(): void;
  refStoreSize(): number;
};
