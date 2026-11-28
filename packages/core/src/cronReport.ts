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
 * A tick row's bucket is a UTC hour for a job that ticks more often than every 30 minutes, a UTC
 * day otherwise ({@link cronTickBucketMs}): at most 60 ticks a row for a job recorded every tick.
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

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The largest offset a tick can have: the last second of a UTC day, the largest bucket. */
export const CRON_TICK_MAX_OFFSET_SEC = DAY_MS / 1000 - 1;
/** How many codes fit under a tick's offset: the low three bits. */
const CODE_SPAN = 8;

/**
 * A tick packed: `offsetSec × 8 + code`. The offset is floored to a whole second and held inside a
 * day (`0 … CRON_TICK_MAX_OFFSET_SEC`), so a clock's fraction or a stamp a moment outside its bucket
 * never spills into the code's bits; a code outside `0 … 7`, or an offset that isn't a number, is a
 * wiring fault and throws.
 */
export function packTick(offsetSec: number, code: number): number {
  if (!Number.isInteger(code) || code < 0 || code >= CODE_SPAN) {
    throw new RangeError(`packTick: code ${code} is not 0–7`);
  }
  if (!Number.isFinite(offsetSec)) throw new RangeError('packTick: offset is not a number');
  const offset = Math.min(CRON_TICK_MAX_OFFSET_SEC, Math.max(0, Math.floor(offsetSec)));
  return offset * CODE_SPAN + code;
}

/** A packed tick read back: the inverse of {@link packTick} on its range. */
export function unpackTick(value: number): { offsetSec: number; code: number } {
  return { offsetSec: Math.floor(value / CODE_SPAN), code: value % CODE_SPAN };
}

/**
 * A job's tick-row bucket, from how often it ticks: a UTC hour when more often than every 30
 * minutes, a UTC day otherwise. A sub-minute job would overrun 60 ticks an hour; none is registered.
 */
export function cronTickBucketMs(periodMs: number): number {
  return periodMs < 30 * 60_000 ? HOUR_MS : DAY_MS;
}

/** The start of the bucket holding `at`, for a bucket of `bucketMs` (an hour or a day, UTC). */
export function cronTickBucketStart(at: number, bucketMs: number): number {
  return Math.floor(at / bucketMs) * bucketMs;
}
