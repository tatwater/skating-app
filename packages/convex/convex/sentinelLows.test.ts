import {
  addDaysIso,
  DEFAULT_SEASON_WATCH_SETTINGS,
  dailyLowsFromHourly,
  expandLows,
  mergeLows,
  nightsBetween,
} from '@skating/core';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';
import { alignLows, type Lake, lastStoredNight, sentinelRows, siteKey } from './sentinelLows';

const modules = import.meta.glob('./**/*.*s');

/**
 * The Overview Home's sentinel row (B01-2b, D275): each sentinel's stored lows for the season's nights,
 * read back exactly as the season watch stored them — a gap is `null`, never a zero or a filled-in
 * value — and the record's two marked nights only from what the record stored.
 */

type T = ReturnType<typeof convexTest>;

const PREFS = {
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
  await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return t.withIdentity({ subject });
}

async function seedBody(t: T, name: string, lat: number) {
  return await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name,
      searchText: name,
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [-71.651, lat - 0.001],
            [-71.649, lat - 0.001],
            [-71.649, lat + 0.001],
            [-71.651, lat - 0.001],
          ],
        ],
      },
      bbox: { minLat: lat - 0.001, minLng: -71.651, maxLat: lat + 0.001, maxLng: -71.649 },
      centroid: { lat, lng: -71.65 },
      interiorPoint: { lat, lng: -71.65 },
      states: ['NH'],
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  );
}

const SEASON = 'winter-2026-27';
/** Noon, 13 October 2026, New York — the board's "day 10". */
const NOW = Date.parse('2026-10-13T16:00:00Z');

async function seedRoster(t: T) {
  const clouds = await seedBody(t, 'Upper Lake of the Clouds', 44.26);
  const eagle = await seedBody(t, 'Eagle Lake', 44.15);
  const kinsman = await seedBody(t, 'Kinsman Pond', 44.13);
  const roster = [
    { waterBodyId: clouds, name: 'Upper Lake of the Clouds', state: 'NH' },
    { waterBodyId: eagle, name: 'Eagle Lake', state: 'NH' },
    { waterBodyId: kinsman, name: 'Kinsman Pond', state: 'NH' },
  ];
  await t.run((ctx) =>
    ctx.db.insert('seasonWatchSettings', {
      version: 1,
      settings: DEFAULT_SEASON_WATCH_SETTINGS,
      sentinels: roster,
      pinned: [],
      savedAt: NOW,
    }),
  );
  return { clouds, eagle, kinsman, roster };
}

async function seedSeries(
  t: T,
  body: Id<'waterBodies'>,
  firstDate: string,
  lows: Array<number | null>,
  season = SEASON,
) {
  await t.run((ctx) =>
    ctx.db.insert('seasonWatchSeries', {
      season,
      waterBodyId: body,
      name: 'site',
      lat: 44,
      lng: -71.65,
      source: 'forecast' as const,
      firstDate,
      lows,
      updatedAt: NOW,
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sentinelLows.forSeason', () => {
  test('a moderator reads each sentinel’s lows from the floor to the last stored night; a gap stays a gap', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const { clouds, eagle, kinsman, roster } = await seedRoster(t);
    // Clouds stored from 25 Sep (before the floor), a missing night on 5 Oct, last night 12 Oct.
    await seedSeries(t, clouds, '2026-09-25', [
      ...Array.from({ length: 6 }, () => 5),
      1.1,
      -0.4,
      -2.8,
      -1.1,
      null,
      -1.7,
      -7.2,
      -3.9,
      -2.2,
      0.6,
      -1.1,
      -0.6,
    ]);
    // Eagle stops two nights early; Kinsman has nothing stored at all.
    await seedSeries(t, eagle, '2026-10-01', [2.2, 0.6, 0, -0.6, -2.8, -0.6, -7.2, -3.3, -1.1]);
    await t.run((ctx) =>
      ctx.db.insert('imageryIngestSeasons', {
        season: SEASON,
        opensOn: '2026-10-03',
        openedBy: ['sentinel'],
        winterFrom: null,
        sitesSampled: 28,
        detectedAt: NOW,
        settings: DEFAULT_SEASON_WATCH_SETTINGS,
        sentinels: roster,
        opening: {
          sentinels: [
            { waterBodyId: clouds, name: 'Upper Lake of the Clouds', lowC: -2.8 },
            { waterBodyId: eagle, name: 'Eagle Lake', lowC: 0 },
          ],
          corpus: { frozen: 0, reporting: 25 },
        },
        imageryNudgeOn: '2026-10-07',
        imageryNudgeSites: [
          { waterBodyId: clouds, name: 'Upper Lake of the Clouds', lowC: -7.2 },
          { waterBodyId: eagle, name: 'Eagle Lake', lowC: -7.2 },
        ],
      }),
    );

    const r = await mod.query(api.sentinelLows.forSeason, { season: 2026, now: NOW });
    expect(r.state).toBe('value');
    if (r.state !== 'value') return;
    expect([r.firstDate, r.lastDate]).toEqual(['2026-10-01', '2026-10-12']);
    const [c, e, k] = r.sentinels;
    expect(c?.lows).toEqual([1.1, -0.4, -2.8, -1.1, null, -1.7, -7.2, -3.9, -2.2, 0.6, -1.1, -0.6]);
    expect(e?.lows).toEqual([2.2, 0.6, 0, -0.6, -2.8, -0.6, -7.2, -3.3, -1.1, null, null, null]);
    expect(k).toMatchObject({ key: kinsman, status: 'read', lows: new Array(12).fill(null) });
    expect(r.lines).toEqual({
      watchC: DEFAULT_SEASON_WATCH_SETTINGS.freezeC,
      imageryC: DEFAULT_SEASON_WATCH_SETTINGS.imageryNudgeC,
    });
    expect(r.opened).toEqual({
      on: '2026-10-03',
      of: 3,
      sites: [
        { key: clouds, name: 'Upper Lake of the Clouds', lowC: -2.8 },
        { key: eagle, name: 'Eagle Lake', lowC: 0 },
      ],
    });
    expect(r.imageryLine?.on).toBe('2026-10-07');
  });

  test('a member is refused; the capability is the one D275 names', async () => {
    const t = convexTest(schema, modules);
    const member = await seedUser(t, 'member', 'member');
    await expect(member.query(api.sentinelLows.forSeason, {})).rejects.toThrow();
  });

  test('before the floor nothing has been measured; after it, an empty store is not recorded', async () => {
    const sept = Date.parse('2026-09-20T16:00:00Z');
    vi.useFakeTimers({ now: sept, toFake: ['Date'] });
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    await seedRoster(t);
    expect(await mod.query(api.sentinelLows.forSeason, { now: sept })).toEqual({
      state: 'before',
      season: 2026,
      countsFrom: '2026-10-01',
    });
    vi.setSystemTime(NOW);
    expect(await mod.query(api.sentinelLows.forSeason, { now: NOW })).toEqual({
      state: 'none',
      season: 2026,
      countsFrom: '2026-10-01',
      roster: 3,
    });
  });

  test('a stored night before the floor, or in another season, never shows; no record means no marks', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const { clouds, eagle } = await seedRoster(t);
    await seedSeries(t, clouds, '2026-09-01', [-3, -3, -3]);
    await seedSeries(t, eagle, '2026-10-02', [-1], 'winter-2025-26');
    const r = await mod.query(api.sentinelLows.forSeason, { now: NOW });
    expect(r.state).toBe('none');
  });

  test('a merged sentinel is read under the body it merged into, as the cron stores it; a gone one is gone', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const { clouds, eagle } = await seedRoster(t);
    const survivor = await seedBody(t, 'Lake of the Clouds', 44.27);
    await t.run(async (ctx) => {
      await ctx.db.patch(clouds, { mergedIntoId: survivor });
      await ctx.db.delete(eagle);
    });
    await seedSeries(t, survivor, '2026-10-01', [-1, -2]);
    const r = await mod.query(api.sentinelLows.forSeason, { now: NOW });
    if (r.state !== 'value') throw new Error(r.state);
    expect(r.sentinels[0]).toMatchObject({ key: clouds, bodyId: survivor, lows: [-1, -2] });
    expect(r.sentinels[1]).toMatchObject({ key: eagle, status: 'gone', lows: [null, null] });
    // No season record: neither night is marked.
    expect([r.opened, r.imageryLine]).toEqual([null, null]);
  });
});

// ── One identity for a sentinel (Greptile on #150) ────────────────────────────────────────────

/** A season record whose two nights name `fired` (the ids saved when they happened). */
async function seedRecord(
  t: T,
  roster: ReadonlyArray<{ waterBodyId: Id<'waterBodies'>; name: string; state: string }>,
  fired: ReadonlyArray<{ waterBodyId: Id<'waterBodies'>; name: string; lowC: number }>,
  season = SEASON,
) {
  await t.run((ctx) =>
    ctx.db.insert('imageryIngestSeasons', {
      season,
      opensOn: season === SEASON ? '2026-10-01' : '2025-10-01',
      openedBy: ['sentinel'],
      winterFrom: null,
      sitesSampled: 28,
      detectedAt: NOW,
      settings: DEFAULT_SEASON_WATCH_SETTINGS,
      sentinels: [...roster],
      opening: { sentinels: [...fired], corpus: { frozen: 0, reporting: 25 } },
      imageryNudgeOn: season === SEASON ? '2026-10-02' : '2025-10-02',
      imageryNudgeSites: [...fired],
    }),
  );
}

describe('one identity for a sentinel', () => {
  test('a sentinel’s lake merged after the watch opened keeps its marker on its own line', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const { clouds, roster } = await seedRoster(t);
    // The watch opened on Clouds's id; Clouds was merged into another body since.
    await seedRecord(t, roster, [
      { waterBodyId: clouds, name: 'Upper Lake of the Clouds', lowC: -1 },
    ]);
    const survivor = await seedBody(t, 'Lake of the Clouds', 44.27);
    await t.run((ctx) => ctx.db.patch(clouds, { mergedIntoId: survivor }));
    await seedSeries(t, survivor, '2026-10-01', [-1, -6.7]);
    const r = await mod.query(api.sentinelLows.forSeason, { now: NOW });
    if (r.state !== 'value') throw new Error(r.state);
    const row = r.sentinels.find((s) => s.bodyId === survivor);
    expect(row?.key).toBe(clouds);
    expect(r.opened?.sites.map((s) => s.key)).toEqual([clouds]);
    expect(r.imageryLine?.sites.map((s) => s.key)).toEqual([clouds]);
  });

  test('two roster sentinels merged into one lake are one row; a dropped one and a gone one keep theirs', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const t = convexTest(schema, modules);
    const mod = await seedUser(t, 'mod', 'moderator');
    const { clouds, eagle, kinsman, roster } = await seedRoster(t);
    const dropped = await seedBody(t, 'Bog Pond', 44.3);
    // The record watched Bog Pond too; the roster has since dropped it.
    await seedRecord(
      t,
      [...roster, { waterBodyId: dropped, name: 'Bog Pond', state: 'NH' }],
      [
        { waterBodyId: dropped, name: 'Bog Pond', lowC: -2 },
        { waterBodyId: eagle, name: 'Eagle Lake', lowC: -1 },
      ],
    );
    // Eagle merged into Clouds; Kinsman's body is gone.
    await t.run(async (ctx) => {
      await ctx.db.patch(eagle, { mergedIntoId: clouds });
      await ctx.db.delete(kinsman);
    });
    await seedSeries(t, clouds, '2026-10-01', [-1, -2]);
    await seedSeries(t, dropped, '2026-10-01', [-2, -3]);
    const r = await mod.query(api.sentinelLows.forSeason, { now: NOW });
    if (r.state !== 'value') throw new Error(r.state);
    expect(r.sentinels.map((s) => [s.key, s.status])).toEqual([
      [clouds, 'read'],
      [kinsman, 'gone'],
      [dropped, 'read'],
    ]);
    // Eagle fired: its marker goes on the row its lake now is (Clouds's); Bog Pond's on its own.
    expect(r.opened?.sites.map((s) => s.key)).toEqual([dropped, clouds]);
    expect(r.opened?.of).toBe(4);
  });
});

/** Rosters, merges and event records, generated: every named site lands on exactly one row — its lake's. */
describe('sentinelRows over generated rosters and merges', () => {
  const world = fc.record({
    ids: fc.uniqueArray(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'), {
      minLength: 1,
      maxLength: 6,
    }),
    // Each id leads to a lake (another id's, its own), is gone, or unread.
    lead: fc.array(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', null, 'unread'), {
      minLength: 6,
      maxLength: 6,
    }),
    fired: fc.array(fc.nat(5), { maxLength: 6 }),
  });
  const property = fc.property(world, ({ ids, lead, fired }) => {
    const lakeOf = (id: string): Lake => {
      const l = lead[(ids as readonly string[]).indexOf(id)];
      return l === undefined
        ? 'unread'
        : l === null
          ? null
          : l === 'unread'
            ? 'unread'
            : `lake-${l}`;
    };
    const named = fired.map((i) => ids[i % ids.length] as string);
    const candidates = [...ids, ...named].map((id) => ({ savedId: id, name: `n-${id}` }));
    const { rows, keyOf } = sentinelRows(candidates, lakeOf);
    // One row per identity, never two for one lake.
    const lakes = rows
      .map((r) => r.lake)
      .filter((l): l is string => typeof l === 'string' && l !== 'unread');
    expect(new Set(lakes).size).toBe(lakes.length);
    for (const id of named) {
      const key = siteKey({ waterBodyId: id, name: `n-${id}` }, keyOf, candidates);
      const matching = rows.filter((r) => r.key === key);
      // Exactly one row, and it is the site's lake's (or, gone or unread, its own).
      expect(matching).toHaveLength(1);
      const lake = lakeOf(id);
      if (typeof lake === 'string' && lake !== 'unread') expect(matching[0]?.lake).toBe(lake);
      else expect(matching[0]?.key).toBe(id);
    }
  });

  test('every marker the record names lands once, on its sentinel’s line (pinned seeds and one random)', () => {
    for (const seed of [20261117, 150, 127]) fc.assert(property, { seed, numRuns: 300 });
    fc.assert(property, { numRuns: 300 });
  });

  test('a site stored before ids is matched by name; a name no row has is no row', () => {
    const candidates = [{ savedId: 'a', name: 'Kinsman Pond' }];
    const { keyOf } = sentinelRows(candidates, () => 'lake-a');
    expect(siteKey({ name: 'Kinsman Pond' }, keyOf, candidates)).toBe('a');
    expect(siteKey({ name: 'Elsewhere' }, keyOf, candidates)).toBeNull();
  });

  test('a site stored by name lands on the row its sentinel’s lake now is, though that row has another name', () => {
    // Eagle merged into Clouds: one row, Clouds's — a name-only site naming Eagle marks it.
    const candidates = [
      { savedId: 'clouds', name: 'Upper Lake of the Clouds' },
      { savedId: 'eagle', name: 'Eagle Lake' },
    ];
    const { rows, keyOf } = sentinelRows(candidates, () => 'lake-clouds');
    expect(rows.map((r) => r.key)).toEqual(['clouds']);
    expect(siteKey({ name: 'Eagle Lake' }, keyOf, candidates)).toBe('clouds');
  });
});

// ── The dates are the watch's own ─────────────────────────────────────────────────────────────

/** An hourly series in a site's zone, spanning a DST change: what the watch cuts into nights. */
const hourly = fc
  .record({
    // A start somewhere in the five days before either change (8 Mar or 1 Nov 2026).
    change: fc.constantFrom('2026-03-08T00:00:00Z', '2026-11-01T00:00:00Z'),
    offsetHours: fc.integer({ min: -120, max: 0 }),
    temps: fc.array(fc.option(fc.double({ min: -30, max: 15, noNaN: true }), { nil: null }), {
      minLength: 24 * 3,
      maxLength: 24 * 9,
    }),
  })
  .map(({ change, offsetHours, temps }) => {
    // Whole hours from a New York midnight, so the first day is never a truncated one.
    const start = Date.parse(change) / 1000 + (offsetHours + 5) * 3600;
    return { times: temps.map((_, i) => start + i * 3600), temps };
  });

describe('the window reads the watch’s nights back unchanged', () => {
  const property = fc.property(hourly, ({ times, temps }) => {
    const nights = dailyLowsFromHourly(times, temps, 'America/New_York', -5 * 3600);
    fc.pre(nights.length > 0);
    const stored = mergeLows(null, nights);
    const first = nights[0]?.date as string;
    const last = lastStoredNight(stored, first, '9999-12-31') as string;
    const aligned = alignLows(stored, first, last);
    const dates = nightsBetween(first, last);
    // Every night the watch cut lands on its own date with its own value; every other date is a gap.
    const byDate = new Map(expandLows(stored).map((d) => [d.date, d.minTempC]));
    dates.forEach((date, i) => {
      expect(aligned[i]).toBe(byDate.get(date) ?? null);
    });
    for (const n of nights) expect(aligned[dates.indexOf(n.date)]).toBe(n.minTempC);
    // The dates are consecutive calendar days, the watch's own `addDaysIso`.
    dates.slice(1).forEach((d, i) => {
      expect(d).toBe(addDaysIso(dates[i] as string, 1));
    });
  });

  test('every night keeps its date and its value, across both DST changes (pinned seeds and one random)', () => {
    for (const seed of [20261117, 8, 1101]) fc.assert(property, { seed, numRuns: 150 });
    fc.assert(property, { numRuns: 150 });
  });

  test('a window outside what is stored is all gaps; an empty store is all gaps', () => {
    expect(alignLows(null, '2026-10-01', '2026-10-03')).toEqual([null, null, null]);
    expect(alignLows({ firstDate: '', lows: [] }, '2026-10-01', '2026-10-01')).toEqual([null]);
    expect(
      lastStoredNight(
        { firstDate: '2026-10-01', lows: [null, 1, null] },
        '2026-10-01',
        '2026-10-30',
      ),
    ).toBe('2026-10-02');
    expect(
      lastStoredNight({ firstDate: '2026-10-01', lows: [1] }, '2026-10-02', '2026-10-30'),
    ).toBeNull();
  });
});
