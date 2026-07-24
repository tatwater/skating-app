/**
 * Water-body functions.
 *
 * Canonical (OSM/NHD) bodies arrive via the internal `importCanonical` upsert (D14/D48) and
 * are auto-listed. User-created bodies are **auto-visible then reviewed-after** (D37):
 * `create` writes a `pending` body immediately (still listed), and a moderator later resolves
 * it via `approve`. Admins can `remove`/`restore` any body — a reversible soft-delist (D48).
 * Whether a body shows on the public map is the derived `listed` boolean (see `./lib/listing`),
 * which `listInViewport` enforces when refining viewport results (see its read-cap note).
 */

import {
  bboxIntersects,
  displayScore,
  isKnownStateCode,
  isMinor,
  KNOWN_STATE_CODES,
  minVisibleZoom,
  nearestBodyForPoint,
  WATER_BODY_TYPES,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, mutation, type QueryCtx, query } from './_generated/server';
import { getCurrentProfile, requireProfile, requireRole } from './lib/auth';
import { CANONICAL_SOURCES, REMOVAL_REASONS } from './lib/enums';
import { waterBodiesGeo } from './lib/geospatial';
import { isListed } from './lib/listing';
import { bbox, geoJson, latLng, literals } from './lib/validators';

/**
 * Two-tier viewport tuning (D5). The geospatial component indexes *points* (centroids), but
 * "in view" means **bbox intersects the viewport** — a large lake fills the screen with its
 * centroid off-screen. A single blanket expansion sized for the largest body (Lake Champlain,
 * ~1.5°) fails at real corpus density: it covers ~all of Vermont, hits the component's internal
 * ~1024-row read cap, and returns a spatially-arbitrary slice that the refine finds nothing in
 * (this returned **0** for a normal city zoom over 9,967 bodies). So we decouple the outliers:
 *
 *  - **Tier 1 (the common case):** query the centroid index over the viewport expanded by a
 *    *small* margin (`VIEWPORT_MARGIN_DEG`). A body whose bbox intersects the viewport has its
 *    centroid within one bbox-extent of it, so this catches every body whose extent ≤ the margin
 *    — the overwhelming majority (>99% of Vermont bodies span < 0.05°). At city zoom the query
 *    rectangle holds ~100 rows, comfortably under the read cap, so the tier-1 result is correct.
 *  - **Tier 2 (the handful of large bodies):** a body whose bbox spans more than the margin
 *    (`isLarge`, set at import/create) can have its centroid outside the tier-1 rectangle, so we
 *    scan the `by_is_large` short list directly and `bboxIntersects`-test it. Vermont: 12 bodies.
 *
 * **No-gap invariant:** `LARGE_BODY_EXTENT_DEG ≤ VIEWPORT_MARGIN_DEG`. Every body with extent ≤
 * the margin is guaranteed caught by tier 1; everything larger is flagged `isLarge` and caught by
 * tier 2 — so the two tiers cover the full corpus with no silent hole. The fully-general
 * alternative (multi-cell / bbox-coverage indexing) is a larger geospatial rework deferred past
 * Phase 1; the zoom-scored display score is D49 (Phase 2). As more regions load, the `isLarge`
 * list grows — revisit the two-tier scan if it stops being a short list (national-scale, logged).
 */
const VIEWPORT_MARGIN_DEG = 0.05;
const LARGE_BODY_EXTENT_DEG = 0.05;
/** Cap on the tier-1 centroid prefilter — a backstop against a wide zoom pulling the whole corpus;
 *  truncation is logged, never silent (D5). Also the **read-cap guard**: the geospatial component
 *  reads ∝ `maxResults`, so this bounds a single query's reads. 256 sits ~20% under the measured
 *  ~320 crash edge for the Vermont corpus (see the `listInViewport` tier-1 note). The real
 *  display fix is the D49 zoom-scored score (Phase 2). */
const DEFAULT_VIEWPORT_LIMIT = 256;
/** Hard ceiling on the (client-supplied) tier-1 limit. Clamped to the default so no caller can
 *  push `maxResults` past the read-cap-safe zone — a large value crashes the geospatial query
 *  (Convex's 4,096-reads limit), it doesn't just page slowly. See `sanitizeLimit`. */
const MAX_VIEWPORT_LIMIT = DEFAULT_VIEWPORT_LIMIT;

/**
 * `listInViewport.limit` is public, client-supplied input, so guard it (D5/D37 — validate at the
 * trust boundary): a `0`/negative/non-integer value would leave the tier-1 key set empty, silently
 * returning *only* large bodies; a value past `MAX_VIEWPORT_LIMIT` would make the geospatial query
 * exceed its read cap and crash. Fall back to the default for anything that isn't a positive
 * integer, and clamp to the ceiling.
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

/** Largest span of a bbox in either axis, in degrees. */
function bboxExtentDeg(b: { minLat: number; minLng: number; maxLat: number; maxLng: number }) {
  return Math.max(b.maxLat - b.minLat, b.maxLng - b.minLng);
}

/** Whether a body is a `listInViewport` tier-2 outlier — bbox wider than the centroid margin (D5). */
function isLargeBody(b: { minLat: number; minLng: number; maxLat: number; maxLng: number }) {
  return bboxExtentDeg(b) > LARGE_BODY_EXTENT_DEG;
}

/**
 * Derived display-prominence fields (D49) from a body's area + admin boost. `minVisibleZoom` is
 * stored on the row AND used as the geospatial `sortKey` (see `listInViewport` / `./lib/geospatial`),
 * so a wide-zoom query returns the most-prominent bodies first and filters the rest out in-query.
 */
function scoreFields(input: { surfaceAreaSqM?: number; curatedBoost?: number }) {
  const score = displayScore(input);
  return { displayScore: score, minVisibleZoom: minVisibleZoom(score) };
}

/**
 * The geospatial `sortKey` for a stored body — its `minVisibleZoom` (D49), recomputed from area +
 * boost. Used when a mutation re-inserts the geospatial entry without changing score inputs
 * (`approve`/`remove`/`restore`), so the key stays correct even for a legacy row missing the field.
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
          isLarge: isLargeBody(item.bbox),
          surfaceAreaSqM: item.surfaceAreaSqM,
          states: unionState(existing.states, state),
          ...scores,
        });
        // Re-derive listing from the preserved fields (removed stays removed, D48); sortKey =
        // minVisibleZoom (D49) so the zoom filter works.
        await waterBodiesGeo.insert(
          ctx,
          existing._id,
          { latitude: item.centroid.lat, longitude: item.centroid.lng },
          { listed: isListed(existing) },
          scores.minVisibleZoom,
        );
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
          isLarge: isLargeBody(item.bbox),
          surfaceAreaSqM: item.surfaceAreaSqM,
          states: unionState(undefined, state),
          ...scores,
          dedupStatus: 'clean', // default (D36)
          createdAt: now,
        });
        await waterBodiesGeo.insert(
          ctx,
          id,
          { latitude: item.centroid.lat, longitude: item.centroid.lng },
          { listed: true },
          scores.minVisibleZoom,
        );
        inserted++;
      }
    }
    return { inserted, updated };
  },
});

/**
 * Internal, **small-scale** migration (run via `pnpm exec convex run`) that re-derives, in one
 * `collect()` pass, the two fields a keying change can leave stale on an existing body:
 *  1. **`listed` key-switch (D48).** The geospatial index used to be keyed on `reviewStatus`;
 *     entries written under the old key won't match a `listed` filter, so a body indexed before
 *     that switch drops off the map until re-inserted under the `listed` key.
 *  2. **`isLarge` (D5).** The two-tier `listInViewport` scans the `by_is_large` short list; a body
 *     with no `isLarge` is invisible to tier 2. Patched from bbox extent.
 *
 * **Scale limit:** `collect()` + a geospatial re-insert per body reads far past Convex's
 * 4096-reads/mutation cap on a large corpus (the geospatial insert alone reads ~15–20 S2-cell docs
 * per body). This is the path for the handful of **user-created / pre-Phase-1** bodies only. The
 * **canonical corpus** (Vermont ~10k) instead gets both fields from a **re-run of the chunked ETL
 * loader** (`pnpm --filter @skating/etl load <ndjson>`) — `importCanonical` sets `isLarge` and the
 * loader batches to stay under the read cap. A national-scale backfill would need pagination.
 */
export const backfillListed = internalMutation({
  args: {},
  handler: async (ctx) => {
    const bodies = await ctx.db.query('waterBodies').collect();
    for (const body of bodies) {
      const isLarge = isLargeBody(body.bbox);
      const scores = scoreFields({
        surfaceAreaSqM: body.surfaceAreaSqM,
        curatedBoost: body.curatedBoost,
      });
      const patch: Partial<Doc<'waterBodies'>> = {};
      if (body.isLarge !== isLarge) patch.isLarge = isLarge;
      if (body.displayScore !== scores.displayScore) patch.displayScore = scores.displayScore;
      if (body.minVisibleZoom !== scores.minVisibleZoom)
        patch.minVisibleZoom = scores.minVisibleZoom;
      if (Object.keys(patch).length > 0) await ctx.db.patch(body._id, patch);
      await waterBodiesGeo.insert(
        ctx,
        body._id,
        { latitude: body.centroid.lat, longitude: body.centroid.lng },
        { listed: isListed(body) },
        scores.minVisibleZoom,
      );
    }
    return { reindexed: bodies.length };
  },
});

/** Create a user-contributed water body, queued for after-the-fact review (D14/D37). */
export const create = mutation({
  args: {
    name: v.string(),
    type: literals(WATER_BODY_TYPES),
    polygon: geoJson,
    bbox,
    centroid: latLng,
    surfaceAreaSqM: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const profile = await requireProfile(ctx);
    const now = Date.now();
    // Minors are read-only (D41) — mirror `reports.create`, so a minor can't push a public map
    // contribution attributed to them. (This stays a v1 scaffold; GPS-backed create + dedup is
    // Phase 8, D36 — TODO: match-on-create dedup / bbox prefilter → Turf IoU / name similarity.)
    if (isMinor(profile.dateOfBirth, now)) {
      throw new ConvexError('Users under 18 cannot create water bodies');
    }
    const scores = scoreFields({ surfaceAreaSqM: args.surfaceAreaSqM }); // no boost on a new body
    const id = await ctx.db.insert('waterBodies', {
      name: args.name,
      type: args.type,
      source: 'user',
      polygon: args.polygon,
      bbox: args.bbox,
      centroid: args.centroid,
      isLarge: isLargeBody(args.bbox),
      surfaceAreaSqM: args.surfaceAreaSqM,
      ...scores,
      createdByUserId: profile._id,
      reviewStatus: 'pending', // auto-visible, review-after (D37)
      dedupStatus: 'clean', // default (D36)
      createdAt: now,
    });
    // Index the centroid for viewport lookups (D5); a pending user body is auto-visible
    // (D37/D48), so it lists immediately — `listed` is the filter key public queries use.
    // sortKey = minVisibleZoom (D49).
    await waterBodiesGeo.insert(
      ctx,
      id,
      { latitude: args.centroid.lat, longitude: args.centroid.lng },
      { listed: isListed({ reviewStatus: 'pending', dedupStatus: 'clean' }) },
      scores.minVisibleZoom,
    );
    return id;
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
    // Keep the geospatial filter key in sync with the new listing (still listed, D48).
    await waterBodiesGeo.insert(
      ctx,
      args.waterBodyId,
      { latitude: body.centroid.lat, longitude: body.centroid.lng },
      { listed: isListed({ ...body, reviewStatus: 'approved' }) },
      zoomSortKey(body),
    );
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
 * (never a hard delete): stamp `removed*`, flip `listed` off in the geospatial index, and
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
    await waterBodiesGeo.insert(
      ctx,
      args.waterBodyId,
      { latitude: body.centroid.lat, longitude: body.centroid.lng },
      { listed: isListed({ ...body, removedAt: now }) },
      zoomSortKey(body),
    );
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
    await waterBodiesGeo.insert(
      ctx,
      args.waterBodyId,
      { latitude: body.centroid.lat, longitude: body.centroid.lng },
      { listed: isListed({ ...body, removedAt: undefined }) },
      zoomSortKey(body),
    );
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
 * `rejected` (which `isListed` treats as unlisted), re-derives the geospatial key so it drops off the
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
    await waterBodiesGeo.insert(
      ctx,
      args.waterBodyId,
      { latitude: body.centroid.lat, longitude: body.centroid.lng },
      { listed: isListed({ ...body, reviewStatus: 'rejected' }) },
      zoomSortKey(body),
    );
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
    // `merged` as unlisted, so drop its geospatial key too.
    await ctx.db.patch(loserId, { dedupStatus: 'merged', mergedIntoId: survivorId });
    await waterBodiesGeo.insert(
      ctx,
      loserId,
      { latitude: loser.centroid.lat, longitude: loser.centroid.lng },
      { listed: isListed({ ...loser, dedupStatus: 'merged' }) },
      zoomSortKey(loser),
    );
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
 * the geospatial key so the new zoom prominence takes effect, and write a `moderationActions` row.
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
    // Re-index with the new sortKey (minVisibleZoom) so listInViewport's zoom filter sees it.
    await waterBodiesGeo.insert(
      ctx,
      waterBodyId,
      { latitude: body.centroid.lat, longitude: body.centroid.lng },
      { listed: isListed(body) },
      scores.minVisibleZoom,
    );
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
      await waterBodiesGeo.insert(
        ctx,
        target._id,
        { latitude: target.centroid.lat, longitude: target.centroid.lng },
        { listed: isListed(target) },
        scores.minVisibleZoom,
      );
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
 * Public: water bodies whose **bbox intersects** the viewport (D5/D48). Two-tier — see the
 * `VIEWPORT_MARGIN_DEG` / `LARGE_BODY_EXTENT_DEG` note above for why:
 *  - **Tier 1:** a centroid prefilter over the viewport + a small margin (`listed == true`),
 *    catching every non-large body.
 *  - **Tier 2:** the `by_is_large` short list, whose bodies can have off-screen centroids.
 * Both tiers are refined by `bboxIntersects` + `isListed`, then merged (a large body can appear
 * in both). `listed` filters to canonical + auto-visible/approved user bodies (not rejected,
 * merged, or removed).
 *
 * **Zoom-scored prominence (D49).** When the client passes its current `zoom`, tier 1 additionally
 * filters `sortKey <= zoom` (sortKey = `minVisibleZoom`) *inside* the geospatial query, and tier 2
 * applies the same cutoff in JS. So a wide zoom returns only the prominent bodies (Lake Champlain,
 * a boosted Lake Morey) instead of an arbitrary read-capped slice — and because the component orders
 * by `sortKey`, a capped query keeps the *most prominent* bodies. Omitting `zoom` disables the
 * filter (returns all listed bodies in view), preserving the pre-D49 behavior.
 */
export const listInViewport = query({
  args: { viewport: bbox, limit: v.optional(v.number()), zoom: v.optional(v.number()) },
  handler: async (ctx, { viewport, limit, zoom }) => {
    const effectiveLimit = sanitizeLimit(limit);
    // Floor the client zoom to the integer bucket `minVisibleZoom` uses, so the tier-1 range filter
    // (`sortKey < z + 1`) and the tier-2 JS cutoff (`minVisibleZoom > z`) agree at a fractional zoom.
    // (Clients already floor via `zoomForViewport`; this is defense-in-depth against a raw value.)
    const z = zoom === undefined ? undefined : Math.floor(zoom);

    // Tier 1 — centroid prefilter over the viewport expanded by the (small) margin. The
    // geospatial `query` returns a *partial* page plus a continuation cursor, so we page through
    // it, accumulating up to `effectiveLimit` centroids. Stopping with a cursor still pending
    // means we capped a wide zoom — the D5 truncation, surfaced in logs rather than dropped
    // silently (D49 display score is the real fix, Phase 2).
    //
    // Read-cap safety (learned live at the 9,967-body scale — a crash, not theory): the geospatial
    // component runs each `query` as its own execution under Convex's 4,096-reads cap, and it
    // reads roughly ∝ `maxResults` (its internal read-ahead), *not* just the result count — so a
    // wide viewport that can't fill `maxResults` exhausts a large S2 covering and blows the cap.
    // Two levers keep every viewport safe: (1) we do **not** pass the `listed` filter here — the
    // component's filter-stream *intersection* ~halves the safe `maxResults` ceiling, and the
    // `isListed` refine below already enforces listing (Phase 1 has ~no unlisted bodies, so
    // fetching-then-dropping them costs nothing); (2) `MAX_VIEWPORT_LIMIT` is tuned so even the
    // worst exhausting rectangle (wide, panned off-data) stays well under the cap. Measured: at
    // this corpus ~320 is the crash edge unfiltered, so the 256 default carries ~20% margin.
    const rectangle = {
      west: viewport.minLng - VIEWPORT_MARGIN_DEG,
      east: viewport.maxLng + VIEWPORT_MARGIN_DEG,
      south: viewport.minLat - VIEWPORT_MARGIN_DEG,
      north: viewport.maxLat + VIEWPORT_MARGIN_DEG,
    };
    const keys: Id<'waterBodies'>[] = [];
    let cursor: string | undefined;
    let truncated = false;
    do {
      const page = await waterBodiesGeo.query(
        ctx,
        {
          shape: { type: 'rectangle', rectangle },
          limit: effectiveLimit,
          // D49: keep only bodies visible at this zoom. sortKey = minVisibleZoom, and `.lt` is
          // exclusive, so `< z + 1` means `minVisibleZoom <= z`. Ranges over the sort
          // dimension (unlike the `listed` filter-key intersection) don't lower the read cap.
          ...(z !== undefined ? { filter: (q) => q.lt('sortKey', z + 1) } : {}),
        },
        cursor,
      );
      for (const { key } of page.results) keys.push(key);
      cursor = page.nextCursor;
      if (keys.length >= effectiveLimit && cursor !== undefined) truncated = true;
    } while (cursor !== undefined && keys.length < effectiveLimit);
    // Since we don't filter on `listed` in the query (read-cap safety, above), an unlisted body
    // (removed/rejected/merged) in the rectangle occupies a prefilter slot before the `isListed`
    // refine drops it — so at the cap the visible count can undershoot while listed bodies remain
    // behind the cursor. This only bites once the cursor is still pending at `effectiveLimit` —
    // the wide-zoom regime already truncated-and-logged below (D5); at normal zoom the cursor
    // exhausts and every listed body is returned. Inert in Phase 1 (~no unlisted bodies), and the
    // real fix is the D49 zoom-scored display score (Phase 2) — re-adding the `listed` filter here
    // would ~halve the safe `maxResults` and reintroduce the wide-zoom crash this two-tier avoids.
    if (truncated) {
      console.warn(
        `listInViewport hit the ${effectiveLimit}-row prefilter cap; some bodies may be omitted at this zoom (D5/D49).`,
      );
    }
    const tier1 = await Promise.all(keys.slice(0, effectiveLimit).map((key) => ctx.db.get(key)));

    // Tier 2 — the handful of large bodies, which tier 1's small margin can't guarantee to catch.
    const tier2 = await ctx.db
      .query('waterBodies')
      .withIndex('by_is_large', (q) => q.eq('isLarge', true))
      .collect();

    // Merge (dedup by _id — a large body may surface in both tiers), then refine to true
    // bbox-intersection + current listing (tier 2 isn't `listed`-filtered by the index).
    const byId = new Map<Id<'waterBodies'>, Doc<'waterBodies'>>();
    for (const body of [...tier1, ...tier2]) {
      if (!body || !bboxIntersects(body.bbox, viewport) || !isListed(body)) continue;
      // D49 zoom cutoff — also applied to tier-2 (its short-list scan isn't sortKey-filtered). A
      // legacy body missing `minVisibleZoom` is treated as visible (never silently hidden).
      if (z !== undefined && body.minVisibleZoom !== undefined && body.minVisibleZoom > z) {
        continue;
      }
      byId.set(body._id, body);
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
 * The listed bodies worth testing a single coord against — the **read-cap-safe** candidate lookup
 * shared by `resolveBodyForCoord` and the Phase 8 track resolver (D44).
 *
 * Two tiers, matching `listInViewport`'s structure:
 *  - **Tier 1**, a centroid prefilter over a *small* rectangle around the point. Small is what makes
 *    this safe: the geospatial component reads roughly ∝ `maxResults` over an S2 cell covering, so a
 *    wide rectangle is the documented read-cap trap (roadmap Later/deferred) — a ~5 km box around one
 *    coord holds far fewer than the limit, so no pagination is needed.
 *  - **Tier 2**, every `isLarge` body, whose centroid can sit far outside the rectangle even though
 *    the coord is squarely on it (Champlain).
 *
 * Exported rather than copied so a future fix to the geospatial read shape lands in **one** place for
 * both callers; unlisted bodies are refined out here, in JS, for the same reason the viewport query
 * does it (`listed` is derived, and putting it in the geospatial filter halves the safe ceiling).
 */
export async function listedBodiesNearCoord(
  ctx: QueryCtx,
  coord: { lat: number; lng: number },
): Promise<Map<Id<'waterBodies'>, Doc<'waterBodies'>>> {
  const page = await waterBodiesGeo.query(ctx, {
    shape: {
      type: 'rectangle',
      rectangle: {
        west: coord.lng - VIEWPORT_MARGIN_DEG,
        east: coord.lng + VIEWPORT_MARGIN_DEG,
        south: coord.lat - VIEWPORT_MARGIN_DEG,
        north: coord.lat + VIEWPORT_MARGIN_DEG,
      },
    },
    limit: DEFAULT_VIEWPORT_LIMIT,
  });
  const tier1 = await Promise.all(page.results.map(({ key }) => ctx.db.get(key)));
  const tier2 = await ctx.db
    .query('waterBodies')
    .withIndex('by_is_large', (q) => q.eq('isLarge', true))
    .collect();

  const byId = new Map<Id<'waterBodies'>, Doc<'waterBodies'>>();
  for (const body of [...tier1, ...tier2]) {
    if (body && isListed(body)) byId.set(body._id, body);
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
    return ctx.db
      .query('waterBodies')
      .withIndex('by_review_status', (q) => q.eq('reviewStatus', 'pending'))
      .collect();
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
    const rows = await ctx.db
      .query('waterBodies')
      .withIndex('by_dedup_status', (q) => q.eq('dedupStatus', 'suspected_duplicate'))
      .take(100);
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
