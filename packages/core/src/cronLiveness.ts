/**
 * **The cron liveness rule** (D343, D346, D347, B01-8b): whether a cron is on time, late, stalled,
 * failed, running or killed — one pure rule, read by the server (`machineryCrons.jobs`, the
 * Overview's card, later Health) and by the web's ticking clock, so the lane, the cards and the
 * Overview can't disagree, as `runLiveness` does for import runs.
 *
 * The rule (B01-8b's design, *The liveness rule*): *E* is the interval, or a day, or a week. With
 * `runningSince` set: `running` until Convex's action limit and a minute's slack, then `killed`. Else
 * with no tick: `never`. Else, quiet *q* = now − lastTickAt (never negative): `stalled` past
 * `RUN_STALLED_FACTOR`·*E*, `late` past `RUN_LATE_FACTOR`·*E* (a fixed-time job: past its next due
 * time plus a twelfth of *E*, at most an hour), else `failed` if the last tick failed or was
 * killed, else `ok`. `nextAt` only for daily and weekly schedules (ruling 17: an interval's phase
 * is set at deploy and can't be read).
 *
 * Decay here is *confidence in the machinery*, never a claim about the ice (D3).
 *
 * PLACEHOLDER (B01-8b seams): the types are the contract; the rule and its property tests are S2's,
 * and until then it throws.
 */

/** How a cron's last tick ended (`cronHeartbeats.lastOutcome`; the Convex package's `CRON_OUTCOMES`). */
export type CronOutcome = 'ok' | 'worked' | 'failed' | 'killed';

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
      expectedMs: number;
      /** Fixed-time schedules only; an interval's is `null` and never drawn. */
      nextAt: number | null;
    };

/** What the rule reads of a heartbeat (`cronHeartbeats`). */
export interface CronLivenessInput {
  lastTickAt?: number;
  lastOutcome?: CronOutcome;
  runningSince?: number;
}

export function cronLiveness(
  _hb: CronLivenessInput,
  _schedule: CronSchedule,
  _now: number,
): CronLiveness {
  throw new Error('PLACEHOLDER: cronLiveness is not built yet (B01-8b S2)');
}
