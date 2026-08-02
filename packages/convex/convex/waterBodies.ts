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
  canOverwriteElevation,
  classifyDedup,
  DEPTH_SOURCE_RANK,
  DEPTH_SOURCES,
  type DedupClassification,
  type DedupShape,
  type DepthSource,
  displayScore,
  isKnownStateCode,
  isMinor,
  isPlausibleElevationM,
  isPlausibleWindRose,
  KNOWN_STATE_CODES,
  type LatLng,
  MAX_PLAUSIBLE_DEPTH_M,
  MAX_SUGGESTED_SAMPLE_POINTS,
  MIN_FETCH_CLAUSE_M,
  MIN_VISIBLE_ZOOM_FLOOR,
  minVisibleZoom,
  nearestBodyForPoint,
  type ProfileRichness,
  pathToBody,
  pointInPolygon,
  WATER_BODY_TYPES,
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
import { CANONICAL_SOURCES, REMOVAL_REASONS, WATER_BODY_SOURCES } from './lib/enums';
import { isListed } from './lib/listing';
import { takeCapped } from './lib/scan';
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

/** Union a state code into a body's `states` (sorted + deduped); unchanged when no state is given. */
function unionState(
  existing: string[] | undefined,
  state: string | undefined,
): string[] | undefined {
  if (!state) return existing;
  return [...new Set([...(existing ?? []), state])].sort();
}

/** A canonical (OSM/NHD) body as prepared by the ETL, keyed by its `(source, externalId)`. */
const canonicalBody = v.object({
  source: literals(CANONICAL_SOURCES), // osm | nhd — never user (D14)
  externalId: v.string(),
  name: v.string(),
  type: literals(WATER_BODY_TYPES),
  polygon: geoJson,
  bbox,
  centroid: latLng, // the on-water representative point (D48)
  surfaceAreaSqM: v.optional(v.number()),
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
 * Internal, never client-callable: idempotently upsert a batch of canonical bodies (D14/D48).
 * Load via `pnpm exec convex run` from the ETL (chunk batches for the mutation size limit).
 * Keyed on `by_external_id` (`(source, externalId)`), so OSM and NHD stay distinct even when a
 * feature shares an id across feeds:
 *  - **insert** a new body as `listed: true`;
 *  - **update** an existing body's geometry/name/area but **preserve** its `removed*` /
 *    `reviewStatus` / `dedupStatus`, re-deriving `listed` via `isListed` — so a re-import
 *    never resurrects a removed body (above all a landowner takedown, D48).
 * Re-running on unchanged data is a no-op on the final state (one row, same listing).
 */
export const importCanonical = internalMutation({
  // `state` (2-letter code) is the extract's source region; it's unioned into each body's `states`
  // so a border-spanning body imported from multiple state extracts accumulates them all (D5/2.5).
  args: { bodies: v.array(canonicalBody), state: v.optional(v.string()) },
  handler: async (ctx, { bodies, state }) => {
    // Defense-in-depth against the ETL's `--state` guard: reject an unknown region code before any
    // write so a bad tag can never be unioned into a body's `states` (Phase 2.5 review).
    if (state !== undefined && !isKnownStateCode(state)) {
      throw new ConvexError(
        `Unknown state code: ${state}. Expected one of: ${KNOWN_STATE_CODES.join(', ')}.`,
      );
    }
    let inserted = 0;
    let updated = 0;
    for (const item of bodies) {
      const existing = await ctx.db
        .query('waterBodies')
        .withIndex('by_external_id', (q) =>
          q.eq('source', item.source).eq('externalId', item.externalId),
        )
        .unique();

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
          polygon: item.polygon,
          bbox: item.bbox,
          centroid: item.centroid,
          representativePoint: item.centroid,
          surfaceAreaSqM: item.surfaceAreaSqM,
          states: unionState(existing.states, state),
          ...scores,
          ...shapeFields(item),
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
          polygon: item.polygon,
          bbox: item.bbox,
          centroid: item.centroid,
          representativePoint: item.centroid,
          surfaceAreaSqM: item.surfaceAreaSqM,
          states: unionState(undefined, state),
          ...scores,
          ...shapeFields(item),
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
    return { inserted, updated };
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
  },
  handler: async (ctx, { cursor, batchSize, refresh }) => {
    const numItems = Math.min(1000, Math.max(1, batchSize ?? 500));
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });
    const targets = page.page
      .filter((body) => {
        if (body.elevationSource === 'operator') return false;
        return refresh === true || body.elevationM === undefined;
      })
      .map((body) => {
        const point = body.interiorPoint ?? body.representativePoint ?? body.centroid;
        return { waterBodyId: body._id, lat: point.lat, lng: point.lng };
      });
    return {
      targets,
      scanned: page.page.length,
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
  },
  handler: async (ctx, { cursor, batchSize, refresh, minFetchM }) => {
    const numItems = Math.min(1000, Math.max(1, batchSize ?? 500));
    const floor = minFetchM ?? MIN_FETCH_CLAUSE_M;
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });
    const targets = page.page
      .filter((body) => {
        if (!isListed(body)) return false;
        if (!refresh && body.windRose !== undefined) return false;
        const fetchProfileM = body.fetchProfileM;
        if (!fetchProfileM || fetchProfileM.length === 0) return false;
        return Math.max(...fetchProfileM) >= floor;
      })
      .map((body) => {
        const point = body.interiorPoint ?? body.representativePoint ?? body.centroid;
        return { waterBodyId: body._id, lat: point.lat, lng: point.lng };
      });
    return { targets, scanned: page.page.length, cursor: page.continueCursor, isDone: page.isDone };
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
    type: literals(WATER_BODY_TYPES),
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
      }),
    ),
  },
  handler: async (ctx, { lakes }) => {
    let updated = 0;
    let unmatched = 0;
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
      // No approach buffer: a lake's representative point must be *on* our polygon to be that lake.
      // The 300 m parking buffer `resolveBodyForCoord` uses exists so a skater in the car resolves the
      // lake; here it would let a point just off one shoreline claim the body across the road.
      const matchId = nearestBodyForPoint(
        lake.point,
        [...byId.values()].map((b) => ({
          ref: b._id,
          polygon: b.polygon as unknown as Polygon | MultiPolygon,
          surfaceAreaSqM: b.surfaceAreaSqM ?? 0,
        })),
        0,
      );
      const body = matchId ? byId.get(matchId) : undefined;
      if (!body) {
        unmatched++;
        rejects.push({ key: lake.key, reason: 'no listed body at this point' });
        continue;
      }

      const ours = body.surfaceAreaSqM;
      if (ours !== undefined && ours > 0 && lake.areaSqM !== undefined && lake.areaSqM > 0) {
        const ratio = Math.max(ours / lake.areaSqM, lake.areaSqM / ours);
        if (ratio > DEPTH_MATCH_AREA_RATIO) {
          areaRejected++;
          rejects.push({
            key: lake.key,
            reason: `area mismatch with "${body.name}": ${Math.round(ours)} m² vs ${Math.round(lake.areaSqM)} m² (${ratio.toFixed(1)}×)`,
          });
          continue;
        }
      } else {
        // Counted, not silent: with an area missing on either side the guard against "the pond next
        // door" simply doesn't run, and a run needs to say how much of its output went un-gated.
        noAreaGate++;
      }

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
 * The same geometric join as `matchAndImportDepths` above, and deliberately the *same* helpers — a
 * second notion of "these are the same lake" is exactly what N6a's ladder work exists to avoid. What
 * differs is what comes back, because N6b needs two things a depth stamp doesn't:
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
        areaSqM: v.optional(v.number()),
      }),
    ),
    /** Omit the polygon when only the identity is wanted — a coverage count, say. */
    includePolygon: v.optional(v.boolean()),
  },
  handler: async (ctx, { lakes, includePolygon = true }) => {
    const matches: Array<{
      key: string;
      waterBodyId: Id<'waterBodies'>;
      externalId?: string;
      source: string;
      name: string;
      surfaceAreaSqM?: number;
      states?: string[];
      polygon?: unknown;
    }> = [];
    const rejects: { key: string; reason: string }[] = [];

    for (const lake of lakes) {
      const byId = await listedBodiesNearCoord(ctx, lake.point);
      // Zero approach buffer, for the same reason `matchAndImportDepths` uses zero: a lake's
      // representative point must be *on* our polygon to be that lake. A buffer would let a sounding
      // just off one shoreline claim the body across the road.
      const matchId = nearestBodyForPoint(
        lake.point,
        [...byId.values()].map((b) => ({
          ref: b._id,
          polygon: b.polygon as unknown as Polygon | MultiPolygon,
          surfaceAreaSqM: b.surfaceAreaSqM ?? 0,
        })),
        0,
      );
      const body = matchId ? byId.get(matchId) : undefined;
      if (!body) {
        rejects.push({ key: lake.key, reason: 'no listed body at this point' });
        continue;
      }

      // The same 4× area gate, and it earns its place here more than it did for depth. A depth
      // stamped on the wrong pond is one bad number; a *basin* attributed to the wrong pond is a
      // whole rendered map of somewhere else, drawn confidently inside the wrong shoreline.
      const ours = body.surfaceAreaSqM;
      if (ours !== undefined && ours > 0 && lake.areaSqM !== undefined && lake.areaSqM > 0) {
        const ratio = Math.max(ours / lake.areaSqM, lake.areaSqM / ours);
        if (ratio > DEPTH_MATCH_AREA_RATIO) {
          rejects.push({
            key: lake.key,
            reason: `area mismatch with "${body.name}": ${Math.round(ours)} m² vs ${Math.round(lake.areaSqM)} m² (${ratio.toFixed(1)}×)`,
          });
          continue;
        }
      }

      matches.push({
        key: lake.key,
        waterBodyId: body._id,
        externalId: body.externalId,
        source: body.source,
        name: body.name,
        surfaceAreaSqM: body.surfaceAreaSqM,
        states: body.states,
        ...(includePolygon ? { polygon: body.polygon } : {}),
      });
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

/**
 * Moderator: the dedup-review queue (D36) — bodies marked `suspected_duplicate`, off `by_dedup_status`.
 * Each row resolves its `duplicateCandidateIds` to `{ id, name }` pairs so the merge UI can show the
 * candidate survivors without a second round-trip. **Expect ~zero rows until Phase 8** wires
 * match-on-create; the queue degrades gracefully to empty. Bounded — never scans the corpus.
 */
export const listDedupCandidates = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, 'moderator');
    // Both match-on-create tiers land in the queue, near-certain first (D36) — a body flagged as
    // almost certainly a duplicate is the one a moderator should merge before anything else, and
    // before more reports accumulate on the wrong row.
    const nearCertain = await ctx.db
      .query('waterBodies')
      .withIndex('by_dedup_status', (q) => q.eq('dedupStatus', 'near_certain'))
      .take(100);
    const suspected = await ctx.db
      .query('waterBodies')
      .withIndex('by_dedup_status', (q) => q.eq('dedupStatus', 'suspected_duplicate'))
      .take(100 - nearCertain.length);
    const rows = [...nearCertain, ...suspected];
    return Promise.all(
      rows.map(async (body) => {
        const candidates = await Promise.all(
          (body.duplicateCandidateIds ?? []).map(async (id) => {
            const c = await ctx.db.get(id);
            return c ? { id: c._id, name: c.name } : null;
          }),
        );
        return { body, candidates: candidates.filter((c) => c !== null) };
      }),
    );
  },
});
