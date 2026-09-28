import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { libraryGrid, photoIdsInWindow } from './libraryGrid';
import { zonedMinuteOfDay } from './zonedTime';

const H = 3_600_000;
const NY = 'America/New_York';
const at = (iso: string) => Date.parse(iso);
const photo = (id: string, iso: string) => ({ id, takenAtMs: at(iso) });

describe('libraryGrid — grouping by local hour', () => {
  it('groups by the local hour, oldest first', () => {
    const grid = libraryGrid(
      [
        photo('c', '2026-01-10T21:59:00Z'),
        photo('a', '2026-01-10T21:05:00Z'),
        photo('b', '2026-01-10T21:30:00Z'),
        photo('d', '2026-01-10T22:00:00Z'),
      ],
      { timeZone: NY, skate: null },
    );
    expect(grid.map((h) => h.label)).toEqual(['4 PM', '5 PM']);
    expect(grid[0]?.photos.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(grid[1]?.photos.map((p) => p.id)).toEqual(['d']);
    expect(grid[0]?.hourStartMs).toBe(at('2026-01-10T21:00:00Z'));
  });

  it('keeps the two 1 AMs of the night the clocks fall back apart, and says which is which', () => {
    // 2026-11-01: 1:30 EDT is 05:30Z; 1:30 EST is 06:30Z.
    const grid = libraryGrid(
      [photo('edt', '2026-11-01T05:30:00Z'), photo('est', '2026-11-01T06:30:00Z')],
      { timeZone: NY, skate: null },
    );
    expect(grid).toHaveLength(2);
    expect(grid.map((h) => h.label)).toEqual(['1 AM EDT', '1 AM EST']);
    expect(grid[1]?.hourStartMs).toBe(at('2026-11-01T06:00:00Z'));
  });

  it('skips the hour the clocks spring over', () => {
    // 2026-03-08: 1:59 EST is 06:59Z; 3:01 EDT is 07:01Z.
    const grid = libraryGrid(
      [photo('before', '2026-03-08T06:59:00Z'), photo('after', '2026-03-08T07:01:00Z')],
      { timeZone: NY, skate: null },
    );
    expect(grid.map((h) => h.label)).toEqual(['1 AM', '3 AM']);
  });

  it('floors to the local hour in a half-hour zone', () => {
    // St. John's in January is UTC−3:30: 12:10Z is 8:40 local, whose hour began at 11:30Z.
    const grid = libraryGrid([photo('nl', '2026-01-10T12:10:00Z')], {
      timeZone: 'America/St_Johns',
      skate: null,
    });
    expect(grid[0]?.hourStartMs).toBe(at('2026-01-10T11:30:00Z'));
    expect(grid[0]?.label).toBe('8 AM');
  });

  it('puts every photo under exactly one hour that holds it', () => {
    const zones = fc.constantFrom(NY, 'America/St_Johns', 'Europe/London', 'UTC');
    const instant = fc.integer({
      min: at('2026-01-01T00:00:00Z'),
      max: at('2027-01-01T00:00:00Z'),
    });
    fc.assert(
      fc.property(zones, fc.array(instant, { maxLength: 40 }), (timeZone, times) => {
        const photos = times.map((t, i) => ({ id: String(i), takenAtMs: t }));
        const grid = libraryGrid(photos, { timeZone, skate: null });
        expect(grid.reduce((n, h) => n + h.photos.length, 0)).toBe(photos.length);
        for (let i = 1; i < grid.length; i++) {
          expect((grid[i] as { hourStartMs: number }).hourStartMs).toBeGreaterThan(
            (grid[i - 1] as { hourStartMs: number }).hourStartMs,
          );
        }
        for (const h of grid) {
          expect(zonedMinuteOfDay(h.hourStartMs, timeZone) % 60).toBe(0);
          for (const p of h.photos) {
            expect(p.takenAtMs).toBeGreaterThanOrEqual(h.hourStartMs);
            expect(p.takenAtMs).toBeLessThan(h.hourStartMs + H);
          }
        }
      }),
    );
  });
});

describe('libraryGrid — the marks', () => {
  const day = [
    photo('noon', '2026-01-10T17:10:00Z'),
    photo('one', '2026-01-10T18:10:00Z'),
    photo('two', '2026-01-10T19:10:00Z'),
    photo('three', '2026-01-10T20:10:00Z'),
    photo('four', '2026-01-10T21:10:00Z'),
  ];

  it('rails the hours the skate touches, and only those', () => {
    const grid = libraryGrid(day, {
      timeZone: NY,
      skate: { startMs: at('2026-01-10T18:45:00Z'), endMs: at('2026-01-10T20:00:00Z') },
    });
    expect(grid.map((h) => h.inSkate)).toEqual([false, true, true, true, false]);
  });

  it('rails nothing before the skate has an end time', () => {
    expect(libraryGrid(day, { timeZone: NY, skate: null }).some((h) => h.inSkate)).toBe(false);
  });

  it("numbers the other Reports' hours, an end-only Report by its end", () => {
    const grid = libraryGrid(day, {
      timeZone: NY,
      skate: null,
      others: [
        { number: 3, startMs: at('2026-01-10T17:30:00Z'), endMs: at('2026-01-10T18:30:00Z') },
        { number: 1, endMs: at('2026-01-10T18:15:00Z') },
      ],
    });
    expect(grid.map((h) => h.reports)).toEqual([[3], [1, 3], [], [], []]);
  });
});

describe('photoIdsInWindow', () => {
  it('selects the photos inside the window, ends included', () => {
    const photos = [
      photo('before', '2026-01-10T17:59:59Z'),
      photo('start', '2026-01-10T18:00:00Z'),
      photo('end', '2026-01-10T19:00:00Z'),
      photo('after', '2026-01-10T19:00:01Z'),
    ];
    expect(
      photoIdsInWindow(photos, {
        startMs: at('2026-01-10T18:00:00Z'),
        endMs: at('2026-01-10T19:00:00Z'),
      }),
    ).toEqual(['start', 'end']);
  });
});
