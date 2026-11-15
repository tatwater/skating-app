/**
 * **The recurring jobs' failing work, in one place** (D258, B01 §12.8): recording what an
 * action-driven walk could not do, the daily retry of what is parked, and the one Machinery read
 * that says, per job, how much is failing or parked, since when, and with which error classes —
 * counts only, never content, names or ids.
 *
 * The rule is `lib/attempts` (a failure counts, progress clears, three in a row park, held is
 * neither); the isolation is `lib/recurringWork`. Which job keeps its state where:
 *
 * | job (cron) | an item | its state | parked means |
 * | --- | --- | --- | --- |
 * | flush notification queue | a queue row | on the row | out of the due range; retried hourly, expired past its window |
 * | prompt unreported skates | a skater's due rows | on each row | out of the due range; retried daily |
 * | sweep body summaries | a card's refresh row | on the row | out of the due range; card left as it was; retried daily |
 * | demote inactive bodies at the rollover | a body | `jobFailures` | retried daily — the walk runs once a season |
 * | sweep orphan photos | a photo | `jobFailures` | a marker: the walk laps once a day, and its lap is the retry |
 * | repair weather archive gaps | a cell | `jobFailures` | a marker: the walk is daily, and its run is the retry |
 * | reconcile weather cell registry | a page's cells or bodies | `jobFailures` | never parked: a run with failures prunes nothing and is not marked complete |
 * | refresh hazard weather | a hazard | `jobFailures` | never parked: rotated to the back, retried after the cadence gate |
 * | refresh nws alerts | a state | `jobFailures` | never parked: polled every tick |
 * | watch for the imagery season to open | the tick | `jobFailures` | never parked: all-or-nothing by design, counted |
 */

import { DELETION_GRACE_MS } from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
  query,
} from './_generated/server';
import { recordPromptFailure } from './gpsActivities';
import { requireCapability } from './lib/auth';
import { FAILING_JOBS, type FailingJob } from './lib/enums';
import { traced } from './lib/readBudget';
import {
  affords,
  failedSinceAt,
  forgetFailuresBefore,
  type ItemBudget,
  MiB,
  recordFailure,
  runIsolated,
  settleFailures,
} from './lib/recurringWork';
import { literals } from './lib/validators';
import { recordCardFailure } from './waterBodies';

const failedItem = v.object({
  key: v.string(),
  errorClass: v.string(),
  scope: v.optional(v.string()),
});

/**
 * An action-driven walk's outcomes for a batch: each failure recorded by the rule, each success that
 * had been failing cleared. `park: false` for work that must keep being tried.
 */
export const settle = internalMutation({
  args: {
    job: literals(FAILING_JOBS),
    failed: v.array(failedItem),
    succeeded: v.array(v.string()),
    park: v.optional(v.boolean()),
  },
  handler: async (ctx, { job, failed, succeeded, park }): Promise<{ parked: number }> =>
    settleFailures(ctx, job, { failed, succeeded }, Date.now(), {
      ...(park !== undefined ? { park } : {}),
    }),
});

/** Keys a job reads its failing work by, at most this many — a walk clears what it saw succeed. */
const FAILING_KEYS_CAP = 1000;

/**
 * The keys of a job's failing work (parked or not), so a walk an action drives can clear only the
 * successes that had been failing without a write per item. Capped: `capped` says the list is short.
 */
export const failingKeys = internalQuery({
  args: { job: literals(FAILING_JOBS) },
  handler: async (ctx, { job }): Promise<{ keys: string[]; capped: boolean }> => {
    const rows = await ctx.db
      .query('jobFailures')
      .withIndex('by_job_key', (q) => q.eq('job', job))
      .take(FAILING_KEYS_CAP + 1);
    return {
      keys: rows.slice(0, FAILING_KEYS_CAP).map((r) => r.key),
      capped: rows.length > FAILING_KEYS_CAP,
    };
  },
});

/**
 * Whether a job (in `scope`, when given) failed anything at or after `since` — a registry walk prunes
 * only when it did not. Scoped by the walk's tier, since both tiers' walks run at once.
 */
export const failedSince = internalQuery({
  args: { job: literals(FAILING_JOBS), since: v.number(), scope: v.optional(v.string()) },
  handler: (ctx, { job, since, scope }): Promise<boolean> => failedSinceAt(ctx, job, since, scope),
});

/**
 * Forget a job's failures (in `scope`, when given) a complete run did not see again — the work is
 * gone or went through. Oldest first, at most `FAILING_KEYS_CAP` a call.
 */
export const forgetBefore = internalMutation({
  args: { job: literals(FAILING_JOBS), before: v.number(), scope: v.optional(v.string()) },
  handler: (ctx, { job, before, scope }): Promise<number> =>
    forgetFailuresBefore(ctx, job, before, FAILING_KEYS_CAP, scope),
});

// ── The daily retry ─────────────────────────────────────────────────────────────────────────────

/** Parked pieces of each job the daily retry tries a run. */
export const DAILY_RETRIES = 5;

/** What retrying one parked piece may spend — the most any job's item does. */
const RETRY_ITEM: ItemBudget = {
  limits: { bytesRead: 8 * MiB, documentsRead: 3000, databaseQueries: 300, documentsWritten: 300 },
  reserve: { bytesRead: 1 * MiB, documentsRead: 200, databaseQueries: 100, documentsWritten: 100 },
};

/** The jobs the daily retry walks, in order. */
const DAILY_JOBS = ['prompt', 'card', 'standing'] as const;

/**
 * **Parking heals itself** (D258): once a day, a few parked pieces of each job — a skater's prompt, a
 * map card, a body the rollover could not decide — are tried again, least recently tried first, each
 * in its own nested transaction and never in the hourly walks' way. One that goes through is cleared
 * by the rule and back in its walk; one that fails again stays parked, re-stamped as just tried (so it
 * goes behind every other parked piece next day) and noted as retried. Once a run each: a run reads
 * only what was parked, or last tried, before it began. A deployed fix frees what it parked within a
 * day with nobody remembering to.
 *
 * The rollover's bodies are retried whether parked or not: its walk runs once a season, so a body it
 * could not decide has no next walk — the daily retry is its only second attempt.
 */
export const retryParkedDaily = internalMutation({
  args: {
    cutoff: v.optional(v.number()),
    /** Which job the run has reached (`DAILY_JOBS`), and how many of it it has tried. */
    at: v.optional(v.number()),
    tried: v.optional(v.number()),
  },
  handler: (ctx, args): Promise<{ freed: number; failed: number; more: boolean }> =>
    traced('recurringJobs.retryParkedDaily', args, async () => {
      const now = Date.now();
      const cutoff = args.cutoff ?? now;
      let at = Math.max(0, Math.floor(args.at ?? 0));
      let tried = args.tried ?? 0;
      let freed = 0;
      let failed = 0;
      for (; at < DAILY_JOBS.length; at++, tried = 0) {
        while (tried < DAILY_RETRIES) {
          if (!(await affords(ctx, RETRY_ITEM))) {
            await ctx.scheduler.runAfter(0, internal.recurringJobs.retryParkedDaily, {
              cutoff,
              at,
              tried,
            });
            return { freed, failed, more: true };
          }
          const outcome = await retryOne(
            ctx,
            DAILY_JOBS[at] as (typeof DAILY_JOBS)[number],
            cutoff,
            now,
          );
          if (outcome === 'none') break;
          tried++;
          if (outcome === 'freed') freed++;
          else failed++;
        }
      }
      return { freed, failed, more: false };
    }),
});

/** Try the least recently tried parked piece of one job; `none` when it has none left this run. */
async function retryOne(
  ctx: MutationCtx,
  job: (typeof DAILY_JOBS)[number],
  cutoff: number,
  now: number,
): Promise<'freed' | 'failed' | 'none'> {
  if (job === 'prompt') {
    const row = await ctx.db
      .query('gpsActivities')
      .withIndex('by_prompt_parked_detected', (q) =>
        q.eq('promptState', 'pending').gt('promptParkedAt', 0).lt('promptParkedAt', cutoff),
      )
      .first();
    if (!row) return 'none';
    const one = await runIsolated<unknown>(
      ctx,
      internal.gpsActivities.promptSkater,
      { userId: row.userId, dueIds: [row._id], now },
      RETRY_ITEM.limits,
    );
    if (one.ok) return 'freed';
    await recordPromptFailure(ctx, row, one.errorClass, now, { byDailyRetry: true });
    return 'failed';
  }
  if (job === 'card') {
    const row = await ctx.db
      .query('bodySummaryRefreshes')
      .withIndex('by_parked_refresh_at', (q) => q.gt('parkedAt', 0).lt('parkedAt', cutoff))
      .first();
    if (!row) return 'none';
    const one = await runIsolated<null>(
      ctx,
      internal.waterBodies.refreshOneBodySummary,
      { waterBodyId: row.waterBodyId, now },
      RETRY_ITEM.limits,
    );
    if (one.ok) return 'freed';
    await recordCardFailure(ctx, row, one.errorClass, now, { byDailyRetry: true });
    return 'failed';
  }
  // The rollover's bodies: any failing one, least recently failed first (parked ones by when they
  // were last tried). Only what failed before the run began.
  const row = await nextStandingRetry(ctx, cutoff);
  if (!row) return 'none';
  const one = await runIsolated<unknown>(
    ctx,
    internal.standing.rolloverOne,
    { season: Number(row.scope), waterBodyId: row.key, apply: true },
    RETRY_ITEM.limits,
  );
  if (one.ok) return 'freed';
  await recordFailure(ctx, 'standingRollover', row.key, one.errorClass, now, {
    byDailyRetry: true,
    ...(row.scope !== undefined ? { scope: row.scope } : {}),
  });
  return 'failed';
}

/** The next rollover body to retry: failing and not parked first, then parked — each before `cutoff`. */
async function nextStandingRetry(
  ctx: QueryCtx,
  cutoff: number,
): Promise<Doc<'jobFailures'> | null> {
  const failing = await ctx.db
    .query('jobFailures')
    .withIndex('by_job_parked', (q) => q.eq('job', 'standingRollover').eq('parkedAt', undefined))
    .filter((q) => q.lt(q.field('lastFailedAt'), cutoff))
    .first();
  if (failing) return failing;
  return ctx.db
    .query('jobFailures')
    .withIndex('by_job_parked', (q) =>
      q.eq('job', 'standingRollover').gt('parkedAt', 0).lt('parkedAt', cutoff),
    )
    .first();
}

// ── The Machinery read ──────────────────────────────────────────────────────────────────────────

/**
 * The most of one job's failing work the read counts; past it the count says it is capped. Work whose
 * row is small (a failure record, a card's refresh row) counts to `HEALTH_CAP`; work whose row can
 * weigh a document (a queue row's coalesced actors, a recording's path, a profile, an export's error)
 * counts to `HEAVY_CAP`, and only while the transaction can still afford that many at a document
 * each — so the read stays inside its limits however heavy the rows, and says so when it stopped.
 */
export const HEALTH_CAP = 200;
export const HEAVY_CAP = 10;
/** One job's failing work: counts, the oldest age, and the error classes — no content, names or ids. */
export interface JobHealth {
  job: string;
  /** Failing and not (yet) parked: still in its walk. */
  failing: number;
  parked: number;
  /** When the oldest parked piece was parked (or last tried); `null` with nothing parked. */
  oldestParkedAt: number | null;
  /** When the oldest failing piece first failed, parked or not; `null` with nothing failing. */
  oldestFailingSince: number | null;
  /** How many pieces last failed with each class. */
  errorClasses: Record<string, number>;
  /** A count stopped at `HEALTH_CAP`: there are at least this many. */
  capped: boolean;
}

/** What one job's rows say, counted. */
function tally(
  job: string,
  rows: readonly { parkedAt?: number; since?: number; errorClass?: string }[],
  capped: boolean,
): JobHealth {
  const errorClasses: Record<string, number> = {};
  let parked = 0;
  let oldestParkedAt: number | null = null;
  let oldestFailingSince: number | null = null;
  for (const row of rows) {
    if (row.parkedAt !== undefined) {
      parked++;
      oldestParkedAt =
        oldestParkedAt === null ? row.parkedAt : Math.min(oldestParkedAt, row.parkedAt);
    }
    if (row.since !== undefined) {
      oldestFailingSince =
        oldestFailingSince === null ? row.since : Math.min(oldestFailingSince, row.since);
    }
    if (row.errorClass !== undefined) {
      errorClasses[row.errorClass] = (errorClasses[row.errorClass] ?? 0) + 1;
    }
  }
  return {
    job,
    failing: rows.length - parked,
    parked,
    oldestParkedAt,
    oldestFailingSince,
    errorClasses,
    capped,
  };
}

/** Up to `HEALTH_CAP` small rows, and whether there were more. */
async function capped<T>(
  read: (n: number) => Promise<T[]>,
): Promise<{ rows: T[]; capped: boolean }> {
  const rows = await read(HEALTH_CAP + 1);
  return { rows: rows.slice(0, HEALTH_CAP), capped: rows.length > HEALTH_CAP };
}

/**
 * Up to `HEAVY_CAP` rows that may each weigh a document, as many as the transaction can still
 * afford at that weight (from what it has really read), and whether the count stopped short.
 */
async function cappedHeavy<T>(
  ctx: QueryCtx,
  read: (n: number) => Promise<T[]>,
): Promise<{ rows: T[]; capped: boolean }> {
  const m = await ctx.meta.getTransactionMetrics();
  const affordable = Math.floor((m.bytesRead.remaining - HEALTH_RESERVE) / MiB);
  const n = Math.max(0, Math.min(HEAVY_CAP + 1, affordable));
  if (n === 0) return { rows: [], capped: true };
  const rows = await read(n);
  return {
    rows: rows.slice(0, HEAVY_CAP),
    // More than it shows, or a read the budget cut short of the row that would have said.
    capped: rows.length > HEAVY_CAP || (n <= HEAVY_CAP && rows.length === n),
  };
}

/** What the read keeps back for everything after a heavy read: the small tables and the answer. */
const HEALTH_RESERVE = 3 * MiB;

/**
 * **The recurring jobs' failing work, for Machinery** (`machinery.read`): per job, how much is failing
 * and how much parked, the oldest parked time and the oldest failure, and the error classes — counts
 * only. The account deletions and expired exports have no failure record (each account's chain and
 * each bundle's retry are their own); what they show is how much is **overdue** — past its promise by
 * more than a day — and since when. `erasure.parked` and `bodyLibrary.parked` keep their own reads.
 *
 * Bounded: each job reads at most `HEALTH_CAP` rows (plus one to tell), and says `capped` past it.
 */
export const health = query({
  args: { now: v.optional(v.number()) },
  handler: async (
    ctx,
    { now: callerNow },
  ): Promise<{ jobs: JobHealth[]; overdue: OverdueHealth[] }> => {
    await requireCapability(ctx, 'machinery.read');
    const now = callerNow ?? Date.now();
    const jobs: JobHealth[] = [];

    // Every row with a failure on it, parked or not, from its own index: a filter over the due range
    // would scan every healthy row in the queue to find the few that failed. Most attempts first, so
    // a capped count still reaches the parked rows (three or more) before the merely failing.
    const queue = await cappedHeavy(ctx, (n) =>
      ctx.db
        .query('notificationQueue')
        .withIndex('by_attempts', (q) => q.gt('attempts', 0))
        .order('desc')
        .take(n),
    );
    jobs.push(
      tally(
        'flush notification queue',
        queue.rows.map((r) => ({
          ...(r.parkedAt !== undefined ? { parkedAt: r.parkedAt } : {}),
          ...(r.firstDueAt !== undefined ? { since: r.firstDueAt } : {}),
          ...(r.lastErrorClass !== undefined ? { errorClass: r.lastErrorClass } : {}),
        })),
        queue.capped,
      ),
    );

    const prompts = await cappedHeavy(ctx, (n) =>
      ctx.db
        .query('gpsActivities')
        .withIndex('by_prompt_parked_detected', (q) =>
          q.eq('promptState', 'pending').gt('promptParkedAt', 0),
        )
        .take(n),
    );
    jobs.push(
      tally(
        'prompt unreported skates',
        prompts.rows.map((r) => ({
          ...(r.promptParkedAt !== undefined ? { parkedAt: r.promptParkedAt } : {}),
          ...(r.promptErrorClass !== undefined ? { errorClass: r.promptErrorClass } : {}),
        })),
        prompts.capped,
      ),
    );

    const cards = await capped((n) =>
      ctx.db
        .query('bodySummaryRefreshes')
        .withIndex('by_parked_refresh_at', (q) => q.gt('parkedAt', 0))
        .take(n),
    );
    jobs.push(
      tally(
        'sweep body summaries',
        cards.rows.map((r) => ({
          ...(r.parkedAt !== undefined ? { parkedAt: r.parkedAt } : {}),
          ...(r.lastErrorClass !== undefined ? { errorClass: r.lastErrorClass } : {}),
        })),
        cards.capped,
      ),
    );

    for (const job of FAILING_JOBS) {
      const rows = await capped((n) =>
        ctx.db
          .query('jobFailures')
          .withIndex('by_job_key', (q) => q.eq('job', job))
          .take(n),
      );
      jobs.push(
        tally(
          CRON_OF[job],
          rows.rows.map((r) => ({
            ...(r.parkedAt !== undefined ? { parkedAt: r.parkedAt } : {}),
            since: r.firstFailedAt,
            errorClass: r.errorClass,
          })),
          rows.capped,
        ),
      );
    }

    return { jobs, overdue: await overdueHealth(ctx, now) };
  },
});

/** The cron each `jobFailures` job belongs to — the name Machinery shows. */
const CRON_OF: Record<FailingJob, string> = {
  orphanPhotos: 'sweep orphan photos',
  weatherCells: 'reconcile weather cell registry',
  weatherGaps: 'repair weather archive gaps',
  standingRollover: 'demote inactive bodies at the rollover',
  hazardWeather: 'refresh hazard weather',
  nwsAlerts: 'refresh nws alerts',
  seasonWatch: 'watch for the imagery season to open',
};

/** Work past its promise: how much (to the cap) and since when. */
export interface OverdueHealth {
  job: string;
  overdue: number;
  oldestDueAt: number | null;
  capped: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Accounts whose deletion is due a day or more, and expired exports a day or more past expiry. */
async function overdueHealth(ctx: QueryCtx, now: number): Promise<OverdueHealth[]> {
  const accounts = await cappedHeavy(ctx, (n) =>
    ctx.db
      .query('profiles')
      .withIndex('by_deletion_requested_at', (q) =>
        q.gt('deletionRequestedAt', 0).lte('deletionRequestedAt', now - DELETION_GRACE_MS - DAY_MS),
      )
      .take(n),
  );
  const live = accounts.rows.filter((p) => p.status !== 'deleted');
  const exports = await cappedHeavy(ctx, (n) =>
    ctx.db
      .query('dataExports')
      .withIndex('by_expires_at', (q) => q.lt('expiresAt', now - DAY_MS))
      .take(n),
  );
  return [
    {
      job: 'finalize account deletions',
      overdue: live.length,
      oldestDueAt:
        live[0]?.deletionRequestedAt !== undefined
          ? live[0].deletionRequestedAt + DELETION_GRACE_MS
          : null,
      capped: accounts.capped,
    },
    {
      job: 'sweep expired exports',
      overdue: exports.rows.length,
      oldestDueAt: exports.rows[0]?.expiresAt ?? null,
      capped: exports.capped,
    },
  ];
}
