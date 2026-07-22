import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DWELL_GRACE_MS,
  type DwellState,
  emptyDwellState,
  recordDwellFix,
  suggestedSkateWindow,
} from './dwell';

const MIN = 60_000;
// A fixed "today" so the calendar-day pruning is deterministic: local noon on some day.
const NOON = new Date(2026, 0, 15, 12, 0, 0, 0).getTime();
const DAY_START = new Date(2026, 0, 15, 0, 0, 0, 0).getTime();

/** Fold a sequence of `[bodyId, minutesAfterNoon]` observations into a dwell state. */
function play(
  steps: readonly [string | null, number][],
  grace = DEFAULT_DWELL_GRACE_MS,
): DwellState {
  let state = emptyDwellState();
  for (const [bodyId, minutes] of steps) {
    state = recordDwellFix(state, bodyId, NOON + minutes * MIN, {
      graceMs: grace,
      dayStartMs: DAY_START,
    });
  }
  return state;
}

describe('recordDwellFix', () => {
  it('opens a dwell when the device first resolves onto a body', () => {
    const state = play([['lakeA', 0]]);
    expect(state.current).toMatchObject({ bodyId: 'lakeA', start: NOON });
    expect(state.intervals).toHaveLength(0);
  });

  it('extends the open dwell while the skater stays on the same body', () => {
    const state = play([
      ['lakeA', 0],
      ['lakeA', 30],
      ['lakeA', 60],
    ]);
    expect(state.current).toMatchObject({
      bodyId: 'lakeA',
      start: NOON,
      lastSeen: NOON + 60 * MIN,
    });
    expect(state.intervals).toHaveLength(0);
  });

  it('does not split the dwell for a brief shoreline excursion within the grace window', () => {
    const state = play([
      ['lakeA', 0],
      [null, 1], // a lap clips the shoreline — off any body for a moment
      ['lakeA', 2],
      ['lakeA', 40],
    ]);
    expect(state.intervals).toHaveLength(0);
    expect(state.current).toMatchObject({ bodyId: 'lakeA', start: NOON });
  });

  it('closes the dwell once the skater has been off the body past the grace window', () => {
    const state = play([
      ['lakeA', 0],
      ['lakeA', 30],
      [null, 30 + 5], // 5 min off > 2 min grace ⇒ a real departure
    ]);
    expect(state.intervals).toEqual([{ bodyId: 'lakeA', start: NOON, end: NOON + 30 * MIN }]);
    expect(state.current).toBeNull();
  });

  it('opens a new dwell when the skater moves to a different lake', () => {
    const state = play([
      ['lakeA', 0],
      ['lakeA', 20],
      ['lakeB', 20 + 5], // off A past grace, now on B
      ['lakeB', 40],
    ]);
    expect(state.intervals).toEqual([{ bodyId: 'lakeA', start: NOON, end: NOON + 20 * MIN }]);
    expect(state.current).toMatchObject({ bodyId: 'lakeB' });
  });
});

describe('suggestedSkateWindow', () => {
  it('returns nothing for a body with no dwell today', () => {
    expect(suggestedSkateWindow(emptyDwellState(), 'lakeA', { dayStartMs: DAY_START })).toEqual({});
  });

  it('suggests the open dwell span for the lake the skater is still on', () => {
    const state = play([
      ['lakeA', 0],
      ['lakeA', 90],
    ]);
    expect(suggestedSkateWindow(state, 'lakeA', { dayStartMs: DAY_START })).toEqual({
      start: NOON,
      end: NOON + 90 * MIN,
    });
  });

  it('collapses a leave-and-return into one earliest-in / latest-out window', () => {
    // Skate A, take a real break off the ice, come back to A — two intervals, one suggestion.
    const state = play([
      ['lakeA', 0],
      ['lakeA', 20],
      [null, 30], // off past grace ⇒ closes [0, 20]
      ['lakeA', 60],
      ['lakeA', 100], // second dwell on A, still open
    ]);
    expect(state.intervals).toHaveLength(1);
    expect(suggestedSkateWindow(state, 'lakeA', { dayStartMs: DAY_START })).toEqual({
      start: NOON,
      end: NOON + 100 * MIN,
    });
  });

  it("a peek at a neighbouring lake never fragments the first lake's suggestion", () => {
    const state = play([
      ['lakeA', 0],
      ['lakeA', 20],
      ['lakeB', 25], // wander to B past grace
      ['lakeB', 35],
      ['lakeA', 45], // back to A
      ['lakeA', 80],
    ]);
    // A's window spans its earliest start to its latest end; B's dwell doesn't touch it.
    expect(suggestedSkateWindow(state, 'lakeA', { dayStartMs: DAY_START })).toEqual({
      start: NOON,
      end: NOON + 80 * MIN,
    });
    expect(suggestedSkateWindow(state, 'lakeB', { dayStartMs: DAY_START })).toMatchObject({
      end: NOON + 35 * MIN,
    });
  });

  it('drops intervals from a previous day (on-device, day-scoped)', () => {
    // A dwell yesterday afternoon (recorded with yesterday's day-start, as the singleton would)...
    const yDayStart = new Date(2026, 0, 14, 0, 0, 0, 0).getTime();
    const yPM = new Date(2026, 0, 14, 14, 0, 0, 0).getTime();
    let state = recordDwellFix(emptyDwellState(), 'lakeA', yPM, { dayStartMs: yDayStart });
    state = recordDwellFix(state, 'lakeA', yPM + 60 * MIN, { dayStartMs: yDayStart });
    // ...then the first fix today (off any lake, well past grace) commits it — but it ends before today's
    // start, so the day-prune drops it and today's form gets no stale suggestion.
    state = recordDwellFix(state, null, NOON, { dayStartMs: DAY_START });
    expect(suggestedSkateWindow(state, 'lakeA', { dayStartMs: DAY_START })).toEqual({});
  });
});
