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
 */

import type { DraftPhoto } from '@skating/core';
import { type ProcessedPhoto, processPhoto } from '../components/photoPipeline';

interface HeldPhoto {
  full: File;
  thumb: File;
  previewUrl: string;
}

const held = new Map<string, HeldPhoto>();

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
}

/** Drop every held blob — after a Post lands, or when a restored sheet arrives without its files. */
export function releaseAllSheetPhotos(): void {
  for (const id of [...held.keys()]) releaseSheetPhoto(id);
}
