import { type HazardShape, hazardFootprint, isBrowsableSeason, type Season } from '@skating/core';

import type { BodyMapScene, MapOutline } from '../../map/mapDescriptors';

/**
 * What the Hazards tab asks the frame's map to draw (board 5.4.7): every hazard's footprint and
 * every known feature's, on the Hazards and Features layers — and Hazards opens with both on.
 * **No clocks on the map** (Review 13): a hazard is its dot field there, dimmed by freshness and
 * never removed; a known feature draws exactly as a hazard does, at full strength, with no key.
 *
 * **The winter on screen is in the lit address**, so the map draws the winter the list shows and a
 * reload keeps it: `winter:<year>` while a past winter is chosen and nothing in it is lit, and a
 * hazard in a past winter as `hazard:<year>.<id>`. The current winter needs neither — the tab opens
 * on it, empty or not, and a past one is shown only by choosing it.
 */

/** A footprint the map can draw: the stored clip when there is one, else the shape grown. */
type Shaped = Pick<HazardShape, 'geometryKind' | 'radiusMeters' | 'bufferMeters'> & {
  _id: string;
  geometry: unknown;
  clippedFootprint?: unknown;
};

export type HazardsMapData = {
  /** The winter these hazards are from, and the winter it is now. */
  season: Season;
  current: Season;
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

/**
 * The address a hazard answers to on `?lit=`: bare in the current winter, carrying its winter in a
 * past one, so lighting it never moves the list or the map back to now.
 */
export const hazardLit = (id: string, season?: Season, current?: Season) =>
  season === undefined || season === current ? `hazard:${id}` : `hazard:${season}.${id}`;
/**
 * A known feature's address: like a hazard's, it carries the winter on screen when that is a past
 * one, so lighting a feature while a past winter is shown keeps that winter (a feature has no
 * winter of its own, but the list and the map beside it do).
 */
export const featureLit = (id: string, season?: Season, current?: Season) =>
  season === undefined || season === current ? `feature:${id}` : `feature:${season}.${id}`;

/** A chosen winter with nothing in it lit: `null` for the current one, which needs no address. */
export const winterLit = (season: Season, current: Season): string | null =>
  season === current ? null : `winter:${season}`;

/**
 * The winter a lit address is in: a chosen past winter, a past winter's hazard or feature, or now.
 * A year the server wouldn't browse (it reads such a season as this one) is now, too, so a crafted
 * address never labels this winter's hazards as another's.
 */
export function seasonOfLit(lit: string | null | undefined, current: Season): Season {
  const m = /^(?:winter:(\d{4})$|(?:hazard|feature):(\d{4})\.)/.exec(lit ?? '');
  const year = Number(m?.[1] ?? m?.[2]);
  return isBrowsableSeason(year) && year <= current ? year : current;
}

export function hazardsMapScene(data: HazardsMapData, lit: string | null): BodyMapScene {
  const items: MapOutline[] = [];
  for (const f of data.features) {
    const geometry = footprintOf(f);
    if (geometry === null) continue;
    items.push({
      kind: 'outline',
      id: featureLit(f._id, data.season, data.current),
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
      id: hazardLit(h._id, data.season, data.current),
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
