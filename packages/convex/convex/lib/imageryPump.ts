/**
 * Single-flight scheduling for the live imagery job (A06i §5, D214).
 *
 * Two jobs — the `pump` and the `index` build — each run **at most once at a time** and have **at
 * most one pending beat**. Every wake-up (a poll, *Start imagery*, *Retry failed*, a pump that landed
 * a frame, a pump scheduling its own next beat) goes through {@link wakeBeat}, so beats never
 * multiply into parallel chains; and every run brackets itself with {@link beginBeat} and
 * {@link endBeat}, so the lease is held by exactly one token.
 *
 * ⚠ **Why each rule is here** (the build's second self-review, 2026-10-06): a nine-minute lease
 * under a ten-minute action limit could lapse while its holder still ran, and an unowned release
 * then freed the next holder's lease; wake-ups that each scheduled a beat stacked parallel chains,
 * each with its own backoff; and a run that threw scheduled nothing, so one transient error ended
 * the chain. So: the lease outlives any action, only its token releases it, a beat is replaced
 * rather than added, a throw ends in a backoff beat, and a backoff holds against every wake-up but
 * an admin's.
 */

import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

export type BeatKey = 'pump' | 'index';

/** Longer than Convex's 10-minute action limit: a lease can only lapse once its holder is dead. */
export const LEASE_MS = 15 * 60_000;

/** How long a failing Fly or archive holds the pump off. */
export const BACKOFF_MS = 30 * 60_000;

async function stateRow(ctx: MutationCtx, key: BeatKey): Promise<Doc<'imageryPump'>> {
  const row = await ctx.db
    .query('imageryPump')
    .withIndex('by_key', (q) => q.eq('key', key))
    .unique();
  if (row) return row;
  const id = await ctx.db.insert('imageryPump', { key, runningUntil: 0, pending: false });
  return (await ctx.db.get(id)) as Doc<'imageryPump'>;
}

/** Put the one pending beat at `at`, replacing a later one; an earlier one already wins. */
async function placeBeat(ctx: MutationCtx, row: Doc<'imageryPump'>, at: number): Promise<void> {
  if (row.scheduledId && row.nextAt !== undefined && row.nextAt <= at) return;
  if (row.scheduledId) {
    try {
      await ctx.scheduler.cancel(row.scheduledId);
    } catch {
      // Already ran or already gone — either way it is not pending, which is what we needed.
    }
  }
  const delay = Math.max(0, at - Date.now());
  const scheduledId: Id<'_scheduled_functions'> =
    row.key === 'pump'
      ? await ctx.scheduler.runAfter(delay, internal.imageryLive.pump, {})
      : await ctx.scheduler.runAfter(delay, internal.imageryLive.buildIndex, {});
  await ctx.db.patch(row._id, { nextAt: at, scheduledId });
}

/**
 * Ask for a beat in `delayMs`. While a run holds the lease, the request is noted and the holder
 * runs once more when it ends. A backoff holds against every request except a `force`d one — an
 * admin pressing *Start* or *Retry failed* after fixing whatever was failing.
 */
export async function wakeBeat(
  ctx: MutationCtx,
  key: BeatKey,
  delayMs: number,
  options: { force?: boolean } = {},
): Promise<void> {
  const row = await stateRow(ctx, key);
  const now = Date.now();
  if (options.force && (row.backoffUntil !== undefined || row.refusalStreak)) {
    await ctx.db.patch(row._id, { backoffUntil: undefined, refusalStreak: 0 });
    row.backoffUntil = undefined;
  }
  if (row.runningUntil > now) {
    await ctx.db.patch(row._id, { pending: true });
    return;
  }
  let at = now + delayMs;
  if (row.backoffUntil !== undefined && row.backoffUntil > at) at = row.backoffUntil;
  await placeBeat(ctx, row, at);
}

/**
 * Take the lease for a run, or say who has it. The beat being consumed is cleared; a held lease with
 * nothing scheduled gets a beat at its expiry, so a crashed holder can never strand the job.
 */
export async function beginBeat(
  ctx: MutationCtx,
  key: BeatKey,
  token: string,
): Promise<{ ok: true; refusalStreak: number } | { ok: false }> {
  const row = await stateRow(ctx, key);
  const now = Date.now();
  if (row.runningUntil > now) {
    await ctx.db.patch(row._id, { pending: true });
    if (!row.scheduledId || (row.nextAt ?? 0) <= now) {
      await placeBeat(ctx, { ...row, scheduledId: undefined }, row.runningUntil + 1_000);
    }
    return { ok: false };
  }
  await ctx.db.patch(row._id, {
    runningUntil: now + LEASE_MS,
    token,
    pending: false,
    ...((row.nextAt ?? 0) <= now ? { nextAt: undefined, scheduledId: undefined } : {}),
  });
  return { ok: true, refusalStreak: row.refusalStreak ?? 0 };
}

/**
 * Give the lease back — **only with the token that took it**, so a holder that outlived its lease
 * cannot free its successor's. Schedules the next beat: now if someone asked during the run,
 * otherwise `delayMs` (`null` for none), held to any backoff.
 */
export async function endBeat(
  ctx: MutationCtx,
  key: BeatKey,
  token: string,
  outcome: { delayMs: number | null; backoff?: boolean; refusalStreak?: number },
): Promise<void> {
  const row = await stateRow(ctx, key);
  if (row.token !== token) return;
  const now = Date.now();
  const backoffUntil = outcome.backoff ? now + BACKOFF_MS : row.backoffUntil;
  const patch = {
    runningUntil: 0,
    token: undefined,
    pending: false,
    backoffUntil: backoffUntil !== undefined && backoffUntil > now ? backoffUntil : undefined,
    ...(outcome.refusalStreak !== undefined ? { refusalStreak: outcome.refusalStreak } : {}),
  };
  await ctx.db.patch(row._id, patch);
  const delay = row.pending ? 0 : outcome.delayMs;
  if (delay === null) return;
  let at = now + delay;
  if (patch.backoffUntil !== undefined && patch.backoffUntil > at) at = patch.backoffUntil;
  await placeBeat(ctx, { ...row, ...patch }, at);
}
