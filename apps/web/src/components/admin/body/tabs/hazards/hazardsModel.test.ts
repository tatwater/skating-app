import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dayX, lastReal } from '@/components/kit/day-strips';
import { FIELD_LEVELS, featureGlyph } from './featureGlyph';
import {
  BODY_NOW,
  dailyFrom,
  FEB_ARCHIVED,
  FEB_HAZARDS,
  FEB_NOW,
  LAST_WINTER_DAILY,
  MASCOMA_FEATURES,
  MASCOMA_MAP_DATA,
} from './hazardsFixtures';
import { hazardLit, hazardsMapScene, seasonOfLit, winterLit } from './hazardsMap';
import {
  ageWords,
  archivedRows,
  axisIndex,
  dailyClock,
  dayIndex,
  dayWords,
  drawnDay,
  featureRows,
  firstReports,
  hazardRows,
  lineSummary,
  monthTicks,
  seasonChoices,
  seasonWord,
  stripDays,
  type WinterLine,
  type Winters,
  wintersFrom,
  winterWindow,
} from './hazardsModel';
import { LAKE_CLAIM } from './hazardsWords';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('ageWords — since anyone last looked', () => {
  it('writes the board’s ages', () => {
    expect(ageWords(FEB_NOW - 26 * HOUR, FEB_NOW)).toBe('1 d');
    expect(ageWords(FEB_NOW - 20.5 * HOUR, FEB_NOW)).toBe('20 h');
    expect(ageWords(FEB_NOW - 194 * HOUR, FEB_NOW)).toBe('8 d');
    expect(ageWords(FEB_NOW - 59 * 60_000, FEB_NOW)).toBe('< 1 h');
    // A seen-at in the future reads as just now, never negative.
    expect(ageWords(FEB_NOW + DAY, FEB_NOW)).toBe('< 1 h');
  });

  it('never rounds an age down to fresher than it is, and never past the next unit', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 * DAY }), (ms) => {
        const words = ageWords(0, ms);
        const m = /^(\d+) (h|d)$/.exec(words);
        if (ms < HOUR) {
          expect(words).toBe('< 1 h');
          return;
        }
        expect(m).not.toBeNull();
        const n = Number(m?.[1]);
        const unit = m?.[2] === 'h' ? HOUR : DAY;
        // Floor: the stated age is at most the real one, and within one unit of it.
        expect(n * unit).toBeLessThanOrEqual(ms);
        expect((n + 1) * unit).toBeGreaterThan(ms);
        // Hours only under a day.
        expect(m?.[2] === 'h').toBe(ms < DAY);
      }),
    );
  });

  it('is monotone: an older sighting never reads younger', () => {
    const rank = (w: string) => {
      if (w === '< 1 h') return 0;
      const [n, u] = w.split(' ');
      return Number(n) * (u === 'd' ? 24 : 1);
    };
    fc.assert(
      fc.property(fc.nat(300 * DAY), fc.nat(300 * DAY), (a, b) => {
        const [young, old] = a <= b ? [a, b] : [b, a];
        expect(rank(ageWords(0, young))).toBeLessThanOrEqual(rank(ageWords(0, old)));
      }),
    );
  });
});

describe('hazard rows', () => {
  it('draws every hazard, stale included, with its state in words', () => {
    const rows = hazardRows(FEB_HAZARDS, FEB_NOW);
    expect(rows.map((r) => [r.type, r.state, r.place, r.sub, r.age, r.gone])).toEqual([
      ['Pressure ridge', 'fresh', 'Black Point to Wood Island', '3 “still there”', '1 d', 0],
      [
        'Wet / working crack',
        'aging',
        'Across the north end',
        '1 “still there” · “Healing — still unsafe”',
        '3 d',
        0,
      ],
      ['Thin ice', 'fresh', 'Off Lower Shaker Village', '1 “still there”', '20 h', 1],
      ['Overflow / slush', 'stale', 'Off Mascoma Lake Campground', '1 “still there”', '8 d', 0],
      ['Air pockets', 'unconfirmed', 'East of Relham Island', 'No other sighting', '4 h', 0],
    ]);
    expect(rows[1]?.healing).toBe(true);
    expect(rows.every((r) => r.goneOf === 2)).toBe(true);
  });

  it('only “healing, still unsafe” is amber', () => {
    const [none, disputed] = hazardRows(
      [
        { ...(FEB_HAZARDS[0] as (typeof FEB_HAZARDS)[number]), healingState: 'none' },
        { ...(FEB_HAZARDS[0] as (typeof FEB_HAZARDS)[number]), healingState: 'disputed' },
      ],
      FEB_NOW,
    );
    expect([none?.healing, disputed?.healing]).toEqual([false, false]);
  });

  it('quotes the whole healing verdict, never a bare “healing”, and a crossing’s own words', () => {
    const base = FEB_HAZARDS[0] as (typeof FEB_HAZARDS)[number];
    const [ridge, crossing] = hazardRows(
      [
        { ...base, healingState: 'healing_unsafe' },
        { ...base, type: 'ridge_crossing', healingState: 'healing_unsafe' },
      ],
      FEB_NOW,
    );
    expect(ridge?.sub).toContain('“Healing — still unsafe”');
    expect(crossing?.sub).toContain('“Crossing looks dicey now”');
  });

  it('a stale or unconfirmed hazard is never dropped', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            freshness: fc.constantFrom('fresh', 'aging', 'stale'),
            provisional: fc.boolean(),
            lastConfirmedAt: fc.integer({ min: 0, max: FEB_NOW }),
            goneCount: fc.nat(5),
          }),
          { maxLength: 20 },
        ),
        (hs) => {
          const input = hs.map((h, i) => ({
            ...(FEB_HAZARDS[0] as (typeof FEB_HAZARDS)[number]),
            ...h,
            _id: `h${i}`,
          }));
          const rows = hazardRows(input, FEB_NOW);
          expect(rows.map((r) => r.id)).toEqual(input.map((h) => h._id));
          // The gone squares never overflow their two slots.
          for (const r of rows) expect(r.gone).toBeLessThanOrEqual(r.goneOf);
        },
      ),
    );
  });

  it('archived rows say when anyone last saw them, never that the ice cleared', () => {
    expect(archivedRows([...FEB_HAZARDS, ...FEB_ARCHIVED])).toEqual([
      {
        id: 'h-inlet',
        type: 'Spring / inlet-outlet current',
        place: 'Mascoma River inlet',
        lastSeen: '9 Feb',
      },
      {
        id: 'h-launch',
        type: 'Open water / lead',
        place: 'Off the Boat Launch',
        lastSeen: '26 Jan',
      },
    ]);
  });
});

describe('known features', () => {
  it('say what, where, the shape and where it came from', () => {
    expect(featureRows(MASCOMA_FEATURES)).toEqual([
      {
        id: 'f-spring',
        type: 'Spring / current',
        place: 'Mascoma River inlet',
        sub: 'Point, 60 m · From a pin, 21 Jan 2026',
      },
      {
        id: 'f-narrows',
        type: 'Bridge narrows',
        place: 'Shaker Bridge',
        sub: 'Line, 40 m band · Drawn 18 Nov 2025',
      },
    ]);
    const bare = featureRows([
      { _id: 'x', type: 'mystery', geometryKind: 'polygon', geometry: null, createdAt: 0 },
    ])[0];
    expect(bare?.type).toBe('mystery');
    expect(bare?.place).toBeNull();
    expect(bare?.sub.startsWith('Area · Drawn')).toBe(true);
  });

  it('a glyph is the footprint’s own cells, brightest deepest inside, within its grid', () => {
    const square: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [0.001, 0],
          [0.001, 0.001],
          [0, 0.001],
          [0, 0],
        ],
      ],
    };
    const g = featureGlyph(square);
    expect(g.cells.length).toBeGreaterThan(0);
    for (const c of g.cells) {
      expect(c.col).toBeLessThan(g.cols);
      expect(c.row).toBeLessThan(g.rows);
      expect(FIELD_LEVELS).toContain(c.level);
    }
    // The middle is at the top level; a corner at the lowest.
    const mid = g.cells.find(
      (c) => c.col === Math.floor(g.cols / 2) && c.row === Math.floor(g.rows / 2),
    );
    expect(mid?.level).toBe(1);
    expect(g.cells.find((c) => c.col === 0 && c.row === 0)?.level).toBe(0.24);
  });
});

describe('the winters, a bar per day', () => {
  it('runs the whole season, 1 July to 1 July, UTC — the read’s own window', () => {
    expect(winterWindow(2026)).toEqual({ start: Date.UTC(2026, 6, 1), days: 365 });
    // Every month ticked; the quarters named, so twelve labels never crowd the strip.
    expect(monthTicks(2026).map((m) => [m.at, m.label])).toEqual([
      [0, 'JUL'],
      [31, ''],
      [62, ''],
      [92, 'OCT'],
      [123, ''],
      [153, ''],
      [184, 'JAN'],
      [215, ''],
      [243, ''],
      [274, 'APR'],
      [304, ''],
      [335, ''],
    ]);
  });

  it('buckets every instant into the UTC day it falls on, and nothing outside the window', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2000, max: 2090 }),
        fc.integer({ min: -40 * DAY, max: 220 * DAY }),
        (season, off) => {
          const { start, days } = winterWindow(season);
          const at = start + off;
          const i = dayIndex(at, season);
          if (off < 0 || off >= days * DAY) {
            expect(i).toBeNull();
            return;
          }
          expect(i).not.toBeNull();
          const d = new Date(at);
          expect(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toBe(
            start + (i as number) * DAY,
          );
        },
      ),
    );
  });

  it('a day that hasn’t happened is null, never zero; a counted day keeps both its parts', () => {
    const now = Date.UTC(2026, 9, 14, 16);
    const days = stripDays(
      { season: 2026, days: [{ at: Date.UTC(2026, 9, 5, 3), count: 2, unknown: 1 }] },
      now,
    );
    const at = (m: number, d: number) => dayIndex(Date.UTC(2026, m, d), 2026) as number;
    // From 1 July to today every day is real; 5 October holds its count; after today, nothing.
    expect(days.slice(0, at(9, 5)).every((d) => d?.count === 0 && d.unknown === 0)).toBe(true);
    expect(days[at(9, 5)]).toEqual({ count: 2, unknown: 1, reported: 0 });
    expect(days.slice(at(9, 6), at(9, 15)).every((d) => d?.count === 0)).toBe(true);
    expect(days.slice(at(9, 15)).every((d) => d === null)).toBe(true);
    // Last winter, whole: every day real, the archived ones unknown to the winter's end.
    const last = stripDays(LAST_WINTER_DAILY, BODY_NOW);
    expect(last.every((d) => d !== null)).toBe(true);
    expect(last.at(-1)).toEqual({ count: 2, unknown: 8, reported: 0 });
  });

  it('never drops a day the read holds, even one past this clock’s today', () => {
    const now = Date.UTC(2026, 9, 14, 16);
    const days = stripDays(
      { season: 2026, days: [{ at: Date.UTC(2026, 11, 1), count: 3, unknown: 0 }] },
      now,
    );
    expect(days[dayIndex(Date.UTC(2026, 11, 1), 2026) as number]).toEqual({
      count: 3,
      unknown: 0,
      reported: 0,
    });
    // Out of the season is out (June belongs to the season before).
    expect(
      stripDays({ season: 2026, days: [{ at: Date.UTC(2026, 5, 1), count: 3, unknown: 0 }] }, now)
        .flatMap((d) => (d === null ? [] : [d.count]))
        .every((c) => c === 0),
    ).toBe(true);
  });

  it('every day the read holds keeps at least its count and its unknown (fast-check)', () => {
    const season = 2026;
    const { start, days } = winterWindow(season);
    const entry = fc.record({
      day: fc.integer({ min: 0, max: days - 1 }),
      offset: fc.integer({ min: 0, max: DAY - 1 }),
      count: fc.nat(40),
      unknown: fc.nat(40),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(entry, { selector: (e) => e.day, maxLength: 60 }),
        fc.integer({ min: start - 30 * DAY, max: start + 200 * DAY }),
        (entries, now) => {
          const read = {
            season,
            days: entries.map((e) => ({
              at: start + e.day * DAY + e.offset,
              count: e.count,
              unknown: e.unknown,
            })),
          };
          const drawn = stripDays(read, now);
          for (const e of entries) {
            const d = drawn[e.day];
            expect(d).not.toBeNull();
            expect(d?.count).toBeGreaterThanOrEqual(e.count);
            expect(d?.unknown).toBeGreaterThanOrEqual(e.unknown);
          }
        },
      ),
    );
  });
});

describe('the day-by-day read’s clock', () => {
  it('is the start of the UTC day, which the server counts whole (fast-check)', () => {
    const { start, days } = winterWindow(2025);
    const end = start + days * DAY;
    fc.assert(
      fc.property(fc.integer({ min: start, max: end - 1 }), (at) => {
        const hour = Math.floor(at / HOUR) * HOUR;
        // No end-of-hour workaround: the server counts through the whole of the clock's UTC day.
        expect(dailyClock(2025, hour)).toBe(Math.floor(hour / DAY) * DAY);
        expect(Math.floor(dailyClock(2025, hour) / DAY)).toBe(Math.floor(at / DAY));
      }),
    );
  });

  it('a winter that is over keeps one clock, its end', () => {
    const { start, days } = winterWindow(2024);
    const end = start + days * DAY;
    expect(dailyClock(2024, end + 5 * HOUR)).toBe(end);
    expect(dailyClock(2024, end + 400 * DAY)).toBe(end);
    // Before its window opens, that day.
    expect(dailyClock(2024, start - 10 * DAY + 5 * HOUR)).toBe(start - 10 * DAY);
  });
});

describe('a day in words', () => {
  it('reads the board’s days', () => {
    expect(dayWords(null, false)).toBe('Not yet');
    expect(dayWords({ count: 0, unknown: 0, reported: 0 }, false)).toBe('No hazard reports');
    expect(dayWords({ count: 3, unknown: 0, reported: 0 }, false)).toBe('3 reported on the lake');
    expect(dayWords({ count: 3, unknown: 2, reported: 0 }, false)).toBe(
      'At least 3 reported on the lake, 2 unknown',
    );
    expect(dayWords({ count: 0, unknown: 2, reported: 0 }, false)).toBe(
      '2 unknown: archived, may still have been on the lake',
    );
    expect(dayWords({ count: 3, unknown: 0, reported: 0 }, true)).toBe(
      'At least 3 reported on the lake',
    );
    expect(dayWords({ count: 0, unknown: 0, reported: 0 }, true)).toBe(
      'No reports counted; the count stopped short',
    );
    // A mark's hazard was first reported that day: never ended, never gone after it.
    expect(dayWords({ count: 2, unknown: 3, reported: 1 }, false)).toBe(
      'At least 2 reported on the lake, 1 first reported this day, 3 unknown',
    );
    expect(dayWords({ count: 1, unknown: 0, reported: 1 }, false)).toBe(
      '1 reported on the lake, 1 first reported this day',
    );
    // A first report the count doesn't hold is still said: never fewer than drawn.
    expect(dayWords({ count: 0, unknown: 0, reported: 2 }, false)).toBe(
      '2 reported on the lake, 2 first reported this day',
    );
  });

  it('a marked day says reported, never ended, and still names its unknown (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.nat(200),
        fc.nat(200),
        fc.integer({ min: 1, max: 50 }),
        fc.boolean(),
        (count, unknown, reported, capped) => {
          const words = dayWords({ count, unknown, reported }, capped);
          expect(words).toContain(`${reported} first reported this day`);
          expect(words).not.toMatch(/\bend(ed|s)?\b/i);
          expect(words).not.toMatch(LAKE_CLAIM);
          if (unknown > 0) expect(words).toContain(`${unknown} unknown`);
          const numbers = (words.match(/\d+/g) ?? []).map(Number);
          expect(numbers[0]).toBe(Math.max(count, reported));
        },
      ),
    );
  });

  it('never claims fewer than the count, and names any unknown (fast-check)', () => {
    fc.assert(
      fc.property(fc.nat(1000), fc.nat(1000), fc.boolean(), (count, unknown, capped) => {
        const words = dayWords({ count, unknown, reported: 0 }, capped);
        const numbers = (words.match(/\d+/g) ?? []).map(Number);
        // The first number is the known count whenever there is one; nothing reads as clear.
        if (count > 0) expect(numbers[0]).toBe(count);
        if (count > 0 && (unknown > 0 || capped)) expect(words).toMatch(/^At least /);
        if (unknown > 0) {
          expect(words).toContain(`${unknown} unknown`);
          expect(words).not.toMatch(/None/i);
        }
        expect(words).not.toMatch(LAKE_CLAIM);
      }),
    );
  });
});

describe('the winters as the tab draws them', () => {
  it('a new season before 1 October is an honestly empty record from 1 July, never a gap', () => {
    const now = Date.UTC(2026, 7, 20, 15);
    const w = wintersFrom(
      [{ season: 2026, days: [], unknownEnds: 0, hazards: [], capped: false, watchOpensOn: null }],
      now,
    );
    const today = dayIndex(now, 2026) as number;
    // The season began on 1 July: its record runs from there to today, each day real and empty.
    expect(w?.today).toBe(today);
    expect(w?.lines[0]?.days.slice(0, today + 1).every((d) => d?.count === 0)).toBe(true);
    expect(w?.lines[0]?.days.slice(today + 1).every((d) => d === null)).toBe(true);
    expect(w && lineSummary(w.lines[0] as WinterLine)).toBe('No hazard reports');
  });

  it('draws a season that hasn’t begun as days not yet, never zeros', () => {
    const w = wintersFrom(
      [{ season: 2026, days: [], unknownEnds: 0, hazards: [], capped: false, watchOpensOn: null }],
      Date.UTC(2026, 5, 20),
    );
    expect(w?.today).toBeNull();
    expect(w?.lines[0]?.days.every((d) => d === null)).toBe(true);
  });

  it('marks today and the watch’s opening, and carries each strip’s floor and missing ends', () => {
    const w = wintersFrom(
      [
        {
          season: 2026,
          days: [{ at: Date.UTC(2026, 9, 5), count: 1, unknown: 0 }],
          unknownEnds: 0,
          hazards: [],
          capped: true,
          watchOpensOn: Date.UTC(2026, 9, 3),
        },
        LAST_WINTER_DAILY,
      ],
      Date.UTC(2026, 9, 14, 16),
    );
    expect(w?.today).toBe(dayIndex(Date.UTC(2026, 9, 14), 2026));
    expect(w?.opens).toBe(dayIndex(Date.UTC(2026, 9, 3), 2026));
    expect(w?.lines.map((l) => [l.season, l.capped, l.unknownEnds])).toEqual([
      [2026, true, 0],
      [2025, false, 8],
    ]);
    expect(lineSummary(w?.lines[0] as WinterLine)).toBe('1 day with hazard reports; each a floor');
    expect(lineSummary(w?.lines[1] as WinterLine)).toMatch(
      /^\d+ days with hazard reports, 8 first reports with no recorded end, \d+ with some unknown$/,
    );
    expect(wintersFrom([], 0)).toBeNull();
  });

  it('lines up leap and common seasons date for date, on one axis of 1 Jul to 30 Jun', () => {
    const DAYMS = 86_400_000;
    // A date in a season (1 Jul – 30 Jun), as the day after 1 July it falls on.
    const winterDay = (season: number, offset: number) => Date.UTC(season, 6, 1) + offset * DAYMS;
    fc.assert(
      fc.property(
        fc.integer({ min: 2000, max: 2090 }),
        fc.integer({ min: 0, max: 364 }),
        fc.integer({ min: 1, max: 9 }),
        (season, offset, count) => {
          const at = winterDay(season, offset);
          const date = new Date(at);
          // The same calendar date in the winter before (when it has one: 29 February may not).
          const before = Date.UTC(
            season - 1 + (date.getUTCMonth() < 6 ? 1 : 0),
            date.getUTCMonth(),
            date.getUTCDate(),
          );
          const sameDate = new Date(before).getUTCDate() === date.getUTCDate();
          const w = wintersFrom(
            [
              {
                season,
                days: [{ at, count, unknown: 0 }],
                unknownEnds: 0,
                hazards: [],
                capped: false,
                watchOpensOn: null,
              },
              {
                season: season - 1,
                days: sameDate ? [{ at: before, count, unknown: 0 }] : [],
                unknownEnds: 0,
                hazards: [],
                capped: false,
                watchOpensOn: null,
              },
            ],
            Date.UTC(season + 1, 6, 1),
          );
          if (w === null) throw new Error('no winters');
          // One axis for both, whichever holds a 29 February.
          for (const line of w.lines) expect(line.days).toHaveLength(w.days);
          const here = w.lines[0]?.days.findIndex((d) => d !== null && d.count > 0);
          // Nothing dropped: the day's count is on the axis.
          expect(w.lines[0]?.days[here as number]?.count).toBe(count);
          if (sameDate) {
            const there = w.lines[1]?.days.findIndex((d) => d !== null && d.count > 0);
            expect(there).toBe(here);
          }
          // The month ticks fall on the 1st of each month in either season.
          if (date.getUTCDate() === 1) expect(w.months.some((m) => m.at === here)).toBe(true);
        },
      ),
    );
    // 30 June is the axis's last day in a leap season and a common one alike.
    for (const season of [2023, 2025]) {
      const w = wintersFrom(
        [
          {
            season,
            days: [{ at: Date.UTC(season + 1, 5, 30), count: 1, unknown: 0 }],
            unknownEnds: 0,
            hazards: [],
            capped: false,
            watchOpensOn: null,
          },
        ],
        Date.UTC(season + 1, 6, 1),
      );
      expect(w?.lines[0]?.days.at(-1)).toEqual({ count: 1, unknown: 0, reported: 0 });
    }
  });

  it('a past winter has no today and no beginning ahead', () => {
    const w = wintersFrom([LAST_WINTER_DAILY], Date.UTC(2026, 9, 14, 16));
    expect(w?.today).toBeNull();
    expect(w?.opens).toBeNull();
  });

  it('the strip’s ink stops at the last real day; x runs left to right', () => {
    expect(lastReal([0, 1, null, null])).toBe(1);
    expect(lastReal([null])).toBe(-1);
    fc.assert(
      fc.property(fc.nat(500), fc.nat(500), fc.integer({ min: 1, max: 500 }), (a, b, n) => {
        if (a <= b) expect(dayX(a, n)).toBeLessThanOrEqual(dayX(b, n));
      }),
    );
    expect(dayX(3, 0)).toBe(dayX(0, 0));
  });
});

describe('first-report marks — from the read’s own hazards', () => {
  const season = 2025;
  const { start, days } = winterWindow(season);

  it('marks each archived hazard with no recorded end once, on its first-report day; an ended or active one never', () => {
    const day = (n: number) => start + n * DAY + 5 * HOUR;
    const read = dailyFrom(
      season,
      [
        { first: day(3), active: false },
        { first: day(3), active: false },
        { first: day(3), active: true },
        { first: day(9), active: false, ended: day(12) },
        // First reported in September: on the strip, a mark in September.
        { first: Date.UTC(2025, 8, 12, 5), active: false },
      ],
      Date.UTC(2026, 6, 1),
    );
    const marks = firstReports(read, Date.UTC(2026, 6, 1));
    expect(marks).toHaveLength(days);
    expect(marks[3]).toBe(2);
    expect(marks[dayIndex(Date.UTC(2025, 8, 12), season) as number]).toBe(1);
    expect(marks.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('a hazard first reported today is a bar until the day after says whether it is still there', () => {
    const now = start + 40 * DAY + 10 * HOUR;
    const read = dailyFrom(season, [{ first: now - HOUR, active: false }], now);
    expect(firstReports(read, now).reduce((a, b) => a + b, 0)).toBe(0);
    const line = (wintersFrom([read], now) as Winters).lines[0] as WinterLine;
    expect(line.days[40]).toMatchObject({ count: 1, reported: 0 });
  });

  it('every winter is marked from its own read — last winter beside this one too', () => {
    const w = wintersFrom([LAST_WINTER_DAILY], BODY_NOW);
    const line = w?.lines[0] as WinterLine;
    const total = line.days.reduce((n, d) => n + (d === null ? 0 : drawnDay(d).marks), 0);
    expect(total).toBe(LAST_WINTER_DAILY.unknownEnds);
    expect(lineSummary(line)).toMatch(
      /8 first reports with no recorded end, \d+ with some unknown$/,
    );
  });

  it('a hazard with a recorded end is bars for its days on the lake, and no mark (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: days - 40 }),
        fc.integer({ min: 0, max: 30 }),
        (first, length) => {
          const at = start + first * DAY + 5 * HOUR;
          const read = dailyFrom(
            season,
            [{ first: at, active: false, ended: at + length * DAY }],
            Date.UTC(2026, 6, 1),
          );
          const line = (wintersFrom([read], Date.UTC(2026, 6, 1)) as Winters)
            .lines[0] as WinterLine;
          const drawn = line.days.map((d) => (d === null ? { bars: 0, marks: 0 } : drawnDay(d)));
          expect(drawn.reduce((n, d) => n + d.marks, 0)).toBe(0);
          expect(drawn.reduce((n, d) => n + d.bars, 0)).toBe(length + 1);
        },
      ),
    );
  });

  it('every hazard with no recorded end yields exactly one mark, on its first-report day, and no day draws fewer than the count (fast-check)', () => {
    const entry = fc.record({
      day: fc.integer({ min: 0, max: days - 1 }),
      hour: fc.integer({ min: 0, max: 23 }),
      kind: fc.constantFrom('active', 'unended', 'ended'),
    });
    fc.assert(
      fc.property(
        fc.array(entry, { maxLength: 40 }),
        fc.integer({ min: start, max: start + (days + 20) * DAY }),
        (entries, now) => {
          const seen = entries
            .map((e) => ({ ...e, first: start + e.day * DAY + e.hour * HOUR }))
            .filter((e) => e.first < now);
          const read = dailyFrom(
            season,
            seen.map((e) => ({
              first: e.first,
              active: e.kind === 'active',
              ...(e.kind === 'ended' ? { ended: e.first + 2 * DAY } : {}),
            })),
            now,
          );
          const line = (wintersFrom([read], now) as Winters).lines[0] as WinterLine;
          const expected = Array.from({ length: line.days.length }, () => 0);
          const today = Math.floor((now - start) / DAY);
          for (const e of seen) {
            // Reported on its own last day (today, or the season's last): a bar until the day after.
            if (e.kind !== 'unended' || e.day + 1 > today || e.day + 1 >= days) continue;
            const at = axisIndex(e.day, season);
            expected[at] = (expected[at] ?? 0) + 1;
          }
          line.days.forEach((d, i) => {
            expect(d === null ? 0 : drawnDay(d).marks).toBe(expected[i]);
            if (d === null) return;
            const { bars, marks } = drawnDay(d);
            expect(bars + marks).toBeGreaterThanOrEqual(d.count);
          });
        },
      ),
    );
  });
});

describe('seasons', () => {
  it('the bar is this winter and the two before; Earlier holds three more', () => {
    expect(seasonChoices(2026)).toEqual({ bar: [2026, 2025, 2024], earlier: [2023, 2022, 2021] });
    expect(seasonWord(2026)).toBe('2026–27');
    expect(seasonWord(2099)).toBe('2099–00');
  });
});

describe('the map', () => {
  it('draws every footprint on its layer, opens Hazards and Features, lights only its own', () => {
    const scene = hazardsMapScene(
      {
        season: 2025,
        current: 2025,
        hazards: [
          {
            _id: 'h-slush',
            geometryKind: 'point_radius',
            geometry: { type: 'Point', coordinates: [-72.1757, 43.644] },
            radiusMeters: 40,
            freshness: 'stale',
            provisional: false,
          },
        ],
        features: MASCOMA_MAP_DATA.features,
      },
      'hazard:h-slush',
    );
    expect(scene.layers).toEqual({ hazards: true, features: true });
    expect(scene.items.map((i) => [i.id, i.layer, i.kind])).toEqual([
      ['feature:f-spring', 'features', 'outline'],
      ['feature:f-narrows', 'features', 'outline'],
      ['hazard:h-slush', 'hazards', 'outline'],
    ]);
    // A stale hazard still draws — faded by its field, never gone.
    expect((scene.items[2] as unknown as { field: unknown }).field).toEqual({
      freshness: 'stale',
      tone: 'hazard',
      provisional: false,
    });
    expect((scene.items[0] as unknown as { field: unknown }).field).toEqual({
      freshness: 'known',
      tone: 'hazard',
      provisional: false,
    });
    expect(scene.lit).toBe('hazard:h-slush');
    expect(hazardsMapScene(MASCOMA_MAP_DATA, 'bay:x').lit).toBeNull();
  });

  it('a stored clip wins; a shape that can’t be grown draws nowhere, never somewhere wrong', () => {
    const clip: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    };
    const scene = hazardsMapScene(
      {
        season: 2025,
        current: 2025,
        hazards: [],
        features: [
          { _id: 'a', geometryKind: 'polygon', geometry: null, clippedFootprint: clip },
          { _id: 'b', geometryKind: 'line', geometry: { type: 'Bogus' } },
        ],
      },
      null,
    );
    expect(scene.items.map((i) => i.id)).toEqual(['feature:a']);
    expect((scene.items[0] as { geometry: unknown }).geometry).toBe(clip);
  });
});

describe('the winter in the lit address', () => {
  const NOW = 2025;
  it('opens on the current winter, and a past one only by choosing it', () => {
    expect(seasonOfLit(null, NOW)).toBe(NOW);
    expect(seasonOfLit('feature:f1', NOW)).toBe(NOW);
    expect(seasonOfLit('hazard:h1', NOW)).toBe(NOW);
    expect(seasonOfLit('winter:2023', NOW)).toBe(2023);
    expect(seasonOfLit('hazard:2023.h1', NOW)).toBe(2023);
    // A winter that hasn't come is no winter: the current one.
    expect(seasonOfLit('winter:2031', NOW)).toBe(NOW);
    expect(seasonOfLit('winter:23', NOW)).toBe(NOW);
    // A feature lit in a past winter keeps that winter.
    expect(seasonOfLit('feature:2023.f1', NOW)).toBe(2023);
    // A year the server won't browse (it would answer with this season) is now.
    expect(seasonOfLit('winter:1000', NOW)).toBe(NOW);
    expect(seasonOfLit('hazard:1899.h1', NOW)).toBe(NOW);
  });

  it('keeps a past winter through lighting a hazard and clearing it', () => {
    expect(winterLit(NOW, NOW)).toBeNull();
    expect(winterLit(2023, NOW)).toBe('winter:2023');
    expect(hazardLit('h1', NOW, NOW)).toBe('hazard:h1');
    expect(hazardLit('h1', 2023, NOW)).toBe('hazard:2023.h1');
    expect(seasonOfLit(hazardLit('h1', 2023, NOW), NOW)).toBe(2023);
    expect(seasonOfLit(winterLit(2023, NOW), NOW)).toBe(2023);
  });

  it('draws a past winter’s hazards under their winter’s addresses', () => {
    const scene = hazardsMapScene(
      {
        season: 2023,
        current: NOW,
        hazards: [
          {
            _id: 'h1',
            geometryKind: 'point_radius',
            geometry: { type: 'Point', coordinates: [-72.15, 43.63] },
            radiusMeters: 40,
            freshness: 'stale',
            provisional: true,
          },
        ],
        features: [],
      },
      'hazard:2023.h1',
    );
    expect(scene.lit).toBe('hazard:2023.h1');
    expect(scene.items[0]).toMatchObject({
      id: 'hazard:2023.h1',
      field: { freshness: 'stale', provisional: true },
    });
  });
});
