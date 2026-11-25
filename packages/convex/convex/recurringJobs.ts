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
 * | compute body geometry facts | a body | on `bodyGeoFacts`, mirrored | out of the due range; retried daily (`bodyGeo.computeDue` parked) |
 * | repair body geometry drift | a facts row | `jobFailures` | never parked: the row goes to the back and the body is marked for recompute |
 * | find bodies missing geometry | a library row | `jobFailures` | never parked: the weekly walk is the retry |
 * | reset lapsed suspensions | a person | on the profile, mirrored | out of the due range; retried daily (`peopleJobs.retryLapsedDaily`) |
 * | reconcile clerk ban locks | a lock it repaired, or the run | `jobFailures` | never parked: a repair is counted for a week; an unfinished run until one finishes |
 * | the Inbox's backfill (by hand) | a source row | `jobFailures` | the drift repair retries it while failing; once parked, retried daily — the Inbox says `pending` until none is owed |
 * | the Corpus tasks' backfill (by hand) | a body | `jobFailures` | the same: the drift repair retries it while failing; once parked, retried daily — the lanes say `pending` until none is owed |
 * | repair corpus tasks drift | a body, or a lane's counts | `jobFailures` | its walk retries it while the body has a question; failing or parked, retried daily too — a body that left the walk has no other |
 */

import { CORPUS_TASK_LANES } from '@skating/core';
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
import { COUNT_LIMITS } from './corpusTaskJobs';
import { recordPromptFailure } from './gpsActivities';
import { requireCapability } from './lib/auth';
import { FAILING_JOBS, type FailingJob } from './lib/enums';
import { traced } from './lib/readBudget';
import {
  affords,
  clearFailure,
  failedSinceAt,
  forgetFailuresBefore,
  forgetGoneMirrors,
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

/** Mirrored failures the daily retry checks for work that went some other way, at most. */
const MIRRORS_CHECKED = 10;

/** Parked pieces of each job the daily retry tries a run. */
export const DAILY_RETRIES = 5;

/** What retrying one parked piece may spend — the most any job's item does. */
const RETRY_ITEM: ItemBudget = {
  limits: { bytesRead: 8 * MiB, documentsRead: 3000, databaseQueries: 300, documentsWritten: 300 },
  reserve: { bytesRead: 1 * MiB, documentsRead: 200, databaseQueries: 100, documentsWritten: 100 },
};

/** What retrying one lane's Corpus task counts may spend: its own walk's limits (`COUNT_LIMITS`). */
const RETRY_COUNTS: ItemBudget = { limits: COUNT_LIMITS, reserve: RETRY_ITEM.reserve };

/**
 * The jobs the daily retry walks, in order. Appended to, never reordered: a run's continuation
 * carries its place as an index (`at`).
 */
const DAILY_JOBS = [
  'prompt',
  'card',
  'standing',
  'inbox',
  'corpusBackfill',
  'corpusRepair',
] as const;

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
 * could not decide has no next walk — the daily retry is its only second attempt. The Corpus tasks'
 * repair is retried the same way, for the same reason: its walk meets only bodies with a question,
 * so a body that failed and then lost its question (or its row) is never met again.
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
          if (outcome === 'defer') {
            // A lane's counts need more than this transaction has left: the next one starts fresh.
            await ctx.scheduler.runAfter(0, internal.recurringJobs.retryParkedDaily, {
              cutoff,
              at,
              tried,
            });
            return { freed, failed, more: true };
          }
          tried++;
          if (outcome === 'freed') freed++;
          else failed++;
        }
      }
      // Mirrored failures of recordings and cards that went some other way (erased with an account,
      // a card whose body was removed): checked a few a day.
      await forgetGoneMirrors(ctx, 'prompts', MIRRORS_CHECKED, async (key) => {
        const id = ctx.db.normalizeId('gpsActivities', key);
        const row = id ? await ctx.db.get(id) : null;
        return row?.promptState === 'pending' && row.promptAttempts !== undefined;
      });
      await forgetGoneMirrors(ctx, 'cards', MIRRORS_CHECKED, async (key) => {
        const id = ctx.db.normalizeId('waterBodies', key);
        const row = id
          ? await ctx.db
              .query('bodySummaryRefreshes')
              .withIndex('by_water_body', (q) => q.eq('waterBodyId', id))
              .first()
          : null;
        return row?.attempts !== undefined;
      });
      return { freed, failed, more: false };
    }),
});

/**
 * Try the least recently tried parked piece of one job; `none` when it has none left this run, `defer`
 * when the piece needs a fresh transaction.
 */
async function retryOne(
  ctx: MutationCtx,
  job: (typeof DAILY_JOBS)[number],
  cutoff: number,
  now: number,
): Promise<'freed' | 'failed' | 'none' | 'defer'> {
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
  if (job === 'inbox') {
    // A source the Inbox's backfill parked (PR #170): the drift repair retries only what is still
    // failing, so a parked one would stay a missing question, and the Inbox `pending`, for good.
    const row = await ctx.db
      .query('jobFailures')
      .withIndex('by_job_parked', (q) =>
        q.eq('job', 'inboxBackfill').gt('parkedAt', 0).lt('parkedAt', cutoff),
      )
      .first();
    if (!row) return 'none';
    const one = await runIsolated<unknown>(
      ctx,
      internal.inboxItems.retryBackfillSource,
      { key: row.key },
      RETRY_ITEM.limits,
    );
    if (one.ok) return 'freed';
    await recordFailure(ctx, 'inboxBackfill', row.key, one.errorClass, now, {
      byDailyRetry: true,
    });
    return 'failed';
  }
  if (job === 'corpusBackfill') return retryCorpusBackfill(ctx, cutoff, now);
  if (job === 'corpusRepair') return retryCorpusRepair(ctx, cutoff, now);
  // The rollover's bodies: any failing one, least recently failed first (parked ones by when they
  // were last tried). Only what failed before the run began.
  const row = await nextFailingRetry(ctx, 'standingRollover', cutoff);
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

/**
 * A body the Corpus tasks' backfill parked (B01-7a): the drift repair retries only what is still
 * failing, and `corpusTasksPending` reads true while any backfill failure is owed — so a parked one
 * would leave the lanes `pending` for good. Synced as the backfill syncs it; a key that names no body
 * is no question, and a body since deleted syncs to nothing (any task it left open leaves with it):
 * either way the row is cleared.
 */
async function retryCorpusBackfill(
  ctx: MutationCtx,
  cutoff: number,
  now: number,
): Promise<'freed' | 'failed' | 'none'> {
  const row = await ctx.db
    .query('jobFailures')
    .withIndex('by_job_parked', (q) =>
      q.eq('job', 'corpusTaskBackfill').gt('parkedAt', 0).lt('parkedAt', cutoff),
    )
    .first();
  if (!row) return 'none';
  const id = ctx.db.normalizeId('waterBodies', row.key);
  const one =
    id === null
      ? ({ ok: true } as const)
      : await runIsolated<unknown>(
          ctx,
          internal.corpusTaskJobs.syncOne,
          { waterBodyId: id },
          RETRY_ITEM.limits,
        );
  if (one.ok) {
    await clearFailure(ctx, 'corpusTaskBackfill', row.key);
    return 'freed';
  }
  await recordFailure(ctx, 'corpusTaskBackfill', row.key, one.errorClass, now, {
    byDailyRetry: true,
  });
  return 'failed';
}

/**
 * A piece the Corpus tasks' drift repair failed: failing first, then parked, each from before the
 * run. Its walk retries a body only while it carries a question (or an open task), so one that failed
 * and then lost both — answered, or deleted — would sit on Machinery for good. A body is repaired as
 * the walk repairs it, a lane's counts recounted under their own limits; a key that names neither is
 * cleared.
 */
async function retryCorpusRepair(
  ctx: MutationCtx,
  cutoff: number,
  now: number,
): Promise<'freed' | 'failed' | 'none' | 'defer'> {
  const row = await nextFailingRetry(ctx, 'corpusTaskRepair', cutoff);
  if (!row) return 'none';
  let one: { ok: true } | { ok: false; errorClass: string } = { ok: true };
  const lane = row.key.startsWith('counts:') ? row.key.slice('counts:'.length) : null;
  const id = lane === null ? ctx.db.normalizeId('waterBodies', row.key) : null;
  if (lane !== null && (CORPUS_TASK_LANES as readonly string[]).includes(lane)) {
    if (!(await affords(ctx, RETRY_COUNTS))) return 'defer';
    one = await runIsolated<number>(
      ctx,
      internal.corpusTaskJobs.repairCountsOne,
      { lane },
      COUNT_LIMITS,
    );
  } else if (id !== null) {
    one = await runIsolated<unknown>(
      ctx,
      internal.corpusTaskJobs.repairOne,
      { waterBodyId: id },
      RETRY_ITEM.limits,
    );
  }
  if (one.ok) {
    await clearFailure(ctx, 'corpusTaskRepair', row.key);
    return 'freed';
  }
  await recordFailure(ctx, 'corpusTaskRepair', row.key, one.errorClass, now, {
    byDailyRetry: true,
  });
  return 'failed';
}

/** The next piece of `job` to retry: failing and not parked first, then parked — each before `cutoff`. */
async function nextFailingRetry(
  ctx: QueryCtx,
  job: 'standingRollover' | 'corpusTaskRepair',
  cutoff: number,
): Promise<Doc<'jobFailures'> | null> {
  const failing = await ctx.db
    .query('jobFailures')
    .withIndex('by_job_parked', (q) => q.eq('job', job).eq('parkedAt', undefined))
    .filter((q) => q.lt(q.field('lastFailedAt'), cutoff))
    .first();
  if (failing) return failing;
  return ctx.db
    .query('jobFailures')
    .withIndex('by_job_parked', (q) => q.eq('job', job).gt('parkedAt', 0).lt('parkedAt', cutoff))
    .first();
}

// ── The Machinery read ──────────────────────────────────────────────────────────────────────────

/**
 * The most of one job's failing work the read counts; past it the count says it is capped. Every row
 * it reads is a `jobFailures` row — ids, numbers and a class — so the read is small however heavy the
 * work it describes.
 */
export const HEALTH_CAP = 200;
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
 * **The recurring jobs' failing work, for Machinery** (`machinery.read`): per job, how much is failing
 * and how much parked, the oldest parked time and the oldest failure, and the error classes — counts
 * only, from small rows only: the queue-shaped jobs' state is mirrored into `jobFailures`; an account
 * more than a day past its deletion date and an expired bundle whose blob would not delete are counted
 * there by their sweeps. `erasure.parked` and `bodyLibrary.parked` keep their own reads.
 *
 * Bounded: each job reads at most `HEALTH_CAP` rows (plus one to tell), and says `capped` past it.
 */
export const health = query({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, { now: callerNow }): Promise<{ jobs: JobHealth[] }> => {
    await requireCapability(ctx, 'machinery.read');
    // Small rows only (D258): every job's failing work is a `jobFailures` row — the queue-shaped jobs'
    // state is mirrored there — so the read never loads a queue row, a recording or a profile.
    void callerNow;
    const jobs: JobHealth[] = [];
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
    return { jobs };
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
  notifications: 'flush notification queue',
  prompts: 'prompt unreported skates',
  cards: 'sweep body summaries',
  finalizeDeletions: 'finalize account deletions',
  expiredExports: 'sweep expired exports',
  bodyGeo: 'compute body geometry facts',
  geoDrift: 'repair body geometry drift',
  geoMissing: 'find bodies missing geometry',
  lapses: 'reset lapsed suspensions',
  clerkMirror: 'reconcile clerk ban locks',
  // The backfill is run by hand; its failures are retried by the repair's cron, parked ones daily.
  inboxBackfill: 'repair inbox items drift',
  inboxRepair: 'repair inbox items drift',
  photoPurge: 'purge removed photos',
  // The rotation runs per takedown, not by cron; its watch retries it, parked ones daily. A stored
  // photo file owed a deletion (`lib/photoFiles`, key `file:<id>`) is its row too, whoever owed it —
  // a rotation, a delete, the purge — retried by the watch and by the daily 'sweep photo files'.
  photoRotation: 'rotate or release a photo’s files',
  // B01-7a: the backfill is run by hand; its failures are retried by the repair's cron, parked ones
  // daily. The repair's own are retried by its walk, and daily.
  corpusTaskBackfill: 'repair corpus tasks drift',
  corpusTaskRepair: 'repair corpus tasks drift',
};
