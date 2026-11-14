/**
 * One target's audit rows, newest first — **one rule for every reader** of a target's history
 * (`moderation.listActions` and the Body console's `bodyConsole.history`): with a verb, the
 * `by_target_action` range, so the filter is in the index rather than over a page already capped;
 * without one, `by_target`. Both readers ask for the same rows the same way, and get the same answer.
 */
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import type { ModerationAction, ModerationTargetType } from './audit';

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
 * for every reader** of a body's history: `bodyConsole.history` (once per body in the merge chain)
 * and `moderation.listActions` for a `waterbody` target. With a verb, its index range; with
 * `bodyOnly`, the rows on the body itself — never a filter over a page already capped.
 */
export function auditLinksOnBody(
  ctx: QueryCtx,
  body: { waterBodyId: Id<'waterBodies'>; action?: ModerationAction; bodyOnly?: boolean },
  take: number,
): Promise<Doc<'auditBodyLinks'>[]> {
  const { waterBodyId, action, bodyOnly } = body;
  if (action !== undefined) {
    return ctx.db
      .query('auditBodyLinks')
      .withIndex('by_body_action_time', (q) =>
        q.eq('waterBodyId', waterBodyId).eq('action', action),
      )
      .order('desc')
      .filter((f) => (bodyOnly === true ? f.eq(f.field('self'), true) : true))
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
