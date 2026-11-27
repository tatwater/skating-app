/**
 * **The Machinery writes on a corpus run** (D342, B01-8a): *Mark failed*, *Wait 30 minutes* and a
 * request to stop (built, not drawn), each with its inverse.
 *
 * Each is gated `machinery.corpus` (D217), writes one audit row (target `importRun`) and one
 * `runEvents` line, and refuses with a thrown sentence the web shows as a toast (D268). Each has an
 * inverse in the undo registry (D226): `markRunFailed` ↔ `reopenRun`, `waitOnRun` ↔
 * `stopWaitingOnRun`, `requestRunStop` ↔ `withdrawRunStop`.
 *
 * A late `finish` from the laptop never erases a mark: `importRuns.finish` on a marked run stores
 * its outcome as `loaderFinish` beside it.
 *
 * PLACEHOLDER (B01-8a T0): the contracts are the seam; every body is S1's.
 */

import { ConvexError, v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { mutation } from './_generated/server';
import { requireCapability } from './lib/auth';

/** Every write's answer: the audit row it wrote, which its undo receipt names. */
export type RunWriteResult = { actionId: Id<'moderationActions'> };

const notBuilt = (name: string) => new ConvexError(`${name} is not built yet`);

/**
 * Refused when the run isn't `running`, is already marked, or the reason is empty (the record's
 * *why*, asked in a dialog). Sets `status: 'failed'`, `finishedAt` and `markedFailed`, writes a
 * `mark` line, and schedules nothing.
 */
export const markRunFailed = mutation({
  args: { runId: v.id('importRuns'), reason: v.string() },
  handler: async (ctx, _args): Promise<RunWriteResult> => {
    await requireCapability(ctx, 'machinery.corpus');
    // PLACEHOLDER (B01-8a T0): S1 writes it.
    throw notBuilt('markRunFailed');
  },
});

/**
 * The mark's inverse: clears it; the status becomes the loader's late close if one came
 * (`loaderFinish`), else `running` again. Refused if the run was marked again since.
 */
export const reopenRun = mutation({
  args: { runId: v.id('importRuns') },
  handler: async (ctx, _args): Promise<RunWriteResult> => {
    await requireCapability(ctx, 'machinery.corpus');
    // PLACEHOLDER (B01-8a T0): S1 writes it.
    throw notBuilt('reopenRun');
  },
});

/**
 * *Wait 30 minutes*: refused when the run isn't stalled by the server's clock, or already waiting.
 * Sets `stallWait: { until: now + 30 min, … }` and writes a `wait` line. `now` is the caller's.
 */
export const waitOnRun = mutation({
  args: { runId: v.id('importRuns'), now: v.number() },
  handler: async (ctx, _args): Promise<RunWriteResult & { until: number }> => {
    await requireCapability(ctx, 'machinery.corpus');
    // PLACEHOLDER (B01-8a T0): S1 writes it.
    throw notBuilt('waitOnRun');
  },
});

/** The wait's inverse: clears it; refused once it has expired (nothing to undo). */
export const stopWaitingOnRun = mutation({
  args: { runId: v.id('importRuns') },
  handler: async (ctx, _args): Promise<RunWriteResult> => {
    await requireCapability(ctx, 'machinery.corpus');
    // PLACEHOLDER (B01-8a T0): S1 writes it.
    throw notBuilt('stopWaitingOnRun');
  },
});

/**
 * A request to stop (built, not drawn): refused when the run isn't `running`, or already asked.
 * Sets `stopRequest` and writes a `stop` line; `runEvents.append` returns `stop` to the run, or to
 * every pass whose `parentRunId` is it.
 */
export const requestRunStop = mutation({
  args: { runId: v.id('importRuns') },
  handler: async (ctx, _args): Promise<RunWriteResult> => {
    await requireCapability(ctx, 'machinery.corpus');
    // PLACEHOLDER (B01-8a T0): S1 writes it.
    throw notBuilt('requestRunStop');
  },
});

/** The stop's inverse: clears it; refused once `seenAt` is set (the run has stopped). */
export const withdrawRunStop = mutation({
  args: { runId: v.id('importRuns') },
  handler: async (ctx, _args): Promise<RunWriteResult> => {
    await requireCapability(ctx, 'machinery.corpus');
    // PLACEHOLDER (B01-8a T0): S1 writes it.
    throw notBuilt('withdrawRunStop');
  },
});
