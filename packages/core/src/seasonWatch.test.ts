import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDaysIso, ingestWindow, type SiteSeries } from './ingestGate';
import {
  celsiusToFahrenheit,
  clipToFloor,
  DEFAULT_SEASON_WATCH_SETTINGS,
  daysBetween,
  durationInWords,
  EARLIEST_START_MONTH_DAY,
  evaluateSeason,
  expandLows,
  fahrenheitToCelsius,
  firstNightAtOrBelow,
  firstSentinelNightAtOrBelow,
  formatLow,
  IMAGERY_NUDGE_F,
  mergeLows,
  type SeasonWatchSettings,
  seasonFloorDate,
  seasonStartYear,
  validateSeasonWatchSettings,
} from './seasonWatch';

/** `lows` from `start`, one per day; `null` leaves a gap in the series. */
function series(
  siteId: string,
  start: string,
  lows: (number | null)[],
  sentinel?: boolean,
): SiteSeries {
  return {
    siteId,
    ...(sentinel ? { sentinel: true } : {}),
    days: lows.flatMap((minTempC, i) =>
      minTempC === null ? [] : [{ date: addDaysIso(start, i), minTempC }],
    ),
  };
}

const warm = (n: number) => Array.from({ length: n }, () => 8);

describe('ingestWindow — what the opening night measured (A06i)', () => {
  it('names every sentinel that fired, coldest first, with its low', () => {
    // 3 October 2026 as it happened: two summits at or below freezing, one above, no valley lake.
    const window = ingestWindow([
      series('eagle', '2026-10-01', [9.1, 5.6, 0.0], true),
      series('clouds', '2026-10-01', [7.0, 3.5, -0.4], true),
      series('kinsman', '2026-10-01', [9.5, 6.3, 1.4], true),
      series('valley-a', '2026-10-01', [12, 12, 6]),
      series('valley-b', '2026-10-01', [13, 11, 7]),
    ]);
    expect(window.opensOn).toBe('2026-10-03');
    expect(window.openedBy).toEqual(['sentinel']);
    expect(window.opening).toEqual({
      sentinels: [
        { siteId: 'clouds', lowC: -0.4 },
        { siteId: 'eagle', lowC: 0 },
      ],
      corpus: { frozen: 0, reporting: 2 },
    });
    expect(window.winter).toBeNull();
  });

  it('reports the corpus count when the ordinary lakes open it', () => {
    const window = ingestWindow([
      series('a', '2026-11-01', [5, -1]),
      series('b', '2026-11-01', [6, 2]),
    ]);
    expect(window.opening).toEqual({ sentinels: [], corpus: { frozen: 1, reporting: 2 } });
  });

  it('lists the lakes that froze the night winter set in, out of those reporting', () => {
    const window = ingestWindow([
      series('a', '2026-11-01', [5, -1, -3]),
      series('b', '2026-11-01', [6, 2, -2]),
      series('c', '2026-11-01', [7, 3, 4]),
      series('d', '2026-11-01', [7, 3, null]),
    ]);
    expect(window.winterFrom).toBe('2026-11-03');
    expect(window.winter).toEqual({
      frozen: [
        { siteId: 'a', lowC: -3 },
        { siteId: 'b', lowC: -2 },
      ],
      reporting: 3,
    });
  });

  it('returns no detail when nothing opened', () => {
    const window = ingestWindow([series('a', '2026-11-01', warm(5))]);
    expect(window).toEqual({
      opensOn: null,
      winterFrom: null,
      closesOn: null,
      openedBy: [],
      opening: null,
      winter: null,
    });
  });
});

describe('ingestWindow — sentinelNights', () => {
  it('waits for the run at one sentinel, not a night here and a night there', () => {
    const sites = [
      series('clouds', '2026-10-01', [-1, 3, -1, -2, -3], true),
      series('eagle', '2026-10-01', [3, -1, 3, 3, 3], true),
      series('valley', '2026-10-01', warm(5)),
    ];
    expect(ingestWindow(sites).opensOn).toBe('2026-10-01');
    const strict = ingestWindow(sites, { sentinelNights: 3 });
    expect(strict.opensOn).toBe('2026-10-05');
    // The low reported is the night the run completed.
    expect(strict.opening?.sentinels).toEqual([{ siteId: 'clouds', lowC: -3 }]);
  });

  it('lets a missing night break the run rather than count as cold', () => {
    const sites = [series('clouds', '2026-10-01', [-1, null, -1, -1], true)];
    expect(ingestWindow(sites, { sentinelNights: 2 }).opensOn).toBe('2026-10-04');
    expect(ingestWindow(sites, { sentinelNights: 3 }).opensOn).toBeNull();
  });

  it('treats a nonsense run length as one night', () => {
    const sites = [series('clouds', '2026-10-01', [3, -1], true)];
    expect(ingestWindow(sites, { sentinelNights: 0 }).opensOn).toBe('2026-10-02');
  });

  const low = fc.oneof(
    fc.constant(null),
    fc.double({ min: -15, max: 15, noNaN: true }).map((n) => Math.round(n * 10) / 10),
  );
  const site = (id: string, sentinel: boolean) =>
    fc
      .array(low, { minLength: 1, maxLength: 40 })
      .map((lows) => series(id, '2026-10-01', lows, sentinel));
  const corpus = fc.tuple(
    fc
      .array(fc.constant(0), { maxLength: 3 })
      .chain((s) => fc.tuple(...s.map((_, i) => site(`sentinel-${i}`, true)))),
    fc
      .array(fc.constant(0), { minLength: 1, maxLength: 5 })
      .chain((s) => fc.tuple(...s.map((_, i) => site(`lake-${i}`, false)))),
  );

  it('never opens earlier under a stricter rule (property)', () => {
    // A tightened rule that opened the watch *sooner* would be a setting that does the opposite of
    // what its label says — the one mistake the preview exists to stop a person making.
    fc.assert(
      fc.property(corpus, fc.integer({ min: 1, max: 5 }), ([sentinels, lakes], nights) => {
        const sites = [...sentinels, ...lakes];
        const loose = ingestWindow(sites, { sentinelNights: nights }).opensOn;
        const strict = ingestWindow(sites, { sentinelNights: nights + 1 }).opensOn;
        if (strict !== null) expect(loose !== null && loose <= strict).toBe(true);
      }),
    );
  });

  it('reports only lows at or below the freezing line, coldest first (property)', () => {
    fc.assert(
      fc.property(
        corpus,
        fc.double({ min: -5, max: 2, noNaN: true }),
        ([sentinels, lakes], freezeC) => {
          const window = ingestWindow([...sentinels, ...lakes], { freezeC });
          const lows = window.opening?.sentinels.map((s) => s.lowC) ?? [];
          for (const l of lows) expect(l).toBeLessThanOrEqual(freezeC);
          expect([...lows].sort((a, b) => a - b)).toEqual(lows);
          if (window.winter) {
            expect(window.winter.frozen.length / window.winter.reporting).toBeGreaterThanOrEqual(
              0.5,
            );
          }
        },
      ),
    );
  });
});

describe('settings', () => {
  it('ships the defaults D149 shipped with', () => {
    expect(DEFAULT_SEASON_WATCH_SETTINGS).toMatchObject({
      startMonthDay: '10-01',
      freezeC: 0,
      sentinelNights: 1,
      corpusFraction: 0.1,
      winterFraction: 0.5,
      thawC: 0,
      thawRunDays: 10,
      sampleSize: 24,
    });
    expect(celsiusToFahrenheit(DEFAULT_SEASON_WATCH_SETTINGS.imageryNudgeC)).toBeCloseTo(
      IMAGERY_NUDGE_F,
      10,
    );
    expect(validateSeasonWatchSettings(DEFAULT_SEASON_WATCH_SETTINGS)).toEqual([]);
  });

  it('converts both ways', () => {
    expect(fahrenheitToCelsius(32)).toBe(0);
    expect(celsiusToFahrenheit(-40)).toBe(-40);
  });

  it.each([
    [{ startMonthDay: '06-30' }, 'between September and December'],
    // The history keeps lows from 1 September, so an August floor could not be previewed.
    [{ startMonthDay: '08-31' }, 'between September and December'],
    [{ startMonthDay: '11-31' }, 'not a real day'],
    [{ startMonthDay: 'Nov 1' }, 'between September and December'],
    [{ freezeC: 9 }, 'freezing line'],
    [{ freezeC: Number.NaN }, 'freezing line'],
    [{ sentinelNights: 1.5 }, 'Sentinel nights'],
    [{ sentinelNights: 0 }, 'Sentinel nights'],
    [{ corpusFraction: 0 }, 'opening share'],
    [{ winterFraction: 1.2 }, 'winter share'],
    [{ imageryNudgeC: 10 }, 'imagery line'],
    [{ thawC: 20 }, 'thaw line'],
    [{ thawRunDays: 0 }, 'Thawed nights'],
    [{ sampleSize: 100 }, 'sample'],
  ] as [Partial<SeasonWatchSettings>, string][])('refuses %o', (patch, message) => {
    const errors = validateSeasonWatchSettings({ ...DEFAULT_SEASON_WATCH_SETTINGS, ...patch });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(message);
  });

  it.each(['11-01', EARLIEST_START_MONTH_DAY])('accepts a %s floor', (startMonthDay) => {
    expect(
      validateSeasonWatchSettings({ ...DEFAULT_SEASON_WATCH_SETTINGS, startMonthDay }),
    ).toEqual([]);
  });
});

describe('durationInWords', () => {
  it('says minutes under two hours, hours from there', () => {
    expect(durationInWords(30 * 60_000)).toBe('30 minutes');
    expect(durationInWords(119 * 60_000)).toBe('119 minutes');
    expect(durationInWords(6 * 60 * 60_000)).toBe('6 hours');
    expect(durationInWords(-5)).toBe('0 minutes');
  });
});

describe('season labels and the floor', () => {
  it('reads the start year from a label', () => {
    expect(seasonStartYear('winter-2026-27')).toBe(2026);
    expect(seasonStartYear('winter-1999-00')).toBe(1999);
    expect(seasonFloorDate('winter-2026-27', '11-01')).toBe('2026-11-01');
  });

  it.each(['2026-27', 'winter-2026-28', 'winter-26-27'])('refuses %s', (label) => {
    expect(() => seasonStartYear(label)).toThrow(/not a season label/);
  });

  it('clips observations before the floor and drops emptied sites', () => {
    const clipped = clipToFloor(
      [series('a', '2026-09-29', [-5, -5, 3, 2]), series('b', '2026-09-28', [-1, -1])],
      '2026-10-01',
    );
    expect(clipped).toEqual([series('a', '2026-10-01', [3, 2])]);
  });
});

describe('first nights at or below a line', () => {
  it('finds the first qualifying night on or after `from`', () => {
    const s = series('clouds', '2026-10-01', [1, -7, 0, -8], true);
    expect(firstNightAtOrBelow(s, -6.5)).toEqual({ date: '2026-10-02', minTempC: -7 });
    expect(firstNightAtOrBelow(s, -6.5, '2026-10-03')).toEqual({
      date: '2026-10-04',
      minTempC: -8,
    });
    expect(firstNightAtOrBelow(s, -20)).toBeNull();
  });

  it('names every sentinel at the line on the first such night, and ignores ordinary lakes', () => {
    const night = firstSentinelNightAtOrBelow(
      [
        series('clouds', '2026-10-05', [-3, -7.1], true),
        series('eagle', '2026-10-05', [-2, -6.8], true),
        series('kinsman', '2026-10-05', [-1, -4], true),
        series('valley', '2026-10-05', [-9, -9]),
      ],
      fahrenheitToCelsius(20),
    );
    expect(night).toEqual({
      date: '2026-10-06',
      sites: [
        { siteId: 'clouds', lowC: -7.1 },
        { siteId: 'eagle', lowC: -6.8 },
      ],
    });
    expect(firstSentinelNightAtOrBelow([series('valley', '2026-10-05', [-9])], 0)).toBeNull();
  });

  it('orders a tie by id', () => {
    const night = firstSentinelNightAtOrBelow(
      [series('b', '2026-10-05', [-8], true), series('a', '2026-10-05', [-8], true)],
      -7,
    );
    expect(night?.sites.map((s) => s.siteId)).toEqual(['a', 'b']);
  });
});

describe('evaluateSeason — the function the cron and the preview share', () => {
  const sites = [
    // The summit dips in late September, freezes on 3 October and reaches 19 °F on the 6th.
    series('clouds', '2026-09-28', [-2, 3, 4, 7, 3.5, -0.4, -0.2, -3.7, -7.1], true),
    series('valley-a', '2026-09-28', warm(9)),
    series('valley-b', '2026-09-28', warm(9)),
  ];

  it('applies the floor, then the rules, then the imagery line', () => {
    const result = evaluateSeason(sites, DEFAULT_SEASON_WATCH_SETTINGS, 'winter-2026-27');
    expect(result.floor).toBe('2026-10-01');
    expect(result.opensOn).toBe('2026-10-03');
    expect(result.imageryNudge).toEqual({
      date: '2026-10-06',
      sites: [{ siteId: 'clouds', lowC: -7.1 }],
    });
  });

  it('postpones under a later floor, and finds nothing when the floor passes the data', () => {
    const later = evaluateSeason(
      sites,
      { ...DEFAULT_SEASON_WATCH_SETTINGS, startMonthDay: '10-05' },
      'winter-2026-27',
    );
    expect(later.opensOn).toBe('2026-10-05');
    const november = evaluateSeason(
      sites,
      { ...DEFAULT_SEASON_WATCH_SETTINGS, startMonthDay: '11-01' },
      'winter-2026-27',
    );
    expect(november.opensOn).toBeNull();
    expect(november.imageryNudge).toBeNull();
  });

  it('never nudges before the watch opens', () => {
    // A single 20 °F night that does not complete a three-night run.
    const dip = [series('clouds', '2026-10-01', [5, -8, 5, -1, -1, -1], true)];
    const result = evaluateSeason(
      dip,
      { ...DEFAULT_SEASON_WATCH_SETTINGS, sentinelNights: 3 },
      'winter-2026-27',
    );
    expect(result.opensOn).toBe('2026-10-06');
    expect(result.imageryNudge).toBeNull();
  });
});

describe('compact lows', () => {
  it('expands, skipping gaps', () => {
    expect(expandLows({ firstDate: '2026-10-30', lows: [1, null, -2] })).toEqual([
      { date: '2026-10-30', minTempC: 1 },
      { date: '2026-11-01', minTempC: -2 },
    ]);
  });

  it('merges a refetch over stored nights, keeping what was not refetched', () => {
    const stored = { firstDate: '2026-10-01', lows: [1, 2, 3] };
    expect(
      mergeLows(stored, [
        { date: '2026-10-03', minTempC: -3 },
        { date: '2026-10-05', minTempC: -5 },
      ]),
    ).toEqual({ firstDate: '2026-10-01', lows: [1, 2, -3, null, -5] });
    expect(mergeLows(null, [])).toEqual({ firstDate: '', lows: [] });
    expect(mergeLows({ firstDate: '2026-10-01', lows: [] }, [])).toEqual({
      firstDate: '2026-10-01',
      lows: [],
    });
  });

  it('round-trips: merging a series into nothing expands back to it (property)', () => {
    const day = fc
      .tuple(fc.integer({ min: 0, max: 300 }), fc.double({ min: -30, max: 30, noNaN: true }))
      .map(([offset, minTempC]) => ({ date: addDaysIso('2026-07-01', offset), minTempC }));
    fc.assert(
      fc.property(fc.uniqueArray(day, { selector: (d) => d.date, maxLength: 60 }), (days) => {
        const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
        expect(expandLows(mergeLows(null, days))).toEqual(sorted);
      }),
    );
  });

  it('counts days between labels', () => {
    expect(daysBetween('2026-10-03', '2026-10-19')).toBe(16);
    expect(daysBetween('2027-03-10', '2027-03-15')).toBe(5);
  });
});

describe('formatLow', () => {
  it.each([
    [-0.4, '31.3°F (−0.4°C)'],
    [0, '32.0°F (0.0°C)'],
    [-0.04, '31.9°F (0.0°C)'],
    [-7.1, '19.2°F (−7.1°C)'],
    [-20, '−4.0°F (−20.0°C)'],
  ])('%d °C reads %s', (c, text) => {
    expect(formatLow(c)).toBe(text);
  });
});
