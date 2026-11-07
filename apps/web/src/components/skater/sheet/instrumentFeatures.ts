/**
 * What the instrument's map draws (5.1), as GeoJSON — pure, so the drawing is a unit test and the
 * canvas only hands these to MapLibre. One lake, its launches and lots (the chosen one lit), the live
 * hazards at their footprints' centers, the photos placed on the water, and the track when one is
 * linked. No other lake, no labels of other bodies: the instrument answers "this lake, this day".
 */

import type { BBox, LatLng } from '@skating/core';
import type { Feature, FeatureCollection, LineString, MultiPolygon, Point, Polygon } from 'geojson';

export interface InstrumentPin {
  id: string;
  coord: LatLng;
  name: string;
  kind: 'putIn' | 'parking';
}

export interface InstrumentHazard {
  id: string;
  bbox: BBox;
  passage: boolean;
}

export interface InstrumentInput {
  polygon: Polygon | MultiPolygon | null;
  pins: readonly InstrumentPin[];
  chosenPinId?: string;
  hazards: readonly InstrumentHazard[];
  photos: readonly { id: string; coord: LatLng }[];
  /** `[lng, lat]` pairs of the linked track. */
  track?: readonly (readonly number[])[];
  /** A point the author set by hand (no put-in chosen). */
  point?: LatLng;
}

export const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

const point = (coord: LatLng, properties: Record<string, unknown>): Feature<Point> => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [coord.lng, coord.lat] },
  properties,
});

export function lakeFeatures(polygon: Polygon | MultiPolygon | null): FeatureCollection {
  if (polygon === null) return EMPTY;
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: polygon, properties: {} }],
  };
}

/** The marks: pins (chosen lit), hazards, photos, the hand-set point. Kind in `kind`. */
export function markFeatures(input: InstrumentInput): FeatureCollection<Point> {
  const features: Feature<Point>[] = [
    ...input.pins.map((p) =>
      point(p.coord, { id: p.id, kind: p.kind, chosen: p.id === input.chosenPinId }),
    ),
    ...input.hazards.map((h) =>
      point(
        { lat: (h.bbox.minLat + h.bbox.maxLat) / 2, lng: (h.bbox.minLng + h.bbox.maxLng) / 2 },
        { id: h.id, kind: h.passage ? 'passage' : 'hazard', chosen: false },
      ),
    ),
    ...input.photos.map((p) => point(p.coord, { id: p.id, kind: 'photo', chosen: false })),
    ...(input.point !== undefined && input.chosenPinId === undefined
      ? [point(input.point, { id: 'point', kind: 'point', chosen: true })]
      : []),
  ];
  return { type: 'FeatureCollection', features };
}

export function trackFeatures(track: InstrumentInput['track']): FeatureCollection<LineString> {
  if (track === undefined || track.length < 2) return EMPTY as FeatureCollection<LineString>;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: track.map((c) => [c[0] ?? 0, c[1] ?? 0]) },
        properties: {},
      },
    ],
  };
}

/** The lake's bounds, `[[w, s], [e, n]]`, or `null` with no outline. */
export function lakeBounds(
  polygon: Polygon | MultiPolygon | null,
): [[number, number], [number, number]] | null {
  if (polygon === null) return null;
  const rings = polygon.type === 'Polygon' ? polygon.coordinates : polygon.coordinates.flat();
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const ring of rings) {
    for (const [lng = 0, lat = 0] of ring) {
      w = Math.min(w, lng);
      e = Math.max(e, lng);
      s = Math.min(s, lat);
      n = Math.max(n, lat);
    }
  }
  if (!Number.isFinite(w)) return null;
  return [
    [w, s],
    [e, n],
  ];
}
