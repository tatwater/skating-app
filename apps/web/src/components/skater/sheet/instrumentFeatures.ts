/**
 * What the instrument's map draws (5.1) — pure, so the drawing is a unit test. One lake and the
 * track when one is linked, as GeoJSON for MapLibre; its launches and lots (the chosen one lit), the
 * live hazards at their footprints' centers and the photos placed on the water as the region map's
 * own marks, drawn over the canvas. No other lake, no labels of other bodies: the instrument
 * answers "this lake, this day".
 */

import type { BBox, LatLng } from '@skating/core';
import type { FeatureCollection, LineString, MultiPolygon, Polygon } from 'geojson';
import type { MapKeyKind } from '../../kit/map-key';
import { HAZARD_KEY_KIND, type HazardTone } from '../map/mapDerive';

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
  /** Its latest verdict is "healing but unsafe" — the region map's healing tone. */
  healing?: boolean;
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

export function lakeFeatures(polygon: Polygon | MultiPolygon | null): FeatureCollection {
  if (polygon === null) return EMPTY;
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: polygon, properties: {} }],
  };
}

/** The marks' share of the input: what `InstrumentMarks` draws. */
export type InstrumentMarksInput = Pick<
  InstrumentInput,
  'pins' | 'chosenPinId' | 'hazards' | 'photos' | 'point'
>;

/** One mark on the instrument: a launch or lot, a hazard, a placed photo, or the hand-set point. */
export type InstrumentMark = { id: string; coord: LatLng; chosen: boolean } & (
  | { kind: 'putIn' | 'parking' | 'photo' | 'point' }
  | { kind: 'hazard'; tone: HazardTone }
);

function hazardTone(h: InstrumentHazard): HazardTone {
  return h.passage ? 'passage' : h.healing ? 'healing' : 'danger';
}

/** The marks, bottom to top: pins (chosen lit), hazards, photos, the hand-set point. */
export function instrumentMarks(input: InstrumentMarksInput): InstrumentMark[] {
  return [
    ...input.pins.map((p) => ({
      id: p.id,
      coord: p.coord,
      kind: p.kind,
      chosen: p.id === input.chosenPinId,
    })),
    ...input.hazards.map((h) => ({
      id: h.id,
      coord: { lat: (h.bbox.minLat + h.bbox.maxLat) / 2, lng: (h.bbox.minLng + h.bbox.maxLng) / 2 },
      kind: 'hazard' as const,
      tone: hazardTone(h),
      chosen: false,
    })),
    ...input.photos.map((p) => ({
      id: p.id,
      coord: p.coord,
      kind: 'photo' as const,
      chosen: false,
    })),
    ...(input.point !== undefined && input.chosenPinId === undefined
      ? [{ id: 'point', coord: input.point, kind: 'point' as const, chosen: true }]
      : []),
  ];
}

/**
 * The pin a chip is pointing at, when the instrument is drawing it: a launch, a lot, or the
 * hand-set shore point. `null` for anything else — a pin this lake doesn't draw, a hazard's or a
 * photo's id — so a chip naming nothing on the map never dims the map for nothing.
 */
export function pointedPinId(
  marks: readonly InstrumentMark[],
  id: string | null | undefined,
): string | null {
  if (id === null || id === undefined) return null;
  return marks.some(
    (m) => m.id === id && (m.kind === 'putIn' || m.kind === 'parking' || m.kind === 'point'),
  )
    ? id
    : null;
}

/** What the instrument's key lists: the kinds its marks and its track are drawing. */
export function instrumentKeyKinds(input: InstrumentInput): MapKeyKind[] {
  const kinds = new Set<MapKeyKind>();
  for (const mark of instrumentMarks(input)) {
    if (mark.kind === 'hazard') kinds.add(HAZARD_KEY_KIND[mark.tone]);
    else if (mark.kind === 'parking') kinds.add('lot');
    else kinds.add(mark.kind === 'photo' ? 'photo' : 'putIn');
  }
  if ((input.track?.length ?? 0) >= 2) kinds.add('yourTrack');
  return [...kinds];
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
