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
 * - *An action job throws*: `finish` records it `failed` (with the report its error carries, if any:
 *   core's `withCronReport`), then the dispatcher rethrows, so Convex's own log of the cron says
 *   failed too. An action's writes are each their own transaction, kept.
 * - *`begin` or `finish` throws*: caught and logged; the job still runs (a `begin` that failed only
 *   means a kill of this tick won't be seen), and the job's work is untouched (it committed as it
 *   went).
 * - *An action is killed* (Convex's action limit, or a deploy): `finish` never runs. The next
 *   announcing tick's `begin` finds its `runningSince` and records that tick `killed` first: a cron
 *   tick finding a cron stamp at any age (Convex never overlaps a cron with itself), anything else
 *   past the action limit (`stampKilled`, Ma27 (b)). A `finish` that itself failed leaves its stamp
 *   too, so the next cron tick records that tick killed — an unrecorded tick reads as one that died.
 *   A non-announcing action killed mid-run goes unrecorded (they are the short ones).
 *
 * **Recording mode** (`cronJobs.ts`, `CronRecordMode`): a `sparse` job's quiet tick is skipped — no
 * write at all, one heartbeat read — unless it is the job's first in its UTC hour, or the first quiet
 * tick after a failed or killed one (so a recovered job's heartbeat never reads failed for an hour).
 */

import {
  CHAIN_LINES_TAIL,
  CONVEX_ACTION_LIMIT_MS,
  CRON_CAUSE_SAMPLE_MAX,
  CRON_FAILURE_CAUSES,
  CRON_KILLED_AFTER_MS,
  CRON_REPORT_LINE_MAX,
  CRON_REPORT_MAX_LINES,
  CRON_TICK_CODES,
  type CronCauseTally,
  type CronFailureCause,
  type CronReport,
  type CronReportLine,
  type CronTickContext,
  chainLiveness,
  cronTickBucketMs,
  cronTickBucketStart,
  mergeCauseTallies,
  mergeChainCounts,
  packTick,
  planChainLines,
  redactSample,
} from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalAction, internalMutation, type MutationCtx } from './_generated/server';
import {
  CRON_RETENTION,
  type CronActionJob,
  type CronJobEntry,
  type CronMutationJob,
  cronJob,
  cronPeriodMs,
} from './cronJobs';
import { retryOnWriteConflict } from './lib/chainRun';
import { cronCauseTally, cronReportLine } from './lib/cronValidators';
import { type CRON_OUTCOMES, type CRON_RUN_OUTCOMES, CRON_TRIGGERS } from './lib/enums';
import { literals } from './lib/validators';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const KIB = 1024;
const MIB = 1024 * KIB;

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

/** A tick row's bucket, by core's one rule (`cronTickBucketMs`): an hour or a day, from the schedule. */
export function bucketMsOf(entry: CronJobEntry): number {
  return cronTickBucketMs(cronPeriodMs(entry.schedule));
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
  const counts = readCounts(r.counts);
  if (counts !== undefined) report.counts = counts;
  const lines = readLines(r.lines, now, CRON_REPORT_MAX_LINES);
  if (lines !== undefined) report.lines = lines;
  // A chained job's open run (D349): checked against the job by the recorder, which falls back to a
  // run row of its own for an id that isn't one.
  if (typeof r.runId === 'string' && r.runId.length > 0 && r.runId.length <= RUN_ID_MAX) {
    report.runId = r.runId;
  }
  const causes = readCauses(r.causes, now);
  if (causes !== undefined) report.causes = causes;
  return report;
}

/** The longest string a `cronRuns` id can be (Convex ids are 32 characters). */
const RUN_ID_MAX = 64;
/** A cause's sample key (a cell key, a state code, a hazard id), in characters. */
export const CAUSE_KEY_MAX = 120;
/** How many tallies one report or step may send before they are folded: a bound on the work. */
const CAUSES_IN_MAX = 1_000;

/** A report's or step's counts, made writable: finite, named like a field, at most 64. */
export function readCounts(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const counts: Record<string, number> = {};
  let n = 0;
  for (const [k, c] of Object.entries(raw)) {
    if (n >= RUN_COUNTS_MAX) break;
    if (!COUNT_KEY.test(k) || typeof c !== 'number' || !Number.isFinite(c)) continue;
    counts[k] = c;
    n++;
  }
  return n > 0 ? counts : undefined;
}

/** A report's or step's lines, made writable: at most `max`, each trimmed, a known kind. */
export function readLines(raw: unknown, now: number, max: number): CronReportLine[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const lines: CronReportLine[] = [];
  for (const line of raw.slice(0, max)) {
    if (typeof line !== 'object' || line === null) continue;
    const l = line as Record<string, unknown>;
    lines.push({
      kind: LINE_KINDS.includes(l.kind as never) ? (l.kind as CronReportLine['kind']) : 'line',
      text: trimText(String(l.text ?? ''), CRON_REPORT_LINE_MAX),
      loggedAt: typeof l.loggedAt === 'number' && Number.isFinite(l.loggedAt) ? l.loggedAt : now,
    });
  }
  return lines.length > 0 ? lines : undefined;
}

/**
 * Failures by cause, made writable and folded (core's `mergeCauseTallies`): one entry per cause, in
 * the vocabulary's order, an unknown cause as `other`, counts whole and ≥ 0, the first sample kept,
 * every sample redacted (no query string, credential or secret: core's `redactSample`) and trimmed.
 */
export function readCauses(raw: unknown, now: number): CronCauseTally[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tallies: CronCauseTally[] = [];
  for (const item of raw.slice(0, CAUSES_IN_MAX)) {
    if (typeof item !== 'object' || item === null) continue;
    const t = item as Record<string, unknown>;
    const cause = CRON_FAILURE_CAUSES.includes(t.cause as never)
      ? (t.cause as CronFailureCause)
      : 'other';
    const count =
      typeof t.count === 'number' && Number.isFinite(t.count) && t.count > 0
        ? Math.floor(t.count)
        : 0;
    const key = typeof t.sampleKey === 'string' && t.sampleKey.length > 0 ? t.sampleKey : null;
    const text = typeof t.sampleText === 'string' && t.sampleText.length > 0 ? t.sampleText : cause;
    tallies.push({
      cause,
      count,
      ...(key !== null ? { sampleKey: trimText(redactSample(key), CAUSE_KEY_MAX) } : {}),
      sampleText: trimText(redactSample(text), CRON_CAUSE_SAMPLE_MAX),
      sampleAt: typeof t.sampleAt === 'number' && Number.isFinite(t.sampleAt) ? t.sampleAt : now,
    });
  }
  const folded = mergeCauseTallies(undefined, tallies);
  return folded.length > 0 ? folded : undefined;
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
  const job = entry.name;
  const hb = await heartbeatOf(ctx, job);
  if (sparseSkips(entry, hb, tick)) return 'skipped';
  const out = outcomesOf(tick);
  const ms = Math.max(0, Math.round(tick.finishedAt - tick.startedAt));
  const r = tick.report;

  let runId: Id<'cronRuns'> | undefined;
  // A chained job's head (D349): its tick is merged into the run it opened, never a second row.
  const chained = r?.runId !== undefined ? await chainRunOf(ctx, job, r.runId) : null;
  if (r?.runId !== undefined && chained === null) {
    console.warn(`cron "${job}": the report's run ${r.runId} is not an open run of this job`);
  }
  if (chained !== null) {
    runId = chained._id;
    await mergeHead(ctx, chained, tick, out.run);
  } else if (out.run !== null) {
    const causes = readCauses(r?.causes, tick.finishedAt);
    runId = await ctx.db.insert('cronRuns', {
      job,
      startedAt: tick.startedAt,
      finishedAt: tick.finishedAt,
      outcome: out.run,
      trigger: tick.trigger,
      ...(tick.byUserId !== undefined ? { byUserId: tick.byUserId } : {}),
      ...(r?.season !== undefined ? { season: r.season } : {}),
      ...(r?.detail !== undefined ? { detail: r.detail } : {}),
      ...(tick.error !== undefined ? { error: tick.error } : {}),
      ...(r?.counts !== undefined ? { counts: r.counts } : {}),
      ...(causes !== undefined ? { causes } : {}),
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
  const bucketStart = cronTickBucketStart(tick.startedAt, bucketMs);
  const packed = packTick(Math.floor((tick.startedAt - bucketStart) / 1000), out.code);
  const row = await ctx.db
    .query('cronTicks')
    .withIndex('by_job_bucket', (q) => q.eq('job', job).eq('bucketStart', bucketStart))
    .first();
  if (row === null) {
    await ctx.db.insert('cronTicks', {
      job,
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
  // An older tick recorded after a newer one (a manual run beside the cron's, finishing later, or
  // a kill found late) never moves the last good or last failed tick back, as `lastTickAt` doesn't.
  const newest = (at: number | undefined) => at === undefined || tick.startedAt >= at;
  const fields = {
    lastTickAt: Math.max(hb?.lastTickAt ?? 0, tick.startedAt),
    lastOutcome: out.heartbeat,
    lastMs: ms,
    ...(failed
      ? newest(hb?.lastFailedAt)
        ? {
            lastFailedAt: tick.startedAt,
            lastError: tick.error ?? r?.detail ?? (tick.killed ? 'killed' : out.heartbeat),
          }
        : {}
      : newest(hb?.lastOkAt)
        ? { lastOkAt: tick.startedAt }
        : {}),
    ...(runId !== undefined ? { lastRunId: runId } : {}),
  };
  if (hb === null) await ctx.db.insert('cronHeartbeats', { job, ...fields });
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
    console.error(
      `${line}: ${tick.error ?? tick.report?.detail ?? (tick.killed ? 'never finished' : out.heartbeat)}`,
    );
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

/**
 * A mutation job's report: as {@link readReport}, less `runId` — a chain is an action's (its batches
 * fetch), and the merge's reads and line deletes are outside the reserve a nested job leaves.
 */
function mutationReport(result: unknown, now: number): CronReport | null {
  const report = readReport(result, now);
  if (report?.runId !== undefined) delete report.runId;
  return report;
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
      report: error === undefined ? mutationReport(result, finishedAt) : null,
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
  runId: v.optional(v.string()),
  causes: v.optional(v.array(cronCauseTally)),
});

/**
 * Whether a `runningSince` stamp `begin` finds belongs to a tick that died (Ma27 (b), B01-8b-2):
 *
 * - **a cron tick finding a cron stamp: at any age** — Convex never starts a cron while its last run
 *   is still executing, so a cron stamp the next cron tick finds is a run that never finished;
 * - otherwise (a manual press, which can overlap a live cron run; or a manual stamp, or one stamped
 *   before the trigger was kept): **the age rule**, past core's `CRON_KILLED_AFTER_MS` (the measured
 *   action limit and a minute).
 */
export function stampKilled(
  stamp: { since: number; trigger: Trigger | undefined },
  tick: { startedAt: number; trigger: Trigger },
): boolean {
  if (tick.trigger === 'cron' && stamp.trigger === 'cron') return true;
  return tick.startedAt - stamp.since > CRON_KILLED_AFTER_MS;
}

/**
 * An announcing action's start: stamps `runningSince` with this tick's start (so it is never older
 * than the heartbeat's last tick), with the trigger and presser that started it
 * (`runningTrigger`, `runningByUserId`). A stamp already there that {@link stampKilled} calls dead is
 * a tick that never finished: recorded `killed` first, **with the trigger and presser it really had**
 * (Ma30; `cron` and no presser for a stamp from before they were kept), its end the action limit or
 * this tick's start, whichever is sooner. A live one is overwritten: a run still inside the limit (a
 * manual run beside the cron's) finishes and records as usual (its `finish` leaves the newer stamp
 * alone), and one killed young by a deploy goes unrecorded as killed until the next cron tick — never
 * a false kill.
 */
export const begin = internalMutation({
  args: {
    job: v.string(),
    startedAt: v.number(),
    /** This tick's trigger: `cron` when absent (a caller from before Ma27 (b)). */
    trigger: v.optional(literals(CRON_TRIGGERS)),
    byUserId: v.optional(v.id('profiles')),
  },
  returns: v.null(),
  handler: async (ctx, { job, startedAt, trigger = 'cron', byUserId }) => {
    const entry = requireCronJob(job, 'action');
    const hb = await heartbeatOf(ctx, job);
    const since = hb?.runningSince;
    if (
      since !== undefined &&
      stampKilled({ since, trigger: hb?.runningTrigger }, { startedAt, trigger })
    ) {
      // A chained head that died (D349): the run it opened (with its own start) takes the kill,
      // so the death is one row, never a second `killed` row beside the chain's.
      const opened = await chainRunStartedAt(ctx, job, since);
      const tick: Tick = {
        startedAt: since,
        finishedAt: Math.max(since, Math.min(since + CONVEX_ACTION_LIMIT_MS, startedAt)),
        trigger: hb?.runningTrigger ?? 'cron',
        ...(hb?.runningByUserId !== undefined ? { byUserId: hb.runningByUserId } : {}),
        killed: true,
        report: opened === null ? null : { worked: true, runId: opened._id },
      };
      await recorder.recordTick(ctx, entry, tick);
      logTick(entry, tick, 'recorded');
    }
    const stamp = {
      runningSince: startedAt,
      runningTrigger: trigger,
      runningByUserId: byUserId,
    };
    const now = await heartbeatOf(ctx, job);
    if (now === null) {
      await ctx.db.insert('cronHeartbeats', {
        job,
        runningSince: startedAt,
        runningTrigger: trigger,
        ...(byUserId !== undefined ? { runningByUserId: byUserId } : {}),
      });
    } else await ctx.db.patch(now._id, stamp);
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
      await ctx.db.patch(hb._id, {
        runningSince: undefined,
        runningTrigger: undefined,
        runningByUserId: undefined,
      });
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
        await ctx.runMutation(internal.cronRuns.begin, {
          job: entry.name,
          startedAt,
          trigger: args.trigger ?? 'cron',
          ...(args.byUserId !== undefined ? { byUserId: args.byUserId } : {}),
        });
      } catch (err) {
        console.error(
          `cron "${entry.name}": begin failed, running the job anyway: ${errorText(err)}`,
        );
      }
    }
    let result: unknown = null;
    let thrown: { error: unknown } | null = null;
    try {
      // The third argument is the tick (D349): a chained job opens its run with it.
      result = await entry.handler(
        ctx,
        entry.args as never,
        tickContextOf(entry.name, startedAt, args.trigger ?? 'cron', args.byUserId),
      );
    } catch (error) {
      thrown = { error };
    }
    const finishedAt = Date.now();
    // A thrown error may carry its run's report (core's `withCronReport`): its detail is kept.
    const report = readReport(thrown === null ? result : thrown.error, finishedAt);
    const sendFinish = () =>
      ctx.runMutation(internal.cronRuns.finish, {
        job: entry.name,
        trigger: args.trigger ?? 'cron',
        ...(args.byUserId !== undefined ? { byUserId: args.byUserId } : {}),
        startedAt,
        finishedAt,
        ...(thrown !== null ? { error: errorText(thrown.error) } : {}),
        report,
      });
    try {
      // A chained head's finish closes its branch on a row its batches are stepping on: a lost write
      // conflict there would leave the run open until the next run calls it killed, so it is sent
      // again (it never committed). Every other job's finish is sent once, as before.
      await (report?.runId !== undefined ? retryOnWriteConflict(sendFinish) : sendFinish());
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

// ─── A run that continues past its tick (D349, B01-8c) ──────────────────────────────────────────
//
// **The model.** A chained job opens its run before its first batch (`openRun`: `open: 1`, the head's
// own branch). Every branch is opened by whoever starts it and closed by itself:
//
// - the head, before it runs a batch inline or schedules one, opens a branch for it
//   (`chainStep({ runId, opened: 1 })`, no batch counted);
// - a batch, when it ends, sends its tallies with `closed: 1` and `opened: n` for the n
//   continuations it is about to schedule (then schedules them);
// - the head's own branch closes when its tick is recorded: the dispatcher merges the head's report
//   (which names the run: `cronReport.runId`) into the run with `closed: 1`. A head with no tick (a
//   chain another job scheduled) closes it itself: `chainStep({ runId, closed: 1, head: true })`.
//
// The run closes when `open` reaches 0, so it can't close while any branch is still running, in any
// order the steps arrive. `steps` counts the batches (steps that closed a branch, the head's close
// excepted).
//
// **What happens when something fails** (each order has its test in `crons.test.ts`):
//
// - *`openRun` throws*: the job runs unrecorded as a chain (`lib/chainRun.openChainRun` answers no
//   run, every later step is skipped); its head's tick is recorded as before the chain (a run row of
//   its own, the first batch's counts if the head reports them).
// - *A `chainStep` throws* (mid-chain): the batch's work is kept and it still schedules its next
//   (`lib/chainRun.chainStepSafely` catches and logs); the run misses that step's tallies. A
//   continuing batch's step opens one branch as it closes its own, so losing it leaves `open` right
//   (proven: 79 of 80 steps recorded, the run closed `ok`). A lost last step leaves `open` one too
//   many: the run reads quiet, then stopped, and the next `openRun` closes it `killed`. A lost pure
//   open (the head's, before a batch) leaves it one too few: the run closes early, `ok`, its last
//   steps logged as stragglers.
// - *The closing step never arrives* (a batch killed by the action limit, a deploy, a throw before its
//   step): `open` stays above 0 and `progressAt` ages — `running` for 15 minutes, then `quiet` (*No
//   word since …*), then `stopped` past the action limit and a minute (core's `chainLiveness`); the
//   next `openRun` of the job closes it `killed` (*No word after step N*), its end its last word.
// - *Two branches close at once*: each step reads the run and patches it in one transaction; Convex
//   serializes the two (a write conflict retries the later one against the first's write), so `open`
//   reaches 0 exactly once and the run closes once.
// - *A step retried after a write conflict*: a mutation's retry re-runs the whole transaction against
//   fresh reads, and only one attempt commits, so a step is counted once. Branches stepping on the one
//   row at once can lose a conflict on all of Convex's own retries (measured on a local backend with
//   instant batches: 6 of 320 steps over 8 branches); that error means the step didn't commit, so
//   `chainStepSafely` sends it again (`retryOnWriteConflict`, four attempts in all), and so does the
//   dispatcher for a chained head's `finish` — whose lost close would otherwise leave the run open
//   until the next run called it killed. No other error is ever resent (it may have committed).
// - *A straggler* (a step on a run already closed: a batch outliving its run's kill, or one after an
//   early close): nothing changes, one log line.
// - *The head throws* with its run open: its error rides its report (`withCronReport`, `runId` kept),
//   the merge closes the head's branch with the error, and the run closes `failed` when its last
//   branch ends. *The head is killed*: the next tick's `begin` finds the run the dead tick opened (by
//   its start) and closes the head's branch with an error — or, if the whole chain has stopped, the
//   run `killed` — so the death is one row, never a second `killed` row beside the chain's.

/** The most branches one step may open or close: a fan-out is a few tiers, never more. */
export const CHAIN_BRANCHES_MAX = 64;

/** What one step brings to its run (the arguments of `chainStep`, and the head's merge). */
interface ChainStepInput {
  opened?: number;
  closed?: number;
  counts?: Record<string, number>;
  causes?: CronCauseTally[];
  lines?: CronReportLine[];
  error?: string;
  /** The head's report outcome: `capped` or `refused` is kept as the run's; `failed` is an error. */
  outcome?: CronReport['outcome'];
  detail?: string;
  season?: string;
}

const branchCount = (n: number | undefined): number =>
  typeof n === 'number' && Number.isFinite(n)
    ? Math.min(CHAIN_BRANCHES_MAX, Math.max(0, Math.floor(n)))
    : 0;

/** The run `runId` names, if it is a chained run of `job`; else `null`. */
async function chainRunOf(
  ctx: MutationCtx,
  job: string,
  runId: string,
): Promise<Doc<'cronRuns'> | null> {
  const id = ctx.db.normalizeId('cronRuns', runId);
  if (id === null) return null;
  const run = await ctx.db.get(id);
  return run !== null && run.job === job && run.chain !== undefined ? run : null;
}

/**
 * Write a step's lines under the run's cap (core's `planChainLines`: the first 200 and the newest
 * 100 kept, the middle dropped and counted): at most 300 inserts and 100 deletes, one range read.
 */
async function writeChainLines(
  ctx: MutationCtx,
  run: Doc<'cronRuns'>,
  chain: NonNullable<Doc<'cronRuns'>['chain']>,
  lines: CronReportLine[],
  now: number,
): Promise<{ lines: number; linesDropped: number }> {
  const plan = planChainLines(chain, lines.length);
  if (plan.drop !== null) {
    const { from, to } = plan.drop;
    const doomed = await ctx.db
      .query('runEvents')
      .withIndex('by_cron_run_seq', (q) =>
        q.eq('cronRunId', run._id).gte('seq', from).lt('seq', to),
      )
      .take(CHAIN_LINES_TAIL);
    for (const row of doomed) await ctx.db.delete(row._id);
  }
  const lineDays = (cronJob(run.job)?.retention ?? CRON_RETENTION).lineDays;
  const keepUntil = run.startedAt + lineDays * DAY_MS;
  for (const { index, seq } of plan.insert) {
    const line = lines[index] as CronReportLine;
    await ctx.db.insert('runEvents', {
      cronRunId: run._id,
      seq,
      at: now,
      loggedAt: line.loggedAt,
      kind: line.kind,
      text: line.text,
      keepUntil,
    });
  }
  return { lines: plan.lines, linesDropped: plan.linesDropped };
}

/**
 * **Apply one step to its run** — the one writer of a chained run after `openRun`: one patch of the
 * run, plus its lines. `mode: 'head'` is the head's own branch closing (not a batch, so `steps`
 * doesn't move). A step on a run already closed changes nothing.
 */
async function applyChainStep(
  ctx: MutationCtx,
  run: Doc<'cronRuns'>,
  step: ChainStepInput,
  mode: 'batch' | 'head',
): Promise<void> {
  const chain = run.chain;
  if (chain === undefined || !(chain.open > 0)) {
    console.warn(
      `cron "${run.job}": a step on run ${run._id}, already closed (${run.outcome}); nothing changed`,
    );
    return;
  }
  const now = Date.now();
  const kept = await writeChainLines(
    ctx,
    run,
    chain,
    readLines(step.lines, now, CRON_REPORT_MAX_LINES) ?? [],
    now,
  );
  const closed = branchCount(step.closed);
  const open = Math.max(0, chain.open + branchCount(step.opened) - closed);
  const counts = mergeChainCounts(run.counts, readCounts(step.counts), RUN_COUNTS_MAX);
  const causes = mergeCauseTallies(run.causes, readCauses(step.causes, now));
  const error =
    run.error ??
    (step.error !== undefined && step.error.length > 0
      ? trimText(step.error, RUN_ERROR_MAX)
      : undefined);
  const held =
    run.outcome === 'ok' && (step.outcome === 'capped' || step.outcome === 'refused')
      ? step.outcome
      : run.outcome;
  await ctx.db.patch(run._id, {
    chain: {
      open,
      steps: chain.steps + (mode === 'batch' && closed > 0 ? 1 : 0),
      progressAt: Math.max(chain.progressAt, now),
      lines: kept.lines,
      ...(kept.linesDropped > 0 ? { linesDropped: kept.linesDropped } : {}),
    },
    ...(Object.keys(counts).length > 0 ? { counts } : {}),
    ...(causes.length > 0 ? { causes } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(step.detail !== undefined && step.detail.length > 0
      ? { detail: trimText(step.detail, RUN_DETAIL_MAX) }
      : {}),
    ...(run.season === undefined && step.season !== undefined && step.season.length > 0
      ? { season: trimText(step.season, SEASON_MAX) }
      : {}),
    outcome: open === 0 && error !== undefined ? 'failed' : held,
    ...(open === 0 ? { finishedAt: Math.max(run.startedAt, now) } : {}),
  });
}

/**
 * Close a stopped chain's run `killed` (no batch of it can still be alive: core's `chainLiveness`),
 * its end its last word, with one line saying so.
 */
async function killChain(ctx: MutationCtx, run: Doc<'cronRuns'>, now: number): Promise<void> {
  const chain = run.chain;
  if (chain === undefined || !(chain.open > 0)) return;
  const said = `No word after step ${chain.steps}; closed when the next run began`;
  const kept = await writeChainLines(
    ctx,
    run,
    chain,
    [{ kind: 'fail', text: said, loggedAt: now }],
    now,
  );
  await ctx.db.patch(run._id, {
    outcome: 'killed',
    finishedAt: Math.max(run.startedAt, chain.progressAt),
    error: run.error ?? `No word after step ${chain.steps}`,
    chain: {
      ...chain,
      open: 0,
      lines: kept.lines,
      ...(kept.linesDropped > 0 ? { linesDropped: kept.linesDropped } : {}),
    },
  });
}

/**
 * The head's tick merged into its run (the recorder's half of D349): its counts, causes and lines as
 * a step that closes the head's branch, its error (a throw, or a report of failure) the run's. A
 * killed head (recorded by the next `begin`): its branch closed with an error, or the whole run
 * `killed` if the chain has stopped.
 */
async function mergeHead(
  ctx: MutationCtx,
  run: Doc<'cronRuns'>,
  tick: Tick,
  runOutcome: CronRunOutcome | null,
): Promise<void> {
  const now = Date.now();
  if (tick.killed) {
    if (run.chain !== undefined && chainLiveness(run.chain, now) === 'stopped') {
      await killChain(ctx, run, now);
    } else {
      await applyChainStep(ctx, run, { closed: 1, error: 'its first step never finished' }, 'head');
    }
    return;
  }
  const r = tick.report;
  await applyChainStep(
    ctx,
    run,
    {
      closed: 1,
      ...(r?.counts !== undefined ? { counts: r.counts } : {}),
      ...(r?.causes !== undefined ? { causes: r.causes } : {}),
      ...(r?.lines !== undefined ? { lines: r.lines } : {}),
      ...(tick.error !== undefined
        ? { error: tick.error }
        : runOutcome === 'failed'
          ? { error: r?.detail ?? 'failed' }
          : {}),
      ...(r?.outcome !== undefined ? { outcome: r.outcome } : {}),
      ...(r?.detail !== undefined ? { detail: r.detail } : {}),
      ...(r?.season !== undefined ? { season: r.season } : {}),
    },
    'head',
  );
}

/** The chained run a tick that started at `startedAt` opened (its head opens with its own start). */
async function chainRunStartedAt(
  ctx: MutationCtx,
  job: string,
  startedAt: number,
): Promise<Doc<'cronRuns'> | null> {
  const runs = await ctx.db
    .query('cronRuns')
    .withIndex('by_job_started', (q) => q.eq('job', job).eq('startedAt', startedAt))
    .take(3);
  return runs.find((run) => run.chain !== undefined) ?? null;
}

/** How many of a job's newest runs `openRun` reads for an open chain. */
export const OPEN_RUN_LOOKBACK = 3;

/**
 * **Open a chained job's run** before its first batch: the run row exists before any batch is
 * scheduled, so every batch (and the head tick's `finish`) has a row to add to. Reads the job's
 * newest {@link OPEN_RUN_LOOKBACK} runs (`by_job_started`, desc): an open chain among them that
 * hasn't stopped (core's `chainLiveness`: a step inside the action limit and a minute) makes the
 * answer `{ busy }` (a second chain would ask Open-Meteo for the same cells twice) and opens
 * nothing; one that has stopped is closed `killed` first. Then inserts the run: `outcome: 'ok'`,
 * `finishedAt: startedAt`, `chain: { open: 1 }` (the head's own branch), `keepUntil` from the
 * entry, and any `counts` known at the start (the registry's size, the days asked for).
 */
export const openRun = internalMutation({
  args: {
    job: v.string(),
    startedAt: v.number(),
    trigger: literals(CRON_TRIGGERS),
    byUserId: v.optional(v.id('profiles')),
    detail: v.optional(v.string()),
    season: v.optional(v.string()),
    /** Counts known before the first batch, folded with the steps' (core's `mergeChainCounts`). */
    counts: v.optional(v.record(v.string(), v.number())),
  },
  returns: v.union(v.object({ runId: v.id('cronRuns') }), v.object({ busy: v.id('cronRuns') })),
  handler: async (ctx, args) => {
    const entry = requireCronJob(args.job, 'action');
    const job = entry.name;
    const now = Date.now();
    const recent = await ctx.db
      .query('cronRuns')
      .withIndex('by_job_started', (q) => q.eq('job', job))
      .order('desc')
      .take(OPEN_RUN_LOOKBACK);
    let busy: Id<'cronRuns'> | null = null;
    for (const run of recent) {
      if (run.chain === undefined || !(run.chain.open > 0)) continue;
      if (chainLiveness(run.chain, now) === 'stopped') await killChain(ctx, run, now);
      else busy ??= run._id;
    }
    if (busy !== null) return { busy };
    const counts = readCounts(args.counts);
    const runId = await ctx.db.insert('cronRuns', {
      job,
      startedAt: args.startedAt,
      finishedAt: args.startedAt,
      outcome: 'ok',
      trigger: args.trigger,
      ...(args.byUserId !== undefined ? { byUserId: args.byUserId } : {}),
      ...(args.season !== undefined && args.season.length > 0
        ? { season: trimText(args.season, SEASON_MAX) }
        : {}),
      ...(args.detail !== undefined && args.detail.length > 0
        ? { detail: trimText(args.detail, RUN_DETAIL_MAX) }
        : {}),
      ...(counts !== undefined ? { counts } : {}),
      chain: { open: 1, steps: 0, progressAt: args.startedAt, lines: 0 },
      keepUntil: args.startedAt + entry.retention.runDays * DAY_MS,
    });
    return { runId };
  },
});

/**
 * **One step of a chained run**: its counts folded key by key (core's `mergeChainCounts`: a tally
 * adds, a `…Max` key keeps the larger, a `…Min` or `oldest…` key the smaller), its causes merged
 * (core's `mergeCauseTallies`: counts summed, the first sample kept, one entry per cause), its lines
 * appended under the cap (core's `planChainLines`), `open + opened − closed`, `progressAt` stamped,
 * and `steps + 1` when it closes a branch (not for `head`). At `open === 0` the run closes:
 * `finishedAt` now, `failed` if any step sent an `error`, else its outcome (`ok`). A step on a run
 * already closed changes nothing and logs one line. Reads one document (the run) and patches it, plus
 * its lines.
 */
export const chainStep = internalMutation({
  args: {
    runId: v.id('cronRuns'),
    /** Branches this step starts: 1 for each continuation it is about to schedule. */
    opened: v.optional(v.number()),
    /** Branches this step ends: 1 for a batch's own (it is the batch that ran). */
    closed: v.optional(v.number()),
    /**
     * This step closes the head's own branch (a run opened by a handler with no tick, which the
     * dispatcher never merges): not a batch, so `steps` doesn't move.
     */
    head: v.optional(v.boolean()),
    counts: v.optional(v.record(v.string(), v.number())),
    causes: v.optional(v.array(cronCauseTally)),
    lines: v.optional(v.array(cronReportLine)),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { runId, head, ...step }) => {
    const run = await ctx.db.get(runId);
    if (run === null) {
      console.warn(`cronRuns.chainStep: no run ${runId}; nothing changed`);
      return null;
    }
    await applyChainStep(ctx, run, step, head === true ? 'head' : 'batch');
    return null;
  },
});

/** A tick's context for its handler (core's `CronTickContext`), from the dispatcher's arguments. */
export function tickContextOf(
  job: string,
  startedAt: number,
  trigger: Trigger,
  byUserId: Id<'profiles'> | undefined,
): CronTickContext {
  return { job, startedAt, trigger, ...(byUserId !== undefined ? { byUserId } : {}) };
}
