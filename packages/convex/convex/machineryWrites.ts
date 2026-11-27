/**
 * **The Machinery writes on a corpus run** (D342, B01-8a): *Mark failed*, *Wait 30 minutes* and a
 * request to stop (built, not drawn), each with its inverse.
 *
 * Each is gated `machinery.corpus` (D217), writes one audit row (target `importRun`) and one
 * `runEvents` line, and refuses with a thrown sentence the web shows as a toast (D268). Each has an
 * inverse in the undo registry (D226): `markRunFailed` ↔ `reopenRun`, `waitOnRun` ↔
 * `stopWaitingOnRun`, `requestRunStop` ↔ `withdrawRunStop`. The undo runs the inverse's own impl
 * (`lib/undoHandlersMachinery.ts`), so an undo writes the same row and line a press would.
 *
 * A late `finish` from the laptop never erases a mark: `importRuns.finish` on a marked run stores
 * its outcome as `loaderFinish` beside it.
 *
 * **Every verdict uses the server's clock.** *Wait 30 minutes* is refused unless the run is stalled
 * by `Date.now()` here, whatever the page believed; the wait's end is the caller's clock held within
 * a minute of the server's (`callerNow`), so the page's *until* is the one it shows.
 */

import { callerNow, RUN_WAIT_MS, runLiveness } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type MutationCtx, mutation } from './_generated/server';
import { markChangedBodies, requestCellReconcile } from './importRuns';
import { normalizeReason, typed, writeAudit } from './lib/audit';
import { requireCapability } from './lib/auth';
import { campaignMarkOffered, isCampaignRow, newestPassUnder, titleOf } from './machineryRuns';
import { insertRunLines } from './runEvents';

/** Every write's answer: the audit row it wrote, which its undo receipt names. */
export type RunWriteResult = { actionId: Id<'moderationActions'> };

/** How far the caller's clock may sit from the server's for a wait's end. */
const CLOCK_SLACK_MS = 60_000;

// ── The refusals, in words a person can read (D268) ────────────────────────────────────────────────

export const RUN_GONE = 'That run no longer exists.';
export const RUN_NOT_RUNNING = 'This run has already finished, so there is nothing to mark.';
export const RUN_ALREADY_MARKED = 'This run is already marked failed.';
export const MARK_NEEDS_REASON = 'Say why you are marking this run failed.';
export const CAMPAIGN_MOVED_ON =
  'The campaign has carried on since its pass was marked, so it was left open. Check where it is now.';
export const NOT_A_CAMPAIGN = 'Only a campaign can be marked failed along with its pass.';
export const RUN_NOT_MARKED = 'This run isn’t marked failed, so there is nothing to reopen.';
export const WAIT_FINISHED = 'This run has already finished, so there is nothing to wait on.';
export const WAIT_ALREADY = 'Someone is already waiting on this run.';
export const WAIT_NOT_STALLED = 'This run isn’t stalled, so there is nothing to wait on.';
export const WAIT_NO_HEARTBEAT =
  'This run has no heartbeat recorded, so it can’t be waited on. Mark it failed if it has stopped.';
export const WAIT_NONE = 'Nobody is waiting on this run.';
export const WAIT_EXPIRED = 'The wait has already run out, so there is nothing to undo.';
export const STOP_FINISHED = 'This run has already finished, so there is nothing to stop.';
export const STOP_ALREADY = 'This run has already been asked to stop.';
export const STOP_NONE = 'This run hasn’t been asked to stop.';
export const STOP_SEEN =
  'The run has already seen the request and stopped, so it can’t be withdrawn.';

async function runOf(ctx: MutationCtx, runId: Id<'importRuns'>): Promise<Doc<'importRuns'>> {
  const run = await ctx.db.get(runId);
  if (!run) throw new ConvexError(RUN_GONE);
  return run;
}

/** Whether a run is still going, as the console sees it: running, and not marked by hand. */
const isLive = (run: Doc<'importRuns'>) =>
  run.status === 'running' && run.markedFailed === undefined;

/** The audit row and the log line every write leaves, at one instant. */
async function record(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  run: Doc<'importRuns'>,
  entry: {
    action:
      | 'mark_run_failed'
      | 'reopen_run'
      | 'wait_on_run'
      | 'stop_waiting_on_run'
      | 'request_run_stop'
      | 'withdraw_run_stop';
    reason: string;
    metadata: Record<string, unknown>;
    line: { kind: 'mark' | 'wait' | 'stop'; text: string };
    now: number;
  },
): Promise<Id<'moderationActions'>> {
  const actionId = await writeAudit(ctx, {
    actorId: actor._id,
    action: entry.action,
    targetType: 'importRun',
    targetId: run._id,
    reason: typed(entry.reason),
    metadata: { kind: run.kind, label: run.label, ...entry.metadata },
    createdAt: entry.now,
  });
  await insertRunLines(ctx, run._id, [{ ...entry.line, loggedAt: entry.now }], entry.now);
  return actionId;
}

// ── Mark failed, and its inverse ───────────────────────────────────────────────────────────────────

export async function markRunFailedImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  args: { runId: Id<'importRuns'>; reason: string; afterPass?: Id<'importRuns'> },
): Promise<RunWriteResult> {
  const run = await runOf(ctx, args.runId);
  if (run.markedFailed !== undefined) throw new ConvexError(RUN_ALREADY_MARKED);
  if (run.status !== 'running') throw new ConvexError(RUN_NOT_RUNNING);
  // *Mark the campaign failed too*: only while the offer still holds by the rows as they stand —
  // the named pass is the campaign's newest and nothing moved after its mark (`campaignMarkOffered`).
  let afterPassName: string | null = null;
  if (args.afterPass !== undefined) {
    if (!isCampaignRow(run)) throw new ConvexError(NOT_A_CAMPAIGN);
    const newest = await newestPassUnder(ctx, run._id);
    if (newest?._id !== args.afterPass || !campaignMarkOffered(run, newest)) {
      throw new ConvexError(CAMPAIGN_MOVED_ON);
    }
    afterPassName = titleOf(newest);
  }
  const reason = normalizeReason(args.reason);
  if (reason.length === 0) throw new ConvexError(MARK_NEEDS_REASON);
  const now = Date.now();
  // The audit row first: it refuses a reason past the cap (D261), and the mark names it.
  const actionId = await record(ctx, actor, run, {
    action: 'mark_run_failed',
    reason,
    metadata: {
      prev: { status: run.status },
      ...(args.afterPass !== undefined && { afterPass: args.afterPass }),
    },
    line: {
      kind: 'mark',
      text:
        afterPassName === null
          ? `Marked failed by ${actor.displayName}: ${reason}`
          : `Marked failed by ${actor.displayName} after its ${afterPassName} pass: ${reason}`,
    },
    now,
  });
  await ctx.db.patch(run._id, {
    status: 'failed',
    finishedAt: now,
    markedFailed: { byUserId: actor._id, at: now, reason, actionId },
  });
  // The founder's ruling on fork 2: a run that changed the bodies before it was marked asks for
  // the weather-cell walk, debounced as a loader's close is (`importRuns.finish`).
  if (markChangedBodies(run)) await requestCellReconcile(ctx);
  return { actionId };
}

/**
 * The mark's inverse: clears it; the status becomes the loader's late close if one came
 * (`loaderFinish`, which then is the row's close), else `running` again — a run that is still
 * quiet reads late or stalled again by the stall rule.
 */
export async function reopenRunImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  args: { runId: Id<'importRuns'>; reason?: string },
): Promise<RunWriteResult> {
  const run = await runOf(ctx, args.runId);
  const mark = run.markedFailed;
  if (mark === undefined) throw new ConvexError(RUN_NOT_MARKED);
  const now = Date.now();
  const late = run.loaderFinish;
  const actionId = await record(ctx, actor, run, {
    action: 'reopen_run',
    reason: args.reason ?? 'Reopened a run marked failed',
    metadata: { prev: mark, loaderFinish: late ?? null },
    line: {
      kind: 'mark',
      text:
        late === undefined
          ? `Reopened by ${actor.displayName}: running again`
          : `Reopened by ${actor.displayName}: the loader's own close stands (${late.status})`,
    },
    now,
  });
  await ctx.db.patch(
    run._id,
    late === undefined
      ? { status: 'running', finishedAt: undefined, markedFailed: undefined }
      : {
          status: late.status,
          finishedAt: late.at,
          ...(late.error !== undefined && { error: late.error }),
          markedFailed: undefined,
          loaderFinish: undefined,
        },
  );
  return { actionId };
}

// ── Wait 30 minutes, and its inverse ───────────────────────────────────────────────────────────────

export async function waitOnRunImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  args: { runId: Id<'importRuns'>; now: number },
): Promise<RunWriteResult & { until: number }> {
  const run = await runOf(ctx, args.runId);
  if (!isLive(run)) throw new ConvexError(WAIT_FINISHED);
  const serverNow = Date.now();
  if (run.stallWait !== undefined && run.stallWait.until > serverNow) {
    throw new ConvexError(WAIT_ALREADY);
  }
  const liveness = runLiveness(
    {
      kind: run.kind,
      status: run.status,
      ...(run.progressAt !== undefined && { progressAt: run.progressAt }),
    },
    serverNow,
  );
  if (liveness.state === 'notRecorded') throw new ConvexError(WAIT_NO_HEARTBEAT);
  if (liveness.state !== 'stalled') throw new ConvexError(WAIT_NOT_STALLED);
  const at = callerNow(args.now, serverNow, CLOCK_SLACK_MS);
  const until = at + RUN_WAIT_MS;
  const actionId = await record(ctx, actor, run, {
    action: 'wait_on_run',
    reason: 'Waited 30 minutes on a stalled run',
    metadata: { until, prev: run.stallWait ?? null },
    line: {
      kind: 'wait',
      text: `${actor.displayName} is waiting 30 minutes before calling it stalled`,
    },
    now: serverNow,
  });
  await ctx.db.patch(run._id, { stallWait: { until, byUserId: actor._id, at, actionId } });
  return { actionId, until };
}

export async function stopWaitingOnRunImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  args: { runId: Id<'importRuns'>; reason?: string },
): Promise<RunWriteResult> {
  const run = await runOf(ctx, args.runId);
  const wait = run.stallWait;
  if (wait === undefined) throw new ConvexError(WAIT_NONE);
  const now = Date.now();
  if (wait.until <= now) throw new ConvexError(WAIT_EXPIRED);
  const actionId = await record(ctx, actor, run, {
    action: 'stop_waiting_on_run',
    reason: args.reason ?? 'Stopped waiting on a stalled run',
    metadata: { prev: wait },
    line: { kind: 'wait', text: `${actor.displayName} stopped waiting` },
    now,
  });
  await ctx.db.patch(run._id, { stallWait: undefined });
  return { actionId };
}

// ── A request to stop (built, not drawn), and its withdrawal ────────────────────────────────────────

export async function requestRunStopImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  args: { runId: Id<'importRuns'> },
): Promise<RunWriteResult> {
  const run = await runOf(ctx, args.runId);
  if (!isLive(run)) throw new ConvexError(STOP_FINISHED);
  if (run.stopRequest !== undefined) throw new ConvexError(STOP_ALREADY);
  const now = Date.now();
  const actionId = await record(ctx, actor, run, {
    action: 'request_run_stop',
    reason: 'Asked a run to stop at its next flush',
    metadata: {},
    line: { kind: 'stop', text: `${actor.displayName} asked the run to stop at its next flush` },
    now,
  });
  await ctx.db.patch(run._id, { stopRequest: { byUserId: actor._id, at: now, actionId } });
  return { actionId };
}

export async function withdrawRunStopImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  args: { runId: Id<'importRuns'>; reason?: string },
): Promise<RunWriteResult> {
  const run = await runOf(ctx, args.runId);
  const request = run.stopRequest;
  if (request === undefined) throw new ConvexError(STOP_NONE);
  if (request.seenAt !== undefined) throw new ConvexError(STOP_SEEN);
  const now = Date.now();
  const actionId = await record(ctx, actor, run, {
    action: 'withdraw_run_stop',
    reason: args.reason ?? 'Withdrew a request to stop a run',
    metadata: { prev: request },
    line: { kind: 'stop', text: `${actor.displayName} withdrew the request to stop` },
    now,
  });
  await ctx.db.patch(run._id, { stopRequest: undefined });
  return { actionId };
}

// ── The mutations ──────────────────────────────────────────────────────────────────────────────────

/**
 * Refused when the run isn't `running`, is already marked, or the reason is empty (the record's
 * *why*, asked in a dialog). With `afterPass` (*Mark the campaign failed too*), also refused unless
 * the run is a campaign whose newest pass is that one, marked, with nothing after the mark. Sets `status: 'failed'`, `finishedAt` and `markedFailed`, writes a
 * `mark` line, and asks for the weather-cell walk when the run changed bodies (`markChangedBodies`).
 */
export const markRunFailed = mutation({
  args: {
    runId: v.id('importRuns'),
    reason: v.string(),
    /** *Mark the campaign failed too*: the campaign's pass already marked, which must still be its newest. */
    afterPass: v.optional(v.id('importRuns')),
  },
  handler: async (ctx, args): Promise<RunWriteResult> => {
    const actor = await requireCapability(ctx, 'machinery.corpus');
    return markRunFailedImpl(ctx, actor, args);
  },
});

/**
 * The mark's inverse: clears it; the status becomes the loader's late close if one came
 * (`loaderFinish`), else `running` again. As an undo, refused if the run was marked again since.
 */
export const reopenRun = mutation({
  args: { runId: v.id('importRuns') },
  handler: async (ctx, args): Promise<RunWriteResult> => {
    const actor = await requireCapability(ctx, 'machinery.corpus');
    return reopenRunImpl(ctx, actor, args);
  },
});

/**
 * *Wait 30 minutes*: refused when the run isn't stalled by the server's clock, or already waiting.
 * Sets `stallWait: { until: now + 30 min, … }` and writes a `wait` line. `now` is the caller's.
 */
export const waitOnRun = mutation({
  args: { runId: v.id('importRuns'), now: v.number() },
  handler: async (ctx, args): Promise<RunWriteResult & { until: number }> => {
    const actor = await requireCapability(ctx, 'machinery.corpus');
    return waitOnRunImpl(ctx, actor, args);
  },
});

/** The wait's inverse: clears it; refused once it has expired (nothing to undo). */
export const stopWaitingOnRun = mutation({
  args: { runId: v.id('importRuns') },
  handler: async (ctx, args): Promise<RunWriteResult> => {
    const actor = await requireCapability(ctx, 'machinery.corpus');
    return stopWaitingOnRunImpl(ctx, actor, args);
  },
});

/**
 * A request to stop (built, not drawn): refused when the run isn't `running`, or already asked.
 * Sets `stopRequest` and writes a `stop` line; `runEvents.append` returns `stop` to the run, or to
 * every pass whose `parentRunId` is it.
 */
export const requestRunStop = mutation({
  args: { runId: v.id('importRuns') },
  handler: async (ctx, args): Promise<RunWriteResult> => {
    const actor = await requireCapability(ctx, 'machinery.corpus');
    return requestRunStopImpl(ctx, actor, args);
  },
});

/** The stop's inverse: clears it; refused once `seenAt` is set (the run has stopped). */
export const withdrawRunStop = mutation({
  args: { runId: v.id('importRuns') },
  handler: async (ctx, args): Promise<RunWriteResult> => {
    const actor = await requireCapability(ctx, 'machinery.corpus');
    return withdrawRunStopImpl(ctx, actor, args);
  },
});
