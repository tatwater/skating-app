import { type HazardShape, hazardFootprint } from '@skating/core';

import type { BodyMapScene, MapHazardField } from './mapDescriptors';

/**
 * What the Hazards tab asks the frame's map to draw (board 5.4.7): every hazard's footprint and
 * every known feature's, on the Hazards and Features layers — and Hazards opens with both on.
 * **No clocks on the map** (Review 13): a hazard is its dot field there, dimmed by freshness and
 * never removed; a known feature draws exactly as a hazard does, at full strength, with no key.
 * The dot field is a contract request (`MapHazardField`); until the frame adopts it, each draws as
 * a plain footprint plate.
 */

/** A footprint the map can draw: the stored clip when there is one, else the shape grown. */
type Shaped = Pick<HazardShape, 'geometryKind' | 'radiusMeters' | 'bufferMeters'> & {
  _id: string;
  geometry: unknown;
  clippedFootprint?: unknown;
};

export type HazardsMapData = {
  hazards: readonly (Shaped & {
    freshness: 'fresh' | 'aging' | 'stale';
    provisional: boolean;
    healingState?: string | undefined;
  })[];
  features: readonly Shaped[];
};

type Area = GeoJSON.Polygon | GeoJSON.MultiPolygon;

function footprintOf(s: Shaped): Area | null {
  const clipped = s.clippedFootprint as Area | undefined;
  if (clipped?.type === 'Polygon' || clipped?.type === 'MultiPolygon') return clipped;
  try {
    return hazardFootprint({
      geometryKind: s.geometryKind,
      geometry: s.geometry as HazardShape['geometry'],
      ...(s.radiusMeters !== undefined ? { radiusMeters: s.radiusMeters } : {}),
      ...(s.bufferMeters !== undefined ? { bufferMeters: s.bufferMeters } : {}),
    });
  } catch {
    // A row whose geometry can't be grown is drawn nowhere rather than somewhere wrong; its list
    // row still stands, so it is never silently gone.
    return null;
  }
}

/** The address a hazard or a feature answers to on `?lit=`. */
export const hazardLit = (id: string) => `hazard:${id}`;
export const featureLit = (id: string) => `feature:${id}`;

export function hazardsMapScene(data: HazardsMapData, lit: string | null): BodyMapScene {
  const items: MapHazardField[] = [];
  for (const f of data.features) {
    const geometry = footprintOf(f);
    if (geometry === null) continue;
    items.push({
      kind: 'outline',
      id: featureLit(f._id),
      layer: 'features',
      style: 'footprint',
      geometry,
      field: { freshness: 'known', tone: 'hazard', provisional: false },
    });
  }
  for (const h of data.hazards) {
    const geometry = footprintOf(h);
    if (geometry === null) continue;
    items.push({
      kind: 'outline',
      id: hazardLit(h._id),
      layer: 'hazards',
      style: 'footprint',
      geometry,
      field: {
        freshness: h.freshness,
        tone: h.healingState === 'healing_unsafe' ? 'healing' : 'hazard',
        provisional: h.provisional,
      },
    });
  }
  const mine = lit !== null && items.some((i) => i.id === lit);
  return { items, lit: mine ? lit : null, layers: { hazards: true, features: true } };
}
