import type { Id } from '@skating/convex/dataModel';
import { useEffect, useMemo } from 'react';

import { processPhoto, uploadToStorage } from '../../photoPipeline';
import type { PhotoPreview } from './HazardFlowView';

/**
 * The hazard flow's photos. The files live in the draft store's memory (a reload can't keep a
 * `File`), so previews are derived from them here and the upload happens once, at Post — nothing is
 * sent for a hazard nobody files.
 *
 * **No location leaves with a photo.** A hazard already has a footprint, and an EXIF coordinate
 * riding along would invite a second, differently derived location to contradict it.
 */

let nextId = 0;
const ids = new WeakMap<File, string>();

/** A stable id per file for the life of the page — what Remove names. */
export function photoIdOf(file: File): string {
  let id = ids.get(file);
  if (id === undefined) {
    nextId += 1;
    id = `photo-${nextId}`;
    ids.set(file, id);
  }
  return id;
}

export function usePhotoPreviews(files: readonly File[]): PhotoPreview[] {
  const previews = useMemo(
    () =>
      files.map((file) => ({
        id: photoIdOf(file),
        url: URL.createObjectURL(file),
        name: file.name,
      })),
    [files],
  );
  useEffect(
    () => () => {
      for (const p of previews) URL.revokeObjectURL(p.url);
    },
    [previews],
  );
  return previews;
}

export interface PhotoUploadDeps {
  generateUploadUrl: () => Promise<string>;
  createPhoto: (args: {
    storageId: Id<'_storage'>;
    thumbStorageId: Id<'_storage'>;
    placeOnMap: boolean;
  }) => Promise<Id<'photos'>>;
  deletePhoto: (args: { photoId: Id<'photos'> }) => Promise<unknown>;
}

/**
 * Process and upload every file, returning the photo ids in order. On any failure the rows already
 * made are deleted (best-effort) before the error is rethrown, so a failed Post strands nothing.
 */
export async function uploadHazardPhotos(
  files: readonly File[],
  deps: PhotoUploadDeps,
): Promise<Id<'photos'>[]> {
  const made: Id<'photos'>[] = [];
  try {
    for (const file of files) {
      const processed = await processPhoto(file);
      const [storageId, thumbStorageId] = await Promise.all(
        [processed.full, processed.thumb].map(async (blob) => {
          const url = await deps.generateUploadUrl();
          return (await uploadToStorage(url, blob)) as Id<'_storage'>;
        }),
      );
      made.push(
        await deps.createPhoto({
          storageId: storageId as Id<'_storage'>,
          thumbStorageId: thumbStorageId as Id<'_storage'>,
          placeOnMap: false,
        }),
      );
    }
    return made;
  } catch (error) {
    for (const photoId of made) void deps.deletePhoto({ photoId }).catch(() => {});
    throw error;
  }
}
