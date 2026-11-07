/**
 * The open Post sheet on web (A10-5 / §10.3), held outside the route.
 *
 * Same shape as mobile's `sheetStore`, and for the same reason: the console's affordances — the
 * body picker, the hazard form over the map, a tab switch between Reports — must not take the
 * half-written Post with them, and a route component's own state is unmounted by the router.
 * Nothing here decides anything: the pure model (core's `postSheet`) does, and this holds it.
 *
 * **What web adds is the refresh (§10.3).** A Post survives an accidental reload through
 * `localStorage`: the words, the chips, the put-in, every scalar.
 *
 * **Photos come back too, when the browser lets them (B03 §5).** The blobs live in IndexedDB
 * (`sheetPhotos`); what the record holds is where each one was placed. The record is the one source
 * of truth: it is written synchronously, it claims the photos, and the store of blobs is reconciled
 * to that claim — so a blob can never outlive the draft that names it, whichever door the draft left
 * by. `restoreStoredSheet` is the async read a restoring state renders over; when IndexedDB is gone,
 * full, denied or slow it resolves to what `readStoredSheet` has always given, the words without the
 * photos, and `useSheetPhotosLost` is how the sheet says so. The typing is what is expensive to lose,
 * and no storage failure can cost it: the words are in hand before IndexedDB is asked anything.
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

import {
  type DraftPhoto,
  type PostDraft,
  type PostSheet,
  postCreateSent,
  revivePostDraft,
  revivePostSheet,
} from '@skating/core';
import { useSyncExternalStore } from 'react';
import {
  adoptSheetPhotos,
  readSheetPhotos,
  releaseAllSheetPhotos,
  releaseRestoredPhotosExcept,
  type SheetPhotoClaim,
  syncSheetPhotos,
} from './sheetPhotos';

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

/** What `restoreStoredSheet` finds: the sheet with its photos back, and how many could not come. */
export interface RestoredSheet extends StoredSheet {
  photosLost: number;
}

/**
 * Where each photo sat when the record was written — the records `serializable` strips off the
 * sheet, so that `sheet` stays what a reader without IndexedDB can use as it stands. Absent when the
 * sheet had no photos, and on every record stored before this field.
 */
interface StoredPhotos {
  reports?: Record<string, DraftPhoto[]>;
  pool?: DraftPhoto[];
}

interface StoredRecord extends StoredSheet {
  owner: string;
  photos?: StoredPhotos;
}

let current: PostSheet | null = null;
let attempt: PostDraft | null = null;
let owner: string | null = null;
/** When the open sheet last reached `localStorage` — the status bar's "saved in this browser". */
let persistedAt: number | null = null;
/** A photo read is in flight (`restoreStoredSheet`). */
let restoring = false;
let restoreToken = 0;
let restoreInFlight: Promise<RestoredSheet | null> | null = null;
/** What the last restore could not bring back, and for which draft — it says so only on that one. */
let lostPhotos: { draftId: string; count: number } | null = null;
/**
 * A photo on the open sheet that will not survive a reload, for one of two reasons with two different
 * clocks: the record that claims it could not be written, or the blob store refused it. Kept apart so
 * that a reconcile finishing late cannot clear what a failed write has just said.
 */
let recordRefused = false;
let blobsRefused = false;
/** The claim last handed to the blob store, so a keystroke does not reconcile an unchanged set. */
let lastClaim: string | null = null;
let swept = false;
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

/** The stored copy, stripped of what cannot survive a reload (the picked files — the Reports' and the pool's). */
function serializable(post: PostSheet): PostSheet {
  const { photos: _pool, ...rest } = post;
  return {
    ...rest,
    reports: post.reports.map((r) => ({ ...r, photos: [] })),
  };
}

/** The photo records on a sheet, by where they sit. `undefined` when there are none. */
function storedPhotos(post: PostSheet): StoredPhotos | undefined {
  const reports: Record<string, DraftPhoto[]> = {};
  for (const r of post.reports) if (r.photos.length > 0) reports[r.id] = r.photos;
  const pool = post.photos ?? [];
  if (Object.keys(reports).length === 0 && pool.length === 0) return undefined;
  return { reports, ...(pool.length > 0 ? { pool } : {}) };
}

/** A stored list of photo records, tolerating whatever a torn or foreign record left there. */
function photoList(value: unknown): DraftPhoto[] {
  if (!Array.isArray(value)) return [];
  return value.filter((p) => typeof (p as DraftPhoto | null)?.id === 'string');
}

/** What the record claims exists in the blob store. */
function claimOf(record: StoredRecord): SheetPhotoClaim {
  const inReports = Object.values(record.photos?.reports ?? {}).flatMap(photoList);
  return {
    owner: record.owner,
    draftId: record.sheet.draftId,
    photoIds: [...inReports, ...photoList(record.photos?.pool)].map((p) => p.id),
  };
}

function photoIdsOf(post: PostSheet): string[] {
  return [...post.reports.flatMap((r) => r.photos), ...(post.photos ?? [])].map((p) => p.id);
}

function onPhotosSynced(everyPhotoStored: boolean): void {
  if (blobsRefused === !everyPhotoStored) return;
  blobsRefused = !everyPhotoStored;
  emit();
}

/** Hand the blob store a claim. The set of photos rarely changes; a keystroke must not reconcile. */
function claimPhotos(claim: SheetPhotoClaim | null): void {
  const key =
    claim === null ? '' : JSON.stringify([claim.owner, claim.draftId, [...claim.photoIds].sort()]);
  if (key === lastClaim) return;
  lastClaim = key;
  syncSheetPhotos(claim, onPhotosSynced);
}

function removeStored(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; the next write overwrites it.
  }
}

/** Anything that changes what is stored outdates a read in flight — its result is not to be used. */
function cancelRestore(): void {
  restoreToken++;
  restoreInFlight = null;
  restoring = false;
}

function persist(): void {
  if (typeof window === 'undefined') return;
  cancelRestore();
  // An edit is never restored: the published Report is the durable copy, and a stale draft of it
  // restored over a later edit would silently undo someone else's save.
  if (current === null || current.mode.kind === 'edit') {
    persistedAt = null;
    recordRefused = false;
    removeStored();
    claimPhotos(null);
    return;
  }
  // A sheet with no signed-in author to file it under is not written down for the next one.
  if (owner === null) {
    persistedAt = null;
    return;
  }
  const photos = storedPhotos(current);
  const record: StoredRecord = {
    owner,
    sheet: serializable(current),
    attempt,
    ...(photos !== undefined ? { photos } : {}),
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    persistedAt = Date.now();
    recordRefused = false;
    claimPhotos(claimOf(record));
  } catch {
    // A full or disabled store costs the restore, never the sheet in front of the author. The
    // blobs stay matched to whatever record did survive, and these photos were never claimed.
    const survivor = readRecord();
    claimPhotos(survivor && claimOf(survivor));
    recordRefused = photos !== undefined;
  }
}

/** The record as stored, if it has the shape of one — whoever's it is and however old. */
function readRecord(): StoredRecord | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StoredRecord> | null;
    const sheet = parsed?.sheet;
    if (
      typeof parsed?.owner !== 'string' ||
      typeof sheet?.draftId !== 'string' ||
      !Array.isArray(sheet.reports) ||
      sheet.reports.length === 0
    ) {
      return null;
    }
    return parsed as StoredRecord;
  } catch {
    return null;
  }
}

function isExpired(record: StoredRecord, now: number): boolean {
  return now - record.sheet.openedAtMs > STORED_MAX_AGE_MS;
}

/**
 * The record's sheet and attempt, as this build reads them. A sheet an earlier build stored carries
 * that build's fields (D210 renamed one); every reader indexes this build's, so the record is
 * revived before anything reads it. `null` when it cannot be.
 */
function wordsOf(record: StoredRecord): StoredSheet | null {
  try {
    const stored = record.attempt;
    return {
      sheet: revivePostSheet(record.sheet),
      attempt: stored?.id === record.sheet.draftId ? revivePostDraft(stored) : null,
    };
  } catch {
    return null;
  }
}

/**
 * The page's first look at the blob store, once per load: whatever a closed tab left that no live
 * record names — a sign-out whose delete never ran, a draft that expired while nobody was here.
 * The words of an expired draft stay where they are, inert (`readStoredSheet` refuses them).
 */
function sweepOnce(): void {
  if (swept || typeof window === 'undefined') return;
  swept = true;
  const record = readRecord();
  claimPhotos(record !== null && !isExpired(record, Date.now()) ? claimOf(record) : null);
}

/**
 * The account the sheet belongs to — `AuthGate` calls this with Clerk's user id, `null` when
 * signed out. A change drops the open sheet and its photos from memory (it was the last account's),
 * and leaves the stored one to the owner check in `readStoredSheet`.
 */
export function bindSheetOwner(next: string | null): void {
  sweepOnce();
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
  // A photo read started for the last account is not for this one, and what it held goes too.
  cancelRestore();
  current = null;
  attempt = null;
  persistedAt = null;
  lostPhotos = null;
  recordRefused = false;
  blobsRefused = false;
  releaseAllSheetPhotos();
  emit();
}

/** The sheet a reload left behind for the bound owner, if it is recent enough to be worth restoring. */
export function readStoredSheet(now: number): StoredSheet | null {
  if (owner === null) return null;
  const record = readRecord();
  if (record === null || record.owner !== owner || isExpired(record, now)) return null;
  return wordsOf(record);
}

async function runRestore(now: number): Promise<RestoredSheet | null> {
  if (owner === null) return null;
  const record = readRecord();
  // Nothing readable stored: nothing can claim a blob. Another account's record is left alone — it
  // is that author's until something overwrites it — but it is not this one's to read.
  if (record === null) {
    claimPhotos(null);
    return null;
  }
  if (record.owner !== owner) return null;
  if (isExpired(record, now)) {
    removeStored();
    claimPhotos(null);
    return null;
  }
  // The words first, and they are final: nothing that happens in IndexedDB below can take them.
  const words = wordsOf(record);
  if (words === null) {
    claimPhotos(null);
    return null;
  }
  const claim = claimOf(record);
  if (claim.photoIds.length === 0) return { ...words, photosLost: 0 };

  const token = ++restoreToken;
  restoring = true;
  emit();
  const rows = await readSheetPhotos(claim);
  // The sheet, the account or the store moved on while this read: it answers nobody now.
  if (token !== restoreToken) return null;
  adoptSheetPhotos(rows);

  const found = new Set(rows.map((row) => row.photoId));
  const kept = (list: unknown) => photoList(list).filter((p) => found.has(p.id));
  const pool = kept(record.photos?.pool);
  const sheet: PostSheet = {
    ...words.sheet,
    reports: words.sheet.reports.map((r) => ({
      ...r,
      photos: kept(record.photos?.reports?.[r.id]),
    })),
    ...(pool.length > 0 ? { photos: pool } : {}),
  };
  const photosLost = claim.photoIds.length - photoIdsOf(sheet).length;
  lostPhotos = photosLost > 0 ? { draftId: sheet.draftId, count: photosLost } : null;
  restoring = false;
  emit();
  return { ...words, sheet, photosLost };
}

/**
 * `readStoredSheet` with the photos back: the same gate, and the same shape for the route to check
 * against its door and hand to `setSheet`. Every IndexedDB failure resolves to the words alone with
 * `photosLost` counting what did not come, and `useSheetRestoring` is true for as long as it waits.
 *
 * `null` means nothing restored *for this call*: nothing stored, not this account's, expired, or
 * outdated by a sheet being set while it read. Concurrent calls share one read — a remounting effect
 * must not have its first call answered "nothing" and open a door over the real draft.
 */
export function restoreStoredSheet(now: number): Promise<RestoredSheet | null> {
  if (restoreInFlight !== null) return restoreInFlight;
  const flight: Promise<RestoredSheet | null> = runRestore(now).finally(() => {
    if (restoreInFlight === flight) restoreInFlight = null;
  });
  restoreInFlight = flight;
  return flight;
}

/** Forget the stored copy — after a Post lands, or when the author starts over. */
export function clearStoredSheet(): void {
  removeStored();
  claimPhotos(null);
}

/**
 * Forget the sheet everywhere — memory, its photos, storage. The explicit sign-out's half: the
 * author is leaving this browser, and what they were writing leaves with them.
 */
export function forgetSheet(): void {
  cancelRestore();
  current = null;
  attempt = null;
  persistedAt = null;
  lostPhotos = null;
  recordRefused = false;
  blobsRefused = false;
  releaseAllSheetPhotos();
  removeStored();
  claimPhotos(null);
  emit();
}

/**
 * Replace the open sheet (or close it). The attempt goes with it: a new sheet starts with none, a
 * restored one brings the one it was stored with.
 */
export function setSheet(next: PostSheet | null, nextAttempt: PostDraft | null = null): void {
  current = next;
  attempt = next === null ? null : nextAttempt;
  // A restore this door turned down brought back photos no sheet is using.
  releaseRestoredPhotosExcept(next === null ? [] : photoIdsOf(next));
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

const getRestoring = () => restoring;
const getServerRestoring = () => false;

/** A restore is reading the photos back; the words arrive with them. */
export function useSheetRestoring(): boolean {
  return useSyncExternalStore(subscribe, getRestoring, getServerRestoring);
}

const getPhotosLost = () =>
  lostPhotos?.draftId === current?.draftId ? (lostPhotos?.count ?? 0) : 0;
const getServerPhotosLost = () => 0;

/** How many of the open sheet's photos the restore could not bring back — the sheet says so. */
export function useSheetPhotosLost(): number {
  return useSyncExternalStore(subscribe, getPhotosLost, getServerPhotosLost);
}

/** The author has seen it: the sheet stops saying its photos were lost. */
export function dismissSheetPhotosLost(): void {
  if (lostPhotos === null) return;
  lostPhotos = null;
  emit();
}

const getPhotosNotKept = () => current !== null && (recordRefused || blobsRefused);
const getServerPhotosNotKept = () => false;

/**
 * Storage refused a photo on the open sheet (quota, a private window). It is still here and still
 * posts; it will not be here after a reload. Cleared when a later change gets every photo stored.
 */
export function useSheetPhotosNotKept(): boolean {
  return useSyncExternalStore(subscribe, getPhotosNotKept, getServerPhotosNotKept);
}

/** Test seam: forget the open sheet and its owner without touching storage — a reload, in effect. */
export function resetSheetStoreForTests(): void {
  cancelRestore();
  current = null;
  attempt = null;
  owner = null;
  persistedAt = null;
  lostPhotos = null;
  recordRefused = false;
  blobsRefused = false;
  lastClaim = null;
  swept = false;
  listeners.clear();
}
