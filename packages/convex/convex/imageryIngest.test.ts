import { DEFAULT_SEASON_WATCH_SETTINGS, fahrenheitToCelsius } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/**
 * The season watch's daily tick (D149; A06i / D212–D213): the lifecycle, the emails it queues and
 * the roster it samples.
 *
 * ⚠ **This file exists because the checker once had no tests at all**, and a recorded `opensOn`
 * short-circuited every later tick — the `closesOn` that `ingestWindow` computed was never persisted
 * and nothing downstream could ever stand down. The lifecycle tests below are that regression.
 */

const square = (d: number, lat = 44.0163): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [-72.0331 - d, lat - d],
      [-72.0331 + d, lat - d],
      [-72.0331 + d, lat + d],
      [-72.0331 - d, lat + d],
      [-72.0331 - d, lat - d],
    ],
  ],
});

type T = ReturnType<typeof convexTest>;

/** A named, listed body. `boost` puts it in the ordinary sample; a roster name makes it a sentinel. */
async function seedBody(
  t: T,
  name: string,
  lat: number,
  opts: { state?: string; boost?: number } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert('waterBodies', {
      name,
      searchText: name,
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: square(0.001, lat),
      bbox: { minLat: lat - 0.001, minLng: -72.04, maxLat: lat + 0.001, maxLng: -72.02 },
      centroid: { lat, lng: -72.0331 },
      interiorPoint: { lat, lng: -72.0331 },
      ...(opts.state ? { states: [opts.state] } : {}),
      dedupStatus: 'clean' as const,
      ...(opts.boost !== undefined ? { curatedBoost: opts.boost } : {}),
      createdAt: Date.now(),
    }),
  );
}

/** `count` ordinary boosted lakes at 44.0163 + i·0.1. */
async function seedSites(t: T, count = 3) {
  for (let i = 0; i < count; i++)
    await seedBody(t, `Gate Lake ${i}`, 44.0163 + i * 0.1, { boost: 10 - i });
}

const SUMMIT_LAT = 44.258;
async function seedSentinel(t: T) {
  return await seedBody(t, 'Upper Lake of the Clouds', SUMMIT_LAT, { state: 'NH' });
}

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * One site's Open-Meteo hourly row: 24 UTC hours a day from `start`, each at that day's low (`null`
 * is a missing reading). The watcher cuts the days itself (`dailyLowsFromOpenMeteo`).
 */
function hourlyRow(start: string, lows: (number | null)[]) {
  const base = Date.parse(`${start}T00:00:00Z`) / 1000;
  return {
    timezone: 'UTC',
    utc_offset_seconds: 0,
    hourly: {
      time: lows.flatMap((_, d) =>
        Array.from({ length: 24 }, (_, h) => base + (d * 24 + h) * 3600),
      ),
      temperature_2m: lows.flatMap((low) => new Array<number | null>(24).fill(low)),
    },
  };
}

/**
 * An Open-Meteo stub answering each requested coordinate by latitude: `summit` for the sentinel,
 * `valley` for everything else. One object per site, as the multi-coordinate form returns.
 */
const EAGLE_LAT = 44.16;

function stubLows(
  start: string,
  valley: number[],
  summit: number[] = valley,
  eagle: number[] = summit,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const lats = (new URL(url).searchParams.get('latitude') ?? '').split(',');
      return okJson(
        lats.map((lat) => {
          const at = Number(lat).toFixed(3);
          const lows =
            at === SUMMIT_LAT.toFixed(3) ? summit : at === EAGLE_LAT.toFixed(3) ? eagle : valley;
          return hourlyRow(start, lows);
        }),
      );
    }),
  );
}

/**
 * The checker's floor reads the real clock, so a test pins the clock **and** dates its fixtures to
 * match. ⚠ Both dates sit inside one season label: D63's boundary is July, so December 2026 and
 * April 2027 are both `winter-2026-27`.
 */
const IN_SEASON = '2026-12-15';
const IN_SPRING = '2027-04-30';
const atDate = (iso: string, hour = 17) =>
  vi.setSystemTime(new Date(`${iso}T${String(hour).padStart(2, '0')}:00:00Z`));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tickNow = (t: T) => t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});
const theRow = (t: T) => t.run((ctx) => ctx.db.query('imageryIngestSeasons').first());

async function broadcasts(t: T) {
  return t.run(async (ctx) => {
    const jobs = await ctx.db.system.query('_scheduled_functions').collect();
    return jobs
      .filter((j) => j.name.includes('broadcastToStaff'))
      .map(
        (j) =>
          j.args[0] as {
            subject: string;
            heading: string;
            blocks: { kind: string }[];
            roles?: string[];
          },
      );
  });
}

describe('maybeCheckSeasonOpen — the season lifecycle', () => {
  test('does nothing before the floor', async () => {
    vi.useFakeTimers();
    atDate('2026-08-15');
    const t = convexTest(schema, modules);
    await seedSites(t);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await tickNow(t)).toMatchObject({ skipped: 'before the floor' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a later floor in the settings postpones the watch', async () => {
    vi.useFakeTimers();
    atDate('2026-10-20');
    const t = convexTest(schema, modules);
    await seedSites(t);
    await t.mutation(internal.seasonWatch.ensureSettings, {});
    await t.run((ctx) =>
      ctx.db.insert('seasonWatchSettings', {
        version: 2,
        settings: { ...DEFAULT_SEASON_WATCH_SETTINGS, startMonthDay: '11-01' },
        sentinels: [],
        pinned: [],
        savedAt: Date.now(),
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await tickNow(t)).toMatchObject({ skipped: 'before the floor' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('records the open, keeps the lows, then keeps ticking to look for the close', async () => {
    vi.useFakeTimers();
    atDate(IN_SEASON);
    const t = convexTest(schema, modules);
    await seedSites(t);

    // A cold December: every site freezes, so the corpus signal fires and winter establishes.
    stubLows('2026-12-01', [2, -1, -3, -4, -5]);
    expect(await tickNow(t)).toMatchObject({ open: true, opensOn: '2026-12-02' });

    const row = await theRow(t);
    expect(row).toMatchObject({
      openedBy: ['corpus'],
      winterFrom: '2026-12-02',
      settingsVersion: 1,
      settings: DEFAULT_SEASON_WATCH_SETTINGS,
      opening: { sentinels: [], corpus: { frozen: 3, reporting: 3 } },
    });
    expect(row?.winter?.frozen).toHaveLength(3);

    // The lows are kept, one document per site, from the forecast endpoint's observed past days.
    const series = await t.run((ctx) => ctx.db.query('seasonWatchSeries').collect());
    expect(series).toHaveLength(3);
    expect(series[0]).toMatchObject({
      season: 'winter-2026-27',
      source: 'forecast',
      firstDate: '2026-12-01',
    });
    expect(series[0]?.lows).toEqual([2, -1, -3, -4, -5]);

    // ⚠ The regression this file exists for. A second tick must NOT report "already recorded" —
    // the row has an open date and no close date, so there is still work to do.
    const again = await tickNow(t);
    expect(again).toMatchObject({ open: true });
  });

  test("cuts days at the lake's midnight from hourly readings, not Open-Meteo's daily ones", async () => {
    // `daily=temperature_2m_min` cuts every day at the request-time offset, so a November tick split
    // every October day an hour wrong. The watcher asks for hours and cuts them by the zone.
    vi.useFakeTimers();
    atDate(IN_SEASON);
    const t = convexTest(schema, modules);
    await seedSites(t);
    // 23:00 EST on 1 Dec is 04:00Z on the 2nd: the freeze belongs to the 1st at the lake.
    const start = Date.UTC(2026, 11, 1, 5) / 1000;
    const time = Array.from({ length: 48 }, (_, h) => start + h * 3600);
    const temperature_2m = time.map((ts) => (ts === Date.UTC(2026, 11, 2, 4) / 1000 ? -6 : 3));
    const fetchMock = vi.fn(async (_url: string) =>
      okJson(
        Array.from({ length: 3 }, () => ({
          timezone: 'America/New_York',
          utc_offset_seconds: -5 * 3600,
          hourly: { time, temperature_2m },
        })),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await t.action(internal.imageryIngest.maybeCheckSeasonOpen, {});
    expect(result).toMatchObject({ open: true, opensOn: '2026-12-01' });
    const params = new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams;
    expect(params.get('hourly')).toBe('temperature_2m');
    expect(params.get('timeformat')).toBe('unixtime');
    expect(params.get('daily')).toBeNull();
    vi.useRealTimers();
  });

  test('closes the season on a sustained thaw, against the RECORDED winterFrom', async () => {
    vi.useFakeTimers();
    atDate(IN_SEASON);
    const t = convexTest(schema, modules);
    await seedSites(t);
    stubLows('2026-12-01', [2, -1, -3, -4, -5]);
    await tickNow(t);

    // April: the fetch window no longer reaches December, but the stored lows and the recorded
    // winterFrom do — the close is measured from the date the region froze.
    atDate(IN_SPRING);
    stubLows(
      '2027-04-01',
      Array.from({ length: 20 }, () => 8),
    );
    expect(await tickNow(t)).toMatchObject({ closed: true, closesOn: '2027-04-10' });
    const row = await theRow(t);
    expect(row?.closesOn).toBe('2027-04-10');
    expect(row?.closedAt).toBeTypeOf('number');

    // Closed is final within a season: a later tick neither reopens it nor moves the date.
    stubLows(
      '2027-05-01',
      Array.from({ length: 20 }, () => 9),
    );
    expect(await tickNow(t)).toMatchObject({ skipped: 'already recorded' });
    expect((await theRow(t))?.closesOn).toBe('2027-04-10');
  });

  test('a legacy row is stamped with the defaults, its opening night filled, and winter found later', async () => {
    vi.useFakeTimers();
    atDate(IN_SEASON);
    const t = convexTest(schema, modules);
    await seedSites(t, 2);
    const summit = await seedSentinel(t);
    const eagle = await seedBody(t, 'Eagle Lake', EAGLE_LAT, { state: 'NH' });
    // ⚠ **The normal October state.** A sentinel opens a season weeks before a majority of ordinary
    // sites freeze, and the opening is insert-only — so if nothing revisits `winterFrom` the row can
    // never close, and imagery and the D161 sweep run all summer.
    await t.run((ctx) =>
      ctx.db.insert('imageryIngestSeasons', {
        season: 'winter-2026-27',
        opensOn: '2026-12-02',
        openedBy: ['sentinel'],
        winterFrom: null,
        sitesSampled: 3,
        detectedAt: Date.parse('2026-12-03T20:00:00Z'),
      }),
    );

    // Still no region-wide freeze: the tick stands down, but fills in what it can.
    stubLows('2026-12-01', [6, 6, 6, 6, 6], [3, -0.4, -2, -3, -4], [3, -1.5, 0, 0, 0]);
    expect(await tickNow(t)).toMatchObject({ skipped: 'already recorded' });
    const stamped = await theRow(t);
    expect(stamped).toMatchObject({
      winterFrom: null,
      // Version 0: the defaults it shipped with, before there were versions.
      settingsVersion: 0,
      // Its opening email already went, as the old message: stamped so the queue never re-sends it.
      emailsSent: [{ kind: 'opened', sentOn: '2026-12-03' }],
      opening: {
        // Both sentinels that fired, coldest first.
        sentinels: [
          { waterBodyId: eagle, name: 'Eagle Lake', state: 'NH', lowC: -1.5 },
          { waterBodyId: summit, name: 'Upper Lake of the Clouds', state: 'NH', lowC: -0.4 },
        ],
        corpus: { frozen: 0, reporting: 2 },
      },
    });

    // The region freezes. Ice-in arrives *after* opening, so it has to be writable after opening.
    atDate('2026-12-16');
    stubLows('2026-12-01', [2, 2, 2, 2, 2, 2, 2, 2, -1, -3]);
    expect(await tickNow(t)).toMatchObject({ open: true, opensOn: '2026-12-02' });
    const row = await theRow(t);
    expect(row?.winterFrom).toBe('2026-12-09');
    expect(row?.opensOn).toBe('2026-12-02');

    // A one-way door: a later window does not re-date ice-in.
    stubLows('2026-12-01', [-5, -5, -5]);
    await tickNow(t);
    expect((await theRow(t))?.winterFrom).toBe('2026-12-09');
  });

  test('a legacy winter gets its detail filled, and no late email', async () => {
    vi.useFakeTimers();
    atDate(IN_SEASON);
    const t = convexTest(schema, modules);
    await seedSites(t, 2);
    await t.run((ctx) =>
      ctx.db.insert('imageryIngestSeasons', {
        season: 'winter-2026-27',
        opensOn: '2026-12-01',
        openedBy: ['corpus'],
        winterFrom: '2026-12-02',
        sitesSampled: 2,
        detectedAt: Date.parse('2026-12-02T20:00:00Z'),
      }),
    );
    stubLows('2026-12-01', [3, -1, 4, 4, 4]);
    await tickNow(t);
    const row = await theRow(t);
    expect(row?.winter).toEqual({
      frozen: [
        expect.objectContaining({ name: 'Gate Lake 0', lowC: -1 }),
        expect.objectContaining({ name: 'Gate Lake 1', lowC: -1 }),
      ],
      reporting: 2,
    });
    expect(row?.emailQueue ?? []).toEqual([]);
    // Once only, and never on a row without a winter.
    expect(
      await t.mutation(internal.imageryIngest.recordWinterDetail, {
        season: 'winter-2026-27',
        frozen: [],
        reporting: 0,
      }),
    ).toBeNull();
  });

  test('sentinelNights holds the opening until one summit stays cold', async () => {
    vi.useFakeTimers();
    atDate('2026-10-10');
    const t = convexTest(schema, modules);
    await seedSites(t, 2);
    await seedSentinel(t);
    const config = await t.mutation(internal.seasonWatch.ensureSettings, {});
    await t.run((ctx) =>
      ctx.db.insert('seasonWatchSettings', {
        version: 2,
        settings: { ...DEFAULT_SEASON_WATCH_SETTINGS, sentinelNights: 3 },
        sentinels: config.sentinels,
        pinned: [],
        savedAt: Date.now(),
      }),
    );
    stubLows('2026-10-01', [9, 9, 9, 9, 9, 9, 9], [5, -1, 3, -1, -2, -3, 4]);
    expect(await tickNow(t)).toMatchObject({ open: true, opensOn: '2026-10-06' });
    expect((await theRow(t))?.settingsVersion).toBe(2);
  });

  test('records the first 20 °F sentinel night once, and queues the reminder', async () => {
    vi.useFakeTimers();
    atDate('2026-10-05');
    const t = convexTest(schema, modules);
    await seedSites(t, 2);
    await seedSentinel(t);
    stubLows('2026-10-01', [9, 9, 9, 9], [7, 3, -0.4, -2]);
    expect(await tickNow(t)).toMatchObject({ open: true, opensOn: '2026-10-03' });
    expect((await theRow(t))?.imageryNudgeOn).toBeUndefined();

    atDate('2026-10-07');
    stubLows('2026-10-01', [9, 9, 9, 9, 9, 9], [7, 3, -0.4, -2, -3.7, -7.1]);
    await tickNow(t);
    const row = await theRow(t);
    expect(row?.imageryNudgeOn).toBe('2026-10-06');
    expect(row?.imageryNudgeSites?.[0]?.lowC).toBe(-7.1);
  });

  test('stands down cleanly with nothing to sample, or nothing observed', async () => {
    vi.useFakeTimers();
    atDate(IN_SEASON);
    const empty = convexTest(schema, modules);
    vi.stubGlobal('fetch', vi.fn());
    expect(await tickNow(empty)).toMatchObject({ skipped: 'no sites' });

    const t = convexTest(schema, modules);
    await seedSites(t, 1);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson([hourlyRow('2026-12-01', [null])])),
    );
    expect(await tickNow(t)).toMatchObject({ skipped: 'no observations' });
  });

  test('a mild autumn opens nothing', async () => {
    vi.useFakeTimers();
    atDate('2026-10-05');
    const t = convexTest(schema, modules);
    await seedSites(t, 2);
    stubLows('2026-10-01', [9, 9, 9, 9]);
    expect(await tickNow(t)).toMatchObject({ open: false, sitesSampled: 2 });
    expect(await theRow(t)).toBeNull();
  });

  test('an Open-Meteo failure throws, and still lets a queued email go', async () => {
    vi.useFakeTimers();
    atDate(IN_SEASON);
    const t = convexTest(schema, modules);
    await seedSites(t, 1);
    await t.mutation(internal.seasonWatch.ensureSettings, {});
    await t.mutation(internal.imageryIngest.recordSeasonOpen, {
      season: 'winter-2026-27',
      opensOn: '2026-12-02',
      openedBy: ['corpus'],
      winterFrom: null,
      sitesSampled: 1,
      settingsVersion: 1,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503, statusText: 'Down' })),
    );
    await expect(tickNow(t)).rejects.toThrow(/Open-Meteo 503/);
    expect(await broadcasts(t)).toHaveLength(1);
  });
  test("today's low is a forecast, and is never stored or decided on", async () => {
    vi.useFakeTimers();
    atDate('2026-10-06');
    const t = convexTest(schema, modules);
    await seedSites(t, 1);
    await seedSentinel(t);
    // Through 6 October, the 6th being today: its 19 °F is a forecast for a night not yet over.
    stubLows('2026-10-01', [9, 9, 9, 9, 9, 9], [7, 3, -0.4, -0.2, -3.7, -7.1]);
    await tickNow(t);
    expect((await theRow(t))?.imageryNudgeOn).toBeUndefined();
    const summit = (await t.run((ctx) => ctx.db.query('seasonWatchSeries').collect())).find(
      (d) => d.name === 'Upper Lake of the Clouds',
    );
    expect(summit?.lows).toEqual([7, 3, -0.4, -0.2, -3.7]);
  });
});

describe('the staff emails — one a day, in order (D212)', () => {
  /** An active moderator and admin, plus two who must NOT be mailed. */
  async function seedStaff(t: T) {
    const base = {
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: {
        activityDetected: true,
        bountyRequest: true,
        hazardConfirmation: true,
        bountyAnswered: true,
        reportRated: true,
        reportCommented: true,
        contentFlagResolved: true,
        favoriteReport: true,
        nearbyReportDigest: true,
        greatReportNearby: true,
      },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      createdAt: Date.now(),
    };
    await t.run(async (ctx) => {
      await ctx.db.insert('profiles', {
        ...base,
        clerkUserId: 'mod-1',
        displayName: 'Mod',
        username: 'mod1',
        role: 'moderator' as const,
        status: 'active' as const,
      });
      await ctx.db.insert('profiles', {
        ...base,
        clerkUserId: 'admin-1',
        displayName: 'Admin',
        username: 'admin1',
        role: 'admin' as const,
        status: 'active' as const,
      });
      // ⚠ Keeps its role but must not be mailed — suspension and demotion are separate levers (D37).
      await ctx.db.insert('profiles', {
        ...base,
        clerkUserId: 'mod-suspended',
        displayName: 'Suspended Mod',
        username: 'modsus',
        role: 'moderator' as const,
        status: 'suspended' as const,
      });
      await ctx.db.insert('profiles', {
        ...base,
        clerkUserId: 'member-1',
        displayName: 'Member',
        username: 'member1',
        role: 'member' as const,
        status: 'active' as const,
      });
    });
  }

  test('the opening email goes the day it opens, names the sentinel, and goes once', async () => {
    vi.useFakeTimers();
    atDate('2026-10-04');
    const t = convexTest(schema, modules);
    await seedSites(t, 2);
    await seedSentinel(t);
    await seedStaff(t);
    stubLows('2026-10-01', [9, 9, 9, 9], [7, 3, -0.4, 1]);

    await tickNow(t);
    const sent = await broadcasts(t);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe('Winter 2026-27: Ice Watch Has Begun');
    expect(sent[0]?.heading).toBe('Ice watch began on Saturday, October 3');
    expect(JSON.stringify(sent[0]?.blocks)).toContain('Upper Lake of the Clouds, NH');
    expect(JSON.stringify(sent[0]?.blocks)).toContain('31.3°F (−0.4°C)');

    // The same day again: nothing further, and the row says what went when.
    await tickNow(t);
    expect(await broadcasts(t)).toHaveLength(1);
    expect((await theRow(t))?.emailsSent).toEqual([
      expect.objectContaining({ kind: 'opened', sentOn: '2026-10-04' }),
    ]);
  });

  test('two facts found on one tick go on two days', async () => {
    vi.useFakeTimers();
    atDate(IN_SEASON);
    const t = convexTest(schema, modules);
    await seedSites(t);
    await seedStaff(t);
    // Opens and establishes winter on the same night: the opening goes today, winter tomorrow.
    stubLows('2026-12-01', [2, -1, -3, -4, -5]);
    await tickNow(t);
    expect((await broadcasts(t)).map((b) => b.subject)).toEqual([
      'Winter 2026-27: Ice Watch Has Begun',
    ]);

    atDate('2026-12-16');
    await tickNow(t);
    expect((await broadcasts(t)).map((b) => b.subject)).toEqual([
      'Winter 2026-27: Ice Watch Has Begun',
      'Winter 2026-27: Winter Has Set In Region-Wide',
    ]);

    // Spring: the close is queued, and goes on the tick that found it (nothing else went that day).
    atDate(IN_SPRING);
    stubLows(
      '2027-04-01',
      Array.from({ length: 20 }, () => 8),
    );
    await tickNow(t);
    const subjects = (await broadcasts(t)).map((b) => b.subject);
    expect(subjects.at(-1)).toBe('Winter 2026-27: Ice Watch Has Ended');
    // And a later tick tells nobody again.
    atDate('2027-05-01');
    await tickNow(t);
    expect((await broadcasts(t)).filter((b) => b.subject.includes('Ended'))).toHaveLength(1);
  });

  test('an imagery reminder is dropped once imagery is running, without spending the day', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seasonWatch.ensureSettings, {});
    await t.mutation(internal.imageryIngest.recordSeasonOpen, {
      season: 'winter-2026-27',
      opensOn: '2026-10-03',
      openedBy: ['sentinel'],
      winterFrom: null,
      sitesSampled: 3,
      imageryNudge: { date: '2026-10-03', sites: [{ name: 'Upper Lake of the Clouds', lowC: -7 }] },
    });
    await t.mutation(internal.imageryIngest.sendNextEmail, { today: '2026-10-04' });
    const row = await theRow(t);
    await t.run((ctx) =>
      ctx.db.patch((row as { _id: Id<'imageryIngestSeasons'> })._id, {
        imageryStartedAt: Date.now(),
      }),
    );
    // The reminder is dropped; nothing else is queued, so nothing goes and the queue empties.
    expect(await t.mutation(internal.imageryIngest.sendNextEmail, { today: '2026-10-05' })).toEqual(
      {
        sent: null,
      },
    );
    expect((await theRow(t))?.emailQueue).toEqual([]);
    expect(await broadcasts(t)).toHaveLength(1);
  });

  test('a nudge recorded after imagery started queues nothing', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.imageryIngest.recordSeasonOpen, {
      season: 'winter-2026-27',
      opensOn: '2026-10-03',
      openedBy: ['sentinel'],
      winterFrom: null,
      sitesSampled: 3,
    });
    const row = await theRow(t);
    await t.run((ctx) =>
      ctx.db.patch((row as { _id: Id<'imageryIngestSeasons'> })._id, {
        imageryStartedAt: Date.now(),
        emailQueue: [],
      }),
    );
    await t.mutation(internal.imageryIngest.recordImageryNudge, {
      season: 'winter-2026-27',
      date: '2026-10-06',
      sites: [],
    });
    expect((await theRow(t))?.emailQueue).toEqual([]);
    // Once only.
    expect(
      await t.mutation(internal.imageryIngest.recordImageryNudge, {
        season: 'winter-2026-27',
        date: '2026-10-07',
        sites: [],
      }),
    ).toBeNull();
  });

  test('each email states the rule that decided it, not the one the season opened under', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seasonWatch.ensureSettings, {});
    await t.mutation(internal.imageryIngest.recordSeasonOpen, {
      season: 'winter-2026-27',
      opensOn: '2026-10-03',
      openedBy: ['sentinel'],
      winterFrom: null,
      sitesSampled: 3,
      settings: DEFAULT_SEASON_WATCH_SETTINGS, // the 20 °F imagery line
    });
    await t.mutation(internal.imageryIngest.sendNextEmail, { today: '2026-10-04' });
    // An admin raises the imagery line to 25 °F after the opening; a 24 °F night meets it.
    const raised = { ...DEFAULT_SEASON_WATCH_SETTINGS, imageryNudgeC: fahrenheitToCelsius(25) };
    await t.mutation(internal.imageryIngest.recordImageryNudge, {
      season: 'winter-2026-27',
      date: '2026-10-06',
      sites: [{ name: 'Eagle Lake', lowC: fahrenheitToCelsius(24) }],
      settings: raised,
    });
    expect(await t.mutation(internal.imageryIngest.sendNextEmail, { today: '2026-10-07' })).toEqual(
      { sent: 'imagery' },
    );
    const headings = (await broadcasts(t)).map((a) => a.heading);
    expect(headings.at(-1)).toBe('First 25°F night: Tuesday, October 6');
  });

  test('winter and the close carry the settings that decided them, for their emails', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.imageryIngest.recordSeasonOpen, {
      season: 'winter-2026-27',
      opensOn: '2026-10-03',
      openedBy: ['sentinel'],
      winterFrom: null,
      sitesSampled: 3,
      settings: DEFAULT_SEASON_WATCH_SETTINGS,
    });
    const later = { ...DEFAULT_SEASON_WATCH_SETTINGS, winterFraction: 0.75, thawRunDays: 14 };
    await t.mutation(internal.imageryIngest.recordSeasonWinterFrom, {
      season: 'winter-2026-27',
      winterFrom: '2026-11-20',
      frozen: [],
      reporting: 24,
      settings: later,
    });
    await t.mutation(internal.imageryIngest.recordSeasonClose, {
      season: 'winter-2026-27',
      closesOn: '2027-04-10',
      settings: later,
    });
    const queue = (await theRow(t))?.emailQueue ?? [];
    type Entry = { email: { kind: string }; settings?: { thawRunDays: number } };
    expect(queue.map((e: Entry) => [e.email.kind, e.settings?.thawRunDays])).toEqual([
      ['opened', DEFAULT_SEASON_WATCH_SETTINGS.thawRunDays],
      ['winter', 14],
      ['closed', 14],
    ]);
  });

  test("a reset the same day does not send a second email: the day's mark is not on the row", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seasonWatch.ensureSettings, {});
    const open = (opensOn: string) =>
      t.mutation(internal.imageryIngest.recordSeasonOpen, {
        season: 'winter-2026-27',
        opensOn,
        openedBy: ['sentinel'],
        winterFrom: null,
        sitesSampled: 3,
        settings: DEFAULT_SEASON_WATCH_SETTINGS,
      });
    await open('2026-10-03');
    expect(await t.mutation(internal.imageryIngest.sendNextEmail, { today: '2026-10-04' })).toEqual(
      { sent: 'opened' },
    );
    // Reset the same day — the row, and its lastEmailOn, move to the superseded table — and the
    // watch reopens at once.
    await t.run(async (ctx) => {
      const row = await ctx.db.query('imageryIngestSeasons').first();
      if (row) await ctx.db.delete(row._id);
    });
    await open('2026-10-03');
    expect(await t.mutation(internal.imageryIngest.sendNextEmail, { today: '2026-10-04' })).toEqual(
      { sent: null },
    );
    expect(await broadcasts(t)).toHaveLength(1);
    // The next day it goes.
    expect(await t.mutation(internal.imageryIngest.sendNextEmail, { today: '2026-10-05' })).toEqual(
      { sent: 'opened' },
    );
  });

  test('nothing is sent before any settings exist', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.imageryIngest.recordSeasonOpen, {
      season: 'winter-2026-27',
      opensOn: '2026-10-03',
      openedBy: ['corpus'],
      winterFrom: null,
      sitesSampled: 3,
    });
    expect(await t.mutation(internal.imageryIngest.sendNextEmail, { today: '2026-10-04' })).toEqual(
      {
        sent: null,
      },
    );
    expect((await theRow(t))?.emailQueue).toHaveLength(1);
  });

  test('a reopening after a reset says which notice it replaces', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seasonWatch.ensureSettings, {});
    const admin = await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: 'a',
        displayName: 'A',
        username: 'a',
        role: 'admin' as const,
        status: 'active' as const,
        driveTimePrefMinutes: 60,
        profileVisibility: 'public' as const,
        notificationPrefs: {
          activityDetected: true,
          bountyRequest: true,
          hazardConfirmation: true,
          bountyAnswered: true,
          reportRated: true,
          reportCommented: true,
          contentFlagResolved: true,
          favoriteReport: true,
          nearbyReportDigest: true,
          greatReportNearby: true,
        },
        dateOfBirth: Date.UTC(1990, 0, 1),
        reputationPoints: 0,
        createdAt: Date.now(),
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert('imageryIngestSeasonsSuperseded', {
        season: 'winter-2026-27',
        opensOn: '2026-10-03',
        openedBy: ['sentinel'],
        winterFrom: null,
        sitesSampled: 28,
        detectedAt: Date.parse('2026-10-04T20:46:00Z'),
        supersededAt: Date.now(),
        supersededBy: admin,
      }),
    );
    await t.mutation(internal.imageryIngest.recordSeasonOpen, {
      season: 'winter-2026-27',
      opensOn: '2026-11-04',
      openedBy: ['sentinel'],
      winterFrom: null,
      sitesSampled: 28,
    });
    const queued = (await theRow(t))?.emailQueue?.[0]?.email;
    expect(queued).toMatchObject({ kind: 'opened', replaces: { opensOn: '2026-10-03' } });
  });

  test('the record mutations are what actually make the emails once-only', async () => {
    // ⚠ Two ticks racing, which convex-test cannot schedule — so the guarantee is asserted where it
    // lives, in the writes, rather than assumed from control flow.
    const t = convexTest(schema, modules);
    const args = {
      season: 'winter-2026-27',
      opensOn: '2026-12-02',
      openedBy: ['corpus'],
      winterFrom: '2026-12-02',
      sitesSampled: 3,
    };
    const first = await t.mutation(internal.imageryIngest.recordSeasonOpen, args);
    const second = await t.mutation(internal.imageryIngest.recordSeasonOpen, args);
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });

    expect(
      await t.mutation(internal.imageryIngest.recordSeasonClose, {
        season: 'winter-2026-27',
        closesOn: '2027-04-10',
      }),
    ).not.toBeNull();
    expect(
      await t.mutation(internal.imageryIngest.recordSeasonClose, {
        season: 'winter-2026-27',
        closesOn: '2027-05-01',
      }),
    ).toBeNull();
    expect((await theRow(t))?.closesOn).toBe('2027-04-10');
    // Winter is already set on this row, and a missing row is refused, not created.
    expect(
      await t.mutation(internal.imageryIngest.recordSeasonWinterFrom, {
        season: 'winter-2026-27',
        winterFrom: '2026-12-09',
      }),
    ).toBeNull();
    expect(
      await t.mutation(internal.imageryIngest.recordSeasonWinterFrom, {
        season: 'winter-2030-31',
        winterFrom: '2030-12-09',
      }),
    ).toBeNull();
    expect(
      await t.mutation(internal.imageryIngest.recordSeasonClose, {
        season: 'winter-2030-31',
        closesOn: '2031-04-01',
      }),
    ).toBeNull();
    expect(
      await t.mutation(internal.imageryIngest.recordOpeningDetail, {
        season: 'winter-2030-31',
        sentinels: [],
        corpus: { frozen: 0, reporting: 0 },
      }),
    ).toBeNull();
  });

  test('the recipient list is active moderators and admins, and `roles` narrows it', async () => {
    const t = convexTest(schema, modules);
    await seedStaff(t);
    const staff = await t.query(internal.operatorAlerts.staffSubjects, {});
    expect(staff.map((s) => s.subject).sort()).toEqual(['admin-1', 'mod-1']);
    const admins = await t.query(internal.operatorAlerts.staffSubjects, { roles: ['admin'] });
    expect(admins.map((s) => s.subject)).toEqual(['admin-1']);
  });

  test('a broadcast with no configured staff is reported, not thrown', async () => {
    const t = convexTest(schema, modules);
    const res = await t.action(internal.operatorAlerts.broadcastToStaff, {
      subject: 's',
      heading: 'h',
      blocks: [{ kind: 'paragraph', text: 'x' }],
      deepLinkPath: '/admin',
    });
    expect(res).toEqual({ recipients: 0, sent: 0 });
  });

  test('a broadcast reports zero sent when Resend is unconfigured, without throwing', async () => {
    // ⚠ All Resend env vars ship unset. `sent` is what tells "nobody is configured" from "nobody was
    // told" — a silent void would let an unsent alert look delivered.
    const t = convexTest(schema, modules);
    await seedStaff(t);
    const res = await t.action(internal.operatorAlerts.broadcastToStaff, {
      subject: 's',
      heading: 'h',
      lines: ['x'],
      deepLinkPath: '/admin',
    });
    expect(res).toEqual({ recipients: 2, sent: 0 });
  });
});

describe('the roster — seeded by name, then held by id', () => {
  /** The roster the tick samples: settings version 1 seeded from the names, then `gateSites`. */
  async function rosterSites(t: T) {
    const config = await t.mutation(internal.seasonWatch.ensureSettings, {});
    return await t.query(internal.seasonWatch.gateSites, {
      sentinels: config.sentinels,
      pinned: config.pinned,
      sampleSize: 24,
    });
  }

  test('all three alpine sentinels are flagged, and a pinned site rides along unflagged', async () => {
    const t = convexTest(schema, modules);
    const clouds = await seedBody(t, 'Upper Lake of the Clouds', 44.258, { state: 'NH' });
    const eagle = await seedBody(t, 'Eagle Lake', 44.16, { state: 'NH' });
    const kinsman = await seedBody(t, 'Kinsman Pond', 44.136, { state: 'NH' });
    const lowPlains = await seedBody(t, 'Low Plains', 43.411, { state: 'NH' });
    await seedSites(t, 2);

    const sites = await rosterSites(t);
    const byId = new Map(sites.map((s) => [s.siteId, s]));
    expect(byId.get(clouds)?.sentinel).toBe(true);
    expect(byId.get(eagle)?.sentinel).toBe(true);
    expect(byId.get(kinsman)?.sentinel).toBe(true);
    expect(byId.get(lowPlains)).toMatchObject({ sentinel: false, role: 'pinned' });
    expect(sites).toHaveLength(6);
    expect(new Set(sites.map((s) => s.siteId)).size).toBe(6);
  });

  test('a same-named body in another state is not the sentinel', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t, 'Eagle Lake', 44.35, { state: 'ME' });
    await seedBody(t, 'Eagle Lake', 44.2, { state: 'NY' });
    const real = await seedBody(t, 'Eagle Lake', 44.16, { state: 'NH' });
    const sites = await rosterSites(t);
    expect(sites.filter((s) => s.sentinel).map((s) => s.siteId)).toEqual([real]);
  });

  test('a roster name that resolves to two rows in the state is dropped, not doubled', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t, 'Kinsman Pond', 44.136, { state: 'NH', boost: 1 });
    await seedBody(t, 'Kinsman Pond', 44.137, { state: 'NH', boost: 1 });
    const clouds = await seedBody(t, 'Upper Lake of the Clouds', 44.258, { state: 'NH' });
    const sites = await rosterSites(t);
    expect(sites.filter((s) => s.sentinel).map((s) => s.siteId)).toEqual([clouds]);
    expect(sites).toHaveLength(3);
  });

  test('a merged tombstone beside the survivor does not drop the sentinel', async () => {
    const t = convexTest(schema, modules);
    const survivor = await seedBody(t, 'Kinsman Pond', 44.136, { state: 'NH', boost: 0.3 });
    const loser = await seedBody(t, 'Kinsman Pond', 44.137, { state: 'NH', boost: 0.3 });
    await t.run((ctx) =>
      ctx.db.patch(loser, { dedupStatus: 'merged' as const, mergedIntoId: survivor }),
    );
    const sites = await rosterSites(t);
    expect(sites.filter((s) => s.sentinel).map((s) => s.siteId)).toEqual([survivor]);
    expect(sites.map((s) => s.siteId)).not.toContain(loser);
  });

  test('a sentinel merged after it was chosen follows its survivor', async () => {
    const t = convexTest(schema, modules);
    const original = await seedBody(t, 'Kinsman Pond', 44.136, { state: 'NH' });
    const config = await t.mutation(internal.seasonWatch.ensureSettings, {});
    const survivor = await seedBody(t, 'Kinsman Pond (survivor)', 44.137, { state: 'NH' });
    await t.run((ctx) =>
      ctx.db.patch(original, { dedupStatus: 'merged' as const, mergedIntoId: survivor }),
    );
    const sites = await t.query(internal.seasonWatch.gateSites, {
      sentinels: config.sentinels,
      pinned: config.pinned,
      sampleSize: 24,
    });
    expect(sites.filter((s) => s.sentinel).map((s) => s.siteId)).toEqual([survivor]);
  });

  test("a moderator's display-name pick does not lose the sentinel — the roster name is a claim", async () => {
    const t = convexTest(schema, modules);
    const clouds = await seedBody(t, 'Lakes of the Clouds', 44.258, { state: 'NH' });
    await t.run((ctx) =>
      ctx.db.patch(clouds, {
        nameClaims: [
          { source: 'user' as const, value: 'Lakes of the Clouds' },
          { source: 'osm' as const, value: 'Upper Lake of the Clouds' },
        ],
        searchText: 'Lakes of the Clouds Upper Lake of the Clouds',
      }),
    );
    const sites = await rosterSites(t);
    expect(sites.filter((s) => s.sentinel).map((s) => s.siteId)).toEqual([clouds]);
  });

  test('a sentinel that also ranks in the boost sample keeps its flag, listed once', async () => {
    const t = convexTest(schema, modules);
    const kinsman = await seedBody(t, 'Kinsman Pond', 44.136, { state: 'NH', boost: 0.3 });
    await seedSites(t, 1);
    const sites = await rosterSites(t);
    expect(sites.find((s) => s.siteId === kinsman)?.sentinel).toBe(true);
    expect(sites).toHaveLength(2);
  });

  // Greptile, PR #74: a fixed `take(24)` then `filter` let each boosted tombstone cost the sample
  // a site, shrinking the vote until one freezing pond could clear the 10% corpus rule alone.
  test('boosted tombstones at the top of the index do not shrink the ordinary sample', async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 30; i++) {
      const id = await seedBody(t, `Merged Pond ${i}`, 43 + i * 0.01, {
        state: 'NH',
        boost: 50 - i,
      });
      await t.run((ctx) => ctx.db.patch(id, { dedupStatus: 'merged' as const }));
    }
    for (let i = 0; i < 26; i++)
      await seedBody(t, `Listed Pond ${i}`, 44 + i * 0.01, { state: 'NH', boost: 1 });
    const sites = await rosterSites(t);
    expect(sites).toHaveLength(24);
    const names = await t.run(async (ctx) =>
      Promise.all(
        sites.map(async (s) => (await ctx.db.get(s.siteId as Id<'waterBodies'>))?.name as string),
      ),
    );
    expect(names.every((n) => n.startsWith('Listed Pond'))).toBe(true);
  });

  test('with nothing on the roster, the boost sample carries the gate alone', async () => {
    const t = convexTest(schema, modules);
    await seedSites(t, 3);
    const sites = await rosterSites(t);
    expect(sites).toHaveLength(3);
    expect(sites.some((s) => s.sentinel)).toBe(false);
  });
});
