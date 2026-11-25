/**
 * **What the Corpus tasks' drift repair checks, and how it fixes it** (B01-6a). The one writer
 * (`lib/corpusTasks.ts`) keeps every task beside the write that changed its body; this is the net
 * for a write that didn't call it. Two checks, each read only (the dry run) or fixing (the repair):
 *
 * - **A body's tasks against its fields** — the writer's own rule, `planBodyTasks`: an open task
 *   whose question is gone (or a second one on its key), a live question with no open task, a task
 *   whose tab, rank or search text its body's facts have moved. Fixed by the writer's sync, which is
 *   what any hook would have written.
 * - **A lane's counts against its tasks**: every `open:<lane>` and `open:<lane>:<facet>` row equal to
 *   the tally of the lane's open tasks, and none left standing for a tab with none. Fixed by writing
 *   the tally.
 *
 * Only kinds cross into what the jobs record and return, never a body's name or a task's contents.
 */

import { CORPUS_REASON_LANE, type CorpusTaskLane } from '@skating/core';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { countKeysOf, planBodyTasks, syncBodyTasks } from './corpusTasks';

/** What the repair found wrong — kinds only, never contents. */
export type CorpusDriftKind =
  | 'task_without_question'
  | 'question_without_task'
  /** A task's tab, rank or search text behind its body's facts. */
  | 'stale_facet'
  | 'counts';

/** The lanes 6a files tasks in, and so the lanes whose counts the repair checks. */
export const CORPUS_TASK_LANES_6A: readonly CorpusTaskLane[] = Object.values(CORPUS_REASON_LANE);

/** What a body's sync would fix, by kind; empty when its tasks are what its fields say. */
export async function bodyTaskDrift(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<CorpusDriftKind[]> {
  const plan = await planBodyTasks(ctx, waterBodyId);
  const kinds: CorpusDriftKind[] = [];
  if (plan.leave.length > 0) kinds.push('task_without_question');
  if (plan.file.length > 0) kinds.push('question_without_task');
  if (plan.refresh.length > 0) kinds.push('stale_facet');
  return kinds;
}

/** A body's tasks re-synced from its fields: how many it fixed, and the kinds. */
export async function repairBodyTasks(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  now: number,
): Promise<{ fixed: number; kinds: CorpusDriftKind[] }> {
  const kinds = await bodyTaskDrift(ctx, waterBodyId);
  if (kinds.length === 0) return { fixed: 0, kinds };
  const outcome = await syncBodyTasks(ctx, waterBodyId, { now });
  return { fixed: outcome.filed + outcome.refreshed + outcome.left, kinds };
}

/**
 * The most open tasks one lane's count check reads. Its transaction's limits (`COUNT_LIMITS` in
 * `corpusTaskJobs.ts`) hold it; a lane past this is recorded as a failure on Machinery, never
 * miscounted.
 */
export const COUNT_SCAN = 10_000;

/** A lane whose open tasks are past {@link COUNT_SCAN}: too many to count in one transaction. */
export class LaneTooLarge extends Error {}

/** Each count row of `lane` that differs from its tally: its key, what's stored, what it should be. */
export async function laneCountDrift(
  ctx: QueryCtx,
  lane: CorpusTaskLane,
): Promise<{ key: string; stored: number; tally: number; rowId?: Id<'corpusTaskCounts'> }[]> {
  const open = await ctx.db
    .query('corpusTasks')
    .withIndex('by_status_lane_rank', (q) => q.eq('status', 'open').eq('lane', lane))
    .take(COUNT_SCAN + 1);
  if (open.length > COUNT_SCAN) throw new LaneTooLarge(`lane ${lane} is past its count scan`);
  const tally = new Map<string, number>();
  for (const task of open) {
    for (const key of countKeysOf(task)) tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  // The lane's rows: `open:<lane>` and every `open:<lane>:<facet>` (`;` sorts just after `:`).
  const lead = `open:${lane}`;
  const rows = await ctx.db
    .query('corpusTaskCounts')
    .withIndex('by_key', (q) => q.gte('key', lead).lt('key', `${lead};`))
    .collect();
  const drift: { key: string; stored: number; tally: number; rowId?: Id<'corpusTaskCounts'> }[] =
    [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.key !== lead && !row.key.startsWith(`${lead}:`)) continue;
    const want = tally.get(row.key) ?? 0;
    // A second row on one key is drift too: the first takes the tally, the next goes to zero.
    const expected = seen.has(row.key) ? 0 : want;
    seen.add(row.key);
    if (row.count !== expected) {
      drift.push({ key: row.key, stored: row.count, tally: expected, rowId: row._id });
    }
  }
  for (const [key, count] of tally) {
    if (!seen.has(key)) drift.push({ key, stored: 0, tally: count });
  }
  return drift;
}

/** A lane's count rows set to their tallies: how many rows it wrote. */
export async function repairLaneCounts(ctx: MutationCtx, lane: CorpusTaskLane): Promise<number> {
  const drift = await laneCountDrift(ctx, lane);
  for (const d of drift) {
    if (d.rowId !== undefined) await ctx.db.patch(d.rowId, { count: d.tally });
    else await ctx.db.insert('corpusTaskCounts', { key: d.key, count: d.tally });
  }
  return drift.length;
}
