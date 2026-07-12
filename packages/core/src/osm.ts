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

import { WATER_BODY_TYPES, type WaterBodyType } from './types'

/** A raw OSM feature's tag bag (`key=value`), e.g. `{ natural: 'water', water: 'lake' }`. */
export type OsmTags = Record<string, string | undefined>

/**
 * `water=*` subtags that are **flowing / linear** — deferred (rivers) or drainage we skip.
 * Present on either the `water` subtag or as a `waterway` value; both route to `null`.
 */
const FLOWING_WATER = new Set([
  'river',
  'stream',
  'canal',
  'ditch',
  'drain',
  'tidal_channel',
  'lock',
  'moat',
])

/** Direct `water=*` subtag → our enum, for the still-water types we recognize by name. */
const WATER_SUBTYPE: Partial<Record<string, WaterBodyType>> = {
  lake: 'lake',
  pond: 'pond',
  reservoir: 'reservoir',
}

/**
 * Map an OSM feature's tags to our `WaterBodyType`, or `null` to **skip** the feature.
 *
 * Returns `null` for anything that isn't still water we import this phase — non-water
 * features, flowing/linear water (rivers/streams/canals — deferred), and non-marsh wetlands
 * (swamp/bog/fen). Returns `'other'` only once a feature is established as a water *area* of
 * an unrecognized kind (e.g. `natural=water` with a missing/odd `water` subtag), so the ETL
 * still imports the body rather than losing it — `other` is the safety net, not a skip.
 */
export function waterBodyTypeFromOsmTags(tags: OsmTags): WaterBodyType | null {
  const { natural, water, waterway, landuse, wetland } = tags

  // Flowing/linear water is deferred (rivers) or drainage we don't want — always skip.
  if (waterway !== undefined) return null

  // A water *area*: `natural=water` (standard) or a bare `water=*` subtag.
  if (natural === 'water' || water !== undefined) {
    if (water !== undefined) {
      if (FLOWING_WATER.has(water)) return null // river/stream/canal/… — deferred
      const mapped = WATER_SUBTYPE[water]
      if (mapped !== undefined) return mapped
    }
    // Water area of unknown/unspecified kind (lagoon, oxbow, basin, no subtag, …).
    return 'other'
  }

  if (natural === 'bay') return 'bay'
  if (landuse === 'reservoir') return 'reservoir'

  // Wetlands: only marshes are in-scope; swamp/bog/fen/etc. are skipped.
  if (wetland === 'marsh') return 'marsh'

  return null
}

/** Type guard: is `value` one of our water-body types? (defensive validation in the ETL). */
export function isWaterBodyType(value: string): value is WaterBodyType {
  return (WATER_BODY_TYPES as readonly string[]).includes(value)
}
