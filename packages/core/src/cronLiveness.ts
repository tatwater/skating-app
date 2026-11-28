/**
 * **The cron liveness rule** (D343, D346, D347, B01-8b): whether a cron is on time, late, stalled,
 * failed, running or killed — one pure rule, read by the server (`machineryCrons.jobs`, the
 * Overview's card, later Health) and by the web's ticking clock, so the lane, the cards and the
 * Overview can't disagree, as `runLiveness` does for import runs.
 *
 * The rule (B01-8b's design, *The liveness rule*): *E* is the interval, or a day, or a week — never
 * less than the input's `quietFloorMs` (the longest quiet the recorder leaves on a healthy job,
 * below). With `runningSince` set: `running` until the action limit (30 minutes, as measured) and a
 * minute's slack, then `killed`. Else with no tick: `never`. Else, quiet *q* = now − lastTickAt (never negative):
 * `stalled` past `RUN_STALLED_FACTOR`·*E*, `late` past `RUN_LATE_FACTOR`·*E* (a fixed-time job:
 * past its next due time plus a twelfth of *E*, at most an hour), else `failed` if the last tick
 * failed or was killed, else `ok`. `nextAt` only for daily and weekly schedules (ruling 17: an
 * interval's phase is set at deploy and can't be read).
 *
 * **Sparse recording** (B01-8b's fork 1): a cron recorded `sparse` writes a quiet tick only when it
 * is its first in its UTC hour, so a healthy one-minute job's `lastTickAt` can be an hour (and one
 * tick) old. Its input carries `quietFloorMs` = {@link CRON_SPARSE_QUIET_FLOOR_MS}
 * ({@link cronQuietFloorMs}, the one helper every read uses), and the rule reads *E* as at least
 * that: late past two hours of silence, stalled past ten. Failures and work are recorded as they
 * happen, so `failed` is as prompt as under `every`.
 *
 * Decay here is *confidence in the machinery*, never a claim about the ice (D3).
 */

import { RUN_LATE_FACTOR, RUN_STALLED_FACTOR } from './runLiveness';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * The longest one action may run before Convex kills it, as measured (B01-8b-1's build: a local
 * backend killed a sleeping action at 1,800 s, not the 10 minutes Convex's docs give). The rule
 * takes the longer of the two so a live action can never read killed; the recorder's `begin`
 * imports it, so the two can't disagree.
 */
export const CONVEX_ACTION_LIMIT_MS = 30 * MINUTE;
/** A running tick reads killed past the action limit and a minute's slack. */
export const CRON_KILLED_AFTER_MS = CONVEX_ACTION_LIMIT_MS + MINUTE;
/** A fixed-time job's grace past its due time: a twelfth of its period, at most this. */
export const CRON_FIXED_GRACE_MAX_MS = HOUR;
/**
 * How early a fixed-time job's tick may be stamped and still count as that due time's run: a tick
 * stamped a moment before its minute (a clock's jitter) is that run, never the one before it.
 */
export const CRON_EARLY_TICK_SLACK_MS = MINUTE;
/**
 * The longest a `sparse` job's healthy heartbeat goes unwritten: its quiet ticks are recorded once
 * a UTC hour.
 */
export const CRON_SPARSE_QUIET_FLOOR_MS = HOUR;

/** How the recorder writes a cron's quiet ticks (the registry's `record`, `cronJobs.ts`). */
export type CronRecord = 'every' | 'sparse';

/** How a cron's last tick ended (`cronHeartbeats.lastOutcome`; the Convex package's `CRON_OUTCOMES`). */
export type CronOutcome = 'ok' | 'worked' | 'failed' | 'killed';

/** What started a cron run (the Convex package's `CRON_TRIGGERS`). */
export type CronTrigger = 'cron' | 'manual';

/** A cron's schedule as the rule reads it: an interval in ms, or a fixed UTC time. */
export type CronSchedule =
  | { every: number }
  | { daily: { hourUTC: number; minuteUTC: number } }
  /** `dayOfWeek`: 0 is Sunday, as `Date.getUTCDay`. */
  | { weekly: { dayOfWeek: number; hourUTC: number; minuteUTC: number } };

export type CronLiveness =
  /** No tick recorded since recording began. */
  | { state: 'never' }
  /** An announcing action, inside the action limit. */
  | { state: 'running'; since: number }
  /** Began, never finished, past the limit. */
  | { state: 'killed'; since: number }
  | {
      state: 'failed' | 'late' | 'stalled' | 'ok';
      lastTickAt: number;
      /** now − lastTickAt, never negative (a clock ahead of the server reads 0). */
      quietMs: number;
      /** *E*: the period, never under the input's quiet floor. */
      expectedMs: number;
      /** Fixed-time schedules only; an interval's is `null` and never drawn. */
      nextAt: number | null;
    };

/** What the rule reads of a heartbeat (`cronHeartbeats`), and of its registry entry. */
export interface CronLivenessInput {
  lastTickAt?: number;
  lastOutcome?: CronOutcome;
  runningSince?: number;
  /**
   * What started the run that stamped `runningSince` (`cronHeartbeats.runningTrigger`, B01-8b-2,
   * Ma27 (b)); absent on a stamp from before it. The rule's verdict doesn't read it: a heartbeat
   * alone can't tell a long cron run from a dead one before the next tick, so `running` and `killed`
   * keep the age rule for both; a cron's earlier kill reaches the verdict through the next tick's
   * `begin`, which records it (`lastOutcome: 'killed'`). Carried so the card can say who started
   * the run on screen.
   */
  runningTrigger?: CronTrigger;
  /**
   * The longest quiet the recorder leaves on a healthy job ({@link cronQuietFloorMs}): *E* is never
   * less. Absent (or 0) for a job recorded every tick.
   */
  quietFloorMs?: number;
}

/** An entry's quiet floor, from its recording mode: one helper, so every read agrees. */
export function cronQuietFloorMs(record: CronRecord): number {
  return record === 'sparse' ? CRON_SPARSE_QUIET_FLOOR_MS : 0;
}

/** A schedule's period: its interval, a day, or a week. */
export function cronSchedulePeriodMs(schedule: CronSchedule): number {
  if ('every' in schedule) return schedule.every;
  return 'daily' in schedule ? DAY : WEEK;
}

/**
 * A fixed-time schedule's first due time after `at` (a tick stamped up to
 * {@link CRON_EARLY_TICK_SLACK_MS} before its minute counts as that minute's); `null` for an
 * interval.
 */
export function cronNextDueAt(schedule: CronSchedule, at: number): number | null {
  if ('every' in schedule) return null;
  const after = at + CRON_EARLY_TICK_SLACK_MS;
  const fixed = 'daily' in schedule ? schedule.daily : schedule.weekly;
  const d = new Date(after);
  let due = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    fixed.hourUTC,
    fixed.minuteUTC,
  );
  if ('weekly' in schedule) {
    due += ((((schedule.weekly.dayOfWeek - d.getUTCDay()) % 7) + 7) % 7) * DAY;
    if (due <= after) due += WEEK;
  } else if (due <= after) {
    due += DAY;
  }
  return due;
}

const finite = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n);

export function cronLiveness(
  hb: CronLivenessInput,
  schedule: CronSchedule,
  now: number,
): CronLiveness {
  // A `runningSince` older than the last tick was left by a finish that didn't clear it: no run.
  if (finite(hb.runningSince) && !(finite(hb.lastTickAt) && hb.runningSince < hb.lastTickAt)) {
    const since = hb.runningSince;
    return now - since <= CRON_KILLED_AFTER_MS
      ? { state: 'running', since }
      : { state: 'killed', since };
  }
  if (!finite(hb.lastTickAt)) return { state: 'never' };
  const lastTickAt = hb.lastTickAt;
  const floor = finite(hb.quietFloorMs) ? Math.max(0, hb.quietFloorMs) : 0;
  const expectedMs = Math.max(cronSchedulePeriodMs(schedule), floor);
  const quietMs = Math.max(0, now - lastTickAt);
  const nextAt = cronNextDueAt(schedule, lastTickAt);
  const base = { lastTickAt, quietMs, expectedMs, nextAt };
  if (quietMs > RUN_STALLED_FACTOR * expectedMs) return { state: 'stalled', ...base };
  const late =
    nextAt === null
      ? quietMs > RUN_LATE_FACTOR * expectedMs
      : now > nextAt + Math.min(expectedMs / 12, CRON_FIXED_GRACE_MAX_MS);
  if (late) return { state: 'late', ...base };
  if (hb.lastOutcome === 'failed' || hb.lastOutcome === 'killed') {
    return { state: 'failed', ...base };
  }
  return { state: 'ok', ...base };
}
