/**
 * The files behind the sheet's photos (A10-5 / §8.2), held beside the sheet rather than in it.
 *
 * The sheet's `SheetReport.photos` are core `DraftPhoto` records — ids, the EXIF coordinate, the
 * `placeOnMap` opt-in — which is what the model serializes and what `flushPost` uploads. On a
 * phone those records point at real files on disk. A browser has no such path, so the processed
 * blobs and their preview URLs live here, in a module map keyed by the same id, and the sheet
 * stays JSON.
 *
 * The privacy invariant is the pipeline's, unchanged (D31/D42): `processPhoto` reads EXIF GPS from
 * the original and the re-encode strips all metadata, so the only location that can leave the
 * browser is one the author opted to place on the map (`photoUploadCoord`, applied at upload).
 *
 * **The map is what the tab uses; IndexedDB is how it survives a reload (B03 §5).** Every reader
 * stays synchronous against the map. `syncSheetPhotos` reconciles the store with the one thing
 * that decides what should exist — the sheet record's claim — so there is a single rule rather
 * than a delete at every door: a stored blob the claim does not name goes, whoever's it was and
 * however it stopped being named (removed, posted, abandoned, expired, overwritten by another
 * draft). A failure here costs the photos on a reload, never the sheet in front of the author.
 */

import type { DraftPhoto } from '@skating/core';
import { type ProcessedPhoto, processPhoto } from '../components/photoPipeline';
import {
  createSheetPhotoDb,
  type SheetPhotoDb,
  type SheetPhotoRow,
  type SheetPhotoScope,
} from './sheetPhotoDb';

interface HeldPhoto {
  full: File;
  thumb: File;
  previewUrl: string;
}

/** The photos the stored sheet record says exist, and whose they are. */
export interface SheetPhotoClaim extends SheetPhotoScope {
  photoIds: readonly string[];
}

const held = new Map<string, HeldPhoto>();
/** Ids `adoptSheetPhotos` brought back: a restore the route then declines must not leave them held. */
const restored = new Set<string>();
let db: SheetPhotoDb = createSheetPhotoDb();

/** Store operations run one at a time, in order, so a restore never reads across a sweep. */
let tail: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work);
  tail = run.catch(() => {});
  return run;
}

/**
 * Process one picked file into a draft record the sheet can hold, keeping its blobs here.
 * Throws what `processPhoto` throws — the panel turns that into its own sentence.
 */
export async function addSheetPhoto(file: File): Promise<DraftPhoto> {
  const processed: ProcessedPhoto = await processPhoto(file);
  const id = crypto.randomUUID();
  held.set(id, {
    full: processed.full,
    thumb: processed.thumb,
    previewUrl: URL.createObjectURL(processed.thumb),
  });
  return {
    id,
    // The sheet addresses a blob by the same id at both ends; there is no path to point at.
    fullUri: `${id}:full`,
    thumbUri: `${id}:thumb`,
    ...(processed.coord ? { coord: processed.coord } : {}),
    ...(processed.takenAtMs !== undefined ? { takenAtMs: processed.takenAtMs } : {}),
    placeOnMap: false,
  };
}

/** The preview for a draft photo, or `null` once its blobs have been released. */
export function sheetPhotoPreview(id: string): string | null {
  return held.get(id)?.previewUrl ?? null;
}

/** The blob one of `flushPost`'s upload calls is asking for, by the uri the record carries. */
export function sheetPhotoBlob(uri: string): File | null {
  const [id, which] = uri.split(':');
  if (id === undefined) return null;
  const entry = held.get(id);
  if (!entry) return null;
  return which === 'thumb' ? entry.thumb : entry.full;
}

/** Drop a photo the author removed, revoking its preview. */
export function releaseSheetPhoto(id: string): void {
  const entry = held.get(id);
  if (!entry) return;
  URL.revokeObjectURL(entry.previewUrl);
  held.delete(id);
  restored.delete(id);
}

/** Drop every held blob — after a Post lands, or when a restored sheet arrives without its files. */
export function releaseAllSheetPhotos(): void {
  for (const id of [...held.keys()]) releaseSheetPhoto(id);
}

/**
 * Bring the store in line with the claim: anything it does not name goes, and anything it names that
 * is held here but not yet stored is written. `true` when every claimed photo ended up stored.
 *
 * Collects before it writes — the garbage is what a full disk needs back — and writes one row per
 * transaction, so one photo over quota does not cost the others.
 */
async function reconcile(claim: SheetPhotoClaim | null): Promise<boolean> {
  const claimed = new Set(claim?.photoIds ?? []);
  try {
    const keys = await db.keys(claim);
    const inScope = new Set(keys.inScope);
    const kept = new Set([...claimed].filter((id) => inScope.has(id)));
    await db.remove(keys.all.filter((id) => !kept.has(id)));
    if (claim === null) return true;

    let everyPhotoStored = true;
    for (const photoId of claimed) {
      if (kept.has(photoId)) continue;
      const entry = held.get(photoId);
      try {
        if (!entry) throw new Error('No blob to store');
        await db.put({
          photoId,
          owner: claim.owner,
          draftId: claim.draftId,
          full: entry.full,
          thumb: entry.thumb,
          storedAt: Date.now(),
        });
      } catch {
        everyPhotoStored = false;
      }
    }
    return everyPhotoStored;
  } catch {
    // A store that cannot answer has lost nothing the claim did not ask it to keep.
    return claimed.size === 0;
  }
}

let wanted: SheetPhotoClaim | null = null;
let syncQueued = false;

/**
 * Reconcile the store with `claim`, in the background. Calls that arrive while one is waiting
 * collapse into it, and each pass reads the latest claim, so the store converges on the last word.
 * `onSettled` hears whether every claimed photo reached the store. Never rejects.
 */
export function syncSheetPhotos(
  claim: SheetPhotoClaim | null,
  onSettled: (everyPhotoStored: boolean) => void,
): void {
  wanted = claim;
  if (syncQueued) return;
  syncQueued = true;
  void enqueue(async () => {
    syncQueued = false;
    onSettled(await reconcile(wanted));
  });
}

/**
 * Can this blob still be read? A row can outlive its bytes — the browser evicted the file behind
 * it — and `size` still answers; only a read finds out, and better here than at the upload.
 */
async function readable(blob: Blob | undefined): Promise<boolean> {
  try {
    if (!(blob instanceof Blob) || blob.size === 0) return false;
    await blob.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/**
 * The stored rows the claim names whose blobs can still be read. Filed under the claim's own owner
 * and draft, or not returned at all. Never rejects: a store that cannot answer has no photos.
 */
export function readSheetPhotos(claim: SheetPhotoClaim): Promise<SheetPhotoRow[]> {
  return enqueue(async () => {
    try {
      const rows = await db.read(claim);
      const usable = await Promise.all(
        rows.map(async (row) => {
          const claimed = claim.photoIds.includes(row.photoId);
          return claimed && (await readable(row.full)) && (await readable(row.thumb));
        }),
      );
      return rows.filter((_, i) => usable[i]);
    } catch {
      return [];
    }
  });
}

/** Hold what a restore read back, so the map's readers find it as if it had just been picked. */
export function adoptSheetPhotos(rows: readonly SheetPhotoRow[]): void {
  for (const row of rows) {
    if (held.has(row.photoId)) continue;
    held.set(row.photoId, {
      full: row.full,
      thumb: row.thumb,
      previewUrl: URL.createObjectURL(row.thumb),
    });
    restored.add(row.photoId);
  }
}

/** Let go of restored photos the sheet now open does not use — a restore the door turned down. */
export function releaseRestoredPhotosExcept(photoIds: readonly string[]): void {
  for (const id of [...restored]) {
    if (photoIds.includes(id)) restored.delete(id);
    else releaseSheetPhoto(id);
  }
}

/** Resolves once every store operation queued so far, and any queued meanwhile, has finished. */
export async function whenSheetPhotosSettled(): Promise<void> {
  let seen: Promise<unknown>;
  do {
    seen = tail;
    await seen;
  } while (seen !== tail);
}

/** Test seam: run against this store, with nothing held and nothing queued. */
export function setSheetPhotoDbForTests(next: SheetPhotoDb): void {
  db = next;
  held.clear();
  restored.clear();
  wanted = null;
  syncQueued = false;
  tail = Promise.resolve();
}
