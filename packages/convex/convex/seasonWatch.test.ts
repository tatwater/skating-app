import { DEFAULT_SEASON_WATCH_SETTINGS } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
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

  test('an admin saves a new version; sites it adds get their history filled', async () => {
    const t = convexTest(schema, modules);
    const clouds = await seedBody(t, 'Upper Lake of the Clouds', 44.258);
    const eagle = await seedBody(t, 'Big Pond', 44.16);
    await t.mutation(internal.seasonWatch.ensureSettings, {});
    const admin = await seedUser(t, 'admin', 'admin');

    const saved = await admin.as.mutation(api.seasonWatch.saveSettings, {
      settings: { ...DEFAULT_SEASON_WATCH_SETTINGS, sentinelNights: 3 },
      sentinels: [clouds, eagle],
      pinned: [],
      note: '  Matt: three nights  ',
    });
    expect(saved).toEqual({ version: 2 });
    const row = await t.run((ctx) =>
      ctx.db.query('seasonWatchSettings').withIndex('by_version').order('desc').first(),
    );
    expect(row).toMatchObject({ version: 2, note: 'Matt: three nights', savedBy: admin.id });
    expect(row?.sentinels.map((s) => s.name)).toEqual(['Upper Lake of the Clouds', 'Big Pond']);
    const fills = await scheduled(t, 'scheduleHistoryFill');
    expect(fills).toHaveLength(1);
    expect(fills[0]?.args[0]).toEqual({ waterBodyIds: [eagle] });
  });

  test('a save with nothing new schedules no fill', async () => {
    const t = convexTest(schema, modules);
    const clouds = await seedBody(t, 'Upper Lake of the Clouds', 44.258);
    await t.mutation(internal.seasonWatch.ensureSettings, {});
    const admin = await seedUser(t, 'admin', 'admin');
    await admin.as.mutation(api.seasonWatch.saveSettings, {
      settings: DEFAULT_SEASON_WATCH_SETTINGS,
      sentinels: [clouds],
      pinned: [],
    });
    expect(await scheduled(t, 'scheduleHistoryFill')).toHaveLength(0);
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
    };
    await expect(
      admin.as.mutation(api.seasonWatch.saveSettings, {
        settings: o.settings ?? DEFAULT_SEASON_WATCH_SETTINGS,
        sentinels: o.many ? Array.from({ length: 11 }, () => a) : o.twice ? [a, a] : [a],
        pinned: o.both ? [a] : [],
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

  test('storeSeries merges a refetch over what is stored and skips an empty first write', async () => {
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
    await t.mutation(internal.seasonWatch.storeSeries, {
      season: 'winter-2025-26',
      source: 'archive',
      sites: [{ ...site, days: [] }],
    });
    const rows = await t.query(internal.seasonWatch.seasonSeries, { season: 'winter-2026-27' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ firstDate: '2026-10-01', lows: [3, -1, -2] });
    expect(await t.query(internal.seasonWatch.seasonSeries, { season: 'winter-2025-26' })).toEqual(
      [],
    );

    const admin = await seedUser(t, 'admin', 'admin');
    const all = await admin.as.query(api.seasonWatch.series, {});
    expect(all).toEqual([
      {
        season: 'winter-2026-27',
        waterBodyId: id,
        name: 'A Pond',
        // The state from the first write stays: a later write without one does not erase it.
        state: 'NH',
        source: 'forecast',
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
    expect(await scheduled(t, 'imageryLive')).toHaveLength(1);

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

  test('a full history fill runs once a day, whoever clicks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, 'admin', 'admin');
    await admin.as.mutation(api.seasonWatch.requestHistoryFill, {});
    await expect(admin.as.mutation(api.seasonWatch.requestHistoryFill, {})).rejects.toThrow(
      /already started today/,
    );
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
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

  test('a full fill is spread out: the current season now, each past season a slot later', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    const t = convexTest(schema, modules);
    await seedBody(t, 'Upper Lake of the Clouds', 44.258);
    const admin = await seedUser(t, 'admin', 'admin');
    await admin.as.mutation(api.seasonWatch.requestHistoryFill, {});
    await t.finishInProgressScheduledFunctions();
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    const fills = await scheduled(t, 'fillSeason');
    // One site, one chunk: the current season plus ten past ones.
    expect(fills).toHaveLength(11);
    const seasons = fills.map((f) => (f.args[0] as { season: string }).season);
    expect(seasons).toContain('winter-2026-27');
    expect(seasons).toContain('winter-2016-17');
    const times = fills.map((f) => f.scheduledTime).sort((a, b) => a - b);
    // Spaced an hour and a quarter apart, so the fill never starves the daily corpus sweep.
    expect((times.at(-1) as number) - (times[0] as number)).toBeGreaterThanOrEqual(
      10 * 75 * 60_000,
    );
  });

  test('a fill with no matching sites schedules nothing', async () => {
    const t = convexTest(schema, modules);
    const pond = await seedBody(t, 'A Pond', 44.1);
    // Merged away, so no longer sampled.
    await t.run((ctx) => ctx.db.patch(pond, { dedupStatus: 'merged' as const }));
    const result = await t.mutation(internal.seasonWatch.scheduleHistoryFill, {
      waterBodyIds: [pond],
    });
    expect(result).toEqual({ requests: 0 });
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
        return new Response(
          JSON.stringify({
            daily: {
              time: ['2025-08-31', '2025-09-01', '2025-09-02'],
              temperature_2m_min: [1, 2, null],
            },
          }),
          { status: 200 },
        );
      }),
    );
    const site = { waterBodyId: pond, name: 'A Pond', state: 'NH', lat: 44.1, lng: -71.65 };
    await t.action(internal.seasonWatch.fillSeason, { season: 'winter-2025-26', sites: [site] });
    expect(urls[0]).toContain('archive-api.open-meteo.com');
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
