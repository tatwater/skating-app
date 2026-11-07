import type { MapOverlay } from '../map/mapSpec';

/**
 * What an open report draws on the region map (board 2.4): its own path over the lake, when it has
 * one, and its placed photos as numbered pins — the numbers match the photos' order in the card.
 * Keyed by what they draw, so the map re-sources only when the drawing changes.
 */

/** A recorded path, as `gpsActivities.getForReport` sends it (already clipped at the put-in, D58). */
export interface ReportTrack {
  path: GeoJSON.LineString;
}

export interface PlacedPhoto {
  photoId: string;
  coord?: { lat: number; lng: number };
}

export function trackOverlay(
  reportId: string,
  track: ReportTrack | null | undefined,
): MapOverlay | null {
  if (!track) return null;
  return {
    key: `track:${reportId}:${track.path.coordinates.length}`,
    data: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: track.path, properties: {} }],
    },
  };
}

export function photosOverlay(
  reportId: string,
  photos: readonly PlacedPhoto[] | undefined,
): MapOverlay | null {
  const placed = (photos ?? []).flatMap((photo, i) =>
    photo.coord === undefined ? [] : [{ photo, n: i + 1, coord: photo.coord }],
  );
  if (placed.length === 0) return null;
  return {
    key: `photos:${reportId}:${placed.map((p) => p.photo.photoId).join(',')}`,
    data: {
      type: 'FeatureCollection',
      features: placed.map(({ photo, n, coord }) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [coord.lng, coord.lat] },
        properties: { photoId: photo.photoId, n },
      })),
    },
  };
}
