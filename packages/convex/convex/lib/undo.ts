/**
 * The undo engine (D226, B01 §11).
 *
 * `lib/undoPolicy.ts` says what undoes each verb; this decides whether *this* row can be undone by
 * *this* person right now, and runs it:
 *
 * - **Already undone** — a row whose `undoesActionId` points at it exists.
 * - **Overtaken** — a later row on the same target exists ("a later write means no undo", the
 *   founder's call): History links to what overtook it instead of offering Undo.
 * - **Capability** — the undoer must hold the inverse's capability (D217); it is never offered
 *   otherwise.
 * - **Reason** — asked only when the value the undo puts back takes something away from skaters.
 *
 * The undo itself runs the inverse verb's own helper inside {@link asUndoOf}, so its side effects run
 * and every row it writes is tagged as the undo.
 */

import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { asUndoOf } from './audit';
import { hasCapability } from './auth';
import { UNDO_HANDLERS, type UndoHandler } from './undoHandlers';
import { UNDO_POLICY, undoCapability } from './undoPolicy';

/** How long after acting the toast offers its undo (D226). History has no limit. */
export const TOAST_UNDO_MS = 10_000;

export type UndoState =
  | { state: 'available'; needsReason: boolean }
  | { state: 'undone'; byActionId: Id<'moderationActions'> }
  | { state: 'overtaken'; byActionId: Id<'moderationActions'> }
  | { state: 'unavailable'; why: string };

/** The handler for a row, if its verb is undoable in this build. */
function handlerFor(row: Doc<'moderationActions'>): UndoHandler | null {
  return UNDO_HANDLERS[row.action] ?? null;
}

/** Whether `row` can be undone by `viewer`, and if not, why. Bounded: two index reads. */
export async function undoState(
  ctx: QueryCtx | MutationCtx,
  viewer: Pick<Doc<'profiles'>, 'role'>,
  row: Doc<'moderationActions'>,
): Promise<UndoState> {
  const rule = UNDO_POLICY[row.action];
  if (rule.undo.kind === 'none') return { state: 'unavailable', why: rule.undo.why };
  if (rule.undo.kind === 'later') {
    return { state: 'unavailable', why: `Undo for this lands with ${rule.undo.workstream}.` };
  }
  const handler = handlerFor(row);
  if (!handler) return { state: 'unavailable', why: 'Undo for this is not built yet.' };

  const undoneBy = await ctx.db
    .query('moderationActions')
    .withIndex('by_undoes', (q) => q.eq('undoesActionId', row._id))
    .first();
  if (undoneBy) return { state: 'undone', byActionId: undoneBy._id };

  const newest = await ctx.db
    .query('moderationActions')
    .withIndex('by_target', (q) => q.eq('targetType', row.targetType).eq('targetId', row.targetId))
    .order('desc')
    .first();
  if (newest && newest._id !== row._id && newest._creationTime > row._creationTime) {
    return { state: 'overtaken', byActionId: newest._id };
  }

  const blocked = handler.blocked?.(row) ?? null;
  if (blocked) return { state: 'unavailable', why: blocked };
  if (!hasCapability(viewer, undoCapability(rule, row.targetType))) {
    return { state: 'unavailable', why: 'Undoing this takes a role you do not hold.' };
  }
  return { state: 'available', needsReason: handler.undoTakesAway(row) };
}

/** Undo `actionId` as `actor` (already gated by the caller), with `reason` when one is needed. */
export async function runUndo(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  actionId: Id<'moderationActions'>,
  reason: string | undefined,
): Promise<void> {
  const row = await ctx.db.get(actionId);
  if (!row) throw new ConvexError('That action no longer exists');
  const state = await undoState(ctx, actor, row);
  switch (state.state) {
    case 'undone':
      throw new ConvexError('That action has already been undone');
    case 'overtaken':
      throw new ConvexError('Something changed this since; open its history to see what');
    case 'unavailable':
      throw new ConvexError(state.why);
  }
  const trimmed = reason?.trim() ?? '';
  if (state.needsReason && trimmed.length === 0) {
    throw new ConvexError('Undoing this takes something away from skaters, so it needs a reason');
  }
  const handler = handlerFor(row);
  if (!handler) throw new ConvexError('Undo for this is not built yet');
  const why =
    trimmed.length > 0 ? trimmed : `Undid ${row.action.replace(/_/g, ' ')}: ${row.reason}`;
  await asUndoOf(ctx, actionId, () => handler.run({ ctx, actor, row, reason: why }));
}
