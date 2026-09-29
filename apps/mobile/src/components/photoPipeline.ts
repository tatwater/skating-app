import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { exifCoord, exifTakenAt } from '../lib/photo';

/**
 * Native photo-pipeline glue (§6, D31/D42) — the mobile analog of web's `photoPipeline.ts`, but much
 * simpler: `expo-image-picker` returns EXIF (incl. GPS) directly (no `exifr`) and reads HEIC natively
 * (no `heic2any`), and `expo-image-manipulator` resizes + re-encodes to strip EXIF (no
 * `browser-image-compression`). The privacy invariant is unchanged: the coord is read from the
 * original before the re-encode drops all metadata, and only leaves the device on the `placeOnMap`
 * opt-in (gated by `@skating/core` `photoUploadCoord`). Untested (native modules) like the map shell.
 */

const FULL_MAX_EDGE = 2048;
const THUMB_MAX_EDGE = 400;

export interface ProcessedPhoto {
  /** Optimized, EXIF-stripped full image + thumbnail (file URIs), ready to upload. */
  fullUri: string;
  thumbUri: string;
  /** EXIF GPS if the original carried it — surfaced for the opt-in `placeOnMap` toggle (D42). */
  coord?: { lat: number; lng: number };
  /** EXIF capture time, epoch ms, when the original carried one (A10-7 assigns by it). Never sent. */
  takenAtMs?: number;
}

/** What the pipeline needs of a picked or library asset: its file and its size, plus EXIF when read. */
export type PhotoAssetLike = Pick<ImagePicker.ImagePickerAsset, 'uri' | 'width' | 'height'> & {
  exif?: Record<string, unknown> | null;
  /** The library's own capture time (ms), when EXIF has none — `expo-media-library`'s `creationTime`. */
  creationTime?: number;
  /** The library's own location, when EXIF has none — `Asset.getLocation` (A10-8). */
  location?: { lat: number; lng: number };
};

/**
 * Launch the system photo picker (multi-select, EXIF on). Returns [] if the user cancels. It needs
 * no permission on either phone (D207): on Android it is the system picker, which also shows the
 * person's Google Photos; on iOS it is PHPicker. Asking first would put the library prompt in front
 * of a picker that never needed it.
 */
export async function pickPhotos(): Promise<ImagePicker.ImagePickerAsset[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    exif: true,
    quality: 1,
  });
  return result.canceled ? [] : result.assets;
}

/** Downscale the long edge to `maxEdge` (never upscaling) + re-encode to JPEG (strips EXIF). */
async function resizeAndStrip(asset: PhotoAssetLike, maxEdge: number): Promise<string> {
  const longEdge = Math.max(asset.width, asset.height);
  const target = Math.min(maxEdge, longEdge);
  const resize = asset.width >= asset.height ? { width: target } : { height: target };
  const out = await ImageManipulator.manipulateAsync(asset.uri, [{ resize }], {
    compress: 0.85,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  return out.uri;
}

/** Read EXIF GPS from the original, then produce the stripped full + thumb. */
export async function processPhoto(asset: PhotoAssetLike): Promise<ProcessedPhoto> {
  const coord = exifCoord(asset.exif) ?? asset.location;
  const takenAtMs = exifTakenAt(asset.exif) ?? asset.creationTime;
  const [fullUri, thumbUri] = await Promise.all([
    resizeAndStrip(asset, FULL_MAX_EDGE),
    resizeAndStrip(asset, THUMB_MAX_EDGE),
  ]);
  return { fullUri, thumbUri, coord, ...(takenAtMs !== undefined ? { takenAtMs } : {}) };
}

/** Upload a local file URI to a Convex storage upload URL; returns the resulting `storageId`. */
export async function uploadToStorage(uploadUrl: string, uri: string): Promise<string> {
  const blob = await (await fetch(uri)).blob();
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
  });
  if (!res.ok) throw new Error(`Photo upload failed (${res.status})`);
  const { storageId } = (await res.json()) as { storageId: string };
  return storageId;
}
