/**
 * Water-body functions.
 *
 * Canonical (OSM/NHD) bodies arrive via the internal `importCanonical` upsert (D14/D48) and
 * are auto-listed. User-created bodies are **auto-visible then reviewed-after** (D37):
 * `create` writes a `pending` body immediately (still listed), and a moderator later resolves
 * it via `approve`. Admins can `remove`/`restore` any body — a reversible soft-delist (D48).
 * Whether a body shows on the public map is the derived `listed` boolean (see `./lib/listing`) —
 * an unlisted body simply has no rows in the N1 cell index, so it can't be reached from the map at
 * all (see `./lib/cellIndex` and `plans/phase-N1-read-path-durability.md`).
 */

import {
  bboxIntersects,
  belongsInCorpus,
  bodiesCoveringPoint,
  CONFIDENCE_LEVELS,
  canOverwriteElevation,
  classifyDedup,
  containedFraction,
  DEPTH_SOURCE_RANK,
  DEPTH_SOURCES,
  type DedupClassification,
  type DedupShape,
  type DepthSource,
  displayScore,
  haversineMeters,
  type IdMatch,
  isKnownStateCode,
  isMinor,
  isPlausibleElevationM,
  isPlausibleWindRose,
  isWetlandClass,
  KNOWN_STATE_CODES,
  type LatLng,
  LEGACY_TYPE_TO_CLASS,
  type LegacyWaterBodyType,
  MAX_PLAUSIBLE_DEPTH_M,
  MAX_SUGGESTED_SAMPLE_POINTS,
  MIN_FETCH_CLAUSE_M,
  MIN_VISIBLE_ZOOM_FLOOR,
  matchDepthSource,
  minVisibleZoom,
  nearestBodyForPoint,
  type ProfileRichness,
  pathToBody,
  pointInPolygon,
  polygonBBox,
  polygonIoU,
  REVIEW_REASONS,
  resolveUpsert,
  WATER_BODY_CLASSES,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { LineString, MultiPolygon, Polygon } from 'geojson';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import {
  getCurrentProfile,
  requireContributor,
  requireContributorRole,
  requireProfile,
  requireRole,
} from './lib/auth';
import { syncWaterBodyCells, WATER_BODY_LADDER } from './lib/cellIndex';
import { rankCandidates, scanCells } from './lib/cellScan';
import {
  CANONICAL_SOURCES,
  GEOMETRY_SOURCES,
  REMOVAL_REASONS,
  WATER_BODY_SOURCES,
} from './lib/enums';
import { isListed } from './lib/listing';
import { takeCapped, takeCappedResult } from './lib/scan';
import { bbox, geoJson, latLng, literals } from './lib/validators';
import {
  reclipSubAreasToParent,
  repointSubAreasOnMerge,
  scheduleRestamp,
  syncCellsForParent,
} from './subAreas';

/**
 * Viewport read budget (N1). These are **product** numbers now, not safety numbers.
 *
 * The old two-tier scheme (a centroid prefilter over the viewport plus a small margin, plus a scan
 * of every `isLarge` body) had a genuine no-gap invariant, but its cost was governed by constants
 * measured live against the 9,967-body Vermont corpus — and Phase 2.5 then grew that corpus to
 * ~116k without anyone re-measuring. The ladder-grid index removes the coupling entirely: reads
 * scale with what's *on screen*, not with how big the query rectangle or the corpus is.
 *
 * Worst case, this query reads `CELL_ROW_SCAN_BUDGET` cell rows + one hydrating `ctx.db.get` per
 * *distinct candidate* (also ≤ `CELL_ROW_SCAN_BUDGET`, since a candidate comes from a row) + a
 * viewer's favorites — ~3,000 against Convex's 4,096 cap, with the geometry (§theorems 1–2) keeping
 * real viewports orders of magnitude below that.
 */
/** How many bodies to hand the map. Purely a render budget: at dense z13–14 viewports across the
 *  Phase-2.5 corpus the old 256 was visibly short, and MapLibre is comfortable with ~1k small
 *  polygons. Truncation keeps the *most prominent* bodies and is logged, never silent (D5). */
const DEFAULT_VIEWPORT_LIMIT = 1000;
/** Hard ceiling on the client-supplied limit — the read-budget arithmetic above depends on it. */
const MAX_VIEWPORT_LIMIT = DEFAULT_VIEWPORT_LIMIT;
/**
 * Cells one rung may contribute — an *absurdity* guard, not a tight bound. A square viewport at its
 * own zoom covers ≤ 4 cells at any rung (property-tested), but a real map is many tiles wide: a
 * 3840px-wide window spans ~15 tiles, so its finest rung covers ~150 cells. Those are empty-or-tiny
 * index lookups and cost almost nothing. What this catches is the incoherent case — a 1°-wide
 * viewport claiming zoom 14, which would want ~2,000 cells — where we skip the rung and say so.
 */
const MAX_CELLS_PER_LEVEL = 256;
/**
 * Total cells one read may look up across all rungs. Spent a **whole rung at a time** — see the
 * plan walk in `bodiesCoveringBox` for why a partial rung is the one truncation with no honest
 * story to tell.
 */
const CELL_SCAN_BUDGET = 512;
/** Pending user-created bodies shown in the moderator review queue at once. */
const REVIEW_QUEUE_CAP = 500;
/** Total cell rows one read may scan. Rows are also what bounds hydration (one `db.get` per distinct
 *  candidate row at most), so the worst case is 512 lookups + 1,500 rows + ≤1,500 hydrating gets ≈
 *  3,000 document reads against Convex's 4,096 cap. */
const CELL_ROW_SCAN_BUDGET = 1500;
/**
 * Rows held in reserve for each not-yet-scanned cell, so a dense early cell can't spend the row
 * budget before the walk reaches the rest of the viewport (Greptile PR #27). It is a *floor*, not a
 * ration: a cell still takes everything it wants whenever the budget is ample, which is every real
 * viewport measured. Four because that's what theorem 2 bounds a body's own-rung footprint to — a
 * cell that yields four rows has said something about what's there, and a whole neighbourhood of the
 * map going blank is a worse failure than a slightly shallower read of one dense cell.
 */
const MIN_ROWS_PER_CELL = 4;

/**
 * `listInViewport.limit` is public, client-supplied input, so guard it (D5/D37 — validate at the
 * trust boundary): a `0`/negative/non-integer value would silently return nothing, and a value past
 * `MAX_VIEWPORT_LIMIT` would break the read-budget arithmetic above. Fall back to the default for
 * anything that isn't a positive integer, and clamp to the ceiling.
 */
function sanitizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) return DEFAULT_VIEWPORT_LIMIT;
  return Math.min(limit, MAX_VIEWPORT_LIMIT);
}

/**
 * A body's `states`, from whichever producer actually knows.
 *
 * ## Two producers, and only one of them used to be heard
 *
 * The **OSM lane** imports one state extract at a time, so it knows only "this batch came from
 * Vermont" — and a border-spanning body accumulates its states by being imported once per extract,
 * which is what `--state` and the union are for. The **merge** loads a single pass with no per-state
 * batches, computes `statesFor` per body against the state-level admin areas, and knows the whole
 * answer at once.
 *
 * The handler only ever read the first of those. Adding `states` to the validator without this would
 * have accepted the field and then written nothing from it: 27,074 rows with no state at all, and
 * every regional filter in the app — the feed, drive-time, the state chips — silently empty.
 *
 * So: **an explicit list from the producer is authoritative and replaces**; a `--state` tag is a
 * partial observation and unions. The rule is the same one `assertedCatalogueIds` follows for the
 * catalogue ids, and for the same reason — the difference between a complete record and a partial one
 * has to be expressed by the caller, because nothing in here can tell them apart.
 */
function resolveStates(
  existing: string[] | undefined,
  incoming: string[] | undefined,
  state: string | undefined,
): string[] | undefined {
  if (incoming?.length) return [...new Set(incoming)].sort();
  if (!state) return existing;
  return [...new Set([...(existing ?? []), state])].sort();
}

/**
 * A canonical body as prepared by the ETL — **keyed by its catalogue ids, not by `(source,
 * externalId)`** (N7 / D93).
 *
 * The ids are what changed. `externalId` is still carried and still written, because the contour
 * tiles are stamped with it and D93 keeps it in step for one full campaign before retiring it — but
 * it is no longer how a row is found. A merged record can hold three catalogue ids at once, and the
 * pair `(source, externalId)` can only express one of them, which is why an NHD feature used to
 * insert a duplicate of every OSM body we already held.
 *
 * **At least one catalogue id must be present.** `resolveUpsert` refuses a feature carrying none —
 * it cannot be upserted, only counted as a drop — and the mutation surfaces that as a conflict
 * rather than inventing an identity for it.
 */
const canonicalBody = v.object({
  source: literals(CANONICAL_SOURCES), // osm | nhd | 3dhp — never user (D14)
  externalId: v.string(),
  /**
   * The catalogue ids this record carries. **All optional, at least one required** — enforced by
   * `resolveUpsert` rather than by the validator, because "which of these three" is a rule with a
   * reason attached and a validator can only say `false`.
   */
  osmId: v.optional(v.string()),
  nhdId: v.optional(v.string()),
  threeDhpId: v.optional(v.string()),
  /** Proposes, never decides — see the schema note and `GNIS_IS_NOT_AN_UPSERT_KEY`. */
  gnisId: v.optional(v.string()),
  /** Whose outline this is (D92). Absent means "the same as `source`". */
  geometrySource: v.optional(literals(GEOMETRY_SOURCES)),
  name: v.string(),
  type: literals(WATER_BODY_CLASSES),
  /**
   * The states this body touches — **computed by the producer, not by the loader's `--state` flag.**
   *
   * The OSM lane got this for free by importing one state extract at a time and letting the loader
   * tag each batch. A merged corpus is loaded in a *single pass*, so there are no per-state batches
   * and `statesFor` computes it per body against the state-level admin areas — giving a
   * border-spanning body every state it touches rather than the first.
   *
   * **This field was missing from this validator while the ETL emitted it**, which is a wire break
   * rather than an omission: Convex object validators are exact, so every batch of a merged load
   * would have been rejected outright. And adding the field alone was not enough — the handler
   * ignored it and wrote `unionState(existing.states, state)` from a CLI flag a single-pass load does
   * not have, which would have produced 27,000 rows with no state at all and silently broken every
   * regional filter in the app.
   */
  states: v.optional(v.array(v.string())),
  polygon: geoJson,
  bbox,
  centroid: latLng, // the on-water representative point (D48)
  surfaceAreaSqM: v.optional(v.number()),
  /** The area the admission decision was made on — see the schema note on `sourceAreaSqM`. */
  sourceAreaSqM: v.optional(v.number()),
  /** Share of the outline inside our five states, `[0, 1]` — see the schema note. */
  inRegionFraction: v.optional(v.number()),
  /** Per-attribute agreement between the catalogues (D110) — see the schema note. */
  confidence: v.optional(
    v.object({
      name: literals(CONFIDENCE_LEVELS),
      polygon: literals(CONFIDENCE_LEVELS),
      cls: literals(CONFIDENCE_LEVELS),
    }),
  ),
  /** Why this body wants a human (D110). Empty is normal and is omitted rather than stored. */
  reviewReasons: v.optional(v.array(literals(REVIEW_REASONS))),
  // A genuinely-interior point + the D85 shape stats, measured by the ETL on the source geometry
  // before it was simplified. All optional: a body whose geometry defeats one of them still loads.
  interiorPoint: v.optional(latLng),
  shorelineM: v.optional(v.number()),
  longAxisM: v.optional(v.number()),
  longAxisBearingDeg: v.optional(v.number()),
  shortAxisM: v.optional(v.number()),
  fetchProfileM: v.optional(v.array(v.number())),
});

/**
 * The N6c shape stats as a patch fragment, `undefined` for anything the ETL couldn't measure.
 *
 * **Spread explicitly into both the insert and the update**, rather than relying on `...item`:
 * `importCanonical` patches a named field list on purpose (that discipline is what lets depth,
 * `curatedBoost` and the review/removal state survive a re-import), so a new field that isn't named
 * here simply never lands — silently, and only visibly as a column of blanks weeks later.
 *
 * Written as explicit `undefined`s rather than omitted keys so a re-import *clears* a stat the new
 * geometry can no longer support. A stale shoreline beside a fresh outline is worse than none.
 */
function shapeFields(item: {
  interiorPoint?: LatLng;
  shorelineM?: number;
  longAxisM?: number;
  longAxisBearingDeg?: number;
  shortAxisM?: number;
  fetchProfileM?: number[];
}) {
  return {
    interiorPoint: item.interiorPoint,
    shorelineM: item.shorelineM,
    longAxisM: item.longAxisM,
    longAxisBearingDeg: item.longAxisBearingDeg,
    shortAxisM: item.shortAxisM,
    fetchProfileM: item.fetchProfileM,
  };
}

/**
 * What the **merge** knew and the loader used to discard (N7 audit).
 *
 * Written as explicit `undefined`s rather than omitted keys, for the same reason `shapeFields` is:
 * a re-import must be able to *clear* a value the new evidence no longer supports. A stale
 * `confidence: high` beside a body whose second catalogue just disappeared is worse than none, and a
 * stale `reviewReasons` would keep a moderator looking at a conflict that has since resolved.
 *
 * **The one asymmetry is `sourceAreaSqM`.** It is an area, and the D91 floor is decided on it, so
 * clearing it silently moves a body from "admitted at 1.0001 acres" to "unknown area" — which
 * `pruneBelowAreaFloor` treats as a keep. That is the safe direction, and it is the direction the
 * prune already takes for an unknown area, so the explicit `undefined` is correct here too.
 */
function mergeFields(item: {
  sourceAreaSqM?: number;
  inRegionFraction?: number;
  confidence?: { name: string; polygon: string; cls: string };
  reviewReasons?: string[];
}) {
  return {
    sourceAreaSqM: item.sourceAreaSqM,
    inRegionFraction: item.inRegionFraction,
    confidence: item.confidence as Doc<'waterBodies'>['confidence'],
    reviewReasons: item.reviewReasons as Doc<'waterBodies'>['reviewReasons'],
  };
}

/**
 * Derived display-prominence fields (D49/D2) from a body's area, admin boost and profile richness.
 * `minVisibleZoom` is stored on the row AND denormalized onto its cell rows (see `./lib/cellIndex`),
 * where it's the trailing field of `by_cell` — so a wide-zoom query returns the most-prominent
 * bodies first and never reads the rest at all.
 */
function scoreFields(input: {
  surfaceAreaSqM?: number;
  curatedBoost?: number;
  richness?: ProfileRichness;
}) {
  const score = displayScore(input);
  return { displayScore: score, minVisibleZoom: minVisibleZoom(score) };
}

/**
 * A body's D2 profile richness, read from what it actually has.
 *
 * **Costs two index reads per body**, which is why it is computed in `backfillCells` (paginated,
 * a few hundred bodies per transaction) and NOT in `importCanonical`, which already does the
 * heaviest work in the app and would pay this on all 116,070 rows mid-import.
 *
 * `hasContours` reads the `bathymetryCoverage` side table rather than a column, because contour
 * coverage is a property of the N6b TILESET rather than of the body — see that table's comment.
 */
async function richnessFor(ctx: QueryCtx, body: Doc<'waterBodies'>): Promise<ProfileRichness> {
  const putIns = await ctx.db
    .query('putIns')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', body._id))
    .take(25);
  const visiblePutIns = putIns.filter((p) => p.status === 'visible');

  const report = await ctx.db
    .query('reports')
    .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', body._id))
    .first();
  const hazard = report
    ? null
    : await ctx.db
        .query('hazards')
        .withIndex('by_water_body_first_reported', (q) => q.eq('waterBodyId', body._id))
        .first();

  const coverage = await ctx.db
    .query('bathymetryCoverage')
    .withIndex('by_external_id', (q) =>
      q.eq('source', body.source === 'nhd' ? 'nhd' : 'osm').eq('externalId', body.externalId ?? ''),
    )
    .first();

  return {
    // A blank name is the 92% case; a name is a weak but real signal that someone cared.
    hasName: body.name.trim().length > 0,
    hasContours: coverage !== null,
    hasDepth: body.meanDepthM !== undefined || body.maxDepthM !== undefined,
    hasDerivedPutIn: visiblePutIns.some((p) => p.source === 'derived'),
    hasOfficialPutIn: visiblePutIns.some((p) => p.source === 'official'),
    hasActivity: report !== null || hazard !== null,
  };
}

/**
 * A stored body's `minVisibleZoom` (D49), recomputed from area + boost. Used when a mutation
 * re-cells a body without changing its score inputs (`approve`/`remove`/`restore`), so the cell rows
 * stay correct even for a legacy row missing the field.
 */
function zoomSortKey(body: { surfaceAreaSqM?: number; curatedBoost?: number }): number {
  return scoreFields(body).minVisibleZoom;
}

/**
 * Did a canonical re-import actually move this body's outline? (N2)
 *
 * Cheap on purpose — four bbox floats, an area, and a vertex count, all of which the loader hands us
 * or the row already stores. It exists to keep `importCanonical` from paying for a polygon clip per
 * sub-area on every run regardless of whether anything changed; see the call site for why that cost
 * is the one worth guarding in this mutation.
 *
 * It errs toward "moved": any of the three differing runs the re-clip. Two different shorelines with
 * the same bbox, the same geodesic area **and** the same vertex count is not a thing an OSM extract
 * produces, and the cost of being wrong in that direction is a redundant clip rather than a stale
 * invariant.
 */
export function footprintMoved(
  existing: Pick<Doc<'waterBodies'>, 'bbox' | 'surfaceAreaSqM' | 'polygon'>,
  next: { bbox: Doc<'waterBodies'>['bbox']; surfaceAreaSqM?: number; polygon: unknown },
): boolean {
  const a = existing.bbox;
  const b = next.bbox;
  if (a.minLat !== b.minLat || a.minLng !== b.minLng) return true;
  if (a.maxLat !== b.maxLat || a.maxLng !== b.maxLng) return true;
  if (existing.surfaceAreaSqM !== next.surfaceAreaSqM) return true;
  return vertexCount(existing.polygon) !== vertexCount(next.polygon);
}

/** Total positions across every ring — a shape fingerprint that costs no geometry math. */
function vertexCount(geometry: unknown): number {
  const g = geometry as { type?: string; coordinates?: unknown[] };
  if (g?.type === 'Polygon') {
    return (g.coordinates as unknown[][]).reduce((n, ring) => n + ring.length, 0);
  }
  if (g?.type === 'MultiPolygon') {
    return (g.coordinates as unknown[][][]).reduce(
      (n, poly) => n + poly.reduce((m, ring) => m + ring.length, 0),
      0,
    );
  }
  return 0;
}

/**
 * Look up every stored row each of an incoming record's catalogue ids resolves to (N7 / D93).
 *
 * One index read per id present, each on the id's **own** index. `osmId` deliberately does not go
 * through `by_external_id`: the two fields hold the same string today and D93 exists to end that
 * coincidence, so keying identity on the arrival field would re-create the bug one layer down — and
 * it did, in the first draft of this function, which silently returned no match for a body whose
 * `externalId` and `osmId` had diverged and would have inserted a duplicate.
 *
 * Returns the shape `resolveUpsert` consumes: the caller does the reads, the pure function makes the
 * decision, and that split is what lets `merge` and `conflict` be tested exhaustively without a
 * database.
 *
 * **`.collect()` and not `.unique()`.** A `unique()` here would *throw* on the one case the whole
 * design exists to detect — an id resolving to two rows — and turn a finding we want queued into a
 * failed batch.
 */
async function lookupByCatalogueIds(
  ctx: MutationCtx,
  ids: { osmId?: string; nhdId?: string; threeDhpId?: string },
): Promise<IdMatch<Id<'waterBodies'>>[]> {
  const out: IdMatch<Id<'waterBodies'>>[] = [];
  if (ids.osmId) {
    const rows = await ctx.db
      .query('waterBodies')
      .withIndex('by_osm_id', (q) => q.eq('osmId', ids.osmId))
      .collect();
    out.push({ field: 'osmId', value: ids.osmId, keys: rows.map((r) => r._id) });
  }
  if (ids.nhdId) {
    const rows = await ctx.db
      .query('waterBodies')
      .withIndex('by_nhd_id', (q) => q.eq('nhdId', ids.nhdId))
      .collect();
    out.push({ field: 'nhdId', value: ids.nhdId, keys: rows.map((r) => r._id) });
  }
  if (ids.threeDhpId) {
    const rows = await ctx.db
      .query('waterBodies')
      .withIndex('by_three_dhp_id', (q) => q.eq('threeDhpId', ids.threeDhpId))
      .collect();
    out.push({ field: 'threeDhpId', value: ids.threeDhpId, keys: rows.map((r) => r._id) });
  }
  return out;
}

/**
 * Internal, never client-callable: idempotently upsert a batch of canonical bodies (D14/D48/D93).
 * Load via `pnpm exec convex run` from the ETL (chunk batches for the mutation size limit).
 *
 * ## Keyed on the catalogue ids, which is the change this phase exists to make
 *
 * It used to key on `(source, externalId)`. That worked while the corpus was one catalogue and fails
 * the moment it is three: **an NHD feature would insert a duplicate of every OSM body we hold**,
 * because the pair can only express one identity and the NHD row's is not the OSM row's.
 * `resolveUpsert` (`@skating/core`) takes what each id resolved to and returns one of four verdicts:
 *
 *  - **insert** — no id matched. Mint a `waterBodyKey` and add it, `listed: true`.
 *  - **patch** — exactly one stored row. Update in place; **`_id` never moves**, which is what keeps
 *    user content attached and makes "change a lake's geometry source" a field write.
 *  - **merge** — two ids, two *different* rows. Reconciliation missed a duplicate. **Queued, never
 *    performed**: an automatic merge that is wrong is unrecoverable in a way a queued one is not.
 *  - **conflict** — one id, two rows. The corpus already violates its own uniqueness. Refuse.
 *
 * **`merge` and `conflict` do not throw and do not write.** They mark the rows for the D36 dedup
 * queue and are counted in the return value, because a batch of 150 must not be lost to one lake
 * whose identity is ambiguous — and because the ambiguity is itself a finding a moderator can act on.
 *
 * ## What a re-import still preserves
 *
 * `removed*` / `reviewStatus` / `dedupStatus` / `curatedBoost` / depth survive, with `listed`
 * re-derived through `isListed`, so a re-import **never resurrects a removed body** — above all a
 * landowner takedown (D48). Re-running on unchanged data is a no-op on the final state.
 */
export const importCanonical = internalMutation({
  // `state` (2-letter code) is the extract's source region; it's unioned into each body's `states`
  // so a border-spanning body imported from multiple state extracts accumulates them all (D5/2.5).
  args: {
    bodies: v.array(canonicalBody),
    state: v.optional(v.string()),
    /**
     * The campaign this load belongs to. Stamped on every row it inserts or patches, so step 6's
     * prune can ask "did the master list re-affirm this body?" without re-deriving any rule.
     */
    campaignId: v.optional(v.string()),
  },
  handler: async (ctx, { bodies, state, campaignId }) => {
    // Defense-in-depth against the ETL's `--state` guard: reject an unknown region code before any
    // write so a bad tag can never be unioned into a body's `states` (Phase 2.5 review).
    if (state !== undefined && !isKnownStateCode(state)) {
      throw new ConvexError(
        `Unknown state code: ${state}. Expected one of: ${KNOWN_STATE_CODES.join(', ')}.`,
      );
    }
    let inserted = 0;
    let updated = 0;
    let queuedForMerge = 0;
    let conflicts = 0;
    const unresolved: { externalId: string; action: string; reason: string }[] = [];

    for (const item of bodies) {
      // Held rather than inlined: the `conflict` branch needs the same rows back, and re-reading
      // them would double the index reads in the heaviest mutation in the app.
      const matches = await lookupByCatalogueIds(ctx, item);
      const verdict = resolveUpsert(
        { osmId: item.osmId, nhdId: item.nhdId, threeDhpId: item.threeDhpId },
        matches,
      );

      if (verdict.action === 'conflict') {
        conflicts++;
        unresolved.push({
          externalId: item.externalId,
          action: 'conflict',
          reason: verdict.reason,
        });
        // **A conflict must not become a deletion** (N7 second audit). This used to write nothing at
        // all, which was right about the *body* and catastrophic in combination with step 6: the rows
        // an id resolved ambiguously to never got a `lastCampaignId`, so `pruneNotInCampaign` then
        // saw two clean, unattached, un-reaffirmed rows and **deleted both** — resolving a
        // corpus-uniqueness violation by destroying the evidence of it.
        //
        // So the rows are marked for the same D36 queue a `merge` verdict uses. That is what the
        // dedup status is for, and it is also what the prune's protection list already honours.
        for (const match of matches) {
          for (const key of match.keys) {
            const row = await ctx.db.get(key);
            if (row && row.dedupStatus !== 'merged') {
              await ctx.db.patch(key, { dedupStatus: 'near_certain' });
            }
          }
        }
        continue;
      }

      if (verdict.action === 'merge') {
        // **Flag, never collapse.** D36's queue exists for exactly this decision and merging is a
        // moderator action. Both sides are marked so whichever a human opens shows the other.
        queuedForMerge++;
        for (const key of [verdict.into, ...verdict.absorb]) {
          const row = await ctx.db.get(key);
          if (row && row.dedupStatus !== 'merged') {
            await ctx.db.patch(key, { dedupStatus: 'near_certain' });
          }
        }
        unresolved.push({
          externalId: item.externalId,
          action: 'merge',
          reason: `${verdict.matchedBy.join('+')} resolve to ${1 + verdict.absorb.length} rows`,
        });
        continue;
      }

      const existing = verdict.action === 'patch' ? await ctx.db.get(verdict.key) : null;

      if (existing) {
        // Patch geometry/name/area + re-derived scores; removed*/reviewStatus/dedupStatus/
        // curatedBoost are preserved. Score uses the new area + the *preserved* admin boost (D49).
        //
        // ⚠ **This resets the score to area + boost, dropping the D2 richness term**, because
        // reading put-ins and reports per body would put two extra index reads on every one of
        // 116,070 rows inside the heaviest mutation in the app. So the ordering is not optional:
        // canonical re-import → depth/elevation run → `backfillCells`, which recomputes richness
        // last. Re-scoring earlier would score against data that had not landed yet.
        const scores = scoreFields({
          surfaceAreaSqM: item.surfaceAreaSqM,
          curatedBoost: existing.curatedBoost,
        });
        await ctx.db.patch(existing._id, {
          name: item.name,
          type: item.type,
          // **`source` is deliberately NOT patched, and it is not the same question as
          // `geometrySource`** (second audit, 2026-08-06 — noted because this was "fixed" and then
          // un-fixed within the hour).
          //
          // The audit flagged that a body first imported from OSM and now drawn by NHD keeps
          // `source: 'osm'` for ever, which reads like staleness. It is not: **`source` and
          // `externalId` are one pair**, describing where this row *arrived* from, and `externalId`
          // cannot move — the contour tiles are stamped with it (D93). Patching `source` alone
          // separates the pair, and `richnessFor` reads exactly that pair to find a body's contour
          // coverage — so "correcting" it would look up `('nhd', 'way/123')`, match nothing, and
          // silently drop `hasContours` from the D2 prominence score of every body whose geometry
          // source changed.
          //
          // Whose outline we drew is `geometrySource`, which IS patched, three lines down. The two
          // disagreeing is the design working, not drift.
          polygon: item.polygon,
          bbox: item.bbox,
          centroid: item.centroid,
          representativePoint: item.centroid,
          surfaceAreaSqM: item.surfaceAreaSqM,
          states: resolveStates(existing.states, item.states, state),
          ...scores,
          ...shapeFields(item),
          ...mergeFields(item),
          // Stamped on every touch, so step 6 can find the rows this campaign never mentioned.
          // Left alone when the caller names no campaign: a partial load must not make the whole
          // corpus look re-affirmed by a run that only saw one state.
          ...(campaignId ? { lastCampaignId: campaignId } : {}),
          // **Every id the record asserts, and nothing it merely fails to mention.** The old rule
          // withheld `nhdId` entirely so a reconciliation survived a re-import; that was right when
          // an incoming record was one catalogue's view, and too strict now that the merge resolves
          // all three ids before emitting — it would freeze the corpus at whatever the first
          // reconciliation guessed. Overwriting unconditionally is the opposite error and a far
          // worse one; see `assertedCatalogueIds`.
          ...assertedCatalogueIds(item),
        });
        // Re-derive listing from the preserved fields (removed stays removed, D48) and re-cell the
        // body against its new geometry + prominence (N1).
        await syncWaterBodyCells(ctx, existing._id, {
          bbox: item.bbox,
          minVisibleZoom: scores.minVisibleZoom,
          listed: isListed(existing),
        });
        // A re-import can refine a shoreline under a hand-drawn bay, and Decision 10's "inside its
        // parent by construction" has to survive the parent changing shape — otherwise it decays into
        // "was true when it was drawn."
        //
        // **Gated on the outline having actually moved, because the clip is the expensive thing in
        // this mutation.** Champlain's polygon is 10,755 vertices and carries nine bays; a clip
        // against it is comfortable alone and blows a mutation's 1s budget at a dozen (measured in
        // the N2 curation session), and the ETL loads Champlain as a near-solo batch precisely
        // because it's already the heaviest row in the feed. Re-running the loader on unchanged data
        // is documented as a no-op, and an unconditional re-clip would have made it an increasingly
        // expensive one — worse with every bay drawn. The check is `footprintMoved`: identical bbox
        // and identical geodesic area means OSM handed us the same shoreline, and a containment
        // answer that was true a moment ago is still true.
        if (footprintMoved(existing, item)) {
          const resynced = await reclipSubAreasToParent(ctx, existing._id, {
            ...existing,
            polygon: item.polygon,
          });
          // Only when a bay actually moved: membership changed, so the stamps did. Gating on this
          // keeps an ETL batch from scheduling one job per body it touched.
          if (resynced.reclipped > 0 || resynced.delisted > 0) {
            await scheduleRestamp(ctx, existing._id);
          }
        }
        updated++;
      } else {
        const now = Date.now();
        const scores = scoreFields({ surfaceAreaSqM: item.surfaceAreaSqM }); // no boost on import
        const id = await ctx.db.insert('waterBodies', {
          name: item.name,
          type: item.type,
          source: item.source,
          externalId: item.externalId,
          // **Minted at insert, so no row is ever without one.** `mintWaterBodyKeys` exists to
          // backfill the rows that predate the field; a body created after it should not need that
          // pass to have run, or the corpus acquires a second class of row whose tile stamp is
          // pending. Same `wb_` prefix and opaque UUID (D93).
          waterBodyKey: `wb_${crypto.randomUUID()}`,
          // Identity alongside the key. Set here so a fresh import needs no backfill to be
          // reconcilable, and so the day `externalId` stops being an OSM id, this still is one.
          ...catalogueIds(item),
          polygon: item.polygon,
          bbox: item.bbox,
          centroid: item.centroid,
          representativePoint: item.centroid,
          surfaceAreaSqM: item.surfaceAreaSqM,
          states: resolveStates(undefined, item.states, state),
          ...scores,
          ...shapeFields(item),
          ...mergeFields(item),
          // Stamped on every touch, so step 6 can find the rows this campaign never mentioned.
          // Left alone when the caller names no campaign: a partial load must not make the whole
          // corpus look re-affirmed by a run that only saw one state.
          ...(campaignId ? { lastCampaignId: campaignId } : {}),
          dedupStatus: 'clean', // default (D36)
          createdAt: now,
        });
        await syncWaterBodyCells(ctx, id, {
          bbox: item.bbox,
          minVisibleZoom: scores.minVisibleZoom,
          listed: true,
        });
        inserted++;
      }
    }
    // `unresolved` is capped: a batch is 150 bodies and a pathological run could make every one of
    // them ambiguous, but the *counts* are what the loader reports and the samples are for a human
    // reading a run row. Twenty is enough to recognise a pattern and small enough to never dominate
    // the return value.
    return {
      inserted,
      updated,
      queuedForMerge,
      conflicts,
      unresolved: unresolved.slice(0, 20),
    };
  },
});

/**
 * Backfill `osmId` / `geometrySource` onto rows imported before those fields existed (N6b follow-up).
 *
 * Pure restatement — every value is derived from `source` and `externalId`, which the row already
 * carries — so this is idempotent, order-independent, and safe to re-run against a corpus that is
 * still changing underneath it. That last property is the point: it can run alongside the depth,
 * elevation and wind passes without any of them having to know about it.
 *
 * **It writes no `nhdId`.** Reconciliation is a geometric question (`polygonIoU` against NHD, never
 * point containment — see the schema note), and it belongs in its own pass with its own evidence.
 * This one only says what we already knew and had nowhere to put.
 *
 * Paginated for the same byte-budget reason as `pruneBelowAreaFloor`: a page is bounded by polygon
 * bytes long before document count, and one page containing Lake Champlain carries ~0.3 MiB in a
 * single row.
 */
/**
 * Count the corpus, one page at a time — **the campaign baseline** (N7).
 *
 * Every "how much did this add" claim in the N7 plan is measured against the post-prune corpus size,
 * and that number has been quoted as *"~21,000"* with a note that it is unconfirmed. There was no
 * cheap way to establish it: a one-off query cannot scan ~21,000 rows inside Convex's 16 MB read cap
 * (a body averages 1.8 KB and the large ones are far bigger), and no counting function existed.
 *
 * So this is paged and resumable, in the same shape as `backfillCatalogueIds` — hand back the cursor
 * and the running totals, call it until `isDone`. It is a **query**, so it writes nothing and can be
 * run against a live corpus mid-campaign without interfering.
 *
 * **It counts the fields the campaign actually reasons about**, not just rows: how many bodies carry
 * each catalogue id (so the reconciliation's progress is visible), how many are listed, and the
 * per-state split (so a regional claim can be checked).
 *
 * **Contour coverage is deliberately absent.** It lives in the `contourCoverage` side table rather
 * than on the body — a property of the tileset, not of the lake — so counting it here would mean a
 * second scan inside a function whose whole job is to walk `waterBodies` once. Ask that table.
 */
/** Square metres in an acre — local, so this query needs no extra import. */
const SQ_M_PER_ACRE_LOCAL = 4046.8564224;

export const corpusStats = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    running: v.optional(v.any()),
  },
  handler: async (ctx, { cursor, batchSize, running }) => {
    // 200 keeps a page well inside the byte cap even where the corpus is all Champlain-sized
    // polygons — the N6c depth loader blew 16 MB at a batch of 25 by not thinking about this.
    const numItems = Math.min(500, Math.max(1, batchSize ?? 200));
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });

    const prior = (running ?? {}) as {
      total?: number;
      listed?: number;
      withOsmId?: number;
      withNhdId?: number;
      withGeometrySource?: number;
      withDepth?: number;
      withElevation?: number;
      withWindRose?: number;
      byState?: Record<string, number>;
      byType?: Record<string, number>;
      unnamedWetlandBands?: Record<string, number>;
    };
    const byState: Record<string, number> = { ...(prior.byState ?? {}) };
    const byType: Record<string, number> = { ...(prior.byType ?? {}) };
    const unnamedWetlandBands: Record<string, number> = { ...(prior.unnamedWetlandBands ?? {}) };
    let total = prior.total ?? 0;
    let listed = prior.listed ?? 0;
    let withOsmId = prior.withOsmId ?? 0;
    let withNhdId = prior.withNhdId ?? 0;
    let withGeometrySource = prior.withGeometrySource ?? 0;
    let withDepth = prior.withDepth ?? 0;
    let withElevation = prior.withElevation ?? 0;
    let withWindRose = prior.withWindRose ?? 0;

    for (const body of page.page) {
      total++;
      if (isListed(body)) listed++;
      if (body.osmId) withOsmId++;
      if (body.nhdId) withNhdId++;
      if (body.geometrySource) withGeometrySource++;
      if (body.maxDepthM !== undefined || body.meanDepthM !== undefined) withDepth++;
      if (body.elevationM !== undefined) withElevation++;
      if (body.windRose) withWindRose++;
      byType[body.type] = (byType[body.type] ?? 0) + 1;
      // **The unnamed-wetland size distribution, because D96 is the rule most likely to be re-tuned.**
      // "Omit unnamed wetland" removes 96% of the class, and whether that is the right trade depends
      // on how much of it is big — which no whole-corpus aggregate answers. Banded here so a
      // threshold can be chosen against the real distribution rather than a sample, which is how the
      // first projection of this prune came out 40% low.
      // **`isWetlandClass`, not `type === 'marsh'`.** The D109 migration renames this value, and a
      // literal comparison would not fail — it would return zero for every band, which reads exactly
      // like "there is no unnamed wetland left" for the one rule most likely to be re-tuned.
      if (
        isWetlandClass(body.type) &&
        body.name.length === 0 &&
        body.surfaceAreaSqM !== undefined
      ) {
        const acres = body.surfaceAreaSqM / SQ_M_PER_ACRE_LOCAL;
        if (acres >= 5) {
          const band =
            acres >= 100
              ? '100+'
              : acres >= 50
                ? '50-100'
                : acres >= 30
                  ? '30-50'
                  : acres >= 25
                    ? '25-30'
                    : acres >= 10
                      ? '10-25'
                      : '5-10';
          unnamedWetlandBands[band] = (unnamedWetlandBands[band] ?? 0) + 1;
        }
      }
      // A border-spanning body counts once per state it touches, so these sum above `total` — which
      // is correct and is why they are reported separately rather than as a partition.
      for (const state of body.states ?? []) byState[state] = (byState[state] ?? 0) + 1;
    }

    return {
      running: {
        total,
        listed,
        withOsmId,
        withNhdId,
        withGeometrySource,
        withDepth,
        withElevation,
        withWindRose,
        byState,
        byType,
        unnamedWetlandBands,
      },
      scanned: page.page.length,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Page the corpus out for offline reconciliation — campaign step 2 (N7).
 *
 * **Geometry included, which is why this is paged at 100 rather than 500.** A body averages 1.8 KB
 * but Champlain's polygon alone is 10,755 vertices, and Convex caps a transaction at 16 MB of reads
 * as well as 4,096 documents — the N6c depth loader blew the byte cap at a batch of 25 by reasoning
 * only about the document count.
 *
 * Returns the minimum reconciliation needs: the key to write back to, the OSM id for the ledger, the
 * name for a human reading the review queue, and the polygon. **Not** the scores, cells or provenance
 * — this is one pass to get the geometry local, after which the matching iterates offline.
 */
export const listForReconcile = internalQuery({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, batchSize }) => {
    const numItems = Math.min(200, Math.max(1, batchSize ?? 100));
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });
    return {
      bodies: page.page.map((b) => ({
        key: b._id,
        externalId: b.externalId,
        name: b.name,
        polygon: b.polygon,
      })),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Apply the OSM ↔ NHD reconciliation — campaign step 2's write half (N7, D93).
 *
 * ## Why a match and a duplicate group are handled differently
 *
 * **A collapsed group must NOT receive the `nhdId`.** When two of our bodies both match one NHD
 * feature, writing that id to both would put the corpus into precisely the state `resolveUpsert`
 * refuses to work with — one identifier resolving to two rows — and the next import would return
 * `conflict` for a lake we ourselves broke. So the id is withheld and the pair goes to the dedup
 * queue instead.
 *
 * That is not a consolation prize: **the duplicate is the finding**. OSM cannot see that
 * `way/150404999` and `relation/2602300` are both Long Pond; NHD can, because both land on one
 * `Permanent_Identifier`. Fifty-five such groups exist, and the `nhdId` becomes writable on whichever
 * row survives the merge.
 *
 * `near_certain` rather than `suspected_duplicate` because the evidence is unusually strong: two
 * independent catalogues, plus a geometric proof that the two bodies overlap each other (to both
 * clear 0.5 IoU against one candidate, each must cover more than half of it). D36's queue exists for
 * exactly this decision, and merging is a moderator action, never an import's.
 *
 * ## What it will not overwrite
 *
 * An existing `nhdId` is left alone — it was either set by a later reconciliation or by hand, and both
 * outrank a restatement. A body already marked `merged` keeps that status; re-opening a settled merge
 * from an import would undo a moderator.
 */
export const importReconciliation = internalMutation({
  args: {
    matches: v.optional(v.array(v.object({ key: v.id('waterBodies'), nhdId: v.string() }))),
    duplicateGroups: v.optional(v.array(v.array(v.id('waterBodies')))),
  },
  handler: async (ctx, { matches, duplicateGroups }) => {
    let idWritten = 0;
    let idAlreadySet = 0;
    let missing = 0;
    for (const { key, nhdId } of matches ?? []) {
      const body = await ctx.db.get(key);
      if (!body) {
        missing++;
        continue;
      }
      if (body.nhdId !== undefined) {
        idAlreadySet++;
        continue;
      }
      await ctx.db.patch(key, { nhdId });
      idWritten++;
    }

    let flagged = 0;
    let flagSkipped = 0;
    for (const group of duplicateGroups ?? []) {
      const present = (await Promise.all(group.map((id) => ctx.db.get(id)))).filter(
        (b): b is NonNullable<typeof b> => b !== null,
      );
      if (present.length < 2) {
        flagSkipped++;
        continue;
      }
      for (const body of present) {
        if (body.dedupStatus === 'merged') {
          flagSkipped++;
          continue;
        }
        const others = present.filter((o) => o._id !== body._id).map((o) => o._id);
        await ctx.db.patch(body._id, {
          dedupStatus: 'near_certain',
          // Union rather than replace: a body may already have candidates from the D36 create-time
          // check, and dropping those would lose a signal a moderator has not acted on yet.
          duplicateCandidateIds: [...new Set([...(body.duplicateCandidateIds ?? []), ...others])],
        });
        flagged++;
      }
    }

    return { idWritten, idAlreadySet, missing, flagged, flagSkipped };
  },
});

/**
 * Mint a `waterBodyKey` for every body that lacks one — campaign step 4 (N7 / D93).
 *
 * **Never overwrites.** A key that already exists is the identity other things have already been
 * stamped with; re-minting it would be the exact failure the field exists to prevent.
 *
 * `wb_` prefix on an opaque UUID. The prefix costs three bytes and buys the thing an opaque id
 * otherwise loses: when one turns up in a tile stamp, a log line or an export, you can tell what
 * kind of thing it points at without a lookup.
 *
 * Paged and idempotent like the other backfills, so an interrupted run resumes rather than restarts.
 */
/**
 * Rewrite every stored `type` from the retired vocabulary into `WATER_BODY_CLASSES` (N7, D109).
 *
 * ## Why this is a separate pass rather than something the re-import does
 *
 * The canonical re-import would rewrite the OSM rows it touches — but it does not touch everything.
 * A body a skater drew (`source: 'user'`) never passes through the ETL, and a body the merge no
 * longer admits is never re-imported either; both would sit on the old vocabulary indefinitely, and
 * the schema union that tolerates them cannot be narrowed while any remain. So the migration is its
 * own pass, it runs before the re-import, and it is what lets the union close.
 *
 * ## It is pure restatement, which is what makes it safe to run against a live corpus
 *
 * Every new value is a function of the value already stored (`LEGACY_TYPE_TO_CLASS`), so this is
 * idempotent, order-independent, and safe to interleave with anything else — a row already carrying
 * a class is skipped rather than re-derived. Same shape as `backfillCatalogueIds` and
 * `mintWaterBodyKeys`: hand back the cursor, call until `isDone`.
 *
 * **It does not touch `displayScore`, cells, or listing.** `type` feeds none of them — D49 scores on
 * area and boost, N1 cells on bbox and prominence — so a body's position, visibility and ranking are
 * bit-identical before and after. The one thing that *does* read the class is `belongsInCorpus`, and
 * `isWetlandClass` deliberately understands both spellings precisely so the prune cannot disagree
 * with the corpus mid-migration.
 *
 * `remaining` is the number this pass exists to drive to zero — when it reports zero, the schema
 * union in `schema.ts` can be narrowed to `literals(WATER_BODY_CLASSES)`.
 */
export const backfillWaterBodyClasses = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    /** Actually write. Absent / false ⇒ count only, so the scope can be read before it moves. */
    apply: v.optional(v.boolean()),
  },
  handler: async (ctx, { cursor, batchSize, apply }) => {
    // A body carries its polygon, so a page is bounded by the transaction's byte budget long before
    // its document count — the same reason `pruneBelowAreaFloor` pages at 100 and the N6c depth
    // loader blew 16 MB at a batch of 25 by counting documents instead.
    const numItems = Math.min(500, Math.max(1, batchSize ?? 200));
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });

    let rewritten = 0;
    let alreadyMigrated = 0;
    let unmappable = 0;
    const byMapping: Record<string, number> = {};

    for (const body of page.page) {
      const current = body.type as string;
      if ((WATER_BODY_CLASSES as readonly string[]).includes(current)) {
        alreadyMigrated++;
        continue;
      }
      const next = LEGACY_TYPE_TO_CLASS[current as LegacyWaterBodyType];
      if (next === undefined) {
        // Neither vocabulary. Counted rather than thrown, because one unrecognised row must not
        // stall a migration across 18,383 — but counted loudly, because it means a value reached the
        // table that no validator should have admitted.
        unmappable++;
        continue;
      }
      // **ASCII, because this is a Convex object key.** Convex refuses a field name containing a
      // non-control non-ASCII character, so the obvious `→` throws at return time — after the
      // patches in this page have already been applied.
      byMapping[`${current}->${next}`] = (byMapping[`${current}->${next}`] ?? 0) + 1;
      if (apply === true) await ctx.db.patch(body._id, { type: next });
      rewritten++;
    }

    return {
      applied: apply === true,
      scanned: page.page.length,
      rewritten,
      alreadyMigrated,
      unmappable,
      byMapping,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * A light projection for the D97 audit: what each body is, what it is called, and which catalogue
 * rows it is tied to — **without the polygon** (N7).
 *
 * Separate from `listForReconcile`, which carries geometry and therefore pages at 100. The audit's
 * questions are about *attributes* — how much of `other` could borrow a class from NHD, whether a
 * name keyword agrees with the catalogue's own type — and answering them a hundred rows at a time
 * because of polygons nobody reads would be the expensive way to be slow.
 */
export const listForClassificationAudit = internalQuery({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, batchSize }) => {
    const numItems = Math.min(2000, Math.max(1, batchSize ?? 1000));
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });
    return {
      rows: page.page.map((b) => ({
        type: b.type,
        name: b.name,
        // The join key back to the offline artifacts — `.scratch/corpus.ndjson` carries the polygons
        // this projection deliberately omits, and an audit that needs geometry (bay containment,
        // say) joins the two rather than paging 18,383 polygons a hundred at a time.
        externalId: b.externalId ?? null,
        nhdId: b.nhdId ?? null,
        acres: Math.round((b.surfaceAreaSqM ?? 0) / 4046.8564224),
        // Depth rides along because the class rules now read it: an unnamed body deep enough to be
        // unambiguously a lake is promoted out of `unclassified` rather than waiting for a moderator.
        maxDepthM: b.maxDepthM ?? null,
        meanDepthM: b.meanDepthM ?? null,
        // Elevation separates a tidal bay from a lake bay better than geometry does: the ocean is at
        // zero and every lake in the region is not.
        elevationM: b.elevationM ?? null,
      })),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const backfillWaterBodyKeys = internalMutation({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, batchSize }) => {
    const numItems = Math.min(500, Math.max(1, batchSize ?? 200));
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });
    let minted = 0;
    let alreadySet = 0;
    for (const body of page.page) {
      if (body.waterBodyKey !== undefined) {
        alreadySet++;
        continue;
      }
      await ctx.db.patch(body._id, { waterBodyKey: `wb_${crypto.randomUUID()}` });
      minted++;
    }
    return {
      minted,
      alreadySet,
      scanned: page.page.length,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const backfillCatalogueIds = internalMutation({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, batchSize }) => {
    const numItems = Math.min(500, Math.max(1, batchSize ?? 200));
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });

    let patched = 0;
    let alreadySet = 0;
    let noExternalId = 0;
    for (const body of page.page) {
      const want = deriveCatalogueIds(body);
      if (Object.keys(want).length === 0) {
        noExternalId++;
        continue;
      }
      // Never overwrite. A value already present was either set by a later import or by a
      // reconciliation, and both outrank a restatement of what the row shipped with.
      const patch: Record<string, unknown> = {};
      if (want.osmId !== undefined && body.osmId === undefined) patch.osmId = want.osmId;
      if (want.nhdId !== undefined && body.nhdId === undefined) patch.nhdId = want.nhdId;
      if (body.geometrySource === undefined && want.geometrySource !== undefined) {
        patch.geometrySource = want.geometrySource;
      }
      if (Object.keys(patch).length === 0) {
        alreadySet++;
        continue;
      }
      await ctx.db.patch(body._id, patch);
      patched++;
    }
    return {
      patched,
      alreadySet,
      noExternalId,
      scanned: page.page.length,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Internal migration (run via `pnpm exec convex run`) that re-derives a body's D49 prominence and
 * rebuilds its cell rows (N1) — the path from the old centroid index to the ladder grid, and the
 * repair path for any body whose scores predate a scoring change.
 *
 * **Paginated, deliberately.** Its predecessor `collect()`-ed the whole table and re-inserted a
 * centroid-index point per body, which read far past Convex's 4,096-reads/mutation cap on anything
 * bigger than the handful of user-created bodies — so the canonical corpus had to be backfilled by
 * re-running the ETL loader instead. That stopped being viable at Phase 2.5's ~116k bodies. This
 * walks a `cursor` in bounded batches; the caller loops until `isDone`, and each batch is its own
 * transaction, so an interrupted run resumes rather than restarting.
 */
export const backfillCells = internalMutation({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, batchSize }) => {
    // Each body costs a `by_body` read plus up to 4 cell writes, so a few hundred per batch sits
    // comfortably inside the mutation's read/write budget with room for a re-cell of every row.
    const numItems = Math.min(500, Math.max(1, batchSize ?? 200));
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });

    for (const body of page.page) {
      // The D2 richness term is applied HERE and nowhere else — see `richnessFor` for why, and the
      // warning in `importCanonical` for the ordering that makes it correct.
      const richness = await richnessFor(ctx, body);
      const scores = scoreFields({
        richness,
        surfaceAreaSqM: body.surfaceAreaSqM,
        curatedBoost: body.curatedBoost,
      });
      const patch: Partial<Doc<'waterBodies'>> = {};
      if (body.displayScore !== scores.displayScore) patch.displayScore = scores.displayScore;
      if (body.minVisibleZoom !== scores.minVisibleZoom)
        patch.minVisibleZoom = scores.minVisibleZoom;
      if (Object.keys(patch).length > 0) await ctx.db.patch(body._id, patch);
      await syncWaterBodyCells(ctx, body._id, {
        bbox: body.bbox,
        minVisibleZoom: scores.minVisibleZoom,
        listed: isListed(body),
      });
    }
    return { reindexed: page.page.length, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/**
 * Copy `centroid` → `representativePoint` on rows written before the rename (N6c-1).
 *
 * **The transition window in one job.** Convex validates the schema against existing data on push,
 * and dev holds 116,070 rows that predate the new field, so the rename cannot be a single atomic
 * step: `representativePoint` ships optional, every writer sets both, this fills the backlog, and a
 * later change makes it required and drops `centroid`.
 *
 * Paginated for the same reason `backfillCells` is — the whole table cannot be read in one
 * transaction. Idempotent: a row that already has the field is skipped, so re-running costs reads
 * and no writes.
 *
 * Covers all three tables that carried the misnamed field.
 */
export const backfillRepresentativePoint = internalMutation({
  args: {
    table: literals(['waterBodies', 'waterBodySubAreas', 'adminAreas'] as const),
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, { table, cursor, batchSize }) => {
    const numItems = Math.min(1000, Math.max(1, batchSize ?? 500));
    const page = await ctx.db.query(table).paginate({ cursor: cursor ?? null, numItems });
    let filled = 0;
    for (const row of page.page) {
      if (row.representativePoint !== undefined) continue;
      await ctx.db.patch(row._id, { representativePoint: row.centroid });
      filled++;
    }
    return { scanned: page.page.length, filled, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/**
 * Is anything at all attached to this body — and if so, what?
 *
 * Every table here holds a **human** act against a specific lake: a report, a hazard, a bounty, a
 * put-in, a favourite, a recorded track, a moderator's body feature. A body with any of them is not
 * a puddle no matter what it measures, and deleting it would orphan the row rather than tidy the
 * corpus. Returns the first table that claims it, for the run summary; `null` means unattached.
 *
 * **Two queue tables are deliberately absent.** `recurrenceQueue` and `notificationQueue` have no
 * by-body index — but both are *derived*: a queue row exists only because a hazard, report or bounty
 * for that body exists, all three of which are checked here. No hazard ⇒ no recurrence row to strand.
 */
async function bodyAttachmentKind(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<string | null> {
  const report = await ctx.db
    .query('reports')
    .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', waterBodyId))
    .first();
  if (report) return 'reports';
  const hazard = await ctx.db
    .query('hazards')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .first();
  if (hazard) return 'hazards';
  const recurrence = await ctx.db
    .query('hazardRecurrence')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .first();
  if (recurrence) return 'hazardRecurrence';
  const bounty = await ctx.db
    .query('bounties')
    .withIndex('by_water_body_status', (q) => q.eq('waterBodyId', waterBodyId))
    .first();
  if (bounty) return 'bounties';
  const activity = await ctx.db
    .query('gpsActivities')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .first();
  if (activity) return 'gpsActivities';
  const favorite = await ctx.db
    .query('waterBodyFavorites')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .first();
  if (favorite) return 'waterBodyFavorites';
  const putIn = await ctx.db
    .query('putIns')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .first();
  if (putIn) return 'putIns';
  const feature = await ctx.db
    .query('bodyFeatures')
    .withIndex('by_water_body_active', (q) => q.eq('waterBodyId', waterBodyId))
    .first();
  if (feature) return 'bodyFeatures';
  const subArea = await ctx.db
    .query('waterBodySubAreas')
    .withIndex('by_parent', (q) => q.eq('waterBodyId', waterBodyId))
    .first();
  if (subArea) return 'waterBodySubAreas';
  const gateEvent = await ctx.db
    .query('bountyGateEvents')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
    .first();
  if (gateEvent) return 'bountyGateEvents';
  return null;
}

/**
 * Delete the canonical bodies the D91 floor would never have imported — **paginated, dry by
 * default, and refusing anything with a claim on it.**
 *
 * The rule (`belongsInCorpus`, `@skating/core`) governs what a *future* import writes; it cannot
 * reach the ~116,000 rows already stored, because `importCanonical` upserts and never deletes. This
 * is the other half: one pass that brings the stored corpus into agreement with the rule, driven
 * from `pnpm --filter @skating/etl prune-floor`.
 *
 * **It runs dry unless `apply` is true.** The tallies are identical either way, so the operator sees
 * exactly what a real run would do before it does it.
 *
 * A body is deleted only when it fails the floor **and** nothing else speaks for it:
 *  - `source: 'user'` is never touched — a skater drew it from a track they recorded (Phase 8).
 *  - `surfaceAreaSqM` absent ⇒ kept. The field is optional; "we can't measure it" is not "it's
 *    small", and a silent delete on a missing number is how you lose Champlain to a schema gap.
 *  - `curatedBoost` set ⇒ kept. An admin promoted it by hand (D49); that outranks a threshold.
 *  - `dedupStatus !== 'clean'`, or any merge pointer ⇒ kept. Reads follow the survivor (D36) and
 *    there is no index from a survivor back to the rows that name it, so a merge target must not
 *    vanish underneath them.
 *  - `removedAt` set ⇒ kept. A soft-delist is an admin act with a reason attached (D48), sometimes a
 *    landowner takedown; deleting the row destroys the record of the takedown along with the body.
 *  - anything attached to it (`bodyAttachmentKind`) ⇒ kept, and named in the summary.
 *
 * Cell rows go through `syncWaterBodyCells` with `listed: false` rather than a hand-rolled delete, so
 * the one tested path that maintains the N1 index stays the only thing that writes to it.
 */
export const pruneBelowAreaFloor = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    /** Actually delete. Absent / false ⇒ count only, write nothing. */
    apply: v.optional(v.boolean()),
  },
  handler: async (ctx, { cursor, batchSize, apply }) => {
    // A body carries its polygon, so a page is bounded by the transaction's **byte** budget long
    // before its document count, and the ceiling has to hold for the worst page rather than the
    // average one: most bodies are a few KB, but a page that happens to contain Lake Champlain
    // carries ~0.3 MiB in one row. 500 measured comfortably inside the limits on the five-state
    // corpus (a candidate also costs ≤ 10 index probes for attachments and ≤ 5 writes to delete),
    // and the cap is what keeps a caller from turning a slow pass into a failed transaction.
    const numItems = Math.min(500, Math.max(1, batchSize ?? 100));
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });

    const kept = {
      clearsFloor: 0,
      areaUnknown: 0,
      userCreated: 0,
      curated: 0,
      dedupOrMerged: 0,
      delisted: 0,
      attached: 0,
    };
    const attachedBy: Record<string, number> = {};
    let deleted = 0;

    for (const body of page.page) {
      // **The area the import decided on, not the one we draw.** `surfaceAreaSqM` is measured from
      // the simplified polygon; the floor was applied to the source geometry. They differ by a
      // fraction of a percent, which is enough to make a body just over a bar in one measure and
      // just under it in the other — so the import added it and this deleted it, every campaign,
      // forever. `sourceAreaSqM` is that number; the fallback is for rows written before it existed.
      const floorArea = body.sourceAreaSqM ?? body.surfaceAreaSqM;
      if (floorArea === undefined) {
        kept.areaUnknown++;
        continue;
      }
      if (
        belongsInCorpus({
          name: body.name,
          type: body.type,
          surfaceAreaSqM: floorArea,
          includedByRequest: body.includedByRequest,
        })
      ) {
        kept.clearsFloor++;
        continue;
      }
      if (body.source === 'user') {
        kept.userCreated++;
        continue;
      }
      if ((body.curatedBoost ?? 0) !== 0) {
        kept.curated++;
        continue;
      }
      if (
        body.dedupStatus !== 'clean' ||
        body.mergedIntoId !== undefined ||
        (body.duplicateCandidateIds?.length ?? 0) > 0
      ) {
        kept.dedupOrMerged++;
        continue;
      }
      if (body.removedAt !== undefined) {
        kept.delisted++;
        continue;
      }
      const attachment = await bodyAttachmentKind(ctx, body._id);
      if (attachment !== null) {
        kept.attached++;
        attachedBy[attachment] = (attachedBy[attachment] ?? 0) + 1;
        continue;
      }

      if (apply === true) {
        await syncWaterBodyCells(ctx, body._id, {
          bbox: body.bbox,
          minVisibleZoom: body.minVisibleZoom ?? MIN_VISIBLE_ZOOM_FLOOR,
          listed: false,
        });
        await ctx.db.delete(body._id);
      }
      deleted++;
    }

    return {
      applied: apply === true,
      scanned: page.page.length,
      deleted,
      kept,
      attachedBy,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Delete the stored bodies the campaign's master list did **not** re-affirm — campaign step 6 (N7).
 *
 * ## The gap this closes, and why the two existing prunes cannot
 *
 * `importCanonical` upserts and never deletes. So after a re-import the corpus is the **union** of
 * what the master list says and whatever was there before — and the two sets do not contain each
 * other: 18,383 stored against 27,074 merged, with real rows on both sides of the difference.
 *
 * Every stored body the new rules now refuse survives that load forever:
 *
 * - a body the ocean veto now catches (a Great Lake, an unnamed 100,000-acre polygon);
 * - a body outside the region mask, or in New York below I-84 (D111);
 * - an unnamed wetland under the 50-acre bar D96 settled after it was imported;
 * - a `salt_pool` or a river that the old classifier dropped into `other` and the new one refuses.
 *
 * **`pruneBelowAreaFloor` can find none of them**, because it only ever asks about area, and
 * `pruneOutsideCoverage` only about a polygon you hand it. This asks the one question that covers
 * every case at once: *did this campaign's master list re-affirm this body?*
 *
 * ## Membership is asserted by the loader, not inferred here
 *
 * `importCanonical` stamps `lastCampaignId` on every row it inserts or patches. A row whose stamp is
 * not the campaign we just ran is a row the master list did not contain — which is exactly the
 * statement we want, and it needs no geometry, no reclassification and no second copy of the rules.
 * Getting it from the data rather than re-deriving it is also what keeps this pass from disagreeing
 * with the import at the edges, which is the failure D97 named: *one deleter, one reporter.*
 *
 * ## Every protection `pruneBelowAreaFloor` honours, honoured identically
 *
 * A body carrying user content is **never** deleted, whatever the master list says — that is D93's
 * closing rule and it is the reason the whole campaign patches in place. `source: 'user'`, a
 * `curatedBoost`, a soft-delist, a dedup or merge pointer, `includedByRequest` (N7b's whole point),
 * and any attachment all keep a row. The shared predicate is `protectedFromPrune`, so the two passes
 * cannot drift.
 *
 * **Dry by default**, like both of its siblings: the tallies are identical either way.
 */
export const pruneNotInCampaign = internalMutation({
  args: {
    /** The campaign whose master list defines membership. Required — there is no sane default. */
    campaignId: v.string(),
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    apply: v.optional(v.boolean()),
    /**
     * How much of a page this pass is allowed to delete before it refuses — **the blast radius**
     * (N7 second audit).
     *
     * The prune's whole premise is that a row the campaign did not stamp is a row the master list did
     * not contain. That premise fails silently in one specific, likely way: `load.ts` deliberately
     * survives isolated batch failures (`MAX_CONSECUTIVE_BATCH_FAILURES = 5`), and every body in a
     * failed batch of ~150 is left unstamped. Nothing distinguishes those from bodies the rules now
     * refuse, so a load that reported success with three failed batches would hand this pass 450 real
     * lakes to delete, named twenty at a time in a summary nobody reads to the end.
     *
     * A whole-corpus replacement is not what step 6 is for — the expected deletion is the difference
     * between two master lists, which is a few percent. So a page that is mostly deletions is
     * evidence the premise broke, and the pass stops and says so.
     *
     * **Check the load's run row first.** This is the mechanical backstop, not the check: `load.ts`
     * records `batchFailures`, and a non-zero count there means do not run this at all.
     */
    maxDeleteFraction: v.optional(v.number()),
  },
  handler: async (ctx, { campaignId, cursor, batchSize, apply, maxDeleteFraction }) => {
    if (campaignId.trim().length === 0) {
      throw new ConvexError('pruneNotInCampaign: campaignId must not be empty');
    }
    const deleteCap =
      maxDeleteFraction === undefined
        ? DEFAULT_MAX_DELETE_FRACTION
        : Math.min(1, Math.max(0, maxDeleteFraction));
    // **Bounded by READS, not by bytes — and the first version got this wrong** (N7, found by
    // running it 2026-08-07).
    //
    // `pruneBelowAreaFloor`'s page limit is about polygon bytes, and this mutation inherited the
    // number without inheriting the arithmetic. The binding constraint here is different:
    // `bodyAttachmentKind` runs on every body the campaign did **not** re-affirm and costs **10
    // index reads** (reports, hazards, recurrence, bounties, tracks, favourites, put-ins, features,
    // sub-areas, gate events). Convex allows 4,096 reads per execution, so a page of 500 whose rows
    // are mostly deletion candidates asks for 5,000+ and dies:
    //
    // ```
    // Uncaught Error: Too many reads in a single function execution (limit: 4096)
    //     at async bodyAttachmentKind
    // ```
    //
    // It is the worst shape of limit to advertise, because it depends on the *data* rather than the
    // page: the first page of the real run had 11 candidates and sailed through at 500, so an
    // operator learns that 500 works and then hits the wall somewhere in the middle of a campaign,
    // where the un-reaffirmed rows happen to cluster.
    //
    // 250 leaves the worst case — every row on the page a candidate — at 2,750 reads.
    const numItems = Math.min(PRUNE_MAX_PAGE, Math.max(1, batchSize ?? 100));
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });

    const kept = {
      reaffirmed: 0,
      userCreated: 0,
      curated: 0,
      includedByRequest: 0,
      dedupOrMerged: 0,
      delisted: 0,
      attached: 0,
    };
    const attachedBy: Record<string, number> = {};
    /** Named, not just counted — a deletion nobody can inspect is one nobody can veto. */
    const sample: { name: string; externalId?: string; acres: number }[] = [];
    /**
     * Classified first, deleted second — so the blast-radius guard can see the whole page.
     *
     * The first version deleted inline, which meant a page that turned out to be 90% deletions had
     * already destroyed 90% of itself by the time anything could object.
     */
    const doomed: Doc<'waterBodies'>[] = [];

    for (const body of page.page) {
      if (body.lastCampaignId === campaignId) {
        kept.reaffirmed++;
        continue;
      }
      if (body.source === 'user') {
        kept.userCreated++;
        continue;
      }
      if (body.includedByRequest === true) {
        kept.includedByRequest++;
        continue;
      }
      // **A boost of zero is not a curation decision** (2026-08-07), and this used to read
      // `!== undefined`, which meant the field merely being *present* shielded a body from every
      // future prune. `pruneBelowAreaFloor` — written first — already had it right, so the two
      // passes disagreed about what "curated" means, which is the drift this codebase exists to
      // object to.
      //
      // Measured on dev: of 20 boosted bodies, 16 carry a real `0.3` and 4 carry a no-op `0`. Two of
      // those four were **South Bay** and **Half Moon Cove** on Cobscook Bay — tidal water the salt
      // veto had correctly refused, surviving two campaigns on a value that changes nothing about
      // how they draw.
      //
      // A **negative** boost is still a real decision (an admin demoting a body), which is why the
      // test is `!== 0` rather than `> 0`.
      if ((body.curatedBoost ?? 0) !== 0) {
        kept.curated++;
        continue;
      }
      if (
        body.dedupStatus !== 'clean' ||
        body.mergedIntoId !== undefined ||
        (body.duplicateCandidateIds?.length ?? 0) > 0
      ) {
        kept.dedupOrMerged++;
        continue;
      }
      if (body.removedAt !== undefined) {
        kept.delisted++;
        continue;
      }
      const attachment = await bodyAttachmentKind(ctx, body._id);
      if (attachment !== null) {
        kept.attached++;
        attachedBy[attachment] = (attachedBy[attachment] ?? 0) + 1;
        continue;
      }

      if (sample.length < PRUNE_SAMPLE_CAP) {
        sample.push({
          name: body.name,
          externalId: body.externalId,
          acres: Math.round((body.surfaceAreaSqM ?? 0) / SQ_M_PER_ACRE_LOCAL),
        });
      }
      doomed.push(body);
    }

    const deleted = doomed.length;
    const fraction = page.page.length === 0 ? 0 : deleted / page.page.length;
    // **The guard fires in both modes**, so a dry run reports the refusal instead of quietly
    // printing a number the operator would then apply. It does **not** fire on a page too small for
    // a fraction to mean anything: three rows of which two are unstamped is 67% and no evidence at
    // all, and a guard that cries wolf on the tail page of every run is one somebody switches off.
    if (page.page.length >= PRUNE_GUARD_MIN_PAGE && fraction > deleteCap) {
      throw new ConvexError(
        `pruneNotInCampaign: ${deleted} of ${page.page.length} rows on this page are not in ` +
          `campaign "${campaignId}" (${Math.round(fraction * 100)}% > ${Math.round(deleteCap * 100)}%). ` +
          'That is a whole-corpus replacement, not a difference between two master lists — check the ' +
          'load run row for failed batches before raising maxDeleteFraction.',
      );
    }

    if (apply === true) {
      for (const body of doomed) {
        await syncWaterBodyCells(ctx, body._id, {
          bbox: body.bbox,
          minVisibleZoom: body.minVisibleZoom ?? MIN_VISIBLE_ZOOM_FLOOR,
          listed: false,
        });
        await ctx.db.delete(body._id);
      }
    }

    return {
      applied: apply === true,
      scanned: page.page.length,
      deleted,
      deleteFraction: Math.round(fraction * 1000) / 1000,
      kept,
      attachedBy,
      sample,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * The largest page `pruneNotInCampaign` will take — **derived from the read budget, not chosen**.
 *
 * `bodyAttachmentKind` costs 10 index reads per un-reaffirmed body and Convex allows 4,096 per
 * execution, so the worst case (every row a candidate) is `10 × n + n`. At 250 that is 2,750; at the
 * 500 this used to allow, it is 5,500 and the mutation dies mid-campaign. See the handler.
 */
const PRUNE_MAX_PAGE = 250;

/**
 * Bodies named per page by `pruneNotInCampaign` — **all of them, not a sample**.
 *
 * This was 20, which made a dry run a *sample* of what it would delete rather than a manifest of it.
 * The docstring's own justification is *"a deletion nobody can inspect is one nobody can veto"*, and
 * you cannot veto what you were not shown: at ~21 deletions per page on the real run, a cap of 20 was
 * quietly withholding the tail of most pages.
 *
 * Set to the page ceiling so every candidate on a page is named. The cost is a return value of at
 * most 250 short objects — about 20 KB, for the one call in this campaign whose output somebody is
 * meant to read line by line before saying yes.
 */
const PRUNE_SAMPLE_CAP = PRUNE_MAX_PAGE;

/**
 * The default blast radius for `pruneNotInCampaign` — **a third of a page**.
 *
 * Set against what step 6 is actually for: the difference between two master lists. The last measured
 * gap was 18,383 stored against ~25,500 in the list with neither containing the other, so the
 * expected deletion is single-digit percent and clusters (out-of-region residue, a class the veto now
 * refuses). A page where a third of the rows went unstamped is not that shape — it is a load that did
 * not finish, and the founder's own framing for the corpus applies: trim later, never delete on
 * absence of evidence.
 *
 * Raise it deliberately, per invocation, once the load's run row shows zero failed batches.
 */
const DEFAULT_MAX_DELETE_FRACTION = 0.33;

/**
 * How many rows a page needs before its deletion *fraction* is evidence of anything.
 *
 * Twenty-five. Below that the ratio is dominated by its own denominator — a page of three rows of
 * which two are unstamped reads as 67% and means nothing — and the last page of any paginated run is
 * short by construction. A guard that fires on the tail of every campaign is a guard somebody
 * disables, which would cost more than the one it protects against.
 */
const PRUNE_GUARD_MIN_PAGE = 25;

/**
 * Delete water we no longer claim to cover — the corpus edge that is not the map's edge.
 *
 * ## Why there is anything to delete
 *
 * Coverage and rendering used to be one decision because the basemap was a bbox extract whose
 * southern edge — 41.2°N, just above Manhattan — cut both off together. The map now renders all of
 * New York, and the corpus deliberately does not follow it down (founder, 2026-08-05): Poughkeepsie
 * should appear on the map, and we should not be telling anyone about the ice on Kensico Reservoir.
 * Splitting the two left this residue, everything imported between 41.2°N and the county line while
 * they were still one question.
 *
 * ## Why the shapes are an argument
 *
 * The first draft resolved each body's centroid through `adminAreas` and asked which county it was
 * in. That is the *right* question and the wrong way to ask it at corpus scale: a place resolution
 * reads town, county and state polygons, and a page dense with downstate bodies blew Convex's 16 MB
 * per-execution read budget however small the page got. Taking the polygons as an argument makes
 * the whole pass allocation-free — the caller reads `downstate-ny-coarse.geojson`, written by
 * `pnpm --filter @skating/admin-areas build-region` from the same TIGER counties the map's mask is
 * cut from, so the line in the corpus and the line on the map cannot drift apart.
 *
 * It also leaves this general: it prunes bodies inside whatever polygons it is handed, and the next
 * coverage change is a different file rather than a different mutation.
 *
 * ## What it will not delete
 *
 * Exactly what `pruneBelowAreaFloor` will not, and for the same reason: a coverage decision is about
 * *our* data, and a body someone has reported on, favourited, drawn a hazard on or created by hand
 * has stopped being only ours. Those are kept and named in the summary, so the residue is visible
 * rather than silently spared. Cell rows go through `syncWaterBodyCells` with `listed: false`, never
 * a hand-rolled delete, or the ladder grid keeps pointing at bodies that no longer load.
 *
 * **Dry by default.** `apply` absent counts and writes nothing, which is the mode to run first and
 * the mode a mistyped invocation lands in.
 */
export const pruneOutsideCoverage = internalMutation({
  args: {
    /** The areas to prune, as GeoJSON polygons — see above for where they come from. */
    exclude: v.array(geoJson),
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    /** Actually delete. Absent / false ⇒ count only, write nothing. */
    apply: v.optional(v.boolean()),
  },
  handler: async (ctx, { exclude, cursor, batchSize, apply }) => {
    if (exclude.length === 0) throw new Error('pruneOutsideCoverage: no polygons to prune inside');
    // One bbox over the whole exclusion set, so a body nowhere near it costs four comparisons rather
    // than a point-in-polygon walk. Almost every body in a five-state corpus is nowhere near it.
    const boxes = exclude.map((polygon) => polygonBBox(polygon as Polygon | MultiPolygon));
    const gate = {
      minLng: Math.min(...boxes.map((b) => b.minLng)),
      minLat: Math.min(...boxes.map((b) => b.minLat)),
      maxLng: Math.max(...boxes.map((b) => b.maxLng)),
      maxLat: Math.max(...boxes.map((b) => b.maxLat)),
    };

    // Bounded by the transaction's byte budget, not its document count — see `pruneBelowAreaFloor`
    // for the worked reasoning.
    const numItems = Math.min(500, Math.max(1, batchSize ?? 100));
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });

    const kept = { inCoverage: 0, userCreated: 0, attached: 0 };
    const attachedBy: Record<string, number> = {};
    let deleted = 0;

    for (const body of page.page) {
      // `centroid` is `pointOnFeature` and can sit on the shoreline rather than inside the water
      // (see its own note), which for a county-scale test is close enough — a body straddling the
      // line is decided by whichever side its representative point landed, and either answer is
      // within the rule we are enforcing.
      const point = body.centroid;
      const near =
        point.lng >= gate.minLng &&
        point.lng <= gate.maxLng &&
        point.lat >= gate.minLat &&
        point.lat <= gate.maxLat;
      const inside =
        near &&
        exclude.some((polygon, i) => {
          const box = boxes[i];
          if (
            box === undefined ||
            point.lng < box.minLng ||
            point.lng > box.maxLng ||
            point.lat < box.minLat ||
            point.lat > box.maxLat
          ) {
            return false;
          }
          return pointInPolygon(point, polygon as Polygon | MultiPolygon);
        });
      if (!inside) {
        kept.inCoverage++;
        continue;
      }
      if (body.source === 'user') {
        kept.userCreated++;
        continue;
      }
      const attachment = await bodyAttachmentKind(ctx, body._id);
      if (attachment !== null) {
        kept.attached++;
        attachedBy[attachment] = (attachedBy[attachment] ?? 0) + 1;
        continue;
      }

      if (apply === true) {
        await syncWaterBodyCells(ctx, body._id, {
          bbox: body.bbox,
          minVisibleZoom: body.minVisibleZoom ?? MIN_VISIBLE_ZOOM_FLOOR,
          listed: false,
        });
        await ctx.db.delete(body._id);
      }
      deleted++;
    }

    return {
      applied: apply === true,
      scanned: page.page.length,
      deleted,
      kept,
      attachedBy,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * How far our shoreline may differ from HydroLAKES' before the run says so (D85).
 *
 * **2×, and deliberately loose.** The two are measuring different polygons — different water mask,
 * different date, different resolution — so ordinary disagreement is expected and is not a finding.
 * This is a *broken-join* detector, not an accuracy bar: a factor of two on a lake big enough for
 * HydroLAKES to carry at all means we matched the wrong body or mishandled its rings.
 */
const SHORELINE_CROSS_CHECK_RATIO = 2;

// ── Bathymetry contour coverage (N6c-1 / D2) ─────────────────────────────────────────────────

/**
 * Replace the contour-coverage set with the bodies the current tileset actually draws.
 *
 * **Replace, not merge**, and paginated so it can be driven from a loader loop: a re-tile that drops
 * a lake must drop its coverage too, or the row keeps claiming surveyed bathymetry it no longer has
 * — silently, since nothing on the map would look different. `clearFirst` on the opening batch is
 * what makes the whole operation a replacement rather than an accumulation.
 */
export const importContourCoverage = internalMutation({
  args: {
    source: literals(CANONICAL_SOURCES),
    externalIds: v.array(v.string()),
    clearFirst: v.optional(v.boolean()),
  },
  handler: async (ctx, { source, externalIds, clearFirst }) => {
    let cleared = 0;
    if (clearFirst) {
      // ~2,000 rows, so a full collect is bounded and this is the one place it is honest to do.
      const existing = await ctx.db.query('bathymetryCoverage').collect();
      for (const row of existing) {
        await ctx.db.delete(row._id);
        cleared++;
      }
    }
    let inserted = 0;
    for (const externalId of externalIds) {
      const already = await ctx.db
        .query('bathymetryCoverage')
        .withIndex('by_external_id', (q) => q.eq('source', source).eq('externalId', externalId))
        .first();
      if (already) continue;
      await ctx.db.insert('bathymetryCoverage', { source, externalId });
      inserted++;
    }
    return { cleared, inserted };
  },
});

// ── Elevation (N6c A1) ───────────────────────────────────────────────────────────────────────

/**
 * Page the corpus for bodies whose elevation the DEM pass should look up.
 *
 * **Paginated and filtered server-side**, the `backfillCells` shape: 116,070 bodies cannot be
 * `.collect()`-ed, and the loader has no business deciding what to skip — the precedence rule lives
 * next to the write that enforces it, or the two drift.
 *
 * Two exclusions, and they are the difference between a resumable pass and a pass that redoes its
 * work every time it is interrupted:
 * - **`operator`-sourced rows are never returned**, so a moderator's value costs no quota and can
 *   never be overwritten by a race between the read and the write.
 * - **Rows already carrying a `dem_glo90` reading are skipped** unless `refresh` is set, so a
 *   re-run after a failure resumes rather than restarts. `refresh` exists for the day the DEM
 *   changes; it is not the normal path.
 *
 * Returns the point to sample — `interiorPoint` where the re-import has set one, `centroid`
 * otherwise. A DEM read on a bank is biased upward by the bank, which is the whole reason
 * `interiorPoint` exists.
 */
export const listNeedingElevation = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    refresh: v.optional(v.boolean()),
    /**
     * Only return bodies the canonical import would keep — `belongsInCorpus`, imported, not restated.
     * That predicate rather than the bare area floor, so a body admitted by request (N7b) gets its
     * elevation like any other; before N7 this pass was stricter than the prune, so a below-floor
     * body with a report on it would have survived forever with no elevation and nothing saying so.
     *
     * **Paging is free; API calls are not.** Open-Meteo's free tier counts each *coordinate* against
     * the quota, so a 100-coordinate request costs ~100 calls and a corpus-wide pass is ~12 days of
     * free-tier allowance. Scanning every body costs nothing, so the filter belongs here — between
     * the cheap read and the expensive lookup — rather than on the caller.
     *
     * **A boolean, not a threshold, and that is the point.** This was briefly a `minAreaSqM` number
     * with a comment saying it mirrored the import's rule. It drifted within hours: the rule became
     * `>= 5 acres OR (named AND >= 1 acre)` while the copy here still said `named OR >= 5 acres`,
     * which is strictly more permissive — it would have spent quota on sub-one-acre named bodies
     * that `pruneBelowAreaFloor` deletes. Importing the predicate makes "the current rule" true by
     * construction; a parameter invites a caller to invent a different floor.
     */
    importFloorOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, { cursor, batchSize, refresh, importFloorOnly }) => {
    const numItems = Math.min(1000, Math.max(1, batchSize ?? 500));
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });
    const belowFloor = (body: Doc<'waterBodies'>) =>
      !belongsInCorpus({
        name: body.name ?? '',
        surfaceAreaSqM: body.surfaceAreaSqM ?? 0,
        includedByRequest: body.includedByRequest,
      });
    const targets = page.page
      .filter((body) => {
        if (body.elevationSource === 'operator') return false;
        if (importFloorOnly === true && belowFloor(body)) return false;
        return refresh === true || body.elevationM === undefined;
      })
      .map((body) => {
        const point = body.interiorPoint ?? body.representativePoint ?? body.centroid;
        return { waterBodyId: body._id, lat: point.lat, lng: point.lng };
      });
    return {
      targets,
      scanned: page.page.length,
      // Counted so a filtered run can say how much of the corpus it deliberately walked past —
      // otherwise "scanned 116,070, looked up 16,817" reads like a 14% failure rather than a 14%
      // target.
      belowFloor: importFloorOnly === true ? page.page.filter(belowFloor).length : 0,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Write a batch of DEM elevations (N6c A1).
 *
 * **Re-checks the operator rung at write time** even though `listNeedingElevation` already filtered
 * on it. The read and the write are separate transactions and a 116k-body pass takes minutes, so a
 * moderator can set an override in between — and the failure mode of getting that wrong is silent:
 * the override simply disappears and nobody knows which lakes lost one.
 *
 * Implausible readings are counted and dropped rather than stored (`isPlausibleElevationM`), on the
 * same reasoning as the OSM depth tag's strict parse: a wrong number here renders as a fact.
 */
export const importElevations = internalMutation({
  args: {
    elevations: v.array(v.object({ waterBodyId: v.id('waterBodies'), elevationM: v.number() })),
  },
  handler: async (ctx, { elevations }) => {
    let updated = 0;
    let operatorHeld = 0;
    let implausible = 0;
    let missing = 0;
    for (const { waterBodyId, elevationM } of elevations) {
      const body = await ctx.db.get(waterBodyId);
      if (!body) {
        missing++;
        continue;
      }
      if (!canOverwriteElevation(body.elevationSource)) {
        operatorHeld++;
        continue;
      }
      if (!isPlausibleElevationM(elevationM)) {
        implausible++;
        continue;
      }
      await ctx.db.patch(waterBodyId, { elevationM, elevationSource: 'dem_glo90' });
      updated++;
    }
    return { updated, operatorHeld, implausible, missing };
  },
});

// ── Winter wind rose (N6c A4b) ───────────────────────────────────────────────────────────────

/**
 * Page the corpus for bodies whose wind rose is worth fetching.
 *
 * **Only bodies that could ever use one.** The caption suppresses the wind clause below
 * `MIN_FETCH_CLAUSE_M`, so a body whose longest fetch is under that threshold would spend WIND
 * Toolkit requests on a number nothing will ever render. That filter is what turns a 116,070-body
 * pass into a few thousand — and the requests are the scarce resource here (10,000/day, one point
 * and one year each), not the storage.
 *
 * Returns the point to sample and the body's current rose state, so the loader can dedupe by grid
 * cell before spending anything.
 */
export const listNeedingWindRose = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    refresh: v.optional(v.boolean()),
    /** Minimum longest-fetch to qualify; defaults to the caption's own floor. */
    minFetchM: v.optional(v.number()),
    /**
     * The import rule, same predicate and same reason as `listNeedingElevation` — `belongsInCorpus`,
     * imported rather than restated. A rose costs five WIND Toolkit requests against a 10,000/day
     * allowance, and a body `pruneBelowAreaFloor` is about to delete is not worth one of them.
     *
     * Expected to change little — qualifying on fetch already selects big water — but "expected" is
     * not "measured", and the run reports `belowFloor` either way.
     */
    importFloorOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, { cursor, batchSize, refresh, minFetchM, importFloorOnly }) => {
    const numItems = Math.min(1000, Math.max(1, batchSize ?? 500));
    const floor = minFetchM ?? MIN_FETCH_CLAUSE_M;
    let belowFloor = 0;
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });
    const targets = page.page
      .filter((body) => {
        if (!isListed(body)) return false;
        if (!refresh && body.windRose !== undefined) return false;
        if (
          importFloorOnly === true &&
          !belongsInCorpus({
            name: body.name ?? '',
            surfaceAreaSqM: body.surfaceAreaSqM ?? 0,
            includedByRequest: body.includedByRequest,
          })
        ) {
          belowFloor++;
          return false;
        }
        const fetchProfileM = body.fetchProfileM;
        if (!fetchProfileM || fetchProfileM.length === 0) return false;
        return Math.max(...fetchProfileM) >= floor;
      })
      .map((body) => {
        const point = body.interiorPoint ?? body.representativePoint ?? body.centroid;
        return { waterBodyId: body._id, lat: point.lat, lng: point.lng };
      });
    return {
      targets,
      scanned: page.page.length,
      belowFloor,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Write a batch of winter wind roses.
 *
 * **Validates the rose shape server-side** rather than trusting the loader: a rose stored as raw
 * hour counts instead of frequencies is still sixteen plausible numbers, and it would scale every
 * exposure index by the hours sampled — which changes no ranking and breaks every threshold. See
 * `isPlausibleWindRose`.
 */
export const importWindRoses = internalMutation({
  args: {
    roses: v.array(v.object({ waterBodyId: v.id('waterBodies'), rose: v.array(v.number()) })),
  },
  handler: async (ctx, { roses }) => {
    let updated = 0;
    let malformed = 0;
    let missing = 0;
    for (const { waterBodyId, rose } of roses) {
      const body = await ctx.db.get(waterBodyId);
      if (!body) {
        missing++;
        continue;
      }
      if (!isPlausibleWindRose(rose)) {
        malformed++;
        continue;
      }
      await ctx.db.patch(waterBodyId, { windRose: rose, windRoseSource: 'wtk_2km' });
      updated++;
    }
    return { updated, malformed, missing };
  },
});

/** Create a user-contributed water body, queued for after-the-fact review (D14/D37). */
export const create = mutation({
  args: {
    name: v.string(),
    type: literals(WATER_BODY_CLASSES),
    /**
     * The recorded skate this body is derived from. **Required** — the geometry is computed
     * server-side from its trusted path, and the client cannot supply a polygon at all.
     */
    activityId: v.id('gpsActivities'),
    /** Set after the user has seen the ranked matches and answered "none of these" (D36). */
    confirmedNew: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const profile = await requireContributor(ctx);
    const now = Date.now();
    // Minors are read-only (D41) — mirror `reports.create`, so a minor can't push a public map
    // contribution attributed to them.
    if (isMinor(profile.dateOfBirth, now)) {
      throw new ConvexError('Users under 18 cannot create water bodies');
    }

    // Path-only, enforced at the trust boundary (D14/D36, D37 "the server contract is the boundary").
    // There is no freehand drawing in this app and there is no argument by which a client can hand us
    // a shape: without a trusted path there's no proof of presence and no frame of reference for
    // scale or position, so a body derived from anything else would be a guess that then collects
    // other people's reports.
    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new ConvexError('Activity not found');
    if (activity.userId !== profile._id) throw new ConvexError('Not your activity');
    if (activity.path?.type !== 'LineString') {
      throw new ConvexError('That skate has no recorded path');
    }
    if (activity.waterBodyId !== undefined) {
      throw new ConvexError('That skate already resolved to a known lake');
    }

    const derived = pathToBody(activity.path as LineString);
    if (derived === null) {
      throw new ConvexError(
        "That recording is too short to map a new lake from — it didn't move far enough.",
      );
    }

    // Match on create (D36): score the derived shape against everything nearby and refuse to mint a
    // duplicate silently. The caller must have seen the ranked matches and said "none of these".
    const { status, matches } = await scoreAgainstNearby(ctx, {
      name: args.name,
      geometry: derived.polygon,
      centroid: derived.centroid,
      bbox: derived.bbox,
    });
    if (matches.length > 0 && args.confirmedNew !== true) {
      throw new ConvexError({
        code: 'possible_duplicate',
        message: 'This looks like water we already know about.',
        candidateIds: matches.map((m) => m.ref),
      });
    }

    const scores = scoreFields({ surfaceAreaSqM: derived.surfaceAreaSqM }); // no boost on a new body
    const id = await ctx.db.insert('waterBodies', {
      name: args.name,
      type: args.type,
      source: 'user',
      polygon: derived.polygon,
      bbox: derived.bbox,
      centroid: derived.centroid,
      representativePoint: derived.centroid,
      surfaceAreaSqM: derived.surfaceAreaSqM,
      ...scores,
      createdByUserId: profile._id,
      reviewStatus: 'pending', // auto-visible, review-after (D37)
      // The verdict is stamped even when the user confirmed it's new — that stamp is exactly what
      // feeds the Phase 7 moderator merge queue, which has had nothing flowing into it until now.
      dedupStatus: status,
      ...(matches.length > 0 ? { duplicateCandidateIds: matches.map((m) => m.ref) } : {}),
      createdAt: now,
    });
    // Cell-index it for viewport lookups (N1); a pending user body is auto-visible (D37/D48), so it
    // lists immediately. A suspected/near-certain duplicate still lists: hiding it would take any
    // reports filed against it off the map on a machine's guess (D3).
    await syncWaterBodyCells(ctx, id, {
      bbox: derived.bbox,
      minVisibleZoom: scores.minVisibleZoom,
      listed: isListed({ reviewStatus: 'pending', dedupStatus: status }),
    });
    // Bind the skate to the water it discovered, so the report flow can carry straight on.
    await ctx.db.patch(args.activityId, { waterBodyId: id });
    return id;
  },
});

/**
 * Score a proposed body against every listed body near it (D36) — the shared half of
 * `findMatchCandidates` (which shows the user the steer) and `create` (which stamps the verdict), so
 * the ranked list someone chose "none of these" against is provably the same list the stamp came from.
 */
async function scoreAgainstNearby(
  ctx: QueryCtx,
  candidate: DedupShape,
): Promise<DedupClassification<Id<'waterBodies'>>> {
  const nearby = await listedBodiesNearCoord(ctx, candidate.centroid);
  return classifyDedup(
    candidate,
    [...nearby.values()].map((body) => ({
      ref: body._id,
      name: body.name,
      geometry: body.polygon as unknown as Polygon | MultiPolygon,
      centroid: body.centroid,
      bbox: body.bbox,
      // D36 prefers attaching to official data, so canonical bodies rank first among equals.
      official: body.source !== 'user',
    })),
  );
}

/**
 * "Attach here?" — the ranked matches for the body a skate would create (D36).
 *
 * The **producer** the Phase 7 dedup queue has been waiting for. The client calls this before
 * `create`, shows the matches, and only sends `confirmedNew` once the user has explicitly rejected
 * all of them. Deriving the shape here (rather than taking one) means the preview is scored against
 * the *exact* geometry that would be stored.
 */
export const findMatchCandidates = query({
  args: { activityId: v.id('gpsActivities'), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const profile = await requireProfile(ctx);
    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new ConvexError('Activity not found');
    if (activity.userId !== profile._id) throw new ConvexError('Not your activity');
    if (activity.path?.type !== 'LineString') {
      return { status: 'clean' as const, derivable: false, matches: [] };
    }
    const derived = pathToBody(activity.path as LineString);
    if (derived === null) return { status: 'clean' as const, derivable: false, matches: [] };

    const { status, matches } = await scoreAgainstNearby(ctx, {
      name: args.name ?? '',
      geometry: derived.polygon,
      centroid: derived.centroid,
      bbox: derived.bbox,
    });

    return {
      status,
      derivable: true,
      surfaceAreaSqM: derived.surfaceAreaSqM,
      matches: await Promise.all(
        matches.map(async (m) => {
          const body = await ctx.db.get(m.ref);
          return {
            waterBodyId: m.ref,
            name: body?.name ?? '',
            official: m.official,
            verdict: m.verdict,
            centroidDistanceM: Math.round(m.centroidDistanceM),
          };
        }),
      ),
    };
  },
});

/** Moderator/admin: approve a pending user-created body + write the audit row (D37). */
export const approve = mutation({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, args) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const body = await ctx.db.get(args.waterBodyId);
    if (!body) throw new ConvexError('Water body not found');
    // Only user-created bodies enter the review queue; approving canonical (OSM/NHD)
    // bodies is meaningless and would stamp a `reviewStatus` they shouldn't have.
    if (body.source !== 'user') {
      throw new ConvexError('Only user-created water bodies can be reviewed');
    }
    // Idempotency + audit integrity: only a pending body can be approved, so we never
    // reverse a rejection or write duplicate audit rows on a re-approve.
    if (body.reviewStatus !== 'pending') {
      throw new ConvexError('Water body is not pending review');
    }

    await ctx.db.patch(args.waterBodyId, { reviewStatus: 'approved' });
    // Keep the cell index in sync with the new listing (still listed, D48).
    await syncWaterBodyCells(ctx, args.waterBodyId, {
      bbox: body.bbox,
      minVisibleZoom: zoomSortKey(body),
      listed: isListed({ ...body, reviewStatus: 'approved' }),
    });
    // Sub-areas inherit the parent's listing (Decision 11), so every mutation that moves it has to
    // move theirs — a bay is only reachable while the lake it names is.
    await syncCellsForParent(ctx, args.waterBodyId, { ...body, reviewStatus: 'approved' });
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'approve_waterbody',
      targetType: 'waterbody',
      targetId: args.waterBodyId,
      reason: 'Approved user-created water body',
      createdAt: Date.now(),
    });
    return args.waterBodyId;
  },
});

/**
 * Admin: soft-delist a body from the map — curation or a landowner takedown (D48). Reversible
 * (never a hard delete): stamp `removed*`, drop its cell-index rows, and
 * write a `moderationActions` audit row. A re-import preserves this (see `importCanonical`).
 */
export const remove = mutation({
  args: { waterBodyId: v.id('waterBodies'), reason: literals(REMOVAL_REASONS) },
  handler: async (ctx, args) => {
    const actor = await requireContributorRole(ctx, 'admin');
    const body = await ctx.db.get(args.waterBodyId);
    if (!body) throw new ConvexError('Water body not found');
    // Idempotency + no duplicate audit rows: only an on-map body can be removed.
    if (body.removedAt !== undefined) throw new ConvexError('Water body is already removed');

    const now = Date.now();
    await ctx.db.patch(args.waterBodyId, {
      removedAt: now,
      removedByUserId: actor._id,
      removalReason: args.reason,
    });
    // A removed body loses its cell rows outright, so it costs the read path nothing (N1).
    await syncWaterBodyCells(ctx, args.waterBodyId, {
      bbox: body.bbox,
      minVisibleZoom: zoomSortKey(body),
      listed: isListed({ ...body, removedAt: now }),
    });
    // The case this exists for: a landowner takedown must take the lake's named bays off the map
    // with it, or "Malletts Bay" keeps drawing on a map that no longer has Lake Champlain.
    await syncCellsForParent(ctx, args.waterBodyId, { ...body, removedAt: now });
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'remove',
      targetType: 'waterbody',
      targetId: args.waterBodyId,
      reason: `Removed from map (${args.reason})`,
      metadata: { removalReason: args.reason },
      createdAt: now,
    });
    return args.waterBodyId;
  },
});

/** Admin: reverse a removal — clear `removed*`, re-derive `listed`, audit the restore (D48). */
export const restore = mutation({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, args) => {
    const actor = await requireContributorRole(ctx, 'admin');
    const body = await ctx.db.get(args.waterBodyId);
    if (!body) throw new ConvexError('Water body not found');
    if (body.removedAt === undefined) throw new ConvexError('Water body is not removed');

    await ctx.db.patch(args.waterBodyId, {
      removedAt: undefined,
      removedByUserId: undefined,
      removalReason: undefined,
    });
    await syncWaterBodyCells(ctx, args.waterBodyId, {
      bbox: body.bbox,
      minVisibleZoom: zoomSortKey(body),
      listed: isListed({ ...body, removedAt: undefined }),
    });
    // Restoring the lake brings back the bays that weren't delisted in their own right.
    await syncCellsForParent(ctx, args.waterBodyId, { ...body, removedAt: undefined });
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'restore',
      targetType: 'waterbody',
      targetId: args.waterBodyId,
      reason: 'Restored to the map',
      createdAt: Date.now(),
    });
    return args.waterBodyId;
  },
});

/**
 * Moderator: reject a user-drawn body (D37) — the third arm of the review triad beside `approve` and
 * the D36 `merge`. Mirrors `approve`'s guards (user-source, still-pending), flips `reviewStatus` to
 * `rejected` (which `isListed` treats as unlisted), drops its cell rows so it leaves the
 * map, and audits `reject_waterbody`.
 */
export const reject = mutation({
  args: { waterBodyId: v.id('waterBodies'), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const body = await ctx.db.get(args.waterBodyId);
    if (!body) throw new ConvexError('Water body not found');
    if (body.source !== 'user') {
      throw new ConvexError('Only user-created water bodies can be reviewed');
    }
    if (body.reviewStatus !== 'pending') {
      throw new ConvexError('Water body is not pending review');
    }

    await ctx.db.patch(args.waterBodyId, { reviewStatus: 'rejected' });
    await syncWaterBodyCells(ctx, args.waterBodyId, {
      bbox: body.bbox,
      minVisibleZoom: zoomSortKey(body),
      listed: isListed({ ...body, reviewStatus: 'rejected' }),
    });
    await syncCellsForParent(ctx, args.waterBodyId, { ...body, reviewStatus: 'rejected' });
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'reject_waterbody',
      targetType: 'waterbody',
      targetId: args.waterBodyId,
      reason: args.reason?.trim() || 'Rejected user-created water body',
      createdAt: Date.now(),
    });
    return args.waterBodyId;
  },
});

/**
 * Moderator: merge a duplicate water body into a survivor (D36) — the missing dedup mutation. Re-points
 * **every** body-keyed child (`reports`/`hazards`/`bounties`/`bodyFeatures`/`putIns`/
 * `waterBodyFavorites`) from the loser to the survivor, then soft-tombstones the loser
 * (`dedupStatus: merged` + `mergedIntoId`) so read paths follow the chain to the survivor and
 * `isListed` drops it off the map. Never a hard delete (reversible in spirit with the D15/D33 ethos);
 * audits `merge_waterbody` with the re-pointed counts.
 *
 * Favorites and put-ins were initially left behind on the theory that a dedup loser is always a bare
 * user-drawn duplicate; they're re-pointed as of the 2026-07-24 review, because stranding them on a
 * tombstone silently drops official put-ins, loses hidden-put-in suppression, and cuts favoriters off
 * from drive-time matching and report notifications for a lake they still care about.
 *
 * `notificationQueue` rows are deliberately left alone — they're transient (drained within hours by the
 * flush cron) and carry a `coalesceKey` baked from the old id, so re-pointing them would break
 * coalescing for no lasting benefit.
 */
export const merge = mutation({
  args: {
    survivorId: v.id('waterBodies'),
    loserId: v.id('waterBodies'),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { survivorId, loserId, reason }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    if (survivorId === loserId) throw new ConvexError('Cannot merge a water body into itself');
    const survivor = await ctx.db.get(survivorId);
    const loser = await ctx.db.get(loserId);
    if (!survivor || !loser) throw new ConvexError('Water body not found');
    // Don't merge into a tombstone, and don't re-merge an already-merged loser — the operator must
    // pick a live canonical survivor, which also keeps the merge chain a single hop.
    if (survivor.mergedIntoId !== undefined) {
      throw new ConvexError('Survivor is itself merged — pick the canonical body');
    }
    if (loser.dedupStatus === 'merged') throw new ConvexError('Water body is already merged');

    // Re-point every child from loser → survivor. Merge is a rare manual action on a typically-small
    // dedup loser, so a bounded `collect()` per child table is acceptable (cf. `listPendingReview`).
    // Unrolled per table so each `withIndex` keeps its exact type (Convex index builders are per-table).
    const reports = await ctx.db
      .query('reports')
      .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', loserId))
      .collect();
    const hazards = await ctx.db
      .query('hazards')
      .withIndex('by_water_body', (q) => q.eq('waterBodyId', loserId))
      .collect();
    const bounties = await ctx.db
      .query('bounties')
      .withIndex('by_water_body_status', (q) => q.eq('waterBodyId', loserId))
      .collect();
    // A merge loser is normally a user-drawn suspected-duplicate with no promoted features, but a
    // stranded known-hazard feature would be a safety false-negative — so re-point these too.
    const features = await ctx.db
      .query('bodyFeatures')
      .withIndex('by_water_body_active', (q) => q.eq('waterBodyId', loserId))
      .collect();
    // Put-ins carry `official` (accurate, priority-styled) and `hidden` (moderator suppression that has
    // to outlive re-clustering, decision #7) rows — both are silent safety/quality losses if stranded.
    const putIns = await ctx.db
      .query('putIns')
      .withIndex('by_water_body', (q) => q.eq('waterBodyId', loserId))
      .collect();
    for (const child of [...reports, ...hazards, ...bounties, ...features, ...putIns]) {
      await ctx.db.patch(child._id, { waterBodyId: survivorId });
    }

    // Favorites are one-row-per-user×body (`by_user_water_body` is the uniqueness key), so a user who
    // favorited BOTH bodies would end up with a duplicate pair. Re-point when they only had the loser;
    // drop the loser row when the survivor is already favorited.
    const favorites = await ctx.db
      .query('waterBodyFavorites')
      .withIndex('by_water_body', (q) => q.eq('waterBodyId', loserId))
      .collect();
    let favoritesRepointed = 0;
    let favoritesDeduped = 0;
    for (const fav of favorites) {
      const existing = await ctx.db
        .query('waterBodyFavorites')
        .withIndex('by_user_water_body', (q) =>
          q.eq('userId', fav.userId).eq('waterBodyId', survivorId),
        )
        .unique();
      if (existing) {
        await ctx.db.delete(fav._id);
        favoritesDeduped++;
      } else {
        await ctx.db.patch(fav._id, { waterBodyId: survivorId });
        favoritesRepointed++;
      }
    }

    // Named sub-areas move too (Decision 11). Leaving them would strand hand-drawn curation on a
    // tombstone whose `isListed` is permanently false — unreachable from the map and the editor, yet
    // still named on every report this merge just moved to the survivor. Re-clipped against the
    // survivor's outline on the way, since near-identical is what made these a duplicate pair.
    const subAreas = await repointSubAreasOnMerge(ctx, loserId, survivor, actor._id);

    const repointed = {
      reports: reports.length,
      hazards: hazards.length,
      bounties: bounties.length,
      bodyFeatures: features.length,
      putIns: putIns.length,
      favorites: favoritesRepointed,
      favoritesDeduped,
      subAreas: subAreas.repointed,
      subAreasDelisted: subAreas.delisted,
    };

    // Soft-tombstone the loser: reads chase `mergedIntoId` to the survivor; `isListed` treats
    // `merged` as unlisted, so drop its cell rows too.
    await ctx.db.patch(loserId, { dedupStatus: 'merged', mergedIntoId: survivorId });
    // …and clear the flag at the **other end of the pair**, which nothing used to do. N7's
    // reconciliation flags every member of a duplicate group mutually, so the survivor is normally
    // itself `near_certain` naming the body just merged — a candidate `merge` would now refuse as
    // "already merged". Left alone, every merge cleared one card and left a permanent, unclearable
    // one behind, and the queue could never reach zero. Only the loser is resolved here: a survivor
    // with other live candidates stays flagged, which is correct for a group of three.
    const resolved = new Set<Id<'waterBodies'>>([loserId]);
    for (const id of new Set([survivorId, ...(loser.duplicateCandidateIds ?? [])])) {
      if (id === loserId) continue;
      const partner = await ctx.db.get(id);
      if (partner) await clearDuplicateFlag(ctx, partner, resolved);
    }
    await syncWaterBodyCells(ctx, loserId, {
      bbox: loser.bbox,
      minVisibleZoom: zoomSortKey(loser),
      listed: isListed({ ...loser, dedupStatus: 'merged' }),
    });
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'merge_waterbody',
      targetType: 'waterbody',
      targetId: loserId,
      reason: reason?.trim() || `Merged into ${survivor.name}`,
      metadata: { survivorId, repointed },
      createdAt: Date.now(),
    });
    // The loser's reports and hazards now belong to the survivor, so their sub-area stamps have to be
    // recomputed against the survivor's bays — the old stamps were resolved against a different set.
    await scheduleRestamp(ctx, survivorId);
    // And so does the survivor's cross-season recurrence (N5c / §C4): it just gained a winter's worth
    // of sightings that were clustered against a different lake, and the loser's stored clusters would
    // otherwise sit ranked in the operator queue on a tombstoned body, linking nowhere. Scheduled
    // rather than run inline — the merge is already a fan-out over every body-keyed child, and one
    // more full pass inside it is the transaction size nobody wants to debug.
    await ctx.scheduler.runAfter(0, internal.recurrence.enqueueBody, { waterBodyId: survivorId });
    await ctx.scheduler.runAfter(0, internal.recurrence.enqueueBody, { waterBodyId: loserId });
    return survivorId;
  },
});

/**
 * Public: a single water body for its detail view (D47). **Follows `mergedIntoId` to the survivor**
 * (D36) so a deep link to a merged duplicate lands on the canonical body. Returns a discriminated
 * result so the UI can tell apart the three cases:
 *  - `null` — no such body (or a merge chain into a deleted survivor);
 *  - `{ available: false }` — it exists but is unlisted (removed/rejected), so a friendly
 *    "not available" state shows instead of a blank (vs. the `null` not-found);
 *  - `{ available: true, body }` — a listed body to render.
 */
export const get = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    let body = await ctx.db.get(waterBodyId);
    // Resolve the merge chain to the survivor; bounded hops guard a pathological cycle (D36).
    for (let hops = 0; body?.mergedIntoId !== undefined && hops < 8; hops++) {
      body = await ctx.db.get(body.mergedIntoId);
    }
    if (!body) return null;
    if (!isListed(body)) return { available: false as const };
    return { available: true as const, body };
  },
});

/**
 * Moderator: set a body's `curatedBoost` (D49), recompute `displayScore` + `minVisibleZoom`, re-insert
 * its cell rows so the new zoom prominence takes effect, and write a `moderationActions` row.
 * (D37, refined 2026-07-23: curation is a moderator content lever, not admin-only.)
 */
export const setCuratedBoost = mutation({
  args: { waterBodyId: v.id('waterBodies'), curatedBoost: v.number() },
  handler: async (ctx, { waterBodyId, curatedBoost }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const body = await ctx.db.get(waterBodyId);
    if (!body) throw new ConvexError('Water body not found');

    const scores = scoreFields({ surfaceAreaSqM: body.surfaceAreaSqM, curatedBoost });
    await ctx.db.patch(waterBodyId, { curatedBoost, ...scores });
    // Restamp the cell rows with the new `minVisibleZoom` — it's part of `by_cell`'s range, so a
    // boost that didn't move the body still has to move its rows, or it draws at the old zoom (N1).
    await syncWaterBodyCells(ctx, waterBodyId, {
      bbox: body.bbox,
      minVisibleZoom: scores.minVisibleZoom,
      listed: isListed(body),
    });
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'set_curated_boost',
      targetType: 'waterbody',
      targetId: waterBodyId,
      reason: `Set curatedBoost to ${curatedBoost}`,
      metadata: { curatedBoost, minVisibleZoom: scores.minVisibleZoom },
      createdAt: Date.now(),
    });
    return waterBodyId;
  },
});

/**
 * Moderator: set a body's weather **sample points** (D56 §5) — the writer the schema field and
 * `lib/sampling.ts` have been waiting for since Phase 10 shipped them with no mutation at all.
 *
 * Weather doesn't vary below Open-Meteo's grid, so every body samples at its centroid by default and
 * only the genuinely multi-cell giants need more — Champlain is ~200 km end to end, and one sample
 * at its middle says nothing useful about the ice at either end. The suggestion grid is computed
 * client-side in the lake editor from the polygon it already has (`@skating/core`'s
 * `suggestSamplePoints`); this is the trust boundary that decides what gets stored.
 *
 * **Every point is validated to lie on the water, and that is the whole safety argument.** A point on
 * land returns a real forecast for the wrong surface — the one way this feature can silently produce
 * a wrong answer rather than no answer, which is exactly the failure mode the app spends its effort
 * avoiding. An empty array clears back to the centroid default.
 */
export const setWeatherSamplePoints = mutation({
  args: { waterBodyId: v.id('waterBodies'), points: v.array(latLng) },
  handler: async (ctx, { waterBodyId, points }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const body = await ctx.db.get(waterBodyId);
    if (!body) throw new ConvexError('Water body not found');
    if (points.length > MAX_SUGGESTED_SAMPLE_POINTS) {
      throw new ConvexError(
        `A body can carry at most ${MAX_SUGGESTED_SAMPLE_POINTS} sample points — each one is a forecast fetch and a cache row.`,
      );
    }

    const polygon = body.polygon as unknown as Polygon | MultiPolygon;
    const offWater = points.findIndex((point) => !pointInPolygon(point, polygon));
    if (offWater >= 0) {
      const bad = points[offWater];
      throw new ConvexError(
        `Sample point ${offWater + 1} (${bad?.lat.toFixed(4)}, ${bad?.lng.toFixed(4)}) isn't on ${body.name}. A point on land returns a real forecast for the wrong surface.`,
      );
    }

    // Empty clears the field rather than storing `[]`, so `nearestSamplePoint`'s "absent ⇒ centroid"
    // default is the one code path for "this body doesn't need a grid".
    await ctx.db.patch(waterBodyId, {
      weatherSamplePoints: points.length > 0 ? points : undefined,
    });
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'set_weather_sample_points',
      targetType: 'waterbody',
      targetId: waterBodyId,
      reason:
        points.length > 0
          ? `Set ${points.length} weather sample point${points.length === 1 ? '' : 's'}`
          : 'Cleared weather sample points (back to the centroid default)',
      metadata: { count: points.length },
      createdAt: Date.now(),
    });
    return waterBodyId;
  },
});

/**
 * Moderator: type in a body's depth — rung 1 of the D68 ladder (N6a).
 *
 * This is the path for a state-agency survey read off a chart (NH Fish & Game, VT ANR) or firsthand local
 * knowledge, and it **outranks every automated source**: the depth ETL refuses to overwrite an
 * `operator`-sourced value, so a correction here is durable across re-imports and re-runs.
 *
 * **Each measurement is three-state, and that is the whole design of this mutation** (review fix,
 * 2026-07-31). A field the moderator did not touch must arrive as `undefined` and be left *exactly* as it
 * was, rung included. The first cut took a plain `v.number()` per field and stamped `operator` on
 * everything it received — so a form that pre-filled a HydroLAKES mean and saved a max the moderator did
 * know relabelled a 90 m-DEM estimate as a survey reading: the public caption lost its `~`, and the value
 * became permanently immune to ETL correction. Provenance you can launder by accident is not provenance.
 *
 *  - **absent** — leave the measurement and its rung untouched, whatever they are.
 *  - **a number** — the moderator's own reading. Stored at rung `operator`.
 *  - **`null`** — an explicit *rejection*: the number goes, the `operator` rung **stays** as a tombstone,
 *    and `winsLadder` therefore refuses to let any import refill it. "A human looked at HydroLAKES' 14 m
 *    and says it is wrong" is a durable claim about the lake, and it has to outlive the next ETL run or
 *    it isn't worth making. Reversible via `clearDepthOverride`, which drops the tombstone and lets the
 *    import back in.
 *
 * The invariant this replaces — *never provenance without a number* — was protecting the caption, not the
 * row, and it still holds where it matters: `describeLakeDepth` renders nothing without a number, so a
 * tombstone is invisible to skaters and legible to the ladder, which is exactly the split we want.
 *
 * `sourceNote` is the **evidence** behind the claim (D68 amendment, founder call) and it is **public** —
 * it replaces the `operator` rung's own label in the skater-facing caption, because "entered by a
 * moderator" is attribution in name only. Optional rather than required: a moderator who simply knows the
 * pond has nothing to cite, and forcing the field would only produce "local knowledge" typed by rote —
 * whereas an absent note falls back to the honest "entered by a moderator", which correctly says we don't
 * know where the number came from. `null` clears it; absent leaves it alone, like the depths.
 */
export const setDepth = mutation({
  args: {
    waterBodyId: v.id('waterBodies'),
    meanDepthM: v.optional(v.union(v.number(), v.null())),
    maxDepthM: v.optional(v.union(v.number(), v.null())),
    sourceNote: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { waterBodyId, meanDepthM, maxDepthM, sourceNote }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const body = await ctx.db.get(waterBodyId);
    if (!body) throw new ConvexError('Water body not found');

    for (const [label, value] of [
      ['Mean', meanDepthM],
      ['Max', maxDepthM],
    ] as const) {
      if (value === undefined || value === null) continue;
      if (!Number.isFinite(value) || value <= 0) {
        throw new ConvexError(`${label} depth must be a positive number of metres.`);
      }
      if (value > MAX_PLAUSIBLE_DEPTH_M) {
        throw new ConvexError(
          `${label} depth of ${value} m is deeper than any lake in the region (Seneca, the deepest, is ~188 m) — if you're reading a chart in feet, divide by 3.28.`,
        );
      }
    }

    // The resulting pair, which is what the cross-field check has to run against: an untouched field
    // keeps whatever the row already held, so "mean 30 typed against an existing max of 6" is caught
    // just as a single save of both would be.
    const nextMean = meanDepthM === undefined ? body.meanDepthM : (meanDepthM ?? undefined);
    const nextMax = maxDepthM === undefined ? body.maxDepthM : (maxDepthM ?? undefined);
    // The one cross-field check worth making: a mean deeper than the max is a transposition, and it
    // would flip `isShallowDepth` (which prefers the mean) to the wrong answer on a real lake.
    if (nextMean !== undefined && nextMax !== undefined && nextMean > nextMax) {
      throw new ConvexError(
        `Mean depth (${nextMean} m) can't exceed max depth (${nextMax} m) — the two look transposed.`,
      );
    }

    const trimmedNote = sourceNote === null ? null : sourceNote?.trim();
    if (typeof trimmedNote === 'string' && trimmedNote.length > MAX_DEPTH_NOTE_LENGTH) {
      throw new ConvexError(
        `Source note is ${trimmedNote.length} characters; keep it under ${MAX_DEPTH_NOTE_LENGTH} — it renders inline on the lake, so it wants to be a citation, not a paragraph.`,
      );
    }

    const patch: Partial<Doc<'waterBodies'>> = {};
    if (meanDepthM !== undefined) {
      patch.meanDepthM = meanDepthM ?? undefined;
      patch.meanDepthSource = 'operator'; // number ⇒ the reading; null ⇒ the tombstone
    }
    if (maxDepthM !== undefined) {
      patch.maxDepthM = maxDepthM ?? undefined;
      patch.maxDepthSource = 'operator';
    }

    // A note can never outlive the claim it substantiates: once no operator *number* remains, it goes.
    // Otherwise a body would keep asserting "NH Fish & Game, 1998" beside numbers from a global model.
    const nextMeanSource = patch.meanDepthSource ?? body.meanDepthSource;
    const nextMaxSource = patch.maxDepthSource ?? body.maxDepthSource;
    const hasOperatorNumber =
      (nextMean !== undefined && nextMeanSource === 'operator') ||
      (nextMax !== undefined && nextMaxSource === 'operator');
    const nextNote = !hasOperatorNumber
      ? undefined
      : trimmedNote === undefined
        ? body.depthSourceNote
        : trimmedNote || undefined;
    if (nextNote !== body.depthSourceNote) patch.depthSourceNote = nextNote;

    if (Object.keys(patch).length === 0) return waterBodyId; // a save that touched nothing

    await ctx.db.patch(waterBodyId, patch);
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'set_lake_depth',
      targetType: 'waterbody',
      targetId: waterBodyId,
      reason: describeDepthChange(meanDepthM, maxDepthM, nextNote),
      // Before *and* after. The audit row is the only place a prior value survives a patch, so a log
      // that records just the new number can answer "who changed this" and never "changed it from what".
      metadata: {
        meanDepthM: nextMean,
        maxDepthM: nextMax,
        prev: {
          meanDepthM: body.meanDepthM,
          meanDepthSource: body.meanDepthSource,
          maxDepthM: body.maxDepthM,
          maxDepthSource: body.maxDepthSource,
          depthSourceNote: body.depthSourceNote,
        },
      },
      createdAt: Date.now(),
    });
    return waterBodyId;
  },
});

/**
 * Moderator: drop an `operator` rung entirely, handing the measurement back to the import (N6a).
 *
 * The counterpart to `setDepth`'s tombstone, and the reason a rejection is safe to make: rung 1 is
 * durable *by design*, so without a release there would be no way back short of a database edit. Clears
 * the value **and** its source for the named measurements, so the next ETL run fills them normally.
 *
 * Only ever touches `operator`-sourced measurements — asking to release a HydroLAKES value is a no-op
 * rather than an error, since the thing being released is the override, not the number.
 */
export const clearDepthOverride = mutation({
  args: {
    waterBodyId: v.id('waterBodies'),
    measurements: v.array(literals(['mean', 'max'] as const)),
  },
  handler: async (ctx, { waterBodyId, measurements }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const body = await ctx.db.get(waterBodyId);
    if (!body) throw new ConvexError('Water body not found');

    const patch: Partial<Doc<'waterBodies'>> = {};
    const released: string[] = [];
    if (measurements.includes('mean') && body.meanDepthSource === 'operator') {
      patch.meanDepthM = undefined;
      patch.meanDepthSource = undefined;
      released.push('mean');
    }
    if (measurements.includes('max') && body.maxDepthSource === 'operator') {
      patch.maxDepthM = undefined;
      patch.maxDepthSource = undefined;
      released.push('max');
    }
    if (released.length === 0) return waterBodyId;
    // Nothing operator-sourced is left to cite, so the citation goes with it.
    patch.depthSourceNote = undefined;

    await ctx.db.patch(waterBodyId, patch);
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'set_lake_depth',
      targetType: 'waterbody',
      targetId: waterBodyId,
      reason: `Released the operator override on ${released.join(' and ')} depth — the import may refill it`,
      metadata: {
        released,
        prev: {
          meanDepthM: body.meanDepthM,
          meanDepthSource: body.meanDepthSource,
          maxDepthM: body.maxDepthM,
          maxDepthSource: body.maxDepthSource,
          depthSourceNote: body.depthSourceNote,
        },
      },
      createdAt: Date.now(),
    });
    return waterBodyId;
  },
});

/** A citation, not a paragraph — it renders inline under the depth on the lake drawer. */
const MAX_DEPTH_NOTE_LENGTH = 160;

function describeDepthChange(
  meanDepthM: number | null | undefined,
  maxDepthM: number | null | undefined,
  sourceNote?: string,
): string {
  const parts: string[] = [];
  const describe = (label: string, value: number | null | undefined) => {
    if (value === undefined) return; // untouched — saying nothing about it is the honest log line
    parts.push(value === null ? `rejected the ${label} depth` : `${label} ${value} m`);
  };
  describe('mean', meanDepthM);
  describe('max', maxDepthM);
  if (parts.length === 0) return 'Cleared depth';
  // The note goes in the audit reason as well as on the row: the moderation log is where you look to ask
  // "who claimed this and on what basis", and a reason that omits the basis makes you go and diff the row.
  return `Set depth: ${parts.join(', ')}${sourceNote ? ` (${sourceNote})` : ''}`;
}

/**
 * Idempotently stamp depths from the N6a ETL, honoring the D68 ladder (internal, never client-callable).
 *
 * Two rules the loader enforces rather than trusting its input for:
 *  - **an `operator` value is never overwritten.** A moderator typed a survey in; a re-run of a global
 *    modelled join must not quietly undo that. This is the durability half of D68's top rung.
 *  - **a worse rung never displaces a better one**, per measurement. So the pipeline can be re-run with
 *    sources in any order, or with one source added later, and converges on the same answer — the same
 *    property `importCanonical` has and for the same reason (these runs get interrupted and resumed).
 */
export const importDepths = internalMutation({
  args: {
    depths: v.array(
      v.object({
        source: literals(WATER_BODY_SOURCES),
        externalId: v.string(),
        meanDepthM: v.optional(v.number()),
        meanDepthSource: v.optional(literals(DEPTH_SOURCES)),
        maxDepthM: v.optional(v.number()),
        maxDepthSource: v.optional(literals(DEPTH_SOURCES)),
      }),
    ),
  },
  handler: async (ctx, { depths }) => {
    let updated = 0;
    let unmatched = 0;
    let skipped = 0;
    let operatorHeld = 0;
    let inverted = 0;
    const rejects: { key: string; reason: string }[] = [];
    for (const item of depths) {
      const body = await ctx.db
        .query('waterBodies')
        .withIndex('by_external_id', (q) =>
          q.eq('source', item.source).eq('externalId', item.externalId),
        )
        .unique();
      if (!body) {
        unmatched++;
        continue;
      }
      const outcome = await applyDepthLadder(ctx, body, item);
      if (outcome.changed) updated++;
      else skipped++;
      if (outcome.operatorHeld) {
        operatorHeld++;
        rejects.push({
          key: item.externalId,
          reason: `a moderator owns this depth on "${body.name}" — released via the lake editor`,
        });
      }
      for (const bad of outcome.rejectedValues) {
        rejects.push({ key: item.externalId, reason: `implausible depth (${bad} m), not stored` });
      }
      for (const clash of outcome.inversions) {
        inverted++;
        rejects.push({ key: item.externalId, reason: `contradictory pair on ${clash}` });
      }
    }
    return { updated, unmatched, skipped, operatorHeld, inverted, rejects };
  },
});

/** An offered depth pair with its provenance, as either depth entry point hands it to the ladder. */
interface OfferedDepths {
  meanDepthM?: number;
  meanDepthSource?: DepthSource;
  maxDepthM?: number;
  maxDepthSource?: DepthSource;
}

/** What the ladder did with one body's offer — enough for the loader to itemize its run. */
interface LadderOutcome {
  changed: boolean;
  /** A measurement an operator owns (a reading *or* a rejection) refused this offer. */
  operatorHeld: boolean;
  /** An offered number that wasn't a plausible depth, per measurement, with the value that failed. */
  rejectedValues: string[];
  /** A mean-over-max contradiction the ladder resolved, described for the run log. */
  inversions: string[];
}

/**
 * Apply the D68 ladder to one body. **The single place the ladder is enforced** — both depth entry
 * points (`by_external_id` and the spatial match) go through here, so "an operator value is never
 * overwritten" is one rule in one function rather than a convention two mutations each have to remember.
 *
 * It is also where an offered *number* is sanity-checked, for the same reason (review fix, 2026-07-31).
 * The transform drops non-positive values and the `-9999` sentinel, but the transform is not the write
 * boundary and a third-party column with a different fill value (`-999`, `9999`) is a version bump away.
 * `setDepth` has refused implausible depths since day one; the automated path had nothing, which put the
 * weaker guard on the input nobody reads before it lands.
 *
 * **And it is where the pair is kept consistent** (Greptile, PR #33). The ladder resolves each
 * measurement independently — that is D68 working as designed, since mean and max routinely come from
 * different rungs — but *independently resolved* is not the same as *jointly valid*. Two sources that
 * matched slightly different lakes, or two models that disagree, can each win their own slot and leave
 * `mean 30 m` beside `max 6 m`: impossible for one basin, displayed to skaters as fact, and worse than
 * cosmetic because `isShallowDepth` prefers the mean, so the contradicted number is the one that decides
 * the safety classification. See `resolveInversion`.
 */
async function applyDepthLadder(
  ctx: MutationCtx,
  body: Doc<'waterBodies'>,
  offered: OfferedDepths,
): Promise<LadderOutcome> {
  const patch: Partial<Doc<'waterBodies'>> = {};
  const rejectedValues: string[] = [];
  const inversions: string[] = [];
  let operatorHeld = false;

  const consider = (
    label: 'mean' | 'max',
    value: number | undefined,
    source: DepthSource | undefined,
    existing: DepthSource | undefined,
  ): { valueM: number; source: DepthSource } | undefined => {
    if (value === undefined || source === undefined) return undefined;
    if (!winsLadder(source, existing)) {
      if (existing === 'operator') operatorHeld = true;
      return undefined;
    }
    if (!Number.isFinite(value) || value <= 0 || value > MAX_PLAUSIBLE_DEPTH_M) {
      rejectedValues.push(`${label} ${value}`);
      return undefined;
    }
    return { valueM: value, source };
  };

  const mean = consider('mean', offered.meanDepthM, offered.meanDepthSource, body.meanDepthSource);
  if (mean) {
    patch.meanDepthM = mean.valueM;
    patch.meanDepthSource = mean.source;
  }
  const max = consider('max', offered.maxDepthM, offered.maxDepthSource, body.maxDepthSource);
  if (max) {
    patch.maxDepthM = max.valueM;
    patch.maxDepthSource = max.source;
  }

  // The pair this write would leave behind, incumbents included — an inversion is just as reachable by
  // one measurement landing beside an older one as by a record carrying both.
  const drop = resolveInversion(
    { applied: mean, storedM: body.meanDepthM, storedSource: body.meanDepthSource },
    { applied: max, storedM: body.maxDepthM, storedSource: body.maxDepthSource },
    body.name,
    inversions,
  );
  // Dropping is the same write whether the loser arrived in this offer or was already stored: clear the
  // value *and* its rung. For an incumbent that is a retraction rather than a refusal — deliberate,
  // since leaving it keeps an impossible pair on display and in the classifier, and clearing the rung
  // lets a later run refill it once the sources agree. `winsLadder` guarantees it is never an operator's.
  if (drop === 'mean') {
    patch.meanDepthM = undefined;
    patch.meanDepthSource = undefined;
  } else if (drop === 'max') {
    patch.maxDepthM = undefined;
    patch.maxDepthSource = undefined;
  }

  if (Object.keys(patch).length === 0) {
    return { changed: false, operatorHeld, rejectedValues, inversions };
  }
  await ctx.db.patch(body._id, patch);
  return { changed: true, operatorHeld, rejectedValues, inversions };
}

/** One measurement as the pair check sees it: what would be written, or what is already there. */
interface PairSide {
  applied?: { valueM: number; source: DepthSource };
  storedM?: number;
  storedSource?: DepthSource;
}

/**
 * Decide which half of a contradictory depth pair to drop, or `null` when the pair is fine.
 *
 * A mean can never exceed a max **in one basin**, so an inverted pair is not a rounding disagreement —
 * it is proof that one of the two numbers describes something else: a different lake the geometric join
 * landed on, or a model whose shoreline differs enough to change the answer. One of them is wrong and we
 * cannot tell which from the numbers alone, so the ladder decides it the way it decides everything else.
 *
 * **The better-ranked measurement wins**, because that is what the ladder means: a measured LAGOS-US max
 * beats a modelled HydroLAKES mean that contradicts it, in either direction of arrival. When the loser is
 * an incumbent it is *retracted* — deliberately, since leaving it would keep the impossible pair on
 * display and feeding the classifier, and clearing its rung lets a later run refill it once the sources
 * agree. An `operator` value can never be the loser: `winsLadder` has already refused any offer that
 * would contradict one.
 *
 * **On a tie the mean goes**, which is the conservative half of the choice rather than an arbitrary one.
 * The mean *wins* the shallow classification when present (`isShallowDepth`), so dropping it routes the
 * body through the generous `SHALLOW_MAX_DEPTH_M` fallback instead — the direction that keeps a shallow
 * lake classified shallow when we are least sure (D69's asymmetry: a false positive makes a warning
 * linger, a false negative loses the signal outright).
 */
function resolveInversion(
  meanSide: PairSide,
  maxSide: PairSide,
  bodyName: string,
  inversions: string[],
): 'mean' | 'max' | null {
  const resolve = (side: PairSide) =>
    side.applied ??
    (side.storedM !== undefined ? { valueM: side.storedM, source: side.storedSource } : undefined);
  const nextMean = resolve(meanSide);
  const nextMax = resolve(maxSide);
  if (!nextMean || !nextMax || nextMean.valueM <= nextMax.valueM) return null;

  // A measurement carrying no source at all ranks worst — it has nothing to argue with.
  const rank = (source?: DepthSource) =>
    source === undefined ? Number.MAX_SAFE_INTEGER : DEPTH_SOURCE_RANK[source];
  const dropped = rank(nextMean.source) < rank(nextMax.source) ? 'max' : 'mean';
  inversions.push(
    `"${bodyName}": mean ${nextMean.valueM} m (${nextMean.source ?? 'no source'}) exceeds max ` +
      `${nextMax.valueM} m (${nextMax.source ?? 'no source'}) — dropped the ${dropped}`,
  );
  return dropped;
}

/**
 * Whether an incoming source may replace the one already stored. A better *or equal* rank wins, so
 * re-running the same source with a corrected value updates rather than silently no-ops — which is the
 * behavior you want when a source republishes, and the reason this isn't a strict `<`.
 *
 * An `operator` rung blocks every import **whether or not it carries a number**: a measurement cleared
 * through `setDepth` keeps its rung as a tombstone, which is how "a human read HydroLAKES' 14 m and says
 * it's wrong" survives the next run. `clearDepthOverride` is the way back.
 */
function winsLadder(incoming: DepthSource, existing?: DepthSource): boolean {
  if (existing === undefined) return true;
  if (existing === 'operator') return incoming === 'operator';
  return DEPTH_SOURCE_RANK[incoming] <= DEPTH_SOURCE_RANK[existing];
}

/**
 * How far apart two areas may be and still be believed to describe the same lake. HydroLAKES, LAGOS-US
 * and OSM each draw a shoreline from a different water mask at a different date, so exact agreement is
 * not on offer — but an order-of-magnitude disagreement means the point landed on the wrong body, which
 * is the one failure mode of a spatial join that produces a *wrong* answer instead of no answer. 4× is
 * deliberately loose: a false reject costs one lake its depth, a false accept stamps a 40 m lake's
 * depth onto the pond next door and quietly tells the decay model that pond is deep.
 */
const DEPTH_MATCH_AREA_RATIO = 4;

/**
 * How far outside our shoreline a *survey's* representative point may fall and still be that lake.
 *
 * Zero for a single depth reading (`matchAndImportDepths`), and deliberately not zero here. The two
 * differ in what is being placed. A reading is a point and could genuinely belong to the pond across
 * the road, so it must land inside. A survey's representative point is its **deepest** measurement —
 * the furthest point in the lake from any shore — so a point that lands 9 m outside our polygon is
 * never the pond next door; it is two agencies drawing the same shoreline from different imagery on
 * different dates.
 *
 * Measured, not guessed: of 54 lakes the zero buffer rejected, 7 sit 0–9 m outside a polygon carrying
 * the same lake's name (Burncoat Park Pond at 0 m, Wat-Tuh Lake at 1 m, Middle Pond at 2 m). The next
 * band out begins at 126 m and is where wrong answers start — Goodwin Pond, 7 acres, reaching
 * Mooselookmeguntic Lake at 16,213. 25 m clears the first group with an order of magnitude to spare
 * and cannot reach the second.
 *
 * **This is only safe because the area gate above actually runs.** It did not, for the whole of the
 * first bathymetry build: the caller never sent `areaSqM`, so every ratio test was skipped and a
 * buffer would have had nothing behind it. Do not widen this without checking that gate is live.
 */
const BATHYMETRY_APPROACH_M = 25;

/**
 * The catalogue-identity fields an import can assert, from the row it is importing.
 *
 * Only ever what the *importer* knows: an OSM import knows the lake's OSM id and that it drew OSM's
 * polygon, and knows nothing about NHD. `nhdId` is written by reconciliation, never by import —
 * keeping it out of here is what stops a re-import erasing it.
 */
/**
 * The identity fields an incoming record carries, **taken from the payload rather than derived**
 * (N7 / D93).
 *
 * This used to infer `osmId` from `source === 'osm' && externalId`, which is `externalId` doing the
 * identity job all over again — the exact conflation D93 exists to undo. A merged record knows all
 * three of its catalogue ids because the merge worked them out; the import's job is to write them
 * down, not to guess one of them back from where the row happened to arrive.
 *
 * **On insert every field is written; on patch, only the ones the record actually asserts** — see
 * `assertedCatalogueIds`. The asymmetry is deliberate and it is a safety property, not tidiness.
 *
 * ⚠ **`geometrySource` falls back to `source`, never to nothing.** The schema says absent means "the
 * same as `source`", so leaving it undefined is technically correct and practically a trap: a later
 * reader has to know that rule to interpret the column, and D92's whole point is that the two can
 * diverge. Write it down.
 */
/**
 * Derive `osmId` / `nhdId` / `geometrySource` from `source` + `externalId` — **for the backfill of
 * legacy rows only.**
 *
 * This is the rule `catalogueIds` used to apply to every import, and it is exactly the conflation
 * D93 exists to undo — so it is deliberately *not* shared with the import path any more. It survives
 * because a row written before the identity fields existed genuinely has nowhere else to get them
 * from: `source: 'osm'` plus an `externalId` that is an OSM id is real evidence, just weaker than an
 * assertion from the merge.
 *
 * ⚠ **Do not call this from `importCanonical`.** An incoming record states its own identity; guessing
 * one back from where the row happened to arrive is how `externalId` ended up doing three jobs.
 */
function deriveCatalogueIds(item: { source: string; externalId?: string }): {
  osmId?: string;
  nhdId?: string;
  geometrySource?: 'osm' | 'nhd' | '3dhp' | 'user';
} {
  if (item.source === 'osm' && item.externalId) {
    return { osmId: item.externalId, geometrySource: 'osm' };
  }
  if (item.source === 'nhd' && item.externalId) {
    return { nhdId: item.externalId, geometrySource: 'nhd' };
  }
  return {};
}

interface IncomingIds {
  source: string;
  externalId?: string;
  osmId?: string;
  nhdId?: string;
  threeDhpId?: string;
  gnisId?: string;
  geometrySource?: (typeof GEOMETRY_SOURCES)[number];
}

function catalogueIds(item: IncomingIds) {
  return {
    osmId: item.osmId,
    nhdId: item.nhdId,
    threeDhpId: item.threeDhpId,
    gnisId: item.gnisId,
    geometrySource:
      item.geometrySource ?? (item.source as (typeof GEOMETRY_SOURCES)[number] | undefined),
  };
}

/**
 * The same ids, **with the absent ones omitted rather than set to `undefined`** — the update path.
 *
 * ## Why a re-import may not clear an id it does not mention
 *
 * The obvious rule is "the incoming record is authoritative, write all of it", and it is wrong here
 * in a way that is expensive exactly once. The merge resolves all three ids before emitting, so a
 * *complete* record asserting no `nhdId` really does mean "this lake has no NHD counterpart" — but
 * nothing in this mutation can tell a complete record from a partial one. Load a single state's OSM
 * lane by itself, or an older export, and an overwriting rule silently wipes every reconciliation in
 * the corpus. That is 18,383 rows of geometric work, destroyed by a load that reported success.
 *
 * So: **an id present is an assertion and overwrites; an id absent is silence and changes nothing.**
 * A wrong `nhdId` is corrected by the next merge that asserts a different one, which is the case that
 * actually happens. Withdrawing an id entirely — asserting that a match was wrong and has no
 * replacement — is rare, consequential, and deliberately not something an import can do in passing;
 * it is a moderator action, and `reconcileAudit` is where it would be found.
 *
 * `geometrySource` follows the same rule for the same reason: D92's per-lake override is a decision
 * someone made, and an import that has no opinion about geometry must not erase one that does.
 */
function assertedCatalogueIds(item: IncomingIds): Record<string, string> {
  const all = catalogueIds(item);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * How much of a survey a body must hold to be called the lake that was surveyed.
 *
 * A half, and the half is doing real work in both directions. **Not higher**, because our shoreline
 * and the agency's disagree at the edges — near-shore soundings routinely fall outside our polygon,
 * and an OSM outline that under-draws a lake would fail a 0.8 test while being the right lake.
 * **Not lower**, because a bay holds a few percent of its lake's survey and must lose to the lake;
 * anything under a half means most of what was measured is somewhere else.
 *
 * It is a *fraction*, never a count, which is what makes it work on Maine's sparse surveys: a lake
 * with nine soundings and a lake with ninety thousand are judged the same way.
 */
const MIN_SURVEY_CONTAINMENT = 0.5;

/**
 * Spatially match a batch of source lakes to our bodies and stamp their depths (internal; the N6a ETL's
 * load stage). The global sources are keyed to their **own** lake ids — `Hylak_id`, `lagoslakeid` — so
 * there is no join key to our OSM corpus and the join has to be geometric.
 *
 * The match runs **here rather than in the ETL** because the spatial index lives here: resolving ~8k
 * source lakes against the cell index costs ~8k small indexed lookups, where doing it locally would
 * mean exporting all 116,070 bodies with their polygons first. It reuses `listedBodiesNearCoord` — the
 * degenerate one-box viewport read N1 built for coord→lake resolution — so the depth join and the "you
 * are at Lake X" hint agree by construction about which body a point is on.
 *
 * **Every rejection is counted and named**, because an ETL that silently matches 60% of its input looks
 * exactly like one that matched all of it.
 */
export const matchAndImportDepths = internalMutation({
  args: {
    lakes: v.array(
      v.object({
        // The source's own id, echoed back in the per-lake outcome so a run can be diffed/resumed.
        key: v.string(),
        point: latLng,
        areaSqM: v.optional(v.number()),
        meanDepthM: v.optional(v.number()),
        meanDepthSource: v.optional(literals(DEPTH_SOURCES)),
        maxDepthM: v.optional(v.number()),
        maxDepthSource: v.optional(literals(DEPTH_SOURCES)),
        /** HydroLAKES' own shoreline in metres — D85's cross-check. Compared, logged, never stored. */
        shorelineM: v.optional(v.number()),
        /** The source's own name, corroboration for a proximity match only. Never stored. */
        name: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { lakes }) => {
    let updated = 0;
    let unmatched = 0;
    /** Matched by proximity rather than containment — a weaker claim, so it is counted apart. */
    let matchedByProximity = 0;
    /** A body was in range but nothing corroborated it. Distinct from "nothing here". */
    let proximityUnconfirmed = 0;
    let areaRejected = 0;
    let shorelineCompared = 0;
    let shorelineDisagreed = 0;
    let skipped = 0;
    let noAreaGate = 0;
    let operatorHeld = 0;
    let inverted = 0;
    const rejects: { key: string; reason: string }[] = [];

    for (const lake of lakes) {
      const byId = await listedBodiesNearCoord(ctx, lake.point);
      // Containment first, then a corroborated proximity fallback — see `matchDepthSource`, which
      // owns the rule and the reasoning. The zero-buffer rule this replaced was right about the
      // danger ("a point just off one shoreline claiming the body across the road") and wrong about
      // the cost: it lost 40% of the prominent bodies to source polygons drawn on a different date.
      // The fallback is held to a strictly tighter standard than containment, never a looser one.
      const match = matchDepthSource(
        { point: lake.point, areaSqM: lake.areaSqM, name: lake.name },
        [...byId.values()].map((b) => ({
          ref: b._id,
          polygon: b.polygon as unknown as Polygon | MultiPolygon,
          surfaceAreaSqM: b.surfaceAreaSqM ?? 0,
          name: b.name,
        })),
        { areaRatioLimit: DEPTH_MATCH_AREA_RATIO },
      );

      if (match.matched === null) {
        // Name the body we declined. A rejection an operator can act on says *which* lake it looked
        // at and how the two areas compared; a bare ratio is a number to squint at.
        const declined = match.nearest ? byId.get(match.nearest) : undefined;
        const named = declined
          ? ` with "${declined.name}": ${Math.round(declined.surfaceAreaSqM ?? 0)} m² vs ${Math.round(lake.areaSqM ?? 0)} m²`
          : '';
        if (match.reason === 'area_mismatch') {
          areaRejected++;
          rejects.push({
            key: lake.key,
            reason: `area mismatch${named} (${match.detail ?? ''})`,
          });
        } else if (match.reason === 'proximity_unconfirmed') {
          proximityUnconfirmed++;
          rejects.push({
            key: lake.key,
            reason: `body within range but unconfirmed${named} — ${match.detail ?? ''}`,
          });
        } else {
          unmatched++;
          rejects.push({ key: lake.key, reason: 'no listed body at or near this point' });
        }
        continue;
      }

      const body = byId.get(match.matched);
      if (!body) {
        unmatched++;
        rejects.push({ key: lake.key, reason: 'matched body vanished mid-batch' });
        continue;
      }
      if (match.method === 'proximity') matchedByProximity++;
      // Same accounting as before: an area gate that could not run is counted, never silent.
      if (match.areaRatio === undefined) noAreaGate++;

      // ── D85's free cross-check: HydroLAKES' Shore_len against our own shoreline ──────────────
      //
      // **Log the comparison; store ours.** HydroLAKES' polygon is a different water mask at a
      // different date and its own resolution, so a disagreement does not say who is right. What it
      // does say is whether our number is in the right neighbourhood — a 2× gap on a known lake
      // means the join or the ring handling is broken, and that is worth catching at load time
      // rather than in a screenshot.
      //
      // Only fires where both exist: HydroLAKES' 10 ha floor covers ~7% of the corpus, so a silent
      // absence here is the norm and not a finding.
      if (
        typeof body.shorelineM === 'number' &&
        body.shorelineM > 0 &&
        typeof lake.shorelineM === 'number' &&
        lake.shorelineM > 0
      ) {
        shorelineCompared++;
        const ratio = Math.max(
          body.shorelineM / lake.shorelineM,
          lake.shorelineM / body.shorelineM,
        );
        if (ratio > SHORELINE_CROSS_CHECK_RATIO) {
          shorelineDisagreed++;
          rejects.push({
            key: lake.key,
            reason:
              `shoreline cross-check on "${body.name}": ours ${Math.round(body.shorelineM / 1000)} km vs ` +
              `HydroLAKES ${Math.round(lake.shorelineM / 1000)} km (${ratio.toFixed(1)}×) — not stored, check the ring handling`,
          });
        }
      }

      const outcome = await applyDepthLadder(ctx, body, lake);
      if (outcome.changed) updated++;
      else skipped++;
      if (outcome.operatorHeld) {
        operatorHeld++;
        rejects.push({
          key: lake.key,
          reason: `a moderator owns this depth on "${body.name}" — released via the lake editor`,
        });
      }
      for (const bad of outcome.rejectedValues) {
        rejects.push({
          key: lake.key,
          reason: `implausible depth (${bad} m) for "${body.name}", not stored`,
        });
      }
      for (const clash of outcome.inversions) {
        inverted++;
        rejects.push({ key: lake.key, reason: `contradictory pair on ${clash}` });
      }
    }
    return {
      updated,
      unmatched,
      matchedByProximity,
      proximityUnconfirmed,
      shorelineCompared,
      shorelineDisagreed,
      areaRejected,
      skipped,
      noAreaGate,
      operatorHeld,
      inverted,
      rejects,
    };
  },
});

/**
 * Resolve a batch of source lakes to our bodies, for the N6b bathymetry ETL (internal; read-only).
 *
 * Sibling to `matchAndImportDepths` above, over the same corpus and the same candidate lookup — but
 * **not the same resolver**, and the difference is load-bearing rather than incidental.
 *
 * That function places a *reading*: one depth, one point, and the most specific body containing it is
 * the right answer, so it ranks smallest-area-first and uses a zero buffer. This one places a
 * *survey*: thousands of soundings describing a whole basin, where the most specific body containing
 * the deepest point is very often a **bay** of the lake that was actually surveyed. Ranking those the
 * same way put every acre of Moosehead Lake onto North Bay, 1.6% of the water the survey covers.
 *
 * So this ranks largest-first (`bodiesCoveringPoint`), bounds the answer by the survey's own footprint
 * rather than by an unsigned area disagreement, and returns the whole containment chain instead of a
 * winner — because a lake's isobaths belong to the lake *and* to the bays drawn inside it. Someone
 * skating the bay is skating the lake.
 *
 * What comes back also carries two things a depth stamp doesn't need:
 *
 * - **The body's `externalId`.** Contour tiles carry it per feature so the client can filter to the
 *   open lake (D81). It is the OSM id rather than the Convex `_id` on purpose: `_id` changes if a row
 *   is ever recreated, and re-tiling five states because a re-import churned ids is not a thing we
 *   should be one accident away from. `externalId` is what `importCanonical` upserts on, so it
 *   survives re-imports by construction.
 * - **The polygon.** The sounding lanes need the shoreline as a depth-0 boundary constraint (§Maine
 *   step 3), and the contour lanes need it to clip. Returning it here is what keeps the ETL from
 *   needing its own copy of the corpus.
 *
 * A **query**, not a mutation: this resolves, it doesn't write. The rung-1 depth write is a separate
 * call, so a run can inspect its own join before changing anything — which matters more than usual
 * here, because a bad join silently attributes one lake's basin to another.
 */
export const matchBathymetryLakes = internalQuery({
  args: {
    lakes: v.array(
      v.object({
        /** The source's own lake id (`au_id`, `PALIS_ID`, `MIDAS`, a VT lake name), echoed back. */
        key: v.string(),
        point: latLng,
        /**
         * A deterministic sample of the survey's own measurements — what the containment gate is
         * measured against. Optional only because the validator cannot require what an older caller
         * won't send; omitting it runs the join ungated, which the ETL counts and reports.
         */
        samplePoints: v.optional(v.array(latLng)),
      }),
    ),
    /** Omit the polygon when only the identity is wanted — a coverage count, say. */
    includePolygon: v.optional(v.boolean()),
  },
  handler: async (ctx, { lakes, includePolygon = true }) => {
    interface Resolved {
      waterBodyId: Id<'waterBodies'>;
      externalId?: string;
      source: string;
      name: string;
      surfaceAreaSqM?: number;
      states?: string[];
      polygon?: unknown;
    }
    const matches: Array<Resolved & { key: string; alsoCovers: Resolved[] }> = [];
    const rejects: { key: string; reason: string }[] = [];

    for (const lake of lakes) {
      const byId = await listedBodiesNearCoord(ctx, lake.point);
      // **Every** body covering the point, largest first — not the nearest one. See
      // `bodiesCoveringPoint`: a survey placed by smallest-area lands on a lake's bay instead of the
      // lake, and Moosehead Lake proved it by arriving as North Bay.
      const covering = bodiesCoveringPoint(
        lake.point,
        [...byId.values()].map((b) => ({
          ref: b._id,
          polygon: b.polygon as unknown as Polygon | MultiPolygon,
          surfaceAreaSqM: b.surfaceAreaSqM ?? 0,
        })),
        BATHYMETRY_APPROACH_M,
      );
      if (covering.length === 0) {
        rejects.push({
          key: lake.key,
          reason: `no listed body within ${BATHYMETRY_APPROACH_M} m of this point`,
        });
        continue;
      }

      // **Which of these bodies is the lake that was surveyed?** Answered by asking how much of the
      // survey each one actually holds — see `containedFraction` for why the area comparison this
      // replaces could not answer it, and cost 68 correct lakes when it tried.
      //
      // A survey that sent no sample disables the gate rather than failing it, exactly as a missing
      // `areaSqM` used to: unmeasurable is not evidence of a bad match. That path is a caller bug and
      // is counted by the ETL, not silently tolerated.
      const sample = lake.samplePoints ?? [];
      const scored = covering.map((hit) => ({
        ...hit,
        held:
          sample.length > 0 ? containedFraction(sample, byId.get(hit.ref)?.polygon as Polygon) : 1,
      }));
      // Most of the survey first; ties (including the no-sample case) fall back to the largest body,
      // which is the containment answer for a bay-vs-lake pair when we cannot measure it.
      scored.sort((a, b) => b.held - a.held || b.surfaceAreaSqM - a.surfaceAreaSqM);

      const eligible = scored.filter((h) => h.held >= MIN_SURVEY_CONTAINMENT);
      if (eligible.length === 0) {
        const best = scored[0];
        rejects.push({
          key: lake.key,
          reason:
            `no body here holds the survey: best is "${byId.get(best?.ref as Id<'waterBodies'>)?.name ?? '?'}" ` +
            `with ${((best?.held ?? 0) * 100).toFixed(0)}% of ${sample.length} sampled measurements ` +
            `(need ${MIN_SURVEY_CONTAINMENT * 100}%)`,
        });
        continue;
      }

      const resolve = (id: Id<'waterBodies'>): Resolved | undefined => {
        const body = byId.get(id);
        if (!body) return undefined;
        return {
          waterBodyId: body._id,
          externalId: body.externalId,
          source: body.source,
          name: body.name,
          surfaceAreaSqM: body.surfaceAreaSqM,
          states: body.states,
          ...(includePolygon ? { polygon: body.polygon } : {}),
        };
      };

      // The body holding most of the survey — the lake, not one of its bays.
      const primaryHit = eligible[0];
      const primary = primaryHit ? resolve(primaryHit.ref) : undefined;
      if (!primaryHit || !primary) {
        rejects.push({ key: lake.key, reason: 'body vanished between lookup and resolve' });
        continue;
      }

      // **The bays**, taken from the full chain rather than from `eligible`: a bay is by definition
      // far smaller than the lake that was surveyed, so the gate that picks the lake excludes exactly
      // the bodies we want here. What qualifies is being covered by the survey and nested inside the
      // body it resolved to — which is why this filters on the *primary's* area rather than its own.
      //
      // Same-size neighbours are included on purpose: two OSM polygons for one lake (a cross-border
      // duplicate, most often) are a real case, and both should draw rather than one of them
      // rendering flat beside the other.
      const alsoCovers = covering
        .filter((h) => h.ref !== primaryHit.ref && h.surfaceAreaSqM <= primaryHit.surfaceAreaSqM)
        .map((h) => resolve(h.ref))
        .filter((r): r is Resolved => r !== undefined);

      matches.push({ key: lake.key, ...primary, alsoCovers });
    }

    return { matches, rejects };
  },
});

/**
 * Internal seed (run via `pnpm exec convex run`, no auth) — the Phase 2.5 re-seed of the community
 * favorites list. For each `{ name, boost, state? }`: find *listed* bodies whose name matches
 * (search index, then exact case-insensitive), disambiguate a repeated name by the optional `state`
 * hint else the **largest-area** body (the one people mean — Lake George NY over the MA reservoir),
 * set `curatedBoost` + recompute `displayScore`/`minVisibleZoom` + re-index. Mirrors
 * `setCuratedBoost`'s core minus the admin auth + audit row — Phase 7 lifts per-body boost editing
 * into the admin UI with proper auditing. Returns what was boosted + names that matched nothing.
 */
export const applyCuratedBoostSeed = internalMutation({
  args: {
    seed: v.array(v.object({ name: v.string(), boost: v.number(), state: v.optional(v.string()) })),
  },
  handler: async (ctx, { seed }) => {
    const applied: Array<{
      name: string;
      id: Id<'waterBodies'>;
      states: string[];
      areaSqM: number;
      minVisibleZoom: number;
    }> = [];
    const notFound: string[] = [];
    for (const { name, boost, state } of seed) {
      const candidates = (
        await ctx.db
          .query('waterBodies')
          .withSearchIndex('search_name', (s) => s.search('name', name))
          .take(50)
      ).filter((b) => b.name.toLowerCase() === name.toLowerCase() && isListed(b));
      // A malformed `state` hint (typo, non-code) is ignored rather than silently matching nothing,
      // so it falls back to largest-area disambiguation instead of quietly picking the wrong body.
      const stateHint = state && isKnownStateCode(state) ? state : undefined;
      const target =
        (stateHint ? candidates.find((b) => b.states?.includes(stateHint)) : undefined) ??
        candidates.sort((a, b) => (b.surfaceAreaSqM ?? 0) - (a.surfaceAreaSqM ?? 0))[0];
      if (!target) {
        notFound.push(name);
        continue;
      }
      const scores = scoreFields({ surfaceAreaSqM: target.surfaceAreaSqM, curatedBoost: boost });
      await ctx.db.patch(target._id, { curatedBoost: boost, ...scores });
      await syncWaterBodyCells(ctx, target._id, {
        bbox: target.bbox,
        minVisibleZoom: scores.minVisibleZoom,
        listed: isListed(target),
      });
      applied.push({
        name,
        id: target._id,
        states: target.states ?? [],
        areaSqM: target.surfaceAreaSqM ?? 0,
        minVisibleZoom: scores.minVisibleZoom,
      });
    }
    return { applied, notFound };
  },
});

/**
 * The one place cell rows are read (N1) — shared by the viewport query and the coord resolver so a
 * change to the read shape can't land in one and miss the other (the old centroid path had exactly
 * that split, and the comment on it said so).
 *
 * **Two passes, because prominence is a global order.** Pass 1 walks the ladder rungs and the cells
 * covering the box, collecting candidate *rows* — cheap, since `minVisibleZoom` is denormalized onto
 * the cell row, so ranking costs no document read. Pass 2 sorts those candidates by prominence and
 * hydrates in that order until the render budget is full.
 *
 * Ranking *after* the scan is the load-bearing part. `by_cell` returns ascending `minVisibleZoom`
 * within one cell, but a viewport spans many cells: accepting bodies as the walk reached them meant
 * an early cell's least prominent ponds displaced a later cell's headline lake whenever the budget
 * bound, so which lakes the map showed depended on row-major cell order rather than on prominence
 * (Greptile PR #27). Sorting the whole candidate set first makes the answer traversal-independent —
 * the top-`limit` bodies by `minVisibleZoom`, wherever in the box they sit.
 *
 * **The walk itself lives in `lib/cellScan.ts`** (extracted in N2, when the sub-area layer needed the
 * same one over a second cell table): whole-rung admission, the fair-share row budget, and the
 * probe-one-past truncation flag are all stated there, each with the review correction it came from.
 * What stays here is what's specific to water bodies — which table, and how a candidate hydrates.
 *
 * The residual is honest and unavoidable: a hard row budget means a dense cell is read only to its
 * share's depth, so a body can be missed if its own cell holds more prominent bodies than that share.
 * Fixing that completely would mean reading every row, which is the unbounded scan this phase exists
 * to retire. Truncation is logged either way (D5).
 *
 * Every candidate is refined against the real bbox: a cell is coarser than the query box at all but
 * the finest rung, so "in this cell" is a superset of "in view", exactly as intended.
 *
 * `zoom` present ⇒ scan rungs up to that zoom and apply D49's cutoff as an index range (the map).
 * `zoom` absent ⇒ scan every rung with no cutoff (a containment lookup: the pond you are standing
 * on must be found however unprominent it is).
 */
async function bodiesCoveringBox(
  ctx: QueryCtx,
  box: { minLat: number; minLng: number; maxLat: number; maxLng: number },
  /**
   * `maxRows` overrides `CELL_ROW_SCAN_BUDGET` for one call. Only `viewportReadStats` passes it —
   * "what would this viewport do on a tighter row budget?" is the question you have to be able to
   * answer *before* changing the constant, and it's the only way to exercise the budget-bound
   * branches without seeding 1,500 cell rows. The public query never sets it.
   */
  opts: { zoom?: number; limit: number; maxRows?: number },
): Promise<{
  byId: Map<Id<'waterBodies'>, Doc<'waterBodies'>>;
  truncated: boolean;
  rowsRead: number;
  cellsScanned: number;
}> {
  const { zoom, limit } = opts;
  const scan = await scanCells<Id<'waterBodies'>>(
    box,
    WATER_BODY_LADDER,
    {
      maxCellsPerLevel: MAX_CELLS_PER_LEVEL,
      cellBudget: CELL_SCAN_BUDGET,
      rowBudget: Math.min(opts.maxRows ?? CELL_ROW_SCAN_BUDGET, CELL_ROW_SCAN_BUDGET),
      minRowsPerCell: MIN_ROWS_PER_CELL,
      limit,
    },
    { ...(zoom !== undefined ? { zoom } : {}), label: 'waterBodyCells' },
    async (cell, probe, atZoom) => {
      const rows = await ctx.db
        .query('waterBodyCells')
        .withIndex('by_cell', (q) => {
          const atCell = q.eq('z', cell.z).eq('x', cell.x).eq('y', cell.y);
          return atZoom === undefined ? atCell : atCell.lte('minVisibleZoom', atZoom);
        })
        .take(probe);
      return rows.map((row) => ({ ref: row.waterBodyId, minVisibleZoom: row.minVisibleZoom }));
    },
  );

  // Pass 2 — hydrate in global prominence order, so the render budget spends itself on the biggest
  // lakes in the box rather than on whichever cell the walk opened first.
  let truncated = scan.truncated;
  const byId = new Map<Id<'waterBodies'>, Doc<'waterBodies'>>();
  for (const waterBodyId of rankCandidates(scan.candidates)) {
    if (byId.size >= limit) {
      truncated = true;
      break;
    }
    const body = await ctx.db.get(waterBodyId);
    // `isListed` is defense-in-depth — an unlisted body has no cell rows to be found through in the
    // first place, which is what makes the listing filter free here.
    if (!body || !bboxIntersects(body.bbox, box) || !isListed(body)) continue;
    byId.set(body._id, body);
  }

  return { byId, truncated, rowsRead: scan.rowsRead, cellsScanned: scan.cellsScanned };
}

/**
 * Public: water bodies whose **bbox intersects** the viewport (D5/D48), served off the N1 ladder-grid
 * cell index. A body is indexed under every cell its bbox covers, at a level no finer than the zoom
 * it first draws at, so this query is exactly: *scan the cells covering the viewport, at every rung
 * up to the current zoom.* No margin, no large-body outlier list, no read-cap tuning — see
 * `plans/phase-N1-read-path-durability.md` for the two theorems and
 * `packages/core/src/spatialCells.ts` for the math.
 *
 * **Why the reads are bounded.** Every rung scanned is coarser than or equal to the viewport's own
 * zoom, so its cells are at least as large as the viewport and each rung contributes ~4 of them;
 * within a cell, `by_cell`'s trailing `minVisibleZoom` makes the D49 cutoff a *range on the index*,
 * so a wide zoom reads only the bodies it will actually draw. Both halves are geometry, not a tuned
 * constant — which is the entire point, after two crash fixes whose safety rested on numbers
 * measured against a corpus that then grew 11.6× (PR #10, #11).
 *
 * **Listing is free.** Unlisted bodies (removed / rejected / merged) have no cell rows at all, so
 * there is nothing to filter. The `isListed` check below is a cheap belt-and-braces re-read of the
 * hydrated row, not the load-bearing gate it used to be.
 *
 * **Zoom-scored prominence (D49).** `zoom` is **required**: the completeness guarantee is stated
 * against it (a body's index level is ≤ its `minVisibleZoom`), so a query with no zoom has no
 * bounded set of rungs to scan. Both clients have always passed it.
 */
export const listInViewport = query({
  args: { viewport: bbox, limit: v.optional(v.number()), zoom: v.number() },
  handler: async (ctx, { viewport, limit, zoom }) => {
    const effectiveLimit = sanitizeLimit(limit);
    // Floor to the integer bucket `minVisibleZoom` uses so a fractional zoom can't fall between
    // rungs. (Clients already floor via `zoomForViewport`; this is defense-in-depth.)
    const z = Math.floor(zoom);

    const { byId, truncated, rowsRead } = await bodiesCoveringBox(ctx, viewport, {
      zoom: z,
      limit: effectiveLimit,
    });
    if (truncated) {
      console.warn(
        `listInViewport stopped early at zoom ${z} with ${byId.size} bodies (render budget ${effectiveLimit}, ${rowsRead} cell rows read); the least prominent bodies were omitted (D5/D49/N1).`,
      );
    }

    // Favorites are pinned visible at **every zoom** (Phase 4 map highlight): a viewer's favorited body
    // that intersects the viewport is included even when its `minVisibleZoom` is above the current zoom,
    // so a small-but-beloved lake never drops out from under its highlight when you zoom out. Bounded by
    // a user's handful of favorites; follows merges to the survivor and honors the same `listed` gate.
    const viewer = await getCurrentProfile(ctx);
    if (viewer) {
      const favorites = await ctx.db
        .query('waterBodyFavorites')
        .withIndex('by_user', (q) => q.eq('userId', viewer._id))
        .collect();
      for (const fav of favorites) {
        let body = await ctx.db.get(fav.waterBodyId);
        for (let hops = 0; body?.mergedIntoId !== undefined && hops < 8; hops++) {
          body = await ctx.db.get(body.mergedIntoId);
        }
        if (!body || byId.has(body._id)) continue;
        if (isListed(body) && bboxIntersects(body.bbox, viewport)) byId.set(body._id, body);
      }
    }
    return [...byId.values()];
  },
});

/**
 * Internal: what one viewport read actually costs (N1). Same scan as `listInViewport`, returning the
 * counters instead of the bodies.
 *
 * This exists because the constants it measures were wrong for a year without anyone noticing — the
 * 256-row clamp was tuned live against a 9,967-body corpus and never revisited after that corpus grew
 * to 116k, and no test could catch it because `convex-test` doesn't model Convex's read cap. A claim
 * about read cost should be checkable against the real deployment:
 * `pnpm exec convex run waterBodies:viewportReadStats '{"viewport": {...}, "zoom": 12}'`.
 *
 * `maxRows` lowers the row budget for one call, and `names` returns *which* bodies survived rather
 * than how many. Together they answer the question you have to settle before touching
 * `CELL_ROW_SCAN_BUDGET`: when the budget binds, is what's left the most prominent bodies from
 * across the viewport, or everything from the corner the scan started in?
 */
export const viewportReadStats = internalQuery({
  args: {
    viewport: bbox,
    zoom: v.number(),
    limit: v.optional(v.number()),
    maxRows: v.optional(v.number()),
    names: v.optional(v.boolean()),
  },
  handler: async (ctx, { viewport, zoom, limit, maxRows, names }) => {
    const { byId, truncated, rowsRead, cellsScanned } = await bodiesCoveringBox(ctx, viewport, {
      zoom: Math.floor(zoom),
      limit: sanitizeLimit(limit),
      maxRows,
    });
    return {
      bodies: byId.size,
      cellsScanned,
      cellRowsRead: rowsRead,
      // The read the 4,096 cap actually counts: index rows + one hydrating get per distinct body.
      approxDocumentReads: cellsScanned + rowsRead + byId.size,
      truncated,
      ...(names ? { names: [...byId.values()].map((b) => b.name) } : {}),
    };
  },
});

/** Default parking/approach buffer for coord→lake resolution (F2 offline flush + map-open framing).
 *  ~300 m covers a lakeside lot / approach so opening from the car still resolves the lake (S1).
 *  Tunable — Phase 7 lifts it behind admin controls, same "don't bury constants" principle as the
 *  displayScore curve (D37). */
const AUTOSELECT_BUFFER_M = 300;

/**
 * Public: resolve a GPS coord to the listed water body it's on / nearest to within a parking-approach
 * buffer. The server side of the **F2 offline flush** for a *coord-only* draft — a report captured
 * off a lake the device hadn't cached, so the client couldn't auto-select it locally (see the mobile
 * body cache). Reuses `listInViewport`'s two-tier centroid + large-body lookup (read-cap-safe: the
 * per-point rectangle is small), then ranks candidates with the shared `nearestBodyForPoint`
 * (buffered `pointInPolygon`, smaller-area tie-break). Returns the (already survivor-listed) body id
 * + name, or null when nothing is within the buffer. Also usable online for a "you're at Lake X" hint.
 */
export const resolveBodyForCoord = query({
  args: { coord: latLng, bufferMeters: v.optional(v.number()) },
  handler: async (ctx, { coord, bufferMeters }) => {
    const buffer = bufferMeters ?? AUTOSELECT_BUFFER_M;
    const byId = await listedBodiesNearCoord(ctx, coord);
    const matchId = nearestBodyForPoint(
      coord,
      [...byId.values()].map((b) => ({
        ref: b._id,
        polygon: b.polygon as unknown as Polygon | MultiPolygon,
        surfaceAreaSqM: b.surfaceAreaSqM ?? 0,
      })),
      buffer,
    );
    const body = matchId ? byId.get(matchId) : undefined;
    return body ? { waterBodyId: body._id, name: body.name } : null;
  },
});

/**
 * Half-width (degrees) of the box searched around a coord, ~1.1 km — comfortably wider than the
 * `AUTOSELECT_BUFFER_M` parking-approach buffer the caller then measures against, so the ranking
 * step never has to reject a candidate the lookup should have offered it.
 */
const NEAR_COORD_MARGIN_DEG = 0.01;

/**
 * The listed bodies worth testing a single coord against — the candidate lookup shared by
 * `resolveBodyForCoord` and the Phase 8 track resolver (D44).
 *
 * The degenerate case of the viewport read (N1): one small box, every ladder rung, **no zoom
 * cutoff** — a body you are standing on must be found however unprominent it is, which is exactly
 * why this can't reuse the map's prominence filter. Its predecessor needed a second tier scanning
 * every `isLarge` body for the same reason (Champlain's centroid is nowhere near most of its
 * shoreline); a bbox-covering index makes size a non-issue, so that scan is gone.
 */
export async function listedBodiesNearCoord(
  ctx: QueryCtx,
  coord: { lat: number; lng: number },
): Promise<Map<Id<'waterBodies'>, Doc<'waterBodies'>>> {
  const { byId, truncated } = await bodiesCoveringBox(
    ctx,
    {
      minLat: coord.lat - NEAR_COORD_MARGIN_DEG,
      maxLat: coord.lat + NEAR_COORD_MARGIN_DEG,
      minLng: coord.lng - NEAR_COORD_MARGIN_DEG,
      maxLng: coord.lng + NEAR_COORD_MARGIN_DEG,
    },
    { limit: MAX_VIEWPORT_LIMIT },
  );
  if (truncated) {
    console.warn(
      `listedBodiesNearCoord stopped early near ${coord.lat},${coord.lng} with ${byId.size} candidates; a nearer body may have been missed (N1).`,
    );
  }
  return byId;
}

/**
 * Public: full-text search listed water bodies by name for the map's search box. Uses the
 * `search_name` search index (typo-tolerant, prefix match on the last term) and refines out
 * unlisted bodies (removed / rejected / merged) in JS — `listed` is a *derived* predicate, not a
 * stored field, so it can't be a search `filterField` (same reason `listInViewport` refines in JS).
 * Overfetches (`max * 4`) so the post-refine count stays stable — this assumes <75% of a term's
 * top index hits are unlisted. That holds while unlisted bodies (merged/removed/rejected) are a
 * small fraction of the corpus; revisit the multiplier (or page the index) if a large dedup/removal
 * sweep ever pushes that fraction up. Returns the light fields a result row needs; selecting a
 * result navigates to `/water/:id`, which handles the map fly-to + detail.
 * A <2-char query returns nothing (skip a pointless index scan).
 */
export const searchByName = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    /**
     * Drop the sub-area half of the merge (N2). Default `false` — a skater's box wants both, since
     * they don't know or care which table their bay lives in.
     *
     * It exists for callers whose destination is a *body*: `/admin/water`'s "open a lake" box routes
     * into the per-lake editor, and a bay has no editor of its own. Without this it would filter the
     * bay rows out client-side — **after** they had already claimed their reserved slots — so
     * searching a lake with named bays would silently return fewer lakes than it was asked for.
     */
    bodiesOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, { query, limit, bodiesOnly }) => {
    const term = query.trim();
    if (term.length < 2) return [];
    const max = Math.min(Math.max(limit ?? 8, 1), 20);
    const raw = await ctx.db
      .query('waterBodies')
      .withSearchIndex('search_name', (s) => s.search('name', term))
      .take(max * 4);
    // Sub-areas share the box (N2/D60). Searching a bay must reach it: S2 found Malletts under ten
    // spellings, and the northeast arm of Champlain is "the Inland Sea" — a name sharing no token
    // with anything the body index holds. Merged rather than a second box, because a skater typing
    // "malletts" doesn't know or care which table the answer lives in.
    //
    // **Bays are collected first and given reserved slots.** The obvious merge — take `max` bodies,
    // append bays, slice to `max` — silently drops every bay whenever the body index fills the page,
    // which the live corpus proved immediately: "Inland Sea" returned Dead Sea and Billington Sea
    // and not the arm of Lake Champlain actually named that. Bays are rare, hand-curated and
    // specifically asked for, so they get up to half the page and bodies fill the rest.
    const subAreaHits = bodiesOnly ? [] : await searchSubAreas(ctx, term, max);
    const bayShare = Math.min(subAreaHits.length, Math.ceil(max / 2));
    const bodyRoom = Math.max(1, max - bayShare);

    const results: SearchHit[] = [];
    for (const body of raw) {
      if (!isListed(body)) continue;
      results.push({
        kind: 'body',
        _id: body._id,
        waterBodyId: body._id,
        name: body.name,
        type: body.type,
        centroid: body.centroid,
        bbox: body.bbox,
        states: body.states ?? [],
      });
      if (results.length >= bodyRoom) break;
    }

    // **Rank across the two indexes, not within each.** Convex scores each search index on its own,
    // so a merged list ordered by table puts every fuzzy body match ahead of an exact bay match:
    // live, "Inland Sea" came back as Dead Sea, Billington Sea, Seabreeze Lagoon… with the arm of
    // Lake Champlain actually called that sitting eighth. An exact name match is an exact name match
    // whichever table holds it, so tier the merged set first and keep the index order inside a tier.
    //
    // Bodies still win at equal relevance — "Champlain" is a substring match on Lake Champlain and
    // on nothing else, so the lake lands first, which is the behaviour the merge must not break.
    const merged = [...results, ...subAreaHits.slice(0, bayShare)];
    return merged
      .map((hit, index) => ({ hit, index, tier: matchTier(hit, term) }))
      .sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.index - b.index))
      .slice(0, max)
      .map(({ hit }) => hit);
  },
});

/**
 * How closely a hit matches what was typed: `0` exact (name or alias), `1` substring, `2` fuzzy.
 *
 * The search indexes are typo-tolerant, which is what makes them useful and also what makes an
 * unranked merge misleading — "Sea" fuzzily matches a dozen ponds, and without a tier those bury the
 * one row whose name *is* the query.
 */
function matchTier(hit: SearchHit, term: string): number {
  const needle = term.toLowerCase();
  const names = [hit.name.toLowerCase(), ...(hit.aliases ?? []).map((a) => a.toLowerCase())];
  if (names.some((name) => name === needle)) return 0;
  if (names.some((name) => name.includes(needle))) return 1;
  return 2;
}

/** One row in the merged search box — a lake, or a named bay that tells you which lake it's in. */
type SearchHit = {
  kind: 'body' | 'subArea';
  /** The row's own id — a `waterBodies` id for a body hit, a `waterBodySubAreas` id for a bay. */
  _id: string;
  /** Where selecting it navigates: a sub-area hit opens its **parent's** page (D60 — the bay is a
   *  name on the lake, not a page of its own), framed on the bay's own bbox. */
  waterBodyId: Id<'waterBodies'>;
  name: string;
  /** Set for a sub-area hit only — renders as "Malletts Bay — in Lake Champlain". */
  parentName?: string;
  /** A bay's spelling variants, so an alias match can rank as the exact match it is. */
  aliases?: string[];
  type: Doc<'waterBodies'>['type'];
  centroid: Doc<'waterBodies'>['centroid'];
  /** The frame to fly to. **The bay's own**, not the parent's — searching Malletts Bay shouldn't
   *  frame you on 200 km of Lake Champlain, which is the whole reason the bay is nameable. */
  bbox: Doc<'waterBodies'>['bbox'];
  states: string[];
};

/**
 * Named-sub-area hits for the merged search box, refined on **both** listings.
 *
 * The parent check is the load-bearing half and easy to forget: `isListed` is derived, not stored,
 * so it can't be a search `filterField` on either table — and a bay whose lake was taken down must
 * not be reachable through a search box when it isn't reachable through the map (Decision 11). Same
 * `max * 4` overfetch as the body search, on the same assumption: unlisted rows are a small
 * fraction of the index.
 */
async function searchSubAreas(ctx: QueryCtx, term: string, max: number): Promise<SearchHit[]> {
  const raw = await ctx.db
    .query('waterBodySubAreas')
    .withSearchIndex('search_subarea', (s) => s.search('searchText', term))
    .take(max * 4);
  const hits: SearchHit[] = [];
  for (const subArea of raw) {
    if (subArea.removedAt !== undefined) continue;
    const parent = await ctx.db.get(subArea.waterBodyId);
    if (!parent || !isListed(parent)) continue;
    hits.push({
      kind: 'subArea',
      _id: subArea._id,
      waterBodyId: parent._id,
      name: subArea.name,
      parentName: parent.name,
      ...(subArea.aliases !== undefined ? { aliases: subArea.aliases } : {}),
      type: parent.type,
      centroid: subArea.centroid,
      bbox: subArea.bbox,
      states: parent.states ?? [],
    });
    if (hits.length >= max) break;
  }
  return hits;
}

/** Boosted bodies the curation list shows at once. A curated set in the low hundreds, by design. */
const CURATED_LIST_CAP = 300;
/**
 * How many boosted rows are *read* to fill that list.
 *
 * `isListed` is derived, so it can't be an index range — the filter has to run after the read, and a
 * cap applied before it lets removed/merged/rejected rows eat slots in a list whose whole job is to
 * show the operator every live boost. Reading two caps' worth and trimming after means the visible
 * list is short only when there genuinely are more than `CURATED_LIST_CAP` boosted *listed* bodies.
 */
const CURATED_SCAN_CAP = CURATED_LIST_CAP * 2;

/**
 * Moderator: every body carrying a `curatedBoost` (N2) — **the surface that makes a mis-match
 * visible**.
 *
 * The Phase-2.5 seed matched community favourites by name, and five of them landed on same-named
 * lakes in the wrong state. That wasn't five separate bugs so much as one missing screen: the boost
 * is editable per body, and nothing anywhere listed which bodies had one. Four of the five are
 * Champlain bays whose boost went to a namesake elsewhere, and the fix is one motion — strip the
 * wrong boost, draw the right sub-area — which only became possible once sub-areas existed.
 *
 * Each row carries what you need to *judge* the match without opening it: the states it spans, its
 * area, and the resulting `minVisibleZoom`. A boosted "South Bay" listed as ME with a 2 km² area is
 * self-evidently not the arm of Lake Champlain someone meant.
 */
export const listCurated = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, 'moderator');
    const rows = await takeCapped(
      ctx.db.query('waterBodies').withIndex('by_curated_boost', (q) => q.gt('curatedBoost', 0)),
      CURATED_SCAN_CAP,
      'waterBodies.listCurated',
    );
    // Strongest boost first — the most aggressively promoted body is the one a wrong match hurts
    // most, since it's drawing at a zoom where it displaces real lakes. Trimmed *after* the listing
    // filter, so a removed body can't take a live one's place in the list (see `CURATED_SCAN_CAP`).
    return rows
      .filter((body) => isListed(body))
      .sort((a, b) => (b.curatedBoost ?? 0) - (a.curatedBoost ?? 0))
      .slice(0, CURATED_LIST_CAP)
      .map((body) => ({
        _id: body._id,
        name: body.name,
        type: body.type,
        states: body.states ?? [],
        surfaceAreaSqM: body.surfaceAreaSqM ?? 0,
        curatedBoost: body.curatedBoost ?? 0,
        minVisibleZoom: body.minVisibleZoom ?? MIN_VISIBLE_ZOOM_FLOOR,
        centroid: body.centroid,
      }));
  },
});

/** Moderator/admin: the after-the-fact review queue of pending user bodies (D37). */
export const listPendingReview = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, 'moderator');
    // A moderator queue is meant to be short; if it isn't, showing a bounded page beats failing the
    // whole screen, and the log says the queue is running away (N1).
    return takeCapped(
      ctx.db
        .query('waterBodies')
        .withIndex('by_review_status', (q) => q.eq('reviewStatus', 'pending')),
      REVIEW_QUEUE_CAP,
      'waterBodies.listPendingReview',
    );
  },
});

/** How many flagged rows the queue reads before it says so. Two per pair, so this is ~125 pairs. */
const DEDUP_QUEUE_CAP = 250;
/** The most bodies one card may hold. A component larger than this is a matcher bug, not a merge. */
const DEDUP_GROUP_CAP = 6;

/**
 * Everything about a flagged body **except its outline** — the comparison table's input.
 *
 * The polygon is the one field that makes this payload unbounded (Champlain's outline alone is
 * larger than every other field on every row of the queue combined), and it is not needed to
 * *rank* a pair — only to look at one. `getDedupGroup` fetches it for the card the operator opened.
 */
function dedupSummary(body: Doc<'waterBodies'>) {
  const {
    polygon: _polygon,
    fetchProfileM: _fetch,
    windRose: _rose,
    weatherSamplePoints: _samples,
    ...rest
  } = body;
  return rest;
}
export type DedupSummary = ReturnType<typeof dedupSummary>;

/**
 * Moderator: the dedup-review queue (D36) — **grouped into one card per set of duplicates**.
 *
 * The queue used to return one row per flagged body, which was right when the only producer was
 * D36's match-on-create: a user drew a pond over an OSM lake, one row got stamped, and the other end
 * of the pair was a clean canonical body that never appeared. N7's reconciliation pass produces the
 * opposite shape — it flags **every member of a duplicate group**, mutually — so a queue of 50 real
 * decisions rendered as 100 cards, each pair appearing twice with the survivor and loser swapped,
 * and nothing on either card saying they were the same decision seen from two ends.
 *
 * So the rows are folded into connected components over `duplicateCandidateIds` and returned as
 * groups. `total` is the number of *decisions*; `flaggedRows` is the number of rows behind them, and
 * the two are printed together because a heading that says 50 over a table built from 100 rows is
 * the kind of quiet disagreement that makes an operator distrust the whole surface.
 *
 * Edges are followed **only out of rows that are themselves flagged**. A candidate that is clean (or
 * already merged) is pulled in so the card can name it, but its own candidate list is not walked —
 * that bound is what keeps one mis-scored chain from swallowing the corpus into a single card.
 */
export const listDedupCandidates = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, 'moderator');
    // Both match-on-create tiers land in the queue, near-certain first (D36) — a body flagged as
    // almost certainly a duplicate is the one a moderator should merge before anything else, and
    // before more reports accumulate on the wrong row.
    const near = await takeCappedResult(
      ctx.db
        .query('waterBodies')
        .withIndex('by_dedup_status', (q) => q.eq('dedupStatus', 'near_certain')),
      DEDUP_QUEUE_CAP,
      'waterBodies.listDedupCandidates (near_certain)',
    );
    const suspected = await takeCappedResult(
      ctx.db
        .query('waterBodies')
        .withIndex('by_dedup_status', (q) => q.eq('dedupStatus', 'suspected_duplicate')),
      Math.max(0, DEDUP_QUEUE_CAP - near.rows.length),
      'waterBodies.listDedupCandidates (suspected_duplicate)',
    );
    const flagged = [...near.rows, ...suspected.rows];

    // Every body the card has to name, flagged or not — a candidate may be a clean canonical body
    // (D36's original case) that never carries a flag of its own.
    const byId = new Map<Id<'waterBodies'>, Doc<'waterBodies'>>(flagged.map((b) => [b._id, b]));
    for (const body of flagged) {
      for (const id of body.duplicateCandidateIds ?? []) {
        if (byId.has(id)) continue;
        const other = await ctx.db.get(id);
        if (other) byId.set(id, other);
      }
    }

    // Connected components, walking edges out of flagged rows only (both directions: a mutual pair
    // and a one-way D36 stamp must both come out as one card).
    const neighbours = new Map<Id<'waterBodies'>, Set<Id<'waterBodies'>>>();
    const link = (a: Id<'waterBodies'>, b: Id<'waterBodies'>) => {
      if (!byId.has(a) || !byId.has(b)) return;
      for (const [from, to] of [
        [a, b],
        [b, a],
      ] as const) {
        const set = neighbours.get(from) ?? new Set<Id<'waterBodies'>>();
        set.add(to);
        neighbours.set(from, set);
      }
    };
    for (const body of flagged) {
      for (const id of body.duplicateCandidateIds ?? []) link(body._id, id);
    }

    const seen = new Set<Id<'waterBodies'>>();
    const groups: { key: string; members: DedupSummary[]; truncated: boolean }[] = [];
    for (const body of flagged) {
      if (seen.has(body._id)) continue;
      const members: Doc<'waterBodies'>[] = [];
      const stack = [body._id];
      let truncated = false;
      while (stack.length > 0) {
        const id = stack.pop();
        if (id === undefined || seen.has(id)) continue;
        seen.add(id);
        const doc = byId.get(id);
        if (!doc) continue;
        if (members.length >= DEDUP_GROUP_CAP) {
          truncated = true;
          continue;
        }
        members.push(doc);
        for (const next of neighbours.get(id) ?? []) stack.push(next);
      }
      // A flag whose only candidate has since been deleted leaves a group of one. It still belongs
      // in the queue — the flag is real and someone has to clear it — and the card says so.
      const key = members
        .map((m) => m._id)
        .sort()
        .join('+');
      groups.push({ key, members: members.map(dedupSummary), truncated });
    }

    // Near-certain groups first (D36), then the biggest — a three-body group is either the matcher
    // chaining two lakes together or a genuinely messy piece of the corpus, and both want a human
    // sooner than a routine pair does.
    groups.sort((a, b) => {
      const tier = (g: (typeof groups)[number]) =>
        g.members.some((m) => m.dedupStatus === 'near_certain') ? 0 : 1;
      return tier(a) - tier(b) || b.members.length - a.members.length;
    });

    return {
      groups,
      total: groups.length,
      flaggedRows: flagged.length,
      truncated: near.truncated || suspected.truncated,
    };
  },
});

/**
 * Moderator: the **expensive half** of one dedup card — outlines, overlap, and what is attached.
 *
 * Split from the queue query on payload rather than on principle. The list is subscribed to and
 * re-runs whenever any flagged body changes; carrying every outline through it would make a routine
 * page load megabytes of polygon to render a table of ids. This runs once, for the one group whose
 * shapes an operator asked to see.
 *
 * **The attachment counts are the survivor argument, not the duplicate argument.** `merge` re-points
 * every report, hazard, bounty, put-in, feature and favourite from loser to survivor, so nothing is
 * lost either way — but the row the community has actually been filing against is the one whose
 * `_id` is in people's links and caches, and that is worth knowing before choosing which id dies.
 */
export const getDedupGroup = query({
  args: { waterBodyIds: v.array(v.id('waterBodies')) },
  handler: async (ctx, { waterBodyIds }) => {
    await requireRole(ctx, 'moderator');
    if (waterBodyIds.length > DEDUP_GROUP_CAP) {
      throw new ConvexError(`A dedup group holds at most ${DEDUP_GROUP_CAP} bodies`);
    }
    const docs = (await Promise.all(waterBodyIds.map((id) => ctx.db.get(id)))).filter(
      (b): b is Doc<'waterBodies'> => b !== null,
    );

    const members = await Promise.all(
      docs.map(async (body) => ({
        _id: body._id,
        polygon: body.polygon,
        vertices: countVertices(body.polygon as Polygon | MultiPolygon),
        attachments: await countAttachments(ctx, body._id),
      })),
    );

    // Pairwise agreement, both orders folded into one entry. `polygonIoU` is the same measure the
    // matcher scored these on — restated here as *evidence for a person*, next to the outlines it
    // came from, rather than as the verdict it was when nobody could see it.
    const pairs: {
      aId: Id<'waterBodies'>;
      bId: Id<'waterBodies'>;
      iou: number | null;
      centroidDistanceM: number;
      areaRatio: number | null;
    }[] = [];
    for (let i = 0; i < docs.length; i++) {
      for (let j = i + 1; j < docs.length; j++) {
        const a = docs[i];
        const b = docs[j];
        if (!a || !b) continue;
        const areaA = a.surfaceAreaSqM;
        const areaB = b.surfaceAreaSqM;
        pairs.push({
          aId: a._id,
          bId: b._id,
          // Fail soft: the clipper can refuse near-coincident edges, which is exactly this case, and
          // a card that renders without an overlap number is far better than one that doesn't render.
          iou: safeIoU(a.polygon as Polygon | MultiPolygon, b.polygon as Polygon | MultiPolygon),
          centroidDistanceM: haversineMeters(a.centroid, b.centroid),
          areaRatio:
            areaA === undefined || areaB === undefined || areaA <= 0 || areaB <= 0
              ? null
              : Math.max(areaA, areaB) / Math.min(areaA, areaB),
        });
      }
    }

    return { members, pairs };
  },
});

function safeIoU(a: Polygon | MultiPolygon, b: Polygon | MultiPolygon): number | null {
  try {
    return polygonIoU(a, b);
  } catch {
    return null;
  }
}

function countVertices(geom: Polygon | MultiPolygon): number {
  const rings = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flat();
  return rings.reduce((sum, ring) => sum + ring.length, 0);
}

/** What is attached to one body — capped, and honest about the cap. */
async function countAttachments(ctx: QueryCtx, waterBodyId: Id<'waterBodies'>) {
  const cap = 100;
  const count = async (rows: Promise<unknown[]>) => {
    const list = await rows;
    return { n: Math.min(list.length, cap), atLeast: list.length > cap };
  };
  return {
    reports: await count(
      ctx.db
        .query('reports')
        .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', waterBodyId))
        .take(cap + 1),
    ),
    hazards: await count(
      ctx.db
        .query('hazards')
        .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
        .take(cap + 1),
    ),
    bounties: await count(
      ctx.db
        .query('bounties')
        .withIndex('by_water_body_status', (q) => q.eq('waterBodyId', waterBodyId))
        .take(cap + 1),
    ),
    putIns: await count(
      ctx.db
        .query('putIns')
        .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
        .take(cap + 1),
    ),
    bodyFeatures: await count(
      ctx.db
        .query('bodyFeatures')
        .withIndex('by_water_body_active', (q) => q.eq('waterBodyId', waterBodyId))
        .take(cap + 1),
    ),
    favorites: await count(
      ctx.db
        .query('waterBodyFavorites')
        .withIndex('by_water_body', (q) => q.eq('waterBodyId', waterBodyId))
        .take(cap + 1),
    ),
    subAreas: await count(
      ctx.db
        .query('waterBodySubAreas')
        .withIndex('by_parent', (q) => q.eq('waterBodyId', waterBodyId))
        .take(cap + 1),
    ),
  };
}

/**
 * Moderator: **these are not duplicates** — clear the flag and leave both rows standing.
 *
 * The queue could previously only be emptied by merging, which meant the only recorded outcome of a
 * review was "yes". That is a bad shape for any queue and a dangerous one for this queue: the
 * matcher's own audit found nine wrong matches in the bathymetry join, N7's `same-source-duplicate`
 * reason exists precisely because a flagged group can be two *distinct* lakes our matching chained
 * together, and a moderator who reached that conclusion had nowhere to put it. The card stayed, and
 * the pressure was always toward the irreversible button.
 *
 * Each body drops the others from its candidate list, and any body left with no live candidate goes
 * back to `clean`. `isListed` treats `clean` and the two flag tiers identically (a suspected
 * duplicate still draws — hiding it would take reports off the map on a machine's guess), so nothing
 * about visibility changes here and the cell index does not need re-stamping.
 */
export const dismissDuplicates = mutation({
  args: { waterBodyIds: v.array(v.id('waterBodies')), reason: v.optional(v.string()) },
  handler: async (ctx, { waterBodyIds, reason }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    if (waterBodyIds.length < 1) throw new ConvexError('Nothing to dismiss');
    if (waterBodyIds.length > DEDUP_GROUP_CAP) {
      throw new ConvexError(`A dedup group holds at most ${DEDUP_GROUP_CAP} bodies`);
    }
    const ids = new Set(waterBodyIds);
    const cleared: Id<'waterBodies'>[] = [];
    for (const id of ids) {
      const body = await ctx.db.get(id);
      if (!body) continue;
      // A merged tombstone keeps its status: `mergedIntoId` is what read paths follow, and moving it
      // back to `clean` would strand every link that resolves through it.
      if (body.dedupStatus === 'merged') continue;
      await clearDuplicateFlag(ctx, body, ids);
      cleared.push(id);
    }
    const first = cleared[0];
    if (first === undefined) {
      throw new ConvexError('Nothing to dismiss — every body in this group is already merged');
    }
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'dismiss_duplicate',
      targetType: 'waterbody',
      // The first body carries the action; the rest are in the metadata. `moderationActions` is
      // one-target by construction and this decision genuinely covers a set.
      targetId: first,
      reason: reason?.trim() || 'Reviewed and judged distinct bodies',
      metadata: { waterBodyIds: cleared },
      createdAt: Date.now(),
    });
    return cleared.length;
  },
});

/**
 * Drop `resolved` from one body's candidate list, and unflag it if nothing live is left.
 *
 * Shared by `dismissDuplicates` and `merge` because both leave the *other* end of a pair holding a
 * flag that points at a decision already made — the bug that made this queue un-emptiable: merging
 * B into A tombstoned B and left A `near_certain`, naming a candidate that `merge` now refuses as
 * "already merged". Fifty merges cleared fifty cards and left fifty behind.
 */
async function clearDuplicateFlag(
  ctx: MutationCtx,
  body: Doc<'waterBodies'>,
  resolved: ReadonlySet<Id<'waterBodies'>>,
) {
  const remaining: Id<'waterBodies'>[] = [];
  for (const id of body.duplicateCandidateIds ?? []) {
    if (id === body._id || resolved.has(id)) continue;
    const other = await ctx.db.get(id);
    if (other && other.dedupStatus !== 'merged') remaining.push(id);
  }
  await ctx.db.patch(body._id, {
    duplicateCandidateIds: remaining.length > 0 ? remaining : undefined,
    ...(remaining.length === 0 && body.dedupStatus !== 'merged'
      ? { dedupStatus: 'clean' as const }
      : {}),
  });
}

/**
 * **Resolve the duplicate pairs the campaign already answered** — a one-time pass (N7, 2026-08-07).
 *
 * ## What it is for, and why it is not the moderator merge
 *
 * Step 6's prune spared 61 bodies carrying a dedup pointer, on the rule that a body under human
 * review is not deleted out from under the person reviewing it. Every one of them turned out to be
 * the **losing half of an OSM duplicate pair** — Long Pond, Lovell Lake, Duncan Lake among them, the
 * pairs this phase opens by naming. Two independent systems had reached the same verdict: D36's
 * geometric match-on-create flagged them, and the N7 merge collapsed each pair onto one body through
 * NHD's shared `Permanent_Identifier`. The queue's 61 cards were pre-answered.
 *
 * `merge` is the right tool when there is content to move and a pointer worth keeping: it re-points
 * every child and leaves a `mergedIntoId` tombstone so reads chase the survivor. **Neither applies
 * here.** These are ETL rows with *zero* user content — measured, all ten attachment types, before
 * this function was written — so a merge would move nothing and the tombstone would preserve a
 * pointer nobody holds. The founder's call: remove the rows.
 *
 * ## The three things it refuses to do
 *
 * 1. **It never deletes a body carrying user content.** The ten attachment types `bodyAttachmentKind`
 *    knows are re-checked per body, and anything with a report, hazard, bounty, favourite, put-in,
 *    track, feature, sub-area, recurrence row or gate event is skipped and named. That check is not
 *    inherited from the prune: the prune tests `dedupOrMerged` *before* `attached`, so these 61 short
 *    circuited out of it and had never been attachment-checked at all.
 * 2. **It never deletes a body whose survivor is not in the corpus.** The justification for deleting
 *    is "the lake still exists under another row", so the pass verifies exactly that — a
 *    `duplicateCandidateIds` partner carrying this campaign's stamp. A pair where *both* halves are
 *    orphans is a lake the master list refused outright; that is the prune's business, not this
 *    function's, and it is reported rather than swept up.
 * 3. **It never deletes a body a contour tileset points at**, unless told to. `bathymetryCoverage` is
 *    keyed on `(source, externalId)` rather than `waterBodyId`, so no `waterBodyId` check can see it
 *    — five of the 61 carry one, and in every case the *survivor* does not, because the N6b join
 *    matched the survey to the duplicate. Deleting them is what lets the next join find the right
 *    body; `includeCoverageReferenced` is the deliberate opt-in.
 *
 * **Dry by default**, and it names every row in all four outcomes rather than counting them.
 */
export const resolveCampaignDuplicates = internalMutation({
  args: {
    /** The campaign whose master list decides which half of a pair survives. */
    campaignId: v.string(),
    apply: v.optional(v.boolean()),
    /** Also delete rows a `bathymetryCoverage` row points at — see the docstring's rule 3. */
    includeCoverageReferenced: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { campaignId, apply, includeCoverageReferenced, limit }) => {
    if (campaignId.trim().length === 0) {
      throw new ConvexError('resolveCampaignDuplicates: campaignId must not be empty');
    }
    const flagged = await ctx.db
      .query('waterBodies')
      .withIndex('by_dedup_status', (q) => q.eq('dedupStatus', 'near_certain'))
      .take(Math.min(200, Math.max(1, limit ?? 120)));

    const deleted: { name: string; externalId?: string; acres: number; survivor: string }[] = [];
    const skipped: { name: string; externalId?: string; reason: string; detail?: string }[] = [];

    for (const body of flagged) {
      // Re-affirmed rows are the survivors, not the losers — they are the whole point.
      if (body.lastCampaignId === campaignId) continue;
      const label = body.name || '(unnamed)';
      const acres = Math.round((body.surfaceAreaSqM ?? 0) / SQ_M_PER_ACRE_LOCAL);

      const attachment = await bodyAttachmentKind(ctx, body._id);
      if (attachment !== null) {
        skipped.push({
          name: label,
          externalId: body.externalId,
          reason: 'attached',
          detail: attachment,
        });
        continue;
      }

      // The survivor: a candidate partner this campaign re-affirmed.
      let survivor: Doc<'waterBodies'> | null = null;
      for (const id of body.duplicateCandidateIds ?? []) {
        const partner = await ctx.db.get(id);
        if (partner?.lastCampaignId === campaignId) {
          survivor = partner;
          break;
        }
      }
      if (survivor === null) {
        skipped.push({ name: label, externalId: body.externalId, reason: 'no-surviving-partner' });
        continue;
      }

      const coverage = await ctx.db
        .query('bathymetryCoverage')
        .withIndex('by_external_id', (q) =>
          q
            .eq('source', body.source === 'nhd' ? 'nhd' : 'osm')
            .eq('externalId', body.externalId ?? ''),
        )
        .take(1);
      if (coverage.length > 0 && includeCoverageReferenced !== true) {
        skipped.push({
          name: label,
          externalId: body.externalId,
          reason: 'bathymetry-coverage',
          detail: `survivor ${survivor.externalId ?? survivor._id} has none`,
        });
        continue;
      }

      deleted.push({
        name: label,
        externalId: body.externalId,
        acres,
        survivor: `${survivor.name || '(unnamed)'} ${survivor.externalId ?? survivor._id}`,
      });
      if (apply !== true) continue;

      // Clear the flag at the OTHER end of the pair before the row goes, or the survivor is left
      // pointing at an id that no longer loads — the dangling reference `merge` learned to avoid.
      await clearDuplicateFlag(ctx, survivor, new Set([body._id]));
      await syncWaterBodyCells(ctx, body._id, {
        bbox: body.bbox,
        minVisibleZoom: body.minVisibleZoom ?? MIN_VISIBLE_ZOOM_FLOOR,
        listed: false,
      });
      await ctx.db.delete(body._id);
    }

    return {
      applied: apply === true,
      scanned: flagged.length,
      deleted: deleted.length,
      skipped: skipped.length,
      skippedBy: skipped.reduce<Record<string, number>>((acc, s) => {
        acc[s.reason] = (acc[s.reason] ?? 0) + 1;
        return acc;
      }, {}),
      deletedRows: deleted,
      skippedRows: skipped,
    };
  },
});

/**
 * Mark a body as **wanted, whatever the rules say** — N7b's primitive, seeded early (2026-08-07).
 *
 * ## Why this exists before N7b does
 *
 * `includedByRequest` is already read in three places — `belongsInCorpus` short-circuits on it,
 * and both prunes protect it — and until now **nothing could set it**. A field every deletion path
 * honours and no path writes is a rule that cannot actually be used, and the campaign produced the
 * first body that needs it: a 5-acre unnamed wetland near Albany carrying an **active `open_water`
 * hazard**. D96 refuses it (an unnamed wetland needs fifty acres) and it is right to; but somebody
 * stood on that ice and marked open water, which is exactly the evidence N7b's request path is meant
 * to act on.
 *
 * Without this the body survives only because the prune spares anything with an attachment — a
 * technicality that gets re-proposed for deletion every single campaign and has to be re-argued
 * every time. The flag turns it into a decision somebody made once.
 *
 * **Keyed by catalogue id, not by Convex `_id`**, so an operator can name the body the way every
 * other artifact in this phase names it, and so the same command is re-runnable across a re-import.
 * Audited like every other moderator-scale write, because it overrides a corpus rule.
 */
export const setIncludedByRequest = internalMutation({
  args: {
    /** Whose decision this is — every write that overrides a corpus rule is attributable. */
    actorUserId: v.id('profiles'),
    osmId: v.optional(v.string()),
    nhdId: v.optional(v.string()),
    included: v.boolean(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { actorUserId, osmId, nhdId, included, reason }) => {
    if (osmId === undefined && nhdId === undefined) {
      throw new ConvexError('setIncludedByRequest: name the body by osmId or nhdId');
    }
    const matches = await lookupByCatalogueIds(ctx, { osmId, nhdId });
    const keys = [...new Set(matches.flatMap((m) => m.keys))];
    if (keys.length === 0) throw new ConvexError('setIncludedByRequest: no body carries that id');
    if (keys.length > 1) {
      // The same refusal `resolveUpsert` makes: an id resolving to two rows is a corpus-level
      // finding, and guessing which one somebody meant would bury it.
      throw new ConvexError(
        `setIncludedByRequest: that id resolves to ${keys.length} bodies — resolve the duplicate first`,
      );
    }
    const key = keys[0] as Id<'waterBodies'>;
    const body = await ctx.db.get(key);
    if (!body) throw new ConvexError('setIncludedByRequest: body not found');

    await ctx.db.patch(key, { includedByRequest: included ? true : undefined });
    await ctx.db.insert('moderationActions', {
      actorId: actorUserId,
      action: 'set_included_by_request',
      targetType: 'waterbody',
      targetId: key,
      reason:
        reason?.trim() ||
        (included
          ? 'Kept in the corpus by request, against the admission rules'
          : 'No longer kept by request'),
      metadata: { includedByRequest: included },
      createdAt: Date.now(),
    });
    return { waterBodyId: key, name: body.name, includedByRequest: included };
  },
});
