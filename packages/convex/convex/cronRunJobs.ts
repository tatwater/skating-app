/**
 * **The cron backbone's own jobs** (D343, D347, B01-8b).
 *
 * - `prune` — the retention sweep: one `.paginate()` per execution over each backbone table's
 *   `by_keep_until` range below now (`cronTicks`, `cronRuns`, and the cron lines of `runEvents`, read
 *   with `gt('keepUntil', 0)` as the floor, since an import run's lines carry none), a bounded page of
 *   deletes a pass, self-continuing.
 * - `copyImageryRuns` — the one-shot backfill carrying `imageryRuns`' history into `cronRuns` under
 *   each row's cron name, so a cron's runs drawer begins where the Seasons panel's did. Dry run
 *   first; a bounded page a pass; idempotent by `cronRuns.copiedFrom`.
 *
 * PLACEHOLDER (B01-8b seams): both bodies, their pages and their exact answers are S1's; each
 * returns the empty answer until then.
 */

import { v } from 'convex/values';
import { internalMutation } from './_generated/server';

/** What a prune pass did. */
export type PruneResult = { deleted: number; more: boolean };

/** What a copy pass did (or, on a dry run, would do). */
export type CopyImageryRunsResult = {
  dryRun: boolean;
  /** Rows copied this pass (a dry run: rows it would copy). */
  copied: number;
  /** Rows already in `cronRuns` (`copiedFrom`), skipped. */
  alreadyCopied: number;
  more: boolean;
};

export const prune = internalMutation({
  args: {},
  handler: async (): Promise<PruneResult> => {
    // PLACEHOLDER (S1).
    return { deleted: 0, more: false };
  },
});

export const copyImageryRuns = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (_ctx, args): Promise<CopyImageryRunsResult> => {
    // PLACEHOLDER (S1).
    return { dryRun: args.dryRun ?? false, copied: 0, alreadyCopied: 0, more: false };
  },
});
