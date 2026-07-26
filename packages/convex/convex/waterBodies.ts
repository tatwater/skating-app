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
  allLevels,
  bboxIntersects,
  cellRangeCovering,
  cellsCovering,
  classifyDedup,
  type DedupClassification,
  type DedupShape,
  displayScore,
  isKnownStateCode,
  isMinor,
  KNOWN_STATE_CODES,
  minVisibleZoom,
  nearestBodyForPoint,
  pathToBody,
  scanLevels,
  WATER_BODY_TYPES,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { LineString, MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  internalQuery,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import { getCurrentProfile, requireProfile, requireRole } from './lib/auth';
import { syncWaterBodyCells, WATER_BODY_LADDER } from './lib/cellIndex';
import { CANONICAL_SOURCES, REMOVAL_REASONS } from './lib/enums';
import { isListed } from './lib/listing';
import { takeCapped } from './lib/scan';
import { bbox, geoJson, latLng, literals } from './lib/validators';

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
/** Total cells one read may look up across all rungs. */
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
});

/**
 * Derived display-prominence fields (D49) from a body's area + admin boost. `minVisibleZoom` is
 * stored on the row AND denormalized onto its cell rows (see `./lib/cellIndex`), where it's the
 * trailing field of `by_cell` — so a wide-zoom query returns the most-prominent bodies first and
 * never reads the rest at all.
 */
function scoreFields(input: { surfaceAreaSqM?: number; curatedBoost?: number }) {
  const score = displayScore(input);
  return { displayScore: score, minVisibleZoom: minVisibleZoom(score) };
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
          surfaceAreaSqM: item.surfaceAreaSqM,
          states: unionState(existing.states, state),
          ...scores,
        });
        // Re-derive listing from the preserved fields (removed stays removed, D48) and re-cell the
        // body against its new geometry + prominence (N1).
        await syncWaterBodyCells(ctx, existing._id, {
          bbox: item.bbox,
          minVisibleZoom: scores.minVisibleZoom,
          listed: isListed(existing),
        });
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
          surfaceAreaSqM: item.surfaceAreaSqM,
          states: unionState(undefined, state),
          ...scores,
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
      const scores = scoreFields({
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
    const profile = await requireProfile(ctx);
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
    const actor = await requireRole(ctx, 'moderator');
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
    const actor = await requireRole(ctx, 'admin');
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
    const actor = await requireRole(ctx, 'admin');
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
    const actor = await requireRole(ctx, 'moderator');
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
    const actor = await requireRole(ctx, 'moderator');
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

    const repointed = {
      reports: reports.length,
      hazards: hazards.length,
      bounties: bounties.length,
      bodyFeatures: features.length,
      putIns: putIns.length,
      favorites: favoritesRepointed,
      favoritesDeduped,
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
    const actor = await requireRole(ctx, 'moderator');
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
 * **Sorting isn't enough on its own, though: the row budget has to be spent fairly too.** If early
 * cells could take the whole budget, the sort would be ranking a *spatially selected* prefix and the
 * bias would survive one level down — whole neighbourhoods of a dense viewport blank while the first
 * cells scanned rendered their every pond. So each cell's `take` is its **fair share of what's left**
 * (`remaining budget / remaining cells`), which means no cell can be starved by the ones ahead of it,
 * and a cell that comes up short passes its slack to the ones behind. When the budget binds, the
 * result is the most prominent bodies from *across* the box rather than everything from one corner.
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
  const rowCeiling = Math.min(opts.maxRows ?? CELL_ROW_SCAN_BUDGET, CELL_ROW_SCAN_BUDGET);
  let rowBudget = rowCeiling;
  let cellBudget = CELL_SCAN_BUDGET;
  let truncated = false;

  // The full cell walk, materialized before any I/O so the row budget can be divided by how many
  // cells still have to be served. Pure arithmetic on the bbox — no reads — and the per-rung
  // absurdity guard runs here, so a skipped rung doesn't inflate anyone else's share.
  const levels =
    zoom === undefined ? allLevels(WATER_BODY_LADDER) : scanLevels(zoom, WATER_BODY_LADDER);
  const plan: { z: number; x: number; y: number }[] = [];
  for (const level of levels) {
    // A box far wider than its zoom implies (a hand-rolled client, a wrapped bbox) is the only way
    // this trips. Skip the rung and say so rather than materializing a huge covering — the
    // guarantee is worth more stated honestly than silently half-kept.
    const range = cellRangeCovering(box, level);
    if (range.count > MAX_CELLS_PER_LEVEL) {
      console.warn(
        `waterBodyCells: box covers ${range.count} cells at level ${level} (max ${MAX_CELLS_PER_LEVEL}); rung skipped, so bodies indexed there are omitted (N1).`,
      );
      truncated = true;
      continue;
    }
    plan.push(...cellsCovering(box, level));
  }
  if (plan.length > cellBudget) {
    truncated = true;
    plan.length = cellBudget;
  }

  // Pass 1 — candidate ids and their prominence, deduped. A body straddling a cell boundary appears
  // in several cells (and at several rungs when `zoom` is absent); keep the coarsest rung's value,
  // which is the body's own `minVisibleZoom`, so the rank never depends on which cell found it.
  const candidates = new Map<Id<'waterBodies'>, number>();
  for (const [i, cell] of plan.entries()) {
    if (rowBudget <= 0) {
      truncated = true;
      break;
    }
    cellBudget--;
    // Greedy, but never at the expense of a cell behind this one: take as much as wanted *after*
    // setting aside a floor for every cell still unserved. Rationing only bites when the budget is
    // actually scarce — dividing it evenly up front instead would cap an ordinary 39-cell viewport
    // at 38 rows a cell and truncate reads that comfortably fit, which is a worse answer than the
    // bias it fixes. `limit + 1` still caps a single cell: rows arrive ascending by
    // `minVisibleZoom`, so anything past a full render budget's worth from one cell is less
    // prominent than `limit` bodies already in hand and can never win.
    const unserved = plan.length - i - 1;
    // The floor is `MIN_ROWS_PER_CELL`, or an equal split when even that can't be met.
    const floorPerCell = Math.min(MIN_ROWS_PER_CELL, Math.floor(rowBudget / (unserved + 1)));
    const take = Math.max(1, Math.min(rowBudget - unserved * floorPerCell, limit + 1));
    const probe = Math.min(take + 1, rowBudget);
    const rows = await ctx.db
      .query('waterBodyCells')
      .withIndex('by_cell', (q) => {
        const atCell = q.eq('z', cell.z).eq('x', cell.x).eq('y', cell.y);
        return zoom === undefined ? atCell : atCell.lte('minVisibleZoom', zoom);
      })
      // `take + 1`, so "this cell had more" is a fact rather than a guess: stopping at exactly
      // `take` can't distinguish a cell that holds precisely that many from one that holds
      // thousands, and reporting the first as a truncation is how a D5 warning becomes noise
      // (Greptile PR #27 — the same boundary `takeCapped` gets wrong).
      //
      // Clamped to `rowBudget` so the probe is *inside* the budget rather than beside it: every row
      // returned is charged below, and the clamp is what keeps `CELL_ROW_SCAN_BUDGET` an exact
      // ceiling instead of one-per-cell more than it says.
      .take(probe);
    rowBudget -= rows.length;
    if (rows.length > take) {
      // Exact: the probe row came back, so this cell holds more than its share. Those rows are the
      // least prominent in it and can't change the top of the ranking, but the answer is partial.
      truncated = true;
    } else if (rows.length === probe && probe < take + 1) {
      // The budget cut the probe short, so "there was nothing more" was never actually established.
      // On any cell but the last, the exhausted budget flags this on the next iteration — on the
      // last one, nothing would have (Greptile PR #27, round 6: an earlier comment here claimed the
      // next iteration always covers it, which is false precisely at the end of the plan). Report it:
      // D5 would rather a warning that occasionally fires on a scan that happened to fit exactly than
      // a truncation that goes out silently.
      truncated = true;
    }
    for (const row of rows) {
      const best = candidates.get(row.waterBodyId);
      if (best === undefined || row.minVisibleZoom < best) {
        candidates.set(row.waterBodyId, row.minVisibleZoom);
      }
    }
  }

  // Pass 2 — hydrate in global prominence order, most prominent first, so the render budget spends
  // itself on the biggest lakes in the box rather than on whichever cell the walk opened first. Ties
  // break on id purely so the same viewport returns the same bodies twice running.
  const ranked = [...candidates].sort(([aId, aZoom], [bId, bZoom]) =>
    aZoom !== bZoom ? aZoom - bZoom : aId < bId ? -1 : 1,
  );
  const byId = new Map<Id<'waterBodies'>, Doc<'waterBodies'>>();
  for (const [waterBodyId] of ranked) {
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

  return {
    byId,
    truncated,
    rowsRead: rowCeiling - rowBudget,
    cellsScanned: CELL_SCAN_BUDGET - cellBudget,
  };
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
  args: { query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { query, limit }) => {
    const term = query.trim();
    if (term.length < 2) return [];
    const max = Math.min(Math.max(limit ?? 8, 1), 20);
    const raw = await ctx.db
      .query('waterBodies')
      .withSearchIndex('search_name', (s) => s.search('name', term))
      .take(max * 4);
    const results: Array<{
      _id: Id<'waterBodies'>;
      name: string;
      type: Doc<'waterBodies'>['type'];
      centroid: Doc<'waterBodies'>['centroid'];
      states: string[];
    }> = [];
    for (const body of raw) {
      if (!isListed(body)) continue;
      results.push({
        _id: body._id,
        name: body.name,
        type: body.type,
        centroid: body.centroid,
        states: body.states ?? [],
      });
      if (results.length >= max) break;
    }
    return results;
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
