import {
  addDaysIso,
  celsiusToFahrenheit,
  dailyLowsFromHourly,
  expandLows,
  mergeLows,
} from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FAILED_READ } from '@/components/admin/reads/readFailureFixtures';

import { LOWS_BOARD, LOWS_GAPPY } from './sentinelLowsFixtures';
import {
  labeledNights,
  lowsState,
  lowsView,
  nightsOf,
  placeEventWords,
  type SentinelLowsRead,
  tensAround,
  wholeF,
} from './sentinelLowsModel';

type Valued = Extract<SentinelLowsRead, { state: 'value' }>;

describe('the sentinel row from the read', () => {
  it('draws the board: three short names, whole °F, the period, both lines and both marked nights', () => {
    const v = lowsView(LOWS_BOARD);
    expect(v.period).toBe('1–12 Oct');
    expect(v.rows.map((r) => r.label)).toEqual(['Clouds', 'Eagle', 'Kinsman']);
    expect(v.rows.map((r) => r.tone)).toEqual(['lead', 'muted', 'faint']);
    expect(v.rows[0]?.values).toEqual([34, 31, 27, 30, 24, 29, 19, 25, 28, 33, 30, 31]);
    expect(v.rows.map((r) => r.end?.text)).toEqual(['Clouds 31', 'Eagle 33', 'Kinsman 37']);
    expect(v.lines).toEqual({
      watchF: 32,
      imageryF: 20,
      watchWords: 'the watch · 32 °F',
      imageryWords: 'imagery · 20 °F',
    });
    expect(v.opened).toMatchObject({
      night: '2026-10-03',
      index: 2,
      words: 'Watch opened · 2 of 3',
    });
    expect(v.opened?.marks).toEqual([
      { row: 0, value: 27 },
      { row: 1, value: 30 },
    ]);
    expect(v.imagery).toMatchObject({ index: 6, words: 'Imagery line · 19 °F' });
    expect(v.ticks).toEqual([10, 20, 30, 40]);
    expect(v.labeled).toEqual([0, 4, 8, 11]);
    expect(v.labels[0]).toBe('1 Oct');
  });

  it('a gap is a gap: no value, no marker on it, and the end label names its own last night', () => {
    const v = lowsView(LOWS_GAPPY);
    const eagle = v.rows[1];
    expect(eagle?.values.slice(-3)).toEqual([null, null, null]);
    expect(eagle?.end).toEqual({ text: 'Eagle 30 · 9 Oct', value: 30, index: 8 });
    // Clouds has no low on the opening night: the record named it, but no marker is drawn.
    expect(v.opened?.marks.map((m) => m.row)).toEqual([1]);
    // A sentinel with nothing stored has no end label at all.
    expect(v.rows[2]?.end).toBeNull();
    expect(v.rows[2]?.values.every((x) => x === null)).toBe(true);
  });

  it('a sentinel the board doesn’t name keeps its full name; an opening with no sentinel says only that', () => {
    const v = lowsView({
      ...LOWS_BOARD,
      sentinels: [
        { ...(LOWS_BOARD.sentinels[0] as Valued['sentinels'][number]), name: 'Bog Pond' },
      ],
      opened: { on: '2026-10-03', of: 3, sites: [] },
      imageryLine: { on: '2026-10-07', sites: [] },
    });
    expect(v.rows[0]?.label).toBe('Bog Pond');
    expect(v.opened?.words).toBe('Watch opened');
    expect(v.imagery?.words).toBe('Imagery line');
    expect(v.rows.map((r) => r.tone)).toEqual(['lead']);
  });

  it('a marked night outside the drawn nights is not drawn; a fourth sentinel wears the faint ink', () => {
    const extra = LOWS_BOARD.sentinels[2] as Valued['sentinels'][number];
    const v = lowsView({
      ...LOWS_BOARD,
      sentinels: [...LOWS_BOARD.sentinels, { ...extra, key: 'k4' }],
      opened: { on: '2026-09-28', of: 4, sites: [] },
      imageryLine: null,
    });
    expect([v.opened, v.imagery]).toEqual([null, null]);
    expect(v.rows[3]?.tone).toBe('faint');
  });

  it('the period spans months and a single night; the y axis brackets every value in tens', () => {
    expect(
      lowsView({ ...LOWS_BOARD, firstDate: '2026-09-28', lastDate: '2026-10-03' }).period,
    ).toBe('28 Sep–3 Oct');
    expect(
      lowsView({
        ...LOWS_BOARD,
        lastDate: '2026-10-01',
        sentinels: LOWS_BOARD.sentinels.map((s) => ({ ...s, lows: s.lows.slice(0, 1) })),
      }).period,
    ).toBe('1 Oct');
    expect(tensAround([20, 20])).toEqual([10, 20, 30]);
    expect(tensAround([-3, 41])).toEqual([-10, 0, 10, 20, 30, 40, 50]);
    expect(tensAround([])).toEqual([]);
    expect(labeledNights(0)).toEqual([]);
    expect(labeledNights(1)).toEqual([0]);
    expect(labeledNights(2)).toEqual([0, 1]);
    expect(labeledNights(120)).toEqual([0, 40, 80, 119]);
  });

  it('whole °F never reads −0', () => {
    expect(Object.is(wholeF(-17.8), 0)).toBe(true);
    expect(wholeF(-0.4)).toBe(31);
  });
});

describe('the four answers stay apart', () => {
  it('loading, failed, nothing recorded (before the floor, or nothing stored) and a value', () => {
    expect(lowsState(undefined)).toEqual({ kind: 'loading' });
    expect(lowsState(FAILED_READ)).toMatchObject({ kind: 'failed', pending: false });
    expect(lowsState(null)).toEqual({ kind: 'none' });
    expect(lowsState({ state: 'before', season: 2026, countsFrom: '2026-10-01' })).toEqual({
      kind: 'before',
      countsFrom: '2026-10-01',
    });
    expect(lowsState({ state: 'none', season: 2026, countsFrom: '2026-10-01', roster: 3 })).toEqual(
      { kind: 'none' },
    );
    expect(lowsState(LOWS_BOARD).kind).toBe('value');
  });
});

// ── Dates are the watch's, in every zone ─────────────────────────────────────────────────────

const NY_DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  day: 'numeric',
  month: 'short',
});

/** "1 Oct" for the New York calendar day an instant falls in — what the watch dated the night by. */
function nyLabel(sec: number): string {
  const parts = NY_DAY.formatToParts(sec * 1000);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('day')} ${pick('month')}`;
}

/** Hourly lows at a New York site from a New York midnight a few days before either DST change. */
const hourly = fc
  .record({
    change: fc.constantFrom('2026-03-08T05:00:00Z', '2026-11-01T04:00:00Z'),
    daysBefore: fc.integer({ min: 0, max: 5 }),
    temps: fc.array(fc.option(fc.double({ min: -30, max: 15, noNaN: true }), { nil: null }), {
      minLength: 24 * 3,
      maxLength: 24 * 9,
    }),
  })
  .map(({ change, daysBefore, temps }) => {
    // A New York midnight (the change's own midnight, in standard time either side of it).
    const start = Date.parse(change) / 1000 - daysBefore * 86_400;
    return { times: temps.map((_, i) => start + i * 3600), temps };
  });

describe('a night keeps its date and its value in every reader’s zone, across both DST changes', () => {
  const property = fc.property(hourly, ({ times, temps }) => {
    // The watch's own cut, in the site's zone, then its own store.
    const nights = dailyLowsFromHourly(times, temps, 'America/New_York', -5 * 3600);
    fc.pre(nights.length > 0);
    const stored = mergeLows(null, nights);
    const first = stored.firstDate;
    const last = addDaysIso(first, stored.lows.length - 1);
    const view = lowsView({
      ...LOWS_BOARD,
      firstDate: first,
      lastDate: last,
      sentinels: [
        { key: 's', bodyId: 's', name: 'Kinsman Pond', status: 'read', lows: stored.lows },
      ],
      opened: null,
      imageryLine: null,
    });
    // The chart's nights are the watch's own days, in order.
    expect(view.nights).toEqual(nightsOf(first, last));
    expect(expandLows(stored).every((d) => view.nights.includes(d.date))).toBe(true);
    for (const night of nights) {
      const i = view.nights.indexOf(night.date);
      // The value: the night's low in whole °F.
      expect(view.rows[0]?.values[i]).toBe(Math.round(celsiusToFahrenheit(night.minTempC)) || 0);
      // The date: the New York calendar day of that night's coldest hour, whatever zone this runs in.
      const hour = times.find(
        (t, k) => temps[k] === night.minTempC && nyLabel(t) === view.labels[i],
      );
      expect(hour).toBeDefined();
    }
    // A night the watch has no low for is a gap.
    view.nights.forEach((d, i) => {
      if (!nights.some((n) => n.date === d)) expect(view.rows[0]?.values[i]).toBeNull();
    });
  });

  it('pinned seeds and one random', () => {
    for (const seed of [20261117, 8, 1101]) fc.assert(property, { seed, numRuns: 120 });
    fc.assert(property, { numRuns: 120 });
  });
});

describe('the marked nights’ words stay inside the drawing and off each other', () => {
  it('sit right of their rules on the board', () => {
    expect(
      placeEventWords(
        [
          { x: 212, width: 174 },
          { x: 556, width: 166 },
        ],
        1112,
      ),
    ).toEqual([
      { x: 217, anchor: 'start', line: 0 },
      { x: 561, anchor: 'start', line: 0 },
    ]);
  });

  it('turn left at the edge, and drop a line rather than touch', () => {
    expect(
      placeEventWords(
        [
          { x: 100, width: 174 },
          { x: 220, width: 166 },
        ],
        368,
      ),
    ).toEqual([
      { x: 105, anchor: 'start', line: 0 },
      { x: 215, anchor: 'end', line: 1 },
    ]);
    // A label wider than either side keeps to the right rather than run off the left.
    expect(placeEventWords([{ x: 10, width: 400 }], 300)).toEqual([
      { x: 15, anchor: 'start', line: 0 },
    ]);
  });
});
