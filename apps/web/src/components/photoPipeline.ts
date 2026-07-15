import { isHeic } from '../lib/photo'

/**
 * Browser-only photo pipeline glue (§E, D31/D42). Untestable in jsdom (canvas/WASM/network), so it
 * lives outside `src/lib` (coverage collects only pure `lib` code); the pure decisions it leans on
 * (`isHeic`, `photoUploadCoord`) are in `../lib/photo` and unit-tested. The privacy invariant: EXIF
 * GPS/timestamp are read from the ORIGINAL, then the re-encode strips ALL metadata, so the only
 * location that can leave the browser is one the user explicitly opts to place on the map.
 *
 * Heavy deps are dynamically imported so they never load during SSR or for non-photo sessions.
 */

const FULL_MAX_EDGE = 2048
const THUMB_MAX_EDGE = 400

export interface ProcessedPhoto {
  /** Optimized, EXIF-stripped full image + thumbnail, ready to upload. */
  full: File
  thumb: File
  /** EXIF GPS, if the original carried it — surfaced for the opt-in `placeOnMap` toggle (D42). */
  coord?: { lat: number; lng: number }
}

function toJpegName(name: string): string {
  return `${name.replace(/\.[^.]+$/, '')}.jpg`
}

/**
 * Decode (HEIC→JPEG if needed), read EXIF GPS from the original, then downscale + re-encode to a
 * ~2048px full and ~400px thumb with all metadata stripped.
 */
export async function processPhoto(file: File): Promise<ProcessedPhoto> {
  // 1. EXIF GPS from the ORIGINAL, before the re-encode drops it. Failures are non-fatal (no coord).
  let coord: { lat: number; lng: number } | undefined
  try {
    const exifrMod = await import('exifr')
    const exifr = exifrMod.default ?? exifrMod
    const gps = await exifr.gps(file)
    if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
      coord = { lat: gps.latitude, lng: gps.longitude }
    }
  } catch {
    // No/unreadable EXIF — fine; coord stays undefined.
  }

  // 2. HEIC/HEIF → JPEG so the canvas re-encode below can read it (Chrome/Firefox can't decode HEIC).
  let decoded: Blob = file
  if (isHeic(file)) {
    const heic2any = (await import('heic2any')).default
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 })
    decoded = Array.isArray(out) ? (out[0] ?? file) : out
  }
  const decodedFile = new File([decoded], toJpegName(file.name), { type: 'image/jpeg' })

  // 3. Downscale + re-encode (strips EXIF by construction — browser-image-compression drops metadata).
  const imageCompression = (await import('browser-image-compression')).default
  const [full, thumb] = await Promise.all([
    imageCompression(decodedFile, {
      maxWidthOrHeight: FULL_MAX_EDGE,
      useWebWorker: true,
      initialQuality: 0.85,
      fileType: 'image/jpeg',
    }),
    imageCompression(decodedFile, {
      maxWidthOrHeight: THUMB_MAX_EDGE,
      useWebWorker: true,
      initialQuality: 0.7,
      fileType: 'image/jpeg',
    }),
  ])

  return { full, thumb, coord }
}

/** Upload a blob to a Convex storage upload URL; returns the resulting `storageId`. */
export async function uploadToStorage(uploadUrl: string, blob: Blob): Promise<string> {
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': blob.type },
    body: blob,
  })
  if (!res.ok) throw new Error(`Photo upload failed (${res.status})`)
  const { storageId } = (await res.json()) as { storageId: string }
  return storageId
}
