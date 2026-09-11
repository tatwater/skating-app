import { weatherCellFor } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';
import {
  APPEND_PAST_DAYS,
  HOURLY_ROW_VERSION,
  RECONCILE_DEBOUNCE_MS,
  reconcileSatisfiedBy,
  SEASON_OPEN_PAST_DAYS,
  SYNC_ASSUMED_DEAD_MS,
} from './weatherArchive';

const modules = import.meta.glob('./**/*.*s');
const DAY_MS = 86_400_000;

function square(half: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
        [-half, -half],
      ],
    ],
  };
}

async function seedBody(
  t: ReturnType<typeof convexTest>,
  centroid = { lat: 44.0163, lng: -72.0331 },
  elevationM: number | undefined = 338,
): Promise<Id<'waterBodies'>> {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Archive Lake',
      searchText: 'Archive Lake',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: square(0.01),
      bbox: { minLat: 43.99, minLng: -72.05, maxLat: 44.05, maxLng: -71.99 },
      centroid,
      interiorPoint: centroid,
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
      ...(elevationM === undefined ? {} : { elevationM }),
    }),
  ) as Promise<Id<'waterBodies'>>;
}

function asViewer(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({ subject: 'viewer' });
}

/**
 * An Open-Meteo `iso8601` response covering `dates`, 24 hours each. `temps` is per-date so a test can
 * make one day cold and another mild without hand-writing 48 numbers.
 */
function isoResponse(
  dates: string[],
  opts: {
    tempFor?: (date: string, hour: number) => number;
    snowFor?: (date: string, hour: number) => number;
    windFor?: (date: string, hour: number) => number;
    dirFor?: (date: string, hour: number) => number;
    /** WMO code by flat hour index — the variable N6h Workstream D added. */
    codeFor?: (index: number) => number;
    hoursPerDay?: number;
  } = {},
) {
  const hoursPerDay = opts.hoursPerDay ?? 24;
  const time: string[] = [];
  const temperature_2m: number[] = [];
  const snowfall: number[] = [];
  const wind_speed_10m: number[] = [];
  const wind_direction_10m: number[] = [];
  for (const date of dates) {
    for (let h = 0; h < hoursPerDay; h++) {
      time.push(`${date}T${String(h).padStart(2, '0')}:00`);
      temperature_2m.push(opts.tempFor ? opts.tempFor(date, h) : -5);
      snowfall.push(opts.snowFor ? opts.snowFor(date, h) : 0);
      wind_speed_10m.push(opts.windFor ? opts.windFor(date, h) : 3);
      wind_direction_10m.push(opts.dirFor ? opts.dirFor(date, h) : 315);
    }
  }
  const n = time.length;
  return {
    hourly: {
      time,
      temperature_2m,
      precipitation: new Array(n).fill(0),
      rain: new Array(n).fill(0),
      snowfall,
      snow_depth: new Array(n).fill(0),
      wind_speed_10m,
      wind_gusts_10m: wind_speed_10m.map((w) => w * 1.5),
      wind_direction_10m,
      cloud_cover: new Array(n).fill(50),
      sunshine_duration: new Array(n).fill(0),
      shortwave_radiation: new Array(n).fill(0),
      weather_code: time.map((_, i) => opts.codeFor?.(i) ?? 0),
    },
  };
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Local dates ending today (UTC), oldest first — matching what `past_days` returns. */
function recentDates(count: number): string[] {
  const out: string[] = [];
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  for (let i = count - 1; i >= 0; i--) {
    out.push(new Date(today - i * DAY_MS).toISOString().slice(0, 10));
  }
  return out;
}

function dayMsOf(localDate: string): number {
  const [y, m, d] = localDate.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

describe('weatherArchive: the request builder (D153)', () => {
  test('asks for iso8601 local stamps, not unixtime — the DST fix', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const fetchMock = vi.fn(async (_url: string) => okJson(isoResponse(recentDates(3))));
    vi.stubGlobal('fetch', fetchMock);

    await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, { waterBodyId });

    const params = new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams;
    // The entire reason this module has its own request builder: one `utc_offset_seconds` per response
    // misfiles an hour either side of a DST change, and both transitions fall inside a season.
    expect(params.get('timeformat')).toBe('iso8601');
    expect(params.get('timezone')).toBe('auto');
    // Still the cell's snapped centre and band elevation — the key must not fork from `weather.ts`.
    expect(params.get('latitude')).toBe('44');
    expect(params.get('elevation')).toBe('300');
  });

  test('a first touch pulls the 92-day ceiling, not the panel window', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const fetchMock = vi.fn(async (_url: string) => okJson(isoResponse(recentDates(3))));
    vi.stubGlobal('fetch', fetchMock);

    await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, { waterBodyId, days: 7 });

    // D153: lazy backfill is not lossy. The first visitor in February gets the whole season.
    const params = new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams;
    expect(params.get('past_days')).toBe('92');
  });

  test('meters the archive fetch under the same provider (D158)', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(isoResponse(recentDates(3)))),
    );
    await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, { waterBodyId });
    const rows = await t.run((ctx) => ctx.db.query('externalApiCalls').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe('open-meteo');
    // 93 days over 12 vars: ceil(93/14)=7 × 1.2 = 8.4 billed calls in ONE request.
    //
    // ⚠ **This number went up by 9% in N6h Workstream D and that was the point of the founder call.**
    // It was 7.7 at eleven variables; `weather_code` is the twelfth, and it is what lets the scrub
    // readout name sleet and freezing drizzle instead of guessing. The increase applies to every
    // Open-Meteo call in the app, including the corpus-wide Tier-B sweep, which is most of the
    // traffic — so if D158's ~7,000/day trigger ever fires, this variable is part of why. Anyone
    // removing it should expect this assertion to want 7.7 again, and should read `HOURLY_VARS`
    // before assuming that is a saving rather than a silent downgrade.
    expect(rows[0]?.weightedCalls).toBeCloseTo(8.4, 6);
  });
});

describe('weatherArchive: storage', () => {
  test('stores one row per local day, with the measures the panel reads', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const dates = recentDates(3);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okJson(
          isoResponse(dates, {
            tempFor: (_d, h) => (h < 12 ? -8 : -2),
            snowFor: (d, h) => (d === dates[1] && h === 4 ? 3 : 0),
            windFor: () => 2,
          }),
        ),
      ),
    );

    const result = await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, {
      waterBodyId,
      days: 3,
    });

    expect(result?.days).toHaveLength(3);
    const middle = result?.days.find((d) => d.localDate === dates[1]);
    expect(middle?.minTempC).toBe(-8);
    expect(middle?.maxTempC).toBe(-2);
    expect(middle?.snowfallCm).toBeCloseTo(3, 6);
    expect(middle?.hoursBelowFreezing).toBe(24);
    // The black-ice signal: it froze all day and the wind was calm throughout.
    expect(middle?.freezingHoursMeanWindKph).toBeCloseTo(2, 6);
    expect(middle?.windSectorHours).toHaveLength(16);
    // The night that ended on this date reaches into the previous evening, which we have.
    expect(middle?.nightMinTempC).toBe(-8);
  });

  test('the upsert is idempotent — a re-fetch overwrites rather than duplicating', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const dates = recentDates(3);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(isoResponse(dates, { tempFor: () => -5 }))),
    );

    await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, { waterBodyId, days: 3 });
    const first = await t.run((ctx) => ctx.db.query('weatherDays').collect());

    // Every append re-requests overlapping days on purpose (a partial "today" has to be completed),
    // so without an upsert each tick would duplicate — and a duplicated day double-counts in any
    // predicate that sums a span.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(isoResponse(dates, { tempFor: () => -12 }))),
    );
    await t.action(internal.weatherArchive.refreshTierDays, { tier: 'browse' });

    const second = await t.run((ctx) => ctx.db.query('weatherDays').collect());
    expect(second).toHaveLength(first.length);
  });

  test('a partial day reports the hours it actually saw, never a padded 24', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const dates = recentDates(2);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(isoResponse(dates, { hoursPerDay: 10 }))),
    );
    const result = await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, {
      waterBodyId,
      days: 2,
    });
    expect(result?.days[0]?.hours).toBe(10);
  });

  test('a failed fetch stores NOTHING rather than a row of zeroes', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 })),
    );
    const result = await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, {
      waterBodyId,
      days: 7,
    });
    const rows = await t.run((ctx) => ctx.db.query('weatherDays').collect());
    expect(rows).toHaveLength(0);
    // ⚠ The distinction the `missing` flag exists for: an absent day must read as "we don't know",
    // never as "no snow fell", which is what a zeroed row would say to a D159 predicate.
    expect(result?.days).toHaveLength(0);
    expect(result?.missingDayMs).toHaveLength(7);
  });

  test('reports window days that produced no row as missing', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    // Only 2 of the 5 requested days come back.
    const dates = recentDates(5).slice(3);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(isoResponse(dates))),
    );
    const result = await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, {
      waterBodyId,
      days: 5,
    });
    expect(result?.days).toHaveLength(2);
    expect(result?.missingDayMs).toHaveLength(3);
  });
});

describe('weatherArchive: the cell registry', () => {
  test('materialises one row per distinct cell, counting the bodies in it', async () => {
    const t = convexTest(schema, modules);
    // Two bodies in one 0.1° filter cell, one in another.
    await seedBody(t, { lat: 44.0163, lng: -72.0331 }, 338);
    await seedBody(t, { lat: 44.0201, lng: -72.0355 }, 351);
    await seedBody(t, { lat: 45.5, lng: -71.2 }, 200);

    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });

    const cells = await t.run((ctx) => ctx.db.query('weatherCells').collect());
    expect(cells).toHaveLength(2);
    const busy = cells.find((c) => c.bodyCount === 2);
    expect(busy).toBeDefined();
    // The snapped centre is stored so the cron never needs a body row.
    expect(busy?.lat).toBe(44);
    expect(busy?.tier).toBe('filter');
    // `filter` never bands by elevation, so two bodies 13 m apart vertically still share a cell.
    expect(busy?.elevationM).toBeUndefined();
  });

  test('re-running refreshes counts instead of duplicating rows', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t);
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    const cells = await t.run((ctx) => ctx.db.query('weatherCells').collect());
    expect(cells).toHaveLength(1);
    expect(cells[0]?.bodyCount).toBe(1);
  });

  test('skips removed bodies', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t);
    await t.run((ctx) => ctx.db.patch(id, { removedAt: Date.now() }));
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    const cells = await t.run((ctx) => ctx.db.query('weatherCells').collect());
    expect(cells).toHaveLength(0);
  });
});

describe('weatherArchive: the season gate (D161)', () => {
  test('does not spend anything before the season is recorded open', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t);
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    const fetchMock = vi.fn(async () => okJson(isoResponse(recentDates(3))));
    vi.stubGlobal('fetch', fetchMock);

    const result = await t.action(internal.weatherArchive.maybeRefreshFilterTier, {});
    await t.finishInProgressScheduledFunctions();

    expect(result.started).toBe(false);
    // The whole point: ~43% of the annual free-tier budget would otherwise go on July.
    expect(fetchMock).not.toHaveBeenCalled();
    const rows = await t.run((ctx) => ctx.db.query('weatherDays').collect());
    expect(rows).toHaveLength(0);
  });

  test('runs once the 25-site checker has recorded the season open', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t);
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    const gate = await t.run((ctx) =>
      ctx.runQuery(internal.weatherArchive.isSweepSeasonOpen, { nowMs: Date.now() }),
    );
    await t.run((ctx) =>
      ctx.db.insert('imageryIngestSeasons', {
        season: gate.season,
        opensOn: '2025-12-01',
        openedBy: ['sentinel pond'],
        winterFrom: '2025-11-01',
        sitesSampled: 25,
        detectedAt: Date.now(),
      }),
    );

    const fetchMock = vi.fn(async () => okJson(isoResponse(recentDates(3))));
    vi.stubGlobal('fetch', fetchMock);
    const result = await t.action(internal.weatherArchive.maybeRefreshFilterTier, {});
    expect(result.started).toBe(true);
    // The gate *schedules* the sweep rather than awaiting it, so the tick stays fast and the sweep
    // keeps its own self-rescheduling batch loop. Drain the scheduler to see the effect.
    await t.finishInProgressScheduledFunctions();
    expect(fetchMock).toHaveBeenCalled();
  });

  test('stands down once the checker records the season closed', async () => {
    // ⚠ The gate used to open on `opensOn` and never close, so the sweep ran from mid-November to
    // the July label rollover — ~228 days against the ~151 D161 was costed on. `closesOn` is what
    // makes the saving real, and this asserts the second edge exists.
    const t = convexTest(schema, modules);
    await seedBody(t);
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    const gate = await t.run((ctx) =>
      ctx.runQuery(internal.weatherArchive.isSweepSeasonOpen, { nowMs: Date.now() }),
    );
    await t.run((ctx) =>
      ctx.db.insert('imageryIngestSeasons', {
        season: gate.season,
        opensOn: '2025-12-01',
        openedBy: ['sentinel pond'],
        winterFrom: '2025-11-01',
        closesOn: '2026-05-05',
        closedAt: Date.now(),
        sitesSampled: 25,
        detectedAt: Date.now(),
      }),
    );

    const fetchMock = vi.fn(async () => okJson(isoResponse(recentDates(3))));
    vi.stubGlobal('fetch', fetchMock);
    const result = await t.action(internal.weatherArchive.maybeRefreshFilterTier, {});
    await t.finishInProgressScheduledFunctions();

    expect(result.started).toBe(false);
    expect(result.reason).toContain('2026-05-05');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the first sweep of a season reaches back a fortnight, not three days', async () => {
    // D161 promised D159 "a region-wide freeze map on day one". A 3-day append delivers three days,
    // which cannot answer a one-week predicate. 14 costs the same single Open-Meteo billing unit.
    const t = convexTest(schema, modules);
    await seedBody(t);
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    const gate = await t.run((ctx) =>
      ctx.runQuery(internal.weatherArchive.isSweepSeasonOpen, { nowMs: Date.now() }),
    );
    await t.run((ctx) =>
      ctx.db.insert('imageryIngestSeasons', {
        season: gate.season,
        opensOn: '2025-12-01',
        openedBy: ['sentinel pond'],
        winterFrom: '2025-11-01',
        sitesSampled: 25,
        detectedAt: Date.now(),
      }),
    );

    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return okJson(isoResponse(recentDates(SEASON_OPEN_PAST_DAYS)));
      }),
    );

    // Cold archive: nothing held for yesterday, so the first tick reaches back.
    const cold = await t.action(internal.weatherArchive.maybeRefreshFilterTier, {});
    await t.finishInProgressScheduledFunctions();
    expect(cold.pastDays).toBe(SEASON_OPEN_PAST_DAYS);
    expect(urls[0]).toContain(`past_days=${SEASON_OPEN_PAST_DAYS}`);

    // Warm now — the second tick is the cheap daily append again.
    const warm = await t.action(internal.weatherArchive.maybeRefreshFilterTier, {});
    await t.finishInProgressScheduledFunctions();
    expect(warm.pastDays).toBe(APPEND_PAST_DAYS);
  });
});

describe('weatherArchive: the recovery ladder (D161)', () => {
  test('refetches a hole inside the 92-day window (step 1)', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t);
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    const cells = await t.run((ctx) => ctx.db.query('weatherCells').collect());
    const cellKey = cells[0]?.cellKey ?? '';

    // Seed a cell that holds days -5 and -3 but not -4.
    const dates = recentDates(6);
    const present = [dates[0], dates[2]].filter((d): d is string => d !== undefined);
    await t.run(async (ctx) => {
      for (const d of present) {
        await ctx.db.insert('weatherDays', {
          cellKey,
          tier: 'filter' as const,
          dayMs: dayMsOf(d),
          localDate: d,
          source: 'forecast' as const,
          hours: 24,
          fetchedAt: Date.now(),
        });
      }
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(isoResponse(dates))),
    );
    const result = await t.action(internal.weatherArchive.sweepWeatherDayGaps, { tier: 'filter' });
    expect(result.repaired).toBeGreaterThan(0);

    const after = await t.run((ctx) => ctx.db.query('weatherDays').collect());
    const filled = after.find((r) => r.dayMs === dayMsOf(dates[1] ?? ''));
    expect(filled).toBeDefined();
    expect(filled?.missing).not.toBe(true);
  });

  test('records an unrecoverable hole as missing, never as zeroes (step 4)', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t);
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    const cells = await t.run((ctx) => ctx.db.query('weatherCells').collect());
    const cellKey = cells[0]?.cellKey ?? '';
    const dates = recentDates(4);
    await t.run(async (ctx) => {
      for (const d of [dates[0], dates[3]].filter((x): x is string => x !== undefined)) {
        await ctx.db.insert('weatherDays', {
          cellKey,
          tier: 'filter' as const,
          dayMs: dayMsOf(d),
          localDate: d,
          source: 'forecast' as const,
          hours: 24,
          fetchedAt: Date.now(),
        });
      }
    });

    // Open-Meteo down: nothing can be recovered.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 })),
    );
    await t.action(internal.weatherArchive.sweepWeatherDayGaps, { tier: 'filter' });

    const after = await t.run((ctx) => ctx.db.query('weatherDays').collect());
    const gaps = after.filter((r) => r.missing === true);
    expect(gaps.length).toBeGreaterThan(0);
    // A recorded gap carries no measures at all — that is the difference between "unknown" and "zero".
    expect(gaps[0]?.snowfallCm).toBeUndefined();
    expect(gaps[0]?.hours).toBeUndefined();
  });

  test('a gap marker never overwrites real data', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t);
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    const cells = await t.run((ctx) => ctx.db.query('weatherCells').collect());
    const cellKey = cells[0]?.cellKey ?? '';
    const day = dayMsOf(recentDates(2)[0] ?? '');

    await t.run((ctx) =>
      ctx.db.insert('weatherDays', {
        cellKey,
        tier: 'filter' as const,
        dayMs: day,
        localDate: recentDates(2)[0] ?? '',
        source: 'forecast' as const,
        hours: 24,
        snowfallCm: 9,
        fetchedAt: Date.now(),
      }),
    );

    await t.mutation(internal.weatherArchive.writeMissingDays, {
      cellKey,
      tier: 'filter',
      dayMs: [day],
      fetchedAt: Date.now(),
    });

    const row = await t.run((ctx) => ctx.db.query('weatherDays').collect());
    // A sweep running during an outage must not be able to erase a week of good history.
    expect(row[0]?.missing).not.toBe(true);
    expect(row[0]?.snowfallCm).toBe(9);
  });

  test('leaves a never-touched cell alone rather than backfilling the whole corpus', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t);
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    const fetchMock = vi.fn(async () => okJson(isoResponse(recentDates(3))));
    vi.stubGlobal('fetch', fetchMock);

    const result = await t.action(internal.weatherArchive.sweepWeatherDayGaps, { tier: 'filter' });

    // An untouched cell has no gap — it has never been asked about. Treating absence as a hole would
    // silently turn the sweep into a corpus-wide backfill nobody requested.
    expect(result.repaired).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('borrows the days the parent actually has and records the REST as gaps (step 2 → 4)', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t);
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'browse' });
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    const cells = await t.run((ctx) => ctx.db.query('weatherCells').collect());
    const browseKey = cells.find((c) => c.tier === 'browse')?.cellKey ?? '';
    const filterKey = cells.find((c) => c.tier === 'filter')?.cellKey ?? '';

    const dates = recentDates(5);
    const [d0, d1, d2, d3] = dates as [string, string, string, string];
    await t.run(async (ctx) => {
      // The browse cell knows about d0 and d3, so d1 and d2 are holes inside its own known range.
      for (const d of [d0, d3]) {
        await ctx.db.insert('weatherDays', {
          cellKey: browseKey,
          tier: 'browse' as const,
          dayMs: dayMsOf(d),
          localDate: d,
          source: 'forecast' as const,
          hours: 24,
          fetchedAt: Date.now(),
        });
      }
      // The coarser parent can only cover ONE of the two holes — and it is the *newer* one.
      await ctx.db.insert('weatherDays', {
        cellKey: filterKey,
        tier: 'filter' as const,
        dayMs: dayMsOf(d2),
        localDate: d2,
        source: 'forecast' as const,
        hours: 24,
        snowfallCm: 4,
        fetchedAt: Date.now(),
      });
    });

    // Open-Meteo down, so step 1 recovers nothing and the ladder has to fall through to 2 then 4.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 })),
    );
    await t.action(internal.weatherArchive.sweepWeatherDayGaps, { tier: 'browse' });

    const rows = await t.run((ctx) =>
      ctx.db
        .query('weatherDays')
        .filter((q) => q.eq(q.field('cellKey'), browseKey))
        .collect(),
    );
    const byDay = new Map(rows.map((r) => [r.dayMs, r]));
    // d2 came from the parent — real data, honestly labelled as lower-resolution.
    expect(byDay.get(dayMsOf(d2))?.source).toBe('borrowed');
    expect(byDay.get(dayMsOf(d2))?.missing).toBeUndefined();
    // ⚠ d1 is the one the borrow could NOT cover, and it is the day a count-and-slice would have
    // dropped on the floor: an unrecorded hole reads as "no snow fell" to every D159 predicate.
    expect(byDay.get(dayMsOf(d1))?.missing).toBe(true);
  });
});

describe('weatherArchive: honest coverage on a giant (N6h hole 2)', () => {
  test('flags a body too large for one sample point', async () => {
    const t = convexTest(schema, modules);
    // ~55 km of latitude — Champlain's scale, and Champlain carries zero sample points on dev.
    const waterBodyId = (await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Big Long Lake',
        searchText: 'Big Long Lake',
        type: 'lakePond' as const,
        source: 'osm' as const,
        polygon: square(0.25),
        bbox: { minLat: 44.0, minLng: -73.4, maxLat: 44.5, maxLng: -73.3 },
        centroid: { lat: 44.25, lng: -73.35 },
        interiorPoint: { lat: 44.25, lng: -73.35 },
        elevationM: 30,
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
      }),
    )) as Id<'waterBodies'>;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(isoResponse(recentDates(3)))),
    );
    const result = await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, {
      waterBodyId,
      days: 3,
    });
    expect(result?.oneSampleForALargeBody).toBe(true);
  });

  test('does not flag an ordinary lake', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(isoResponse(recentDates(3)))),
    );
    const result = await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, {
      waterBodyId,
      days: 3,
    });
    expect(result?.oneSampleForALargeBody).toBe(false);
  });

  test('stops flagging once an operator has placed a sample grid', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = (await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Gridded Lake',
        searchText: 'Gridded Lake',
        type: 'lakePond' as const,
        source: 'osm' as const,
        polygon: square(0.25),
        bbox: { minLat: 44.0, minLng: -73.4, maxLat: 44.5, maxLng: -73.3 },
        centroid: { lat: 44.25, lng: -73.35 },
        interiorPoint: { lat: 44.25, lng: -73.35 },
        // N2's suggester + moderator writer exist and have never been run; this is what it looks
        // like afterwards.
        weatherSamplePoints: [
          { lat: 44.1, lng: -73.35 },
          { lat: 44.4, lng: -73.35 },
        ],
        elevationM: 30,
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
      }),
    )) as Id<'waterBodies'>;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(isoResponse(recentDates(3)))),
    );
    const result = await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, {
      waterBodyId,
      days: 3,
    });
    expect(result?.oneSampleForALargeBody).toBe(false);
  });
});

describe('weatherArchive: the public read guard', () => {
  test('returns null to an unauthenticated caller and spends nothing', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const fetchMock = vi.fn(async () => okJson(isoResponse(recentDates(3))));
    vi.stubGlobal('fetch', fetchMock);
    const result = await t.action(api.weatherArchive.getWeatherDaysForBody, { waterBodyId });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('returns null for a removed body', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    await t.run((ctx) => ctx.db.patch(waterBodyId, { removedAt: Date.now() }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(isoResponse(recentDates(3)))),
    );
    expect(
      await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, { waterBodyId }),
    ).toBeNull();
  });

  test('a second viewer of the same cell pays nothing', async () => {
    const t = convexTest(schema, modules);
    const a = await seedBody(t, { lat: 44.0163, lng: -72.0331 }, 338);
    const b = await seedBody(t, { lat: 44.0151, lng: -72.0339 }, 330);
    const fetchMock = vi.fn(async () => okJson(isoResponse(recentDates(9))));
    vi.stubGlobal('fetch', fetchMock);

    await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, {
      waterBodyId: a,
      days: 7,
    });
    await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, {
      waterBodyId: b,
      days: 7,
    });

    // Same cell, same band ⇒ the archive is already there. This is D152's whole return on investment.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not invent a gap when the lake is still on yesterday (the UTC/local skew)', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    // ⚠ `dayMs` is the lake's LOCAL date and "today" is a UTC day. Between UTC midnight and the
    // lake's own midnight — 7 PM to midnight in the Northeast, prime browsing — the newest day
    // Open-Meteo can possibly return is UTC-today minus one. Anchoring on UTC-today there reports a
    // phantom "1 day of weather unavailable" AND re-fetches on every single drawer-open chasing a
    // day that does not exist yet. (The rest of this file mints local dates off the UTC clock, which
    // is exactly why the skew hid.)
    const dates = recentDates(8).slice(0, 7);
    const fetchMock = vi.fn(async () => okJson(isoResponse(dates)));
    vi.stubGlobal('fetch', fetchMock);

    const first = await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, {
      waterBodyId,
      days: 7,
    });
    expect(first?.days).toHaveLength(7);
    expect(first?.missingDayMs).toEqual([]);

    const callsAfterFirst = fetchMock.mock.calls.length;
    await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, { waterBodyId, days: 7 });
    // The second open is a pure read. Without the local anchor this spends an Open-Meteo call every
    // time, for ever, on a day the archive can never hold.
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('weatherArchive: the cell registry has a producer (and a reconciler)', () => {
  /** Open the season so the sweep is allowed to spend anything. */
  async function openSeason(t: ReturnType<typeof convexTest>) {
    const gate = await t.run((ctx) =>
      ctx.runQuery(internal.weatherArchive.isSweepSeasonOpen, { nowMs: Date.now() }),
    );
    await t.run((ctx) =>
      ctx.db.insert('imageryIngestSeasons', {
        season: gate.season,
        opensOn: '2025-12-01',
        openedBy: ['sentinel pond'],
        winterFrom: '2025-11-01',
        sitesSampled: 25,
        detectedAt: Date.now(),
      }),
    );
  }

  test('the daily sweep self-heals an empty registry instead of quietly fetching nothing', async () => {
    // ⚠ The shipped failure: nothing outside tests ever called `backfillWeatherCells`, so on a fresh
    // deployment `refreshTierDays` paged zero cells, returned done, and the cron reported a healthy
    // tick having fetched nothing at all. Forever, silently.
    const t = convexTest(schema, modules);
    await seedBody(t);
    await openSeason(t);
    // Deliberately NO backfill call — this is the fresh-deployment state.
    const before = await t.run((ctx) => ctx.db.query('weatherCells').collect());
    expect(before).toHaveLength(0);

    const fetchMock = vi.fn(async () => okJson(isoResponse(recentDates(3))));
    vi.stubGlobal('fetch', fetchMock);
    const result = await t.action(internal.weatherArchive.maybeRefreshFilterTier, {});
    await t.finishInProgressScheduledFunctions();

    expect(result.started).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    const rows = await t.run((ctx) => ctx.db.query('weatherDays').collect());
    expect(rows.length).toBeGreaterThan(0);
  });

  test('reports an empty corpus rather than sweeping nothing in silence', async () => {
    const t = convexTest(schema, modules); // no bodies at all
    await openSeason(t);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await t.action(internal.weatherArchive.maybeRefreshFilterTier, {});
    await t.finishInProgressScheduledFunctions();

    expect(result.started).toBe(false);
    expect(result.reason).toBe('cell registry empty');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the weekly reconciler registers BOTH tiers', async () => {
    // The gap sweep pages the registry per tier, so an unregistered `browse` cell never gets its
    // holes repaired — the reconciler cannot be filter-only.
    const t = convexTest(schema, modules);
    await seedBody(t);
    await t.action(internal.weatherArchive.maybeSyncWeatherCells, {});
    await t.finishInProgressScheduledFunctions();

    const cells = await t.run((ctx) => ctx.db.query('weatherCells').collect());
    expect(cells.some((c) => c.tier === 'filter')).toBe(true);
    expect(cells.some((c) => c.tier === 'browse')).toBe(true);
  });

  test('picks up a body added after the last run', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t);
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    await t.finishInProgressScheduledFunctions();
    const first = await t.run((ctx) => ctx.db.query('weatherCells').collect());

    // A later import lands a body two degrees away — a cell nobody has registered.
    await seedBody(t, { lat: 46.0163, lng: -70.0331 }, 200);
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    await t.finishInProgressScheduledFunctions();

    const second = await t.run((ctx) => ctx.db.query('weatherCells').collect());
    expect(second.length).toBe(first.length + 1);
  });

  test('prunes a cell the corpus no longer occupies', async () => {
    // A purged or moved body leaves its old cell behind, and the sweep would pay Open-Meteo for an
    // empty patch of map every day for ever.
    const t = convexTest(schema, modules);
    const keep = await seedBody(t);
    const drop = await seedBody(t, { lat: 46.0163, lng: -70.0331 }, 200);
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    await t.finishInProgressScheduledFunctions();
    expect(await t.run((ctx) => ctx.db.query('weatherCells').collect())).toHaveLength(2);

    await t.run((ctx) => ctx.db.patch(drop, { removedAt: Date.now() }));
    const res = await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    await t.finishInProgressScheduledFunctions();

    expect(res.pruned).toBe(1);
    const left = await t.run((ctx) => ctx.db.query('weatherCells').collect());
    expect(left).toHaveLength(1);
    expect(keep).toBeTruthy();
  });

  test('⚠ pruning never deletes the observations, only the schedule', async () => {
    // D153: a row describing what the weather did at a place stays true whether or not a lake is
    // still listed there, and the cell may be re-occupied by a later import.
    const t = convexTest(schema, modules);
    const drop = await seedBody(t, { lat: 46.0163, lng: -70.0331 }, 200);
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    await t.finishInProgressScheduledFunctions();
    const cell = await t.run((ctx) => ctx.db.query('weatherCells').first());
    await t.run((ctx) =>
      ctx.db.insert('weatherDays', {
        cellKey: cell?.cellKey ?? '',
        tier: 'filter' as const,
        dayMs: Date.UTC(2026, 1, 10),
        localDate: '2026-02-10',
        source: 'forecast' as const,
        hours: 24,
        freezingDegreeHours: 100,
        fetchedAt: Date.now(),
      }),
    );

    await t.run((ctx) => ctx.db.patch(drop, { removedAt: Date.now() }));
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    await t.finishInProgressScheduledFunctions();

    expect(await t.run((ctx) => ctx.db.query('weatherCells').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('weatherDays').collect())).toHaveLength(1);
  });

  test('a mid-run page does not prune the cells later pages will re-stamp', async () => {
    // ⚠ Pruning on any page rather than on `isDone` would delete the whole registry one page in.
    const t = convexTest(schema, modules);
    await seedBody(t);
    const partial = await t.action(internal.weatherArchive.backfillWeatherCells, {
      tier: 'filter',
    });
    // One page covers this corpus, so `done` is true and pruning is legitimate here; the guard is
    // asserted by the shape of the return rather than by contriving 500+ bodies.
    expect(partial.done).toBe(true);
    expect(partial.pruned).toBe(0);
  });
});

describe('weatherArchive: the reconciler is triggered by the import, not the clock', () => {
  /** Open and close an import run of a given kind. */
  async function runImport(
    t: ReturnType<typeof convexTest>,
    kind: 'canonical_water' | 'elevation' | 'lake_depth' | 'dedup_resolve',
    status: 'succeeded' | 'failed' = 'succeeded',
  ) {
    const runId = await t.run((ctx) =>
      ctx.runMutation(internal.importRuns.start, {
        kind,
        label: `${kind} test`,
        deployment: 'test',
        isProd: false,
      }),
    );
    await t.run((ctx) => ctx.runMutation(internal.importRuns.finish, { runId, status }));
    return runId;
  }

  /**
   * Reconciles the trigger scheduled, if any.
   *
   * Reads the scheduler queue rather than draining it on a clock: what `importRuns.finish` is
   * responsible for is *enqueuing* the reconcile at the right delay, and whether
   * `maybeSyncWeatherCells` then does its job is covered by its own tests. Asserting the queue keeps
   * the two failures distinguishable instead of collapsing them into one timing-dependent pass.
   */
  async function scheduledReconciles(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) => {
      const jobs = await ctx.db.system.query('_scheduled_functions').collect();
      return jobs.filter((j) => j.name.includes('maybeSyncWeatherCells'));
    });
  }

  test('a finished corpus import reconciles the registry', async () => {
    // The root cause of the P1: nothing re-derived the registry when the corpus changed, so the
    // cadence of a cron was standing in for the event that actually invalidates it.
    const t = convexTest(schema, modules);
    await seedBody(t);
    expect(await t.run((ctx) => ctx.db.query('weatherCells').collect())).toHaveLength(0);

    const before = Date.now();
    await runImport(t, 'canonical_water');
    const jobs = await scheduledReconciles(t);
    expect(jobs).toHaveLength(1);
    // Debounced, not immediate — a campaign of loaders must collapse into one walk.
    expect(jobs[0]?.scheduledTime).toBeGreaterThanOrEqual(before + RECONCILE_DEBOUNCE_MS);
    // And it carries the request time, which is what lets the debounce decide it is already covered.
    expect((jobs[0]?.args[0] as { requestedAt?: number })?.requestedAt).toBeGreaterThanOrEqual(
      before,
    );
  });

  test('an elevation pass counts, because elevation is IN the browse key', async () => {
    // `bodyWeatherCell(body, 'browse')` bands elevation at 100 m, so a pass that writes `elevationM`
    // moves cell keys just as surely as one that moves coordinates.
    const t = convexTest(schema, modules);
    await seedBody(t);
    await runImport(t, 'elevation');
    expect(await scheduledReconciles(t)).toHaveLength(1);
  });

  test('a pass that cannot move a cell key does not spend a corpus walk', async () => {
    // Depth writes fields the key does not read. Triggering here would cost ~170 MB to rediscover
    // identical keys.
    const t = convexTest(schema, modules);
    await seedBody(t);
    await runImport(t, 'lake_depth');
    expect(await scheduledReconciles(t)).toHaveLength(0);
  });

  test('a failed run does not trigger — the retry that succeeds will', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t);
    await runImport(t, 'canonical_water', 'failed');
    expect(await scheduledReconciles(t)).toHaveLength(0);
  });

  test('a campaign of several loaders collapses into one walk', async () => {
    // ⚠ The debounce invariant: a walk that STARTED at S has seen every body written before S, so a
    // request older than a completed run's start is already satisfied.
    const t = convexTest(schema, modules);
    await seedBody(t);
    await t.action(internal.weatherArchive.maybeSyncWeatherCells, {});
    const syncs = await t.run((ctx) => ctx.db.query('weatherCellSyncs').collect());
    expect(syncs).toHaveLength(2);
    expect(syncs.every((r) => r.completedAt !== undefined)).toBe(true);

    const res = await t.action(internal.weatherArchive.maybeSyncWeatherCells, {
      requestedAt: Math.min(...syncs.map((r) => r.startedAt)) - 1,
    });
    expect(res.skipped).toBe('already reconciled');
  });

  test('a request made after the last run is NOT skipped', async () => {
    // The error that would matter: a genuinely newer import must never be debounced away.
    const t = convexTest(schema, modules);
    await seedBody(t);
    await t.action(internal.weatherArchive.maybeSyncWeatherCells, {});
    const syncs = await t.run((ctx) => ctx.db.query('weatherCellSyncs').collect());

    const res = await t.action(internal.weatherArchive.maybeSyncWeatherCells, {
      requestedAt: Math.max(...syncs.map((r) => r.startedAt)) + 1,
    });
    expect(res.skipped).toBeUndefined();
    expect(res.tiers).toHaveLength(2);
  });

  test('a completed walk records when it STARTED, not a cell stamp', async () => {
    // The bug this fixes: `updatedAt` is written per page with that page's own clock, so sampling a
    // cell could hand the debounce a timestamp from anywhere inside the run.
    const t = convexTest(schema, modules);
    await seedBody(t);
    const before = Date.now();
    await t.action(internal.weatherArchive.maybeSyncWeatherCells, {});
    const after = Date.now();

    for (const row of await t.run((ctx) => ctx.db.query('weatherCellSyncs').collect())) {
      expect(row.startedAt).toBeGreaterThanOrEqual(before);
      expect(row.completedAt ?? 0).toBeGreaterThanOrEqual(row.startedAt);
      expect(row.completedAt ?? 0).toBeLessThanOrEqual(after);
    }
  });

  test('an abandoned walk leaves no completion, so the next request is not debounced away', async () => {
    // A claim without a `completedAt` must never satisfy anything on its own once it is stale — the
    // failure mode being a deploy that kills a walk mid-flight and wedges the debounce for ever.
    const t = convexTest(schema, modules);
    await seedBody(t);
    await t.run((ctx) =>
      ctx.db.insert('weatherCellSyncs', {
        tier: 'filter',
        runId: 'abandoned',
        startedAt: Date.now() - SYNC_ASSUMED_DEAD_MS - 1,
      }),
    );
    const res = await t.action(internal.weatherArchive.maybeSyncWeatherCells, {
      requestedAt: Date.now() - SYNC_ASSUMED_DEAD_MS,
    });
    expect(res.skipped).toBeUndefined();
  });

  test('a superseded run writes nothing — the registry-destroying case', async () => {
    // ⚠ Two concurrent walks each see the other's rows as foreign, so both `pruneVacatedCells` calls
    // would fire and take turns deleting the whole registry. Ownership is a single `runId`, checked
    // in the same transaction as the write so a run cannot be displaced between the two.
    const t = convexTest(schema, modules);
    await seedBody(t);
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    const registered = await t.run((ctx) => ctx.db.query('weatherCells').collect());
    expect(registered.length).toBeGreaterThan(0);

    // A newer run claims the tier; a page of the older one now tries to land.
    await t.mutation(internal.weatherArchive.beginCellSync, {
      tier: 'filter',
      runId: 'newer',
      startedAt: Date.now(),
    });
    const res = await t.mutation(internal.weatherArchive.upsertWeatherCells, {
      tier: 'filter',
      runId: 'older',
      nowMs: Date.now(),
      cells: [{ cellKey: 'intruder', lat: 1, lng: 2, bodyCount: 99 }],
    });
    expect(res.superseded).toBe(true);

    // Nothing of the older run's landed, and what was already there is untouched.
    const after = await t.run((ctx) => ctx.db.query('weatherCells').collect());
    expect(after.map((c) => c.cellKey)).not.toContain('intruder');
    expect(after).toHaveLength(registered.length);
  });

  test('the owning run still writes normally', async () => {
    // The other half of the guard: it must reject only foreign runs, not every run.
    const t = convexTest(schema, modules);
    await t.mutation(internal.weatherArchive.beginCellSync, {
      tier: 'filter',
      runId: 'mine',
      startedAt: Date.now(),
    });
    const res = await t.mutation(internal.weatherArchive.upsertWeatherCells, {
      tier: 'filter',
      runId: 'mine',
      nowMs: Date.now(),
      cells: [{ cellKey: 'ok', lat: 1, lng: 2, bodyCount: 1 }],
    });
    expect(res.superseded).toBe(false);
    const after = await t.run((ctx) => ctx.db.query('weatherCells').collect());
    expect(after.map((c) => c.cellKey)).toContain('ok');
  });

  test('a straggler cannot backdate the registry guarantee', async () => {
    // `finishCellSync` from a displaced run would otherwise stamp `completedAt` against its own older
    // `startedAt`, telling the debounce the corpus is fresher than any walk has actually proved.
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.mutation(internal.weatherArchive.beginCellSync, {
      tier: 'filter',
      runId: 'newer',
      startedAt: now,
    });
    await t.mutation(internal.weatherArchive.finishCellSync, {
      tier: 'filter',
      runId: 'older',
      completedAt: now + 5,
    });
    const [row] = await t.run((ctx) => ctx.db.query('weatherCellSyncs').collect());
    expect(row?.completedAt).toBeUndefined();
    expect(row?.runId).toBe('newer');
  });
});

describe('reconcileSatisfiedBy — the debounce rule, stated directly', () => {
  const R = 1_000_000;
  const state = (tier: 'filter' | 'browse', startedAt: number | null, completedAt: number | null) =>
    ({ tier, startedAt, completedAt }) as const;

  test('a run that started before the request never satisfies it', () => {
    // ⚠ **The exact bug Greptile caught.** This run *completed* well after the request and would have
    // passed the old rule, but it began before those bodies were written — a paginated walk may have
    // read past them long before they existed.
    expect(
      reconcileSatisfiedBy(
        [state('filter', R - 1, R + 10_000), state('browse', R - 1, R + 10_000)],
        R,
        R + 20_000,
      ),
    ).toBe(false);
  });

  test('a completed run that started at or after the request satisfies it', () => {
    expect(
      reconcileSatisfiedBy([state('filter', R, R + 5), state('browse', R + 1, R + 6)], R, R + 10),
    ).toBe(true);
  });

  test('an in-flight run started after the request satisfies it — this is what collapses a campaign', () => {
    // Five loaders finishing minutes apart would otherwise each supersede the last, and a long
    // enough campaign would restart the walk for ever without completing one.
    expect(
      reconcileSatisfiedBy([state('filter', R + 1, null), state('browse', R + 1, null)], R, R + 60),
    ).toBe(true);
  });

  test('an in-flight run stops counting once it is old enough to be dead', () => {
    expect(
      reconcileSatisfiedBy(
        [state('filter', R + 1, null), state('browse', R + 1, null)],
        R,
        R + 1 + SYNC_ASSUMED_DEAD_MS,
      ),
    ).toBe(false);
  });

  test('every tier must be satisfied, not just one', () => {
    // The tiers are walked independently, so one being fresh says nothing about the other.
    expect(
      reconcileSatisfiedBy(
        [state('filter', R + 1, R + 2), state('browse', R - 1, R + 2)],
        R,
        R + 5,
      ),
    ).toBe(false);
  });

  test('a tier that has never been walked satisfies nothing', () => {
    expect(
      reconcileSatisfiedBy([state('filter', R + 1, R + 2), state('browse', null, null)], R, R + 5),
    ).toBe(false);
    expect(reconcileSatisfiedBy([], R, R + 5)).toBe(false);
  });
});

describe('weatherArchive: hourly rows for the timeline (N6h Workstream D)', () => {
  test('a browse-tier ingest stores the hours the day reducer would have discarded', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const dates = recentDates(3);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(isoResponse(dates))),
    );

    const result = await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, {
      waterBodyId,
      days: 3,
    });

    const rows = await t.run((ctx) => ctx.db.query('weatherHours').collect());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.hours).toHaveLength(24);
    // Local hour is stored per hour rather than implied by position — the DST requirement.
    expect(rows[0]?.hours[0]?.localHour).toBe(0);
    expect(rows[0]?.hours[23]?.localHour).toBe(23);
    // And the action serves them, so one drawer-open is one round trip.
    expect(result?.hours.length).toBeGreaterThan(0);
  });

  test('carries the weather code through to storage', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    vi.stubGlobal(
      'fetch',
      // 66 = freezing rain. The whole reason the twelfth variable is worth 9%.
      vi.fn(async () =>
        okJson(isoResponse(recentDates(2), { codeFor: (i) => (i === 5 ? 66 : 0) })),
      ),
    );

    await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, { waterBodyId, days: 2 });

    const rows = await t.run((ctx) => ctx.db.query('weatherHours').collect());
    const codes = rows.flatMap((r) => r.hours.map((h) => h.weatherCode));
    expect(codes).toContain(66);
  });

  test('the corpus-wide filter sweep stores NO hourly rows', async () => {
    // ⚠ The cost decision, pinned. `filter` covers ~3,043 cells swept daily; nothing corpus-wide asks
    // an hourly question, so storing them there would write thousands of rows a day for ever to serve
    // a chart nobody opened. If this ever starts passing hours through, the archive grows without
    // bound and nothing else fails.
    const t = convexTest(schema, modules);
    await seedBody(t);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(isoResponse(recentDates(3)))),
    );

    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    await t.action(internal.weatherArchive.refreshTierDays, { tier: 'filter' });

    expect(await t.run((ctx) => ctx.db.query('weatherDays').collect())).not.toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('weatherHours').collect())).toHaveLength(0);
  });

  test('backfills hours for a cell that already had every daily row', async () => {
    // ⚠ **The silent-blank trap, and the reason this test is worth more than the three above.**
    // The top-up branch used to key only on daily rows, so a cell somebody had already opened
    // satisfied it for ever: complete archive ⇒ no refetch ⇒ no hourly row, permanently, on exactly
    // the popular lakes. Nothing logged, nothing thrown, chart simply empty.
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const dates = recentDates(3);

    const fetchMock = vi.fn(async () => okJson(isoResponse(dates)));
    vi.stubGlobal('fetch', fetchMock);
    await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, { waterBodyId, days: 3 });

    // Simulate the pre-Workstream-D world: daily rows present, hourly rows absent.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('weatherHours').collect()) await ctx.db.delete(row._id);
    });
    expect(await t.run((ctx) => ctx.db.query('weatherHours').collect())).toHaveLength(0);

    fetchMock.mockClear();
    const result = await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, {
      waterBodyId,
      days: 3,
    });

    expect(fetchMock).toHaveBeenCalled(); // it noticed, rather than trusting the healthy daily half
    expect(await t.run((ctx) => ctx.db.query('weatherHours').collect())).not.toHaveLength(0);
    // Served on the same open that discovered the shortfall, not the next one.
    expect(result?.hours.length).toBeGreaterThan(0);
  });

  test('is idempotent on (cellKey, dayMs) — a re-open does not duplicate a day', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(isoResponse(recentDates(3)))),
    );

    await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, { waterBodyId, days: 3 });
    const first = await t.run((ctx) => ctx.db.query('weatherHours').collect());
    await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, { waterBodyId, days: 3 });
    const second = await t.run((ctx) => ctx.db.query('weatherHours').collect());

    expect(second).toHaveLength(first.length);
    const keys = second.map((r) => `${r.cellKey}:${r.dayMs}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('weatherArchive: the hourly row version (N6h Workstream D)', () => {
  test('rewrites rows written by an older generation of the writer', async () => {
    // ⚠ The second appearance of the same shape. The first was hourly rows missing entirely; this is
    // rows that exist but predate a newly-added field. Both are invisible — nothing errors, the
    // feature simply never shows up, and only on cells someone had already opened.
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const dates = recentDates(3);
    const fetchMock = vi.fn(async () => okJson(isoResponse(dates)));
    vi.stubGlobal('fetch', fetchMock);

    await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, { waterBodyId, days: 3 });

    // Age every stored row back to the pre-stamp generation.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('weatherHours').collect()) {
        await ctx.db.patch(row._id, { version: undefined });
      }
    });

    fetchMock.mockClear();
    await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, { waterBodyId, days: 3 });

    expect(fetchMock).toHaveBeenCalled();
    const rows = await t.run((ctx) => ctx.db.query('weatherHours').collect());
    expect(rows.every((r) => r.version === HOURLY_ROW_VERSION)).toBe(true);
  });

  test('leaves current rows alone — the check is staleness, not a refetch on every open', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    const fetchMock = vi.fn(async () => okJson(isoResponse(recentDates(3))));
    vi.stubGlobal('fetch', fetchMock);

    await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, { waterBodyId, days: 3 });
    fetchMock.mockClear();
    await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, { waterBodyId, days: 3 });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('stores the wind bearing the readout names', async () => {
    const t = convexTest(schema, modules);
    const waterBodyId = await seedBody(t);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(isoResponse(recentDates(2), { dirFor: () => 315 }))),
    );

    await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, { waterBodyId, days: 2 });

    const rows = await t.run((ctx) => ctx.db.query('weatherHours').collect());
    expect(rows[0]?.hours[0]?.windDirectionDeg).toBe(315);
  });
});

describe('weatherArchive: one response, one offset — but many dates', () => {
  test('stamps each date with the offset THAT DATE was on, not the response-wide one', async () => {
    // ⚠ **The bug.** Open-Meteo returns a single `utc_offset_seconds` for a whole response, and the
    // ingest wrote it onto every day row — so a 92-day backfill run in July gave every January row
    // EDT. The D160 calibration then read those as date-specific offsets and was an hour out for half
    // the archive, which near local midnight moves the calendar date and shifts a 60-day window.
    //
    // Written through `upsertWeatherDays` directly rather than a fetch, because the defect is in how
    // one response's offset is spread across dates, not in the fetching.
    const t = convexTest(schema, modules);
    const days = [
      { dayMs: Date.UTC(2025, 0, 15), localDate: '2025-01-15' }, // EST
      { dayMs: Date.UTC(2025, 6, 15), localDate: '2025-07-15' }, // EDT
    ];
    await t.mutation(internal.weatherArchive.upsertWeatherDays, {
      cellKey: 'c1',
      tier: 'browse' as const,
      source: 'forecast' as const,
      fetchedAt: Date.now(),
      // As if fetched in July: one offset, EDT, for the whole span.
      utcOffsetSeconds: -4 * 3600,
      timeZone: 'America/New_York',
      days,
    });

    const rows = await t.run((ctx) => ctx.db.query('weatherDays').collect());
    const jan = rows.find((r) => r.localDate === '2025-01-15');
    const jul = rows.find((r) => r.localDate === '2025-07-15');
    expect(jan?.utcOffsetSeconds).toBe(-5 * 3600); // NOT the response's −4
    expect(jul?.utcOffsetSeconds).toBe(-4 * 3600);
    expect(jan?.timeZone).toBe('America/New_York');
  });

  test('falls back to the response-wide offset when no zone came back', async () => {
    // Older Open-Meteo behaviour, or a response we could not read a zone from. One number for every
    // date is wrong-ish, and it is still better than nothing — but it must not claim a zone.
    const t = convexTest(schema, modules);
    await t.mutation(internal.weatherArchive.upsertWeatherDays, {
      cellKey: 'c2',
      tier: 'browse' as const,
      source: 'forecast' as const,
      fetchedAt: Date.now(),
      utcOffsetSeconds: -4 * 3600,
      days: [{ dayMs: Date.UTC(2025, 0, 15), localDate: '2025-01-15' }],
    });
    const row = (await t.run((ctx) => ctx.db.query('weatherDays').collect()))[0];
    expect(row?.utcOffsetSeconds).toBe(-4 * 3600);
    expect(row?.timeZone).toBeUndefined();
  });
});

describe('weatherArchive: a bay is its own place (N6h open question 5)', () => {
  /** A named bay of `parent`, with its own on-water point — far enough away to land in another cell. */
  async function seedBay(
    t: ReturnType<typeof convexTest>,
    parent: Id<'waterBodies'>,
    name: string,
    point: { lat: number; lng: number },
    over: { displayScore?: number; removedAt?: number } = {},
  ): Promise<Id<'waterBodySubAreas'>> {
    const author = (await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: `mod-${name}`,
        displayName: name,
        username: `mod-${name}`.toLowerCase().replace(/\s/g, ''),
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: {
          activityDetected: true,
          bountyRequest: true,
          hazardConfirmation: true,
          bountyFulfilled: true,
          reportRated: true,
          reportCommented: true,
          contentFlagResolved: true,
          favoriteReport: true,
          nearbyReportDigest: false,
          greatReportNearby: false,
        },
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'moderator' as const,
        status: 'active' as const,
        createdAt: Date.now(),
      }),
    )) as Id<'profiles'>;
    return t.run((ctx) =>
      ctx.db.insert('waterBodySubAreas', {
        waterBodyId: parent,
        name,
        searchText: name,
        polygon: square(0.01),
        bbox: {
          minLat: point.lat - 0.01,
          minLng: point.lng - 0.01,
          maxLat: point.lat + 0.01,
          maxLng: point.lng + 0.01,
        },
        centroid: point,
        surfaceAreaSqM: 1_000_000,
        displayScore: over.displayScore ?? 1,
        minVisibleZoom: 10,
        createdByUserId: author,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...(over.removedAt === undefined ? {} : { removedAt: over.removedAt }),
      }),
    ) as Promise<Id<'waterBodySubAreas'>>;
  }

  // Champlain's shape: an anchor mid-lake, and a bay ~55 km north of it. 0.05° cells, so these are
  // many cells apart at either tier.
  const ANCHOR = { lat: 44.25, lng: -73.35 };
  const BAY = { lat: 44.75, lng: -73.2 };

  test("reads the bay's own cell, names it, and drops the whole-lake caveat", async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, ANCHOR, 30);
    const bay = await seedBay(t, lake, 'Malletts Bay', BAY);
    const fetchMock = vi.fn(async (_url: string) => okJson(isoResponse(recentDates(3))));
    vi.stubGlobal('fetch', fetchMock);

    const result = await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, {
      waterBodyId: lake,
      subAreaId: bay,
      days: 3,
    });
    expect(result?.scope).toEqual({ kind: 'subArea', subAreaId: bay, name: 'Malletts Bay' });
    expect(result?.oneSampleForALargeBody).toBe(false);
    // The request went to the bay, not to the lake's anchor: Open-Meteo was asked for the bay's cell.
    const asked = Number(
      new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('latitude'),
    );
    expect(asked).toBeCloseTo(BAY.lat, 1);
    expect(asked).not.toBeCloseTo(ANCHOR.lat, 1);

    // And the two are different archive rows: opening the lake afterwards pays for its own cell.
    await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, {
      waterBodyId: lake,
      days: 3,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a bay carries no fetch profile — the profile is the lake's, and a sheltered bay is not the lake", async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, ANCHOR, 30);
    await t.run((ctx) => ctx.db.patch(lake, { fetchProfileM: Array(16).fill(11_000) }));
    const bay = await seedBay(t, lake, 'Shelburne Bay', BAY);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(isoResponse(recentDates(3)))),
    );

    const forBay = await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, {
      waterBodyId: lake,
      subAreaId: bay,
      days: 3,
    });
    const forLake = await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, {
      waterBodyId: lake,
      days: 3,
    });
    expect(forBay?.fetchProfileM).toBeUndefined();
    expect(forLake?.fetchProfileM).toHaveLength(16);
  });

  test('a delisted or foreign bay id answers for the lake rather than erroring', async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, ANCHOR, 30);
    // Champlain-sized, so the whole-lake caveat has something to say.
    await t.run((ctx) =>
      ctx.db.patch(lake, { bbox: { minLat: 44.0, minLng: -73.4, maxLat: 44.5, maxLng: -73.3 } }),
    );
    const other = await seedBody(t, { lat: 45.0, lng: -70.0 }, 200);
    const gone = await seedBay(t, lake, 'Old Cove', BAY, { removedAt: Date.now() });
    const foreign = await seedBay(t, other, 'Elsewhere Bay', { lat: 45.05, lng: -70.05 });
    const fetchMock = vi.fn(async () => okJson(isoResponse(recentDates(3))));
    vi.stubGlobal('fetch', fetchMock);

    for (const subAreaId of [gone, foreign]) {
      const result = await asViewer(t).action(api.weatherArchive.getWeatherDaysForBody, {
        waterBodyId: lake,
        subAreaId,
        days: 3,
      });
      expect(result?.scope).toEqual({ kind: 'body' });
      // Refused ids still describe the lake — and so still flag that the lake is too big for one point.
      expect(result?.oneSampleForALargeBody).toBe(true);
    }
    // Both answered from the lake's one cell: one fetch, not two.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("the registry registers a bay's cell, and a complete walk does not prune it", async () => {
    // ⚠ A mid-lake bay can sit in a cell no body's anchor occupies. Without this pass the Tier-B sweep
    // never fills that cell and the gap repair never visits it — the spread has a hole exactly where
    // the reader looks, and a lost browse-tier day is never even recorded missing.
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, ANCHOR, 30);
    await seedBay(t, lake, 'Broad Lake', BAY);
    const res = await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    await t.finishInProgressScheduledFunctions();

    expect(res.done).toBe(true);
    expect(res.pruned).toBe(0);
    // One body and one bay, two cells: the bodies-only walk would have produced one.
    expect(res.scanned).toBe(2);
    const cells = await t.run((ctx) => ctx.db.query('weatherCells').collect());
    expect(cells).toHaveLength(2);
    expect(cells.every((c) => c.bodyCount === 1)).toBe(true);

    // A second complete walk sees the bay again and keeps its cell — it is "seen this run".
    const again = await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
    await t.finishInProgressScheduledFunctions();
    expect(again.pruned).toBe(0);
    expect(await t.run((ctx) => ctx.db.query('weatherCells').collect())).toHaveLength(2);
  });

  test('a delisted bay, or one whose lake is gone, is not registered', async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, ANCHOR, 30);
    await seedBay(t, lake, 'Old Cove', BAY, { removedAt: Date.now() });
    const goneLake = await seedBody(t, { lat: 45.0, lng: -70.0 }, 200);
    await seedBay(t, goneLake, 'Orphan Bay', { lat: 45.4, lng: -70.4 });
    await t.run((ctx) => ctx.db.patch(goneLake, { removedAt: Date.now() }));

    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'browse' });
    await t.finishInProgressScheduledFunctions();
    const cells = await t.run((ctx) => ctx.db.query('weatherCells').collect());
    expect(cells).toHaveLength(1);
  });
});

describe('weatherArchive: the sub-area spread reads Tier B (N6h open question 5)', () => {
  const ANCHOR = { lat: 44.25, lng: -73.35 };
  const NORTH = { lat: 44.95, lng: -73.15 };
  const SOUTH = { lat: 43.65, lng: -73.4 };

  async function seedBay(
    t: ReturnType<typeof convexTest>,
    parent: Id<'waterBodies'>,
    name: string,
    point: { lat: number; lng: number },
  ): Promise<Id<'waterBodySubAreas'>> {
    const author = (await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: `mod-${name}`,
        displayName: name,
        username: `m-${name}`.toLowerCase().replace(/\s/g, ''),
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: {
          activityDetected: true,
          bountyRequest: true,
          hazardConfirmation: true,
          bountyFulfilled: true,
          reportRated: true,
          reportCommented: true,
          contentFlagResolved: true,
          favoriteReport: true,
          nearbyReportDigest: false,
          greatReportNearby: false,
        },
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        role: 'moderator' as const,
        status: 'active' as const,
        createdAt: Date.now(),
      }),
    )) as Id<'profiles'>;
    return t.run((ctx) =>
      ctx.db.insert('waterBodySubAreas', {
        waterBodyId: parent,
        name,
        searchText: name,
        polygon: square(0.01),
        bbox: {
          minLat: point.lat - 0.01,
          minLng: point.lng - 0.01,
          maxLat: point.lat + 0.01,
          maxLng: point.lng + 0.01,
        },
        centroid: point,
        surfaceAreaSqM: 1_000_000,
        displayScore: 1,
        minVisibleZoom: 10,
        createdByUserId: author,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    ) as Promise<Id<'waterBodySubAreas'>>;
  }

  /** Seed `n` settled filter-tier days ending yesterday (UTC) for the cell at `point`. */
  async function seedFilterDays(
    t: ReturnType<typeof convexTest>,
    point: { lat: number; lng: number },
    n: number,
    over: {
      nightMinTempC: number;
      snowfallCm?: number;
      skipNewest?: boolean;
      missingNewest?: boolean;
    },
  ) {
    const cell = weatherCellFor('filter', point.lat, point.lng);
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    for (let i = 1; i <= n; i++) {
      if (over.skipNewest && i === 1) continue;
      const dayMs = today - i * DAY_MS;
      const missing = over.missingNewest === true && i === 1;
      await t.run((ctx) =>
        ctx.db.insert('weatherDays', {
          cellKey: cell.key,
          tier: 'filter' as const,
          dayMs,
          localDate: new Date(dayMs).toISOString().slice(0, 10),
          source: 'forecast' as const,
          timeZone: 'UTC',
          fetchedAt: Date.now(),
          ...(missing
            ? { missing: true }
            : {
                hours: 24,
                nightMinTempC: over.nightMinTempC,
                minTempC: over.nightMinTempC + 1,
                snowfallCm: over.snowfallCm ?? 0,
              }),
        }),
      );
    }
  }

  test('ranks the bays over the shared filter-tier days and names the ends', async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, ANCHOR, 30);
    await seedBay(t, lake, 'North Bay', NORTH);
    await seedBay(t, lake, 'South Bay', SOUTH);
    await seedFilterDays(t, NORTH, 7, { nightMinTempC: -18 });
    await seedFilterDays(t, SOUTH, 7, { nightMinTempC: -8, snowfallCm: 10 });

    const spread = await asViewer(t).query(api.weatherArchive.getSubAreaSpread, {
      waterBodyId: lake,
    });
    expect(spread?.bays).toBe(2);
    expect(spread?.days).toBe(7);
    expect(spread?.similar).toBe(false);
    expect(spread?.lines.map((l) => l.text)).toEqual([
      'Lows 0°F to 18°F — coldest at North Bay, mildest at South Bay',
      // 10 cm on each of the seven days: the total over the window, not the last day's.
      'Snow in the last 7 days: none at North Bay, 27.6 in at South Bay',
    ]);
  });

  test('drops the in-progress today and a recorded gap, and compares only the days both bays have', async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, ANCHOR, 30);
    await seedBay(t, lake, 'North Bay', NORTH);
    await seedBay(t, lake, 'South Bay', SOUTH);
    // North's newest day is a gap marker; South is complete. The intersection is six days.
    await seedFilterDays(t, NORTH, 7, { nightMinTempC: -18, missingNewest: true });
    await seedFilterDays(t, SOUTH, 7, { nightMinTempC: -8 });
    // Today, still in progress, must not count even with a full-looking row.
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    await t.run((ctx) =>
      ctx.db.insert('weatherDays', {
        cellKey: weatherCellFor('filter', SOUTH.lat, SOUTH.lng).key,
        tier: 'filter' as const,
        dayMs: today,
        localDate: new Date(today).toISOString().slice(0, 10),
        source: 'forecast' as const,
        timeZone: 'UTC',
        fetchedAt: Date.now(),
        hours: 24,
        nightMinTempC: -30,
        snowfallCm: 50,
      }),
    );

    const spread = await asViewer(t).query(api.weatherArchive.getSubAreaSpread, {
      waterBodyId: lake,
    });
    expect(spread?.days).toBe(6);
    // The forecast-valued today did not sneak −30 °C or 50 cm into the ranking.
    expect(spread?.lines.find((l) => l.kind === 'snow')?.text).toBe(
      'No snow at any bay in the last 6 days',
    );
  });

  test('is null with fewer than two bays, when Tier B is empty, and to a signed-out caller', async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, ANCHOR, 30);
    await seedBay(t, lake, 'Only Bay', NORTH);
    await seedFilterDays(t, NORTH, 7, { nightMinTempC: -18 });
    expect(
      await asViewer(t).query(api.weatherArchive.getSubAreaSpread, { waterBodyId: lake }),
    ).toBeNull();

    await seedBay(t, lake, 'South Bay', SOUTH);
    // South has no Tier-B rows yet (pre-season): no comparison, not a comparison against zeroes.
    expect(
      await asViewer(t).query(api.weatherArchive.getSubAreaSpread, { waterBodyId: lake }),
    ).toBeNull();
    expect(await t.query(api.weatherArchive.getSubAreaSpread, { waterBodyId: lake })).toBeNull();
  });

  test("primeSubAreaWeather fills the bays' filter cells out of season, once per cell", async () => {
    const t = convexTest(schema, modules);
    const lake = await seedBody(t, ANCHOR, 30);
    await seedBay(t, lake, 'North Bay', NORTH);
    await seedBay(t, lake, 'Also North', { lat: NORTH.lat + 0.01, lng: NORTH.lng + 0.01 });
    await seedBay(t, lake, 'South Bay', SOUTH);
    const fetchMock = vi.fn(async () => okJson(isoResponse(recentDates(5))));
    vi.stubGlobal('fetch', fetchMock);

    const res = await t.action(internal.weatherArchive.primeSubAreaWeather, {
      waterBodyId: lake,
      pastDays: 5,
    });
    // Two bays share a 0.1° cell: three bays, two cells, two fetches.
    expect(res.cells).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const rows = await t.run((ctx) => ctx.db.query('weatherDays').collect());
    expect(rows.every((r) => r.tier === 'filter')).toBe(true);
    expect(new Set(rows.map((r) => r.cellKey)).size).toBe(2);
  });
});
