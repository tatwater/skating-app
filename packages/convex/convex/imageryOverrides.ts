/**
 * **An admin's calls on single satellite passes over a body** (B01-3d) — the Imagery tab's *Show to
 * skaters anyway* (a pass the cloud or coverage gate hid; no reason asked, the row records who and
 * when) and *Hide from skaters* (a shown pass; a reason asked). A statement about one pass of a
 * satellite, never about the lake: an override can only add or remove a photograph from a body's
 * timeline, and nothing it does can make anything read as ice being safe.
 *
 * The skater timeline (`@skating/core`'s `buildBodyTimeline`, its `overrides` option) honors these
 * when the app passes them (`passOverrides`); with none, it is unchanged.
 */

import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type MutationCtx, mutation, query } from './_generated/server';
import { writeAudit } from './lib/audit';
import { requireCapability } from './lib/auth';
import { resolveSurvivor } from './lib/bodies';
import { literals } from './lib/validators';
import { editableBody } from './waterBodies';

/** The longest reason a hide records; the longest granule id and season label accepted. */
export const MAX_OVERRIDE_REASON_CHARS = 500;
const MAX_KEY_CHARS = 120;
/**
 * The most calls one body holds in a season (a season holds a few dozen passes per body) — bound at
 * the write, so the skater read, which takes this many, is always whole.
 */
export const OVERRIDES_READ = 200;

type Action = 'show' | 'hide';

/** A granule id or season label, normalized at the edge. */
function keyOf(raw: string, what: string): string {
  const key = raw.trim();
  if (key === '' || key.length > MAX_KEY_CHARS || /\s/.test(key)) {
    throw new ConvexError(`That is not a ${what}`);
  }
  return key;
}

/** Admin: set the call on one pass over a body — `show` it anyway, or `hide` it with a reason. */
export const set = mutation({
  args: {
    waterBodyId: v.id('waterBodies'),
    season: v.string(),
    granuleId: v.string(),
    action: literals(['show', 'hide']),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireCapability(ctx, 'machinery.imagery');
    return setOverrideImpl(ctx, actor, args);
  },
});

/** Admin: clear the call on one pass — the gates decide it again. */
export const clear = mutation({
  args: { waterBodyId: v.id('waterBodies'), season: v.string(), granuleId: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireCapability(ctx, 'machinery.imagery');
    return setOverrideImpl(ctx, actor, { ...args, action: null });
  },
});

/**
 * The one write behind `set`, `clear` and their undo (the same write of the previous call). Refused:
 * a merged-away body, a malformed pass key, a hide without a reason, a reason past
 * {@link MAX_OVERRIDE_REASON_CHARS}, a new call past {@link OVERRIDES_READ} in the season.
 */
export async function setOverrideImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  args: {
    waterBodyId: Id<'waterBodies'>;
    season: string;
    granuleId: string;
    action: Action | null;
    reason?: string;
    undoReason?: string;
  },
): Promise<Id<'waterBodies'>> {
  const body = await editableBody(ctx, args.waterBodyId);
  const season = keyOf(args.season, 'season');
  const granuleId = keyOf(args.granuleId, 'satellite pass');
  const reason = args.reason?.replace(/\s+/g, ' ').trim() ?? '';
  if (args.action === 'hide' && reason === '') {
    throw new ConvexError('Hiding a pass from skaters takes a reason');
  }
  if (reason.length > MAX_OVERRIDE_REASON_CHARS) {
    throw new ConvexError(`A reason is at most ${MAX_OVERRIDE_REASON_CHARS} characters`);
  }
  const existing = await ctx.db
    .query('imageryPassOverrides')
    .withIndex('by_body_granule', (q) => q.eq('waterBodyId', body._id).eq('granuleId', granuleId))
    .first();
  const prev = existing
    ? { action: existing.action, reason: existing.reason ?? null }
    : { action: null, reason: null };
  if (args.action !== null && existing?.season !== season) {
    const held = await ctx.db
      .query('imageryPassOverrides')
      .withIndex('by_body_season_at', (q) => q.eq('waterBodyId', body._id).eq('season', season))
      .take(OVERRIDES_READ);
    if (held.length >= OVERRIDES_READ) {
      throw new ConvexError(
        `A body holds at most ${OVERRIDES_READ} calls on passes in a season — clear one first`,
      );
    }
  }
  const now = Date.now();
  if (args.action === null) {
    if (existing) await ctx.db.delete(existing._id);
  } else {
    const fields = {
      waterBodyId: body._id,
      season,
      granuleId,
      action: args.action,
      reason: args.action === 'hide' ? reason : undefined,
      byUserId: actor._id,
      at: now,
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert('imageryPassOverrides', fields);
  }
  await writeAudit(ctx, {
    actorId: actor._id,
    action: 'set_imagery_override',
    targetType: 'waterbody',
    targetId: body._id,
    reason:
      args.undoReason ??
      (args.action === null
        ? `Cleared the call on the ${granuleId} pass`
        : args.action === 'show'
          ? `Showed the ${granuleId} pass to skaters anyway`
          : `Hid the ${granuleId} pass from skaters: ${reason}`),
    metadata: {
      season,
      granuleId,
      action: args.action,
      ...(args.action === 'hide' ? { overrideReason: reason } : {}),
      prev,
    },
    createdAt: now,
  });
  return body._id;
}

/**
 * **The calls on a body's passes, for skaters' timelines** — granule id and call only (no person, no
 * reason), for `buildBodyTimeline`'s `overrides`. Public, like the season index it qualifies. A
 * merged-away id reads its survivor's.
 */
export const passOverrides = query({
  args: { waterBodyId: v.id('waterBodies'), season: v.string() },
  handler: async (ctx, { waterBodyId, season }) => {
    const body = await resolveSurvivor(ctx, waterBodyId);
    if (!body) return [];
    const rows = await ctx.db
      .query('imageryPassOverrides')
      .withIndex('by_body_season_at', (q) =>
        q.eq('waterBodyId', body._id).eq('season', season.trim()),
      )
      .take(OVERRIDES_READ);
    return rows.map((r) => ({ granuleId: r.granuleId, action: r.action }));
  },
});

/**
 * **The calls on a body's passes, for the Imagery tab** (`body.read`) — each with who made it, when,
 * and a hide's reason; newest first within the season; `capped` past {@link OVERRIDES_READ}.
 */
export const forBody = query({
  args: { waterBodyId: v.id('waterBodies'), season: v.string() },
  handler: async (ctx, { waterBodyId, season }) => {
    await requireCapability(ctx, 'body.read');
    const body = await resolveSurvivor(ctx, waterBodyId);
    if (!body) return { overrides: [], capped: false };
    // Newest first from the index, so the cap never drops a newer call for an older one.
    const rows = await ctx.db
      .query('imageryPassOverrides')
      .withIndex('by_body_season_at', (q) =>
        q.eq('waterBodyId', body._id).eq('season', season.trim()),
      )
      .order('desc')
      .take(OVERRIDES_READ + 1);
    const people = new Map<string, { userId: Id<'profiles'>; displayName: string } | null>();
    const out = [];
    for (const r of rows.slice(0, OVERRIDES_READ)) {
      let by = people.get(r.byUserId);
      if (by === undefined) {
        const p = await ctx.db.get(r.byUserId);
        by = p ? { userId: p._id, displayName: p.displayName } : null;
        people.set(r.byUserId, by);
      }
      out.push({
        granuleId: r.granuleId,
        action: r.action,
        reason: r.reason ?? null,
        at: r.at,
        by,
      });
    }
    return { overrides: out, capped: rows.length > OVERRIDES_READ };
  },
});
