/**
 * Weather-first discovery (N6h Workstream E / D159, D164, D165, D166): the join the registry walk
 * writes, the digest the sweep rebuilds, and the two reads over them.
 */

import { DIGEST_MAX_AGE_DAYS, weatherCellFor } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const DAY_MS = 86_400_000;
const today = () => Math.floor(Date.now() / DAY_MS) * DAY_MS;

function square(half: number, at = { lat: 0, lng: 0 }): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [at.lng - half, at.lat - half],
        [at.lng + half, at.lat - half],
        [at.lng + half, at.lat + half],
        [at.lng - half, at.lat + half],
        [at.lng - half, at.lat - half],
      ],
    ],
  };
}

const NOTIF_PREFS = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyAnswered: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: false,
  greatReportNearby: false,
};

async function seedUser(t: ReturnType<typeof convexTest>, subject: string, role = 'member') {
  const id = (await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: role as 'member' | 'moderator',
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  )) as Id<'profiles'>;
  return { id, as: t.withIdentity({ subject }) };
}

async function seedBody(
  t: ReturnType<typeof convexTest>,
  name: string,
  at: { lat: number; lng: number },
  over: Record<string, unknown> = {},
): Promise<Id<'waterBodies'>> {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name,
      searchText: name,
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: square(0.01, at),
      bbox: {
        minLat: at.lat - 0.01,
        minLng: at.lng - 0.01,
        maxLat: at.lat + 0.01,
        maxLng: at.lng + 0.01,
      },
      centroid: at,
      interiorPoint: at,
      states: ['VT'],
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
      elevationM: 300,
      ...over,
    }),
  ) as Promise<Id<'waterBodies'>>;
}

async function seedBay(
  t: ReturnType<typeof convexTest>,
  author: Id<'profiles'>,
  parent: Id<'waterBodies'>,
  name: string,
  point: { lat: number; lng: number },
): Promise<Id<'waterBodySubAreas'>> {
  return t.run((ctx) =>
    ctx.db.insert('waterBodySubAreas', {
      waterBodyId: parent,
      name,
      searchText: name,
      polygon: square(0.01, point),
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

/**
 * Seed settled filter-tier days for the cell at `point`, newest = yesterday (UTC; the rows carry
 * `timeZone: 'UTC'` so the cell's "today" is the UTC one). `nights` is oldest-first: a number is the
 * night's minimum in °C, `null` an unobserved night, `'gap'` a recorded missing day.
 */
async function seedNights(
  t: ReturnType<typeof convexTest>,
  point: { lat: number; lng: number },
  nights: (number | null | 'gap')[],
  snow: Record<number, number> = {},
) {
  const cell = weatherCellFor('filter', point.lat, point.lng);
  const n = nights.length;
  for (let i = 0; i < n; i++) {
    const dayMs = today() - (n - i) * DAY_MS;
    const night = nights[i] ?? null;
    await t.run((ctx) =>
      ctx.db.insert('weatherDays', {
        cellKey: cell.key,
        tier: 'filter' as const,
        dayMs,
        localDate: new Date(dayMs).toISOString().slice(0, 10),
        source: 'forecast' as const,
        timeZone: 'UTC',
        fetchedAt: Date.now(),
        ...(night === 'gap'
          ? { missing: true }
          : {
              hours: 24,
              ...(typeof night === 'number' ? { nightMinTempC: night, minTempC: night + 1 } : {}),
              snowfallCm: snow[i] ?? 0,
            }),
      }),
    );
  }
  return cell;
}

async function rebuild(t: ReturnType<typeof convexTest>, point: { lat: number; lng: number }) {
  const cell = weatherCellFor('filter', point.lat, point.lng);
  return t.mutation(internal.weatherArchive.rebuildCellDigest, {
    cellKey: cell.key,
    lat: cell.lat,
    lng: cell.lng,
    nowMs: Date.now(),
  });
}

async function walk(t: ReturnType<typeof convexTest>) {
  await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
  await t.finishInProgressScheduledFunctions();
}

// Three lakes in three distinct 0.1° cells, and a giant with two bays in two more.
const A = { lat: 44.05, lng: -72.05 };
const B = { lat: 44.55, lng: -72.55 };
const C = { lat: 45.05, lng: -73.05 };
const GIANT = { lat: 44.25, lng: -73.35 };
const NORTH = { lat: 44.95, lng: -73.15 };
const SOUTH = { lat: 43.65, lng: -73.4 };

describe('the registry walk writes the discovery join', () => {
  test('one row per listed body and one per live bay, pruned on the same run-id rule', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const a = await seedBody(t, 'Lake A', A);
    const giant = await seedBody(t, 'Giant', GIANT);
    await seedBay(t, mod.id, giant, 'North Bay', NORTH);
    // Not joinable: merged, rejected, and removed bodies are not places discovery may name.
    await seedBody(t, 'Merged', B, { mergedIntoId: a, dedupStatus: 'merged' });
    await seedBody(t, 'Rejected', C, { reviewStatus: 'rejected' });
    await walk(t);

    const rows = await t.run((ctx) => ctx.db.query('bodyWeatherCells').collect());
    expect(rows.map((r) => [r.waterBodyId, r.isBay]).sort()).toEqual(
      [
        [a, false],
        [giant, false],
        [giant, true],
      ].sort(),
    );
    expect(rows.find((r) => r.isBay)?.cellKey).toBe(
      weatherCellFor('filter', NORTH.lat, NORTH.lng).key,
    );

    // A body delisted between walks is pruned; the survivor keeps its row.
    await t.run((ctx) => ctx.db.patch(a, { removedAt: Date.now() }));
    await walk(t);
    const after = await t.run((ctx) => ctx.db.query('bodyWeatherCells').collect());
    expect(after.map((r) => r.waterBodyId)).toEqual([giant, giant]);
  });

  test('the browse-tier walk writes no memberships', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t, 'Lake A', A);
    await t.action(internal.weatherArchive.backfillWeatherCells, { tier: 'browse' });
    await t.finishInProgressScheduledFunctions();
    expect(await t.run((ctx) => ctx.db.query('bodyWeatherCells').collect())).toHaveLength(0);
  });
});

describe('the digest (D165)', () => {
  test('reduces a cell’s complete days to indexed chain lengths, as of the newest complete day', async () => {
    const t = convexTest(schema, modules);
    await seedNights(t, A, [2, -14, -14, -14, -2]);
    const res = await rebuild(t, A);
    expect(res.asOfDayMs).toBe(today() - DAY_MS);
    const digest = await t.run((ctx) => ctx.db.query('weatherCellDigests').first());
    expect(digest?.nightsBelow32F).toBe(4);
    expect(digest?.nightsBelow20F).toBe(3);
    expect(digest?.nightsBelow0F).toBe(0);
    expect(digest?.daysKnown).toBe(5);
    expect(digest?.lat).toBe(weatherCellFor('filter', A.lat, A.lng).lat);
  });

  test('ignores today’s partial row and drops a recorded gap rather than reading it as warm', async () => {
    const t = convexTest(schema, modules);
    const cell = await seedNights(t, A, [-14, -14, 'gap', -14]);
    // Today, mid-afternoon: 24 hours present because the forecast filled them.
    await t.run((ctx) =>
      ctx.db.insert('weatherDays', {
        cellKey: cell.key,
        tier: 'filter' as const,
        dayMs: today(),
        localDate: new Date(today()).toISOString().slice(0, 10),
        source: 'forecast' as const,
        timeZone: 'UTC',
        fetchedAt: Date.now(),
        hours: 24,
        nightMinTempC: -30,
        snowfallCm: 0,
      }),
    );
    await rebuild(t, A);
    const digest = await t.run((ctx) => ctx.db.query('weatherCellDigests').first());
    expect(digest?.asOfDayMs).toBe(today() - DAY_MS);
    // The gap consumed the 48 h tolerance; the chain is three nights, not four and not one.
    expect(digest?.nightsBelow20F).toBe(3);
    expect(digest?.nightsBelow0F).toBe(0); // today's −30 never reached it
  });

  test('a cell with no complete day has no digest row at all', async () => {
    const t = convexTest(schema, modules);
    await seedNights(t, A, ['gap', 'gap']);
    await rebuild(t, A);
    expect(await t.run((ctx) => ctx.db.query('weatherCellDigests').collect())).toHaveLength(0);
    // And a digest that existed is removed when its days go.
    await seedNights(t, B, [-14, -14]);
    await rebuild(t, B);
    expect(await t.run((ctx) => ctx.db.query('weatherCellDigests').collect())).toHaveLength(1);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('weatherDays').collect()) await ctx.db.delete(row._id);
    });
    await rebuild(t, B);
    expect(await t.run((ctx) => ctx.db.query('weatherCellDigests').collect())).toHaveLength(0);
  });

  test('the filter sweep rebuilds the digest after each cell it ingests', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t, 'Lake A', A);
    await walk(t);
    const dates: string[] = [];
    for (let i = 3; i >= 0; i--) {
      dates.push(new Date(today() - i * DAY_MS).toISOString().slice(0, 10));
    }
    const time: string[] = [];
    for (const d of dates)
      for (let h = 0; h < 24; h++) time.push(`${d}T${String(h).padStart(2, '0')}:00`);
    const n = time.length;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              timezone: 'UTC',
              utc_offset_seconds: 0,
              hourly: {
                time,
                temperature_2m: new Array(n).fill(-14),
                precipitation: new Array(n).fill(0),
                rain: new Array(n).fill(0),
                snowfall: new Array(n).fill(0),
                snow_depth: new Array(n).fill(0),
                wind_speed_10m: new Array(n).fill(3),
                wind_gusts_10m: new Array(n).fill(4),
                wind_direction_10m: new Array(n).fill(0),
                cloud_cover: new Array(n).fill(50),
                sunshine_duration: new Array(n).fill(0),
                shortwave_radiation: new Array(n).fill(0),
                weather_code: new Array(n).fill(0),
              },
            }),
            { status: 200 },
          ),
      ),
    );
    await t.action(internal.weatherArchive.refreshTierDays, { tier: 'filter', pastDays: 3 });
    await t.finishInProgressScheduledFunctions();
    const digest = await t.run((ctx) => ctx.db.query('weatherCellDigests').first());
    expect(digest).not.toBeNull();
    expect(digest?.nightsBelow20F).toBeGreaterThan(0);
  });

  test('the operator rebuild covers every registered filter cell', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t, 'Lake A', A);
    await seedBody(t, 'Lake B', B);
    await walk(t);
    await seedNights(t, A, [-14, -14]);
    await seedNights(t, B, [-14]);
    const res = await t.action(internal.weatherArchive.rebuildFilterDigests, {});
    await t.finishInProgressScheduledFunctions();
    expect(res.done).toBe(true);
    expect(await t.run((ctx) => ctx.db.query('weatherCellDigests').collect())).toHaveLength(2);
  });
});

describe('a digest the sweep stopped updating is not an answer (Greptile, PR #54)', () => {
  /** Move a digest's as-of back `days` — what the season's close does to every row, slowly. */
  async function age(t: ReturnType<typeof convexTest>, days: number) {
    await t.run(async (ctx) => {
      for (const d of await ctx.db.query('weatherCellDigests').collect()) {
        await ctx.db.patch(d._id, { asOfDayMs: d.asOfDayMs - days * DAY_MS });
      }
    });
  }

  test('a stale digest matches nothing, gates nothing, and narrows nothing', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'author');
    const cold = await seedBody(t, 'Cold', A);
    await walk(t);
    await seedNights(t, A, [-14, -14, -14]);
    await rebuild(t, A);
    const filters = { weather: { thresholdF: 20, minNights: 3 } };
    await author.as.mutation(api.reports.create, {
      waterBodyId: cold,
      skateEndTime: Date.now() - 60 * 60 * 1000,
    });

    // Fresh: everything answers.
    expect((await t.query(api.weatherDiscovery.status, {})).available).toBe(true);
    expect((await t.query(api.weatherDiscovery.listBodyResults, { filters })).results).toHaveLength(
      1,
    );
    expect((await t.query(api.weatherDiscovery.matchedCells, { filters })).cellKeys).toHaveLength(
      1,
    );
    expect(
      (
        await t.query(api.reports.listFeed, {
          paginationOpts: { numItems: 10, cursor: null },
          filters,
        })
      ).page,
    ).toHaveLength(1);

    // Aged past the freshness window — the season closed, or the sweep died: nothing answers, and the
    // knobs go back to "no weather data".
    await age(t, DIGEST_MAX_AGE_DAYS + 1);
    expect((await t.query(api.weatherDiscovery.status, {})).available).toBe(false);
    expect((await t.query(api.weatherDiscovery.listBodyResults, { filters })).results).toHaveLength(
      0,
    );
    expect((await t.query(api.weatherDiscovery.matchedCells, { filters })).cellKeys).toHaveLength(
      0,
    );
    expect(
      (
        await t.query(api.reports.listFeed, {
          paginationOpts: { numItems: 10, cursor: null },
          filters,
        })
      ).page,
    ).toHaveLength(0);
  });

  test('a digest inside the window still answers — a missed tick is not a closed season', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t, 'Cold', A);
    await walk(t);
    await seedNights(t, A, [-14, -14, -14]);
    await rebuild(t, A);
    await age(t, DIGEST_MAX_AGE_DAYS - 1);
    const filters = { weather: { thresholdF: 20, minNights: 3 } };
    expect((await t.query(api.weatherDiscovery.status, {})).available).toBe(true);
    expect((await t.query(api.weatherDiscovery.listBodyResults, { filters })).results).toHaveLength(
      1,
    );
  });
});

describe('the join refuses a superseded walk (Greptile, PR #54)', () => {
  test('a page from a run that lost the tier writes nothing', async () => {
    const t = convexTest(schema, modules);
    const a = await seedBody(t, 'Lake A', A);
    await walk(t); // run 1 owns the tier and stamped A's row
    const before = await t.run((ctx) => ctx.db.query('bodyWeatherCells').first());
    // A newer walk claims the tier; a late page of the old run then tries to land.
    await t.mutation(internal.weatherArchive.beginCellSync, {
      tier: 'filter',
      runId: 'newer-run',
      startedAt: Date.now(),
    });
    const res = await t.mutation(internal.weatherArchive.upsertBodyWeatherCells, {
      runId: before?.runId ?? 'old',
      nowMs: Date.now(),
      members: [{ cellKey: 'f:stale-key', waterBodyId: a }],
    });
    expect(res.superseded).toBe(true);
    const after = await t.run((ctx) => ctx.db.query('bodyWeatherCells').first());
    expect(after?.cellKey).toBe(before?.cellKey);
    expect(after?.runId).toBe(before?.runId);
  });
});

describe('matchedCells — the map read (D166)', () => {
  test('returns the matched cell keys and the lakes matched through a bay', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    await seedBody(t, 'Lake A', A);
    const giant = await seedBody(t, 'Giant', GIANT);
    await seedBay(t, mod.id, giant, 'North Bay', NORTH);
    await walk(t);
    await seedNights(t, A, [-14, -14, -14]);
    await seedNights(t, NORTH, [-14, -14, -14]);
    await seedNights(t, GIANT, [-2, -2, -2]); // the mid-lake cell is milder
    for (const p of [A, NORTH, GIANT]) await rebuild(t, p);

    const res = await t.query(api.weatherDiscovery.matchedCells, {
      filters: { weather: { thresholdF: 20, minNights: 3 } },
    });
    expect(res.cellKeys.sort()).toEqual(
      [
        weatherCellFor('filter', A.lat, A.lng).key,
        weatherCellFor('filter', NORTH.lat, NORTH.lng).key,
      ].sort(),
    );
    expect(res.bayBodyIds).toEqual([giant]);
    expect(res.asOfDayMs).toBe(today() - DAY_MS);

    // Without a weather filter there is nothing to dim by.
    const none = await t.query(api.weatherDiscovery.matchedCells, {
      filters: { radiusMinutes: 30 },
    });
    expect(none).toEqual({ cellKeys: [], bayBodyIds: [], asOfDayMs: null });
  });
});

describe('listBodyResults — the feed read (D165)', () => {
  test('orders by the day the chain reached the requested length, newest first', async () => {
    const t = convexTest(schema, modules);
    const a = await seedBody(t, 'Lake A', A);
    const b = await seedBody(t, 'Lake B', B);
    const c = await seedBody(t, 'Lake C', C);
    await walk(t);
    await seedNights(t, A, [-14, -14, -14, -14, -14]); // reached 3 nights three days ago
    await seedNights(t, B, [2, 2, -14, -14, -14]); // reached 3 nights yesterday
    await seedNights(t, C, [2, 2, 2, -14, -14]); // only 2
    for (const p of [A, B, C]) await rebuild(t, p);

    const res = await t.query(api.weatherDiscovery.listBodyResults, {
      filters: { weather: { thresholdF: 20, minNights: 3 } },
    });
    expect(res.exhausted).toBe(true);
    expect(res.results.map((r) => r.waterBodyId)).toEqual([b, a]);
    expect(res.results[0]?.eventDayMs).toBe(today() - DAY_MS);
    expect(res.results[1]?.eventDayMs).toBe(today() - 3 * DAY_MS);
    expect(res.results[0]?.chain.nights).toBe(3);
    expect(res.results[1]?.chain.nights).toBe(5);
    expect(res.results[0]?.place).toEqual({ kind: 'body' });
    expect(res.results[0]?.states).toEqual(['VT']);
    expect(c).toBeTruthy();
  });

  test('a giant matched through its bays gets one card, naming the bay it was read at', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const giant = await seedBody(t, 'Giant', GIANT);
    const north = await seedBay(t, mod.id, giant, 'North Bay', NORTH);
    await seedBay(t, mod.id, giant, 'South Bay', SOUTH);
    await walk(t);
    await seedNights(t, NORTH, [2, -14, -14, -14]); // reached 3 yesterday
    await seedNights(t, SOUTH, [-14, -14, -14, -14]); // reached 3 two days ago
    await seedNights(t, GIANT, [2, 2, 2, 2]);
    for (const p of [NORTH, SOUTH, GIANT]) await rebuild(t, p);

    const res = await t.query(api.weatherDiscovery.listBodyResults, {
      filters: { weather: { thresholdF: 20, minNights: 3 } },
    });
    expect(res.results).toHaveLength(1);
    const card = res.results[0];
    expect(card?.place).toEqual({ kind: 'subArea', subAreaId: north, name: 'North Bay' });
    expect(card?.otherBayNames).toEqual(['South Bay']);
    expect(card?.oneSampleForALargeBody).toBe(false);
  });

  test('applies the drive-time radius to bodies, favorites exempt, and "no snow since"', async () => {
    const t = convexTest(schema, modules);
    const viewer = await seedUser(t, 'viewer');
    const near = await seedBody(t, 'Near', A);
    const far = await seedBody(t, 'Far', C);
    await walk(t);
    await seedNights(t, A, [-14, -14, -14]);
    await seedNights(t, C, [-14, -14, -14], { 2: 5 }); // 5 cm inside the chain
    for (const p of [A, C]) await rebuild(t, p);
    await t.run((ctx) =>
      ctx.db.patch(viewer.id, {
        homeCoord: A,
        cachedIsochrones: { band30: square(0.2, A) },
        outerRadiusMeters: 30_000,
      }),
    );

    const within = await viewer.as.query(api.weatherDiscovery.listBodyResults, {
      filters: { weather: { thresholdF: 20, minNights: 3 }, radiusMinutes: 30 },
    });
    expect(within.results.map((r) => r.waterBodyId)).toEqual([near]);

    // A favorite outside the radius is exempt from it — but the cell pre-test only reaches cells
    // near home, so the favorite has to be inside the outer box. Widen it for the assertion.
    await t.run((ctx) => ctx.db.patch(viewer.id, { outerRadiusMeters: 300_000 }));
    await viewer.as.mutation(api.waterBodyFavorites.toggle, { waterBodyId: far });
    const withFav = await viewer.as.query(api.weatherDiscovery.listBodyResults, {
      filters: { weather: { thresholdF: 20, minNights: 3 }, radiusMinutes: 30 },
    });
    expect(withFav.results.map((r) => r.waterBodyId).sort()).toEqual([near, far].sort());
    expect(withFav.results.find((r) => r.waterBodyId === far)?.isFavorite).toBe(true);

    // "No snow since" drops the lake that got 5 cm inside its chain.
    const clean = await t.query(api.weatherDiscovery.listBodyResults, {
      filters: { weather: { thresholdF: 20, minNights: 3, noSnowSince: true } },
    });
    expect(clean.results.map((r) => r.waterBodyId)).toEqual([near]);

    // A signed-out reader with a radius set has no band: nothing passes, nothing throws.
    const anon = await t.query(api.weatherDiscovery.listBodyResults, {
      filters: { weather: { thresholdF: 20, minNights: 3 }, radiusMinutes: 30 },
    });
    expect(anon.results).toEqual([]);
  });

  test('leaves unnamed water out of the list, as the sidebar does', async () => {
    const t = convexTest(schema, modules);
    const named = await seedBody(t, 'Named Pond', A);
    await seedBody(t, '', B);
    await walk(t);
    await seedNights(t, A, [-14, -14, -14]);
    await seedNights(t, B, [-14, -14, -14]);
    for (const p of [A, B]) await rebuild(t, p);
    const res = await t.query(api.weatherDiscovery.listBodyResults, {
      filters: { weather: { thresholdF: 20, minNights: 3 } },
    });
    expect(res.results.map((r) => r.waterBodyId)).toEqual([named]);
    // The map still dims by cell, so the unnamed pond's cell is in the matched set.
    const cells = await t.query(api.weatherDiscovery.matchedCells, {
      filters: { weather: { thresholdF: 20, minNights: 3 } },
    });
    expect(cells.cellKeys).toContain(weatherCellFor('filter', B.lat, B.lng).key);
  });

  test('stops at the cap and says so', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t, 'Lake A', A);
    await seedBody(t, 'Lake B', B);
    await walk(t);
    await seedNights(t, A, [-14, -14, -14]);
    await seedNights(t, B, [-14, -14, -14]);
    for (const p of [A, B]) await rebuild(t, p);
    const res = await t.query(api.weatherDiscovery.listBodyResults, {
      filters: { weather: { thresholdF: 20, minNights: 3 } },
      limit: 1,
    });
    expect(res.results).toHaveLength(1);
    expect(res.exhausted).toBe(false);
  });

  test('marks a no-public-access lake rather than dropping it (call 22)', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    await seedBody(t, 'Posted', A, {
      publicAccess: { verdict: 'none', decidedByUserId: mod.id, decidedAt: Date.now() },
    });
    await walk(t);
    await seedNights(t, A, [-14, -14, -14]);
    await rebuild(t, A);
    const res = await t.query(api.weatherDiscovery.listBodyResults, {
      filters: { weather: { thresholdF: 20, minNights: 3 } },
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.noPublicAccess).toBe(true);
  });
});

describe('reports.listFeed under a weather filter (D165)', () => {
  test('narrows reports to lakes whose cell matches, and drops those nobody checked', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'author');
    const cold = await seedBody(t, 'Cold', A);
    const mild = await seedBody(t, 'Mild', B);
    const unswept = await seedBody(t, 'Unswept', C);
    await seedNights(t, A, [-14, -14, -14]);
    await seedNights(t, B, [2, 2, 2]);
    for (const p of [A, B]) await rebuild(t, p);
    const now = Date.now();
    const coldReport = await author.as.mutation(api.reports.create, {
      waterBodyId: cold,
      skateEndTime: now - 3 * 60 * 60 * 1000,
    });
    await author.as.mutation(api.reports.create, {
      waterBodyId: mild,
      skateEndTime: now - 2 * 60 * 60 * 1000,
    });
    await author.as.mutation(api.reports.create, {
      waterBodyId: unswept,
      skateEndTime: now - 60 * 60 * 1000,
    });

    const all = await t.query(api.reports.listFeed, {
      paginationOpts: { numItems: 10, cursor: null },
      filters: {},
    });
    expect(all.page).toHaveLength(3);

    const narrowed = await t.query(api.reports.listFeed, {
      paginationOpts: { numItems: 10, cursor: null },
      filters: { weather: { thresholdF: 20, minNights: 3 } },
    });
    expect(narrowed.page.map((c) => c.reportId)).toEqual([coldReport]);
  });
});

describe('the spread’s bay rankings (call 9)', () => {
  test('sorts bays by chain length and by window snow, off the digest and the shared days', async () => {
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const giant = await seedBody(t, 'Giant', GIANT);
    const north = await seedBay(t, mod.id, giant, 'North Bay', NORTH);
    const south = await seedBay(t, mod.id, giant, 'South Bay', SOUTH);
    await seedNights(t, NORTH, [-14, -14, -14, -14, -14, -14, -14]);
    await seedNights(t, SOUTH, [-2, -2, -2, -2, -14, -14, -14], { 3: 4 });
    for (const p of [NORTH, SOUTH]) await rebuild(t, p);

    const spread = await mod.as.query(api.weatherArchive.getSubAreaSpread, { waterBodyId: giant });
    expect(spread?.rankings?.coldestNights?.bays.map((b) => [b.subAreaId, b.value])).toEqual([
      [north, '7 nights'],
      [south, '3 nights'],
    ]);
    expect(spread?.rankings?.leastSnow?.bays.map((b) => [b.subAreaId, b.value])).toEqual([
      [north, 'none'],
      [south, '1.6 in'],
    ]);
  });
});
