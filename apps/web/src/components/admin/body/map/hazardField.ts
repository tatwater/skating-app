import { PROVISIONAL_OPACITY_SCALE, pointInPolygon, polygonBBox } from '@skating/core';

import type { LngLat, MapHazardField } from './mapDescriptors';

/**
 * A hazard footprint's **dot field** (board 5.4.7): dots across the footprint in the hazard's tone,
 * dimmed by how fresh it is — pure, so the safety rule is tested without a map.
 *
 * **Decay is confidence, not safety (D3).** A stale hazard fades and is **never removed**: every
 * footprint draws at least one dot, and no freshness, however old, takes the field below a floor
 * you can still see. The fade says "nobody has checked recently", never "this is probably gone".
 * A known body feature has no clock and draws at full strength.
 */

/** The field's strength by freshness (the board's `FADE`): fresh, a step back, two steps back. */
export const FIELD_FRESHNESS_OPACITY: Record<MapHazardField['freshness'], number> = {
  known: 1,
  fresh: 1,
  aging: 0.67,
  stale: 0.4,
};

/** The weakest a field ever draws: a stale hazard nobody has confirmed. */
export const FIELD_OPACITY_FLOOR = FIELD_FRESHNESS_OPACITY.stale * PROVISIONAL_OPACITY_SCALE;

/** How strongly a field draws: its freshness, a step further while nobody has confirmed it. */
export function fieldOpacity(field: MapHazardField): number {
  const base = FIELD_FRESHNESS_OPACITY[field.freshness];
  // A known feature is the body's own, not one person's report: no provisional step.
  const provisional = field.provisional && field.freshness !== 'known';
  return base * (provisional ? PROVISIONAL_OPACITY_SCALE : 1);
}

/** How many dots a field runs to along its longer side. */
const DOTS_ACROSS = 14;
/** The finest a field's grid goes, in meters (the board's 5 m cell). */
const MIN_STEP_M = 5;
/** The most dots one footprint draws, however its shape falls on the grid. */
const MAX_DOTS = 400;

const M_PER_DEG_LAT = 111_320;

/**
 * The dots across one footprint: a grid fixed to the ground, about {@link DOTS_ACROSS} along the
 * footprint's longer side and never finer than {@link MIN_STEP_M}, kept where it falls inside.
 * Never empty: a footprint too thin for the grid draws one dot at its middle (or its first vertex).
 */
export function fieldDots(geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): LngLat[] {
  const box = polygonBBox(geometry);
  const midLat = (box.minLat + box.maxLat) / 2;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);
  const wide = (box.maxLng - box.minLng) * mPerDegLng;
  const tall = (box.maxLat - box.minLat) * M_PER_DEG_LAT;
  const step = Math.max(MIN_STEP_M, Math.max(wide, tall) / DOTS_ACROSS);
  const dLng = step / mPerDegLng;
  const dLat = step / M_PER_DEG_LAT;
  const dots: LngLat[] = [];
  // Cells are centered, so a field sits evenly inside its footprint.
  for (let lat = box.minLat + dLat / 2; lat < box.maxLat && dots.length < MAX_DOTS; lat += dLat) {
    for (let lng = box.minLng + dLng / 2; lng < box.maxLng && dots.length < MAX_DOTS; lng += dLng) {
      if (pointInPolygon({ lat, lng }, geometry)) dots.push([lng, lat]);
    }
  }
  if (dots.length > 0) return dots;
  const mid = { lat: midLat, lng: (box.minLng + box.maxLng) / 2 };
  if (pointInPolygon(mid, geometry)) return [[mid.lng, mid.lat]];
  const ring = geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates[0]?.[0];
  const first = ring?.[0];
  return first ? [[first[0] ?? mid.lng, first[1] ?? mid.lat]] : [[mid.lng, mid.lat]];
}
