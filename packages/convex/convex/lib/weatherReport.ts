/**
 * **What a weather job says about its run** (B01-8c, D345, D349): the tallies a weather job keeps
 * while it works — its counts, its failures by cause with one sample each, its log lines — and the
 * one call that hands a chained batch's tallies to its run (`cronRuns.chainStep`).
 *
 * Reporting is an observation of the job, never part of it: a report that fails to land is logged
 * and the job goes on exactly as it would have without it (what it fetches, writes and schedules
 * never depends on a report). Every count is an integer; a weight is stored ×10.
 *
 * Every word here is a pipeline fact (*fetched*, *stored*, *failed*) — never a statement about the
 * weather or the ice (D3).
 */

import {
  CRON_CAUSE_SAMPLE_MAX,
  type CronCauseTally,
  type CronFailureCause,
  type CronReport,
  type CronReportLine,
  type CronTickContext,
  type FetchFailure,
  fetchFailureCause,
  withCronReport,
} from '@skating/core';
import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { ActionCtx } from '../_generated/server';

/** A failure as a job keeps it: its cause (core's one rule) and a sample's text. */
export interface CausedFailure {
  cause: CronFailureCause;
  text: string;
}

/**
 * A sample's text, safe to keep on a run row: a URL loses its query string and fragment (a request's
 * coordinates, or any key a provider might take there), a `key=…`/`token=…`/`secret=…` pair loses its
 * value, and the rest is trimmed to core's `CRON_CAUSE_SAMPLE_MAX`, never through a surrogate pair.
 */
export function sampleTextOf(raw: string): string {
  const scrubbed = raw
    .replace(/(https?:\/\/[^\s?#'"]*)[?#][^\s'"]*/gi, '$1')
    .replace(/\b((?:api[_-]?)?key|token|secret|password)=[^\s&,;'"]*/gi, '$1=…')
    .trim();
  const text = scrubbed.length > 0 ? scrubbed : 'no detail';
  if (text.length <= CRON_CAUSE_SAMPLE_MAX) return text;
  const cut = text.slice(0, CRON_CAUSE_SAMPLE_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** A thrown value's message (or its class when it has none), for a sample. */
export function thrownText(err: unknown): string {
  if (err instanceof Error) return err.message || err.constructor.name || 'Error';
  return String(err);
}

/** A fetch's failure, caused by core's rule (`fetchFailureCause`) with its sample's text. */
export function causedFetchFailure(failure: FetchFailure, text: string): CausedFailure {
  return { cause: fetchFailureCause(failure), text: sampleTextOf(text) };
}

/** How a fetch's non-2xx answer reads in a sample: its status only — never the body or the URL. */
export function statusText(provider: string, status: number): string {
  return `${provider} answered HTTP ${status}`;
}

/**
 * One step's tallies: counts added key by key, failures grouped by cause (the count, the first
 * sample), lines in order. Built per batch and handed to its run whole.
 */
export class StepTally {
  readonly counts: Record<string, number> = {};
  private readonly byCause = new Map<CronFailureCause, CronCauseTally>();
  readonly lines: CronReportLine[] = [];

  /** Add `n` (an integer) to `key`; a zero still names the key, so a report says *0 failed*. */
  add(key: string, n = 1): void {
    this.counts[key] = (this.counts[key] ?? 0) + Math.round(n);
  }

  /** One failed item: `key` names it (a cell key, a state code, a hazard id — never content). */
  fail(failure: CausedFailure, key: string, at: number = Date.now()): void {
    const had = this.byCause.get(failure.cause);
    if (had) {
      had.count += 1;
      return;
    }
    this.byCause.set(failure.cause, {
      cause: failure.cause,
      count: 1,
      sampleKey: key,
      sampleText: sampleTextOf(failure.text),
      sampleAt: at,
    });
  }

  line(kind: CronReportLine['kind'], text: string, at: number = Date.now()): void {
    this.lines.push({ kind, text, loggedAt: at });
  }

  /** The failures by cause, in the order each cause was first seen. */
  causes(): CronCauseTally[] {
    return [...this.byCause.values()];
  }

  /** How many items failed, over every cause. */
  failures(): number {
    let n = 0;
    for (const c of this.byCause.values()) n += c.count;
    return n;
  }

  /** One `warn` line per cause, with its count and its sample — the log's word for this step. */
  causeLines(noun: string, at: number = Date.now()): void {
    for (const c of this.byCause.values()) {
      const what = c.count === 1 ? noun : `${noun}s`;
      const sample = c.sampleKey === undefined ? c.sampleText : `${c.sampleKey}: ${c.sampleText}`;
      this.line('warn', `${c.count} ${what} failed (${CAUSE_WORDS[c.cause]}) · e.g. ${sample}`, at);
    }
  }
}

/** A cause in the log's words (the page has its own, `weatherWords.ts`). */
export const CAUSE_WORDS: Record<CronFailureCause, string> = {
  timeout: 'timed out',
  rateLimit: 'rate limited',
  serverError: 'server error',
  refused: 'refused',
  unreachable: 'unreachable',
  badAnswer: 'answer unreadable',
  emptyAnswer: 'no usable hours',
  writeFailed: 'write failed',
  other: 'other',
};

/** `1234` → `1,234`, the log's number. */
export function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * **A chained run, as each batch carries it** (D349): the run's id, the batch's place in the chain,
 * whether it is the head's own batch (the head closes its own branch: through the dispatcher's merge
 * of its report, or its own last step), and the run's totals so far — what the progress and end
 * lines read, carried because no batch can read the run row.
 */
export const cronRunArg = v.object({
  runId: v.id('cronRuns'),
  /** This batch's number in its branch, from 1. */
  step: v.number(),
  /** The head's own batch: it opens the next branch but never closes its own. */
  head: v.optional(v.boolean()),
  /** The branch's running totals before this batch (`cells`, `stored`, `failed`, …). */
  so: v.optional(v.record(v.string(), v.number())),
  /**
   * The head's own first line and counts, carried into its first batch so they reach the run with
   * that batch's step — ahead of every later line (the head's own report merges only at its end).
   */
  startLine: v.optional(v.string()),
  startCounts: v.optional(v.record(v.string(), v.number())),
});

export interface CronRunArg {
  runId: Id<'cronRuns'>;
  step: number;
  head?: boolean;
  so?: Record<string, number>;
  startLine?: string;
  startCounts?: Record<string, number>;
}

/** The next batch's `cronRun`: one step on, the totals so far, never the head. */
export function nextCronRun(run: CronRunArg, so: Record<string, number>): CronRunArg {
  return { runId: run.runId, step: run.step + 1, so };
}

/** A batch's tally, opened with the head's first line and counts when it carries them. */
export function stepTallyFor(run: CronRunArg | undefined): StepTally {
  const tally = new StepTally();
  if (run?.startLine !== undefined) tally.line('stage', run.startLine);
  for (const [k, n] of Object.entries(run?.startCounts ?? {})) tally.add(k, n);
  return tally;
}

/** `a` and `b` added key by key. */
export function addCounts(
  a: Record<string, number> | undefined,
  b: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...(a ?? {}) };
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n;
  return out;
}

/** What a batch hands its run at its end (`cronRuns.chainStep`'s arguments, less the id). */
export interface StepReport {
  /** Branches this step starts: 1 when it schedules the next batch. */
  opened?: number;
  /** Branches this step ends: 1 for a batch that isn't the head's own. */
  closed?: number;
  tally?: StepTally;
  error?: string;
}

/**
 * Hand one batch's tallies to its run (`cronRuns.chainStep`) — **before** the batch schedules its
 * next, so the run counts the branch the next batch is. A failure here is logged and swallowed: a
 * report must never take the job down with it (the run then reads quiet, and the next run's
 * `openRun` closes it).
 */
export async function reportStep(
  ctx: ActionCtx,
  runId: Id<'cronRuns'>,
  step: StepReport,
): Promise<void> {
  const t = step.tally;
  const causes = t?.causes() ?? [];
  try {
    await ctx.runMutation(internal.cronRuns.chainStep, {
      runId,
      ...(step.opened ? { opened: step.opened } : {}),
      ...(step.closed ? { closed: step.closed } : {}),
      ...(t && Object.keys(t.counts).length > 0 ? { counts: t.counts } : {}),
      ...(causes.length > 0 ? { causes } : {}),
      ...(t && t.lines.length > 0 ? { lines: t.lines } : {}),
      ...(step.error !== undefined ? { error: sampleTextOf(step.error) } : {}),
    });
  } catch (err) {
    console.warn(`weather report: a step of run ${runId} wasn't recorded`, err);
  }
}

/** What a chained head passes `cronRuns.openRun`, from its tick (or none: a run another job chained). */
export interface OpenRunArgs {
  job: string;
  startedAt: number;
  trigger: 'cron' | 'manual';
  byUserId?: Id<'profiles'>;
  detail?: string;
  season?: string;
}

/**
 * A chained head's `openRun` arguments from its tick. With no tick (a run another job chained — the
 * registry walk an import scheduled — or an operator's direct call) the run is `manual` with no
 * presser, 8b-2's convention for a run another job started, and moves no heartbeat.
 */
export function openArgsOf(
  job: string,
  tick: CronTickContext | undefined,
  extra: { detail?: string; season?: string } = {},
): OpenRunArgs {
  return {
    job: tick?.job ?? job,
    startedAt: tick?.startedAt ?? Date.now(),
    trigger: tick?.trigger ?? 'manual',
    ...(tick?.byUserId !== undefined ? { byUserId: tick.byUserId as Id<'profiles'> } : {}),
    ...extra,
  };
}

/**
 * **A chained head's end.** Under the dispatcher (a tick), the head's own branch is closed by the
 * recorder merging this report into the run (`runId`), so the head returns it and writes nothing;
 * with no tick nothing would merge it, so the head closes its own branch with one last step.
 */
export async function closeHead(
  ctx: ActionCtx,
  tick: CronTickContext | undefined,
  runId: Id<'cronRuns'>,
  tally: StepTally,
  extra: { season?: string; detail?: string } = {},
): Promise<CronReport> {
  const causes = tally.causes();
  const report: CronReport = {
    worked: true,
    ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
    ...(extra.season !== undefined ? { season: extra.season } : {}),
    ...(Object.keys(tally.counts).length > 0 ? { counts: tally.counts } : {}),
    ...(causes.length > 0 ? { causes } : {}),
    ...(tally.lines.length > 0 ? { lines: tally.lines } : {}),
  };
  if (tick !== undefined) return { ...report, runId };
  await reportStep(ctx, runId, { closed: 1, tally });
  return report;
}

/**
 * A chained head that threw after its run opened: under the dispatcher the error carries the run's
 * id (core's `withCronReport`), so the recorder closes the run `failed`; with no tick the head closes
 * its own branch with the error. Returns the error to rethrow.
 */
export async function failHead(
  ctx: ActionCtx,
  tick: CronTickContext | undefined,
  runId: Id<'cronRuns'>,
  err: unknown,
  extra: { season?: string } = {},
): Promise<Error> {
  if (tick !== undefined) {
    return withCronReport(err, {
      worked: true,
      runId,
      ...(extra.season !== undefined ? { season: extra.season } : {}),
    });
  }
  await reportStep(ctx, runId, { closed: 1, error: thrownText(err) });
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Open a chained job's run (`cronRuns.openRun`) — `{ runId }`, `{ busy }` while the job's last run is
 * still going, or `null` when the open itself failed (logged: the job then runs unreported, exactly
 * as it did before runs were recorded).
 */
export async function openChainRun(
  ctx: ActionCtx,
  args: OpenRunArgs,
): Promise<{ runId: Id<'cronRuns'> } | { busy: Id<'cronRuns'> } | null> {
  try {
    return await ctx.runMutation(internal.cronRuns.openRun, {
      job: args.job,
      startedAt: args.startedAt,
      trigger: args.trigger,
      ...(args.byUserId !== undefined ? { byUserId: args.byUserId } : {}),
      ...(args.detail !== undefined ? { detail: args.detail } : {}),
      ...(args.season !== undefined ? { season: args.season } : {}),
    });
  } catch (err) {
    console.warn(`weather report: the run of "${args.job}" couldn't be opened`, err);
    return null;
  }
}
