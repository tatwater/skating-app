import { useSyncExternalStore } from 'react';
import { ID_SHAPE } from '../reads/readArgs';

/**
 * **Opened recently** — the bodies this browser opened in the Body console, newest first (the
 * governor's ruling: this browser only). A small list of ids in local storage, written when a
 * body's console opens; nothing reaches the server and nothing is shared between viewers.
 *
 * Storage can be missing, full, blocked or cleared (a private window, a policy, a preview): every
 * read and write is wrapped, a failure reads as an empty list, and the lane then says it is empty —
 * it never breaks the page.
 */

export const OPENED_KEY = 'gli.admin.bodies.opened';
/** How many it keeps: a working session's worth, not a history. */
export const OPENED_MAX = 12;
/** Same-tab writes, which the `storage` event doesn't carry. */
const CHANGED = 'gli:bodies-opened';

/** The stored list, as written: ids only, deduped, capped; anything else reads as empty. */
export function parseOpened(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const ids = value.filter((v): v is string => typeof v === 'string' && ID_SHAPE.test(v));
    return [...new Set(ids)].slice(0, OPENED_MAX);
  } catch {
    return [];
  }
}

/** The list with `id` moved to the front, capped. */
export function withOpened(list: readonly string[], id: string): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, OPENED_MAX);
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The ids this browser opened, newest first; empty when storage can't be read. */
export function readOpened(): string[] {
  try {
    return parseOpened(storage()?.getItem(OPENED_KEY) ?? null);
  } catch {
    return [];
  }
}

/** Remember that `id` was opened. A body id only; a failed write is dropped silently. */
export function rememberOpened(id: string): void {
  if (!ID_SHAPE.test(id)) return;
  try {
    storage()?.setItem(OPENED_KEY, JSON.stringify(withOpened(readOpened(), id)));
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    // Storage full or blocked: the lane just won't list it.
  }
}

// One snapshot per change, so the list keeps its identity between renders.
let cache: { raw: string | null; ids: string[] } = { raw: null, ids: [] };
function snapshot(): string[] {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(OPENED_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw !== cache.raw) cache = { raw, ids: parseOpened(raw) };
  return cache.ids;
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === OPENED_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CHANGED, onChange);
  };
}

const NONE: string[] = [];

/** The opened ids, kept current across tabs; empty on the server. */
export function useOpenedBodies(): readonly string[] {
  return useSyncExternalStore(subscribe, snapshot, () => NONE);
}
