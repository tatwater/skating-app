/**
 * The shell's search reads that aren't a search (B03 §11).
 *
 * `resolveRecents` turns the search plate's Recent picks — stored on the device as `{ kind, id }` —
 * back into display rows in one round trip, replacing a full `waterBodies.get`, `subAreas.listForBody`
 * or `profiles.getPublicProfile` per pick. Each row carries only what the Recent group draws, and a
 * pick that no longer resolves (a removed lake, a deleted bay, a person you can no longer see) comes
 * back `null` in its place, so the client drops it rather than drawing it half-known.
 */

import { normalizeUsername, type SilhouetteData, silhouetteRings, standingOf } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { query } from './_generated/server';
import { getCurrentProfile } from './lib/auth';
import { publicAuthor } from './lib/authorView';
import { resolveSurvivor } from './lib/bodies';
import { isListed } from './lib/listing';
import { profileAccess } from './lib/reportVisibility';

/** The most picks one call resolves — the Recent group shows six. */
export const RECENTS_MAX = 6;

const recentPick = v.union(
  v.object({ kind: v.literal('water_body'), id: v.string() }),
  /** A bay, by its own `waterBodySubAreas` id. */
  v.object({ kind: v.literal('sub_area'), id: v.string() }),
  /** A skater, by username. */
  v.object({ kind: v.literal('skater'), id: v.string() }),
);

type Outline = Pick<SilhouetteData, 'rings' | 'bbox'>;

type RecentRow =
  | {
      kind: 'water_body';
      id: string;
      waterBodyId: string;
      name: string;
      type: Doc<'waterBodies'>['type'];
      states: string[];
      inactive?: true;
      outline?: Outline;
    }
  | {
      kind: 'sub_area';
      id: string;
      waterBodyId: string;
      name: string;
      parentName: string;
      outline?: Outline;
    }
  | {
      kind: 'skater';
      id: string;
      username: string;
      displayName: string;
      profileImageUrl?: string;
      trustClass: ReturnType<typeof publicAuthor>['trustClass'];
      /** A private profile: name and avatar, nothing to browse (D13). */
      private?: true;
    };

/**
 * The outline at card scale (`silhouetteRings`, the feed card's own simplification), or nothing for
 * a shape that isn't a polygon. The doc is already loaded for its name, so the cost is the
 * simplification alone — bounded by `SILHOUETTE_MAX_POINTS` on the way out and by six picks in.
 */
function outlineOf(polygon: Doc<'waterBodies'>['polygon']): { outline?: Outline } {
  if (polygon.type !== 'Polygon' && polygon.type !== 'MultiPolygon') return {};
  const { rings, bbox } = silhouetteRings(polygon as never);
  return rings.length > 0 ? { outline: { rings, bbox } } : {};
}

/**
 * The Recent group's rows (B03 §11), in pick order, `null` where a pick no longer resolves. The same
 * gates as the reads it replaces: a lake follows its merge (D36) and must be listed and not taken
 * down (A07b) — a dormant one comes back marked `inactive`, as search marks it; a bay must be live
 * on a lake that is; a skater answers to `profileAccess` — hidden is `null`, private is name and
 * avatar only.
 */
export const resolveRecents = query({
  args: { picks: v.array(recentPick) },
  handler: async (ctx, { picks }): Promise<(RecentRow | null)[]> => {
    if (picks.length > RECENTS_MAX) {
      throw new ConvexError(`At most ${RECENTS_MAX} recent picks per call`);
    }
    const now = Date.now();
    const viewer = await getCurrentProfile(ctx);
    const rows: (RecentRow | null)[] = [];
    for (const pick of picks) {
      if (pick.kind === 'water_body') {
        const id = ctx.db.normalizeId('waterBodies', pick.id);
        const body = id ? await resolveSurvivor(ctx, id) : null;
        const standing = body ? standingOf(body).standing : 'removed';
        if (!body || !isListed(body) || standing === 'removed') {
          rows.push(null);
          continue;
        }
        rows.push({
          kind: 'water_body',
          id: pick.id,
          waterBodyId: body._id,
          name: body.name,
          type: body.type,
          states: body.states ?? [],
          ...(standing !== 'active' ? { inactive: true as const } : {}),
          ...outlineOf(body.polygon),
        });
      } else if (pick.kind === 'sub_area') {
        const id = ctx.db.normalizeId('waterBodySubAreas', pick.id);
        const bay = id ? await ctx.db.get(id) : null;
        const parent =
          bay && bay.removedAt === undefined ? await ctx.db.get(bay.waterBodyId) : null;
        if (!bay || !parent || !isListed(parent) || standingOf(parent).standing !== 'active') {
          rows.push(null);
          continue;
        }
        rows.push({
          kind: 'sub_area',
          id: pick.id,
          waterBodyId: parent._id,
          name: bay.name,
          parentName: parent.name,
          ...outlineOf(bay.polygon),
        });
      } else {
        const handle = normalizeUsername(pick.id);
        const target = handle
          ? await ctx.db
              .query('profiles')
              .withIndex('by_username', (q) => q.eq('username', handle))
              .unique()
          : null;
        const access = target ? await profileAccess(ctx, target, viewer) : 'hidden';
        if (!target || access === 'hidden') {
          rows.push(null);
          continue;
        }
        const author = publicAuthor(target, now);
        rows.push({
          kind: 'skater',
          id: pick.id,
          username: target.username,
          displayName: author.displayName,
          ...(author.profileImageUrl !== undefined
            ? { profileImageUrl: author.profileImageUrl }
            : {}),
          trustClass: author.trustClass,
          ...(access === 'private' ? { private: true as const } : {}),
        });
      }
    }
    return rows;
  },
});
