/**
 * Photos shared to Gli from another app (A10-8 §8.7) — the file glue. A share hands over bare files,
 * so the capture time and the GPS fix are read here, on device, from the file's own EXIF (core's
 * `readJpegExif`), before the pipeline's re-encode strips everything (D31). Untested native glue;
 * the reader and where the photos land are core's, and are.
 *
 * The staged share is a module-level note, as `hazardPrefill` is: the new-report door takes it by
 * the id its route param carries, once.
 */

import { JPEG_EXIF_HEAD_BYTES, readJpegExif } from '@skating/core';
import { File } from 'expo-file-system';
import type { ShareIntentFile } from 'expo-share-intent';
import { Image } from 'react-native';
import type { PhotoAssetLike } from '../components/photoPipeline';
import { exifTakenAt } from './photo';

/** A shared photo as the pipeline takes it, with its capture time when the file had one. */
export type SharedPhoto = PhotoAssetLike & { takenAtMs?: number };

function fileUri(path: string): string {
  return /^[a-z]+:\/\//i.test(path) ? path : `file://${path}`;
}

function imageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) =>
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject),
  );
}

/** The shared files that are photos, read for what the sheet uses. A file that will not read is skipped. */
export async function readSharedPhotos(files: readonly ShareIntentFile[]): Promise<SharedPhoto[]> {
  const out: SharedPhoto[] = [];
  for (const f of files) {
    if (!f.mimeType?.startsWith('image/')) continue;
    const uri = fileUri(f.path);
    // The metadata is a bonus: a file whose head will not read still lands, undated.
    let exif: Record<string, string | number> | null = null;
    if (/jpe?g/i.test(f.mimeType)) {
      try {
        const handle = new File(uri).open();
        try {
          exif = readJpegExif(handle.readBytes(Math.min(handle.size ?? 0, JPEG_EXIF_HEAD_BYTES)));
        } finally {
          handle.close();
        }
      } catch {
        exif = null;
      }
    }
    try {
      const size =
        f.width && f.height ? { width: f.width, height: f.height } : await imageSize(uri);
      const takenAtMs = exifTakenAt(exif);
      out.push({
        uri,
        ...size,
        exif,
        ...(takenAtMs !== undefined ? { takenAtMs, creationTime: takenAtMs } : {}),
      });
    } catch {
      // Unreadable — the rest still land.
    }
  }
  return out;
}

/**
 * Staged shares by their door's id. Keyed, not one slot: two shares in quick succession each open
 * their own door, and the second must not overwrite the first before its door reads it.
 */
const staged = new Map<string, SharedPhoto[]>();

/** Kept at most — a share whose door never opened is not held forever. */
const MAX_STAGED = 8;

export function stageShare(id: string, photos: SharedPhoto[]): void {
  staged.set(id, photos);
  while (staged.size > MAX_STAGED) {
    const oldest = staged.keys().next().value;
    if (oldest === undefined) break;
    staged.delete(oldest);
  }
}

/**
 * The staged share for a door. Read, not taken: an opening that failed is retried with the same id
 * and must still find its photos. `settleShare(id, 'opened')` lets it go once the sheet is built.
 */
export function stagedShare(id: string): SharedPhoto[] | null {
  return staged.get(id) ?? null;
}

/**
 * How a share's door ended: its sheet was built (`opened`), it could not be (`failed`), or the open
 * sheet held it back — an edit with unsaved changes, a park that failed (`held`).
 */
export type ShareOutcome = 'opened' | 'failed' | 'held';

const waiting = new Map<string, (outcome: ShareOutcome) => void>();

/**
 * Resolve when the share's door says how it ended — not after a guess at how long a door takes: a
 * door building twenty photos can take longer than any fixed wait, and the next share navigating
 * away meanwhile would cancel it. `timeoutMs` is only the backstop for a door that never ran; the
 * share stays staged either way.
 */
export function whenShareSettles(id: string, timeoutMs: number): Promise<ShareOutcome | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve('timeout');
    }, timeoutMs);
    waiting.set(id, (outcome) => {
      clearTimeout(timer);
      resolve(outcome);
    });
  });
}

/** The door says how it ended. An opened share's photos are on its sheet, so its staging goes. */
export function settleShare(id: string, outcome: ShareOutcome): void {
  if (outcome === 'opened') staged.delete(id);
  const resolve = waiting.get(id);
  waiting.delete(id);
  resolve?.(outcome);
}
