/**
 * The open Post sheet on web (A10-5 / §10.3), held outside the route.
 *
 * Same shape as mobile's `sheetStore`, and for the same reason: the console's affordances — the
 * body picker, the hazard form over the map, a tab switch between Reports — must not take the
 * half-written Post with them, and a route component's own state is unmounted by the router.
 * Nothing here decides anything: the pure model (core's `postSheet`) does, and this holds it.
 *
 * **What web adds is the refresh (§10.3).** A Post survives an accidental reload through
 * `localStorage`: the words, the chips, the put-in, every scalar. Photos do not, and cannot — a
 * picked file lives in a `File` this tab holds, and a reload has no way back to it — so they are
 * dropped on the way out and the restored sheet says so. That is the honest half of "keeps a
 * half-written Post across a refresh": the typing is what is expensive to lose.
 */

import type { PostSheet } from '@skating/core';
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'skating.reportSheet.v1';

/**
 * How long a stored sheet is worth restoring. Past this it is almost certainly a tab left open
 * over a weekend, and the D199 window would refuse its end time anyway — better to open a fresh
 * sheet than to restore one that cannot post.
 */
const STORED_MAX_AGE_MS = 7 * 24 * 3600_000;

let current: PostSheet | null = null;
/** When the open sheet last reached `localStorage` — the status bar's "saved in this browser". */
let persistedAt: number | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => current;
// SSR has no sheet and no storage; the server renders nothing and the route's door fills it on mount.
const getServerSnapshot = (): PostSheet | null => null;

/** The stored copy, stripped of what cannot survive a reload (the picked files). */
function serializable(post: PostSheet): PostSheet {
  return {
    ...post,
    reports: post.reports.map((r) => ({ ...r, photos: [] })),
  };
}

function persist(post: PostSheet | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (post === null || post.mode.kind === 'edit') {
      // An edit is never restored: the published Report is the durable copy, and a stale draft of
      // it restored over a later edit would silently undo someone else's save.
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable(post)));
    persistedAt = Date.now();
  } catch {
    // A full or disabled store costs the restore, never the sheet in front of the author.
  }
}

/** The sheet a reload left behind, if it is recent enough to be worth restoring. */
export function readStoredSheet(now: number): PostSheet | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as PostSheet;
    if (
      typeof parsed?.draftId !== 'string' ||
      !Array.isArray(parsed.reports) ||
      parsed.reports.length === 0
    ) {
      return null;
    }
    if (now - parsed.openedAtMs > STORED_MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Forget the stored copy — after a Post lands, or when the author starts over. */
export function clearStoredSheet(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; the next write overwrites it.
  }
}

/** Replace the open sheet (or close it). */
export function setSheet(next: PostSheet | null): void {
  current = next;
  persist(next);
  emit();
}

/** Advance the open sheet through a pure update. A no-op when nothing is open. */
export function updateSheet(update: (post: PostSheet) => PostSheet): void {
  if (current === null) return;
  const next = update(current);
  if (next === current) return;
  setSheet(next);
}

/** Subscribe to the open sheet. */
export function useSheet(): PostSheet | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const getPersistedAt = () => persistedAt;
const getServerPersistedAt = (): number | null => null;

/** When the open sheet last reached storage, or `null` when it has not (an edit never does). */
export function usePersistedAt(): number | null {
  return useSyncExternalStore(subscribe, getPersistedAt, getServerPersistedAt);
}

/** Test seam: forget the open sheet without touching storage. */
export function resetSheetStoreForTests(): void {
  current = null;
  persistedAt = null;
  listeners.clear();
}
