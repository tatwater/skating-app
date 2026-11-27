/**
 * **What a cron says about its tick** (D343, D347, B01-8b): the report convention and the packing of
 * a tick into one number.
 *
 * A job reports through its return value, never through a handle: a function may return
 * `{ cronReport: CronReport }`. `worked: false` (or no report) is a quiet tick — a tick, no run row;
 * `worked: true`, or any failure, makes a run row with the report's counts and detail, and its lines
 * as the run's log. The dispatchers (`convex/cronRuns.ts`) read it; core holds the shape so a job
 * and the recorder can't disagree on it.
 *
 * A tick row (`cronTicks.ticks`) stores each tick as one number: its seconds into the row's bucket
 * times eight, plus its outcome's code. A UTC day is 86,400 s, so the largest packed value is
 * 691,199 — an exact integer in any Convex number.
 *
 * PLACEHOLDER (B01-8b seams): the shape, the codes and the packing are the contract; the property
 * tests and any validation of the packing's domain are S2's.
 */

/** The most lines one report may carry; the recorder keeps the first ones past it. */
export const CRON_REPORT_MAX_LINES = 200;
/** A report line's length, trimmed by the recorder. */
export const CRON_REPORT_LINE_MAX = 500;

/** One line of a cron run's log, as its job reports it. */
export interface CronReportLine {
  kind: 'line' | 'warn' | 'fail' | 'stage';
  text: string;
  /** The job's clock when it wrote the line. */
  loggedAt: number;
}

/** What a job returns as `{ cronReport }`. */
export interface CronReport {
  /** Did this tick do work? `false` is a quiet tick: no run row. */
  worked: boolean;
  /** The run's outcome when it did work; `ok` if absent. A thrown job is `failed` whatever it says. */
  outcome?: 'ok' | 'capped' | 'refused' | 'failed';
  /** The run's headline. */
  detail?: string;
  counts?: Record<string, number>;
  season?: string;
  /** At most {@link CRON_REPORT_MAX_LINES}, each trimmed to {@link CRON_REPORT_LINE_MAX}. */
  lines?: CronReportLine[];
}

/**
 * A tick's outcome as a code, packed into the low three bits of a tick (`refused` is a run's, drawn
 * on the strip). Held in step with the Convex package's `CRON_OUTCOMES` by a guard.
 */
export const CRON_TICK_CODES = { ok: 0, worked: 1, failed: 2, killed: 3, refused: 4 } as const;
export type CronTickCode = (typeof CRON_TICK_CODES)[keyof typeof CRON_TICK_CODES];

/** A tick packed: `offsetSec × 8 + code`. */
export function packTick(offsetSec: number, code: number): number {
  return offsetSec * 8 + code;
}

/** A packed tick read back. */
export function unpackTick(value: number): { offsetSec: number; code: number } {
  return { offsetSec: Math.floor(value / 8), code: value % 8 };
}
