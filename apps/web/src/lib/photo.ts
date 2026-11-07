/**
 * Web-only photo helper (§5, D31). The privacy-critical `photoUploadCoord` gate (D42) is shared
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
  const type = file.type.toLowerCase();
  if (type === 'image/heic' || type === 'image/heif') return true;
  return /\.(heic|heif)$/i.test(file.name);
}

/**
 * What the profile-photo picker offers: the formats the avatar pipeline can turn into a JPEG. HEIC
 * is listed by extension too, because some browsers hand an iPhone photo over with no type.
 */
export const AVATAR_ACCEPT =
  'image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif';

const AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Whether a picked file is one the avatar pipeline takes: JPEG, PNG, WebP, or HEIC/HEIF. The
 * picker's `accept` is only a hint — "All files" gets past it — so this is the check that counts.
 * A blank or generic type falls back to the extension, as `isHeic` does.
 */
export function isAvatarImage(file: { type: string; name: string }): boolean {
  if (isHeic(file)) return true;
  const type = file.type.toLowerCase();
  if (type !== '' && type !== 'application/octet-stream') return AVATAR_TYPES.has(type);
  return /\.(jpe?g|png|webp)$/i.test(file.name);
}
