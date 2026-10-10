/**
 * The live imagery job's run state (A06i §5, D214): a lease, a backoff and a breaker — and no
 * scheduling at all.
 *
 * Both jobs run from **fixed crons** (`crons.ts`): the pump every 3 minutes, the index build every
 * 10. A tick with nothing to do is one read. A tick that finds the lease held, or the job backing
 * off, does nothing — the next tick is minutes away whatever happened to this one.
 *
 * ⚠ **Why crons and not self-scheduled beats** (three self-review rounds, 2026-10-06). Every version
 * that scheduled its own next run grew a new way to lose or double it: chains that multiplied per
 * wake-up, a lease that lapsed inside a run, a beat id that outlived a failed run and wedged the job
 * for good, a crashed holder with nothing scheduled behind it. A fixed tick cannot be lost, stacked
 * or wedged, so none of that machinery exists here.
 */

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

export type JobKey = 'pump' | 'index';

/** Longer than Convex's 10-minute action limit: a lease can only lapse once its holder is dead. */
export const LEASE_MS = 15 * 60_000;

/** How long a failing Fly or archive holds the pump off. */
export const BACKOFF_MS = 30 * 60_000;

/** Refusals in a row that trip the spawn breaker. */
export const SPAWN_BREAKER = 3;

export async function jobRow(ctx: QueryCtx, key: JobKey): Promise<Doc<'imageryPump'> | null> {
  return await ctx.db
    .query('imageryPump')
    .withIndex('by_key', (q) => q.eq('key', key))
    .unique();
}

async function ensureRow(ctx: MutationCtx, key: JobKey): Promise<Doc<'imageryPump'>> {
  const row = await jobRow(ctx, key);
  if (row) return row;
  const id = await ctx.db.insert('imageryPump', { key, runningUntil: 0 });
  return (await ctx.db.get(id)) as Doc<'imageryPump'>;
}

export type Begun =
  | { ok: true; refusalStreak: number; blindTicks: number; unreadableStreak: number }
  | { ok: false; reason: 'running' | 'backing off' };

/**
 * Take the lease for one run, unless another run holds it or the job is backing off.
 *
 * A backoff the breaker caused ends **half-open**: the streak is set one short of tripping, so the
 * first run after it makes exactly one probe spawn — a success closes the breaker, a refusal trips
 * it again. Without this a tripped streak, carried across runs, would hand every claim back untried
 * for ever and nothing could reset it.
 */
export async function beginRun(ctx: MutationCtx, key: JobKey, token: string): Promise<Begun> {
  const row = await ensureRow(ctx, key);
  const now = Date.now();
  if (row.runningUntil > now) return { ok: false, reason: 'running' };
  if (row.backoffUntil !== undefined && row.backoffUntil > now) {
    return { ok: false, reason: 'backing off' };
  }
  const streak = Math.min(row.refusalStreak ?? 0, SPAWN_BREAKER - 1);
  await ctx.db.patch(row._id, {
    runningUntil: now + LEASE_MS,
    token,
    runStartedAt: now,
    backoffUntil: undefined,
    refusalStreak: streak,
  });
  return {
    ok: true,
    refusalStreak: streak,
    blindTicks: row.blindTicks ?? 0,
    unreadableStreak: row.unreadableStreak ?? 0,
  };
}

/**
 * Give the lease back — **only with the token that took it**, so a holder that outlived its lease
 * cannot free its successor's — and record what the run learned. An admin's reset during the run
 * wins: the run's stale streak and backoff are dropped rather than written over it.
 */
export async function endRun(
  ctx: MutationCtx,
  key: JobKey,
  token: string,
  outcome: {
    backoff?: boolean;
    /** A backoff of its own length, rather than `BACKOFF_MS`. */
    backoffMs?: number;
    refusalStreak?: number;
    blindTicks?: number;
    unreadableStreak?: number;
  },
): Promise<void> {
  const row = await jobRow(ctx, key);
  if (!row || row.token !== token) return;
  const resetDuringRun = (row.forcedAt ?? 0) > (row.runStartedAt ?? 0);
  await ctx.db.patch(row._id, {
    runningUntil: 0,
    token: undefined,
    ...(resetDuringRun
      ? {}
      : {
          ...(outcome.backoffMs !== undefined
            ? { backoffUntil: Date.now() + outcome.backoffMs }
            : outcome.backoff
              ? { backoffUntil: Date.now() + BACKOFF_MS }
              : {}),
          ...(outcome.refusalStreak !== undefined ? { refusalStreak: outcome.refusalStreak } : {}),
          ...(outcome.blindTicks !== undefined ? { blindTicks: outcome.blindTicks } : {}),
          ...(outcome.unreadableStreak !== undefined
            ? { unreadableStreak: outcome.unreadableStreak }
            : {}),
        }),
  });
}

/** An admin's "try again now": clear the backoff and close the breaker, even mid-run. */
export async function clearBackoff(ctx: MutationCtx, key: JobKey): Promise<void> {
  const row = await ensureRow(ctx, key);
  await ctx.db.patch(row._id, {
    backoffUntil: undefined,
    refusalStreak: 0,
    blindTicks: 0,
    forcedAt: Date.now(),
  });
}

/** Ask for an index rebuild: the next index tick sees it. */
export async function markDirty(ctx: MutationCtx, key: JobKey): Promise<void> {
  const row = await ensureRow(ctx, key);
  await ctx.db.patch(row._id, { dirtySeq: (row.dirtySeq ?? 0) + 1 });
}

/** The rebuild a build should satisfy, or `null` if none is outstanding. */
export function outstanding(row: Doc<'imageryPump'> | null): number | null {
  const asked = row?.dirtySeq ?? 0;
  return asked > (row?.builtSeq ?? 0) ? asked : null;
}

/**
 * Mark `seq` built — **compare-and-clear**, after the build succeeds. Nothing is cleared up front,
 * so a build killed mid-way (the action limit, a deploy) leaves the request standing for the next
 * tick; and a frame that lands during the build raises `dirtySeq` past `seq`, so it is built again.
 */
export async function markBuilt(ctx: MutationCtx, key: JobKey, seq: number): Promise<void> {
  const row = await ensureRow(ctx, key);
  if ((row.builtSeq ?? 0) < seq) await ctx.db.patch(row._id, { builtSeq: seq });
}
