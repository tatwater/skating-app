import { fahrenheitToCelsius, JOB_STATES } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { LOWS_BOARD } from '../../season/sentinelLowsFixtures';
import { granuleRowModel } from './granuleRows';
import { imageryActionsShown } from './ImageryActions';
import {
  BACKING_OFF_PAGE,
  BOARD_ROWS,
  CROSSED_PAGE,
  CUTTING_A,
  EMPTY_A,
  EMPTY_OLD,
  ENDED_PAGE,
  FAILED_OOM,
  LANDED_A,
  LANDED_VIEW,
  NO_WATCH_PAGE,
  NOW,
  OLD_IMAGE_VIEW,
  OOM_VIEW,
  PAUSED_PAGE,
  QUEUED_A,
  RUNNING_PAGE,
  WAITING_PAGE,
  ZONE,
} from './imageryFixtures';
import {
  allListRows,
  attemptFailed,
  capturedAtOf,
  cronStateAt,
  dayClock,
  fahrenheit,
  fahrenheitSpan,
  granulePlatform,
  granuleTitle,
  imageryLaneTailFromPage,
  imageryLaneTailOf,
  isoDayWords,
  lastExit,
  lineCrossed,
  lowsFactsOf,
  machineMinutes,
  openAttempt,
  pageShapeOf,
  relativeDay,
  seasonWords,
  sentinelRows,
  totalQueued,
  waitingToRetry,
  worstCron,
} from './imageryModel';
import { exitWords, imageryTailWords, signalOf, whatToCheck } from './imageryWords';

const MIN = 60_000;
/** A fixture's value, there by construction (a test fails loudly if not). */
function need<T>(x: T | null | undefined): T {
  if (x == null) throw new Error('fixture missing');
  return x;
}
const HOUR = 60 * MIN;

describe('the page’s state', () => {
  test('waiting is not started or no watch; working is the rest', () => {
    expect(pageShapeOf('notStarted')).toBe('waiting');
    expect(pageShapeOf('noWatch')).toBe('waiting');
    expect(pageShapeOf('running')).toBe('working');
    expect(pageShapeOf('paused')).toBe('working');
    expect(pageShapeOf('ended')).toBe('working');
  });

  test('the line is crossed only once the watch recorded the night it was', () => {
    expect(lineCrossed(WAITING_PAGE.watch)).toBe(false);
    expect(lineCrossed(CROSSED_PAGE.watch)).toBe(true);
    expect(lineCrossed(NO_WATCH_PAGE.watch)).toBe(false);
    expect(lineCrossed(null)).toBe(false);
    // The watch's record is the fact (the lane's `ready` and the staff email read it too): a
    // coldest night at the line the watch hasn't recorded yet isn't called crossed here.
    const unrecorded = {
      ...need(WAITING_PAGE.watch),
      closestNight: { date: 'x', lowC: -6.667, site: 's' },
    };
    expect(lineCrossed(unrecorded)).toBe(false);
  });

  test('°F from °C: one decimal, whole without it, never −0', () => {
    expect(fahrenheit(fahrenheitToCelsius(20))).toBe('20');
    expect(fahrenheit(-6.222)).toBe('20.8');
    expect(fahrenheit(fahrenheitToCelsius(-0.01))).toBe('0');
    expect(fahrenheitSpan(-0.5)).toBe('0.9');
  });

  test('the season, written; the ledger’s total; machine-minutes', () => {
    expect(seasonWords('winter-2026-27')).toBe('Winter 2026–27');
    expect(seasonWords('odd')).toBe('odd');
    expect(totalQueued(RUNNING_PAGE.counts)).toBe(23);
    expect(machineMinutes(38 * MIN + 29_000)).toBe(38);
    expect(machineMinutes(-5)).toBe(0);
  });

  test('Try again now has something to lift only while backing off or re-reading', () => {
    expect(waitingToRetry(RUNNING_PAGE, NOW)).toBe(false);
    expect(waitingToRetry(BACKING_OFF_PAGE, NOW)).toBe(true);
    expect(waitingToRetry({ ...BACKING_OFF_PAGE, index: RUNNING_PAGE.index }, NOW + HOUR)).toBe(
      false,
    );
  });
});

describe('the bar', () => {
  test('each verb by the season’s state', () => {
    expect(imageryActionsShown(RUNNING_PAGE, NOW)).toEqual({
      retryFailed: true,
      pause: true,
      resume: false,
      tryAgain: false,
    });
    expect(imageryActionsShown(PAUSED_PAGE, NOW)).toMatchObject({ pause: false, resume: true });
    expect(imageryActionsShown(BACKING_OFF_PAGE, NOW).tryAgain).toBe(true);
    expect(Object.values(imageryActionsShown(ENDED_PAGE, NOW))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(Object.values(imageryActionsShown(WAITING_PAGE, NOW))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(
      imageryActionsShown({ ...RUNNING_PAGE, counts: { ...RUNNING_PAGE.counts, failed: 0 } }, NOW)
        .retryFailed,
    ).toBe(false);
  });
});

describe('a granule', () => {
  test('its name, by either grammar, and an id neither knows', () => {
    expect(granuleTitle(CUTTING_A)).toBe('Sentinel-2B · tile 18TXP');
    expect(granuleTitle(FAILED_OOM)).toBe('Sentinel-1A · GRD');
    expect(granulePlatform(FAILED_OOM)).toBe('Sentinel-1A');
    expect(granuleTitle({ granuleId: 'weird', mission: 's1' })).toBe('Sentinel-1 · weird');
    expect(granulePlatform({ granuleId: 'weird', mission: 's2' })).toBe('Sentinel-2');
  });

  test('a capture that doesn’t parse is null, never a made-up instant', () => {
    expect(capturedAtOf({ capturedAt: 'not a date' })).toBeNull();
    expect(capturedAtOf(FAILED_OOM)).toBe(Date.parse(FAILED_OOM.capturedAt));
  });

  test('under All, each failed granule once and first', () => {
    const { failed, rest } = allListRows([FAILED_OOM], [FAILED_OOM, ...BOARD_ROWS]);
    expect(failed).toEqual([FAILED_OOM]);
    expect(rest).toEqual(BOARD_ROWS);
    // A failed row the failed-first read didn't carry (past its 50) still never shows below.
    expect(allListRows([], [FAILED_OOM, CUTTING_A]).rest).toEqual([CUTTING_A]);
  });

  test('the open attempt: the asked one, else the newest; none of nothing', () => {
    expect(openAttempt(OOM_VIEW.attempts, 1)?.attempt).toBe(1);
    expect(openAttempt(OOM_VIEW.attempts, 7)?.attempt).toBe(2);
    expect(openAttempt(OOM_VIEW.attempts, null)?.attempt).toBe(2);
    expect(openAttempt([], null)).toBeNull();
  });

  test('which verdicts didn’t land (their log drawn open)', () => {
    expect(
      ['failed', 'requeued', 'refused', 'unconfirmed'].every((v) => attemptFailed(v as never)),
    ).toBe(true);
    expect(['landed', 'empty', 'cutting'].some((v) => attemptFailed(v as never))).toBe(false);
  });

  test('the last exit', () => {
    expect(lastExit(OOM_VIEW.attempts)).toEqual({ code: 137, oom: true });
    expect(lastExit([])).toBeNull();
    expect(lastExit([{ ...need(OOM_VIEW.attempts[0]), exitCode: null }])).toBeNull();
  });
});

describe('a granule’s row', () => {
  test('failed: red, its attempts, its last error', () => {
    const row = granuleRowModel(FAILED_OOM, NOW, ZONE);
    expect(row.state).toEqual({ label: 'failed', tone: 'bad' });
    expect(row.attempts).toEqual({ label: '2 attempts', tone: 'default' });
    expect(row.sub).toBe('Captured 12 Oct 22:51 · exit 137 both times');
    expect(row.age).toBe('1 d');
  });

  test('cutting: lit, how long its machine has been up', () => {
    const row = granuleRowModel(CUTTING_A, NOW, ZONE);
    expect(row.state.tone).toBe('lit');
    expect(row.attempts).toBeNull();
    expect(row.sub).toBe('Captured 14 Oct 15:41 · machine up 4 min');
    expect(row.age).toBe('4 min');
  });

  test('queued waits for a machine — never a next-run clock time', () => {
    expect(granuleRowModel(QUEUED_A, NOW, ZONE).sub).toBe(
      'Captured 14 Oct 15:41 · waiting for a machine',
    );
  });

  test('empty says the cutter’s reason, or that none was kept — never cloud', () => {
    expect(granuleRowModel(EMPTY_A, NOW, ZONE).sub).toBe(
      'Nothing to cut · no lake inside the imaged footprint',
    );
    expect(granuleRowModel(EMPTY_OLD, NOW, ZONE).sub).toBe(
      'Nothing to cut · the reason wasn’t recorded',
    );
  });

  test('landed is quiet', () => {
    const row = granuleRowModel(LANDED_A, NOW, ZONE);
    expect(row.state).toEqual({ label: 'landed', tone: 'ok' });
    expect(row.sub).toMatch(/frame landed$/);
  });
});

describe('the crons, at the clock', () => {
  const every = (ms: number) => ({ every: ms });
  test('core’s verdict, with a failed last run held through the ticks after it', () => {
    const base = {
      schedule: every(3 * MIN),
      inputs: { lastTickAt: NOW - MIN, lastOutcome: 'ok' as const },
    };
    expect(cronStateAt({ ...base, lastRun: null }, NOW).state).toBe('ok');
    expect(
      cronStateAt({ ...base, lastRun: { startedAt: NOW - 9 * MIN, outcome: 'failed' } }, NOW).state,
    ).toBe('failed');
    expect(
      cronStateAt({ ...base, lastRun: { startedAt: NOW - 9 * MIN, outcome: 'refused' } }, NOW)
        .state,
    ).toBe('retried');
    expect(
      cronStateAt(
        {
          schedule: every(3 * MIN),
          inputs: { runningSince: NOW - MIN },
          lastRun: { startedAt: 1, outcome: 'killed' },
        },
        NOW,
      ).state,
    ).toBe('failed');
    expect(
      cronStateAt(
        { schedule: every(3 * MIN), inputs: { runningSince: NOW - MIN }, lastRun: null },
        NOW,
      ).state,
    ).toBe('running');
    expect(
      cronStateAt(
        { schedule: every(3 * MIN), inputs: { runningSince: NOW - 2 * HOUR }, lastRun: null },
        NOW,
      ).state,
    ).toBe('failed');
    expect(cronStateAt({ schedule: every(3 * MIN), inputs: {}, lastRun: null }, NOW).state).toBe(
      'never',
    );
  });

  test('the worst of three, and the newest tick for ok', () => {
    expect(worstCron([], NOW)).toEqual({ state: 'never', at: null });
    const ok = (ago: number) => ({
      schedule: every(10 * MIN),
      inputs: { lastTickAt: NOW - ago, lastOutcome: 'ok' as const },
      lastRun: null,
    });
    expect(worstCron([ok(5 * MIN), ok(2 * MIN)], NOW)).toEqual({
      state: 'ok',
      at: NOW - 2 * MIN,
    });
    expect(worstCron([ok(5 * MIN), ok(25 * MIN)], NOW).state).toBe('late');
    expect(worstCron([ok(5 * MIN), ok(2 * HOUR)], NOW).state).toBe('stalled');
  });

  test('the worst never improves as the clock moves on with no tick (property)', () => {
    const order = [...JOB_STATES].reverse();
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 1, max: 600 }), fc.integer({ min: 0, max: 6_000 })), {
          minLength: 1,
          maxLength: 3,
        }),
        fc.integer({ min: 0, max: 10_000 }),
        (crons, later) => {
          const tails = crons.map(([period, ago]) => ({
            schedule: every(period * MIN),
            inputs: { lastTickAt: NOW - ago * MIN, lastOutcome: 'ok' as const },
            lastRun: null,
          }));
          const before = order.indexOf(worstCron(tails, NOW).state);
          const after = order.indexOf(worstCron(tails, NOW + later * MIN).state);
          return after >= before;
        },
      ),
    );
  });
});

describe('the sidebar’s tail', () => {
  test('from the page: the season’s word, or its crons while running', () => {
    expect(imageryLaneTailFromPage(WAITING_PAGE)).toEqual({ state: 'notStarted', ready: false });
    expect(imageryLaneTailFromPage(CROSSED_PAGE)).toEqual({ state: 'notStarted', ready: true });
    expect(imageryLaneTailFromPage(PAUSED_PAGE)).toEqual({ state: 'paused' });
    expect(imageryLaneTailFromPage(RUNNING_PAGE)).toEqual({
      state: 'running',
      crons: RUNNING_PAGE.crons,
    });
  });

  test('from the lanes read: only a shape it knows, never a guess', () => {
    expect(imageryLaneTailOf(undefined)).toBeUndefined();
    expect(imageryLaneTailOf({ state: 'odd' })).toBeUndefined();
    expect(imageryLaneTailOf({ state: 'running' })).toBeUndefined();
    expect(imageryLaneTailOf({ state: 'notStarted', ready: true })).toEqual({
      state: 'notStarted',
      ready: true,
    });
    expect(imageryLaneTailOf({ state: 'ended' })).toEqual({ state: 'ended' });
    expect(imageryLaneTailOf({ state: 'running', crons: [] })).toEqual({
      state: 'running',
      crons: [],
    });
    // The server's shape: while running it names the worst state and carries the crons.
    expect(
      imageryLaneTailOf({ state: 'ok', at: 1, crons: RUNNING_PAGE.crons, ready: false }),
    ).toEqual({ state: 'running', crons: RUNNING_PAGE.crons });
    expect(imageryLaneTailOf({ state: 'paused', at: null, crons: null, ready: false })).toEqual({
      state: 'paused',
    });
  });

  test('its words and tones', () => {
    expect(imageryTailWords({ state: 'notStarted', ready: false }, NOW)).toEqual({
      word: 'not started',
      tone: 'default',
    });
    expect(imageryTailWords({ state: 'notStarted', ready: true }, NOW).tone).toBe('warn');
    expect(imageryTailWords({ state: 'noWatch' }, NOW).word).toBe('not started');
    expect(imageryTailWords({ state: 'paused' }, NOW)).toEqual({ word: 'paused', tone: 'warn' });
    expect(imageryTailWords({ state: 'ended' }, NOW).word).toBe('ended');
    expect(imageryTailWords({ state: 'never', at: null }, NOW).word).toBe('not recorded yet');
    expect(imageryTailWords({ state: 'stalled', at: 1 }, NOW).tone).toBe('bad');
    expect(imageryTailWords({ state: 'failed', at: 1 }, NOW).tone).toBe('bad');
    expect(imageryTailWords({ state: 'late', at: 1 }, NOW).tone).toBe('warn');
    expect(imageryTailWords({ state: 'running', at: 1 }, NOW).tone).toBe('lit');
    expect(imageryTailWords({ state: 'ok', at: NOW - 2 * MIN }, NOW).word).toBe('ok 2 min');
    expect(imageryTailWords({ state: 'ok', at: null }, NOW).word).toBe('ok');
  });
});

describe('What to check', () => {
  test('memory, every attempt alike: the size is the cutter’s config', () => {
    const rows = whatToCheck(OOM_VIEW.attempts, 0);
    expect(rows.map((r) => r.label)).toEqual(['Exit 137', 'Machine size']);
    expect(rows[0]?.body).toMatch(/every attempt died the same way/);
  });

  test('a single non-memory exit, an old image', () => {
    expect(whatToCheck(OLD_IMAGE_VIEW.attempts, 0).map((r) => r.label)).toEqual([
      'Exit 2',
      'No cutter log',
    ]);
  });

  test('a death by signal without Fly’s OOM word is a stop from outside, never the cutter’s error', () => {
    const stopped = { ...need(OOM_VIEW.attempts[0]), exitCode: 130, oomKilled: false };
    const rows = whatToCheck([stopped], 0);
    expect(rows.map((r) => r.label)).toEqual(['Exit 130']);
    expect(rows[0]?.body).toMatch(/outside the cutter stopped the Machine \(SIGINT\)/);
    expect(exitWords(130, false)).toBe('Stopped from outside (SIGINT)');
    expect(exitWords(137, false)).toBe('Stopped from outside (SIGKILL)');
    expect(exitWords(137, true)).toBe('Killed: out of memory');
    expect(exitWords(2, false)).toBe('The cutter stopped with an error');
    expect(exitWords(0, false)).toBe('It exited cleanly but left no frame');
    expect(signalOf(255)).toBeNull();
    expect(signalOf(128 + 6)).toBe('signal 6');
  });

  test('refused three times, never confirmed, a clean landing', () => {
    const refused = {
      ...need(OOM_VIEW.attempts[0]),
      verdict: 'refused' as const,
      exitCode: null,
      oomKilled: null,
    };
    expect(whatToCheck([refused], 3).map((r) => r.label)).toEqual(['Spawn refused']);
    const lost = { ...refused, verdict: 'unconfirmed' as const };
    expect(whatToCheck([lost], 0).map((r) => r.label)).toEqual(['Never confirmed']);
    expect(whatToCheck(LANDED_VIEW.attempts, 0)).toEqual([]);
    expect(whatToCheck([], 0)).toEqual([]);
  });
});

describe('days and the lows', () => {
  test('days written by the reader’s zone, and calendar days as labels', () => {
    expect(dayClock(Date.parse('2026-10-13T02:51:00Z'), ZONE)).toBe('12 Oct 22:51');
    expect(isoDayWords('2026-10-03')).toBe('Sat 3 Oct');
    expect(isoDayWords('nope')).toBe('nope');
    expect(relativeDay(NOW - HOUR, NOW, ZONE)).toBe('Today');
    expect(relativeDay(NOW - 24 * HOUR, NOW, ZONE)).toBe('Yesterday');
    expect(relativeDay(NOW - 72 * HOUR, NOW, ZONE)).toBe('Sun 11 Oct');
  });

  test('the lows’ facts and each sentinel against the line', () => {
    expect(lowsFactsOf(null)).toBeNull();
    expect(
      lowsFactsOf({ state: 'none', season: 2026, countsFrom: '2026-10-01', roster: 3 }),
    ).toBeNull();
    const facts = lowsFactsOf(LOWS_BOARD);
    expect(facts?.opened).toEqual({ fired: 2, of: 3 });
    expect(facts?.crossed?.on).toBe('2026-10-07');
    const rows = sentinelRows(LOWS_BOARD);
    expect(rows.map((r) => r.name)).toEqual([
      'Upper Lake of the Clouds',
      'Eagle Lake',
      'Kinsman Pond',
    ]);
    const clouds = need(rows[0]);
    expect(clouds.coldest?.on).toBe('2026-10-07');
    expect(fahrenheit(need(clouds.coldest).c)).toBe('19');
    expect(clouds.measured).toBe(12);
    expect(clouds.atOrBelow).toBe(10);
    expect(need(clouds.shortC) < 0).toBe(true);
    expect(sentinelRows(undefined)).toEqual([]);
  });

  test('a night exactly at the watch’s line counts as at or below it', () => {
    const at = {
      ...LOWS_BOARD,
      sentinels: [{ ...need(LOWS_BOARD.sentinels[0]), lows: [LOWS_BOARD.lines.watchC, 5] }],
    };
    expect(sentinelRows(at)[0]).toMatchObject({ atOrBelow: 1, measured: 2 });
  });

  test('a gap is a gap: never a zero, never the coldest', () => {
    const gappy = {
      ...LOWS_BOARD,
      sentinels: [{ ...need(LOWS_BOARD.sentinels[0]), lows: [null, null] }],
    };
    expect(sentinelRows(gappy)).toEqual([
      expect.objectContaining({
        lastC: null,
        coldest: null,
        measured: 0,
        atOrBelow: 0,
        shortC: null,
      }),
    ]);
  });
});

test('the fixtures’ clock is the board’s', () => {
  expect(new Date(NOW).toISOString()).toBe('2026-10-14T18:12:00.000Z');
  expect(LANDED_VIEW.row.status).toBe('landed');
  expect(ENDED_PAGE.state).toBe('ended');
});
