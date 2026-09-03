import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/**
 * The season lifecycle of the 25-site checker (D149, and D161's gate for the weather sweep).
 *
 * ⚠ **This file exists because the checker had no tests at all**, and it had just grown a second
 * edge. Opening was covered by `ingestGate.test.ts` at the pure-function level, but the wiring — the
 * early return that decides whether a tick does anything — was not, which is exactly where the bug
 * lived: a recorded `opensOn` short-circuited every subsequent tick, so the `closesOn` that
 * `ingestWindow` computed was never persisted and nothing downstream could ever stand down.
 */

const square = (d: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [-72.0331 - d, 44.0163 - d],
      [-72.0331 + d, 44.0163 - d],
      [-72.0331 + d, 44.0163 + d],
      [-72.0331 - d, 44.0163 + d],
      [-72.0331 - d, 44.0163 - d],
    ],
  ],
});

async function seedSites(t: ReturnType<typeof convexTest>, count = 3) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert('waterBodies', {
        name: `Gate Lake ${i}`,
        searchText: `Gate Lake ${i}`,
        type: 'lakePond' as const,
        source: 'osm' as const,
        polygon: square(0.01),
        bbox: { minLat: 43.99, minLng: -72.05, maxLat: 44.05, maxLng: -71.99 },
        centroid: { lat: 44.0163 + i * 0.1, lng: -72.0331 },
        interiorPoint: { lat: 44.0163 + i * 0.1, lng: -72.0331 },
        dedupStatus: 'clean' as const,
        curatedBoost: 10 - i,
        createdAt: Date.now(),
      });
    }
  });
}

/** Open-Meteo's multi-coordinate daily shape: one object per site. */
function dailyLows(siteCount: number, start: string, lows: number[]) {
  const base = new Date(`${start}T00:00:00Z`).getTime();
  const time = lows.map((_, i) => new Date(base + i * 86_400_000).toISOString().slice(0, 10));
  return Array.from({ length: siteCount }, () => ({
    daily: { time, temperature_2m_min: lows },
  }));
}

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * The checker's month gate and its October observation floor both read the real clock, so a test
 * has to pin the clock **and** date its fixtures consistently with it.
 *
 * ⚠ Both dates below sit inside one season label: D63's boundary is July, so December 2026 and
 * April 2027 are both `winter-2026-27`. Straddling it accidentally is how a close ends up filed
 * against a season that never opened.
 */
const IN_SEASON = '2026-12-15';
const IN_SPRING = '2027-04-30';
const atDate = (iso: string) => vi.setSystemTime(new Date(`${iso}T00:00:00Z`));

describe('maybeCheckSeasonOpen — the season lifecycle', () => {
  test('does nothing between July and October', async () => {
    vi.useFakeTimers();
    atDate('2026-08-15');
    const t = convexTest(schema, modules);
    await seedSites(t);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});
    expect(result).toMatchObject({ skipped: 'before October' });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  test('records the open, then keeps ticking to look for the close', async () => {
    vi.useFakeTimers();
    atDate(IN_SEASON);
    const t = convexTest(schema, modules);
    await seedSites(t);

    // A cold December: every site freezes, so the corpus signal fires and winter establishes.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(dailyLows(3, '2026-12-01', [2, -1, -3, -4, -5]))),
    );
    const opened = await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});
    expect(opened).toMatchObject({ open: true, opensOn: '2026-12-02' });

    // ⚠ The regression this file exists for. A second tick must NOT report "already recorded" —
    // the row has an open date and no close date, so there is still work to do.
    const again = await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});
    expect(again).not.toMatchObject({ skipped: 'already recorded' });
    expect(again).toMatchObject({ open: true });

    vi.useRealTimers();
  });

  test('closes the season on a sustained thaw, against the RECORDED winterFrom', async () => {
    vi.useFakeTimers();
    atDate(IN_SEASON);
    const t = convexTest(schema, modules);
    await seedSites(t);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(dailyLows(3, '2026-12-01', [2, -1, -3, -4, -5]))),
    );
    await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});

    // Now it is April and the fetch window reaches back only to mid-January — nowhere near the
    // December freeze-up. `ingestWindow` would find no winterFrom here and never close; the recorded
    // one is what makes the close reachable.
    atDate(IN_SPRING);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okJson(
          dailyLows(
            3,
            '2027-04-01',
            Array.from({ length: 20 }, () => 8),
          ),
        ),
      ),
    );
    const closed = await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});
    expect(closed).toMatchObject({ closed: true, closesOn: '2027-04-10' });

    const row = await t.run((ctx) => ctx.db.query('imageryIngestSeasons').first());
    expect(row?.closesOn).toBe('2027-04-10');
    expect(row?.closedAt).toBeTypeOf('number');

    // Closed is final within a season: a late cold snap does not reopen it, and a later tick does
    // not move the date to whenever we last looked.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okJson(
          dailyLows(
            3,
            '2027-05-01',
            Array.from({ length: 20 }, () => 9),
          ),
        ),
      ),
    );
    const after = await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});
    expect(after).toMatchObject({ skipped: 'already recorded' });
    const unchanged = await t.run((ctx) => ctx.db.query('imageryIngestSeasons').first());
    expect(unchanged?.closesOn).toBe('2027-04-10');

    vi.useRealTimers();
  });

  test('a season that opened but never established winter is not left ticking for ever', async () => {
    vi.useFakeTimers();
    atDate(IN_SEASON);
    const t = convexTest(schema, modules);
    await seedSites(t);
    const gate = await t.run((ctx) =>
      ctx.db.insert('imageryIngestSeasons', {
        season: 'winter-2026-27',
        opensOn: '2026-11-02',
        openedBy: ['sentinel'],
        // The sentinel opened it and the region never followed — a real recorded state, and one
        // with no close to find. Ticking daily against it would be a fetch a day for nothing.
        winterFrom: null,
        sitesSampled: 3,
        detectedAt: Date.now(),
      }),
    );
    expect(gate).toBeTruthy();

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});
    expect(result).toMatchObject({ skipped: 'already recorded' });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
