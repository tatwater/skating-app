/**
 * Pure, privacy-critical photo decisions shared by both apps (§E, D42). The heavy pipeline glue —
 * decode, EXIF read, downscale + strip, upload — is platform-specific (browser canvas/WASM on web,
 * `expo-image-picker`/`expo-image-manipulator` on native); this gate is the part that must never
 * silently regress, so it lives in `@skating/core` where it's unit-tested and reused by both.
 */

/**
 * D42 gate, client side: a photo's GPS `coord` is sent to the server **only** when the uploader
 * opted into `placeOnMap`. The server re-drops it regardless (defense in depth), but gating here
 * means a non-opted coord never leaves the device in the first place.
 */
export function photoUploadCoord(
  placeOnMap: boolean,
  coord: { lat: number; lng: number } | undefined,
): { lat: number; lng: number } | undefined {
  return placeOnMap ? coord : undefined;
}
