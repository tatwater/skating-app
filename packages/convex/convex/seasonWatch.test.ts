import { DEFAULT_SEASON_WATCH_SETTINGS } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';
import { HISTORY_FIRST_SEASON_YEAR, historySeasons } from './seasonWatch';

const modules = import.meta.glob('./**/*.*s');

/**
 * The season watch's settings, stored lows and admin page (A06i §2, §3, §6; D213).
 */

type T = ReturnType<typeof convexTest>;

const NOTIF_PREFS = {
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
};

async function seedUser(t: T, subject: string, role: 'member' | 'moderator' | 'admin') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

const square = (lat: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [-71.651, lat - 0.001],
      [-71.649, lat - 0.001],
      [-71.649, lat + 0.001],
      [-71.651, lat + 0.001],
      [-71.651, lat - 0.001],
    ],
  ],
});

async function seedBody(
  t: T,
  name: string,
  lat: number,
  opts: { state?: string; boost?: number } = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name,
      searchText: name,
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: square(lat),
      bbox: { minLat: lat - 0.001, minLng: -71.651, maxLat: lat + 0.001, maxLng: -71.649 },
      centroid: { lat, lng: -71.65 },
      interiorPoint: { lat, lng: -71.65 },
      states: [opts.state ?? 'NH'],
      dedupStatus: 'clean' as const,
      ...(opts.boost !== undefined ? { curatedBoost: opts.boost } : {}),
      createdAt: Date.now(),
    }),
  );
}

/**
 * One site's Open-Meteo hourly row: 24 UTC hours a day from `start`, each at that day's low (`null`
 * is a missing reading). `fillSeason` cuts the days itself (`dailyLowsFromOpenMeteo`).
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

/** `n` ordinary lakes, most prominent first — every one of them in the default sample. */
async function seedLakes(t: T, n: number) {
  const ids: Id<'waterBodies'>[] = [];
  for (let i = 0; i < n; i++)
    ids.push(await seedBody(t, `Lake ${i}`, 44 + i / 100, { boost: n - i }));
  return ids;
}

async function seedSeason(t: T, fields: Record<string, unknown> = {}) {
  return await t.run((ctx) =>
    ctx.db.insert('imageryIngestSeasons', {
      season: 'winter-2026-27',
      opensOn: '2026-10-03',
      openedBy: ['sentinel'],
      winterFrom: null,
      sitesSampled: 28,
      detectedAt: Date.parse('2026-10-04T20:46:00Z'),
      ...fields,
    }),
  );
}

const scheduled = (t: T, name: string) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query('_scheduled_functions').collect()).filter((j) =>
      j.name.includes(name),
    ),
  );

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('settings', () => {
  test('version 1 is seeded once, from the defaults, with the roster resolved by name', async () => {
    const t = convexTest(schema, modules);
    const clouds = await seedBody(t, 'Upper Lake of the Clouds', 44.258);
    const first = await t.mutation(internal.seasonWatch.ensureSettings, {});
    expect(first).toMatchObject({
      version: 1,
      settings: DEFAULT_SEASON_WATCH_SETTINGS,
      sentinels: [{ waterBodyId: clouds, name: 'Upper Lake of the Clouds', state: 'NH' }],
      pinned: [],
    });
    await t.mutation(internal.seasonWatch.ensureSettings, {});
    expect(await t.run((ctx) => ctx.db.query('seasonWatchSettings').collect())).toHaveLength(1);
  });

  test('an admin saves a new version, and asks for whatever it lacks to be filled', async () => {
    const t = convexTest(schema, modules);
    const clouds = await seedBody(t, 'Upper Lake of the Clouds', 44.258);
    const pond = await seedBody(t, 'Big Pond', 44.16);
    await t.mutation(internal.seasonWatch.ensureSettings, {});
    const admin = await seedUser(t, 'admin', 'admin');
    const saved = await admin.as.mutation(api.seasonWatch.saveSettings, {
      settings: { ...DEFAULT_SEASON_WATCH_SETTINGS, sentinelNights: 3 },
      sentinels: [clouds, pond],
      pinned: [],
      note: '  Matt: three nights  ',
    });
    expect(saved).toEqual({ version: 2 });
    const row = await t.run((ctx) =>
      ctx.db.query('seasonWatchSettings').withIndex('by_version').order('desc').first(),
    );
    expect(row).toMatchObject({ version: 2, note: 'Matt: three nights', savedBy: admin.id });
    expect(row?.sentinels.map((s) => s.name)).toEqual(['Upper Lake of the Clouds', 'Big Pond']);
    expect((await scheduled(t, 'scheduleHistoryFill')).map((j) => j.args[0])).toEqual([{}]);
  });

  test.each([
    [
      'an invalid value',
      { settings: { ...DEFAULT_SEASON_WATCH_SETTINGS, winterFraction: 2 } },
      /winter share/,
    ],
    ['a duplicate sentinel', { twice: true }, /listed twice/],
    ['a lake in both lists', { both: true }, /both a sentinel and a pinned/],
    ['an unlisted lake', { merged: true }, /not listed/],
    ['a duplicate pinned lake', { pinnedTwice: true }, /pinned lake is listed twice/],
    ['too many sentinels', { many: true }, /At most ten/],
  ])('refuses %s', async (_label, opts, message) => {
    const t = convexTest(schema, modules);
    const a = await seedBody(t, 'A Pond', 44.1);
    if ((opts as { merged?: boolean }).merged) {
      await t.run((ctx) => ctx.db.patch(a, { dedupStatus: 'merged' as const }));
    }
    const admin = await seedUser(t, 'admin', 'admin');
    const o = opts as {
      settings?: typeof DEFAULT_SEASON_WATCH_SETTINGS;
      twice?: boolean;
      both?: boolean;
      many?: boolean;
      pinnedTwice?: boolean;
    };
    await expect(
      admin.as.mutation(api.seasonWatch.saveSettings, {
        settings: o.settings ?? DEFAULT_SEASON_WATCH_SETTINGS,
        sentinels: o.many
          ? Array.from({ length: 11 }, () => a)
          : o.twice
            ? [a, a]
            : o.pinnedTwice
              ? []
              : [a],
        pinned: o.both ? [a] : o.pinnedTwice ? [a, a] : [],
      }),
    ).rejects.toThrow(message);
  });

  test('only an admin may save', async () => {
    const t = convexTest(schema, modules);
    const moderator = await seedUser(t, 'mod', 'moderator');
    await expect(
      moderator.as.mutation(api.seasonWatch.saveSettings, {
        settings: DEFAULT_SEASON_WATCH_SETTINGS,
        sentinels: [],
        pinned: [],
      }),
    ).rejects.toThrow(/admin/);
    await expect(moderator.as.query(api.seasonWatch.overview, {})).rejects.toThrow(/admin/);
  });
});

describe('the overview and the stored lows', () => {
  test('shows the defaults before anything is saved, with the sample the cron would take', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t, 'Upper Lake of the Clouds', 44.258);
    await seedBody(t, 'Big Lake', 44.5, { boost: 1 });
    await seedSeason(t);
    await seedSeason(t, { season: 'winter-2025-26' });
    const admin = await seedUser(t, 'admin', 'admin');
    for (const date of ['2026-01-10', '2025-11-20']) {
      await admin.as.mutation(api.seasonWatch.addFieldDate, {
        season: 'winter-2025-26',
        kind: 'first_skated',
        date,
      });
    }
    const overview = await admin.as.query(api.seasonWatch.overview, {});
    expect(overview.current.version).toBe(0);
    // Newest season first; field dates in date order.
    expect(overview.seasons.map((s) => s.season)).toEqual(['winter-2026-27', 'winter-2025-26']);
    expect(overview.fieldDates.map((d) => d.date)).toEqual(['2025-11-20', '2026-01-10']);
    expect(overview.sites.map((s) => [s.name, s.role])).toEqual([
      ['Upper Lake of the Clouds', 'sentinel'],
      ['Big Lake', 'sample'],
    ]);
    expect(overview.missing).toEqual([]);
    expect(overview.defaultsInCode.settings).toContain('DEFAULT_SEASON_WATCH_SETTINGS');
    expect(overview.historyFirstSeason).toBe(HISTORY_FIRST_SEASON_YEAR);
    // Two sites, one request a season: a small fill, two minutes apart, over the planner's seasons.
    const seasons = 1 + historySeasons(Date.now()).length;
    expect(overview.historyFill).toEqual({ seasons, spanMs: (seasons - 1) * 2 * 60_000 });
  });

  test("previews an edited roster by the cron's rule: survivors, and the sample re-drawn", async () => {
    const t = convexTest(schema, modules);
    const clouds = await seedBody(t, 'Upper Lake of the Clouds', 44.258);
    const survivor = await seedBody(t, 'Lakes of the Clouds', 44.259);
    const big = await seedBody(t, 'Big Lake', 44.5, { boost: 3 });
    await seedBody(t, 'Mid Lake', 44.4, { boost: 2 });
    // The sentinel was merged after it was chosen: its lows now accrue under the survivor.
    await t.run((ctx) =>
      ctx.db.patch(clouds, { dedupStatus: 'merged' as const, mergedIntoId: survivor }),
    );
    const admin = await seedUser(t, 'admin', 'admin');
    const preview = await admin.as.query(api.seasonWatch.previewSites, {
      sentinels: [{ waterBodyId: clouds, name: 'Upper Lake of the Clouds' }],
      pinned: [{ waterBodyId: big, name: 'Big Lake' }],
      sampleSize: 1,
    });
    expect(preview?.sites.map((s) => [s.siteId, s.role])).toEqual([
      [survivor, 'sentinel'],
      [big, 'pinned'],
      // Big Lake is pinned, so the sample of one is the next lake down.
      [expect.anything(), 'sample'],
    ]);
    expect(preview?.sites[2]?.name).toBe('Mid Lake');
    // A size the save would refuse previews nothing; only an admin may ask.
    for (const sampleSize of [0, 1.5, 61]) {
      expect(
        await admin.as.query(api.seasonWatch.previewSites, {
          sentinels: [],
          pinned: [],
          sampleSize,
        }),
      ).toBeNull();
    }
    const many = Array.from({ length: 11 }, () => ({ waterBodyId: big, name: 'Big Lake' }));
    expect(
      await admin.as.query(api.seasonWatch.previewSites, {
        sentinels: many,
        pinned: [],
        sampleSize: 1,
      }),
    ).toBeNull();
    const moderator = await seedUser(t, 'mod', 'moderator');
    await expect(
      moderator.as.query(api.seasonWatch.previewSites, {
        sentinels: [],
        pinned: [],
        sampleSize: 1,
      }),
    ).rejects.toThrow(/admin/);
  });

  test('reports a roster site that no longer resolves', async () => {
    const t = convexTest(schema, modules);
    const clouds = await seedBody(t, 'Upper Lake of the Clouds', 44.258);
    await t.mutation(internal.seasonWatch.ensureSettings, {});
    await t.run((ctx) => ctx.db.patch(clouds, { dedupStatus: 'merged' as const }));
    const admin = await seedUser(t, 'admin', 'admin');
    const overview = await admin.as.query(api.seasonWatch.overview, {});
    expect(overview.missing.map((m) => m.name)).toEqual(['Upper Lake of the Clouds']);
    expect(overview.versions).toHaveLength(1);
  });

  test('a sentinel merged into a pinned lake is the one reported — the pinned lake stays', async () => {
    const t = convexTest(schema, modules);
    const summit = await seedBody(t, 'Upper Lake of the Clouds', 44.258);
    const pinnedLake = await seedBody(t, 'Lakes of the Clouds', 44.259);
    await t.run((ctx) =>
      ctx.db.insert('seasonWatchSettings', {
        version: 1,
        settings: DEFAULT_SEASON_WATCH_SETTINGS,
        sentinels: [{ waterBodyId: summit, name: 'Upper Lake of the Clouds' }],
        pinned: [{ waterBodyId: pinnedLake, name: 'Lakes of the Clouds' }],
        savedAt: Date.now(),
      }),
    );
    await t.run((ctx) =>
      ctx.db.patch(summit, { dedupStatus: 'merged' as const, mergedIntoId: pinnedLake }),
    );
    const admin = await seedUser(t, 'admin', 'admin');
    const overview = await admin.as.query(api.seasonWatch.overview, {});
    expect(overview.sites.map((s) => [s.name, s.role])).toEqual([
      ['Lakes of the Clouds', 'pinned'],
    ]);
    expect(overview.missing).toEqual([
      { waterBodyId: summit, name: 'Upper Lake of the Clouds', role: 'sentinel' },
    ]);
  });

  test('reports a roster lake merged into another roster lake, with its role', async () => {
    const t = convexTest(schema, modules);
    const clouds = await seedBody(t, 'Upper Lake of the Clouds', 44.258);
    const pinned = await seedBody(t, 'Clouds Duplicate', 44.2581);
    await t.run((ctx) =>
      ctx.db.insert('seasonWatchSettings', {
        version: 1,
        settings: DEFAULT_SEASON_WATCH_SETTINGS,
        sentinels: [{ waterBodyId: clouds, name: 'Upper Lake of the Clouds' }],
        pinned: [{ waterBodyId: pinned, name: 'Clouds Duplicate' }],
        savedAt: Date.now(),
      }),
    );
    await t.run((ctx) =>
      ctx.db.patch(pinned, { dedupStatus: 'merged' as const, mergedIntoId: clouds }),
    );
    const admin = await seedUser(t, 'admin', 'admin');
    const overview = await admin.as.query(api.seasonWatch.overview, {});
    expect(overview.sites.map((s) => [s.name, s.role])).toEqual([
      ['Upper Lake of the Clouds', 'sentinel'],
    ]);
    expect(overview.missing).toEqual([
      { waterBodyId: pinned, name: 'Clouds Duplicate', role: 'pinned' },
    ]);
  });

  test('storeSeries merges a refetch over what is stored and skips an empty first write', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    const t = convexTest(schema, modules);
    const id = await seedBody(t, 'A Pond', 44.1);
    const site = { waterBodyId: id, name: 'A Pond', lat: 44.1, lng: -71.65 };
    await t.mutation(internal.seasonWatch.storeSeries, {
      season: 'winter-2026-27',
      source: 'forecast',
      sites: [
        {
          ...site,
          state: 'NH',
          days: [
            { date: '2026-10-01', minTempC: 3 },
            { date: '2026-10-02', minTempC: 2 },
          ],
        },
      ],
    });
    await t.mutation(internal.seasonWatch.storeSeries, {
      season: 'winter-2026-27',
      source: 'forecast',
      sites: [
        {
          ...site,
          days: [
            { date: '2026-10-02', minTempC: -1 },
            { date: '2026-10-03', minTempC: -2 },
          ],
        },
      ],
    });
    // An empty first write from the live watch keeps nothing.
    await t.mutation(internal.seasonWatch.storeSeries, {
      season: 'winter-2025-26',
      source: 'forecast',
      sites: [{ ...site, days: [] }],
    });
    const rows = await t.query(internal.seasonWatch.seasonSeries, { season: 'winter-2026-27' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ firstDate: '2026-10-01', lows: [3, -1, -2] });
    expect(await t.query(internal.seasonWatch.seasonSeries, { season: 'winter-2025-26' })).toEqual(
      [],
    );

    const admin = await seedUser(t, 'admin', 'admin');
    const all = await admin.as.query(api.seasonWatch.series, { current: 'winter-2026-27' });
    expect(all).toEqual([
      {
        season: 'winter-2026-27',
        waterBodyId: id,
        name: 'A Pond',
        // The state from the first write stays: a later write without one does not erase it.
        state: 'NH',
        source: 'forecast',
        // Kept live, but starting 1 October: the season's September is still to fill.
        whole: false,
        firstDate: '2026-10-01',
        lows: [3, -1, -2],
      },
    ]);
  });

  test('cliStatus returns the settings and the recorded watch', async () => {
    const t = convexTest(schema, modules);
    await seedSeason(t);
    const status = await t.query(internal.seasonWatch.cliStatus, { season: 'winter-2026-27' });
    expect(status.config.version).toBe(0);
    expect(status.record?.opensOn).toBe('2026-10-03');
  });
});

describe('reset, imagery and field dates', () => {
  test('a reset moves the row whole into the superseded table, and needs the word', async () => {
    const t = convexTest(schema, modules);
    await seedSeason(t);
    const admin = await seedUser(t, 'admin', 'admin');
    await expect(
      admin.as.mutation(api.seasonWatch.resetSeason, { season: 'winter-2026-27', confirm: 'yes' }),
    ).rejects.toThrow(/Type "reset"/);
    await admin.as.mutation(api.seasonWatch.resetSeason, {
      season: 'winter-2026-27',
      confirm: ' Reset ',
    });
    expect(await t.run((ctx) => ctx.db.query('imageryIngestSeasons').collect())).toEqual([]);
    const superseded = await t.run((ctx) =>
      ctx.db.query('imageryIngestSeasonsSuperseded').collect(),
    );
    expect(superseded).toEqual([
      expect.objectContaining({
        season: 'winter-2026-27',
        opensOn: '2026-10-03',
        supersededBy: admin.id,
      }),
    ]);
    await expect(
      admin.as.mutation(api.seasonWatch.resetSeason, {
        season: 'winter-2026-27',
        confirm: 'reset',
      }),
    ).rejects.toThrow(/No watch is recorded/);
  });

  test('start, pause and start again — and the first start schedules a poll', async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await seedSeason(t);
    const admin = await seedUser(t, 'admin', 'admin');
    await admin.as.mutation(api.seasonWatch.startImagery, { season: 'winter-2026-27' });
    const started = await t.run((ctx) => ctx.db.query('imageryIngestSeasons').first());
    expect(started).toMatchObject({ imageryStartedBy: admin.id });
    // A poll to queue what is new; the pump's own 3-minute tick starts the cuts.
    expect((await scheduled(t, 'imageryLive')).map((j) => j.name)).toEqual(['imageryLive:poll']);

    await admin.as.mutation(api.seasonWatch.pauseImagery, { season: 'winter-2026-27' });
    expect(
      (await t.run((ctx) => ctx.db.query('imageryIngestSeasons').first()))?.imageryPausedAt,
    ).toBeTypeOf('number');
    vi.advanceTimersByTime(60_000);
    await admin.as.mutation(api.seasonWatch.startImagery, { season: 'winter-2026-27' });
    const resumed = await t.run((ctx) => ctx.db.query('imageryIngestSeasons').first());
    expect(resumed?.imageryPausedAt).toBeUndefined();
    // The original start is kept — it is the record of when imagery began.
    expect(resumed?.imageryStartedAt).toBe(started?.imageryStartedAt);
  });

  test('imagery cannot start on an ended watch, or with no watch', async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, 'admin', 'admin');
    await expect(
      admin.as.mutation(api.seasonWatch.startImagery, { season: 'winter-2026-27' }),
    ).rejects.toThrow(/No watch is open/);
    await seedSeason(t, { closesOn: '2027-04-30' });
    await expect(
      admin.as.mutation(api.seasonWatch.startImagery, { season: 'winter-2026-27' }),
    ).rejects.toThrow(/has ended/);
  });

  test('field dates are added, trimmed, validated and removed', async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, 'admin', 'admin');
    const pond = await seedBody(t, 'Low Plains', 43.41);
    const id = await admin.as.mutation(api.seasonWatch.addFieldDate, {
      season: 'winter-2025-26',
      kind: 'first_skated',
      date: '2025-12-01',
      waterBodyId: pond,
      place: '  Low Plains  ',
      note: '   ',
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ place: 'Low Plains', enteredBy: admin.id });
    expect(row?.note).toBeUndefined();
    await expect(
      admin.as.mutation(api.seasonWatch.addFieldDate, {
        season: 'winter-2025-26',
        kind: 'last_skated',
        date: 'March 3',
      }),
    ).rejects.toThrow(/real day/);
    await expect(
      admin.as.mutation(api.seasonWatch.addFieldDate, {
        season: '2025-26',
        kind: 'last_skated',
        date: '2026-03-03',
      }),
    ).rejects.toThrow(/Not a season/);
    await admin.as.mutation(api.seasonWatch.removeFieldDate, { id });
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
  });
});

describe('the review fixes', () => {
  test('a legacy row is stamped as version 0 even when an admin saves before the first tick', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t, 'Upper Lake of the Clouds', 44.258);
    await seedSeason(t);
    const admin = await seedUser(t, 'admin', 'admin');
    await admin.as.mutation(api.seasonWatch.saveSettings, {
      settings: { ...DEFAULT_SEASON_WATCH_SETTINGS, sentinelNights: 3 },
      sentinels: [],
      pinned: [],
    });
    const row = await t.run((ctx) => ctx.db.query('imageryIngestSeasons').first());
    expect(row).toMatchObject({ settingsVersion: 0, settings: DEFAULT_SEASON_WATCH_SETTINGS });
    expect(row?.sentinels?.map((s) => s.name)).toEqual(['Upper Lake of the Clouds']);
  });

  test('the archive fills gaps in the live season but never replaces a kept night', async () => {
    const t = convexTest(schema, modules);
    const id = await seedBody(t, 'A Pond', 44.1);
    const site = { waterBodyId: id, name: 'A Pond', lat: 44.1, lng: -71.65 };
    await t.mutation(internal.seasonWatch.storeSeries, {
      season: 'winter-2026-27',
      source: 'forecast',
      sites: [{ ...site, days: [{ date: '2026-10-02', minTempC: -1 }] }],
    });
    await t.mutation(internal.seasonWatch.storeSeries, {
      season: 'winter-2026-27',
      source: 'archive',
      sites: [
        {
          ...site,
          days: [
            { date: '2026-10-01', minTempC: 4 },
            { date: '2026-10-02', minTempC: 1.5 },
          ],
        },
      ],
    });
    const [doc] = await t.query(internal.seasonWatch.seasonSeries, { season: 'winter-2026-27' });
    expect(doc).toMatchObject({ source: 'forecast', firstDate: '2026-10-01', lows: [4, -1] });
  });

  test('a large history fill cannot start while one is still running, whoever clicks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    const t = convexTest(schema, modules);
    await seedLakes(t, 13);
    const admin = await seedUser(t, 'admin', 'admin');
    const other = await seedUser(t, 'admin2', 'admin');
    expect(await admin.as.mutation(api.seasonWatch.requestHistoryFill, {})).toEqual({
      requests: 22,
    });
    // The plan commits with the click, so a second click is refused at once.
    await expect(other.as.mutation(api.seasonWatch.requestHistoryFill, {})).rejects.toThrow(
      /still running/,
    );
    // Thirteen sites are two requests a season, 22 in all, 75 minutes apart, plus an hour — busy
    // for 28½ hours. The next evening it is still running…
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
    await expect(admin.as.mutation(api.seasonWatch.requestHistoryFill, {})).rejects.toThrow(
      /still running/,
    );
    // …and once it has ended, a new one may start.
    vi.setSystemTime(new Date('2026-10-07T17:00:00Z'));
    await admin.as.mutation(api.seasonWatch.requestHistoryFill, {});
  });

  test('a field date must be a real day inside its season', async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, 'admin', 'admin');
    await expect(
      admin.as.mutation(api.seasonWatch.addFieldDate, {
        season: 'winter-2026-27',
        kind: 'first_skated',
        date: '2027-02-31',
      }),
    ).rejects.toThrow(/real day/);
    await expect(
      admin.as.mutation(api.seasonWatch.addFieldDate, {
        season: 'winter-2026-27',
        kind: 'first_skated',
        date: '2019-12-01',
      }),
    ).rejects.toThrow(/not in winter-2026-27/);
  });
});

describe('history', () => {
  test('covers every season from the first archive season to the one before now', () => {
    const seasons = historySeasons(Date.parse('2026-10-06T00:00:00Z'));
    expect(seasons[0]).toBe('winter-2016-17');
    expect(seasons.at(-1)).toBe('winter-2025-26');
    expect(seasons).toHaveLength(10);
  });

  test("fills exactly what the watch lacks — a merged sentinel's survivor too", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    const t = convexTest(schema, modules);
    const clouds = await seedBody(t, 'Upper Lake of the Clouds', 44.258);
    const survivor = await seedBody(t, 'Lakes of the Clouds', 44.259);
    const big = await seedBody(t, 'Big Lake', 44.5, { boost: 3 });
    // A sample of one — Big Lake, the most prominent.
    await t.run((ctx) =>
      ctx.db.insert('seasonWatchSettings', {
        version: 1,
        settings: { ...DEFAULT_SEASON_WATCH_SETTINGS, sampleSize: 1 },
        sentinels: [{ waterBodyId: clouds, name: 'Upper Lake of the Clouds' }],
        pinned: [],
        savedAt: Date.now(),
      }),
    );
    // Every season is stored for the sentinel and Big Lake…
    const lows = { name: 'x', lat: 44, lng: -71.65, source: 'archive' as const, updatedAt: 0 };
    for (const season of ['winter-2026-27', ...historySeasons(Date.now())]) {
      for (const id of [clouds, big]) {
        await t.run((ctx) =>
          ctx.db.insert('seasonWatchSeries', {
            season,
            waterBodyId: id,
            firstDate: '2025-10-01',
            lows: [1],
            ...lows,
          }),
        );
      }
    }
    expect(await t.mutation(internal.seasonWatch.scheduleHistoryFill, {})).toEqual({
      requests: 0,
    });
    // …then the sentinel is merged: its past seasons stay under its old id, and the survivor —
    // which the watch now reads — has none.
    await t.run((ctx) =>
      ctx.db.patch(clouds, { dedupStatus: 'merged' as const, mergedIntoId: survivor }),
    );
    expect(await t.mutation(internal.seasonWatch.scheduleHistoryFill, {})).toEqual({
      requests: 11,
    });
    const fills = await scheduled(t, 'fillSeason');
    expect(
      fills.every((f) => {
        const sites = (f.args[0] as { sites: { waterBodyId: string }[] }).sites;
        return sites.length === 1 && sites[0]?.waterBodyId === survivor;
      }),
    ).toBe(true);
    // One request a season is a small fill: two minutes apart, the current season first, no hold.
    const byTime = [...fills].sort((a, b) => a.scheduledTime - b.scheduledTime);
    expect((byTime[1]?.scheduledTime ?? 0) - (byTime[0]?.scheduledTime ?? 0)).toBe(2 * 60_000);
    expect(byTime[0]?.args[0]).toMatchObject({ season: 'winter-2026-27' });
    // One fill at a time: a click while it runs is told when it ends.
    const admin = await seedUser(t, 'admin', 'admin');
    await expect(admin.as.mutation(api.seasonWatch.requestHistoryFill, {})).rejects.toThrow(
      /still running/,
    );
  });

  test('a large fill is spread 75 minutes apart; saves during it book one re-plan for its end', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    const t = convexTest(schema, modules);
    await seedLakes(t, 13);
    expect(await t.mutation(internal.seasonWatch.scheduleHistoryFill, {})).toEqual({
      requests: 22,
    });
    const first = (await scheduled(t, 'fillSeason'))
      .map((f) => f.scheduledTime)
      .sort((a, b) => a - b);
    expect((first[1] as number) - (first[0] as number)).toBe(75 * 60_000);
    // Two saves during it queue nothing and do not stretch its hold — one re-plan, at its end.
    const busyUntil = Date.now() + 21 * 75 * 60_000 + 60 * 60_000;
    for (let save = 0; save < 2; save++) {
      expect(await t.mutation(internal.seasonWatch.scheduleHistoryFill, {})).toEqual({
        requests: 0,
        deferredUntil: busyUntil,
      });
    }
    expect(await scheduled(t, 'fillSeason')).toHaveLength(22);
    const replans = await scheduled(t, 'scheduleHistoryFill');
    expect(replans.map((j) => j.scheduledTime)).toEqual([busyUntil]);
    // At its end the re-plan sees what is still lacking (here, all of it) and plans it.
    vi.setSystemTime(busyUntil);
    expect(await t.mutation(internal.seasonWatch.scheduleHistoryFill, {})).toEqual({
      requests: 22,
    });
  });

  test('a past season the live watch kept is topped up from the archive once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    const t = convexTest(schema, modules);
    const [lake] = await seedLakes(t, 1);
    const site = { waterBodyId: lake as Id<'waterBodies'>, name: 'Lake 0', lat: 44, lng: -71.65 };
    // Every past season from the archive, but 2025-26 only as the live watch kept it: to its close.
    for (const season of historySeasons(Date.now())) {
      await t.run((ctx) =>
        ctx.db.insert('seasonWatchSeries', {
          season,
          ...site,
          source: season === 'winter-2025-26' ? ('forecast' as const) : ('archive' as const),
          firstDate: '2025-10-01',
          lows: [1],
          updatedAt: 0,
        }),
      );
    }
    // The season under way, kept back to its floor: whole.
    await t.mutation(internal.seasonWatch.storeSeries, {
      season: 'winter-2026-27',
      source: 'forecast',
      sites: [{ ...site, days: [{ date: '2026-09-01', minTempC: 1 }] }],
    });
    const plan = async () => {
      // Each plan here stands for a later day, after the last fill's hold.
      await t.run(async (ctx) => {
        for (const r of await ctx.db.query('dailyThrottle').collect()) await ctx.db.delete(r._id);
        return null;
      });
      return await t.mutation(internal.seasonWatch.scheduleHistoryFill, {});
    };
    expect(await plan()).toEqual({ requests: 1 });
    expect((await scheduled(t, 'fillSeason'))[0]?.args[0]).toMatchObject({
      season: 'winter-2025-26',
    });
    // The archive fills its gaps — and marks it, so the next plan leaves it be.
    await t.mutation(internal.seasonWatch.storeSeries, {
      season: 'winter-2025-26',
      source: 'archive',
      sites: [{ ...site, days: [{ date: '2026-04-20', minTempC: 5 }] }],
    });
    expect(await plan()).toEqual({ requests: 0 });
  });

  test('between July and 1 September the new season is not filled — it has no night to keep', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T12:00:00Z'));
    const t = convexTest(schema, modules);
    await seedLakes(t, 1);
    await t.mutation(internal.seasonWatch.scheduleHistoryFill, {});
    const seasons = (await scheduled(t, 'fillSeason')).map(
      (f) => (f.args[0] as { season: string }).season,
    );
    expect(seasons).toHaveLength(10);
    expect(seasons).not.toContain('winter-2026-27');
  });

  test('a site the archive did not answer for is not stored; one it answered, even empty, is whole', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    const t = convexTest(schema, modules);
    const [a, b] = await seedLakes(t, 2);
    for (const id of [a, b]) {
      await t.run((ctx) =>
        ctx.db.insert('seasonWatchSeries', {
          season: 'winter-2025-26',
          waterBodyId: id as Id<'waterBodies'>,
          name: 'x',
          lat: 44,
          lng: -71.65,
          source: 'forecast' as const,
          firstDate: '2025-10-01',
          lows: [1],
          updatedAt: 0,
        }),
      );
    }
    // Lake 0 answered with only null nights; Lake 1's answer came back without its row.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        new URL(url).searchParams.get('latitude') === '44.0000'
          ? new Response(JSON.stringify([hourlyRow('2026-04-20', [null])]))
          : new Response('[]'),
      ),
    );
    // An answer without a requested site is a failed request — stored for the rest, then thrown.
    await expect(
      t.action(internal.seasonWatch.fillSeason, {
        season: 'winter-2025-26',
        sites: [a, b].map((id, i) => ({
          waterBodyId: id as Id<'waterBodies'>,
          name: `Lake ${i}`,
          lat: 44 + i / 100,
          lng: -71.65,
        })),
      }),
    ).rejects.toThrow(/answered for 0 of 1 sites/);
    const docs = await t.query(internal.seasonWatch.seasonSeries, { season: 'winter-2025-26' });
    const byId = new Map(docs.map((d) => [d.waterBodyId as string, d]));
    expect(byId.get(a as string)?.archiveFilledAt).toBeDefined();
    expect(byId.get(b as string)?.archiveFilledAt).toBeUndefined();
  });

  test('an archive answer with no nights for a site never stored is kept, so it is not asked again', async () => {
    const t = convexTest(schema, modules);
    const [lake] = await seedLakes(t, 1);
    await t.mutation(internal.seasonWatch.storeSeries, {
      season: 'winter-2019-20',
      source: 'archive',
      sites: [
        { waterBodyId: lake as Id<'waterBodies'>, name: 'Lake 0', lat: 44, lng: -71.65, days: [] },
      ],
    });
    const [doc] = await t.query(internal.seasonWatch.seasonSeries, { season: 'winter-2019-20' });
    expect(doc).toMatchObject({ source: 'archive', firstDate: '2019-09-01', lows: [] });
  });

  test('a fill fetches only the sites still missing when it runs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    const t = convexTest(schema, modules);
    const pond = await seedBody(t, 'A Pond', 44.1);
    await t.run((ctx) =>
      ctx.db.insert('seasonWatchSeries', {
        season: 'winter-2025-26',
        waterBodyId: pond,
        name: 'A Pond',
        lat: 44.1,
        lng: -71.65,
        source: 'archive' as const,
        firstDate: '2025-10-01',
        lows: [1],
        updatedAt: 0,
      }),
    );
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    await t.action(internal.seasonWatch.fillSeason, {
      season: 'winter-2025-26',
      sites: [{ waterBodyId: pond, name: 'A Pond', lat: 44.1, lng: -71.65 }],
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('a past season reads the archive from 1 September; the current one, the forecast', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    const t = convexTest(schema, modules);
    const pond = await seedBody(t, 'A Pond', 44.1);
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(hourlyRow('2025-08-31', [1, 2, null])), { status: 200 });
      }),
    );
    const site = { waterBodyId: pond, name: 'A Pond', state: 'NH', lat: 44.1, lng: -71.65 };
    await t.action(internal.seasonWatch.fillSeason, { season: 'winter-2025-26', sites: [site] });
    expect(urls[0]).toContain('archive-api.open-meteo.com');
    // Hours, cut into days by the zone — never Open-Meteo's daily lows (one fixed offset).
    const params = new URL(urls[0] as string).searchParams;
    expect(params.get('hourly')).toBe('temperature_2m');
    expect(params.get('timeformat')).toBe('unixtime');
    expect(params.get('daily')).toBeNull();
    expect(urls[0]).toContain('start_date=2025-09-01');
    expect(urls[0]).toContain('end_date=2026-06-30');
    const stored = await t.query(internal.seasonWatch.seasonSeries, { season: 'winter-2025-26' });
    // Before the season's September floor and the null night are both dropped.
    expect(stored[0]).toMatchObject({ source: 'archive', firstDate: '2025-09-01', lows: [2] });

    await t.action(internal.seasonWatch.fillSeason, { season: 'winter-2026-27', sites: [site] });
    expect(urls[1]).toContain('api.open-meteo.com/v1/forecast');
    expect(urls[1]).toContain('past_days=92');
    const calls = await t.run((ctx) => ctx.db.query('externalApiCalls').collect());
    expect(calls[0]?.calls).toBe(2);
  });

  test('a fill stores what came and throws for what did not', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    const t = convexTest(schema, modules);
    const [a, b] = await seedLakes(t, 2);
    // An archive season is one site a request: the first answers, the second refuses.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        new URL(url).searchParams.get('latitude') === '44.0000'
          ? new Response(JSON.stringify(hourlyRow('2025-10-01', [1, 2])))
          : new Response('', { status: 429, statusText: 'Too Many' }),
      ),
    );
    await expect(
      t.action(internal.seasonWatch.fillSeason, {
        season: 'winter-2025-26',
        sites: [a, b].map((id, i) => ({
          waterBodyId: id as Id<'waterBodies'>,
          name: `Lake ${i}`,
          lat: 44 + i / 100,
          lng: -71.65,
        })),
      }),
    ).rejects.toThrow(/Open-Meteo 429 Too Many \(1 of 2 requests\) filling winter-2025-26/);
    const docs = await t.query(internal.seasonWatch.seasonSeries, { season: 'winter-2025-26' });
    expect(docs.map((d) => d.waterBodyId)).toEqual([a]);
  });

  test('a lake added mid-season gets its autumn from the archive; the season is whole once it reaches the floor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-02-10T17:00:00Z'));
    const t = convexTest(schema, modules);
    const [lake] = await seedLakes(t, 1);
    const site = { waterBodyId: lake as Id<'waterBodies'>, name: 'Lake 0', lat: 44, lng: -71.65 };
    // The live watch has kept its last 92 days: November on.
    await t.mutation(internal.seasonWatch.storeSeries, {
      season: 'winter-2026-27',
      source: 'forecast',
      sites: [{ ...site, days: [{ date: '2026-11-10', minTempC: -3 }] }],
    });
    const held = () =>
      t.query(internal.seasonWatch.heldSites, {
        season: 'winter-2026-27',
        waterBodyIds: [site.waterBodyId],
        isCurrent: true,
      });
    expect(await held()).toEqual([]);
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        const archive = url.includes('archive-api');
        // The forecast says -3 on 10 Nov again; the archive has September through February.
        return new Response(
          JSON.stringify(
            archive ? hourlyRow('2026-09-01', [5, 4, 3]) : hourlyRow('2026-11-10', [-3]),
          ),
        );
      }),
    );
    await t.action(internal.seasonWatch.fillSeason, { season: 'winter-2026-27', sites: [site] });
    // The forecast first, then the archive from the floor to yesterday.
    expect(urls[0]).toContain('api.open-meteo.com/v1/forecast');
    expect(urls[1]).toContain('archive-api.open-meteo.com');
    expect(urls[1]).toContain('start_date=2026-09-01');
    expect(urls[1]).toContain('end_date=2027-02-09');
    const [doc] = await t.query(internal.seasonWatch.seasonSeries, { season: 'winter-2026-27' });
    // The autumn is filled, the live night kept, and the season whole — while it is under way.
    expect(doc).toMatchObject({ source: 'forecast', firstDate: '2026-09-01' });
    // ⚠ Not marked archive-filled: that would skip the spring once the season is past.
    expect(doc?.archiveFilledAt).toBeUndefined();
    expect(await held()).toEqual([site.waterBodyId]);
    // Next August the season is past, and its spring — after the watch closed — is still to fill.
    vi.setSystemTime(new Date('2027-08-10T17:00:00Z'));
    expect(
      await t.query(internal.seasonWatch.heldSites, {
        season: 'winter-2026-27',
        waterBodyIds: [site.waterBodyId],
        isCurrent: false,
      }),
    ).toEqual([]);
  });

  test('the archive never starts a season under way: a site with no live lows stays lacking', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-02-10T17:00:00Z'));
    const t = convexTest(schema, modules);
    const [lake] = await seedLakes(t, 1);
    await t.mutation(internal.seasonWatch.storeSeries, {
      season: 'winter-2026-27',
      source: 'archive',
      sites: [
        {
          waterBodyId: lake as Id<'waterBodies'>,
          name: 'Lake 0',
          lat: 44,
          lng: -71.65,
          days: [{ date: '2026-09-01', minTempC: 5 }],
        },
      ],
    });
    expect(await t.query(internal.seasonWatch.seasonSeries, { season: 'winter-2026-27' })).toEqual(
      [],
    );
  });

  test('in October the forecast already reaches the floor: no archive pass for the season under way', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T17:00:00Z'));
    const t = convexTest(schema, modules);
    const [lake] = await seedLakes(t, 1);
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(hourlyRow('2026-09-01', [5])));
      }),
    );
    await t.action(internal.seasonWatch.fillSeason, {
      season: 'winter-2026-27',
      sites: [{ waterBodyId: lake as Id<'waterBodies'>, name: 'Lake 0', lat: 44, lng: -71.65 }],
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('api.open-meteo.com/v1/forecast');
  });

  test('a failed archive request throws', async () => {
    const t = convexTest(schema, modules);
    const pond = await seedBody(t, 'A Pond', 44.1);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 429, statusText: 'Too Many' })),
    );
    await expect(
      t.action(internal.seasonWatch.fillSeason, {
        season: 'winter-2020-21',
        sites: [{ waterBodyId: pond, name: 'A Pond', lat: 44.1, lng: -71.65 }],
      }),
    ).rejects.toThrow(/Open-Meteo 429/);
  });
});
