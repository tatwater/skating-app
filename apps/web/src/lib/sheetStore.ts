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
 *
 * **A sheet belongs to the account that wrote it** (PR #77 review). A browser is shared more often
 * than a phone, and the stored copy outlives a session, so the record carries its owner — the
 * Clerk user `AuthGate` binds (`bindSheetOwner`) — and restores only to that owner. A change of
 * account drops the open sheet; an explicit sign-out (`forgetSheet`) wipes the stored one too. A
 * session that merely lapses keeps it, for the same author to find on signing back in.
 *
 * **It also holds the last failed attempt**, stored beside the sheet: the checkpoints a retry
 * resumes from, and — once the create has gone out (`postCreateSent`) — the lock that keeps the
 * sheet from taking a change the server's idempotent create would silently drop.
 */

import { type PostDraft, type PostSheet, postCreateSent } from '@skating/core';
import { useSyncExternalStore } from 'react';
import { releaseAllSheetPhotos } from './sheetPhotos';

const STORAGE_KEY = 'skating.reportSheet.v2';
/** The record as first built carried no owner, so it can never be restored — only removed. */
const LEGACY_STORAGE_KEY = 'skating.reportSheet.v1';

/**
 * How long a stored sheet is worth restoring. Past this it is almost certainly a tab left open
 * over a weekend, and the D199 window would refuse its end time anyway — better to open a fresh
 * sheet than to restore one that cannot post.
 */
const STORED_MAX_AGE_MS = 7 * 24 * 3600_000;

/** What a reload finds: the sheet and the attempt it had failed, if any. */
export interface StoredSheet {
  sheet: PostSheet;
  attempt: PostDraft | null;
}

interface StoredRecord extends StoredSheet {
  owner: string;
}

let current: PostSheet | null = null;
let attempt: PostDraft | null = null;
let owner: string | null = null;
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
const getAttemptSnapshot = () => attempt;
// SSR has no sheet and no storage; the server renders nothing and the route's door fills it on mount.
const getServerSnapshot = (): null => null;

/** The stored copy, stripped of what cannot survive a reload (the picked files). */
function serializable(post: PostSheet): PostSheet {
  return {
    ...post,
    reports: post.reports.map((r) => ({ ...r, photos: [] })),
  };
}

function removeStored(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; the next write overwrites it.
  }
}

function persist(): void {
  if (typeof window === 'undefined') return;
  // An edit is never restored: the published Report is the durable copy, and a stale draft of it
  // restored over a later edit would silently undo someone else's save.
  if (current === null || current.mode.kind === 'edit') {
    persistedAt = null;
    removeStored();
    return;
  }
  // A sheet with no signed-in author to file it under is not written down for the next one.
  if (owner === null) {
    persistedAt = null;
    return;
  }
  const record: StoredRecord = { owner, sheet: serializable(current), attempt };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    persistedAt = Date.now();
  } catch {
    // A full or disabled store costs the restore, never the sheet in front of the author.
  }
}

/**
 * The account the sheet belongs to — `AuthGate` calls this with Clerk's user id, `null` when
 * signed out. A change drops the open sheet and its photos from memory (it was the last account's),
 * and leaves the stored one to the owner check in `readStoredSheet`.
 */
export function bindSheetOwner(next: string | null): void {
  if (next === owner) return;
  owner = next;
  // The ownerless record the first build wrote is nobody's to restore; it goes on the first bind.
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // A disabled store holds nothing to remove.
    }
  }
  if (current === null && attempt === null) return;
  current = null;
  attempt = null;
  persistedAt = null;
  releaseAllSheetPhotos();
  emit();
}

/** The sheet a reload left behind for the bound owner, if it is recent enough to be worth restoring. */
export function readStoredSheet(now: number): StoredSheet | null {
  if (typeof window === 'undefined' || owner === null) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StoredRecord> | null;
    if (parsed?.owner !== owner) return null;
    const sheet = parsed.sheet;
    if (
      typeof sheet?.draftId !== 'string' ||
      !Array.isArray(sheet.reports) ||
      sheet.reports.length === 0
    ) {
      return null;
    }
    if (now - sheet.openedAtMs > STORED_MAX_AGE_MS) return null;
    const stored = parsed.attempt;
    return { sheet, attempt: stored?.id === sheet.draftId ? stored : null };
  } catch {
    return null;
  }
}

/** Forget the stored copy — after a Post lands, or when the author starts over. */
export function clearStoredSheet(): void {
  removeStored();
}

/**
 * Forget the sheet everywhere — memory, its photos, storage. The explicit sign-out's half: the
 * author is leaving this browser, and what they were writing leaves with them.
 */
export function forgetSheet(): void {
  current = null;
  attempt = null;
  persistedAt = null;
  releaseAllSheetPhotos();
  removeStored();
  emit();
}

/**
 * Replace the open sheet (or close it). The attempt goes with it: a new sheet starts with none, a
 * restored one brings the one it was stored with.
 */
export function setSheet(next: PostSheet | null, nextAttempt: PostDraft | null = null): void {
  current = next;
  attempt = next === null ? null : nextAttempt;
  persist();
  emit();
}

/**
 * Advance the open sheet through a pure update. A no-op when nothing is open — and when the open
 * Post has been sent (`postCreateSent`): the retry resends what went, so a change here would be
 * shown to the author and then silently dropped by the server's idempotent create.
 */
export function updateSheet(update: (post: PostSheet) => PostSheet): void {
  if (current === null || postCreateSent(attempt)) return;
  const next = update(current);
  if (next === current) return;
  current = next;
  persist();
  emit();
}

/** Record the attempt a failed *Post* returned (or clear it), so the retry resumes from it. */
export function setSheetAttempt(next: PostDraft | null): void {
  if (current === null) return;
  attempt = next;
  persist();
  emit();
}

/** The open sheet's last failed attempt, read outside React. */
export function getSheetAttempt(): PostDraft | null {
  return attempt;
}

/** Subscribe to the open sheet. */
export function useSheet(): PostSheet | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Subscribe to the open sheet's last failed attempt. */
export function useSheetAttempt(): PostDraft | null {
  return useSyncExternalStore(subscribe, getAttemptSnapshot, getServerSnapshot);
}

const getPersistedAt = () => persistedAt;
const getServerPersistedAt = (): number | null => null;

/** When the open sheet last reached storage, or `null` when it has not (an edit never does). */
export function usePersistedAt(): number | null {
  return useSyncExternalStore(subscribe, getPersistedAt, getServerPersistedAt);
}

/** Test seam: forget the open sheet and its owner without touching storage. */
export function resetSheetStoreForTests(): void {
  current = null;
  attempt = null;
  owner = null;
  persistedAt = null;
  listeners.clear();
}
