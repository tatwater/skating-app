/**
 * Pure, native-side photo helpers (§F, D42). The D42 upload gate itself (`photoUploadCoord`) is
 * shared from `@skating/core`; this parses a GPS coord out of an `expo-image-picker` asset's EXIF,
 * which is platform-shaped (iOS/Android tag differences), so it stays app-local and unit-tested. The
 * coord is read from the ORIGINAL here, *before* `expo-image-manipulator` re-encodes (which strips
 * EXIF), so the only location that can leave the device is one the user opts to place on the map.
 */

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * Best-effort decimal `{ lat, lng }` from an image-picker asset's EXIF, or `undefined` when there's
 * no parseable GPS. Handles decimal `GPSLatitude`/`GPSLongitude` and applies the `N/S`/`E/W` ref to
 * the magnitude when present; validates the coordinate is in range so garbage never becomes a pin.
 */
export function exifCoord(
  exif: Record<string, unknown> | null | undefined,
): { lat: number; lng: number } | undefined {
  if (!exif) return undefined
  const rawLat = toFiniteNumber(exif.GPSLatitude)
  const rawLng = toFiniteNumber(exif.GPSLongitude)
  if (rawLat === undefined || rawLng === undefined) return undefined

  const latRef = String(exif.GPSLatitudeRef ?? '')
    .trim()
    .toUpperCase()
  const lngRef = String(exif.GPSLongitudeRef ?? '')
    .trim()
    .toUpperCase()
  // A ref forces the sign against the magnitude; without one, trust the value as given.
  const lat = latRef === 'S' ? -Math.abs(rawLat) : latRef === 'N' ? Math.abs(rawLat) : rawLat
  const lng = lngRef === 'W' ? -Math.abs(rawLng) : lngRef === 'E' ? Math.abs(rawLng) : rawLng

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return undefined
  if (lat === 0 && lng === 0) return undefined // null-island: almost always missing GPS, not a real fix
  return { lat, lng }
}
