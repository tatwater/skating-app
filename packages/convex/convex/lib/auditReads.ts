/**
 * The audit log's reads, one rule each. {@link auditRowsOn} — one target's rows, newest first
 * (`moderation.listActions`): with a verb, the `by_target_action` range, so the filter is in the index
 * rather than over a page already capped; without one, `by_target`. {@link auditLinksOnBody} — the
 * rows that concern one body (`bodyConsole.history`), through `auditBodyLinks`; its body-only rows
 * are the ones `auditRowsOn` reads for that `waterbody` target. {@link auditTargetLabel} — the name a
 * row's target goes by, for the feed.
 */
import { SCOPE_ALL } from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import type { ModerationAction, ModerationTargetType } from './audit';
import { personRowOf, rowlessProfile } from './peopleRows';

/**
 * **The name an audit row's target goes by**, for the feed (S5): a body's from its stored library
 * row (one indexed read; never the body document, whose outline is the cost), a person's display
 * name. `null` for every other kind, and for a body or person no longer there.
 */
export async function auditTargetLabel(
  ctx: QueryCtx,
  targetType: ModerationTargetType,
  targetId: string,
): Promise<string | null> {
  if (targetType === 'waterbody') {
    const id = ctx.db.normalizeId('waterBodies', targetId);
    if (id === null) return null;
    const row = await ctx.db
      .query('bodyLibraryRows')
      .withIndex('by_body', (q) => q.eq('waterBodyId', id).eq('scope', SCOPE_ALL))
      .first();
    return row?.name ?? null;
  }
  if (targetType === 'user') {
    // The person's light People row, never their profile: a feed or History names a person once a
    // row, and a profile can weigh a whole document. Someone with no row yet (before the People rows
    // backfill) is read in full while the request's profile budget lasts, then left unnamed.
    const id = ctx.db.normalizeId('profiles', targetId);
    if (id === null) return null;
    const row = await personRowOf(ctx, id);
    if (row) return row.displayName.trim() || row.username;
    const person = await rowlessProfile(ctx, id);
    return person ? person.displayName.trim() || person.username : null;
  }
  return null;
}

export function auditRowsOn(
  ctx: QueryCtx,
  target: { targetType: ModerationTargetType; targetId: string; action?: ModerationAction },
  take: number,
): Promise<Doc<'moderationActions'>[]> {
  const { targetType, targetId, action } = target;
  return action === undefined
    ? ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
        .order('desc')
        .take(take)
    : ctx.db
        .query('moderationActions')
        .withIndex('by_target_action', (q) =>
          q.eq('targetType', targetType).eq('targetId', targetId).eq('action', action),
        )
        .order('desc')
        .take(take);
}

/**
 * The audit rows that concern one body, newest first, as their links (`auditBodyLinks`) — **one rule
 * for every reader** of a body's history: `bodyConsole.history` reads it once per body in the merge
 * chain, and with `bodyOnly` it holds the rows `moderation.listActions` reads for that `waterbody`
 * target (tested to agree). With a verb, its index range; with `bodyOnly`, the rows on the body
 * itself — never a filter over a page already capped.
 */
export function auditLinksOnBody(
  ctx: QueryCtx,
  body: { waterBodyId: Id<'waterBodies'>; action?: ModerationAction; bodyOnly?: boolean },
  take: number,
): Promise<Doc<'auditBodyLinks'>[]> {
  const { waterBodyId, action, bodyOnly } = body;
  if (action !== undefined && bodyOnly === true) {
    return ctx.db
      .query('auditBodyLinks')
      .withIndex('by_body_self_action_time', (q) =>
        q.eq('waterBodyId', waterBodyId).eq('self', true).eq('action', action),
      )
      .order('desc')
      .take(take);
  }
  if (action !== undefined) {
    return ctx.db
      .query('auditBodyLinks')
      .withIndex('by_body_action_time', (q) =>
        q.eq('waterBodyId', waterBodyId).eq('action', action),
      )
      .order('desc')
      .take(take);
  }
  if (bodyOnly === true) {
    return ctx.db
      .query('auditBodyLinks')
      .withIndex('by_body_self_time', (q) => q.eq('waterBodyId', waterBodyId).eq('self', true))
      .order('desc')
      .take(take);
  }
  return ctx.db
    .query('auditBodyLinks')
    .withIndex('by_body_time', (q) => q.eq('waterBodyId', waterBodyId))
    .order('desc')
    .take(take);
}
