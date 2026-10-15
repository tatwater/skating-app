/**
 * Undo (D226, B01 §11): the toast's ten seconds and History's Undo both call {@link run}.
 *
 * The gate is the capability of the row being undone (a body's removal needs `body.remove`, a
 * report's needs `content.moderate`), read from the registry before anything else runs. The rules —
 * already undone, overtaken, the reason — are `lib/undo.ts`'s.
 */

import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireCapability } from './lib/auth';
import { MODERATION_TARGET_TYPES } from './lib/enums';
import { runUndo, TOAST_UNDO_MS, type UndoState, undoState } from './lib/undo';
import { UNDO_POLICY, undoCapability } from './lib/undoPolicy';
import { literals } from './lib/validators';

export const run = mutation({
  args: { actionId: v.id('moderationActions'), reason: v.optional(v.string()) },
  handler: async (ctx, { actionId, reason }) => {
    const row = await ctx.db.get(actionId);
    if (!row) throw new ConvexError('That action no longer exists');
    const actor = await requireCapability(
      ctx,
      undoCapability(UNDO_POLICY[row.action], row.targetType),
    );
    await runUndo(ctx, actor, actionId, reason);
  },
});

/**
 * The caller's own newest action on a target, if it is still inside the toast's window — what the
 * toast's Undo acts on. Null once the window has passed or someone else has acted since.
 */
export const latestOwn = query({
  args: { targetType: literals(MODERATION_TARGET_TYPES), targetId: v.string() },
  handler: async (
    ctx,
    { targetType, targetId },
  ): Promise<{ actionId: string; action: string; undo: UndoState } | null> => {
    const viewer = await requireCapability(ctx, 'audit.read');
    const newest = await ctx.db
      .query('moderationActions')
      .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
      .order('desc')
      .first();
    if (!newest || newest.actorId !== viewer._id) return null;
    if (Date.now() - newest.createdAt > TOAST_UNDO_MS) return null;
    return {
      actionId: newest._id,
      action: newest.action,
      undo: await undoState(ctx, viewer, newest),
    };
  },
});
