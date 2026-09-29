/**
 * Photos shared to Gli from another app (A10-8 §8.7) — the file glue. A share hands over bare files,
 * so the capture time and the GPS fix are read here, on device, from the file's own EXIF (core's
 * `readJpegExif`), before the pipeline's re-encode strips everything (D31). Untested native glue;
 * the reader and where the photos land are core's, and are.
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
