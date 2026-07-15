/**
 * Web-only photo helper (§E, D31). The privacy-critical `photoUploadCoord` gate (D42) is shared
 * from `@skating/core`; this `isHeic` check is browser-specific (only browsers can't decode HEIC in
 * a `<canvas>`, so only web needs to detect it and route through `heic2any` first — native decodes
 * HEIC natively via `expo-image-manipulator`).
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
