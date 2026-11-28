import { CRON_TICK_CODES, type CronLiveness, cronLiveness } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  at,
  cronRun,
  NOW,
  PUMP,
  PUMP_JOB,
  pumpRuns,
  pumpTicks,
  STATE_JOBS,
  WATCH_JOB,
} from './cronFixtures';
import {
  CRON_STATE_TONE,
  cronCardAt,
  cronCardState,
  cronLivenessAt,
  cronNextAt,
  cronReading,
  foldQuiet,
  opensByItself,
  placeTicks,
  runTone,
  sortTicks,
  tickAt,
  tickCounts,
  tickKind,
} from './cronModel';
import type { CronLastRun, CronRunView, CronTickView } from './cronViews';

const MIN = 60_000;
const HOUR = 60 * MIN;

const run = (outcome: NonNullable<CronLastRun>['outcome'], startedAt = at(14, 0)): CronLastRun => ({
  id: 'r' as never,
  startedAt,
  outcome,
  counts: null,
});
const ok: CronLiveness = {
  state: 'ok',
  lastTickAt: at(14, 9),
  quietMs: 3 * MIN,
  expectedMs: 3 * MIN,
  nextAt: null,
};
const running: CronLiveness = { state: 'running', since: at(14, 12) };

describe('the verdict', () => {
  it('is core’s rule on the inputs the read sent, at the web’s clock', () => {
    for (const { job } of STATE_JOBS) {
      expect(cronLivenessAt(job, NOW)).toEqual(cronLiveness(job.inputs, job.schedule, NOW));
    }
  });

  it('moves with the clock: an on-time pump goes late, then stalled, with no new read', () => {
    const job = { ...PUMP_JOB, inputs: { lastTickAt: at(14, 9), lastOutcome: 'ok' as const } };
    expect(cronReading(job, at(14, 10)).state).toBe('ok');
    expect(cronReading(job, at(14, 16)).state).toBe('late');
    expect(cronReading(job, at(14, 40)).state).toBe('stalled');
  });
});

describe('the card state (the Overview’s reading, killed kept)', () => {
  it('draws killed as the rule returns it', () => {
    expect(cronCardState({ state: 'killed', since: 1 }, null)).toBe('killed');
    expect(CRON_STATE_TONE.killed).toBe('bad');
  });

  it('keeps a failed or killed last run until a later run supersedes it', () => {
    expect(cronCardState(ok, run('failed'))).toBe('failed');
    expect(cronCardState(ok, run('killed'))).toBe('failed');
    expect(cronCardState(running, run('failed'))).toBe('failed');
    expect(cronCardState(running, run('ok'))).toBe('running');
    expect(cronCardState(running, null)).toBe('running');
  });

  it('reads a refused last run as retried, else ok', () => {
    expect(cronCardState(ok, run('refused'))).toBe('retried');
    expect(cronCardState(ok, run('ok'))).toBe('ok');
    expect(cronCardState(ok, run('capped'))).toBe('ok');
    expect(cronCardState(ok, null)).toBe('ok');
  });

  it('passes never, late, stalled and failed through', () => {
    expect(cronCardState({ state: 'never' }, null)).toBe('never');
    for (const state of ['late', 'stalled', 'failed'] as const) {
      expect(cronCardState({ ...ok, state }, run('ok'))).toBe(state);
    }
  });

  it('every fixture state reads as its name', () => {
    for (const { name, job } of STATE_JOBS) {
      const want = name === 'daily' || name === 'sparse' ? 'ok' : name;
      expect([name, cronReading(job, NOW).state]).toEqual([name, want]);
    }
  });
});

describe('when the card says it last ran', () => {
  it('is the last run while its state is that run’s', () => {
    expect(cronCardAt(ok, run('failed', 5), 'failed')).toBe(5);
    expect(cronCardAt(running, run('refused', 6), 'retried')).toBe(6);
  });
  it('is the tick under way, the kill, the last tick, or none', () => {
    expect(cronCardAt(running, null, 'running')).toBe(at(14, 12));
    expect(cronCardAt({ state: 'killed', since: 7 }, null, 'killed')).toBe(7);
    expect(cronCardAt(ok, run('ok'), 'ok')).toBe(at(14, 9));
    expect(cronCardAt({ state: 'never' }, null, 'never')).toBeNull();
    expect(cronCardAt({ ...ok, state: 'late' }, run('failed', 3), 'late')).toBe(at(14, 9));
  });
});

describe('the next run (ruling 17)', () => {
  it('is never named for an interval cron', () => {
    expect(cronNextAt({ every: HOUR }, ok, NOW)).toBeNull();
  });
  it('is the rule’s next due time for a fixed-time cron, else the next after now', () => {
    const live = cronLivenessAt(WATCH_JOB, NOW);
    expect(cronNextAt(WATCH_JOB.schedule, live, NOW)).toBe(Date.UTC(2026, 9, 15, 11, 30));
    // Never ticked: the next due time after now.
    expect(cronNextAt(WATCH_JOB.schedule, { state: 'never' }, NOW)).toBe(
      Date.UTC(2026, 9, 15, 11, 30),
    );
    // Late (its due time passed): the one after now, never a time already gone.
    const late: CronLiveness = { ...ok, state: 'late', nextAt: Date.UTC(2026, 9, 14, 11, 30) };
    expect(cronNextAt(WATCH_JOB.schedule, late, NOW)).toBe(Date.UTC(2026, 9, 15, 11, 30));
  });
  it('is always after now and on the schedule’s minute', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 * 24 * HOUR }), (offset) => {
        const now = Date.UTC(2026, 0, 1) + offset;
        const next = cronNextAt(WATCH_JOB.schedule, { state: 'never' }, now) as number;
        const d = new Date(next);
        return next > now && d.getUTCHours() === 11 && d.getUTCMinutes() === 30;
      }),
    );
  });
});

describe('ticks', () => {
  it('reads every code, and an unknown one as work, never as quiet', () => {
    expect(tickKind(CRON_TICK_CODES.ok)).toBe('quiet');
    expect(tickKind(CRON_TICK_CODES.worked)).toBe('worked');
    expect(tickKind(CRON_TICK_CODES.failed)).toBe('failed');
    expect(tickKind(CRON_TICK_CODES.killed)).toBe('killed');
    expect(tickKind(CRON_TICK_CODES.refused)).toBe('refused');
    expect(tickKind(7)).toBe('worked');
  });

  it('counts each kind', () => {
    const c = tickCounts(pumpTicks());
    expect(c.refused).toBe(1);
    expect(c.failed).toBe(1);
    expect(c.killed).toBe(1);
    expect(c.quiet + c.worked + c.refused + c.failed + c.killed).toBe(pumpTicks().length);
  });

  const tickArb = fc.record({
    at: fc.integer({ min: 0, max: 12 * HOUR }),
    code: fc.integer({ min: 0, max: 4 }),
    ms: fc.option(fc.integer({ min: 0, max: 60_000 }), { nil: null }),
  });

  it('places ticks oldest first, inside the strip, monotone in time, whatever order they came in', () => {
    fc.assert(
      fc.property(
        fc.array(tickArb, { maxLength: 300 }),
        fc.integer({ min: 1, max: 2000 }),
        (ticks, width) => {
          const marks = placeTicks(ticks, 0, 12 * HOUR, width);
          expect(marks).toHaveLength(ticks.length);
          for (let i = 1; i < marks.length; i++) {
            const [a, b] = [marks[i - 1], marks[i]] as [(typeof marks)[0], (typeof marks)[0]];
            expect(a.at).toBeLessThanOrEqual(b.at);
            expect(a.x).toBeLessThanOrEqual(b.x);
          }
          for (const m of marks) {
            expect(m.x).toBeGreaterThanOrEqual(0);
            expect(m.x).toBeLessThan(Math.max(1, width));
            expect(Number.isInteger(m.x)).toBe(true);
          }
        },
      ),
    );
  });

  it('leaves out ticks outside the range', () => {
    const t = (atMs: number): CronTickView => ({ at: atMs, code: 0, ms: null });
    expect(placeTicks([t(-1), t(0), t(10), t(11)], 0, 10, 100).map((m) => m.x)).toEqual([0, 99]);
  });

  it('a pointer finds the nearest tick, the louder of two on one pixel', () => {
    const marks = placeTicks(
      [
        { at: 10, code: CRON_TICK_CODES.ok, ms: 1 },
        { at: 10, code: CRON_TICK_CODES.failed, ms: 1 },
        { at: 50, code: CRON_TICK_CODES.ok, ms: 1 },
      ],
      0,
      100,
      100,
    );
    expect(tickAt(marks, 11)?.kind).toBe('failed');
    expect(tickAt(marks, 48)?.at).toBe(50);
    expect(tickAt(marks, 30)).toBeNull();
  });

  it('sorts a recorded-order row', () => {
    const ats = sortTicks(pumpTicks()).map((t) => t.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
  });
});

describe('the quiet ticks folded between runs', () => {
  const quiet = (atMs: number): CronTickView => ({ at: atMs, code: CRON_TICK_CODES.ok, ms: 12 });
  const runAt = (atMs: number) => cronRun(PUMP, atMs);

  it('folds each stretch between two runs into one line', () => {
    const rows = foldQuiet(
      [runAt(at(14, 9)), runAt(at(13, 0))],
      [quiet(at(14, 12)), quiet(at(13, 54)), quiet(at(13, 57)), quiet(at(14, 0)), quiet(at(12, 0))],
      false,
    );
    expect(rows).toEqual([
      { kind: 'quiet', count: 1, from: at(14, 12), to: at(14, 12) },
      { kind: 'run', run: runAt(at(14, 9)) },
      { kind: 'quiet', count: 3, from: at(13, 54), to: at(14, 0) },
      { kind: 'run', run: runAt(at(13, 0)) },
    ]);
  });

  it('folds the ticks past the oldest run only once the list is complete', () => {
    const runs = [runAt(at(13, 0))];
    const ticks = [quiet(at(12, 0)), quiet(at(12, 3))];
    expect(foldQuiet(runs, ticks, false)).toHaveLength(1);
    expect(foldQuiet(runs, ticks, true).at(-1)).toEqual({
      kind: 'quiet',
      count: 2,
      from: at(12, 0),
      to: at(12, 3),
    });
  });

  it('never folds a tick that is a run (a press that found nothing), nor one that did work', () => {
    const rows = foldQuiet(
      [runAt(at(13, 0) + 400)],
      [quiet(at(13, 0)), { at: at(12, 0), code: CRON_TICK_CODES.worked, ms: 1 }],
      true,
    );
    expect(rows).toEqual([{ kind: 'run', run: runAt(at(13, 0) + 400) }]);
  });

  it('keeps every run in order and folds each quiet tick at most once', () => {
    const base = at(0, 0);
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 720 }), { maxLength: 30 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 720 }), { maxLength: 200 }),
        (runMins, tickMins) => {
          const runs = [...runMins].sort((a, b) => b - a).map((m) => runAt(base + m * MIN));
          const ticks = tickMins.map((m) => quiet(base + m * MIN + 30_000));
          const rows = foldQuiet(runs, ticks, true);
          const listed = rows
            .filter((r) => r.kind === 'run')
            .map((r) => (r as { run: CronRunView }).run);
          expect(listed).toEqual(runs);
          const folded = rows.reduce((n, r) => n + (r.kind === 'quiet' ? r.count : 0), 0);
          expect(folded).toBe(ticks.length);
          // No two quiet lines in a row: a stretch is one line.
          for (let i = 1; i < rows.length; i++) {
            expect(rows[i - 1]?.kind === 'quiet' && rows[i]?.kind === 'quiet').toBe(false);
          }
        },
      ),
    );
  });
});

describe('a run', () => {
  it('opens its log by itself only when it failed or was killed', () => {
    expect(
      pumpRuns()
        .filter(opensByItself)
        .map((r) => r.outcome),
    ).toEqual(['killed', 'failed']);
  });
  it('is toned by meaning', () => {
    expect(runTone({ outcome: 'failed' })).toBe('bad');
    expect(runTone({ outcome: 'killed' })).toBe('bad');
    expect(runTone({ outcome: 'refused' })).toBe('warn');
    expect(runTone({ outcome: 'capped' })).toBe('warn');
    expect(runTone({ outcome: 'ok' })).toBe('quiet');
  });
});
