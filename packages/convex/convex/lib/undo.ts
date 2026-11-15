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

import { isLeaving } from '@skating/core';
import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { asUndoOf } from './audit';
import { hasCapability } from './auth';
import { authorDeletedAtOn, authorDeletedRefusal } from './authorDeletion';
import { type PersonFacts, writeRefusal } from './peopleCan';
import { factsOfRow, personRowOf, rowlessProfile } from './peopleRows';
import { UNDO_HANDLERS } from './undoHandlers';
import { UNDO_POLICY, undoCapability, WORKSTREAM_MODE } from './undoPolicy';
import { meta, type UndoHandler, type UndoViewer } from './undoTypes';

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

/**
 * How many rows tagged with one undo are read to find that undo's own row. An undo tags every row it
 * writes (`asUndoOf`): a Post's undo writes a row per member it moves (at most ten), then the Post's
 * own, so this covers the largest undo with room to spare.
 */
const UNDO_TAG_READ = 16;

/**
 * The row that undid `row`, if one did: **the undo's own row on the same target**, not the first row
 * the undo happened to write. An undo writes its cascade first (a Post's undo moves its members, each
 * with a row tagged as undoing the Post's), and its own row last, so the newest tagged row on the
 * target is the one. With no tagged row on the target in the read, the newest tagged row stands in:
 * it still says the row was undone, which is what the state decides. `lib/undoChains` follows a
 * chain of undos link by link through this.
 */
export async function undoRowOf(
  ctx: QueryCtx | MutationCtx,
  row: Doc<'moderationActions'>,
): Promise<Doc<'moderationActions'> | null> {
  const tagged = await ctx.db
    .query('moderationActions')
    .withIndex('by_undoes', (q) => q.eq('undoesActionId', row._id))
    .order('desc')
    .take(UNDO_TAG_READ);
  return (
    tagged.find((r) => r.targetType === row.targetType && r.targetId === row.targetId) ??
    tagged[0] ??
    null
  );
}

/**
 * Whether `row` can be undone by `viewer`, and if not, why. Bounded: two index reads (one of at most
 * {@link UNDO_TAG_READ} rows), and one `get` of an item an author could have deleted.
 */
export async function undoState(
  ctx: QueryCtx | MutationCtx,
  viewer: UndoViewer,
  row: Doc<'moderationActions'>,
): Promise<UndoState> {
  const rule = UNDO_POLICY[row.action];
  if (rule.undo.kind === 'none') return { state: 'unavailable', why: rule.undo.why };
  if (rule.undo.kind === 'later') {
    return {
      state: 'unavailable',
      why: `Undo for this arrives with ${WORKSTREAM_MODE[rule.undo.workstream]}.`,
    };
  }
  const handler = handlerFor(row);
  if (!handler) return { state: 'unavailable', why: 'Undo for this is not built yet.' };

  const undoneBy = await undoRowOf(ctx, row);
  if (undoneBy) return { state: 'undone', byActionId: undoneBy._id };

  const newest = await ctx.db
    .query('moderationActions')
    .withIndex('by_target', (q) => q.eq('targetType', row.targetType).eq('targetId', row.targetId))
    .order('desc')
    .first();
  if (newest && newest._id !== row._id && newest._creationTime > row._creationTime) {
    return { state: 'overtaken', byActionId: newest._id };
  }

  const blocked = handler.blocked?.(row, viewer) ?? null;
  if (blocked) return { state: 'unavailable', why: blocked };
  // The row as it stands now refuses this write (B01-3d): never offered, since it would be turned down.
  const refused = (await handler.refusal?.(ctx, row)) ?? null;
  if (refused) return { state: 'unavailable', why: refused };
  // Content its author deleted stays as the deletion left it (D248). The author's own row usually
  // overtakes the takedown above; a withdrawal stamped with no row of its own (a backfill) doesn't,
  // so the undo would be offered and then refused — read the stamp, and give the refusal here.
  if ((await authorDeletedAtOn(ctx, row.targetType, row.targetId)) !== undefined) {
    return { state: 'unavailable', why: authorDeletedRefusal(meta(row).priorStatus, true) };
  }
  // A change to a person is refused through the same rule its forward write uses (`lib/peopleCan`):
  // an account being deleted, or deleted, can't be disciplined back or forth — so History never
  // offers an undo the write would turn down.
  const refusal = await personUndoRefusal(ctx, viewer, row, handler);
  if (refusal !== null) return { state: 'unavailable', why: refusal };
  if (!hasCapability(viewer, undoCapability(rule, row.targetType))) {
    return { state: 'unavailable', why: 'Undoing this takes a role you do not hold.' };
  }
  // Every undo is a write, and a write is refused to an operator on their way out (D62) — so it is
  // never offered to one either, or History would draw a button the server turns down.
  if (isLeaving(viewer)) {
    return {
      state: 'unavailable',
      why: 'Your account is being deleted, so you can no longer undo.',
    };
  }
  return { state: 'available', needsReason: handler.undoTakesAway(row) };
}

/** Why an undo on someone without a People row can't be checked on this page (before the backfill). */
export const UNDO_NEEDS_ROWS =
  'This can be checked once the People rows are built; open the person to undo it.';

/**
 * Why an undo on a person can't run now: the refusal the forward write of the state it puts back
 * would give (`writeRefusal`, on the handler's own `personWrite`) — one rule, never a parallel list.
 * The person's facts come from their light People row (a profile can weigh a whole document, and
 * History asks once a line); a person with no row yet is read in full.
 */
async function personUndoRefusal(
  ctx: QueryCtx | MutationCtx,
  viewer: UndoViewer,
  row: Doc<'moderationActions'>,
  handler: UndoHandler,
): Promise<string | null> {
  if (row.targetType !== 'user' || handler.personWrite === undefined) return null;
  const id = ctx.db.normalizeId('profiles', row.targetId);
  if (!id) return 'This account no longer exists.';
  const light = await personRowOf(ctx, id);
  // Someone with no row yet (before the rows backfill) is read in full, charged to the request's
  // budget; once a page of such rows has spent it, the rest say so rather than read past the limit.
  // A query reads each such person once, however many rows name them.
  const target: PersonFacts | null | undefined = light
    ? factsOfRow(light)
    : await rowlessProfile(ctx, id);
  if (target === undefined) return UNDO_NEEDS_ROWS;
  if (!target) return 'This account no longer exists.';
  return writeRefusal(ctx, viewer, target, handler.personWrite(row));
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
