/**
 * The Overview's server reads (B01, the B01-2 server register): Metrics' three sections, the season's
 * reach, the day pulse, the season summaries, the Corpus and Machinery cards, colleague presence and
 * the machine's feed rows. What is pinned, across all of them:
 *
 *  - **`null` is not recorded, never zero** — a day no rollup wrote, a total the walk hasn't produced,
 *    a record that began partway through the week;
 *  - **the season window is one rule** — 1 October through today, a past season whole, empty from
 *    1 July to 30 September;
 *  - **open flags include `reviewing`**, everywhere;
 *  - **kudos are positive reactions** — a thumbs-down is never counted;
 *  - **the capability map decides who reads what** — moderators read Metrics and the season summary,
 *    support's half and Machinery stay admin's.
 */
import { metricDay } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { cardRows, type JobRow } from './machinery';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Friday 13 November 2026, 15:00 UTC: season 2026, its record open since 1 October (44 days). */
const NOW = Date.UTC(2026, 10, 13, 15);
const TODAY = '2026-11-13';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

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

async function seedUser(
  t: T,
  subject: string,
  role: 'member' | 'moderator' | 'admin' = 'member',
  extra: Record<string, unknown> = {},
) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Person`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: NOW - 400 * DAY,
      ...extra,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

let seq = 0;
async function seedBody(t: T, name: string, extra: Record<string, unknown> = {}) {
  const i = seq++;
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name,
      searchText: name,
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [i, 0],
            [i, 1],
            [i + 1, 1],
            [i + 1, 0],
            [i, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: i, maxLat: 1, maxLng: i + 1 },
      centroid: { lat: 0.5, lng: i + 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: NOW - 400 * DAY,
      ...extra,
    }),
  );
}

async function seedReport(
  t: T,
  authorId: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
  skateEndTime: number,
  extra: Record<string, unknown> = {},
) {
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime,
      reportTime: skateEndTime,
      source: 'native' as const,
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: skateEndTime,
      updatedAt: skateEndTime,
      ...extra,
    }),
  );
}

async function seedComment(
  t: T,
  authorId: Id<'profiles'>,
  reportId: Id<'reports'>,
  createdAt: number,
  extra: Record<string, unknown> = {},
) {
  return t.run((ctx) =>
    ctx.db.insert('comments', {
      reportId,
      authorId,
      body: 'Thanks',
      source: 'native' as const,
      moderationStatus: 'visible' as const,
      createdAt,
      ...extra,
    }),
  );
}

async function seedRating(
  t: T,
  raterId: Id<'profiles'>,
  reportId: Id<'reports'>,
  verdict: 'helpful' | 'unhelpful',
  createdAt: number,
) {
  return t.run((ctx) =>
    ctx.db.insert('reportRatings', {
      targetType: 'report' as const,
      targetId: reportId,
      raterId,
      verdict,
      createdAt,
    }),
  );
}

async function seedPhoto(
  t: T,
  uploaderId: Id<'profiles'>,
  createdAt: number,
  reportId?: Id<'reports'>,
) {
  return t.run((ctx) =>
    ctx.db.insert('photos', {
      storageId: 's',
      thumbStorageId: 't',
      uploaderId,
      placeOnMap: false,
      createdAt,
      ...(reportId ? { reportId } : {}),
    }),
  );
}

async function seedHazard(
  t: T,
  author: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
  at: number,
) {
  return t.run((ctx) =>
    ctx.db.insert('hazards', {
      waterBodyId,
      type: 'pressure_ridge' as const,
      geometryKind: 'point_radius' as const,
      geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
      radiusMeters: 30,
      bbox: { minLat: 0.49, minLng: 0.49, maxLat: 0.51, maxLng: 0.51 },
      createdByUserId: author,
      photoIds: [],
      status: 'active' as const,
      moderationStatus: 'visible' as const,
      firstReportedAt: at,
      lastConfirmedAt: at,
      confirmCount: 0,
      goneCount: 0,
      createdAt: at,
    }),
  );
}

async function seedFlag(
  t: T,
  flaggerId: Id<'profiles'>,
  targetType: 'report' | 'waterbody' | 'user',
  targetId: string,
  extra: Record<string, unknown> = {},
) {
  return t.run((ctx) =>
    ctx.db.insert('contentFlags', {
      flaggerId,
      targetType,
      targetId,
      reason: 'spam' as const,
      status: 'open' as const,
      createdAt: NOW,
      ...extra,
    }),
  );
}

async function snapshot(
  t: T,
  metric: string,
  date: string,
  payload: { scalar?: number; buckets?: number[]; meta?: unknown },
) {
  await t.run((ctx) =>
    ctx.db.insert('metricSnapshots', { metric, date, ...payload, updatedAt: NOW }),
  );
}

const readSnapshot = (t: T, metric: string, date: string) =>
  t.run((ctx) =>
    ctx.db
      .query('metricSnapshots')
      .withIndex('by_metric_date', (q) => q.eq('metric', metric).eq('date', date))
      .unique(),
  );

/** Walk the season's reach to its end, one scheduled page at a time, as production does. */
async function walkReach(t: T, season?: number) {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  await t.mutation(internal.seasonReach.start, season === undefined ? {} : { season });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
}

// ── Open flags: one definition ──────────────────────────────────────────────────────────────────

describe('open flags include reviewing, everywhere (the governor’s ruling)', () => {
  test('the Overview counts a flag under review as open, in its lane and its age', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const s = await seedUser(t, 's');
    await seedFlag(t, s.id, 'report', 'r1', { status: 'reviewing', createdAt: NOW - 3 * DAY });
    await seedFlag(t, s.id, 'report', 'r2');
    await seedFlag(t, s.id, 'report', 'r3', { status: 'dismissed' });
    const o = await mod.as.query(api.console.overview, {});
    expect(o.inbox.contentFlags).toEqual({ count: 2, capped: false });
    expect(o.inbox.oldestOpenAt).toBe(NOW - 3 * DAY);
  });

  test('the rollup’s queue depth and Metrics’ open flags agree with it', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const s = await seedUser(t, 's');
    await seedFlag(t, s.id, 'report', 'r1', { status: 'reviewing', reason: 'unsafe_false_report' });
    await seedFlag(t, s.id, 'report', 'r2');
    await t.mutation(internal.analyticsRollup.rollupOperationalJob, {});
    expect((await readSnapshot(t, 'flag_queue_depth', TODAY))?.meta).toEqual({
      priority: 1,
      standard: 1,
    });
    const k = await mod.as.query(api.metrics.keepingUp, {});
    expect(k.keepingUp.openFlags).toEqual({ total: 2, safety: 1 });
  });
});

// ── console.overview additions ──────────────────────────────────────────────────────────────────

describe('console.overview — the Inbox foot and the People total', () => {
  test('the median age is the lower median of what is open', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const s = await seedUser(t, 's');
    await seedFlag(t, s.id, 'report', 'r1', { createdAt: NOW - 4 * DAY });
    await seedFlag(t, s.id, 'report', 'r2', { createdAt: NOW - 1 * DAY });
    await seedFlag(t, s.id, 'report', 'r3', { createdAt: NOW - 2 * HOUR });
    await t.run((ctx) =>
      ctx.db.insert('waterBodyRequests', {
        kind: 'activate' as const,
        status: 'open' as const,
        requesterId: s.id,
        coord: { lat: 43.6, lng: -72.1 },
        createdAt: NOW - 2 * DAY,
      }),
    );
    const o = await mod.as.query(api.console.overview, {});
    expect(o.inbox.medianAgeMs).toBe(DAY);
  });

  test('the median age is not recorded once a lane read stopped short', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const s = await seedUser(t, 's');
    for (let i = 0; i < 201; i++) await seedFlag(t, s.id, 'report', `r${i}`);
    expect((await mod.as.query(api.console.overview, {})).inbox.medianAgeMs).toBeNull();
  });

  test('nothing open: no age at all', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const o = await mod.as.query(api.console.overview, {});
    expect(o.inbox.oldestOpenAt).toBeNull();
    expect(o.inbox.medianAgeMs).toBeNull();
  });

  test('total users comes from the rollup — not recorded until it runs, a floor when capped', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await seedUser(t, 'a');
    await seedUser(t, 'gone', 'member', { status: 'deleted' });
    expect((await mod.as.query(api.console.overview, {})).people.totalUsers).toBeNull();
    await t.mutation(internal.analyticsRollup.rollupDistributionsJob, {});
    expect((await mod.as.query(api.console.overview, {})).people.totalUsers).toEqual({
      count: 2,
      capped: false,
    });
    await snapshot(t, 'accounts_total', '2026-11-14', { scalar: 5000, meta: { capped: true } });
    expect((await mod.as.query(api.console.overview, {})).people.totalUsers).toEqual({
      count: 5000,
      capped: true,
    });
  });
});

describe('console.corpusCounts — the Corpus card’s tasks', () => {
  test('duplicates count as decisions, re-fits across bodies, open place names, the last campaign', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const a = await seedBody(t, 'Mud Pond', {
      reviewReason: 'duplicate-candidate',
      displayScore: 1,
    });
    const b = await seedBody(t, 'Mud Pond', {
      reviewReason: 'duplicate-candidate',
      displayScore: 1,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(a, { duplicateCandidateIds: [b] });
      await ctx.db.patch(b, { duplicateCandidateIds: [a] });
    });
    await seedBody(t, 'Lone Pond', { reviewReason: 'same-source-duplicate', displayScore: 1 });
    const parent = await seedBody(t, 'Big Lake');
    const bay = (extra: Record<string, unknown>) =>
      t.run((ctx) =>
        ctx.db.insert('waterBodySubAreas', {
          waterBodyId: parent,
          name: 'Bay',
          searchText: 'Bay',
          polygon: {
            type: 'Polygon' as const,
            coordinates: [
              [
                [0, 0],
                [0, 1],
                [1, 1],
                [0, 0],
              ],
            ],
          },
          bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
          centroid: { lat: 0.5, lng: 0.5 },
          surfaceAreaSqM: 1,
          displayScore: 1,
          minVisibleZoom: 10,
          createdByUserId: mod.id,
          createdAt: NOW,
          updatedAt: NOW,
          ...extra,
        }),
      );
    await bay({ mouthReview: { outcome: 'kept', note: 'moved' } });
    await bay({ mouthReview: { outcome: 'refitted', note: 'moved' }, mouthStale: 'islet' });
    await bay({ mouthStale: 'islet' });
    await bay({});
    await t.run(async (ctx) => {
      for (const status of ['open', 'open', 'dismissed'] as const) {
        await ctx.db.insert('corpusPlaceNames', {
          name: 'Apple Island',
          askKey: `apple-${Math.random()}`,
          aliases: [],
          messages: 3,
          skatedMessages: 1,
          states: ['VT'],
          status,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
      await ctx.db.insert('importRuns', {
        kind: 'corpus_merge' as const,
        label: 'merge',
        deployment: 'dev',
        isProd: false,
        status: 'succeeded' as const,
        startedAt: NOW - 3 * DAY,
        counts: [],
        stages: [],
        failures: [],
        failuresTotal: 0,
      });
    });

    const c = await mod.as.query(api.console.corpusCounts, {});
    expect(c.duplicates).toEqual({ count: 2, capped: false });
    expect(c.chordRefits).toEqual({ count: 3, capped: false });
    expect(c.placeNames).toEqual({ count: 2, capped: false });
    expect(c.campaignAt).toBe(NOW - 3 * DAY);
    // No record says when the pre-ice pass ran, and nothing indexes the enrichment a body lacks.
    expect(c.preIcePass).toBeNull();
    expect(c.enrichment).toBeNull();
  });

  test('a member is refused', async () => {
    const t = harness();
    const m = await seedUser(t, 'm');
    await expect(m.as.query(api.console.corpusCounts, {})).rejects.toThrow(/requires moderator/i);
  });
});

// ── Colleague presence ──────────────────────────────────────────────────────────────────────────

describe('colleague presence — who else is in the console', () => {
  test('a heartbeat lights a colleague; a quiet one dims, then goes; the viewer is never listed', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator', { profileImageUrl: 'https://img/mod' });
    const admin = await seedUser(t, 'adm', 'admin');
    await mod.as.mutation(api.console.heartbeat, {});
    await admin.as.mutation(api.console.heartbeat, {});

    expect(await admin.as.query(api.console.colleagues, { now: NOW })).toEqual([
      { id: mod.id, name: 'mod Person', src: 'https://img/mod', present: true },
    ]);
    vi.setSystemTime(NOW + 5 * MINUTE);
    expect(await admin.as.query(api.console.colleagues, { now: NOW + 5 * MINUTE })).toEqual([
      expect.objectContaining({ id: mod.id, present: false }),
    ]);
    vi.setSystemTime(NOW + 20 * MINUTE);
    expect(await admin.as.query(api.console.colleagues, { now: NOW + 20 * MINUTE })).toEqual([]);
  });

  test('one write a heartbeat interval at most, however often the page asks', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.console.heartbeat, {});
    vi.setSystemTime(NOW + 10_000);
    await mod.as.mutation(api.console.heartbeat, {});
    const rows = await t.run((ctx) => ctx.db.query('consolePresence').collect());
    expect(rows).toEqual([expect.objectContaining({ userId: mod.id, seenAt: NOW })]);
    vi.setSystemTime(NOW + 40_000);
    await mod.as.mutation(api.console.heartbeat, {});
    expect((await t.run((ctx) => ctx.db.query('consolePresence').collect()))[0]?.seenAt).toBe(
      NOW + 40_000,
    );
  });

  test('a skater can neither beat nor look; someone no longer staff is not listed', async () => {
    const t = harness();
    const member = await seedUser(t, 'm');
    const mod = await seedUser(t, 'mod', 'moderator');
    const former = await seedUser(t, 'former', 'moderator');
    await expect(member.as.mutation(api.console.heartbeat, {})).rejects.toThrow(
      /requires moderator/i,
    );
    await expect(member.as.query(api.console.colleagues, { now: NOW })).rejects.toThrow(
      /requires moderator/i,
    );
    await former.as.mutation(api.console.heartbeat, {});
    await t.run((ctx) => ctx.db.patch(former.id, { role: 'member' }));
    expect(await mod.as.query(api.console.colleagues, { now: NOW })).toEqual([]);
  });

  test('a skewed clock cannot widen the window', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const admin = await seedUser(t, 'adm', 'admin');
    await mod.as.mutation(api.console.heartbeat, {});
    vi.setSystemTime(NOW + 30 * MINUTE);
    expect(await admin.as.query(api.console.colleagues, { now: NOW })).toEqual([]);
  });
});

// ── The machine's feed rows ─────────────────────────────────────────────────────────────────────

describe('console.systemFeed — what the machines did', () => {
  async function seedRuns(t: T) {
    await t.run(async (ctx) => {
      await ctx.db.insert('importRuns', {
        kind: 'canonical_water' as const,
        label: 'VT canonical water',
        deployment: 'dev',
        isProd: false,
        status: 'failed' as const,
        startedAt: NOW - 3 * HOUR,
        finishedAt: NOW - 2 * HOUR,
        counts: [],
        stages: [],
        failures: [],
        failuresTotal: 0,
      });
      await ctx.db.insert('importRuns', {
        kind: 'canonical_water' as const,
        label: 'NH canonical water',
        deployment: 'dev',
        isProd: false,
        status: 'running' as const,
        startedAt: NOW - HOUR,
        counts: [],
        stages: [],
        failures: [],
        failuresTotal: 0,
      });
      for (const [i, outcome] of (['ok', 'refused', 'failed'] as const).entries()) {
        await ctx.db.insert('imageryRuns', {
          season: 'winter-2026-27',
          kind: 'pump' as const,
          startedAt: NOW - 30 * MINUTE + i * MINUTE,
          finishedAt: NOW - 29 * MINUTE + i * MINUTE,
          outcome,
        });
      }
      await ctx.db.insert('imageryIngestSeasons', {
        season: 'winter-2026-27',
        opensOn: '2026-10-03',
        openedBy: ['sentinel'],
        winterFrom: null,
        sitesSampled: 27,
        detectedAt: NOW - 40 * DAY,
      });
    });
  }

  test('an admin sees imports, imagery trouble and the watch, newest first', async () => {
    const t = harness();
    const admin = await seedUser(t, 'adm', 'admin');
    await seedRuns(t);
    const rows = await admin.as.query(api.console.systemFeed, {});
    expect(rows.map((r) => r.action)).toEqual([
      'Imagery pump failed',
      'Imagery pump refused',
      'Import failed',
      'Ice watch opened',
    ]);
    expect(rows.every((r) => r.actor === null)).toBe(true);
    expect(rows[2]?.target).toEqual(
      expect.objectContaining({ type: 'importRun', label: 'VT canonical water' }),
    );
  });

  test('a moderator sees only the watch; the limit is honored', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await seedRuns(t);
    expect((await mod.as.query(api.console.systemFeed, {})).map((r) => r.action)).toEqual([
      'Ice watch opened',
    ]);
    const admin = await seedUser(t, 'adm', 'admin');
    expect(await admin.as.query(api.console.systemFeed, { limit: 1 })).toHaveLength(1);
  });

  test('a closed watch says so', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await t.run((ctx) =>
      ctx.db.insert('imageryIngestSeasons', {
        season: 'winter-2025-26',
        opensOn: '2025-10-04',
        openedBy: ['sentinel'],
        winterFrom: '2025-12-01',
        closesOn: '2026-05-05',
        closedAt: NOW - 190 * DAY,
        sitesSampled: 27,
        detectedAt: NOW - 400 * DAY,
      }),
    );
    expect((await mod.as.query(api.console.systemFeed, {})).map((r) => r.action)).toEqual([
      'Ice watch closed',
      'Ice watch opened',
    ]);
  });
});

// ── The day pulse ───────────────────────────────────────────────────────────────────────────────

describe('the day pulse rollup', () => {
  test('counts visible comments, attached photos, kudos and contributors for the day', async () => {
    const t = harness();
    const ada = await seedUser(t, 'ada');
    const bo = await seedUser(t, 'bo');
    const cy = await seedUser(t, 'cy');
    const body = await seedBody(t, 'Mascoma Lake');
    const report = await seedReport(t, ada.id, body, NOW - HOUR);
    await seedComment(t, bo.id, report, NOW - HOUR);
    await seedComment(t, bo.id, report, NOW - HOUR, { moderationStatus: 'hidden' });
    await seedComment(t, cy.id, report, NOW - HOUR, { authorDeletedAt: NOW });
    await seedPhoto(t, ada.id, NOW - HOUR, report);
    await seedPhoto(t, ada.id, NOW - HOUR);
    await seedRating(t, cy.id, report, 'helpful', NOW - HOUR);
    await seedRating(t, bo.id, report, 'unhelpful', NOW - HOUR);
    await seedHazard(t, cy.id, body, NOW - HOUR);

    await t.mutation(internal.analyticsRollup.rollupDayJob, { date: TODAY });
    expect(await readSnapshot(t, 'comments_created', TODAY)).toEqual(
      expect.objectContaining({ scalar: 1, meta: { reports: 1 } }),
    );
    expect(await readSnapshot(t, 'photos_added', TODAY)).toEqual(
      expect.objectContaining({ scalar: 1, meta: { reports: 1 } }),
    );
    // A thumbs-down is never a negative kudos, and never counted.
    expect(await readSnapshot(t, 'positive_reactions', TODAY)).toEqual(
      expect.objectContaining({ scalar: 1, meta: { helpful: 1 } }),
    );
    // Ada reported, Bo commented, Cy filed a hazard (her withdrawn comment doesn't count).
    expect((await readSnapshot(t, 'daily_contributors', TODAY))?.scalar).toBe(3);
  });

  test('sign-ins are written only from the day their record began', async () => {
    const t = harness();
    const ada = await seedUser(t, 'ada');
    await t.mutation(internal.analyticsRollup.rollupDayJob, { date: TODAY });
    expect(await readSnapshot(t, 'signed_in', TODAY)).toBeNull();
    await t.run((ctx) =>
      ctx.db.insert('signInDays', { userId: ada.id, day: '2026-11-12', firstAt: NOW - DAY }),
    );
    await t.mutation(internal.analyticsRollup.rollupDayJob, { date: '2026-11-11' });
    await t.mutation(internal.analyticsRollup.rollupDayJob, { date: TODAY });
    expect(await readSnapshot(t, 'signed_in', '2026-11-11')).toBeNull();
    // After the record began, a day nobody came is a measured zero.
    expect((await readSnapshot(t, 'signed_in', TODAY))?.scalar).toBe(0);
  });

  test('accounts_total counts every account that exists', async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, 'a');
    await seedUser(t, 'b');
    await seedUser(t, 'gone', 'member', { status: 'deleted' });
    await t.mutation(internal.analyticsRollup.rollupDistributionsJob, {});
    const row = await readSnapshot(t, 'accounts_total', TODAY);
    expect(row?.scalar).toBe(2);
    expect(row?.meta).toBeUndefined();
  });

  test('the rollup schedules the season walk with its jobs', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.analyticsRollup.runRollup, {});
    const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(jobs.some((j) => j.name.includes('seasonReach'))).toBe(true);
  });
});

// ── The season's reach ──────────────────────────────────────────────────────────────────────────

/** A season with something in every source: two bodies in two states, three people. */
async function seedSeason(t: T) {
  const ada = await seedUser(t, 'ada');
  const bo = await seedUser(t, 'bo');
  const cy = await seedUser(t, 'cy');
  const mascoma = await seedBody(t, 'Mascoma Lake');
  const morey = await seedBody(t, 'Lake Morey');
  const post = await t.run((ctx) =>
    ctx.db.insert('posts', {
      authorId: ada.id,
      reportIds: [],
      photoIds: [],
      moderationStatus: 'visible' as const,
      latestSkateEndTime: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
  const nh = { place: { state: 'NH' } };
  const vt = { place: { state: 'VT' } };
  const r1 = await seedReport(t, ada.id, mascoma, NOW - 10 * DAY, {
    ...nh,
    observedFrom: 'on_ice',
    postId: post,
  });
  const r2 = await seedReport(t, bo.id, mascoma, NOW - 2 * DAY, {
    ...nh,
    observedFrom: 'shore',
    postId: post,
  });
  await seedReport(t, cy.id, morey, NOW - 5 * DAY, vt);
  // Before the record opened (September) and hidden: neither counts.
  await seedReport(t, ada.id, morey, Date.UTC(2026, 8, 20), vt);
  await seedReport(t, ada.id, morey, NOW - DAY, { ...vt, moderationStatus: 'hidden' });
  await seedComment(t, cy.id, r1, NOW - 9 * DAY);
  await seedComment(t, cy.id, r2, NOW - DAY);
  await seedRating(t, bo.id, r1, 'helpful', NOW - 9 * DAY);
  await seedRating(t, cy.id, r1, 'helpful', NOW - 8 * DAY);
  await seedRating(t, ada.id, r2, 'unhelpful', NOW - DAY);
  const photos = [
    await seedPhoto(t, ada.id, NOW - 10 * DAY, r1),
    await seedPhoto(t, ada.id, NOW - 10 * DAY, r1),
  ];
  await t.run((ctx) => ctx.db.patch(r1, { photoIds: photos }));
  await seedHazard(t, bo.id, morey, NOW - 3 * DAY);
  await t.run(async (ctx) => {
    await ctx.db.insert('signInDays', { userId: ada.id, day: '2026-11-01', firstAt: NOW });
    await ctx.db.insert('signInDays', { userId: ada.id, day: '2026-11-02', firstAt: NOW });
    await ctx.db.insert('signInDays', { userId: bo.id, day: '2026-11-02', firstAt: NOW });
  });
  return { ada, bo, cy, mascoma, morey };
}

describe('the season’s reach', () => {
  test('counts the season from 1 October, each person and post once, and ranks the bodies', async () => {
    const t = harness();
    const { mascoma, morey } = await seedSeason(t);
    await walkReach(t);
    const reach = (await readSnapshot(t, 'season_reach', TODAY))?.meta as Record<string, unknown>;
    expect(reach).toEqual(
      expect.objectContaining({
        season: 2026,
        through: TODAY,
        counts: { reports: 3, comments: 2, kudos: 2, photos: 2, hazards: 1 },
        over: { reports: 1, comments: 2, kudos: 2, photos: 1, hazards: 1 },
        people: { signedIn: 2, contributors: 3 },
        vantage: { on_ice: 1, shore: 1, unstated: 1 },
        capped: [],
      }),
    );
    expect((reach.states as Record<string, unknown>).NH).toEqual({
      reports: 2,
      comments: 2,
      photos: 2,
      kudos: 2,
      contributors: 3,
    });
    const ranked = (await readSnapshot(t, 'most_reported', TODAY))?.meta as {
      rows: Array<{ bodyId: string; reports: number; photos: number; people: number }>;
    };
    expect(ranked.rows.map((r) => [r.bodyId, r.reports, r.photos, r.people])).toEqual([
      [mascoma, 2, 2, 2],
      [morey, 1, 0, 1],
    ]);
  });

  test('walks a page at a time, past one page of rows', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 320; i++) {
        const id = await ctx.db.insert('profiles', {
          clerkUserId: `p${i}`,
          displayName: `p${i}`,
          username: `p${i}`,
          driveTimePrefMinutes: 60,
          profileVisibility: 'public' as const,
          notificationPrefs: NOTIF_PREFS,
          dateOfBirth: Date.UTC(1990, 0, 1),
          reputationPoints: 0,
          role: 'member' as const,
          status: 'active' as const,
          createdAt: NOW,
        });
        await ctx.db.insert('signInDays', { userId: id, day: '2026-11-03', firstAt: NOW });
      }
    });
    await walkReach(t);
    const reach = (await readSnapshot(t, 'season_reach', TODAY))?.meta as {
      people: { signedIn: number };
    };
    expect(reach.people.signedIn).toBe(320);
  });

  test('walks nothing before the record opens, and a past season whole', async () => {
    const t = convexTest(schema, modules);
    vi.setSystemTime(Date.UTC(2026, 7, 10));
    expect(await t.mutation(internal.seasonReach.start, {})).toEqual({
      season: 2026,
      walking: false,
    });
    vi.setSystemTime(NOW);
    const ada = await seedUser(t, 'ada');
    const body = await seedBody(t, 'Kezar Lake');
    await seedReport(t, ada.id, body, Date.UTC(2026, 1, 3));
    await walkReach(t, 2025);
    const reach = (await readSnapshot(t, 'season_reach', '2026-06-30'))?.meta as {
      season: number;
      counts: { reports: number };
    };
    expect(reach.season).toBe(2025);
    expect(reach.counts.reports).toBe(1);
  });
});

// ── Metrics: Keeping up ─────────────────────────────────────────────────────────────────────────

describe('metrics.keepingUp', () => {
  test('the queue now, the oldest flag’s body, and the season from the rollup rows', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const s = await seedUser(t, 's');
    const body = await seedBody(t, 'Mascoma Lake');
    const report = await seedReport(t, s.id, body, NOW - 5 * DAY);
    await seedFlag(t, s.id, 'report', report, {
      createdAt: NOW - 2 * DAY,
      reason: 'unsafe_false_report',
    });
    await seedFlag(t, s.id, 'user', s.id, { createdAt: NOW - HOUR });
    await snapshot(t, 'flag_time_to_resolution_h', '2026-11-12', {
      buckets: [1, 0, 0, 0, 0, 0, 0, 0],
    });
    await snapshot(t, 'flag_time_to_resolution_h', '2026-10-02', {
      buckets: [0, 2, 0, 0, 0, 0, 0, 1],
    });
    await snapshot(t, 'flag_oldest_open_age_h', '2026-10-02', { scalar: 30 });
    await snapshot(t, 'flag_queue_depth', '2026-10-02', {
      scalar: 3,
      meta: { priority: 1, standard: 2 },
    });

    const k = await mod.as.query(api.metrics.keepingUp, {});
    expect(k.season).toBe(2026);
    expect(k.opensOn).toBe('2026-10-01');
    expect(k.days).toHaveLength(44);
    expect(k.keepingUp.openFlags).toEqual({ total: 2, safety: 1 });
    expect(k.keepingUp.oldestOpenFlag).toEqual({ openedAt: NOW - 2 * DAY, where: 'Mascoma Lake' });
    expect(k.keepingUp.resolvedWeek).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(k.keepingUp.resolveSeason).toEqual([1, 2, 0, 0, 0, 0, 0, 1]);
    expect(k.keepingUp.queueByDay[0]).toBeNull();
    expect(k.keepingUp.queueByDay[1]).toEqual({ oldestHours: 30, standard: 2, safety: 1 });
    // Support is PII (D37): a moderator's read has none of it.
    expect(k.keepingUp.support).toBeNull();
  });

  test('nothing recorded reads as not recorded, never as zero', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const k = await mod.as.query(api.metrics.keepingUp, {});
    expect(k.keepingUp.openFlags).toEqual({ total: 0, safety: 0 });
    expect(k.keepingUp.oldestOpenFlag).toBeNull();
    expect(k.keepingUp.resolvedWeek).toBeNull();
    expect(k.keepingUp.resolveSeason).toBeNull();
    expect(k.keepingUp.queueByDay.every((d) => d === null)).toBe(true);
  });

  test('an admin reads support: open tickets, the oldest, and the depth per day', async () => {
    const t = harness();
    const admin = await seedUser(t, 'adm', 'admin');
    await t.run(async (ctx) => {
      await ctx.db.insert('supportTickets', {
        category: 'bug',
        status: 'in_progress',
        body: 'b',
        createdAt: NOW - 2 * DAY,
      });
      await ctx.db.insert('supportTickets', {
        category: 'account',
        status: 'open',
        body: 'a',
        createdAt: NOW,
      });
    });
    await snapshot(t, 'support_queue_depth', TODAY, {
      scalar: 2,
      meta: { bug: 1, account: 1, other: 0 },
    });
    await snapshot(t, 'support_time_to_resolution_h', TODAY, { buckets: [0, 1, 0, 0, 0, 0, 0, 0] });
    const support = (await admin.as.query(api.metrics.keepingUp, {})).keepingUp.support;
    expect(support?.open).toBe(2);
    expect(support?.oldestOpenedAt).toBe(NOW - 2 * DAY);
    expect(support?.resolveSeason).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
    expect(support?.depthByDay.at(-1)).toEqual({ bug: 1, account: 1 });
    expect(support?.depthByDay[0]).toBeNull();
  });

  test('a past season is drawn whole; before 1 October the window is empty', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const past = await mod.as.query(api.metrics.keepingUp, { season: 2025 });
    expect(past.days).toHaveLength(273);
    expect(past.days.at(-1)).toBe('2026-06-30');
    vi.setSystemTime(Date.UTC(2026, 7, 1));
    const pre = await mod.as.query(api.metrics.keepingUp, {});
    expect(pre.season).toBe(2026);
    expect(pre.days).toEqual([]);
    expect(pre.keepingUp.resolveSeason).toBeNull();
    // A season nobody can name reads the season now falls in.
    expect((await mod.as.query(api.metrics.keepingUp, { season: 1.5 })).season).toBe(2026);
  });

  test('a member is refused', async () => {
    const t = harness();
    const m = await seedUser(t, 'm');
    await expect(m.as.query(api.metrics.keepingUp, {})).rejects.toThrow(/requires moderator/i);
  });
});

// ── Metrics: Showing up ─────────────────────────────────────────────────────────────────────────

describe('metrics.showingUp', () => {
  test('this week: reports and their people, contributors and first-timers', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const { ada } = await seedSeason(t);
    // Dee's first contribution of any kind is this week.
    const dee = await seedUser(t, 'dee');
    await seedHazard(t, dee.id, await seedBody(t, 'Crystal Lake'), NOW - DAY);
    // Ada has contributed since October, so this week's report is not her first.
    await seedReport(t, ada.id, await seedBody(t, 'Lake Sunapee'), NOW - HOUR);

    const w = (await mod.as.query(api.metrics.showingUp, {})).showingUp.week;
    // Cy's (five days ago), Bo's (two) and Ada's (today); Ada's hidden one never counts.
    expect(w.reports).toEqual({ count: 3, people: 3 });
    // Ada, Bo, Cy and Dee. Bo's first contribution (a hazard three days ago) and Dee's are this
    // week; Ada's reports go back to September and Cy commented on the 4th.
    expect(w.contributors).toEqual({ people: 4, firstTime: 2 });
  });

  test('accounts: not recorded until the total is; sign-ins: not until the record covers the week', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await seedUser(t, 'new', 'member', { createdAt: NOW - DAY });
    let w = (await mod.as.query(api.metrics.showingUp, {})).showingUp.week;
    expect(w.accounts).toBeNull();
    expect(w.signedIn).toBeNull();

    await t.mutation(internal.analyticsRollup.rollupDistributionsJob, {});
    await t.run(async (ctx) => {
      await ctx.db.insert('signInDays', { userId: mod.id, day: '2026-11-10', firstAt: NOW });
    });
    w = (await mod.as.query(api.metrics.showingUp, {})).showingUp.week;
    expect(w.accounts).toEqual({ added: 1, total: 2 });
    // The record began on the 10th: the week from the 7th isn't whole.
    expect(w.signedIn).toBeNull();

    await t.run(async (ctx) => {
      await ctx.db.insert('signInDays', { userId: mod.id, day: '2026-11-01', firstAt: NOW });
      await ctx.db.insert('signInDays', { userId: mod.id, day: '2026-11-12', firstAt: NOW });
    });
    w = (await mod.as.query(api.metrics.showingUp, {})).showingUp.week;
    expect(w.signedIn).toEqual({ people: 1, twoDaysOrMore: 1 });
  });

  test('the pulse is not recorded until the season has been walked, then reads it whole', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const { mascoma } = await seedSeason(t);
    let s = (await mod.as.query(api.metrics.showingUp, {})).showingUp;
    expect(s.pulse.reports).toBeNull();
    expect(s.vantage).toBeNull();
    expect(s.mostReported).toBeNull();

    await t.mutation(internal.analyticsRollup.rollupDayJob, { date: TODAY });
    await walkReach(t);
    s = (await mod.as.query(api.metrics.showingUp, {})).showingUp;
    expect(s.pulse.reports).toEqual(expect.objectContaining({ total: 3, over: 1 }));
    expect(s.pulse.reports?.daily).toHaveLength(44);
    expect(s.pulse.reports?.daily.at(-1)).toBe(0);
    expect(s.pulse.reports?.daily[0]).toBeNull();
    expect(s.pulse.kudos).toEqual(expect.objectContaining({ total: 2, over: 2 }));
    expect(s.pulse.signedIn).toEqual(expect.objectContaining({ total: 2 }));
    expect(s.pulse.contributors).toEqual(expect.objectContaining({ total: 3 }));
    // New accounts add up their days, so they wait for every day of the season to be recorded.
    expect(s.pulse.accounts).toBeNull();
    expect(s.vantage).toEqual({ on_ice: 1, shore: 1, secondhand: 0, unstated: 1 });
    expect(s.mostReported?.[0]).toEqual(
      expect.objectContaining({
        bodyId: mascoma,
        name: 'Mascoma Lake',
        reports: 2,
        photos: 2,
        people: 2,
      }),
    );
  });

  test('new accounts read as a total once every day is recorded', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await seedUser(t, 'fresh', 'member', { createdAt: NOW - HOUR });
    for (let i = 43; i >= 0; i--) {
      await t.mutation(internal.analyticsRollup.rollupDayJob, { date: metricDay(NOW - i * DAY) });
    }
    await walkReach(t);
    const accounts = (await mod.as.query(api.metrics.showingUp, {})).showingUp.pulse.accounts;
    expect(accounts?.total).toBe(1);
    expect(accounts?.daily.at(-1)).toBe(1);
  });

  test('a capped set is not recorded rather than a floor', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await snapshot(t, 'season_reach', TODAY, {
      meta: {
        season: 2026,
        counts: { reports: 9, comments: 0, kudos: 0, photos: 0, hazards: 0 },
        over: { reports: 9, comments: 0, kudos: 0, photos: 0, hazards: 0 },
        people: { signedIn: 20_000, contributors: 4 },
        vantage: {},
        states: {},
        capped: ['signedIn', 'posts'],
      },
    });
    const pulse = (await mod.as.query(api.metrics.showingUp, {})).showingUp.pulse;
    expect(pulse.signedIn).toBeNull();
    expect(pulse.reports).toBeNull();
    expect(pulse.contributors?.total).toBe(4);
  });

  test('another season’s walk is never read as this one’s', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await snapshot(t, 'season_reach', TODAY, { meta: { season: 2025 } });
    expect((await mod.as.query(api.metrics.showingUp, {})).showingUp.vantage).toBeNull();
  });
});

// ── Metrics: Coverage by state ──────────────────────────────────────────────────────────────────

describe('metrics.coverage', () => {
  test('not recorded until the corpus sweep has run', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    expect((await mod.as.query(api.metrics.coverage, {})).coverage).toEqual({
      listedBodies: null,
      states: [],
    });
  });

  test('bodies from the sweep, the season’s activity from the walk, each state by its bodies', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await seedSeason(t);
    await snapshot(t, 'zoom_band_distribution', '2026-11-09', { scalar: 120, meta: {} });
    await snapshot(t, 'state_coverage', '2026-11-09', {
      meta: { 'VT:bodies': 70, 'NH:bodies': 60, 'unknown:bodies': 2, 'VT:reports': 4 },
    });
    let c = (await mod.as.query(api.metrics.coverage, {})).coverage;
    expect(c.listedBodies).toBe(120);
    expect(c.states.map((s) => s.state)).toEqual(['VT', 'NH']);
    // The season hasn't been walked: its columns are not recorded.
    expect(c.states[0]).toEqual({
      state: 'VT',
      bodies: 70,
      reports: null,
      comments: null,
      photos: null,
      kudos: null,
      contributors: null,
    });

    await walkReach(t);
    c = (await mod.as.query(api.metrics.coverage, {})).coverage;
    expect(c.states).toEqual([
      { state: 'VT', bodies: 70, reports: 1, comments: 0, photos: 0, kudos: 0, contributors: 1 },
      { state: 'NH', bodies: 60, reports: 2, comments: 2, photos: 2, kudos: 2, contributors: 3 },
    ]);
  });
});

// ── The season at a glance ──────────────────────────────────────────────────────────────────────

describe('seasonWatch.tape and seasonWatch.homeSummary — for moderators', () => {
  test('waiting: no record yet, nights counted from the floor', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    expect(await mod.as.query(api.seasonWatch.tape, {})).toEqual({
      season: 2026,
      countsFrom: '2026-10-01',
      watch: null,
      imageryNudgeOn: null,
      winterFrom: null,
    });
    const home = await mod.as.query(api.seasonWatch.homeSummary, {});
    expect(home.watch).toBeNull();
    expect(home.winter).toEqual({ state: 'not-yet' });
    expect(home.imagery).toEqual({ state: 'not-started', granules: 0, lastLandedAt: null });
    expect(home.firstSkate).toEqual({ at: null, body: null, lastWinter: null });
  });

  test('open, winter set in for two nights, imagery running, the first skate from on the ice', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const summit = await seedBody(t, 'Upper Lake of the Clouds');
    const a = await seedBody(t, 'Valley A');
    const b = await seedBody(t, 'Valley B');
    await t.run(async (ctx) => {
      await ctx.db.insert('imageryIngestSeasons', {
        season: 'winter-2026-27',
        opensOn: '2026-10-03',
        openedBy: ['sentinel'],
        winterFrom: '2026-11-05',
        winter: { frozen: [{ waterBodyId: a, name: 'Valley A', lowC: -2 }], reporting: 2 },
        sentinels: [{ waterBodyId: summit, name: 'Upper Lake of the Clouds' }],
        opening: {
          sentinels: [{ waterBodyId: summit, name: 'Upper Lake of the Clouds', lowC: -3 }],
          corpus: { frozen: 0, reporting: 2 },
        },
        imageryNudgeOn: '2026-10-20',
        imageryStartedAt: NOW - 10 * DAY,
        sitesSampled: 3,
        detectedAt: NOW - 40 * DAY,
      } as never);
      const site = (id: Id<'waterBodies'>, name: string, lows: number[]) =>
        ctx.db.insert('seasonWatchSeries', {
          season: 'winter-2026-27',
          waterBodyId: id,
          name,
          lat: 44,
          lng: -71,
          source: 'forecast' as const,
          firstDate: '2026-11-05',
          lows,
          updatedAt: NOW,
        });
      await site(summit, 'Upper Lake of the Clouds', [-9, -9, -9, -9]);
      await site(a, 'Valley A', [-2, -1, 3, -1]);
      await site(b, 'Valley B', [1, 2, 4, 3]);
      await ctx.db.insert('imageryCounts', {
        season: 'winter-2026-27',
        queued: 5,
        spawned: 4,
        landed: 3,
        empty: 1,
        failed: 0,
      });
    });
    const ada = await seedUser(t, 'ada');
    await seedReport(t, ada.id, a, NOW - 3 * DAY, { observedFrom: 'shore' });
    await seedReport(t, ada.id, a, NOW - 2 * DAY, { observedFrom: 'on_ice' });
    await seedReport(t, ada.id, b, Date.UTC(2025, 11, 20), { observedFrom: 'on_ice' });

    const tape = await mod.as.query(api.seasonWatch.tape, {});
    expect(tape.watch?.opensOn).toBe('2026-10-03');
    expect(tape.imageryNudgeOn).toBe('2026-10-20');
    expect(tape.winterFrom).toBe('2026-11-05');

    const home = await mod.as.query(api.seasonWatch.homeSummary, {});
    expect(home.watch).toEqual(
      expect.objectContaining({ opensOn: '2026-10-03', openedBy: ['sentinel'], closesOn: null }),
    );
    // Valley A froze the 5th and 6th, half of the two reporting each night; the 7th it thawed.
    expect(home.winter).toEqual({
      state: 'set',
      from: '2026-11-05',
      nights: 2,
      frozen: 1,
      reporting: 2,
      needs: 1,
    });
    expect(home.imagery).toEqual({ state: 'running', granules: 4, lastLandedAt: null });
    expect(home.firstSkate).toEqual({
      at: NOW - 2 * DAY,
      body: 'Valley A',
      lastWinter: { at: Date.UTC(2025, 11, 20), body: 'Valley B' },
    });
  });

  test('a paused imagery run, and a winter recorded without its night', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await t.run((ctx) =>
      ctx.db.insert('imageryIngestSeasons', {
        season: 'winter-2026-27',
        opensOn: '2026-10-03',
        openedBy: ['corpus'],
        winterFrom: '2026-11-05',
        imageryStartedAt: NOW - 10 * DAY,
        imageryPausedAt: NOW - DAY,
        sitesSampled: 3,
        detectedAt: NOW - 40 * DAY,
      }),
    );
    const home = await mod.as.query(api.seasonWatch.homeSummary, {});
    expect(home.imagery.state).toBe('paused');
    expect(home.winter).toBeNull();
  });

  test('a member is refused', async () => {
    const t = harness();
    const m = await seedUser(t, 'm');
    await expect(m.as.query(api.seasonWatch.tape, {})).rejects.toThrow(/requires moderator/i);
    await expect(m.as.query(api.seasonWatch.homeSummary, {})).rejects.toThrow(
      /requires moderator/i,
    );
  });
});

// ── Machinery ───────────────────────────────────────────────────────────────────────────────────

describe('machinery.overviewJobs', () => {
  test('a moderator’s read is not recorded; Machinery is admin’s', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    expect(await mod.as.query(api.machinery.overviewJobs, {})).toBeNull();
  });

  test('trouble first, then a few ok; the untracked crons are never called ok', async () => {
    const t = harness();
    const admin = await seedUser(t, 'adm', 'admin');
    await t.run(async (ctx) => {
      await ctx.db.insert('imageryIngestSeasons', {
        season: 'winter-2026-27',
        opensOn: '2026-10-03',
        openedBy: ['sentinel'],
        winterFrom: null,
        imageryStartedAt: NOW - 10 * DAY,
        sitesSampled: 3,
        detectedAt: NOW - 40 * DAY,
      });
      await ctx.db.insert('imageryRuns', {
        season: 'winter-2026-27',
        kind: 'poll',
        startedAt: NOW - HOUR,
        finishedAt: NOW - HOUR,
        outcome: 'failed',
      });
      await ctx.db.insert('imageryRuns', {
        season: 'winter-2026-27',
        kind: 'pump',
        startedAt: NOW - 2 * HOUR,
        finishedAt: NOW - 2 * HOUR,
        outcome: 'ok',
      });
      await ctx.db.insert('imageryRuns', {
        season: 'winter-2026-27',
        kind: 'index',
        startedAt: NOW - 5 * MINUTE,
        outcome: 'refused',
      });
    });
    await snapshot(t, 'flag_queue_depth', TODAY, { scalar: 0, meta: {} });

    const card = await admin.as.query(api.machinery.overviewJobs, {});
    expect(card?.jobs.map((j) => [j.id, j.state])).toEqual([
      ['imagery-poll', 'failed'],
      // The pump beats every three minutes; two hours of silence while imagery runs is late.
      ['imagery-pump', 'late'],
      ['imagery-index', 'retried'],
      ['metrics-rollup', 'ok'],
      ['coverage-sweep', 'never'],
    ]);
    expect(card?.untracked).toBeGreaterThan(0);
    expect(card?.moreAllOk).toBe(false);
  });

  test('cardRows keeps every job that needs a look, and says all ok only when it knows', () => {
    const job = (id: string, state: JobRow['state']): JobRow => ({ id, name: id, state, at: NOW });
    const jobs = [
      job('a', 'failed'),
      job('b', 'ok'),
      job('c', 'ok'),
      job('d', 'ok'),
      job('e', 'ok'),
      job('f', 'ok'),
    ];
    expect(cardRows(jobs, 0)).toEqual({ jobs: jobs.slice(0, 5), more: 1, moreAllOk: true });
    expect(cardRows(jobs, 3).moreAllOk).toBe(false);
    const bad = Array.from({ length: 7 }, (_, i) => job(`x${i}`, 'late'));
    expect(cardRows(bad, 0).jobs).toHaveLength(7);
  });
});
