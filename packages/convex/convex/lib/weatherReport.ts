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
  mergeCauseTallies,
  redactSample,
  withCronReport,
} from '@skating/core';
import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import type { ActionCtx } from '../_generated/server';
import { chainStepSafely, closeChainHead, type OpenedChain } from './chainRun';

/** A failure as a job keeps it: its cause (core's one rule) and a sample's text. */
export interface CausedFailure {
  cause: CronFailureCause;
  text: string;
}

/**
 * A sample's text, safe to keep on a run row: core's `redactSample` (a URL loses its credentials,
 * query string and fragment; a secret-named `key=value` pair its value — the recorder's own rule, so
 * the two can't disagree), then trimmed to core's `CRON_CAUSE_SAMPLE_MAX`, never through a surrogate
 * pair.
 */
export function sampleTextOf(raw: string): string {
  const scrubbed = redactSample(raw).trim();
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
 * One step's tallies: counts added key by key, failures grouped by cause (core's
 * `mergeCauseTallies`, the rule the run row folds by: the count, the first sample, one entry per
 * cause in the vocabulary's order), lines in order. Built per batch and handed to its run whole.
 */
export class StepTally {
  readonly counts: Record<string, number> = {};
  private byCause: CronCauseTally[] = [];
  readonly lines: CronReportLine[] = [];

  /** Add `n` (an integer) to `key`; a zero still names the key, so a report says *0 failed*. */
  add(key: string, n = 1): void {
    this.counts[key] = (this.counts[key] ?? 0) + Math.round(n);
  }

  /**
   * Keep the largest `n` under `key` — a key ending in `Max`, which the run folds by largest. Set
   * only when there is a value, so an empty step never reads as 0.
   */
  max(key: `${string}Max`, n: number): void {
    const had = this.counts[key];
    this.counts[key] = had === undefined ? Math.round(n) : Math.max(had, Math.round(n));
  }

  /** Keep the smallest `n` under `key` — a key starting `oldest`, which the run folds by smallest. */
  min(key: `oldest${string}`, n: number): void {
    const had = this.counts[key];
    this.counts[key] = had === undefined ? Math.round(n) : Math.min(had, Math.round(n));
  }

  /** One failed item: `key` names it (a cell key, a state code, a hazard id — never content). */
  fail(failure: CausedFailure, key: string, at: number = Date.now()): void {
    this.byCause = mergeCauseTallies(this.byCause, [
      {
        cause: failure.cause,
        count: 1,
        sampleKey: key,
        sampleText: sampleTextOf(failure.text),
        sampleAt: at,
      },
    ]);
  }

  line(kind: CronReportLine['kind'], text: string, at: number = Date.now()): void {
    this.lines.push({ kind, text, loggedAt: at });
  }

  /** The failures by cause, one entry per cause, in the vocabulary's order. */
  causes(): CronCauseTally[] {
    return this.byCause.map((c) => ({ ...c }));
  }

  /** How many items failed, over every cause. */
  failures(): number {
    let n = 0;
    for (const c of this.byCause) n += c.count;
    return n;
  }

  /** One `warn` line per cause, with its count and its sample — the log's word for this step. */
  causeLines(noun: string, at: number = Date.now()): void {
    for (const c of this.byCause) {
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
 * **A chained run, as each batch carries it** (D349): the run's id, the batch's place in its branch,
 * and the branch's totals so far — what the progress and end lines read, carried because no batch
 * can read the run row. The head opens a branch for every batch it runs inline
 * (`openChainBranch`); every batch closes its own and opens one for each batch it schedules.
 */
export const cronRunArg = v.object({
  runId: v.id('cronRuns'),
  /** This batch's number in its branch, from 1. */
  step: v.number(),
  /** The branch's running totals before this batch (`cells`, `stored`, `failed`, …). */
  so: v.optional(v.record(v.string(), v.number())),
});

export interface CronRunArg {
  runId: Id<'cronRuns'>;
  step: number;
  so?: Record<string, number>;
}

/** The next batch's `cronRun`: one step on, the totals so far. */
export function nextCronRun(run: CronRunArg, so: Record<string, number>): CronRunArg {
  return { runId: run.runId, step: run.step + 1, so };
}

/**
 * A start line, as the head sends it on the branch it opens for a tier's first batch
 * (`openChainBranch`): ahead of every batch's lines. The counts known at the start (the registry's
 * size, the days asked for) ride `openChainRun` itself, once.
 */
export function stageLine(text: string, at: number = Date.now()): CronReportLine {
  return { kind: 'stage', text, loggedAt: at };
}

/** `a` and `b` added key by key (the branch's own running totals; never `Max`/`Min`/`oldest` keys). */
export function addCounts(
  a: Record<string, number> | undefined,
  b: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...(a ?? {}) };
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n;
  return out;
}

/** A batch's end, for its run: its branch closed, `next` branches opened, its tallies. */
export async function endBatch(
  ctx: Pick<ActionCtx, 'runMutation'>,
  run: CronRunArg,
  tally: StepTally,
  next: number,
): Promise<void> {
  const causes = tally.causes();
  await chainStepSafely(ctx, run.runId, {
    closed: 1,
    ...(next > 0 ? { opened: next } : {}),
    ...(Object.keys(tally.counts).length > 0 ? { counts: tally.counts } : {}),
    ...(causes.length > 0 ? { causes } : {}),
    ...(tally.lines.length > 0 ? { lines: tally.lines } : {}),
  });
}

/**
 * **A chained head's end.** Under the dispatcher (a tick) the head's own branch is closed by the
 * recorder merging this report into the run (`runId`), so the head returns it and writes nothing;
 * with no tick nothing would merge it, so the head closes its own branch (`closeChainHead`).
 */
export async function closeHead(
  ctx: Pick<ActionCtx, 'runMutation'>,
  tick: CronTickContext | undefined,
  runId: Id<'cronRuns'>,
  extra: { season?: string; detail?: string } = {},
): Promise<CronReport> {
  const report: CronReport = {
    worked: true,
    ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
    ...(extra.season !== undefined ? { season: extra.season } : {}),
  };
  if (tick !== undefined) return { ...report, runId };
  await closeChainHead(ctx, runId);
  return report;
}

/**
 * A chained head whose inline batch threw (the one call in a head's `try` that can: the
 * `ctx.runAction` of a tier's first batch, after the head opened that batch's branch).
 *
 * That batch's branch is closed here first, with the error: it can never close itself — it threw
 * before its step, or after a step that opened a continuation it never scheduled (its scheduler call
 * is the only thing after its step), so either way exactly one branch is left that no batch will end.
 * Without this the run read *running*, then *No word since …*, for the 31 minutes until a press could
 * open another, and stayed open until the next day's run closed it `killed` — when its outcome,
 * `failed`, was known at once. Sent as a `head` step (no batch reported, so `steps` doesn't move).
 *
 * Then under the dispatcher the error carries the run's id (core's `withCronReport`), so the
 * recorder's merge closes the head's own branch and the run `failed`; with no tick the head closes its
 * own branch with the error. Returns the error to rethrow.
 */
export async function failHead(
  ctx: Pick<ActionCtx, 'runMutation'>,
  tick: CronTickContext | undefined,
  runId: Id<'cronRuns'>,
  err: unknown,
  extra: { season?: string } = {},
): Promise<Error> {
  await chainStepSafely(ctx, runId, {
    closed: 1,
    head: true,
    error: sampleTextOf(thrownText(err)),
  });
  if (tick !== undefined) {
    return withCronReport(err, {
      worked: true,
      runId,
      ...(extra.season !== undefined ? { season: extra.season } : {}),
    });
  }
  await closeChainHead(ctx, runId, { error: sampleTextOf(thrownText(err)) });
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * **What a recorder's `busy` means to a weather job** (the governor's ruling, 2026-11-28): a recorder
 * answer never stops a scheduled job from doing its work. A **manual** press while a run is going is
 * skipped (a quiet report saying so; 8c-2 turns it into a toast); a cron tick, or a head with no tick,
 * does its work exactly as before, unrecorded as a chain (`runId: null`). Returns the run to report
 * to, or `'skip'`.
 */
export function runOf(
  opened: OpenedChain,
  tick: CronTickContext | undefined,
): Id<'cronRuns'> | null | 'skip' {
  if ('busy' in opened) return tick?.trigger === 'manual' ? 'skip' : null;
  return opened.runId;
}

/** The quiet report a skipped manual press returns. */
export const BUSY_REPORT: CronReport = {
  worked: false,
  detail: 'A run of this job is already going',
};
