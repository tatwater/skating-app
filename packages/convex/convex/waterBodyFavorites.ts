/**
 * Water-body favorites (Phase 4, decision #1) — place-based curation, the D13 stand-in for the
 * removed people-follow graph. A user favorites specific water bodies; those reports notify by
 * default (see `notifications.ts`), boost + badge in the feed (`reports.listFeed`), and highlight on
 * the map. You subscribe to *lakes*, not people.
 *
 * The join is indexed both directions (`by_user` for the viewer's set, `by_water_body` for the
 * notification fan-out) with a `by_user_water_body` point index enforcing one row per pair.
 */

import { ConvexError, v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import { mutation, type QueryCtx, query } from './_generated/server'
import { getCurrentProfile, requireProfile } from './lib/auth'
import { isListed } from './lib/listing'

/** The set of water-body ids a user has favorited — the shared read behind feed boost + map highlight. */
export async function loadFavoriteBodyIds(
  ctx: QueryCtx,
  userId: Id<'profiles'> | '',
): Promise<Set<string>> {
  if (userId === '') return new Set()
  const rows = await ctx.db
    .query('waterBodyFavorites')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect()
  return new Set(rows.map((r) => r.waterBodyId))
}

/** Look up the single favorite row for a `(user, body)` pair, or `null`. */
async function favoriteRow(ctx: QueryCtx, userId: Id<'profiles'>, waterBodyId: Id<'waterBodies'>) {
  return ctx.db
    .query('waterBodyFavorites')
    .withIndex('by_user_water_body', (q) => q.eq('userId', userId).eq('waterBodyId', waterBodyId))
    .unique()
}

/**
 * Toggle a water body as a favorite for the caller (idempotent per state). Returns the resulting
 * `favorited` boolean so the client can flip the heart without a refetch. Rejects a body that isn't
 * listed (removed/merged/rejected) so you can't favorite a delisted lake — an existing favorite of a
 * body that later delists is simply never surfaced (the feed/map read past it).
 */
export const toggle = mutation({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const profile = await requireProfile(ctx)
    const existing = await favoriteRow(ctx, profile._id, waterBodyId)
    if (existing) {
      await ctx.db.delete(existing._id)
      return { favorited: false }
    }
    const body = await ctx.db.get(waterBodyId)
    if (!body || !isListed(body)) throw new ConvexError('Water body not found')
    await ctx.db.insert('waterBodyFavorites', {
      userId: profile._id,
      waterBodyId,
      createdAt: Date.now(),
    })
    return { favorited: true }
  },
})

/** Whether the caller has favorited a given body (false when signed out). */
export const isFavorite = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const profile = await getCurrentProfile(ctx)
    if (!profile) return false
    return (await favoriteRow(ctx, profile._id, waterBodyId)) !== null
  },
})

/**
 * The caller's favorited bodies for a favorites list / map highlight — newest first, each resolved to
 * its surviving name (following `mergedIntoId`, D36) and dropping any that delisted since. Empty when
 * signed out.
 */
export const listForUser = query({
  args: {},
  handler: async (ctx) => {
    const profile = await getCurrentProfile(ctx)
    if (!profile) return []
    const rows = await ctx.db
      .query('waterBodyFavorites')
      .withIndex('by_user', (q) => q.eq('userId', profile._id))
      .order('desc')
      .collect()
    const out: { waterBodyId: Id<'waterBodies'>; name: string; createdAt: number }[] = []
    for (const row of rows) {
      let body = await ctx.db.get(row.waterBodyId)
      for (let hops = 0; body?.mergedIntoId !== undefined && hops < 8; hops++) {
        body = await ctx.db.get(body.mergedIntoId)
      }
      if (body && isListed(body)) {
        out.push({ waterBodyId: body._id, name: body.name, createdAt: row.createdAt })
      }
    }
    return out
  },
})
