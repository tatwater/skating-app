/**
 * Water-body functions.
 *
 * Canonical (OSM/NHD) bodies arrive via the internal `importCanonical` upsert (D14/D48) and
 * are auto-listed. User-created bodies are **auto-visible then reviewed-after** (D37):
 * `create` writes a `pending` body immediately (still listed), and a moderator later resolves
 * it via `approve`. Admins can `remove`/`restore` any body — a reversible soft-delist (D48).
 * Whether a body shows on the public map is the derived `listed` boolean (see `./lib/listing`),
 * indexed as the geospatial filter key and queried by `listInViewport`.
 */

import { bboxIntersects, WATER_BODY_TYPES } from '@skating/core'
import { ConvexError, v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, mutation, query } from './_generated/server'
import { requireProfile, requireRole } from './lib/auth'
import { CANONICAL_SOURCES, REMOVAL_REASONS } from './lib/enums'
import { waterBodiesGeo } from './lib/geospatial'
import { isListed } from './lib/listing'
import { bbox, geoJson, latLng, literals } from './lib/validators'

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
const VIEWPORT_MARGIN_DEG = 0.05
const LARGE_BODY_EXTENT_DEG = 0.05
/** Cap on the tier-1 centroid prefilter — a backstop against a state-level zoom pulling the whole
 *  corpus; truncation is logged, never silent (D5). The real fix is the D49 display score (Phase 2). */
const DEFAULT_VIEWPORT_LIMIT = 512
/** Hard ceiling on the (client-supplied) tier-1 limit, so a huge value can't page past the query
 *  read budget. See `sanitizeLimit`. */
const MAX_VIEWPORT_LIMIT = 1024

/**
 * `listInViewport.limit` is public, client-supplied input, so guard it (D5/D37 — validate at the
 * trust boundary): a `0`/negative/non-integer value would leave the tier-1 key set empty, silently
 * returning *only* large bodies; a huge value would page until the query blew its read budget.
 * Fall back to the default for anything that isn't a positive integer, and clamp to the ceiling.
 */
function sanitizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) return DEFAULT_VIEWPORT_LIMIT
  return Math.min(limit, MAX_VIEWPORT_LIMIT)
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
})

/** Largest span of a bbox in either axis, in degrees. */
function bboxExtentDeg(b: { minLat: number; minLng: number; maxLat: number; maxLng: number }) {
  return Math.max(b.maxLat - b.minLat, b.maxLng - b.minLng)
}

/** Whether a body is a `listInViewport` tier-2 outlier — bbox wider than the centroid margin (D5). */
function isLargeBody(b: { minLat: number; minLng: number; maxLat: number; maxLng: number }) {
  return bboxExtentDeg(b) > LARGE_BODY_EXTENT_DEG
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
  args: { bodies: v.array(canonicalBody) },
  handler: async (ctx, { bodies }) => {
    let inserted = 0
    let updated = 0
    for (const item of bodies) {
      const existing = await ctx.db
        .query('waterBodies')
        .withIndex('by_external_id', (q) =>
          q.eq('source', item.source).eq('externalId', item.externalId),
        )
        .unique()

      if (existing) {
        // Patch geometry/name/area only; removed*/reviewStatus/dedupStatus are preserved.
        await ctx.db.patch(existing._id, {
          name: item.name,
          type: item.type,
          polygon: item.polygon,
          bbox: item.bbox,
          centroid: item.centroid,
          isLarge: isLargeBody(item.bbox),
          surfaceAreaSqM: item.surfaceAreaSqM,
        })
        // Re-derive listing from the preserved fields (removed stays removed, D48).
        await waterBodiesGeo.insert(
          ctx,
          existing._id,
          { latitude: item.centroid.lat, longitude: item.centroid.lng },
          { listed: isListed(existing) },
          existing.createdAt,
        )
        updated++
      } else {
        const now = Date.now()
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
          dedupStatus: 'clean', // default (D36)
          createdAt: now,
        })
        await waterBodiesGeo.insert(
          ctx,
          id,
          { latitude: item.centroid.lat, longitude: item.centroid.lng },
          { listed: true },
          now,
        )
        inserted++
      }
    }
    return { inserted, updated }
  },
})

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
    const bodies = await ctx.db.query('waterBodies').collect()
    for (const body of bodies) {
      const isLarge = isLargeBody(body.bbox)
      if (body.isLarge !== isLarge) await ctx.db.patch(body._id, { isLarge })
      await waterBodiesGeo.insert(
        ctx,
        body._id,
        { latitude: body.centroid.lat, longitude: body.centroid.lng },
        { listed: isListed(body) },
        body.createdAt,
      )
    }
    return { reindexed: bodies.length }
  },
})

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
    const profile = await requireProfile(ctx)
    // TODO(D36): match-on-create dedup (bbox prefilter → Turf IoU / name similarity)
    // to steer onto an existing body before inserting. Stubbed for the v1 scaffold.
    const now = Date.now()
    const id = await ctx.db.insert('waterBodies', {
      name: args.name,
      type: args.type,
      source: 'user',
      polygon: args.polygon,
      bbox: args.bbox,
      centroid: args.centroid,
      isLarge: isLargeBody(args.bbox),
      surfaceAreaSqM: args.surfaceAreaSqM,
      createdByUserId: profile._id,
      reviewStatus: 'pending', // auto-visible, review-after (D37)
      dedupStatus: 'clean', // default (D36)
      createdAt: now,
    })
    // Index the centroid for viewport lookups (D5); a pending user body is auto-visible
    // (D37/D48), so it lists immediately — `listed` is the filter key public queries use.
    await waterBodiesGeo.insert(
      ctx,
      id,
      { latitude: args.centroid.lat, longitude: args.centroid.lng },
      { listed: isListed({ reviewStatus: 'pending', dedupStatus: 'clean' }) },
      now,
    )
    return id
  },
})

/** Moderator/admin: approve a pending user-created body + write the audit row (D37). */
export const approve = mutation({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, args) => {
    const actor = await requireRole(ctx, 'moderator')
    const body = await ctx.db.get(args.waterBodyId)
    if (!body) throw new ConvexError('Water body not found')
    // Only user-created bodies enter the review queue; approving canonical (OSM/NHD)
    // bodies is meaningless and would stamp a `reviewStatus` they shouldn't have.
    if (body.source !== 'user') {
      throw new ConvexError('Only user-created water bodies can be reviewed')
    }
    // Idempotency + audit integrity: only a pending body can be approved, so we never
    // reverse a rejection or write duplicate audit rows on a re-approve.
    if (body.reviewStatus !== 'pending') {
      throw new ConvexError('Water body is not pending review')
    }

    await ctx.db.patch(args.waterBodyId, { reviewStatus: 'approved' })
    // Keep the geospatial filter key in sync with the new listing (still listed, D48).
    await waterBodiesGeo.insert(
      ctx,
      args.waterBodyId,
      { latitude: body.centroid.lat, longitude: body.centroid.lng },
      { listed: isListed({ ...body, reviewStatus: 'approved' }) },
      body.createdAt,
    )
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'approve_waterbody',
      targetType: 'waterbody',
      targetId: args.waterBodyId,
      reason: 'Approved user-created water body',
      createdAt: Date.now(),
    })
    return args.waterBodyId
  },
})

/**
 * Admin: soft-delist a body from the map — curation or a landowner takedown (D48). Reversible
 * (never a hard delete): stamp `removed*`, flip `listed` off in the geospatial index, and
 * write a `moderationActions` audit row. A re-import preserves this (see `importCanonical`).
 */
export const remove = mutation({
  args: { waterBodyId: v.id('waterBodies'), reason: literals(REMOVAL_REASONS) },
  handler: async (ctx, args) => {
    const actor = await requireRole(ctx, 'admin')
    const body = await ctx.db.get(args.waterBodyId)
    if (!body) throw new ConvexError('Water body not found')
    // Idempotency + no duplicate audit rows: only an on-map body can be removed.
    if (body.removedAt !== undefined) throw new ConvexError('Water body is already removed')

    const now = Date.now()
    await ctx.db.patch(args.waterBodyId, {
      removedAt: now,
      removedByUserId: actor._id,
      removalReason: args.reason,
    })
    await waterBodiesGeo.insert(
      ctx,
      args.waterBodyId,
      { latitude: body.centroid.lat, longitude: body.centroid.lng },
      { listed: isListed({ ...body, removedAt: now }) },
      body.createdAt,
    )
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'remove',
      targetType: 'waterbody',
      targetId: args.waterBodyId,
      reason: `Removed from map (${args.reason})`,
      metadata: { removalReason: args.reason },
      createdAt: now,
    })
    return args.waterBodyId
  },
})

/** Admin: reverse a removal — clear `removed*`, re-derive `listed`, audit the restore (D48). */
export const restore = mutation({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, args) => {
    const actor = await requireRole(ctx, 'admin')
    const body = await ctx.db.get(args.waterBodyId)
    if (!body) throw new ConvexError('Water body not found')
    if (body.removedAt === undefined) throw new ConvexError('Water body is not removed')

    await ctx.db.patch(args.waterBodyId, {
      removedAt: undefined,
      removedByUserId: undefined,
      removalReason: undefined,
    })
    await waterBodiesGeo.insert(
      ctx,
      args.waterBodyId,
      { latitude: body.centroid.lat, longitude: body.centroid.lng },
      { listed: isListed({ ...body, removedAt: undefined }) },
      body.createdAt,
    )
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: 'restore',
      targetType: 'waterbody',
      targetId: args.waterBodyId,
      reason: 'Restored to the map',
      createdAt: Date.now(),
    })
    return args.waterBodyId
  },
})

/**
 * Public: water bodies whose **bbox intersects** the viewport (D5/D48). Two-tier — see the
 * `VIEWPORT_MARGIN_DEG` / `LARGE_BODY_EXTENT_DEG` note above for why:
 *  - **Tier 1:** a centroid prefilter over the viewport + a small margin (`listed == true`),
 *    catching every non-large body.
 *  - **Tier 2:** the `by_is_large` short list, whose bodies can have off-screen centroids.
 * Both tiers are refined by `bboxIntersects` + `isListed`, then merged (a large body can appear
 * in both). `listed` filters to canonical + auto-visible/approved user bodies (not rejected,
 * merged, or removed).
 */
export const listInViewport = query({
  args: { viewport: bbox, limit: v.optional(v.number()) },
  handler: async (ctx, { viewport, limit }) => {
    const effectiveLimit = sanitizeLimit(limit)

    // Tier 1 — centroid prefilter over the viewport expanded by the (small) margin. The
    // geospatial `query` bounds work per call and returns a *partial* page plus a continuation
    // cursor, so we page through it, accumulating up to `effectiveLimit` centroids. Stopping with
    // a cursor still pending means we capped a wide zoom — the D5 truncation, surfaced in logs
    // rather than dropped silently (D49 display score is the real fix, Phase 2).
    const rectangle = {
      west: viewport.minLng - VIEWPORT_MARGIN_DEG,
      east: viewport.maxLng + VIEWPORT_MARGIN_DEG,
      south: viewport.minLat - VIEWPORT_MARGIN_DEG,
      north: viewport.maxLat + VIEWPORT_MARGIN_DEG,
    }
    const keys: Id<'waterBodies'>[] = []
    let cursor: string | undefined
    let truncated = false
    do {
      const page = await waterBodiesGeo.query(
        ctx,
        {
          shape: { type: 'rectangle', rectangle },
          filter: (q) => q.eq('listed', true),
          limit: effectiveLimit,
        },
        cursor,
      )
      for (const { key } of page.results) keys.push(key)
      cursor = page.nextCursor
      if (keys.length >= effectiveLimit && cursor !== undefined) truncated = true
    } while (cursor !== undefined && keys.length < effectiveLimit)
    if (truncated) {
      console.warn(
        `listInViewport hit the ${effectiveLimit}-row prefilter cap; some bodies may be omitted at this zoom (D5/D49).`,
      )
    }
    const tier1 = await Promise.all(keys.slice(0, effectiveLimit).map((key) => ctx.db.get(key)))

    // Tier 2 — the handful of large bodies, which tier 1's small margin can't guarantee to catch.
    const tier2 = await ctx.db
      .query('waterBodies')
      .withIndex('by_is_large', (q) => q.eq('isLarge', true))
      .collect()

    // Merge (dedup by _id — a large body may surface in both tiers), then refine to true
    // bbox-intersection + current listing (tier 2 isn't `listed`-filtered by the index).
    const byId = new Map<Id<'waterBodies'>, Doc<'waterBodies'>>()
    for (const body of [...tier1, ...tier2]) {
      if (body && bboxIntersects(body.bbox, viewport) && isListed(body)) byId.set(body._id, body)
    }
    return [...byId.values()]
  },
})

/** Moderator/admin: the after-the-fact review queue of pending user bodies (D37). */
export const listPendingReview = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, 'moderator')
    return ctx.db
      .query('waterBodies')
      .withIndex('by_review_status', (q) => q.eq('reviewStatus', 'pending'))
      .collect()
  },
})
