import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  DEFAULT_WINTER_ENTER_NIGHTS,
  DEFAULT_WINTER_EXIT_NIGHTS,
  DEFAULT_WINTER_WINDOW_NIGHTS,
  type GateOptions,
  type SiteSeries,
  winterEndAfter,
  winterNightsInWindow,
  winterOnOrAfter,
  winterWindow,
} from './ingestGate';

const START = '2026-10-01';
const night = (i: number) => addDaysIso(START, i);

/** Consecutive days from `START`, each with the given low; `null` is a night with no reading. */
function series(siteId: string, lows: Array<number | null>, sentinel?: boolean): SiteSeries {
  return {
    siteId,
    ...(sentinel ? { sentinel: true } : {}),
    days: lows.flatMap((minTempC, i) => (minTempC === null ? [] : [{ date: night(i), minTempC }])),
  };
}

/** One ordinary site whose nights are winter (`C`), not (`W`), or unreported (`.`). */
function nights(pattern: string): SiteSeries[] {
  return [
    series(
      'a',
      [...pattern].map((c) => (c === 'C' ? -3 : c === 'W' ? 4 : null)),
    ),
  ];
}

/**
 * 25 ordinary lakes from per-night counts of how many froze — the shape the stored lows reduce to.
 * Real counts below are from dev's `seasonWatchSeries` (2026-11-20).
 */
function region(first: string, frozen: readonly number[]): SiteSeries[] {
  return Array.from({ length: 25 }, (_, site) => ({
    siteId: `lake-${site}`,
    days: frozen.map((count, i) => ({
      date: addDaysIso(first, i),
      minTempC: site < count ? -1 : 2,
    })),
  }));
}

describe('winterOnOrAfter — winter sets in on a window of nights (D290)', () => {
  it('sets in on the tenth winter night of fourteen, not before', () => {
    const sites = nights('CCCWCCWCCCWCC');
    // The tenth winter night is the thirteenth night, and all of them are inside fourteen.
    expect(winterOnOrAfter(sites, START)).toMatchObject({ date: night(12), nights: 10 });
    expect(winterOnOrAfter(nights('CCCWCCWCCCWC'), START)).toBeNull();
    // Ten winter nights spread over fifteen never fill one window.
    expect(winterOnOrAfter(nights('CCCCCWWWWWCCCCC'), START)).toBeNull();
  });

  it('never sets in on a warm night, however full the window', () => {
    // From the 11th night the window holds ten, but that night is warm: the next winter night sets it.
    const sites = nights('CCCCCCCCCCWWC');
    expect(winterOnOrAfter(sites, night(10))).toMatchObject({ date: night(12), nights: 11 });
  });

  it('counts cold nights from before the watch opened', () => {
    expect(winterOnOrAfter(nights('CCCCCCCCCCC'), night(10))?.date).toBe(night(10));
  });

  it('reports the night that set it in', () => {
    const sites = [
      series('a', Array(10).fill(-2)),
      series('b', Array(10).fill(-1)),
      series('c', [...Array(9).fill(-1), 3]),
    ];
    expect(winterOnOrAfter(sites, START)).toEqual({
      date: night(9),
      frozen: [
        { siteId: 'a', lowC: -2 },
        { siteId: 'b', lowC: -1 },
      ],
      reporting: 3,
      nights: 10,
    });
  });

  it('is the old one-night rule with a window of one', () => {
    const one: GateOptions = { winterWindowNights: 1, winterEnterNights: 1 };
    expect(winterOnOrAfter(nights('WWCW'), START, one)?.date).toBe(night(2));
  });

  it('⚠ does not set in on 2026-27 so far: one cold night on 7 October is not winter', () => {
    // 1 Oct – 16 Nov 2026. The old rule recorded winter on 7 Oct (13 of 25); the watch's end was
    // then measured from it, and 3–10 Nov had no freeze anywhere — two nights short of ending it.
    const frozen = [
      0, 0, 0, 1, 0, 1, 13, 0, 0, 1, 2, 0, 0, 0, 0, 0, 18, 24, 17, 9, 13, 6, 10, 24, 19, 9, 15, 24,
      2, 0, 13, 24, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 5, 7, 16, 10, 22,
    ];
    const sites = region('2026-10-01', frozen);
    expect(winterOnOrAfter(sites, '2026-10-03')).toBeNull();
    expect(
      winterOnOrAfter(sites, '2026-10-03', { winterWindowNights: 1, winterEnterNights: 1 })?.date,
    ).toBe('2026-10-07');
    expect(winterNightsInWindow(sites, '2026-11-16')).toBe(2);
  });

  it('sets in on 3 December 2024, through November 2024’s false starts', () => {
    // 27 Oct – 5 Dec 2024: three cold spells in a fortnight, each undone, then the real one.
    const frozen = [
      10, 18, 19, 0, 0, 0, 10, 20, 19, 0, 0, 0, 1, 13, 19, 0, 19, 25, 25, 23, 3, 8, 3, 1, 4, 0, 1,
      2, 15, 23, 23, 19, 15, 24, 25, 25, 25, 25, 25, 24,
    ];
    const sites = region('2024-10-27', frozen);
    expect(winterOnOrAfter(sites, '2024-10-01')?.date).toBe('2024-12-03');
  });
});

describe('winterEndAfter — winter ends when the window empties (D290)', () => {
  const WINTER = 'C'.repeat(14);

  it('survives a January thaw of three nights, and of a week', () => {
    expect(winterEndAfter(nights(`${WINTER}WWWCCCC`), night(9))).toBeNull();
    expect(winterEndAfter(nights(`${WINTER}WWWWWWWCCCC`), night(9))).toBeNull();
  });

  it('ends on the night the window falls to four winter nights', () => {
    // Fourteen winter nights, then warm: the tenth warm night leaves four in the window.
    expect(winterEndAfter(nights(`${WINTER}${'W'.repeat(12)}`), night(9))).toBe(night(23));
  });

  it('never ends on nights nobody reported — a failed tick is not a thaw', () => {
    expect(winterEndAfter(nights(`${WINTER}WW..........`), night(9))).toBeNull();
  });

  it('counts a gap inside the window as no winter night', () => {
    expect(winterNightsInWindow(nights('CC.CC'), night(4))).toBe(4);
  });

  it('never consults a sentinel', () => {
    const sites = [
      series('summit', Array(30).fill(-9), true),
      ...nights(`${WINTER}${'W'.repeat(12)}`),
    ];
    expect(winterEndAfter(sites, night(9))).toBe(night(23));
  });
});

describe('winterWindow — the knobs, whole and in order', () => {
  it('defaults to 10 of the last 14 to set in, 4 or fewer to end', () => {
    expect(winterWindow()).toEqual({
      window: DEFAULT_WINTER_WINDOW_NIGHTS,
      enter: DEFAULT_WINTER_ENTER_NIGHTS,
      exit: DEFAULT_WINTER_EXIT_NIGHTS,
    });
    expect(winterWindow()).toEqual({ window: 14, enter: 10, exit: 4 });
  });

  it('keeps exit below enter and enter inside the window', () => {
    expect(
      winterWindow({ winterWindowNights: 5, winterEnterNights: 9, winterExitNights: 9 }),
    ).toEqual({
      window: 5,
      enter: 5,
      exit: 4,
    });
    expect(
      winterWindow({ winterWindowNights: 0, winterEnterNights: 0, winterExitNights: -2 }),
    ).toEqual({
      window: 1,
      enter: 1,
      exit: 0,
    });
  });

  it('never calls a night winter under a fraction that is not a number', () => {
    const sites = nights('C'.repeat(20));
    expect(winterOnOrAfter(sites, START, { winterFraction: Number.NaN })).toBeNull();
    expect(winterNightsInWindow(sites, night(19), { winterFraction: Number.NaN })).toBe(0);
  });
});

describe('the window rule, for any weather', () => {
  const lows = fc.array(fc.option(fc.integer({ min: -10, max: 10 }), { nil: null }), {
    maxLength: 40,
  });
  const roster = fc
    .array(fc.tuple(lows, fc.boolean()), { maxLength: 6 })
    .map((rows) => rows.map(([l, sentinel], i) => series(`s${i}`, l, sentinel)));
  const knobs = fc
    .record({
      winterWindowNights: fc.integer({ min: 1, max: 21 }),
      winterEnterNights: fc.integer({ min: 1, max: 21 }),
      winterExitNights: fc.integer({ min: 0, max: 21 }),
      winterFraction: fc.double({ min: 0.05, max: 1, noNaN: true }),
    })
    .map((o): GateOptions => o);

  it('sets in on the first qualifying winter night, and no sooner', () => {
    fc.assert(
      fc.property(roster, fc.integer({ min: 0, max: 40 }), knobs, (sites, offset, options) => {
        const from = night(offset);
        const found = winterOnOrAfter(sites, from, options);
        const { enter } = winterWindow(options);
        for (let i = offset; i < 40; i++) {
          const date = night(i);
          if (found !== null && date >= found.date) break;
          const single = winterOnOrAfter(sites, date, {
            ...options,
            winterWindowNights: 1,
            winterEnterNights: 1,
          });
          // An earlier winter night never had the count.
          if (single?.date === date)
            expect(winterNightsInWindow(sites, date, options)).toBeLessThan(enter);
        }
        if (found !== null) {
          expect(found.date >= from).toBe(true);
          expect(found.nights).toBe(winterNightsInWindow(sites, found.date, options));
          expect(found.nights).toBeGreaterThanOrEqual(enter);
          expect(found.frozen.length).toBeGreaterThan(0);
        }
      }),
    );
  });

  it('ends on the first night the count falls to the exit, and holds until then', () => {
    fc.assert(
      fc.property(roster, fc.integer({ min: 0, max: 40 }), knobs, (sites, offset, options) => {
        const from = night(offset);
        const end = winterEndAfter(sites, from, options);
        const { exit } = winterWindow(options);
        if (end !== null) {
          expect(end > from).toBe(true);
          expect(winterNightsInWindow(sites, end, options)).toBeLessThanOrEqual(exit);
        }
      }),
    );
  });

  it('is unmoved by any sentinel', () => {
    fc.assert(
      fc.property(roster, lows, knobs, (sites, summit, options) => {
        const ordinary = sites.filter((s) => !s.sentinel);
        const withSummit = [...ordinary, series('summit', summit, true)];
        expect(winterOnOrAfter(withSummit, START, options)).toEqual(
          winterOnOrAfter(ordinary, START, options),
        );
        expect(winterEndAfter(withSummit, START, options)).toBe(
          winterEndAfter(ordinary, START, options),
        );
      }),
    );
  });

  it('never sets in and ends on the same night', () => {
    fc.assert(
      fc.property(roster, knobs, (sites, options) => {
        const set = winterOnOrAfter(sites, START, options);
        if (set === null) return;
        const { exit } = winterWindow(options);
        expect(winterNightsInWindow(sites, set.date, options)).toBeGreaterThan(exit);
      }),
    );
  });
});
