/**
 * **One failing item never blocks a recurring job** (D257) — the pieces every cron-driven job shares,
 * so the jobs that walk a queue, lap a table or page the corpus fail the same way.
 *
 * - **Each item is its own nested transaction** ({@link runIsolated}), with limits of its own
 *   ({@link ItemBudget}): an item that throws, or reads past its limits, rolls back only itself, and
 *   the walk records it and goes on in the same run. An action that drives a walk gets the same from
 *   one mutation per item ({@link runItem}).
 * - **The walk asks before each item** ({@link affords}): it starts one only while the transaction
 *   can still pay that item's whole limits and what the walk does after it, from the real metrics
 *   (`ctx.meta.getTransactionMetrics`), and otherwise stops and continues — so a heavy item is never
 *   starved into failing by the ones before it.
 * - **A failure counts; progress clears; three in a row park; held is neither** — the one rule,
 *   `lib/attempts`. Work with a row of its own keeps the state on it (the notification queue, the
 *   recorder's activities, the map-card refreshes), because the due range has to leave a parked row
 *   out; work without one keeps it in `jobFailures` ({@link recordFailure}, {@link clearFailure}).
 * - **Only the class crosses** — never a message, which can carry content ({@link asItem}).
 */
import type { FunctionReference } from 'convex/server';
import type { Doc } from '../_generated/dataModel';
import type { ActionCtx, MutationCtx, QueryCtx } from '../_generated/server';
import { nextAttemptState } from './attempts';
import type { FailingJob, LappingJob } from './enums';
import { asFailure, errorClassOf } from './readBudget';

export const MiB = 1 << 20;

/** The transaction limits a nested item runs under, and those its caller checks before it. */
export interface Limits {
  bytesRead: number;
  documentsRead: number;
  databaseQueries: number;
  documentsWritten: number;
}

/**
 * What one item may spend — its nested transaction's own `limits` — and what the walk keeps back
 * past it (`reserve`): the read of the next item, the write that records an outcome, the walk's own
 * bookkeeping at the end of the pass.
 */
export interface ItemBudget {
  limits: Limits;
  reserve: Limits;
}

const KEYS = ['bytesRead', 'documentsRead', 'databaseQueries', 'documentsWritten'] as const;

/**
 * Whether this transaction can still afford one more item at its whole limits, with the reserve past
 * it — read from what the transaction has really spent so far, so a light item leaves room for many
 * and a heavy one for few.
 */
export async function affords(ctx: QueryCtx, budget: ItemBudget): Promise<boolean> {
  const m = await ctx.meta.getTransactionMetrics();
  return KEYS.every((k) => m[k].remaining >= budget.limits[k] + budget.reserve[k]);
}

/** An isolated item's outcome: its value, or the class of what it threw. */
export type Isolated<T> = { ok: true; value: T } | { ok: false; errorClass: string };

/**
 * Run one item as its own nested transaction under `limits`. A throw — or a read past its limits —
 * rolls back only the item's writes (its reads still count against the caller, which {@link affords}
 * planned for) and comes back as its class.
 */
export async function runIsolated<T>(
  ctx: MutationCtx,
  fn: FunctionReference<'mutation', 'internal'>,
  args: Record<string, unknown>,
  limits: Limits,
): Promise<Isolated<T>> {
  try {
    // Typed by the caller (`T`): a reference into the caller's own module would otherwise make its
    // handler's type depend on itself through `_generated/api`.
    const value = (await ctx.runMutation(fn, args, { transactionLimits: limits })) as T;
    return { ok: true, value };
  } catch (err) {
    return { ok: false, errorClass: errorClassOf(err) };
  }
}

/** The same for a walk an action drives: one mutation per item, each its own transaction. */
export async function runItem<T>(
  ctx: ActionCtx,
  fn: FunctionReference<'mutation', 'internal'>,
  args: Record<string, unknown>,
): Promise<Isolated<T>> {
  try {
    const value = (await ctx.runMutation(fn, args)) as T;
    return { ok: true, value };
  } catch (err) {
    return { ok: false, errorClass: errorClassOf(err) };
  }
}

/**
 * An item's body: whatever it throws leaves with its class as data, since an error crossing a nested
 * call (or a function boundary) is rebuilt without it. The throw still rolls the item back. `key`
 * names the item — its id or key, never content — and is the one seam a test uses to make an item
 * fail, whatever the job.
 */
export async function asItem<T>(key: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    console.error(`recurring item ${key} failed`, err);
    throw asFailure(err);
  }
}

// ── jobFailures: the state of work with no row of its own ─────────────────────────────────────

/** A job's failure row for one key, if it has one. */
export function failureOf(
  ctx: QueryCtx,
  job: FailingJob,
  key: string,
): Promise<Doc<'jobFailures'> | null> {
  return ctx.db
    .query('jobFailures')
    .withIndex('by_job_key', (q) => q.eq('job', job).eq('key', key))
    .first();
}

/**
 * Record one failed attempt at a job's item, by the rule (`lib/attempts`): one more in a row, its
 * class, parked at the third — unless `park` is false, for work that must keep being tried (the
 * season watch, whose tick is the whole job). Returns whether this failure parked it.
 */
export async function recordFailure(
  ctx: MutationCtx,
  job: FailingJob,
  key: string,
  errorClass: string,
  now: number,
  opts: { byDailyRetry?: boolean; scope?: string; park?: boolean } = {},
): Promise<'failed' | 'parked'> {
  const row = await failureOf(ctx, job, key);
  const next = nextAttemptState(
    row
      ? {
          attempts: row.attempts,
          errorClass: row.errorClass,
          parkedAt: row.parkedAt,
          retriedAt: row.retriedAt,
        }
      : {},
    { kind: 'failed', errorClass, ...(opts.byDailyRetry ? { byDailyRetry: true } : {}) },
    now,
  );
  // A failure always changes the state.
  const state = next as NonNullable<typeof next>;
  const parkedAt = opts.park === false ? undefined : state.parkedAt;
  const fields = {
    attempts: state.attempts ?? 1,
    errorClass,
    lastFailedAt: now,
    parkedAt,
    retriedAt: state.retriedAt,
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
  };
  if (row) await ctx.db.patch(row._id, fields);
  else await ctx.db.insert('jobFailures', { job, key, firstFailedAt: now, ...fields });
  return parkedAt !== undefined && row?.parkedAt === undefined ? 'parked' : 'failed';
}

/** Progress: the item went through, so whatever it was failing with is cleared. */
export async function clearFailure(ctx: MutationCtx, job: FailingJob, key: string): Promise<void> {
  const row = await failureOf(ctx, job, key);
  if (row) await ctx.db.delete(row._id);
}

/**
 * A run's outcomes at once, for a walk an action drives: each failure recorded, each success that
 * had been failing cleared. One transaction per batch, so a run of a few hundred items costs a few
 * writes, not one call each.
 */
export async function settleFailures(
  ctx: MutationCtx,
  job: FailingJob,
  outcomes: {
    failed: readonly { key: string; errorClass: string; scope?: string }[];
    succeeded: readonly string[];
  },
  now: number,
  opts: { park?: boolean } = {},
): Promise<{ parked: number }> {
  let parked = 0;
  for (const { key, errorClass, scope } of outcomes.failed) {
    const r = await recordFailure(ctx, job, key, errorClass, now, {
      ...(scope !== undefined ? { scope } : {}),
      ...(opts.park !== undefined ? { park: opts.park } : {}),
    });
    if (r === 'parked') parked++;
  }
  for (const key of outcomes.succeeded) await clearFailure(ctx, job, key);
  return { parked };
}

// ── jobPositions: where a lapping walk is ──────────────────────────────────────────────────────

/** A position in an index: the indexed number, and the creation time that breaks its ties. */
export interface Position {
  value: number;
  creationTime: number;
}

/** A lapping job's saved place, if it has one. */
export function lapOf(ctx: QueryCtx, job: LappingJob): Promise<Doc<'jobPositions'> | null> {
  return ctx.db
    .query('jobPositions')
    .withIndex('by_job', (q) => q.eq('job', job))
    .first();
}

/** The position a lap row holds, if it is mid-lap. */
export function positionOf(row: Doc<'jobPositions'> | null): Position | undefined {
  return row?.value !== undefined && row.creationTime !== undefined
    ? { value: row.value, creationTime: row.creationTime }
    : undefined;
}

/** Write a lapping job's place: mid-lap at `at`, or (no `at`) the lap finished and the next to start. */
export async function saveLap(
  ctx: MutationCtx,
  job: LappingJob,
  row: Doc<'jobPositions'> | null,
  at: Position | undefined,
  now: number,
  extra: { run?: string; leaseUntil?: number; lapStartedAt?: number } = {},
): Promise<void> {
  const finished = at === undefined;
  const fields = {
    value: at?.value,
    creationTime: at?.creationTime,
    run: finished ? undefined : extra.run,
    leaseUntil: finished ? undefined : extra.leaseUntil,
    lapStartedAt: finished ? undefined : (extra.lapStartedAt ?? row?.lapStartedAt ?? now),
    lapsCompleted: (row?.lapsCompleted ?? 0) + (finished ? 1 : 0),
    updatedAt: now,
  };
  if (row) await ctx.db.patch(row._id, fields);
  else await ctx.db.insert('jobPositions', { job, ...fields });
}
