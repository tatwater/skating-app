/**
 * **The cron dispatchers** (D343, D347, B01-8b): every cron is registered against one of these two
 * with `{ job: <name> }`, and each looks its job up in the registry (`cronJobs.ts`), runs it, and
 * records the tick — the heartbeat (`cronHeartbeats`), the tick in its bucket row (`cronTicks`), and
 * for a tick that worked or failed its run row (`cronRuns`) and its lines (`runEvents`).
 *
 * - `tickMutation` runs a mutation job as a nested transaction under Convex's limits less a fixed
 *   reserve, catches what it throws, and records the tick in its own (outer) transaction.
 * - `tickAction` calls an action job's handler in-process, between a `begin` (announcing jobs only:
 *   stamps `runningSince`, and records a stale one as killed) and a `finish` that records the tick.
 *
 * A triggered run (*Run now*, *Retry failed*) schedules a dispatcher with `trigger: 'manual'` and the
 * person who pressed it.
 *
 * PLACEHOLDER (B01-8b seams): the two contracts are the seam; the recorder is S1's. Until then each
 * dispatcher only runs its job — exactly what the cron did before it moved into the registry, with
 * nothing recorded — so the registry's move changes no job's behavior.
 */

import { v } from 'convex/values';
import { internalAction, internalMutation } from './_generated/server';
import { type CronActionJob, type CronMutationJob, cronJob } from './cronJobs';
import { CRON_TRIGGERS } from './lib/enums';
import { literals } from './lib/validators';

/** The dispatchers' arguments: the registry's name, and who started the run. */
const tickArgs = {
  job: v.string(),
  /** `cron` when absent. */
  trigger: v.optional(literals(CRON_TRIGGERS)),
  /** A manual run's presser. */
  byUserId: v.optional(v.id('profiles')),
};

/** The registry's entry for `name`, which must be of `kind`; else the tick throws (a wiring fault). */
export function requireCronJob(name: string, kind: 'mutation'): CronMutationJob;
export function requireCronJob(name: string, kind: 'action'): CronActionJob;
export function requireCronJob(
  name: string,
  kind: 'mutation' | 'action',
): CronMutationJob | CronActionJob {
  const entry = cronJob(name);
  if (entry === null) throw new Error(`cronRuns: no cron named "${name}" in the registry`);
  if (entry.kind !== kind) {
    throw new Error(
      `cronRuns: "${name}" is ${entry.kind === 'mutation' ? 'a mutation' : 'an action'} job`,
    );
  }
  return entry;
}

export const tickMutation = internalMutation({
  args: tickArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    // PLACEHOLDER (S1): the nested transaction with its reserve, and the record.
    const entry = requireCronJob(args.job, 'mutation');
    await ctx.runMutation(entry.fn, entry.args);
    return null;
  },
});

export const tickAction = internalAction({
  args: tickArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    // PLACEHOLDER (S1): the handler in-process, `begin` and `finish`, and the record.
    const entry = requireCronJob(args.job, 'action');
    await ctx.runAction(entry.fn, entry.args);
    return null;
  },
});
