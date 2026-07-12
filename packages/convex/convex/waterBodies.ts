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
import { internalMutation, mutation, query } from './_generated/server'
import { requireProfile, requireRole } from './lib/auth'
import { REMOVAL_REASONS } from './lib/enums'
import { waterBodiesGeo } from './lib/geospatial'
import { isListed } from './lib/listing'
import { bbox, geoJson, latLng, literals } from './lib/validators'

/**
 * Viewport prefilter tuning (D5). The geospatial component indexes *points* (centroids), but
 * "in view" means **bbox intersects the viewport** — a large lake fills the screen with its
 * centroid off-screen. So we query the centroid index over the viewport *expanded by the
 * largest body's bbox extent*: if a body's bbox intersects the viewport, its centroid lies
 * within one body-extent of it, so this superset can't miss it. We then refine each candidate
 * with `bboxIntersects`. `MAX_BODY_EXTENT_DEG` must exceed the largest stored body's bbox span
 * in either axis (Vermont's driver is Lake Champlain, ~1.8° of latitude); tune against the
 * real corpus once the ETL lands. The zoom-scored replacement is D49 (Phase 2).
 */
const MAX_BODY_EXTENT_DEG = 2
/** Pilot cap on the centroid prefilter. Raised from 64 so a wide zoom doesn't silently drop
 *  most of Vermont before the refine; a true fix is the D49 display score (Phase 2). */
const DEFAULT_VIEWPORT_LIMIT = 512

/** A canonical (OSM/NHD) body as prepared by the ETL, keyed by its source id. */
const canonicalBody = v.object({
  externalId: v.string(),
  name: v.string(),
  type: literals(WATER_BODY_TYPES),
  polygon: geoJson,
  bbox,
  centroid: latLng, // the on-water representative point (D48)
  surfaceAreaSqM: v.optional(v.number()),
})

/**
 * Internal, never client-callable: idempotently upsert a batch of canonical OSM bodies
 * (D14/D48). Load via `pnpm exec convex run` from the ETL (chunk batches for the mutation
 * size limit). Keyed on `by_external_id` (`source: 'osm'`):
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
        .withIndex('by_external_id', (q) => q.eq('source', 'osm').eq('externalId', item.externalId))
        .unique()

      if (existing) {
        // Patch geometry/name/area only; removed*/reviewStatus/dedupStatus are preserved.
        await ctx.db.patch(existing._id, {
          name: item.name,
          type: item.type,
          polygon: item.polygon,
          bbox: item.bbox,
          centroid: item.centroid,
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
          source: 'osm',
          externalId: item.externalId,
          polygon: item.polygon,
          bbox: item.bbox,
          centroid: item.centroid,
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
 * Public: water bodies whose **bbox intersects** the viewport (D5/D48).
 *
 * Filters `listed == true` (canonical + auto-visible/approved user bodies; not rejected,
 * merged, or removed). Implements the decided bbox-intersection semantic: a superset
 * centroid prefilter over the viewport expanded by `MAX_BODY_EXTENT_DEG`, then a
 * `bboxIntersects` refine so a large lake with an off-screen centroid is still returned.
 */
export const listInViewport = query({
  args: { viewport: bbox, limit: v.optional(v.number()) },
  handler: async (ctx, { viewport, limit }) => {
    const effectiveLimit = limit ?? DEFAULT_VIEWPORT_LIMIT
    const { results } = await waterBodiesGeo.query(ctx, {
      shape: {
        type: 'rectangle',
        rectangle: {
          west: viewport.minLng - MAX_BODY_EXTENT_DEG,
          east: viewport.maxLng + MAX_BODY_EXTENT_DEG,
          south: viewport.minLat - MAX_BODY_EXTENT_DEG,
          north: viewport.maxLat + MAX_BODY_EXTENT_DEG,
        },
      },
      filter: (q) => q.eq('listed', true),
      limit: effectiveLimit,
    })
    // The cap truncates the prefilter *before* the refine, so a wide zoom can silently drop
    // bodies. Surface it in logs rather than hiding it (D5); D49 is the real fix (Phase 2).
    if (results.length === effectiveLimit) {
      console.warn(
        `listInViewport hit the ${effectiveLimit}-row prefilter cap; some bodies may be omitted at this zoom (D5/D49).`,
      )
    }
    const bodies = await Promise.all(results.map(({ key }) => ctx.db.get(key)))
    // Refine the centroid-superset down to true bbox-intersection (drops nulls too).
    return bodies.filter(
      (body): body is NonNullable<typeof body> =>
        body !== null && bboxIntersects(body.bbox, viewport),
    )
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
