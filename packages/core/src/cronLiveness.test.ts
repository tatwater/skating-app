/**
 * The cron liveness rule. Mutation-checked: each mutation of `cronLiveness.ts` below was run and
 * seen to fail the tests named, then the source restored —
 *
 *  - **M1** the quiet's clamp dropped (`now − lastTickAt`): *a clock behind the server*;
 *  - **M2** late at `≥ 2E`: *reads an interval job at exactly 2E and 10E*, the sparse by-hand test;
 *    the factor 1 instead: those and *a sparse job's hour of quiet is never late*;
 *  - **M3** the quiet floor ignored: both sparse tests;
 *  - **M4** killed at the bare action limit (no minute's slack): *running inside the action limit*;
 *  - **M5** no early-stamp slack in `nextAt`, or a due time equal to the stamp kept (`<` for `<=`):
 *    *a tick stamped a moment before its minute*;
 *  - **M6** the fixed grace uncapped (a twelfth of a day, two hours): the daily and weekly tests;
 *  - **M7** failed checked before late: *a failed or killed last tick inside the window* and
 *    *never late inside 2E*.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CRON_EARLY_TICK_SLACK_MS,
  CRON_KILLED_AFTER_MS,
  CRON_SPARSE_QUIET_FLOOR_MS,
  type CronLiveness,
  type CronLivenessInput,
  type CronOutcome,
  type CronSchedule,
  cronLiveness,
  cronNextDueAt,
  cronQuietFloorMs,
  cronSchedulePeriodMs,
} from './cronLiveness';
import { RUN_LATE_FACTOR, RUN_STALLED_FACTOR } from './runLiveness';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Friday 27 November 2026, 14:00 UTC. */
const NOW = Date.UTC(2026, 10, 27, 14, 0);

const PUMP: CronSchedule = { every: 3 * MINUTE };
const POLL: CronSchedule = { every: 6 * HOUR };
const WATCH: CronSchedule = { daily: { hourUTC: 11, minuteUTC: 30 } };
const WEEKLY: CronSchedule = { weekly: { dayOfWeek: 1, hourUTC: 9, minuteUTC: 15 } };

/** The ladder over time, best first: what a clock moving forward may only climb. */
const LADDER: Record<CronLiveness['state'], number> = {
  never: 0,
  running: 0,
  ok: 0,
  failed: 0,
  killed: 1,
  late: 1,
  stalled: 2,
};

const schedule: fc.Arbitrary<CronSchedule> = fc.oneof(
  fc.integer({ min: 1, max: 7 * 24 * 60 }).map((m) => ({ every: m * MINUTE })),
  fc
    .record({
      hourUTC: fc.integer({ min: 0, max: 23 }),
      minuteUTC: fc.integer({ min: 0, max: 59 }),
    })
    .map((daily) => ({ daily })),
  fc
    .record({
      dayOfWeek: fc.integer({ min: 0, max: 6 }),
      hourUTC: fc.integer({ min: 0, max: 23 }),
      minuteUTC: fc.integer({ min: 0, max: 59 }),
    })
    .map((weekly) => ({ weekly })),
);
const outcome = fc.constantFrom<CronOutcome>('ok', 'worked', 'failed', 'killed');
const instant = fc.integer({ min: Date.UTC(2024, 0, 1), max: Date.UTC(2032, 0, 1) });
const floor = fc.constantFrom(0, CRON_SPARSE_QUIET_FLOOR_MS);
const ticked: fc.Arbitrary<CronLivenessInput> = fc.record({
  lastTickAt: instant,
  lastOutcome: outcome,
  quietFloorMs: floor,
});
const span = fc.integer({ min: 0, max: 400 * DAY });

describe('cronLiveness, by hand', () => {
  it('reads an interval job at exactly 2E and 10E', () => {
    const at = (q: number) => cronLiveness({ lastTickAt: NOW - q, lastOutcome: 'ok' }, PUMP, NOW);
    const E = 3 * MINUTE;
    expect(at(0).state).toBe('ok');
    expect(at(RUN_LATE_FACTOR * E).state).toBe('ok');
    expect(at(RUN_LATE_FACTOR * E + 1).state).toBe('late');
    expect(at(RUN_STALLED_FACTOR * E).state).toBe('late');
    expect(at(RUN_STALLED_FACTOR * E + 1).state).toBe('stalled');
    expect(at(7 * MINUTE)).toEqual({
      state: 'late',
      lastTickAt: NOW - 7 * MINUTE,
      quietMs: 7 * MINUTE,
      expectedMs: E,
      nextAt: null,
    });
  });

  it('never without a tick; a failed or killed last tick inside the window is failed', () => {
    expect(cronLiveness({}, POLL, NOW)).toEqual({ state: 'never' });
    expect(cronLiveness({ lastOutcome: 'ok' }, POLL, NOW)).toEqual({ state: 'never' });
    expect(cronLiveness({ lastTickAt: Number.NaN }, POLL, NOW)).toEqual({ state: 'never' });
    for (const o of ['failed', 'killed'] as const) {
      expect(cronLiveness({ lastTickAt: NOW - HOUR, lastOutcome: o }, POLL, NOW).state).toBe(
        'failed',
      );
    }
    for (const o of ['ok', 'worked'] as const) {
      expect(cronLiveness({ lastTickAt: NOW - HOUR, lastOutcome: o }, POLL, NOW).state).toBe('ok');
    }
    // Silence outranks the last outcome: a failed tick then twelve hours of nothing is late.
    expect(
      cronLiveness({ lastTickAt: NOW - 13 * HOUR, lastOutcome: 'failed' }, POLL, NOW).state,
    ).toBe('late');
  });

  it('running inside the action limit and its minute of slack, killed past it', () => {
    const since = NOW - CRON_KILLED_AFTER_MS;
    expect(cronLiveness({ runningSince: since }, PUMP, NOW)).toEqual({ state: 'running', since });
    expect(cronLiveness({ runningSince: since - 1 }, PUMP, NOW)).toEqual({
      state: 'killed',
      since: since - 1,
    });
    expect(CRON_KILLED_AFTER_MS).toBe(31 * MINUTE);
    // A live action may run the measured 30 minutes: never killed inside them, nor the minute after.
    for (const d of [10 * MINUTE + 1, 29 * MINUTE, 30 * MINUTE, 31 * MINUTE]) {
      expect(cronLiveness({ runningSince: NOW - d }, PUMP, NOW).state).toBe('running');
    }
    // A begin after the last tick is the run; one older than it was never cleared, so isn't.
    const hb = { lastTickAt: NOW - 2 * MINUTE, lastOutcome: 'ok' as const };
    expect(cronLiveness({ ...hb, runningSince: NOW - MINUTE }, PUMP, NOW).state).toBe('running');
    expect(cronLiveness({ ...hb, runningSince: NOW - 2 * MINUTE }, PUMP, NOW).state).toBe(
      'running',
    );
    expect(cronLiveness({ ...hb, runningSince: NOW - HOUR }, PUMP, NOW).state).toBe('ok');
  });

  it('a daily job is late an hour after it was due, not two days on; its next time is shown', () => {
    const lastTickAt = Date.UTC(2026, 10, 26, 11, 30, 4);
    const due = Date.UTC(2026, 10, 27, 11, 30);
    const at = (now: number) => cronLiveness({ lastTickAt, lastOutcome: 'ok' }, WATCH, now);
    expect(at(due)).toMatchObject({ state: 'ok', nextAt: due, expectedMs: DAY });
    expect(at(due + HOUR).state).toBe('ok');
    expect(at(due + HOUR + 1).state).toBe('late');
    expect(at(lastTickAt + 10 * DAY + 1).state).toBe('stalled');
  });

  it('a weekly job: its next Monday, and late an hour past it', () => {
    // Monday 23 November 2026, 09:15 UTC.
    const lastTickAt = Date.UTC(2026, 10, 23, 9, 15);
    const due = Date.UTC(2026, 10, 30, 9, 15);
    const at = (now: number) => cronLiveness({ lastTickAt, lastOutcome: 'ok' }, WEEKLY, now);
    expect(at(NOW)).toMatchObject({ state: 'ok', nextAt: due, expectedMs: 7 * DAY });
    expect(at(due + HOUR).state).toBe('ok');
    expect(at(due + HOUR + 1).state).toBe('late');
    // From a Thursday: the coming Monday.
    expect(cronNextDueAt(WEEKLY, NOW)).toBe(due);
  });

  it('a tick stamped a moment before its minute is that minute’s run', () => {
    const due = Date.UTC(2026, 10, 27, 11, 30);
    expect(cronNextDueAt(WATCH, due - 1)).toBe(due + DAY);
    expect(cronNextDueAt(WATCH, due - CRON_EARLY_TICK_SLACK_MS)).toBe(due + DAY);
    // A press well before it (a manual run at 11:00) leaves today's due time owed.
    expect(cronNextDueAt(WATCH, due - 30 * MINUTE)).toBe(due);
    expect(cronNextDueAt(PUMP, due)).toBeNull();
  });

  it('a sparse job’s hour-old quiet tick is on time; two hours of silence is late', () => {
    const floor = cronQuietFloorMs('sparse');
    const minutely: CronSchedule = { every: MINUTE };
    const at = (q: number) =>
      cronLiveness({ lastTickAt: NOW - q, lastOutcome: 'ok', quietFloorMs: floor }, minutely, NOW);
    expect(at(HOUR + MINUTE)).toMatchObject({ state: 'ok', expectedMs: HOUR });
    expect(at(2 * HOUR).state).toBe('ok');
    expect(at(2 * HOUR + 1).state).toBe('late');
    expect(at(10 * HOUR + 1).state).toBe('stalled');
    // The same job recorded every tick is late after two minutes.
    expect(cronLiveness({ lastTickAt: NOW - 3 * MINUTE }, minutely, NOW).state).toBe('late');
    // A failure is recorded as it happens, so it reads at once.
    expect(
      cronLiveness(
        { lastTickAt: NOW - MINUTE, lastOutcome: 'failed', quietFloorMs: floor },
        minutely,
        NOW,
      ).state,
    ).toBe('failed');
    expect(cronQuietFloorMs('every')).toBe(0);
    expect(CRON_SPARSE_QUIET_FLOOR_MS).toBe(HOUR);
    // A floor under the period changes nothing; a negative or broken one is no floor.
    expect(cronLiveness({ lastTickAt: NOW - 13 * HOUR, quietFloorMs: HOUR }, POLL, NOW).state).toBe(
      'late',
    );
    expect(
      cronLiveness({ lastTickAt: NOW - 3 * MINUTE, quietFloorMs: -HOUR }, minutely, NOW).state,
    ).toBe('late');
    expect(
      cronLiveness({ lastTickAt: NOW - 3 * MINUTE, quietFloorMs: Number.NaN }, minutely, NOW).state,
    ).toBe('late');
  });

  it('a schedule’s period is its interval, a day or a week', () => {
    expect(cronSchedulePeriodMs(PUMP)).toBe(3 * MINUTE);
    expect(cronSchedulePeriodMs(WATCH)).toBe(DAY);
    expect(cronSchedulePeriodMs(WEEKLY)).toBe(7 * DAY);
  });
});

describe('cronLiveness, its properties', () => {
  it('is monotone in time with the heartbeat fixed', () => {
    fc.assert(
      fc.property(
        fc.record({
          lastTickAt: fc.option(instant, { nil: undefined }),
          lastOutcome: fc.option(outcome, { nil: undefined }),
          runningSince: fc.option(instant, { nil: undefined }),
          quietFloorMs: floor,
        }),
        schedule,
        instant,
        span,
        (hb, s, now, d) => {
          const a = cronLiveness(hb, s, now);
          const b = cronLiveness(hb, s, now + d);
          expect(LADDER[b.state]).toBeGreaterThanOrEqual(LADDER[a.state]);
          if ('quietMs' in a && 'quietMs' in b) expect(b.quietMs).toBeGreaterThanOrEqual(a.quietMs);
        },
      ),
    );
  });

  it('an interval job is never late inside 2E, nor stalled inside 10E', () => {
    fc.assert(
      fc.property(ticked, fc.integer({ min: 1, max: 7 * 24 * 60 }), span, (hb, m, q) => {
        const s = { every: m * MINUTE };
        const E = Math.max(m * MINUTE, hb.quietFloorMs ?? 0);
        const v = cronLiveness(hb, s, (hb.lastTickAt as number) + q);
        if (q <= RUN_LATE_FACTOR * E) expect(['ok', 'failed']).toContain(v.state);
        if (q <= RUN_STALLED_FACTOR * E) expect(v.state).not.toBe('stalled');
        if (q > RUN_STALLED_FACTOR * E) expect(v.state).toBe('stalled');
        if (q > RUN_LATE_FACTOR * E) expect(['late', 'stalled']).toContain(v.state);
      }),
    );
  });

  it('a fixed-time job is never late before its due time and its grace, nor stalled inside 10E', () => {
    fc.assert(
      fc.property(
        ticked,
        schedule.filter((s) => !('every' in s)),
        span,
        (hb, s, q) => {
          const v = cronLiveness(hb, s, (hb.lastTickAt as number) + q);
          const next = cronNextDueAt(s, hb.lastTickAt as number) as number;
          if ((hb.lastTickAt as number) + q <= next + HOUR) {
            expect(['ok', 'failed']).toContain(v.state);
          }
          if (q <= RUN_STALLED_FACTOR * cronSchedulePeriodMs(s)) {
            expect(v.state).not.toBe('stalled');
          }
        },
      ),
    );
  });

  it('a sparse job’s hour of quiet is never late', () => {
    fc.assert(
      fc.property(
        instant,
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 0, max: HOUR + 30 * MINUTE }),
        (lastTickAt, m, q) => {
          const v = cronLiveness(
            { lastTickAt, lastOutcome: 'ok', quietFloorMs: cronQuietFloorMs('sparse') },
            { every: m * MINUTE },
            lastTickAt + q,
          );
          expect(v.state).toBe('ok');
        },
      ),
    );
  });

  it('nextAt is after the last tick, on the schedule’s minute, within one period of it', () => {
    fc.assert(
      fc.property(ticked, schedule, instant, (hb, s, now) => {
        const v = cronLiveness(hb, s, now);
        if (!('nextAt' in v)) return;
        if ('every' in s) {
          expect(v.nextAt).toBeNull();
          return;
        }
        const next = v.nextAt as number;
        const last = hb.lastTickAt as number;
        expect(next).toBeGreaterThan(last);
        expect(next - last).toBeLessThanOrEqual(cronSchedulePeriodMs(s) + CRON_EARLY_TICK_SLACK_MS);
        const d = new Date(next);
        const fixed = 'daily' in s ? s.daily : s.weekly;
        expect([
          d.getUTCHours(),
          d.getUTCMinutes(),
          d.getUTCSeconds(),
          d.getUTCMilliseconds(),
        ]).toEqual([fixed.hourUTC, fixed.minuteUTC, 0, 0]);
        if ('weekly' in s) expect(d.getUTCDay()).toBe(s.weekly.dayOfWeek);
      }),
    );
  });

  it('killed only past the action limit and its slack; running inside it', () => {
    fc.assert(
      fc.property(instant, fc.integer({ min: -HOUR, max: 2 * HOUR }), schedule, (since, d, s) => {
        const v = cronLiveness({ runningSince: since }, s, since + d);
        expect(v.state).toBe(d > CRON_KILLED_AFTER_MS ? 'killed' : 'running');
      }),
    );
  });

  it('a clock behind the server reads a quiet of 0, and nothing worse than the last outcome', () => {
    fc.assert(
      fc.property(ticked, schedule, fc.integer({ min: 0, max: DAY }), (hb, s, ahead) => {
        const v = cronLiveness(hb, s, (hb.lastTickAt as number) - ahead);
        expect(v).toMatchObject({ quietMs: 0 });
        const bad = hb.lastOutcome === 'failed' || hb.lastOutcome === 'killed';
        expect(v.state).toBe(bad ? 'failed' : 'ok');
      }),
    );
  });
});
