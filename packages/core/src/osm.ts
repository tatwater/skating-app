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

// ── The corpus-admission floor (D91) ─────────────────────────────────────────────────────────────
//
// Lives here, in core, rather than in the ETL transform that applies it, because **two** things
// enforce it and they must never drift: the transform (which decides what a future import writes)
// and `waterBodies.pruneBelowAreaFloor` (which decides what an existing corpus keeps). A copy in
// each would mean a prune that deletes rows the next import puts straight back, or leaves rows no
// import would ever produce — and both failures are invisible until someone counts.

/** Square metres in an acre — the unit the floor below is *decided* in, exactly. */
const SQ_M_PER_ACRE = 4046.8564224;

/**
 * The surface-area floor for a **canonical (OSM) import**, in acres (D91, founder call 2026-08-02).
 *
 * Five acres, because that is where the corpus stops being lakes. Measured over the 2026-08-02
 * five-state transform (123,940 bodies): **64% of every feature we import is under one acre**, with
 * a median long axis of 50 m — a backyard pond, a farm dugout, a widening in a brook. 84% is under
 * five. Those 104,000 rows are indexed, tiled, searched and cell-mapped, and not one of them is a
 * place anybody drives to.
 *
 * **Five and not twenty-five or fifty**, which were the other candidates. The three floors all
 * delete ~95% of the corpus — 25 ac keeps 6,966 bodies, 50 ac keeps 4,207, a difference of 2% of the
 * corpus — so the size argument cannot distinguish them, while the cost differs by thousands of real
 * lakes. Checked against the Google-Group gazetteer (`training_data/google_group`, the only demand
 * signal we have): a 50-acre floor would have deleted **Keiser Pond** (36 ac, on our own VT curation
 * seed), Boston Lot Lake, Drew Lake, Ewell Pond and Oliverian Pond, all of them discussed skating
 * destinations, and 41% of the lakes a *state agency* thought worth a bathymetric survey (N6b).
 * Nothing anyone has been recorded skating is under five acres.
 *
 * **Area is the wrong axis and five acres is low enough that it doesn't matter yet.** The test being
 * applied — "you can't skate a full circle" — is about length, and 993 named bodies under 30 acres
 * have a long axis over 600 m (Keiser Pond is 36 ac and 909 m). If this number is ever raised, it
 * needs a `longAxisM` clause beside it.
 *
 * **Three acres was weighed and rejected** (2026-08-02). Dropping this to three would
 * admit 4,988 more bodies (+23% on the kept set) whose median shape is 235 × 117 m; 81% of them are
 * `other`/`marsh` — the buckets for water we couldn't classify — and only 5 carry a state
 * bathymetric survey, an eighth the rate of the unnamed bodies already above five acres. If the
 * worry is losing a skateable-but-unnamed pond, the lever is an axis clause (unnamed ≥ 3 ac with a
 * long axis ≥ 300 m admits 1,174 of those 4,988 and leaves the round pockets out), not a lower area.
 *
 * @see meetsAreaFloor — the rule, which is not this number alone.
 */
export const MIN_SURFACE_AREA_ACRES = 5;

/** `MIN_SURFACE_AREA_ACRES` in the unit geometry is measured in (`surfaceAreaSqM`). */
export const MIN_SURFACE_AREA_SQM = MIN_SURFACE_AREA_ACRES * SQ_M_PER_ACRE;

/**
 * The **hard** floor: an acre, below which a name saves nothing (D91, 2026-08-02).
 *
 * Between this and `MIN_SURFACE_AREA_ACRES` a body needs a name to get in (see `meetsAreaFloor`).
 * Below it, nothing does, because down here a name stops meaning anything. An acre is 64 m across if
 * it's round; the largest named bodies this cuts are Quarry Pond (105 m long), Spring Pond (139 m)
 * and Bog Pond (102 m). Of the 1,586 named sub-acre bodies exactly **one** has a state bathymetric
 * survey and **one** has a long axis over 300 m.
 *
 * Naming is at its least informative here too: 98% of sub-acre bodies are unnamed, so a name clause
 * without this floor rescues a scattered 2% on a signal the band barely carries. Above an acre the
 * gradient turns real — 5.6% named at 1–2 ac, 10.4% at 2–3, 16.1% at 3–4, 19.7% at 4–5, and 52.1%
 * above five.
 *
 * **Checked against the demand data and it costs nothing:** of the 64 discussed water bodies in the
 * Google-Group gazetteer that match the corpus at all, this drops every match of exactly one —
 * "Button Bay", whose only match is an unrelated 0.62-acre bay in *Maine*. The real Button Bay is on
 * Lake Champlain and is not a body in the corpus under any rule (OSM models it as part of the lake;
 * it belongs to the N2 sub-area layer, like Malletts Bay and Dillenbeck Bay). Removing it fixes a
 * search that currently returns the wrong lake.
 */
export const HARD_MIN_SURFACE_AREA_ACRES = 1;

/** `HARD_MIN_SURFACE_AREA_ACRES` in square metres. */
export const HARD_MIN_SURFACE_AREA_SQM = HARD_MIN_SURFACE_AREA_ACRES * SQ_M_PER_ACRE;

/**
 * Does this candidate clear the corpus floor?
 *
 * Two rules, and **nothing under an acre is ever a place**:
 *  - at least `MIN_SURFACE_AREA_ACRES` (5) ⇒ in, on size alone;
 *  - **named** and at least `HARD_MIN_SURFACE_AREA_ACRES` (1) ⇒ in;
 *  - otherwise out.
 *
 * Keeps 21,660 of 123,940 (17.5%) on the 2026-08-02 five-state extract.
 *
 * **The name tier is a hedge and its evidence is thin — recorded as such deliberately.** It rescues
 * 2,398 named bodies between one and five acres, and **not one of them is a place anybody is known
 * to skate**: no water body discussed in the Google-Group corpus is under five acres at all.
 * Everything the floor was *argued* for — Keiser Pond, Boston Lot Lake, Lake Solitude, Profile
 * Lake — clears five acres on size alone. It stays because search is name-driven (a named pond
 * returning nothing reads as a broken app, not a curated one) and because at ~2% of the corpus it is
 * a cheap way to be wrong in the recoverable direction. **The founder's stated fallback if it is
 * wrong is user feedback plus a re-import, which is why the tier is set where relaxing it is cheap.**
 *
 * **There is deliberately no bathymetry clause, and that costs 5 known bodies.** An "or a state
 * agency surveyed it" tier was built and then removed (founder call, 2026-08-03), because agency
 * coverage is *downstream of this function*: `waterBodies.matchBathymetryLakes` resolves a surveyed
 * lake by looking for a **listed body in our corpus** at its deepest sounding, so a lake this floor
 * excludes can never be matched, contoured, or counted as covered. The clause could therefore only
 * ever protect lakes a *previous, more permissive* corpus had already discovered — for any newly
 * imported region it is a no-op by construction — and keeping it would have meant a permanent,
 * unenforceable ordering rule (import unfiltered → join → build → coverage → prune) guarding five
 * bodies: three in Maine, two in New Hampshire, all unnamed, 3.6–4.6 acres. They are knowingly
 * dropped. See D91.
 *
 * **Canonical bodies only.** A body a skater creates from a recorded track (Phase 8,
 * `waterBodies.create`) never passes through the transform, and the prune skips `source: 'user'`
 * for the same reason: someone skated it, which outranks any threshold.
 */
export function meetsAreaFloor(candidate: { name: string; surfaceAreaSqM: number }): boolean {
  if (candidate.surfaceAreaSqM >= MIN_SURFACE_AREA_SQM) return true;
  if (candidate.surfaceAreaSqM < HARD_MIN_SURFACE_AREA_SQM) return false;
  return candidate.name.length > 0;
}
