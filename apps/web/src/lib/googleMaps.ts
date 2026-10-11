import type { LatLng } from '@skating/core';

/**
 * A Google Maps link that drops a pin on a coordinate — a moderator's second look at a spot a skater
 * marked, in imagery and place names we do not hold. The documented Maps URL form (`api=1`), so it
 * keeps working; Satellite is one click once it opens. Only the coordinate leaves, never who marked it.
 */
export function googleMapsUrl(coord: LatLng): string {
  const query = `${coord.lat.toFixed(6)},${coord.lng.toFixed(6)}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
