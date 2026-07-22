/**
 * OSM tag → domain vocabulary mapping for the Phase 1 water-body ETL (D5/D14).
 *
 * Pure and framework-free so it's property-testable in `@skating/core` and reusable
 * from the ETL transform (and any future server-side OSM ingestion). Colocated with the
 * `WATER_BODY_TYPES` enum it targets so the mapping and its output stay single-sourced.
 *
 * **Rivers are deferred this phase** (modeling reaches is a later release — see the phase-1
 * build plan): any flowing/linear water (`waterway=*`, `water=river|stream|canal|…`) maps
 * to `null` so the ETL drops it. We import still water — lakes / ponds / reservoirs — only.
 */

import { WATER_BODY_TYPES, type WaterBodyType } from './types';

/** A raw OSM feature's tag bag (`key=value`), e.g. `{ natural: 'water', water: 'lake' }`. */
export type OsmTags = Record<string, string | undefined>;

/** `water=*` subtags that are **flowing / linear** — deferred (rivers) or drainage we skip. */
const FLOWING_WATER = new Set([
  'river',
  'stream',
  'canal',
  'ditch',
  'drain',
  'tidal_channel',
  'lock',
  'moat',
]);

/** Direct `water=*` subtag → our enum, for the still-water types we recognize by name. */
const WATER_SUBTYPE: Partial<Record<string, WaterBodyType>> = {
  lake: 'lake',
  pond: 'pond',
  reservoir: 'reservoir',
};

/**
 * Map an OSM feature's tags to our `WaterBodyType`, or `null` to **skip** the feature.
 *
 * A **positive still-water classification wins over the flowing-water defer** heuristic: an
 * explicit `water=reservoir` / `landuse=reservoir` / `natural=bay` / `wetland=marsh` isn't
 * dropped just because the feature also carries a through-`waterway` tag (legacy/relation
 * tagging leaves `waterway=river` on some reservoir areas). Only *bare* flowing water — a
 * `waterway` (or `water=river|stream|canal|…`) with no still-water signal — is deferred.
 *
 * Returns `null` for anything that isn't still water we import this phase (non-water,
 * flowing/linear water — rivers deferred, and non-marsh wetlands like swamp/bog/fen). Returns
 * `'other'` once a feature is established as a water *area* of an unrecognized kind (e.g.
 * `natural=water` with a missing/odd `water` subtag), so the ETL imports it rather than losing
 * it — `other` is the safety net, not a skip.
 */
export function waterBodyTypeFromOsmTags(tags: OsmTags): WaterBodyType | null {
  const { natural, water, waterway, landuse, wetland } = tags;

  // An explicit `water=*` subtag is the strongest signal and is checked first.
  if (water !== undefined) {
    if (FLOWING_WATER.has(water)) return null; // water=river|stream|canal|… — deferred
    const mapped = WATER_SUBTYPE[water];
    if (mapped !== undefined) return mapped; // water=lake|pond|reservoir
    return 'other'; // a water area of an unrecognized kind (lagoon, oxbow, basin, …)
  }

  // Other positive still-water classifications — these beat the `waterway` defer below.
  if (natural === 'bay') return 'bay';
  if (landuse === 'reservoir') return 'reservoir';
  if (wetland === 'marsh') return 'marsh'; // only marshes; swamp/bog/fen are skipped

  // Bare flowing/linear water (a `waterway` with no still-water signal above) — deferred.
  if (waterway !== undefined) return null;

  // A `natural=water` area with no recognized `water=*` subtag — unknown kind, still imported.
  if (natural === 'water') return 'other';

  return null;
}

/** Type guard: is `value` one of our water-body types? (defensive validation in the ETL). */
export function isWaterBodyType(value: string): value is WaterBodyType {
  return (WATER_BODY_TYPES as readonly string[]).includes(value);
}
