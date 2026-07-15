import * as ImageManipulator from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { exifCoord } from '../lib/photo'

/**
 * Native photo-pipeline glue (§F, D31/D42) — the mobile analog of web's `photoPipeline.ts`, but much
 * simpler: `expo-image-picker` returns EXIF (incl. GPS) directly (no `exifr`) and reads HEIC natively
 * (no `heic2any`), and `expo-image-manipulator` resizes + re-encodes to strip EXIF (no
 * `browser-image-compression`). The privacy invariant is unchanged: the coord is read from the
 * original before the re-encode drops all metadata, and only leaves the device on the `placeOnMap`
 * opt-in (gated by `@skating/core` `photoUploadCoord`). Untested (native modules) like the map shell.
 */

const FULL_MAX_EDGE = 2048
const THUMB_MAX_EDGE = 400

export interface ProcessedPhoto {
  /** Optimized, EXIF-stripped full image + thumbnail (file URIs), ready to upload. */
  fullUri: string
  thumbUri: string
  /** EXIF GPS if the original carried it — surfaced for the opt-in `placeOnMap` toggle (D42). */
  coord?: { lat: number; lng: number }
}

/** Launch the library picker (multi-select, EXIF on). Returns [] if the user cancels. */
export async function pickPhotos(): Promise<ImagePicker.ImagePickerAsset[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!perm.granted) throw new Error('Photo library permission denied')
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    exif: true,
    quality: 1,
  })
  return result.canceled ? [] : result.assets
}

/** Downscale the long edge to `maxEdge` (never upscaling) + re-encode to JPEG (strips EXIF). */
async function resizeAndStrip(
  asset: ImagePicker.ImagePickerAsset,
  maxEdge: number,
): Promise<string> {
  const longEdge = Math.max(asset.width, asset.height)
  const target = Math.min(maxEdge, longEdge)
  const resize = asset.width >= asset.height ? { width: target } : { height: target }
  const out = await ImageManipulator.manipulateAsync(asset.uri, [{ resize }], {
    compress: 0.85,
    format: ImageManipulator.SaveFormat.JPEG,
  })
  return out.uri
}

/** Read EXIF GPS from the original, then produce the stripped full + thumb. */
export async function processPhoto(asset: ImagePicker.ImagePickerAsset): Promise<ProcessedPhoto> {
  const coord = exifCoord(asset.exif)
  const [fullUri, thumbUri] = await Promise.all([
    resizeAndStrip(asset, FULL_MAX_EDGE),
    resizeAndStrip(asset, THUMB_MAX_EDGE),
  ])
  return { fullUri, thumbUri, coord }
}

/** Upload a local file URI to a Convex storage upload URL; returns the resulting `storageId`. */
export async function uploadToStorage(uploadUrl: string, uri: string): Promise<string> {
  const blob = await (await fetch(uri)).blob()
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
  })
  if (!res.ok) throw new Error(`Photo upload failed (${res.status})`)
  const { storageId } = (await res.json()) as { storageId: string }
  return storageId
}
