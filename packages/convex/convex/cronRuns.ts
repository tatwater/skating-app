/**
 * **The cron dispatchers** (D343, D347, B01-8b): every cron is registered against one of these two
 * with `{ job: <name> }`, and each looks its job up in the registry (`cronJobs.ts`), runs it, and
 * records the tick — the heartbeat (`cronHeartbeats`), the tick in its bucket row (`cronTicks`), and
 * for a tick that worked or failed its run row (`cronRuns`) and its lines (`runEvents`).
 *
 * - `tickMutation` runs a mutation job as a nested transaction under what the transaction has left
 *   less {@link RECORDER_RESERVE}, catches what it throws, and records the tick in its own (outer)
 *   transaction.
 * - `tickAction` calls an action job's handler in-process, between a `begin` (announcing jobs only:
 *   stamps `runningSince`, and records a stale one as killed) and a `finish` that records the tick.
 *
 * A triggered run (*Run now*, *Retry failed*) schedules a dispatcher with `trigger: 'manual'` and the
 * person who pressed it.
 *
 * **What happens when something fails** (each order has its test in `crons.test.ts`):
 *
 * - *The mutation job throws* (its own bug, or a limit it reached under the reduced budget): its
 *   writes roll back exactly as they did before the backbone; the reads it made still count against
 *   the transaction (Convex charges a nested call's overage to its parent), which the reserve is
 *   sized for; the tick is recorded `failed` with its message, and the outer transaction commits.
 * - *The recorder throws after a mutation job succeeded*: the recorder's error is caught and logged,
 *   and the outer transaction commits with the job's writes (a nested transaction commits only with
 *   its parent, so rethrowing would undo the job's work). That tick is then unrecorded, or partly
 *   recorded: the recorder's own rows only, never anything of the job's.
 * - *An action job throws*: `finish` records it `failed`, then the dispatcher rethrows, so Convex's
 *   own log of the cron says failed too. An action's writes are each their own transaction, kept.
 * - *`begin` or `finish` throws*: caught and logged; the job still runs (a `begin` that failed only
 *   means a kill of this tick won't be seen), and the job's work is untouched (it committed as it
 *   went).
 * - *An action is killed* (Convex's action limit, or a deploy): `finish` never runs. The next
 *   announcing tick's `begin` finds the stale `runningSince` and records that tick `killed` first.
 *   A non-announcing action killed mid-run goes unrecorded (they are the short ones).
 *
 * **Recording mode** (`cronJobs.ts`, `CronRecordMode`): a `sparse` job's quiet tick is skipped — no
 * write at all, one heartbeat read — unless it is the job's first in its UTC hour, or the first quiet
 * tick after a failed or killed one (so a recovered job's heartbeat never reads failed for an hour).
 */

import {
  CRON_REPORT_LINE_MAX,
  CRON_REPORT_MAX_LINES,
  CRON_TICK_CODES,
  type CronReport,
  type CronReportLine,
  packTick,
} from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalAction, internalMutation, type MutationCtx } from './_generated/server';
import {
  type CronActionJob,
  type CronJobEntry,
  type CronMutationJob,
  cronJob,
  cronPeriodMs,
} from './cronJobs';
import { type CRON_OUTCOMES, type CRON_RUN_OUTCOMES, CRON_TRIGGERS } from './lib/enums';
import { literals } from './lib/validators';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const KIB = 1024;
const MIB = 1024 * KIB;

/** Convex's action limit (its docs: "Actions time out after 10 minutes"). */
export const ACTION_LIMIT_MS = 10 * MINUTE_MS;
/** A `runningSince` older than this was killed: the limit and a minute's slack (core's rule too). */
export const KILLED_AFTER_MS = ACTION_LIMIT_MS + MINUTE_MS;

/**
 * **What the recorder keeps back from a mutation job's budget**: the job's nested transaction may
 * use what the transaction has left less this, so a job that spends to its edge fails inside its own
 * transaction (recorded `failed`) and never takes the record down with it.
 *
 * Sized for the recorder's worst tick plus a nested call's overage, which Convex charges to the
 * parent ("the limit determines when a nested transaction will fail, but the actual consumption
 * tracked will count the overage"): one more document read or written past its limit, at most 1 MiB.
 * The recorder itself reads two rows by index (the heartbeat, the bucket) and writes at most a
 * heartbeat, a bucket, a run row and its lines ({@link CRON_REPORT_MAX_LINES} of at most 500
 * characters). Against Convex's 4,096 ranges, 32,000 documents read, 16,000 written and 16 MiB each
 * way, the job loses 8 ranges, 8 reads, 208 writes, 1.06 MiB of reads and 1.5 MiB of writes — far
 * inside the headroom every budgeting job already keeps (`lib/readBudget`: 3,500 ranges, 28,000
 * documents, 12 MiB).
 */
export const RECORDER_RESERVE = {
  databaseQueries: 8,
  documentsRead: 8,
  documentsWritten: 8 + CRON_REPORT_MAX_LINES,
  bytesRead: MIB + 64 * KIB,
  bytesWritten: MIB + 512 * KIB,
} as const;

/** A tick row's bucket: a UTC hour for a job ticking more often than every 30 minutes, else a day. */
export function bucketMsOf(entry: CronJobEntry): number {
  return cronPeriodMs(entry.schedule) < 30 * MINUTE_MS ? HOUR_MS : DAY_MS;
}

/**
 * The most ticks one row holds. A schedule puts at most 60 in a row (`bucketMsOf`); manual runs can
 * add to it, so the row is bounded here, far under Convex's 8,192-item array cap: past it a tick is
 * kept on the heartbeat (and its run row, if it has one) but not drawn on the strip.
 */
export const TICK_ROW_MAX = 240;

/** A run's headline, in characters. */
export const RUN_DETAIL_MAX = 1_000;
/** A run's or heartbeat's error, in characters. */
export const RUN_ERROR_MAX = 500;
/** A report's counts: at most this many, each named like a field. */
export const RUN_COUNTS_MAX = 64;
const COUNT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SEASON_MAX = 32;

type CronOutcome = (typeof CRON_OUTCOMES)[number];
type CronRunOutcome = (typeof CRON_RUN_OUTCOMES)[number];
type Trigger = (typeof CRON_TRIGGERS)[number];

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

// ─── The report ─────────────────────────────────────────────────────────────────────────────────

/** `text` cut to `max` characters, never through a surrogate pair. */
export function trimText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const REPORT_OUTCOMES = ['ok', 'capped', 'refused', 'failed'] as const;
const LINE_KINDS = ['line', 'warn', 'fail', 'stage'] as const;

/**
 * **A job's return value read as a report** (core's `CronReport`): `{ cronReport }` on an object,
 * else `null` (a quiet tick). Every field is made writable here — text trimmed, counts kept only when
 * finite and named like a field, lines capped and trimmed — so no report can make the recorder's
 * write throw.
 */
export function readReport(value: unknown, now: number): CronReport | null {
  if (typeof value !== 'object' || value === null || !('cronReport' in value)) return null;
  const raw = (value as { cronReport: unknown }).cronReport;
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const report: CronReport = { worked: r.worked === true };
  if (REPORT_OUTCOMES.includes(r.outcome as never)) {
    report.outcome = r.outcome as CronReport['outcome'];
  }
  if (typeof r.detail === 'string' && r.detail.length > 0) {
    report.detail = trimText(r.detail, RUN_DETAIL_MAX);
  }
  if (typeof r.season === 'string' && r.season.length > 0) {
    report.season = trimText(r.season, SEASON_MAX);
  }
  if (typeof r.counts === 'object' && r.counts !== null) {
    const counts: Record<string, number> = {};
    let n = 0;
    for (const [k, c] of Object.entries(r.counts)) {
      if (n >= RUN_COUNTS_MAX) break;
      if (!COUNT_KEY.test(k) || typeof c !== 'number' || !Number.isFinite(c)) continue;
      counts[k] = c;
      n++;
    }
    if (n > 0) report.counts = counts;
  }
  if (Array.isArray(r.lines)) {
    const lines: CronReportLine[] = [];
    for (const line of r.lines.slice(0, CRON_REPORT_MAX_LINES)) {
      if (typeof line !== 'object' || line === null) continue;
      const l = line as Record<string, unknown>;
      lines.push({
        kind: LINE_KINDS.includes(l.kind as never) ? (l.kind as CronReportLine['kind']) : 'line',
        text: trimText(String(l.text ?? ''), CRON_REPORT_LINE_MAX),
        loggedAt: typeof l.loggedAt === 'number' && Number.isFinite(l.loggedAt) ? l.loggedAt : now,
      });
    }
    if (lines.length > 0) report.lines = lines;
  }
  return report;
}

/** A thrown value's message, trimmed for the heartbeat and the run row. */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return trimText(text.length > 0 ? text : 'threw with no message', RUN_ERROR_MAX);
}

/** What one tick came to, as the recorder writes it. */
export interface Tick {
  startedAt: number;
  finishedAt: number;
  trigger: Trigger;
  byUserId?: Id<'profiles'>;
  /** The job threw: its message. */
  error?: string;
  killed?: boolean;
  report: CronReport | null;
}

/**
 * A tick's outcomes: the heartbeat's, the strip's code, and the run row's (`null`: a quiet tick, no
 * run row). A thrown job is `failed` whatever it reported; a report that failed or was refused is a
 * run even with `worked: false`; a refused run (an outside service turned it down) is `worked` on the
 * heartbeat — the liveness rule's word is the schedule's, the refusal is the run's — and `refused` on
 * the strip and the run row. A manual tick is always a run (`ok` when it found nothing to do), so a
 * press is recorded with who pressed it.
 */
export function outcomesOf(tick: Tick): {
  heartbeat: CronOutcome;
  code: number;
  run: CronRunOutcome | null;
} {
  if (tick.killed) return { heartbeat: 'killed', code: CRON_TICK_CODES.killed, run: 'killed' };
  if (tick.error !== undefined) {
    return { heartbeat: 'failed', code: CRON_TICK_CODES.failed, run: 'failed' };
  }
  const r = tick.report;
  if (r?.outcome === 'failed') {
    return { heartbeat: 'failed', code: CRON_TICK_CODES.failed, run: 'failed' };
  }
  if (r?.outcome === 'refused') {
    return { heartbeat: 'worked', code: CRON_TICK_CODES.refused, run: 'refused' };
  }
  if (r?.worked) {
    return { heartbeat: 'worked', code: CRON_TICK_CODES.worked, run: r.outcome ?? 'ok' };
  }
  return {
    heartbeat: 'ok',
    code: CRON_TICK_CODES.ok,
    run: tick.trigger === 'manual' ? 'ok' : null,
  };
}

// ─── The recorder ───────────────────────────────────────────────────────────────────────────────

async function heartbeatOf(ctx: MutationCtx, job: string): Promise<Doc<'cronHeartbeats'> | null> {
  return await ctx.db
    .query('cronHeartbeats')
    .withIndex('by_job', (q) => q.eq('job', job))
    .first();
}

const sameUtcHour = (a: number, b: number) => Math.floor(a / HOUR_MS) === Math.floor(b / HOUR_MS);

/**
 * Whether a `sparse` job's tick is skipped: quiet (no run row), not the job's first in its UTC hour,
 * and not the first after a failure or kill (so recovery shows at once), with no run in flight.
 */
export function sparseSkips(
  entry: CronJobEntry,
  hb: Pick<Doc<'cronHeartbeats'>, 'lastTickAt' | 'lastOutcome' | 'runningSince'> | null,
  tick: Tick,
): boolean {
  if (entry.record !== 'sparse') return false;
  const out = outcomesOf(tick);
  if (out.run !== null || out.heartbeat !== 'ok') return false;
  if (hb?.lastTickAt === undefined || hb.runningSince !== undefined) return false;
  if (hb.lastOutcome !== 'ok' && hb.lastOutcome !== 'worked') return false;
  return sameUtcHour(hb.lastTickAt, tick.startedAt);
}

/**
 * **Record one tick** — the one writer of `cronHeartbeats`, `cronTicks`, `cronRuns` and the cron
 * lines of `runEvents` (with `begin`'s `runningSince`). Reads the heartbeat (`by_job`, one `eq`) and,
 * unless a sparse job's quiet tick is skipped, the bucket (`by_job_bucket`, two `eq`s); writes the
 * run row and its lines first for a tick that has one, then the bucket and the heartbeat. Returns
 * whether it wrote anything. Called through {@link recorder} so a test can make it throw.
 */
async function recordTick(
  ctx: MutationCtx,
  entry: CronJobEntry,
  tick: Tick,
): Promise<'recorded' | 'skipped'> {
  const hb = await heartbeatOf(ctx, entry.name);
  if (sparseSkips(entry, hb, tick)) return 'skipped';
  const out = outcomesOf(tick);
  const ms = Math.max(0, Math.round(tick.finishedAt - tick.startedAt));
  const r = tick.report;

  let runId: Id<'cronRuns'> | undefined;
  if (out.run !== null) {
    runId = await ctx.db.insert('cronRuns', {
      job: entry.name,
      startedAt: tick.startedAt,
      finishedAt: tick.finishedAt,
      outcome: out.run,
      trigger: tick.trigger,
      ...(tick.byUserId !== undefined ? { byUserId: tick.byUserId } : {}),
      ...(r?.season !== undefined ? { season: r.season } : {}),
      ...(r?.detail !== undefined ? { detail: r.detail } : {}),
      ...(tick.error !== undefined ? { error: tick.error } : {}),
      ...(r?.counts !== undefined ? { counts: r.counts } : {}),
      keepUntil: tick.startedAt + entry.retention.runDays * DAY_MS,
    });
    const at = Date.now();
    const keepUntil = tick.startedAt + entry.retention.lineDays * DAY_MS;
    for (const [seq, line] of (r?.lines ?? []).entries()) {
      await ctx.db.insert('runEvents', {
        cronRunId: runId,
        seq,
        at,
        loggedAt: line.loggedAt,
        kind: line.kind,
        text: line.text,
        keepUntil,
      });
    }
  }

  const bucketMs = bucketMsOf(entry);
  const bucketStart = Math.floor(tick.startedAt / bucketMs) * bucketMs;
  const packed = packTick(Math.floor((tick.startedAt - bucketStart) / 1000), out.code);
  const row = await ctx.db
    .query('cronTicks')
    .withIndex('by_job_bucket', (q) => q.eq('job', entry.name).eq('bucketStart', bucketStart))
    .first();
  if (row === null) {
    await ctx.db.insert('cronTicks', {
      job: entry.name,
      bucketStart,
      bucketMs,
      ticks: [packed],
      ms: [ms],
      keepUntil: bucketStart + bucketMs + entry.retention.tickDays * DAY_MS,
    });
  } else if (row.ticks.length < TICK_ROW_MAX) {
    await ctx.db.patch(row._id, { ticks: [...row.ticks, packed], ms: [...row.ms, ms] });
  }

  const failed = out.heartbeat === 'failed' || out.heartbeat === 'killed';
  const fields = {
    lastTickAt: Math.max(hb?.lastTickAt ?? 0, tick.startedAt),
    lastOutcome: out.heartbeat,
    lastMs: ms,
    ...(failed
      ? {
          lastFailedAt: tick.startedAt,
          lastError: tick.error ?? r?.detail ?? (tick.killed ? 'killed' : out.heartbeat),
        }
      : { lastOkAt: tick.startedAt }),
    ...(runId !== undefined ? { lastRunId: runId } : {}),
  };
  if (hb === null) await ctx.db.insert('cronHeartbeats', { job: entry.name, ...fields });
  else await ctx.db.patch(hb._id, fields);
  return 'recorded';
}

/** The recorder, behind an object a test can spy on (its throwing is a failure order to prove). */
export const recorder = { recordTick };

/** One line per tick in Convex's log, naming the job (behind a dispatcher, the log can't). */
function logTick(entry: CronJobEntry, tick: Tick, wrote: 'recorded' | 'skipped' | 'unrecorded') {
  const out = outcomesOf(tick);
  const took = Math.round(tick.finishedAt - tick.startedAt);
  const line = `cron "${entry.name}": ${out.run ?? out.heartbeat} in ${took} ms (${wrote})`;
  if (out.heartbeat === 'failed' || out.heartbeat === 'killed') {
    console.error(`${line}: ${tick.error ?? tick.report?.detail ?? ''}`);
  } else console.log(line);
}

// ─── The mutation dispatcher ────────────────────────────────────────────────────────────────────

/** What a mutation job's nested transaction may use: what is left, less the recorder's reserve. */
export async function nestedLimits(ctx: MutationCtx): Promise<Record<string, number>> {
  const m = await ctx.meta.getTransactionMetrics();
  const out: Record<string, number> = {};
  for (const [key, reserve] of Object.entries(RECORDER_RESERVE)) {
    out[key] = Math.max(0, m[key as keyof typeof RECORDER_RESERVE].remaining - reserve);
  }
  return out;
}

export const tickMutation = internalMutation({
  args: tickArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const entry = requireCronJob(args.job, 'mutation');
    const startedAt = Date.now();
    const transactionLimits = await nestedLimits(ctx);
    let result: unknown = null;
    let error: string | undefined;
    try {
      result = await ctx.runMutation(entry.fn, entry.args, { transactionLimits });
    } catch (err) {
      error = errorText(err);
    }
    const finishedAt = Date.now();
    const tick: Tick = {
      startedAt,
      finishedAt,
      trigger: args.trigger ?? 'cron',
      ...(args.byUserId !== undefined ? { byUserId: args.byUserId } : {}),
      ...(error !== undefined ? { error } : {}),
      report: error === undefined ? readReport(result, finishedAt) : null,
    };
    let wrote: 'recorded' | 'skipped' | 'unrecorded';
    try {
      wrote = await recorder.recordTick(ctx, entry, tick);
    } catch (err) {
      // Never rethrown: the job's nested transaction commits only with this one.
      console.error(
        `cron "${entry.name}": the recorder failed, the job's work is kept: ${errorText(err)}`,
      );
      wrote = 'unrecorded';
    }
    logTick(entry, tick, wrote);
    return null;
  },
});

// ─── The action dispatcher ──────────────────────────────────────────────────────────────────────

const reportValidator = v.object({
  worked: v.boolean(),
  outcome: v.optional(literals(REPORT_OUTCOMES)),
  detail: v.optional(v.string()),
  counts: v.optional(v.record(v.string(), v.number())),
  season: v.optional(v.string()),
  lines: v.optional(
    v.array(v.object({ kind: literals(LINE_KINDS), text: v.string(), loggedAt: v.number() })),
  ),
});

/**
 * An announcing action's start: stamps `runningSince` with this tick's start (so it is never older
 * than the heartbeat's last tick). One already there and stale (past {@link KILLED_AFTER_MS}) is a
 * tick that never finished: recorded `killed` first. A young one is overwritten: a run still inside
 * the limit (a manual run beside the cron's) finishes and records as usual (its `finish` leaves the
 * newer stamp alone), and one killed young by a deploy goes unrecorded as killed — its absence is a
 * gap between ticks, never a false kill.
 */
export const begin = internalMutation({
  args: { job: v.string(), startedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { job, startedAt }) => {
    const entry = requireCronJob(job, 'action');
    const hb = await heartbeatOf(ctx, job);
    const since = hb?.runningSince;
    if (since !== undefined && startedAt - since > KILLED_AFTER_MS) {
      const tick: Tick = {
        startedAt: since,
        finishedAt: since + ACTION_LIMIT_MS,
        trigger: 'cron',
        killed: true,
        report: null,
      };
      await recorder.recordTick(ctx, entry, tick);
      logTick(entry, tick, 'recorded');
    }
    const now = await heartbeatOf(ctx, job);
    if (now === null) await ctx.db.insert('cronHeartbeats', { job, runningSince: startedAt });
    else await ctx.db.patch(now._id, { runningSince: startedAt });
    return null;
  },
});

/** An action tick's end: records it, and clears `runningSince` if this tick set it. */
export const finish = internalMutation({
  args: {
    job: v.string(),
    trigger: literals(CRON_TRIGGERS),
    byUserId: v.optional(v.id('profiles')),
    startedAt: v.number(),
    finishedAt: v.number(),
    error: v.optional(v.string()),
    report: v.union(reportValidator, v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const entry = requireCronJob(args.job, 'action');
    const tick: Tick = {
      startedAt: args.startedAt,
      finishedAt: args.finishedAt,
      trigger: args.trigger,
      ...(args.byUserId !== undefined ? { byUserId: args.byUserId } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
      report: args.report,
    };
    const wrote = await recorder.recordTick(ctx, entry, tick);
    const hb = await heartbeatOf(ctx, args.job);
    if (hb !== null && hb.runningSince === args.startedAt) {
      await ctx.db.patch(hb._id, { runningSince: undefined });
    }
    logTick(entry, tick, wrote);
    return null;
  },
});

export const tickAction = internalAction({
  args: tickArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const entry = requireCronJob(args.job, 'action');
    const startedAt = Date.now();
    if (entry.announces) {
      try {
        await ctx.runMutation(internal.cronRuns.begin, { job: entry.name, startedAt });
      } catch (err) {
        console.error(
          `cron "${entry.name}": begin failed, running the job anyway: ${errorText(err)}`,
        );
      }
    }
    let result: unknown = null;
    let thrown: { error: unknown } | null = null;
    try {
      result = await entry.handler(ctx, entry.args as never);
    } catch (error) {
      thrown = { error };
    }
    const finishedAt = Date.now();
    try {
      await ctx.runMutation(internal.cronRuns.finish, {
        job: entry.name,
        trigger: args.trigger ?? 'cron',
        ...(args.byUserId !== undefined ? { byUserId: args.byUserId } : {}),
        startedAt,
        finishedAt,
        ...(thrown !== null ? { error: errorText(thrown.error) } : {}),
        report: thrown === null ? readReport(result, finishedAt) : null,
      });
    } catch (err) {
      console.error(
        `cron "${entry.name}": finish failed, the tick is unrecorded: ${errorText(err)}`,
      );
    }
    // Rethrown, so Convex's own record of the cron says failed as well.
    if (thrown !== null) throw thrown.error;
    return null;
  },
});
