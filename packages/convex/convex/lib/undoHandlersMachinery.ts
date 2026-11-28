/**
 * **The Machinery verbs' undos** (B01-8a, D342) — the code half of their `undoPolicy.ts` rows:
 *
 * - `mark_run_failed` → reopened (`reopen_run`): the mark cleared, and the loader's own late close
 *   in its place if one came, else the run `running` again;
 * - `wait_on_run` → the wait cleared (`stop_waiting_on_run`), while it still holds;
 * - `request_run_stop` → withdrawn (`withdraw_run_stop`), until the run has seen it;
 * - `start_imagery` → paused (`pause_imagery`), while the season's imagery is still running; and
 *   `pause_imagery` → resumed (`start_imagery`), while it is still paused (B01-8b-2). Each runs the
 *   other's own impl (`machineryImagery.ts`), so the undo writes the audit row and schedules the poll
 *   a press would; the season row as it stands is the refusal.
 *
 * Each runs the inverse's own impl (`machineryWrites.ts`), so an undo writes the row and the log line
 * a press would. The inverses themselves have no undo (the policy's `none`): the forward press is
 * on the page.
 *
 * **The offer and the run share one refusal**, read from the run as it stands: the row's own mark,
 * wait or request must still be the one on the run (a later one of the same kind replaced it), and
 * still undoable (a wait that ran out, a stop the run already obeyed). The engine's own rule — a
 * later audit row on the run overtakes this one — covers a mark undone and marked again.
 */

import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { imageryStateOf, pauseImageryImpl, startImageryImpl } from '../machineryImagery';
import {
  RUN_GONE,
  reopenRunImpl,
  STOP_SEEN,
  stopWaitingOnRunImpl,
  WAIT_EXPIRED,
  withdrawRunStopImpl,
} from '../machineryWrites';
import type { ModerationAction } from './audit';
import { ROW_MAX } from './readBudget';
import { UNDO_POLICY } from './undoPolicy';
import type { UndoHandler, UndoRead } from './undoTypes';

const runIdOf = (row: Doc<'moderationActions'>) => row.targetId as Id<'importRuns'>;

export const MARK_REPLACED = 'This run was reopened or marked again since; undo the newest change.';
export const WAIT_REPLACED = 'This wait was replaced by a newer one; undo that one instead.';
export const STOP_REPLACED = 'This request to stop was replaced by a newer one.';

/**
 * The run as it stands, read through the undo's budget. `readBudget` has no row kind for an import
 * run; an audit row's (the document limit) is the honest worst case for one, so it is charged as one.
 */
async function runAsItStands(
  ctx: QueryCtx | MutationCtx,
  row: Doc<'moderationActions'>,
  read: UndoRead,
): Promise<Doc<'importRuns'> | null> {
  const id = ctx.db.normalizeId('importRuns', row.targetId);
  if (id === null) return null;
  const [run] = await read.take('moderationAction', 1, async () => {
    const found = await ctx.db.get(id);
    return found === null ? [] : [found];
  });
  return run ?? null;
}

/** Why the undo of `row` would be refused by the run as it stands, or `null`. */
export function machineryUndoRefusal(
  row: Doc<'moderationActions'>,
  run: Doc<'importRuns'> | null,
  now: number,
): string | null {
  if (run === null) return RUN_GONE;
  switch (row.action) {
    case 'mark_run_failed':
      return run.markedFailed?.actionId === row._id ? null : MARK_REPLACED;
    case 'wait_on_run':
      if (run.stallWait?.actionId !== row._id) return WAIT_REPLACED;
      return run.stallWait.until <= now ? WAIT_EXPIRED : null;
    case 'request_run_stop':
      if (run.stopRequest?.actionId !== row._id) return STOP_REPLACED;
      return run.stopRequest.seenAt !== undefined ? STOP_SEEN : null;
    default:
      return 'Undo for this is not built yet.';
  }
}

function machineryUndo(
  inverse: 'reopen_run' | 'stop_waiting_on_run' | 'withdraw_run_stop',
  run: (
    ctx: MutationCtx,
    actor: Doc<'profiles'>,
    args: { runId: Id<'importRuns'>; reason: string },
  ) => Promise<unknown>,
): UndoHandler {
  return {
    undoTakesAway: () => UNDO_POLICY[inverse].takesAway(),
    refusalCost: () => ({ bytes: ROW_MAX.moderationAction, reads: 1 }),
    refusal: async (ctx, row, read) =>
      machineryUndoRefusal(row, await runAsItStands(ctx, row, read), Date.now()),
    run: async ({ ctx, actor, row, reason }) => {
      // The refusal again, inside the write: the run may have moved since the offer was read.
      const why = machineryUndoRefusal(row, await ctx.db.get(runIdOf(row)), Date.now());
      if (why !== null) throw new ConvexError(why);
      await run(ctx, actor, { runId: runIdOf(row), reason });
    },
  };
}

// ── Imagery's Start and Pause (B01-8b-2) ────────────────────────────────────────────────────────────

export const IMAGERY_NOT_RUNNING = 'Imagery isn’t running any more, so there’s nothing to pause.';
export const IMAGERY_NOT_PAUSED = 'Imagery isn’t paused any more, so there’s nothing to resume.';
export const IMAGERY_WATCH_GONE = 'That season’s watch no longer exists.';

/** The season row a Start or Pause row names (its target id), read through the undo's budget. */
async function seasonAsItStands(
  ctx: QueryCtx | MutationCtx,
  row: Doc<'moderationActions'>,
  read: UndoRead | null,
): Promise<Doc<'imageryIngestSeasons'> | null> {
  const get = () =>
    ctx.db
      .query('imageryIngestSeasons')
      .withIndex('by_season', (q) => q.eq('season', row.targetId))
      .unique();
  if (read === null) return await get();
  const [found] = await read.take('moderationAction', 1, async () => {
    const r = await get();
    return r === null ? [] : [r];
  });
  return found ?? null;
}

/** Why the undo of a Start or Pause would be refused by the season as it stands, or `null`. */
export function imageryUndoRefusal(
  row: Doc<'moderationActions'>,
  season: Doc<'imageryIngestSeasons'> | null,
): string | null {
  if (season === null) return IMAGERY_WATCH_GONE;
  const state = imageryStateOf(season);
  if (row.action === 'start_imagery') return state === 'running' ? null : IMAGERY_NOT_RUNNING;
  if (row.action === 'pause_imagery') return state === 'paused' ? null : IMAGERY_NOT_PAUSED;
  return 'Undo for this is not built yet.';
}

function imageryUndo(
  inverse: 'pause_imagery' | 'start_imagery',
  run: (ctx: MutationCtx, actor: Doc<'profiles'>, args: { season: string }) => Promise<unknown>,
): UndoHandler {
  return {
    undoTakesAway: () => UNDO_POLICY[inverse].takesAway(),
    refusalCost: () => ({ bytes: ROW_MAX.moderationAction, reads: 1 }),
    refusal: async (ctx, row, read) =>
      imageryUndoRefusal(row, await seasonAsItStands(ctx, row, read)),
    run: async ({ ctx, actor, row }) => {
      // The refusal again, inside the write: the season may have moved since the offer was read.
      const why = imageryUndoRefusal(row, await seasonAsItStands(ctx, row, null));
      if (why !== null) throw new ConvexError(why);
      await run(ctx, actor, { season: row.targetId });
    },
  };
}

export const MACHINERY_UNDO_HANDLERS: Partial<Record<ModerationAction, UndoHandler>> = {
  mark_run_failed: machineryUndo('reopen_run', reopenRunImpl),
  wait_on_run: machineryUndo('stop_waiting_on_run', stopWaitingOnRunImpl),
  request_run_stop: machineryUndo('withdraw_run_stop', withdrawRunStopImpl),
  start_imagery: imageryUndo('pause_imagery', pauseImageryImpl),
  pause_imagery: imageryUndo('start_imagery', startImageryImpl),
};
