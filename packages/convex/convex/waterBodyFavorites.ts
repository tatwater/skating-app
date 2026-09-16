/**
 * Water-body favorites (Phase 4, decision #1) — place-based curation, the D13 stand-in for the
 * removed people-follow graph. A user favorites specific water bodies; those reports notify by
 * default (see `notifications.ts`), boost + badge in the feed (`reports.listFeed`), and highlight on
 * the map. You subscribe to *lakes*, not people.
 *
 * **Since N9 a favorite can name a bay** (D175). A bay favorite still carries the parent's
 * `waterBodyId`, so the fan-out's one `by_water_body` scan finds both audiences; it then applies
 * only to reports whose *membership* includes the bay. Wanting to hear about Malletts Bay is a
 * different statement from wanting all of Champlain, and only the user can make it — which is why
 * this is stored rather than derived from anything.
 *
 * The join is indexed both directions (`by_user` for the viewer's set, `by_water_body` for the
 * notification fan-out) with a `by_user_water_body_sub_area` point index enforcing one row per
 * user × body × bay; the lake row is the one whose `subAreaId` is `undefined`, which an optional-field
 * index stores as a real key.
 */

import { standingOf } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { mutation, type QueryCtx, query } from './_generated/server';
import { getCurrentProfile, requireProfile } from './lib/auth';
import { resolveSurvivor } from './lib/bodies';
import { isListed } from './lib/listing';
import { subAreaListed } from './subAreas';

/**
 * A viewer's favorites, split the way the two consumers need them (N9): lake favorites by body id,
 * bay favorites by bay id. The feed boost asks "is this *report* favorited" (`isFavoriteReport` in
 * `@skating/core`), which a bay favorite answers only for reports inside the bay; the map highlight
 * and discovery ask "is this *lake* favorited", which either kind answers — see
 * {@link loadFavoriteBodyIds}.
 */
export interface ViewerFavorites {
  bodyIds: Set<string>;
  subAreaIds: Set<string>;
}

export async function loadFavorites(
  ctx: QueryCtx,
  userId: Id<'profiles'> | '',
): Promise<ViewerFavorites> {
  const out: ViewerFavorites = { bodyIds: new Set(), subAreaIds: new Set() };
  if (userId === '') return out;
  const rows = await ctx.db
    .query('waterBodyFavorites')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect();
  for (const row of rows) {
    if (row.subAreaId === undefined) out.bodyIds.add(row.waterBodyId);
    else out.subAreaIds.add(row.subAreaId);
  }
  return out;
}

/**
 * The bodies a user has any favorite on — the lake itself, or a bay of it. The read behind the map
 * highlight and weather discovery's favorite chip, both of which are about the *lake*: a bay only
 * draws at z ≥ 10, so the parent is what gets pinned (N9 kickoff, favorites UX).
 */
export async function loadFavoriteBodyIds(
  ctx: QueryCtx,
  userId: Id<'profiles'> | '',
): Promise<Set<string>> {
  if (userId === '') return new Set();
  const rows = await ctx.db
    .query('waterBodyFavorites')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect();
  return new Set(rows.map((r) => r.waterBodyId));
}

/** Look up the single favorite row for a `(user, body, bay?)` triple, or `null`. */
async function favoriteRow(
  ctx: QueryCtx,
  userId: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
  subAreaId: Id<'waterBodySubAreas'> | undefined,
) {
  return ctx.db
    .query('waterBodyFavorites')
    .withIndex('by_user_water_body_sub_area', (q) =>
      q.eq('userId', userId).eq('waterBodyId', waterBodyId).eq('subAreaId', subAreaId),
    )
    .unique();
}

/**
 * Toggle a water body — or one named bay of it (N9) — as a favorite for the caller (idempotent per
 * state). Returns the resulting `favorited` boolean so the client can flip the heart without a
 * refetch. Rejects a body that isn't listed (removed/merged/rejected) so you can't favorite a
 * delisted lake, and a bay that isn't live on *this* body — the same cross-lake pairing check the
 * bay feed makes, because the bay id alone would otherwise let a favorite name Champlain's bay under
 * Morey's id. An existing favorite of a body or bay that later delists is simply never surfaced.
 */
export const toggle = mutation({
  args: { waterBodyId: v.id('waterBodies'), subAreaId: v.optional(v.id('waterBodySubAreas')) },
  handler: async (ctx, { waterBodyId, subAreaId }) => {
    const profile = await requireProfile(ctx);
    const existing = await favoriteRow(ctx, profile._id, waterBodyId, subAreaId);
    if (existing) {
      await ctx.db.delete(existing._id);
      return { favorited: false };
    }
    const body = await ctx.db.get(waterBodyId);
    // A dormant lake can be favourited — *"if you favourited it, you know something we don't"*, and
    // a favourite is what keeps it from going dormant again. A removed one cannot (N7b): a takedown
    // is the one standing a favourite must not quietly subscribe someone to.
    if (!body || !isListed(body) || standingOf(body).standing === 'removed') {
      throw new ConvexError('Water body not found');
    }
    if (subAreaId !== undefined) {
      const subArea = await ctx.db.get(subAreaId);
      if (!subArea || subArea.waterBodyId !== waterBodyId || !subAreaListed(subArea, body)) {
        throw new ConvexError('That sub-area is not on this water body');
      }
    }
    await ctx.db.insert('waterBodyFavorites', {
      userId: profile._id,
      waterBodyId,
      ...(subAreaId !== undefined ? { subAreaId } : {}),
      createdAt: Date.now(),
    });
    return { favorited: true };
  },
});

/** Whether the caller has favorited a given body, or a given bay of it (false when signed out). */
export const isFavorite = query({
  args: { waterBodyId: v.id('waterBodies'), subAreaId: v.optional(v.id('waterBodySubAreas')) },
  handler: async (ctx, { waterBodyId, subAreaId }) => {
    const profile = await getCurrentProfile(ctx);
    if (!profile) return false;
    return (await favoriteRow(ctx, profile._id, waterBodyId, subAreaId)) !== null;
  },
});

/**
 * The caller's favorites for a favorites list / map highlight — newest first, each resolved to its
 * surviving lake (following `mergedIntoId`, D36) and dropping any that delisted since. A bay
 * favorite carries the bay's id and name beside the lake's, so the list can read *"Malletts Bay ·
 * Lake Champlain"* and navigate to `?sub=`; a favorite of a delisted bay is skipped, not surfaced.
 * Empty when signed out.
 */
export const listForUser = query({
  args: {},
  handler: async (ctx) => {
    const profile = await getCurrentProfile(ctx);
    if (!profile) return [];
    const rows = await ctx.db
      .query('waterBodyFavorites')
      .withIndex('by_user', (q) => q.eq('userId', profile._id))
      .order('desc')
      .collect();
    const out: {
      waterBodyId: Id<'waterBodies'>;
      name: string;
      createdAt: number;
      subAreaId?: Id<'waterBodySubAreas'>;
      subAreaName?: string;
    }[] = [];
    for (const row of rows) {
      const body = await resolveSurvivor(ctx, row.waterBodyId);
      if (!body || !isListed(body) || standingOf(body).standing === 'removed') continue;
      if (row.subAreaId === undefined) {
        out.push({ waterBodyId: body._id, name: body.name, createdAt: row.createdAt });
        continue;
      }
      const subArea = await ctx.db.get(row.subAreaId);
      if (!subArea || !subAreaListed(subArea, body)) continue;
      out.push({
        waterBodyId: body._id,
        name: body.name,
        createdAt: row.createdAt,
        subAreaId: subArea._id,
        subAreaName: subArea.name,
      });
    }
    return out;
  },
});
