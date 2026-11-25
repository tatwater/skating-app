/**
 * **The Corpus tasks' one writer** (B01-6a): every task row and every count row is written here.
 *
 * PLACEHOLDER (S1's): the T0 stub. Its signatures are the briefs' canonical snippet (*The writer*);
 * every body throws until S1 replaces this file. S2's decisions and the undo call it. It imports no
 * function module (`waterBodies.ts`, `moderation.ts`, …): `importCycles.test.ts` holds that line.
 */

import type { CorpusTaskDecision, CorpusTaskLeftReason } from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/** What one sync did to the body's tasks. PLACEHOLDER (S1's): S1 settles its fields. */
export type SyncOutcome = { filed: number; refreshed: number; left: number };

const placeholder = (fn: string): never => {
  throw new Error(`PLACEHOLDER (S1): lib/corpusTasks.${fn} is not built yet`);
};

/** Files, refreshes or leaves the body's 6a tasks from its stored `reviewReasons`. Idempotent. PLACEHOLDER (S1's). */
export async function syncBodyTasks(
  _ctx: MutationCtx,
  _waterBodyId: Id<'waterBodies'>,
): Promise<SyncOutcome> {
  return placeholder('syncBodyTasks');
}

/** Every open task on the body leaves, `because`. PLACEHOLDER (S1's). */
export async function leaveBodyTasks(
  _ctx: MutationCtx,
  _waterBodyId: Id<'waterBodies'>,
  _because: CorpusTaskLeftReason,
): Promise<void> {
  return placeholder('leaveBodyTasks');
}

/** The open task, or the lock's sentence thrown ("Decided by … · 14:42 · renamed"). PLACEHOLDER (S1's). */
export async function taskToDecide(
  _ctx: MutationCtx,
  _taskId: Id<'corpusTasks'>,
): Promise<Doc<'corpusTasks'>> {
  return placeholder('taskToDecide');
}

/**
 * The settle (one path for every intake decision): the reason off `reviewReasons`, `reviewReason`
 * recomputed by `primaryReviewReason`, an entry on `reviewSettled` with today's evidence, the task
 * decided with `actionId`, the counts moved. In the caller's transaction, after its domain write.
 * PLACEHOLDER (S1's).
 */
export async function settleReason(
  _ctx: MutationCtx,
  _args: {
    task: Doc<'corpusTasks'>;
    decision: CorpusTaskDecision;
    actionId: Id<'moderationActions'>;
    actorId: Id<'profiles'>;
  },
): Promise<void> {
  return placeholder('settleReason');
}

/**
 * The undo's: the task `actionId` decided reopens, its `reviewSettled` entry goes and its reason
 * comes back. `'overtaken'` when a later campaign or decision has already moved it (nothing
 * written). PLACEHOLDER (S1's).
 */
export async function reopenTask(
  _ctx: MutationCtx,
  _actionId: Id<'moderationActions'>,
): Promise<'reopened' | 'overtaken' | 'none'> {
  return placeholder('reopenTask');
}

/** Runs `work` with the counts moved once at its end (the import's batch; the `inboxBatch` shape). PLACEHOLDER (S1's). */
export async function corpusTaskBatch<T>(_ctx: MutationCtx, _work: () => Promise<T>): Promise<T> {
  return placeholder('corpusTaskBatch');
}
