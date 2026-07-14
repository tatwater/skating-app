/**
 * Pure photo-pipeline helpers (§E, D31/D42). The heavy work — HEIC decode, EXIF read, downscale +
 * EXIF-strip re-encode, upload — is browser-only glue in `../components/photoPipeline`; the
 * privacy-critical *decisions* live here so they're unit-testable and can't silently regress.
 */

/**
 * Whether a file is HEIC/HEIF (iPhone's default). Chrome/Firefox can't decode HEIC in a `<canvas>`,
 * so the pipeline must decode these to JPEG before the optimize/strip pass (D31, HEIC-on-web).
 * Checks MIME type first, then the extension (browsers sometimes hand over a blank/generic type).
 */
export function isHeic(file: { type: string; name: string }): boolean {
  const type = file.type.toLowerCase()
  if (type === 'image/heic' || type === 'image/heif') return true
  return /\.(heic|heif)$/i.test(file.name)
}

/**
 * D42 gate, client side: a photo's GPS `coord` is sent to the server **only** when the uploader
 * opted into `placeOnMap`. The server re-drops it regardless (defense in depth), but gating here
 * means a non-opted coord never leaves the browser in the first place.
 */
export function photoUploadCoord(
  placeOnMap: boolean,
  coord: { lat: number; lng: number } | undefined,
): { lat: number; lng: number } | undefined {
  return placeOnMap ? coord : undefined
}
