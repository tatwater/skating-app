/**
 * One target's audit rows, newest first — **one rule for every reader** of a target's history
 * (`moderation.listActions` and the Body console's `bodyConsole.history`): with a verb, the
 * `by_target_action` range, so the filter is in the index rather than over a page already capped;
 * without one, `by_target`. Both readers ask for the same rows the same way, and get the same answer.
 */
import type { Doc } from '../_generated/dataModel';
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
