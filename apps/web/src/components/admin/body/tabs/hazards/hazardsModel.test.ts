import { seasonOf } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dayX, lastReal } from '@/components/kit/day-strips';
import { FIELD_LEVELS, featureGlyph } from './featureGlyph';
import {
  BODY_NOW,
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
  dailyClock,
  dayIndex,
  dayWords,
  featureRows,
  hazardRows,
  isCurrent,
  lineSummary,
  monthTicks,
  seasonChoices,
  seasonWord,
  stripDays,
  type WinterLine,
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
        '1 “still there” · “healing”',
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
  it('runs 1 October to 1 April, UTC', () => {
    expect(winterWindow(2026)).toEqual({ start: Date.UTC(2026, 9, 1), days: 182 });
    expect(monthTicks(2026).map((m) => [m.at, m.label])).toEqual([
      [0, 'OCT'],
      [31, 'NOV'],
      [61, 'DEC'],
      [92, 'JAN'],
      [123, 'FEB'],
      [151, 'MAR'],
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
    const none = { count: 0, unknown: 0 };
    expect(days.slice(0, 5)).toEqual([none, none, none, none, { count: 2, unknown: 1 }]);
    expect(days.slice(5, 14).every((d) => d?.count === 0 && d.unknown === 0)).toBe(true);
    expect(days.slice(14).every((d) => d === null)).toBe(true);
    // Last winter, whole: every day real, the archived ones unknown to the winter's end.
    const last = stripDays(LAST_WINTER_DAILY, BODY_NOW);
    expect(last.every((d) => d !== null)).toBe(true);
    expect(last.at(-1)).toEqual({ count: 2, unknown: 8 });
  });

  it('never drops a day the read holds, even one past this clock’s today', () => {
    const now = Date.UTC(2026, 9, 14, 16);
    const days = stripDays(
      { season: 2026, days: [{ at: Date.UTC(2026, 11, 1), count: 3, unknown: 0 }] },
      now,
    );
    expect(days[61]).toEqual({ count: 3, unknown: 0 });
    // Out of the window is out.
    expect(
      stripDays({ season: 2026, days: [{ at: Date.UTC(2026, 8, 1), count: 3, unknown: 0 }] }, now)
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
  it('passes every instant of the hour, and its day is still today’s (fast-check)', () => {
    const { start, days } = winterWindow(2025);
    const end = start + days * DAY;
    fc.assert(
      fc.property(fc.integer({ min: start, max: end - 1 }), (at) => {
        const clock = dailyClock(2025, Math.floor(at / HOUR) * HOUR);
        // A hazard reported any time this hour counts, today included (the server's end is
        // exclusive) — even in a day's first hour.
        expect(clock).toBeGreaterThan(at);
        // And no day past today is ever asked for.
        expect(Math.floor((clock - 1) / DAY)).toBe(Math.floor(at / DAY));
      }),
    );
  });

  it('a winter that is over keeps one clock, its end', () => {
    const { start, days } = winterWindow(2024);
    const end = start + days * DAY;
    expect(dailyClock(2024, end + 5 * HOUR)).toBe(end);
    expect(dailyClock(2024, end + 400 * DAY)).toBe(end);
    // Before its window opens, the hour's end.
    expect(dailyClock(2024, start - 10 * DAY)).toBe(start - 10 * DAY + HOUR);
  });
});

describe('a day in words', () => {
  it('reads the board’s days', () => {
    expect(dayWords(null, false)).toBe('Not yet');
    expect(dayWords({ count: 0, unknown: 0 }, false)).toBe('No hazard reports');
    expect(dayWords({ count: 3, unknown: 0 }, false)).toBe('3 reported on the lake');
    expect(dayWords({ count: 3, unknown: 2 }, false)).toBe(
      'At least 3 reported on the lake, 2 unknown',
    );
    expect(dayWords({ count: 0, unknown: 2 }, false)).toBe(
      '2 unknown: archived, may still have been on the lake',
    );
    expect(dayWords({ count: 3, unknown: 0 }, true)).toBe('At least 3 reported on the lake');
    expect(dayWords({ count: 0, unknown: 0 }, true)).toBe(
      'No reports counted; the count stopped short',
    );
  });

  it('never claims fewer than the count, and names any unknown (fast-check)', () => {
    fc.assert(
      fc.property(fc.nat(1000), fc.nat(1000), fc.boolean(), (count, unknown, capped) => {
        const words = dayWords({ count, unknown }, capped);
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
  it('this winter before 1 October is empty, and says when its record begins', () => {
    const now = Date.UTC(2026, 7, 20, 15);
    const w = wintersFrom(
      [{ season: 2026, days: [], unknownEnds: 0, capped: false, watchOpensOn: null }],
      now,
    );
    expect(w?.begins).toBe(Date.UTC(2026, 9, 1));
    expect(w?.today).toBeNull();
    expect(w?.lines[0]?.days.every((d) => d === null)).toBe(true);
    expect(w && lineSummary(w.lines[0] as WinterLine)).toBe('No hazard reports');
  });

  it('marks today and the watch’s opening, and carries each strip’s floor and missing ends', () => {
    const w = wintersFrom(
      [
        {
          season: 2026,
          days: [{ at: Date.UTC(2026, 9, 5), count: 1, unknown: 0 }],
          unknownEnds: 0,
          capped: true,
          watchOpensOn: Date.UTC(2026, 9, 3),
        },
        LAST_WINTER_DAILY,
      ],
      Date.UTC(2026, 9, 14, 16),
    );
    expect(w?.today).toBe(13);
    expect(w?.opens).toBe(2);
    expect(w?.begins).toBeNull();
    expect(w?.lines.map((l) => [l.season, l.capped, l.unknownEnds])).toEqual([
      [2026, true, 0],
      [2025, false, 8],
    ]);
    expect(lineSummary(w?.lines[0] as WinterLine)).toBe('1 day with hazard reports; each a floor');
    expect(lineSummary(w?.lines[1] as WinterLine)).toMatch(
      /^\d+ days with hazard reports, \d+ with some unknown$/,
    );
    expect(wintersFrom([], 0)).toBeNull();
  });

  it('a past winter has no today and no beginning ahead', () => {
    const w = wintersFrom([LAST_WINTER_DAILY], Date.UTC(2026, 9, 14, 16));
    expect(w?.today).toBeNull();
    expect(w?.begins).toBeNull();
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

describe('seasons', () => {
  it('the bar is this winter and the two before; Earlier holds three more', () => {
    expect(seasonChoices(2026)).toEqual({ bar: [2026, 2025, 2024], earlier: [2023, 2022, 2021] });
    expect(seasonWord(2026)).toBe('2026–27');
    expect(seasonWord(2099)).toBe('2099–00');
    expect(isCurrent(seasonOf(BODY_NOW), BODY_NOW)).toBe(true);
    expect(isCurrent(2025, BODY_NOW)).toBe(false);
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
