/**
 * The Overview's server reads (B01, the B01-2 server register): Metrics' three sections, the season's
 * reach, the day pulse, the season summaries, the Corpus and Machinery cards, colleague presence and
 * the machine's feed rows. What is pinned, across all of them:
 *
 *  - **`null` is not recorded, never zero** — a day no rollup wrote, a total the walk hasn't produced,
 *    a record that began partway through the week;
 *  - **the season window is one rule** — 1 October through today, a past season whole, empty from
 *    1 July to 30 September;
 *  - **open flags are one definition** (`lib/openFlags`), everywhere;
 *  - **kudos are positive reactions** — a thumbs-down is never counted;
 *  - **the capability map decides who reads what** — moderators read Metrics and the season summary,
 *    support's half and Machinery stay admin's.
 */
import { cronLiveness, DEFAULT_SEASON_WATCH_SETTINGS, metricDay } from '@skating/core';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { rollupBountiesDay, rollupDay, rollupPulseDay } from './analyticsRollup';
import { cronJob } from './cronJobs';
import { contributorsBetween } from './lib/contributions';
import { flagBodyId } from './lib/openFlags';
import { refreshPersonRow } from './lib/peopleRows';
import { cardRows, cronJobState, IMAGERY_CARD_JOBS, type JobRow, type JobState } from './machinery';
import { contributorSplit } from './metrics';
import schema from './schema';
import {
  BODY_CAP,
  emptyTally,
  FIRST_TIMER_PAGE,
  foldFirstTimer,
  mostReported,
  SET_ID_CAP,
  unpack,
} from './seasonReach';

const modules = import.meta.glob('./**/*.*s');

/**
 * The Inbox's stored items for rows seeded raw (B01-5): the Overview's Inbox card reads the items'
 * counts, so a test that seeds source rows directly files them the way the backfill does.
 */
async function fileStored(t: {
  mutation: (
    fn: typeof internal.inboxItems.backfill,
    args: { restart?: boolean },
  ) => Promise<{ done: boolean }>;
}) {
  for (let i = 0; i < 100; i++) {
    const pass = await t.mutation(internal.inboxItems.backfill, i === 0 ? { restart: true } : {});
    if (pass.done) return;
  }
  throw new Error('the Inbox backfill did not finish');
}

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
  // A spy (the scan-cap tests silence `console.warn`) never outlives a test that failed mid-way.
  vi.restoreAllMocks();
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
  moderatorDecision: false,
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
      moderationStatus: 'visible' as const,
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

describe('open flags, one definition, everywhere (the governor’s ruling)', () => {
  test('the Overview counts every open flag, in its lane and its age', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const s = await seedUser(t, 's');
    await seedFlag(t, s.id, 'report', 'r1', { createdAt: NOW - 3 * DAY });
    await seedFlag(t, s.id, 'report', 'r2');
    await seedFlag(t, s.id, 'report', 'r3', { status: 'dismissed' });
    await fileStored(t);
    const o = await mod.as.query(api.console.overview, {});
    expect(o.inbox.contentFlags).toEqual({ count: 2, capped: false });
    expect(o.inbox.oldestOpenAt).toBe(NOW - 3 * DAY);
  });

  test('the rollup’s queue depth and Metrics’ open flags agree with it', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const s = await seedUser(t, 's');
    await seedFlag(t, s.id, 'report', 'r1', { reason: 'unsafe_false_report' });
    await seedFlag(t, s.id, 'report', 'r2');
    await t.mutation(internal.analyticsRollup.rollupOperationalJob, {});
    expect((await readSnapshot(t, 'flag_queue_depth', TODAY))?.meta).toEqual({
      priority: 1,
      standard: 1,
    });
    const k = await mod.as.query(api.metrics.keepingUp, {});
    expect(k.keepingUp.openFlags).toEqual({ total: 2, safety: 1 });
  });

  test('a flag names the body it is about, through whatever it was filed on', async () => {
    const t = harness();
    const s = await seedUser(t, 's');
    const body = await seedBody(t, 'Mascoma Lake');
    const report = await seedReport(t, s.id, body, NOW - DAY);
    const ids = await t.run(async (ctx) => {
      const post = await ctx.db.insert('posts', {
        authorId: s.id,
        reportIds: [report],
        photoIds: [],
        latestSkateEndTime: NOW - DAY,
        moderationStatus: 'visible' as const,
        createdAt: NOW - DAY,
        updatedAt: NOW - DAY,
      });
      const comment = await ctx.db.insert('comments', {
        reportId: report,
        authorId: s.id,
        body: 'Thanks',
        source: 'native' as const,
        moderationStatus: 'visible' as const,
        createdAt: NOW,
      });
      const photo = await ctx.db.insert('photos', {
        moderationStatus: 'visible' as const,
        storageId: 's',
        thumbStorageId: 't',
        uploaderId: s.id,
        placeOnMap: false,
        createdAt: NOW,
        reportId: report,
      });
      const alert = await ctx.db.insert('accessAlerts', {
        targetType: 'put_in' as const,
        waterBodyId: body,
        reason: 'not_plowed' as const,
        kind: 'blocker' as const,
        createdByUserId: s.id,
        createdAt: NOW,
        season: 2026,
        status: 'active' as const,
        confirmCount: 0,
        denyCount: 0,
      });
      const loose = await ctx.db.insert('photos', {
        moderationStatus: 'visible' as const,
        storageId: 's',
        thumbStorageId: 't',
        uploaderId: s.id,
        placeOnMap: false,
        createdAt: NOW,
      });
      return { post, comment, photo, alert, loose };
    });
    const hazard = await seedHazard(t, s.id, body, NOW);
    const where = (targetType: Doc<'contentFlags'>['targetType'], targetId: string) =>
      t.run((ctx) => flagBodyId(ctx, { targetType, targetId }));

    expect(await where('waterbody', body)).toBe(body);
    expect(await where('report', report)).toBe(body);
    expect(await where('post', ids.post)).toBe(body);
    expect(await where('comment', ids.comment)).toBe(body);
    expect(await where('photo', ids.photo)).toBe(body);
    expect(await where('hazard', hazard)).toBe(body);
    expect(await where('accessAlert', ids.alert)).toBe(body);
    // A person is no place; a photo on no report, or an id from another table, names none.
    expect(await where('user', s.id)).toBeNull();
    expect(await where('photo', ids.loose)).toBeNull();
    expect(await where('report', body)).toBeNull();
    expect(await where('hazard', report)).toBeNull();
  });
});

// ── console.overview additions ──────────────────────────────────────────────────────────────────

describe('console.overview — the Inbox foot and the People total', () => {
  test('the median open item is sent as when it opened, for the client to age', async () => {
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
    await fileStored(t);
    const o = await mod.as.query(api.console.overview, {});
    // Ages 4 d, 2 d, 1 d, 2 h: the lower median is the 1-day-old flag.
    expect(o.inbox.medianOpenedAt).toBe(NOW - DAY);
  });

  test('the median age is not recorded once a lane read stopped short', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const s = await seedUser(t, 's');
    for (let i = 0; i < 201; i++) await seedFlag(t, s.id, 'report', `r${i}`);
    await fileStored(t);
    expect((await mod.as.query(api.console.overview, {})).inbox.medianOpenedAt).toBeNull();
  });

  test('nothing open: no age at all', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await fileStored(t);
    const o = await mod.as.query(api.console.overview, {});
    expect(o.inbox.oldestOpenAt).toBeNull();
    expect(o.inbox.medianOpenedAt).toBeNull();
  });

  test('total users is the Everyone lane: the live rows, as People counts them (one rule)', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await seedUser(t, 'a');
    await seedUser(t, 'gone', 'member', { status: 'deleted' });
    await t.run(async (ctx) => {
      for (const p of await ctx.db.query('profiles').collect()) await refreshPersonRow(ctx, p._id);
    });
    await fileStored(t);
    const o = await mod.as.query(api.console.overview, {});
    const lanes = await mod.as.query(api.people.lanes, {});
    // The tombstone is not a user; the 6-hourly rollup (Metrics' history) is not read here.
    expect(o.people.totalUsers).toEqual({ count: 2, capped: false });
    expect(lanes.lanes.find((l) => l.lane === 'everyone')?.count).toEqual(o.people.totalUsers);
  });
});

describe('console.corpusCounts — the Corpus card’s tasks', () => {
  test('duplicates count as decisions, re-fits across bodies, open place names, the last campaign', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const a = await seedBody(t, 'Mud Pond', { dedupStatus: 'near_certain', displayScore: 1 });
    const b = await seedBody(t, 'Mud Pond', { dedupStatus: 'near_certain', displayScore: 1 });
    await t.run(async (ctx) => {
      await ctx.db.patch(a, { duplicateCandidateIds: [b] });
      await ctx.db.patch(b, { duplicateCandidateIds: [a] });
    });
    await seedBody(t, 'Lone Pond', { dedupStatus: 'suspected_duplicate', displayScore: 1 });
    // An intake review reason alone is not a dedup flag: the queue doesn't hold it, so neither
    // does the count.
    await seedBody(t, 'Intake Pond', { reviewReason: 'duplicate-candidate', displayScore: 1 });
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

  test('more decisions than the card shows, the queue read whole, reads as a floor', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    // 210 unpaired flags: 210 decisions, inside the queue's read, past the card's figure.
    for (let i = 0; i < 210; i++) {
      await seedBody(t, `Pond ${i}`, { dedupStatus: 'suspected_duplicate' });
    }
    const queue = await mod.as.query(api.waterBodies.listDedupCandidates, {});
    expect(queue).toMatchObject({ total: 210, truncated: false });
    const c = await mod.as.query(api.console.corpusCounts, {});
    expect(c.duplicates).toEqual({ count: 200, capped: true });
  });

  test('a queue read that stops short is a floor, never a whole number', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    // Past the queue's 250-row read: whatever it counts, more are behind it.
    for (let i = 0; i < 251; i++) {
      await seedBody(t, `Pond ${i}`, { dedupStatus: 'near_certain' });
    }
    const queue = await mod.as.query(api.waterBodies.listDedupCandidates, {});
    expect(queue.truncated).toBe(true);
    const c = await mod.as.query(api.console.corpusCounts, {});
    expect(c.duplicates.capped).toBe(true);
  });

  test('the count is the queue’s total over every shape the queue folds', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const body = (name: string, dedupStatus: Doc<'waterBodies'>['dedupStatus']) =>
      seedBody(t, name, { dedupStatus });
    const link = (from: Id<'waterBodies'>, to: Id<'waterBodies'>[]) =>
      t.run((ctx) => ctx.db.patch(from, { duplicateCandidateIds: to }));
    // A mutual pair (one decision).
    const p1 = await body('Pair A', 'near_certain');
    const p2 = await body('Pair B', 'near_certain');
    await link(p1, [p2]);
    await link(p2, [p1]);
    // A one-way D36 stamp against a clean canonical body (one).
    const canon = await body('Canonical', 'clean');
    await link(await body('Drawn', 'suspected_duplicate'), [canon]);
    // A chain of three flagged rows (one).
    const c1 = await body('Chain 1', 'suspected_duplicate');
    const c2 = await body('Chain 2', 'suspected_duplicate');
    const c3 = await body('Chain 3', 'near_certain');
    await link(c1, [c2]);
    await link(c2, [c3]);
    // Two flags naming the same deleted body (two: a missing body links nothing).
    const gone = await body('Gone', 'clean');
    await link(await body('Orphan 1', 'suspected_duplicate'), [gone]);
    await link(await body('Orphan 2', 'suspected_duplicate'), [gone]);
    await t.run((ctx) => ctx.db.delete(gone));
    // A merged tombstone and a clean row with candidates: neither is in the queue.
    await link(await body('Merged', 'merged'), [p1]);
    await link(await body('Clean', 'clean'), [p2]);
    // Two drawn ponds matched against one clean lake: one decision, through a body the count must
    // look up (a candidate named twice is the only kind whose existence changes the number).
    const shared = await body('Shared Lake', 'clean');
    await link(await body('Drawn A', 'suspected_duplicate'), [shared]);
    await link(await body('Drawn B', 'suspected_duplicate'), [shared]);
    // Eight rows in one component: one decision, its card cut at six.
    const big: Id<'waterBodies'>[] = [];
    for (let i = 0; i < 8; i++) big.push(await body(`Big ${i}`, 'suspected_duplicate'));
    for (let i = 0; i < 7; i++)
      await link(big[i] as Id<'waterBodies'>, [big[i + 1] as Id<'waterBodies'>]);

    const queue = await mod.as.query(api.waterBodies.listDedupCandidates, {});
    const c = await mod.as.query(api.console.corpusCounts, {});
    expect(queue.total).toBe(7);
    expect(c.duplicates).toEqual({ count: queue.total, capped: queue.truncated });
    const cut = queue.groups.find((g) => g.members.some((m) => m.name.startsWith('Big')));
    expect(cut).toMatchObject({ hidden: 2 });
    expect(cut?.members).toHaveLength(6);
    const orphans = queue.groups.filter((g) => g.members.some((m) => m.name.startsWith('Orphan')));
    expect(orphans.map((g) => g.members.length)).toEqual([1, 1]);
  });

  test('the last campaign is a merge or a load, never the retirement that cleans up after one', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const run = (kind: 'canonical_water' | 'absorbed_retire', label: string, startedAt: number) =>
      t.run((ctx) =>
        ctx.db.insert('importRuns', {
          kind,
          label,
          deployment: 'dev',
          isProd: false,
          status: 'succeeded' as const,
          startedAt,
          counts: [],
          stages: [],
          failures: [],
          failuresTotal: 0,
        }),
      );
    await run('canonical_water', 'A07a unified corpus — the master list', NOW - 5 * DAY);
    // Since B01-7a: its own kind, which the read never asks for.
    await run('absorbed_retire', 'retire absorbed duplicates', NOW - 2 * DAY);
    // Before: a `canonical_water` row by its label, applied and dry, newer than the load.
    await run('canonical_water', 'retire absorbed duplicates', NOW - 4 * DAY);
    await run('canonical_water', 'retire absorbed duplicates (dry run)', NOW - 3 * DAY);

    const c = await mod.as.query(api.console.corpusCounts, {});
    expect(c.campaignAt).toBe(NOW - 5 * DAY);
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
      // The imagery crons' runs, as the backbone records them (`cronRuns`).
      for (const [i, outcome] of (['ok', 'refused', 'failed', 'capped'] as const).entries()) {
        await ctx.db.insert('cronRuns', {
          job: 'pump live satellite imagery',
          startedAt: NOW - 30 * MINUTE + i * MINUTE,
          finishedAt: NOW - 29 * MINUTE + i * MINUTE,
          outcome,
          trigger: 'cron' as const,
          season: 'winter-2026-27',
          keepUntil: NOW + 200 * DAY,
        });
      }
      await ctx.db.insert('cronRuns', {
        job: 'poll for new satellite imagery',
        startedAt: NOW - 20 * MINUTE,
        finishedAt: NOW - 20 * MINUTE,
        outcome: 'killed' as const,
        trigger: 'cron' as const,
        keepUntil: NOW + 200 * DAY,
      });
      // Another cron's failure is not imagery's, and not the feed's (Health draws every cron, later).
      await ctx.db.insert('cronRuns', {
        job: 'expire bounties',
        startedAt: NOW - 10 * MINUTE,
        finishedAt: NOW - 10 * MINUTE,
        outcome: 'failed' as const,
        trigger: 'cron' as const,
        keepUntil: NOW + 30 * DAY,
      });
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
    expect(rows.map((r) => [r.action, r.target.label])).toEqual([
      ['Run cut off', 'Imagery poll'],
      ['Run failed', 'Imagery pump'],
      ['Run refused', 'Imagery pump'],
      ['Run failed', 'VT canonical water'],
      ['Opened ice watch', 'Winter 2026–27'],
    ]);
    expect(rows.every((r) => r.actor === null)).toBe(true);
    expect(rows[1]?.target).toEqual(
      expect.objectContaining({ type: 'cronRun', label: 'Imagery pump' }),
    );
    expect(rows[3]?.target).toEqual(
      expect.objectContaining({ type: 'importRun', label: 'VT canonical water' }),
    );
  });

  test('a moderator sees only the watch; the limit is honored', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await seedRuns(t);
    expect((await mod.as.query(api.console.systemFeed, {})).map((r) => r.action)).toEqual([
      'Opened ice watch',
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
      'Closed ice watch',
      'Opened ice watch',
    ]);
  });
});

// ── The day pulse ───────────────────────────────────────────────────────────────────────────────

/** A bounty posted at `createdAt` in `status`; a fulfilled one stamped at `fulfilledAt`. */
async function seedBounty(
  t: T,
  requester: Id<'profiles'>,
  body: Id<'waterBodies'>,
  createdAt: number,
  status: 'open' | 'fulfilled' | 'canceled' | 'expired' = 'open',
  fulfilledAt?: number,
) {
  return await t.run((ctx) =>
    ctx.db.insert('bounties', {
      requesterId: requester,
      waterBodyId: body,
      windowHours: 24,
      status,
      rewardPoints: 5,
      fulfillingReportIds: [],
      ...(fulfilledAt !== undefined ? { fulfilledAt } : {}),
      createdAt,
      expiresAt: createdAt + 30 * DAY,
    }),
  );
}

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

    await t.mutation(internal.analyticsRollup.rollupPulseDayJob, { date: TODAY });
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
    // Ada reported and Cy filed a hazard; Bo only commented, and a comment is not a contribution.
    expect((await readSnapshot(t, 'daily_contributors', TODAY))?.scalar).toBe(2);
  });

  test('a bounty is posted on the day it was made and fulfilled on the day it was fulfilled', async () => {
    const t = harness();
    const ada = await seedUser(t, 'ada');
    const body = await seedBody(t, 'Mascoma Lake');
    const yesterday = '2026-11-12';
    // Posted yesterday, fulfilled today; posted yesterday, then canceled; posted today, expired.
    await seedBounty(t, ada.id, body, NOW - DAY, 'fulfilled', NOW - HOUR);
    await seedBounty(t, ada.id, body, NOW - DAY, 'canceled');
    await seedBounty(t, ada.id, body, NOW - HOUR, 'expired');
    // Fulfilled long ago, with no stamp (before fulfilledAt shipped): never counted as fulfilled.
    await seedBounty(t, ada.id, body, NOW - 40 * DAY, 'fulfilled');
    for (const date of [yesterday, TODAY]) {
      await t.mutation(internal.analyticsRollup.rollupBountiesDayJob, { date });
    }
    expect((await readSnapshot(t, 'bounties_posted', yesterday))?.scalar).toBe(2);
    expect((await readSnapshot(t, 'bounties_fulfilled', yesterday))?.scalar).toBe(0);
    expect((await readSnapshot(t, 'bounties_posted', TODAY))?.scalar).toBe(1);
    expect((await readSnapshot(t, 'bounties_fulfilled', TODAY))?.scalar).toBe(1);
  });

  test('sign-ins are written only from the day their record began', async () => {
    const t = harness();
    const ada = await seedUser(t, 'ada');
    await t.mutation(internal.analyticsRollup.rollupPulseDayJob, { date: TODAY });
    expect(await readSnapshot(t, 'signed_in', TODAY)).toBeNull();
    await t.run((ctx) =>
      ctx.db.insert('signInDays', { userId: ada.id, day: '2026-11-12', firstAt: NOW - DAY }),
    );
    await t.mutation(internal.analyticsRollup.rollupPulseDayJob, { date: '2026-11-11' });
    await t.mutation(internal.analyticsRollup.rollupPulseDayJob, { date: TODAY });
    expect(await readSnapshot(t, 'signed_in', '2026-11-11')).toBeNull();
    // After the record began, a day nobody came is a measured zero.
    expect((await readSnapshot(t, 'signed_in', TODAY))?.scalar).toBe(0);
  });

  describe('a count that hits its scan cap is not recorded, never a partial number', () => {
    const CAP = 2;
    const FIELDS = [
      'comments_created',
      'photos_added',
      'positive_reactions',
      'daily_contributors',
      'signed_in',
      'bounties_posted',
      'bounties_fulfilled',
    ] as const;
    type Field = (typeof FIELDS)[number];

    /** Exactly `CAP` rows of every counted kind on the day: two reports by two people (the only
     * contributions), two comments, two attached photos, two kudos, two sign-ins. */
    async function atCap(t: T) {
      const ada = await seedUser(t, 'ada');
      const bo = await seedUser(t, 'bo');
      const body = await seedBody(t, 'Mascoma Lake');
      const report = await seedReport(t, ada.id, body, NOW - HOUR);
      await seedReport(t, bo.id, body, NOW - HOUR);
      for (const who of [ada, bo]) {
        await seedComment(t, who.id, report, NOW - HOUR);
        await seedPhoto(t, who.id, NOW - HOUR, report);
        await seedRating(t, who.id, report, 'helpful', NOW - HOUR);
        await t.run((ctx) =>
          ctx.db.insert('signInDays', { userId: who.id, day: TODAY, firstAt: NOW - HOUR }),
        );
        // Posted today and fulfilled today: two of each.
        await seedBounty(t, who.id, body, NOW - 2 * HOUR, 'fulfilled', NOW - HOUR);
      }
      return { ada, bo, body, report };
    }

    /** One row past the cap, of one kind only. */
    async function onePast(t: T, field: Field, f: Awaited<ReturnType<typeof atCap>>) {
      const cy = await seedUser(t, 'cy');
      switch (field) {
        case 'comments_created':
          return void (await seedComment(t, cy.id, f.report, NOW - HOUR));
        case 'photos_added':
          return void (await seedPhoto(t, cy.id, NOW - HOUR, f.report));
        case 'positive_reactions':
          return void (await seedRating(t, cy.id, f.report, 'helpful', NOW - HOUR));
        case 'daily_contributors':
          return void (await seedReport(t, cy.id, f.body, NOW - HOUR));
        case 'signed_in':
          return void (await t.run((ctx) =>
            ctx.db.insert('signInDays', { userId: cy.id, day: TODAY, firstAt: NOW - HOUR }),
          ));
        case 'bounties_posted':
          return void (await seedBounty(t, cy.id, f.body, NOW - HOUR));
        case 'bounties_fulfilled':
          // Posted ten days ago: only the fulfilled read sees it today.
          return void (await seedBounty(t, cy.id, f.body, NOW - 10 * DAY, 'fulfilled', NOW - HOUR));
      }
    }

    test('a day with exactly the cap is whole', async () => {
      const t = harness();
      await atCap(t);
      await t.run(async (ctx) => {
        await rollupPulseDay(ctx, TODAY, CAP);
        await rollupBountiesDay(ctx, TODAY, CAP);
      });
      for (const field of FIELDS) {
        expect((await readSnapshot(t, field, TODAY))?.scalar, field).toBe(2);
      }
    });

    test.each(FIELDS)(
      '%s past the cap is saved with no number; the rest of the day saves',
      async (field) => {
        const t = harness();
        const fixture = await atCap(t);
        await onePast(t, field, fixture);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await t.run(async (ctx) => {
          await rollupPulseDay(ctx, TODAY, CAP);
          await rollupBountiesDay(ctx, TODAY, CAP);
        });
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/scan cap/));
        warn.mockRestore();

        const capped = await readSnapshot(t, field, TODAY);
        expect(capped).not.toBeNull();
        expect(capped?.scalar).toBeUndefined();
        expect(capped?.meta).toEqual({ capped: true });
        for (const other of FIELDS.filter((f) => f !== field)) {
          expect((await readSnapshot(t, other, TODAY))?.scalar, other).toBe(2);
        }

        // A later run under a cap the day fits replaces the gap with the real number.
        await t.mutation(internal.analyticsRollup.rollupPulseDayJob, { date: TODAY });
        await t.mutation(internal.analyticsRollup.rollupBountiesDayJob, { date: TODAY });
        const whole = await readSnapshot(t, field, TODAY);
        expect(whole?.scalar).toBe(3);
        expect(whole?.meta).not.toEqual({ capped: true });
      },
    );
  });

  // Reports, hazards and new accounts are pulse strips too, counted by the day rollup.
  describe('the day rollup’s pulse strips follow the same rule past their cap', () => {
    const CAP = 2;
    const FIELDS = ['reports_created', 'hazards_created', 'signups'] as const;
    type Field = (typeof FIELDS)[number];

    /** Exactly `CAP` visible reports, hazards and new accounts on the day. */
    async function atCap(t: T) {
      const ada = await seedUser(t, 'ada', 'member', { createdAt: NOW - HOUR });
      const bo = await seedUser(t, 'bo', 'member', { createdAt: NOW - HOUR });
      const body = await seedBody(t, 'Mascoma Lake');
      for (const who of [ada, bo]) {
        await seedReport(t, who.id, body, NOW - HOUR);
        await seedHazard(t, who.id, body, NOW - HOUR);
      }
      return { ada, body };
    }

    /** One row past the cap, of one kind only. */
    async function onePast(t: T, field: Field, f: Awaited<ReturnType<typeof atCap>>) {
      switch (field) {
        case 'reports_created':
          return void (await seedReport(t, f.ada.id, f.body, NOW - HOUR));
        case 'hazards_created':
          return void (await seedHazard(t, f.ada.id, f.body, NOW - HOUR));
        case 'signups':
          return void (await seedUser(t, 'cy', 'member', { createdAt: NOW - HOUR }));
      }
    }

    test('a day with exactly the cap is whole', async () => {
      const t = harness();
      await atCap(t);
      await t.run((ctx) => rollupDay(ctx, TODAY, CAP));
      for (const field of FIELDS) {
        expect((await readSnapshot(t, field, TODAY))?.scalar, field).toBe(2);
      }
    });

    test.each(FIELDS)(
      '%s past the cap is saved with no number; the rest of the day saves',
      async (field) => {
        const t = harness();
        const fixture = await atCap(t);
        await onePast(t, field, fixture);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await t.run((ctx) => rollupDay(ctx, TODAY, CAP));
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/scan cap/));

        const capped = await readSnapshot(t, field, TODAY);
        expect(capped?.scalar).toBeUndefined();
        expect(capped?.meta).toEqual({ capped: true });
        for (const other of FIELDS.filter((f) => f !== field)) {
          expect((await readSnapshot(t, other, TODAY))?.scalar, other).toBe(2);
        }

        await t.mutation(internal.analyticsRollup.rollupDayJob, { date: TODAY });
        expect((await readSnapshot(t, field, TODAY))?.scalar).toBe(3);
      },
    );

    test('a capped day of new accounts leaves the strip with no total, never a short one', async () => {
      const t = harness();
      const mod = await seedUser(t, 'mod', 'moderator');
      const fixture = await atCap(t);
      await onePast(t, 'signups', fixture);
      for (let i = 43; i >= 1; i--) {
        await t.mutation(internal.analyticsRollup.rollupDayJob, { date: metricDay(NOW - i * DAY) });
      }
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await t.run((ctx) => rollupDay(ctx, TODAY, CAP));
      const accounts = async () =>
        (await mod.as.query(api.metrics.showingUp, {})).showingUp.pulse.accounts;
      expect(await accounts()).toBeNull();
      // The same season with today whole adds up: the capped day is what withheld the total.
      await t.mutation(internal.analyticsRollup.rollupDayJob, { date: TODAY });
      expect((await accounts())?.total).toBe(3);
    });
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

  test('the rollup schedules the pulse for yesterday and today, and the season walk', async () => {
    const t = harness();
    await t.mutation(internal.analyticsRollup.runRollup, {});
    const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(jobs.filter((j) => j.name.includes('rollupPulseDayJob'))).toHaveLength(2);
    expect(jobs.some((j) => j.name.includes('seasonReach'))).toBe(true);
  });

  test('the backfill replays the pulse a day at a time, each its own transaction', async () => {
    const t = harness();
    await t.mutation(internal.analyticsRollup.backfillStep, { offset: 2 });
    const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(jobs.filter((j) => j.name.includes('rollupPulseDayJob')).map((j) => j.args[0])).toEqual([
      { date: '2026-11-11' },
    ]);
  });
});

// ── What a contribution is (D253) ───────────────────────────────────────────────────────────────

describe('contributions — one rule for every contributors figure', () => {
  /** One of each kind that counts, by `who`, made at `at`. */
  async function contributeEverything(
    t: T,
    who: Record<'alert' | 'access' | 'putIn' | 'request', Id<'profiles'>>,
    body: Id<'waterBodies'>,
    at: number,
  ) {
    await t.run(async (ctx) => {
      await ctx.db.insert('accessAlerts', {
        targetType: 'put_in',
        waterBodyId: body,
        reason: 'road_closed',
        kind: 'blocker',
        createdByUserId: who.alert,
        createdAt: at,
        season: 2026,
        status: 'active',
        confirmCount: 0,
        denyCount: 0,
      } as never);
      await ctx.db.insert('contentFlags', {
        flaggerId: who.access,
        targetType: 'waterbody' as const,
        targetId: body,
        reason: 'no_public_access' as const,
        status: 'open' as const,
        createdAt: at,
      });
      await ctx.db.insert('putIns', {
        waterBodyId: body,
        coord: { lat: 0.5, lng: 0.5 },
        source: 'official' as const,
        status: 'visible' as const,
        createdByUserId: who.putIn,
        createdAt: at,
      } as never);
      await ctx.db.insert('waterBodyRequests', {
        kind: 'activate' as const,
        status: 'open' as const,
        requesterId: who.request,
        coord: { lat: 43.6, lng: -72.1 },
        createdAt: at,
      });
    });
  }

  test('an alert, a not-accessible report, a placed put-in and a corpus request each count', async () => {
    const t = harness();
    const body = await seedBody(t, 'Mascoma Lake');
    const who = {
      alert: (await seedUser(t, 'al')).id,
      access: (await seedUser(t, 'ac')).id,
      putIn: (await seedUser(t, 'pu')).id,
      request: (await seedUser(t, 're')).id,
    };
    await contributeEverything(t, who, body, NOW - HOUR);
    await t.mutation(internal.analyticsRollup.rollupPulseDayJob, { date: TODAY });
    expect((await readSnapshot(t, 'daily_contributors', TODAY))?.scalar).toBe(4);
    await t.mutation(internal.analyticsRollup.rollupActivityJob, {});
    expect((await readSnapshot(t, 'active_contributors', TODAY))?.scalar).toBe(4);
  });

  test('nothing withdrawn, retracted, removed, declined or dismissed counts', async () => {
    const t = harness();
    const body = await seedBody(t, 'Mascoma Lake');
    const a = await seedUser(t, 'a');
    await seedReport(t, a.id, body, NOW - HOUR, { authorDeletedAt: NOW });
    await seedReport(t, a.id, body, NOW - HOUR, { moderationStatus: 'removed' });
    await t.run(async (ctx) => {
      await ctx.db.insert('accessAlerts', {
        targetType: 'put_in',
        waterBodyId: body,
        reason: 'road_closed',
        kind: 'blocker',
        createdByUserId: a.id,
        createdAt: NOW - HOUR,
        season: 2026,
        status: 'retracted',
        confirmCount: 0,
        denyCount: 0,
      } as never);
      await ctx.db.insert('contentFlags', {
        flaggerId: a.id,
        targetType: 'waterbody' as const,
        targetId: body,
        reason: 'no_public_access' as const,
        status: 'dismissed' as const,
        createdAt: NOW - HOUR,
      });
      await ctx.db.insert('waterBodyRequests', {
        kind: 'admit' as const,
        status: 'declined' as const,
        requesterId: a.id,
        coord: { lat: 43.6, lng: -72.1 },
        createdAt: NOW - HOUR,
      });
      // Not contributions at all: a takedown request, a spam flag, a derived put-in.
      await ctx.db.insert('waterBodyRequests', {
        kind: 'takedown' as const,
        status: 'open' as const,
        requesterId: a.id,
        coord: { lat: 43.6, lng: -72.1 },
        createdAt: NOW - HOUR,
      });
      await ctx.db.insert('putIns', {
        waterBodyId: body,
        coord: { lat: 0.5, lng: 0.5 },
        source: 'derived' as const,
        status: 'visible' as const,
        createdByUserId: a.id,
        createdAt: NOW - HOUR,
      } as never);
    });
    await seedFlag(t, a.id, 'report', 'r1', { createdAt: NOW - HOUR });
    await t.mutation(internal.analyticsRollup.rollupPulseDayJob, { date: TODAY });
    expect((await readSnapshot(t, 'daily_contributors', TODAY))?.scalar).toBe(0);
    const mod = await seedUser(t, 'mod', 'moderator');
    expect((await mod.as.query(api.metrics.showingUp, {})).showingUp.week.contributors).toEqual({
      people: 0,
      firstTime: 0,
    });
  });

  test('a first contribution is the first that stands: a withdrawn report before it is not one', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const body = await seedBody(t, 'Mascoma Lake');
    const a = await seedUser(t, 'a');
    await seedReport(t, a.id, body, NOW - 60 * DAY, { authorDeletedAt: NOW - 59 * DAY });
    await seedReport(t, a.id, body, NOW - DAY);
    expect((await mod.as.query(api.metrics.showingUp, {})).showingUp.week.contributors).toEqual({
      people: 1,
      firstTime: 1,
    });
  });

  test('withdrawn rows after a first contribution don’t make first-time unknown', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const body = await seedBody(t, 'Mascoma Lake');
    const a = await seedUser(t, 'a');
    // Her first contribution is a report two months back; then ten dismissed "not accessible"
    // claims — a full probe of non-contributions, all after a first already known.
    await seedReport(t, a.id, body, NOW - 60 * DAY);
    await t.run(async (ctx) => {
      for (let i = 0; i < 10; i++) {
        await ctx.db.insert('contentFlags', {
          flaggerId: a.id,
          targetType: 'waterbody' as const,
          targetId: body,
          reason: 'no_public_access' as const,
          status: 'dismissed' as const,
          createdAt: NOW - (50 - i) * DAY,
        });
      }
    });
    await seedReport(t, a.id, body, NOW - DAY);
    expect((await mod.as.query(api.metrics.showingUp, {})).showingUp.week.contributors).toEqual({
      people: 1,
      firstTime: 0,
    });
  });

  test('an alert is read in the order it was observed, not the order it reached the server', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const body = await seedBody(t, 'Mascoma Lake');
    const a = await seedUser(t, 'a');
    const alert = (createdAt: number, status: string) => ({
      targetType: 'put_in',
      waterBodyId: body,
      reason: 'road_closed',
      kind: 'blocker',
      createdByUserId: a.id,
      createdAt,
      season: 2026,
      status,
      confirmCount: 0,
      denyCount: 0,
    });
    await t.run(async (ctx) => {
      // Ten retracted alerts, then — flushed from a phone later — one observed before all of them.
      for (let i = 0; i < 10; i++) {
        await ctx.db.insert('accessAlerts', alert(NOW - (60 - i) * DAY, 'retracted') as never);
      }
      await ctx.db.insert('accessAlerts', alert(NOW - 70 * DAY, 'active') as never);
    });
    await seedReport(t, a.id, body, NOW - DAY);
    // Her first contribution is the alert seventy days back: known, and not this week.
    expect((await mod.as.query(api.metrics.showingUp, {})).showingUp.week.contributors).toEqual({
      people: 1,
      firstTime: 0,
    });
  });

  test('a moderator’s hidden markers never crowd out the put-ins they placed', async () => {
    const t = harness();
    const viewer = await seedUser(t, 'viewer', 'moderator');
    const mod = await seedUser(t, 'mod', 'moderator');
    const body = await seedBody(t, 'Mascoma Lake');
    await t.run(async (ctx) => {
      // A cleanup: twelve derived markers hidden — each hide is attributed to the moderator.
      for (let i = 0; i < 12; i++) {
        await ctx.db.insert('putIns', {
          waterBodyId: body,
          coord: { lat: 0.5, lng: 0.5 },
          source: 'derived' as const,
          status: 'hidden' as const,
          createdByUserId: mod.id,
          createdAt: NOW - (40 - i) * DAY,
        } as never);
      }
    });
    // Their first contribution: a report this week.
    await seedReport(t, mod.id, body, NOW - DAY);
    expect((await viewer.as.query(api.metrics.showingUp, {})).showingUp.week.contributors).toEqual({
      people: 1,
      firstTime: 1,
    });
  });

  test('the cap bounds the rows read across every kind together', async () => {
    const t = harness();
    const body = await seedBody(t, 'Mascoma Lake');
    const a = await seedUser(t, 'a');
    const b = await seedUser(t, 'b');
    await seedReport(t, a.id, body, NOW - HOUR);
    await seedReport(t, a.id, body, NOW - HOUR);
    await seedHazard(t, b.id, body, NOW - HOUR);
    const read = (cap: number) =>
      t.run(async (ctx) => {
        const { people, capped } = await contributorsBetween(ctx, NOW - DAY, NOW, cap);
        return { people: people.size, capped };
      });
    // Two reports fill a cap of two: the hazard is past it, and the read says it stopped short.
    expect(await read(2)).toEqual({ people: 1, capped: true });
    expect(await read(3)).toEqual({ people: 2, capped: false });
  });

  test('an unsettled first contribution blanks only first-timers, never the count', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const body = await seedBody(t, 'Mascoma Lake');
    const a = await seedUser(t, 'a');
    for (let i = 0; i < 10; i++) {
      await seedReport(t, a.id, body, NOW - (90 - i) * DAY, { authorDeletedAt: NOW });
    }
    await seedReport(t, a.id, body, NOW - DAY);
    // Her first ten reports were withdrawn, so whether this week's is her first can't be told; that
    // she contributed this week can.
    expect((await mod.as.query(api.metrics.showingUp, {})).showingUp.week.contributors).toEqual({
      people: 1,
      firstTime: null,
    });
  });

  test('past the first-time cap, the count stands and only first-timers are not recorded', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const body = await seedBody(t, 'Mascoma Lake');
    // 301 people, one report each this week: one more than first-time looks up.
    await t.run(async (ctx) => {
      for (let i = 0; i < 301; i++) {
        const authorId = await ctx.db.insert('profiles', {
          clerkUserId: `p${i}`,
          displayName: `P${i} Person`,
          username: `p${i}`,
          driveTimePrefMinutes: 60,
          profileVisibility: 'public' as const,
          notificationPrefs: NOTIF_PREFS,
          dateOfBirth: Date.UTC(1990, 0, 1),
          reputationPoints: 0,
          role: 'member' as const,
          status: 'active' as const,
          createdAt: NOW - 400 * DAY,
        });
        await ctx.db.insert('reports', {
          authorId,
          waterBodyId: body,
          point: { lat: 0.5, lng: 0.5 },
          skateEndTime: NOW - DAY,
          reportTime: NOW - DAY,
          source: 'native' as const,
          iceTypes: [],
          surfaceTags: [],
          photoIds: [],
          moderationStatus: 'visible' as const,
          hazardIdsCreated: [],
          createdAt: NOW - DAY,
          updatedAt: NOW - DAY,
        });
      }
    });
    expect((await mod.as.query(api.metrics.showingUp, {})).showingUp.week.contributors).toEqual({
      people: 301,
      firstTime: null,
    });
  });

  test('the season walk counts every kind once per person, and only reports by state', async () => {
    const t = harness();
    const body = await seedBody(t, 'Mascoma Lake');
    const who = {
      alert: (await seedUser(t, 'al')).id,
      access: (await seedUser(t, 'ac')).id,
      putIn: (await seedUser(t, 'pu')).id,
      request: (await seedUser(t, 're')).id,
    };
    await contributeEverything(t, who, body, NOW - 3 * DAY);
    await walkReach(t);
    const reach = (await readSnapshot(t, 'season_reach', TODAY))?.meta as {
      people: { contributors: number };
      states: Record<string, unknown>;
    };
    expect(reach.people.contributors).toBe(4);
    expect(reach.states).toEqual({});
  });
});

// ── First-timers (B01-2b) ───────────────────────────────────────────────────────────────────────

describe('the season’s first-timers, from the walk', () => {
  test('a contributor is new on the day of their first-ever contribution; an earlier one returns', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const body = await seedBody(t, 'Mascoma Lake');
    const ada = await seedUser(t, 'ada');
    const bo = await seedUser(t, 'bo');
    // Ada first contributed last winter: returning. Bo's first ever is three days ago: new then.
    await seedReport(t, ada.id, body, Date.UTC(2026, 1, 2));
    await seedReport(t, ada.id, body, NOW - 3 * DAY);
    await seedReport(t, bo.id, body, NOW - 3 * DAY);
    await seedReport(t, bo.id, body, NOW - DAY);
    // More contributors than one page looks up, so the stage runs across pages.
    for (let i = 0; i < FIRST_TIMER_PAGE; i++) {
      const p = await seedUser(t, `p${i}`);
      await seedReport(t, p.id, body, Date.UTC(2026, 9, 2));
    }
    await walkReach(t);
    const meta = (await readSnapshot(t, 'season_reach', TODAY))?.meta as {
      firstTimers: { byDay: Record<string, number>; newPeople: number };
    };
    expect(meta.firstTimers).toEqual({
      byDay: { '2026-10-02': FIRST_TIMER_PAGE, [metricDay(NOW - 3 * DAY)]: 1 },
      newPeople: FIRST_TIMER_PAGE + 1,
    });
    const split = (await mod.as.query(api.metrics.showingUp, {})).showingUp.pulse.contributors
      ?.split;
    expect(split?.newPeople).toBe(FIRST_TIMER_PAGE + 1);
    expect(split?.daily.at(-4)).toBe(1);
    // A day with contributors and no first-timer is a measured zero; it isn't left out.
    expect(split?.daily.at(-2)).toBe(0);
  });

  test('a capped contributors set can’t say who is new: not recorded, never a zero', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await snapshot(t, 'season_reach', TODAY, {
      meta: {
        season: 2026,
        through: TODAY,
        counts: { reports: 1, comments: 0, kudos: 0, photos: 0, hazards: 0 },
        over: { reports: 1, comments: 0, kudos: 0, photos: 0, hazards: 0 },
        people: { signedIn: 1, contributors: 1 },
        vantage: {},
        states: {},
        firstTimers: null,
        capped: ['firstTimers'],
      },
    });
    const split = (await mod.as.query(api.metrics.showingUp, {})).showingUp.pulse.contributors
      ?.split;
    expect(split?.newPeople).toBeNull();
    expect(split?.daily.every((d) => d === null)).toBe(true);
  });

  test('days after the walk’s last are not recorded; a walk from before first-timers says none', () => {
    const days = ['2026-10-01', '2026-10-02', '2026-10-03'];
    expect(
      contributorSplit({ through: '2026-10-02', firstTimers: { byDay: {}, newPeople: 0 } }, days),
    ).toEqual({ daily: [0, 0, null], newPeople: 0 });
    expect(contributorSplit({ through: '2026-10-02' }, days)).toEqual({
      daily: [null, null, null],
      newPeople: null,
    });
  });

  // A first contribution lands on its UTC metric day — the day the strips count by — whatever the
  // instant's local date in any zone, across both DST changes; inside the window it counts once.
  const property = fc.property(
    fc.array(fc.integer({ min: Date.UTC(2026, 8, 1), max: Date.UTC(2027, 3, 1) }), {
      maxLength: 50,
    }),
    (firsts) => {
      const window = { firstDay: '2026-10-01', lastDay: '2027-03-15' };
      const byDay: Record<string, number> = {};
      let fresh = 0;
      for (const at of firsts) if (foldFirstTimer(byDay, at, window)) fresh++;
      const inside = firsts.filter((at) => {
        const day = new Date(at).toISOString().slice(0, 10);
        return day >= window.firstDay && day <= window.lastDay;
      });
      expect(fresh).toBe(inside.length);
      expect(Object.values(byDay).reduce((a, n) => a + n, 0)).toBe(inside.length);
      for (const at of inside)
        expect(byDay[new Date(at).toISOString().slice(0, 10)]).toBeGreaterThan(0);
    },
  );
  test('each first lands on its own metric day, once (pinned seeds and one random)', () => {
    for (const seed of [20261117, 3, 1108]) fc.assert(property, { seed, numRuns: 200 });
    fc.assert(property, { numRuns: 200 });
  });
});

// ── The sign-in record's retention (D254) ───────────────────────────────────────────────────────

describe('pruneSignInDays — the current season and one past', () => {
  test('erases every day before the previous season’s 1 July, and keeps that day on', async () => {
    const t = harness();
    const a = await seedUser(t, 'a');
    await t.run(async (ctx) => {
      for (const day of ['2024-06-30', '2025-06-30', '2025-07-01', '2026-11-13']) {
        await ctx.db.insert('signInDays', { userId: a.id, day, firstAt: NOW });
      }
    });
    expect(await t.mutation(internal.analyticsRollup.pruneSignInDays, {})).toEqual({
      deleted: 2,
      presenceDeleted: 0,
      keepFrom: '2025-07-01',
    });
    const left = await t.run((ctx) => ctx.db.query('signInDays').collect());
    expect(left.map((r) => r.day).sort()).toEqual(['2025-07-01', '2026-11-13']);
  });

  test('console presence follows the same rule: last seen before the previous season’s 1 July goes', async () => {
    const t = harness();
    const a = await seedUser(t, 'a', 'moderator');
    const b = await seedUser(t, 'b', 'moderator');
    const boundary = Date.UTC(2025, 6, 1);
    await t.run(async (ctx) => {
      await ctx.db.insert('consolePresence', { userId: a.id, seenAt: boundary - 1 });
      await ctx.db.insert('consolePresence', { userId: b.id, seenAt: boundary });
    });
    expect(await t.mutation(internal.analyticsRollup.pruneSignInDays, {})).toMatchObject({
      presenceDeleted: 1,
    });
    const left = await t.run((ctx) => ctx.db.query('consolePresence').collect());
    expect(left.map((r) => r.userId)).toEqual([b.id]);
  });

  test('rides the daily client-signal prune', async () => {
    const t = harness();
    await t.mutation(internal.analyticsRollup.pruneClientSignals, {});
    const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(jobs.some((j) => j.name.includes('pruneSignInDays'))).toBe(true);
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
    // By state, contributors are the reports' authors: Ada and Bo reported from NH; Cy only
    // commented there.
    expect((reach.states as Record<string, unknown>).NH).toEqual({
      reports: 2,
      comments: 2,
      photos: 2,
      kudos: 2,
      contributors: 2,
    });
    const ranked = (await readSnapshot(t, 'most_reported', TODAY))?.meta as {
      rows: Array<{ bodyId: string; reports: number; photos: number; people: number }>;
    };
    expect(ranked.rows.map((r) => [r.bodyId, r.reports, r.photos, r.people])).toEqual([
      [mascoma, 2, 2, 2],
      [morey, 1, 0, 1],
    ]);
  });

  test('the tally stops at its caps and names what it could not count', () => {
    const w = unpack(emptyTally(), { ids: 2, bodies: 1 });
    w.addTo(w.sets.signedIn, 'a', 'signedIn');
    w.addTo(w.sets.signedIn, 'a', 'signedIn');
    w.contributor('b');
    w.contributor('c');
    expect(w.body('x')).toBeDefined();
    expect(w.body('y')).toBeUndefined();
    expect(w.body('x')).toBeDefined();
    const t = w.pack();
    expect(t.sets.signedIn).toEqual(['a']);
    expect(t.sets.contributors).toEqual(['b']);
    expect(t.capped.sort()).toEqual(['contributors', 'mostReported']);
    // A packed tally picks up where it left off: still full.
    const again = unpack(t, { ids: 2, bodies: 1 });
    again.addTo(again.sets.posts, 'p', 'posts');
    expect(again.pack().capped).toContain('posts');
  });

  test('no one set outgrows what Convex stores as one array, nor the bodies one object', () => {
    // The whole tally has room; the set does not.
    const w = unpack(emptyTally(), { ids: 100, bodies: 5, perSet: 2 });
    for (const id of ['a', 'b', 'c']) w.addTo(w.sets.signedIn, id, 'signedIn');
    w.contributor('d');
    const t = w.pack();
    expect(t.sets.signedIn).toEqual(['a', 'b']);
    expect(t.sets.contributors).toEqual(['d']);
    expect(t.capped).toEqual(['signedIn']);
    // The module's own caps stay inside Convex's value limits.
    expect(SET_ID_CAP).toBeLessThanOrEqual(8_192);
    expect(BODY_CAP).toBeLessThanOrEqual(1_024);
  });

  test('ranks by reports, then the latest report', () => {
    expect(
      mostReported({
        a: { reports: 1, photos: 0, people: ['x'], last: 5 },
        b: { reports: 2, photos: 1, people: ['x', 'y'], last: 1 },
        c: { reports: 1, photos: 0, people: [], last: 9 },
      }).map((r) => r.bodyId),
    ).toEqual(['b', 'c', 'a']);
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

  test('a season older than the sign-in record: never counted from a remnant, never erased', async () => {
    const t = convexTest(schema, modules);
    const a = await seedUser(t, 'a');
    await t.run(async (ctx) => {
      await ctx.db.insert('signInDays', { userId: a.id, day: '2025-01-10', firstAt: NOW });
      await ctx.db.insert('signInDays', { userId: a.id, day: '2026-01-10', firstAt: NOW });
    });
    const reach = async (date: string) =>
      (await readSnapshot(t, 'season_reach', date))?.meta as {
        people: { signedIn: number };
        capped: string[];
      };
    // 2024–25 is past what D254 keeps, and no walk ever recorded it: not recorded.
    await walkReach(t, 2024);
    expect((await reach('2025-06-30')).capped).toContain('signedIn');
    // Last season is kept whole, and counted.
    await walkReach(t, 2025);
    expect((await reach('2026-06-30')).capped).not.toContain('signedIn');
    expect((await reach('2026-06-30')).people.signedIn).toBe(1);
  });

  test('a season the sign-in record never reached is not recorded, never zero people', async () => {
    const t = convexTest(schema, modules);
    const a = await seedUser(t, 'a');
    // The record began this November: last season, kept by retention, holds no row of it.
    await t.run((ctx) =>
      ctx.db.insert('signInDays', { userId: a.id, day: '2026-11-03', firstAt: NOW }),
    );
    await walkReach(t, 2025);
    const reach = (await readSnapshot(t, 'season_reach', '2026-06-30'))?.meta as {
      capped: string[];
    };
    expect(reach.capped).toContain('signedIn');
    // With no row at all, this season is not recorded either.
    const empty = convexTest(schema, modules);
    await walkReach(empty, 2025);
    const none = (await readSnapshot(empty, 'season_reach', '2026-06-30'))?.meta as {
      capped: string[];
    };
    expect(none.capped).toContain('signedIn');
  });

  test('a re-walk keeps the signed-in figure an earlier walk recorded once the rows are gone', async () => {
    const t = convexTest(schema, modules);
    // An earlier walk, run while 2024–25's rows were whole, counted 41 people.
    await snapshot(t, 'season_reach', '2025-06-30', {
      meta: {
        season: 2024,
        through: '2025-06-30',
        counts: { reports: 0, comments: 0, kudos: 0, photos: 0, hazards: 0 },
        over: { reports: 0, comments: 0, kudos: 0, photos: 0, hazards: 0 },
        people: { signedIn: 41, contributors: 0 },
        vantage: {},
        states: {},
        kinds: ['helpful'],
        capped: [],
      },
    });
    const ada = await seedUser(t, 'ada');
    const body = await seedBody(t, 'Kezar Lake');
    await seedReport(t, ada.id, body, Date.UTC(2025, 0, 12));
    await walkReach(t, 2024);
    const meta = (await readSnapshot(t, 'season_reach', '2025-06-30'))?.meta as {
      people: { signedIn: number; contributors: number };
      counts: { reports: number };
      capped: string[];
    };
    // Signed in is kept, never erased for want of rows; what the walk could read in full it corrects.
    expect(meta.people.signedIn).toBe(41);
    expect(meta.capped).not.toContain('signedIn');
    expect(meta.counts.reports).toBe(1);
    expect(meta.people.contributors).toBe(1);
  });

  test('a re-walk keeps the figure the reads showed, even one stamped before the season’s end', async () => {
    const t = convexTest(schema, modules);
    // The last walk while 2024–25's rows were whole ran on 29 June; the reads show its 41.
    await snapshot(t, 'season_reach', '2025-06-29', {
      meta: {
        season: 2024,
        through: '2025-06-29',
        counts: { reports: 0, comments: 0, kudos: 0, photos: 0, hazards: 0 },
        over: { reports: 0, comments: 0, kudos: 0, photos: 0, hazards: 0 },
        people: { signedIn: 41, contributors: 0 },
        vantage: {},
        states: {},
        kinds: ['helpful'],
        capped: [],
      },
    });
    await walkReach(t, 2024);
    // The re-walk's row, on the window's last day, is now the one the reads take: it keeps the 41.
    const meta = (await readSnapshot(t, 'season_reach', '2025-06-30'))?.meta as {
      people: { signedIn: number };
      capped: string[];
    };
    expect(meta.people.signedIn).toBe(41);
    expect(meta.capped).not.toContain('signedIn');
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
    vi.setSystemTime(Date.UTC(2026, 7, 1));
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const pre = await mod.as.query(api.metrics.keepingUp, {});
    expect(pre.season).toBe(2026);
    expect(pre.days).toEqual([]);
    expect(pre.keepingUp.resolveSeason).toBeNull();
    // A season nobody can name reads the season now falls in.
    expect((await mod.as.query(api.metrics.keepingUp, { season: 1.5 })).season).toBe(2026);
    vi.setSystemTime(NOW);
    const past = await mod.as.query(api.metrics.keepingUp, { season: 2025 });
    expect(past.days).toHaveLength(273);
    expect(past.days.at(-1)).toBe('2026-06-30');
  });

  test('reads the window of the page’s day — within a few minutes of the server’s clock', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    // Two minutes before midnight, a page whose clock has turned asks for its new day.
    vi.setSystemTime(Date.UTC(2026, 10, 13, 23, 58));
    const next = await mod.as.query(api.metrics.keepingUp, { now: Date.UTC(2026, 10, 14) });
    expect(next.days.at(-1)).toBe('2026-11-14');
    // The page sends its day's start, hours behind the server by noon: still that day.
    vi.setSystemTime(Date.UTC(2026, 10, 13, 12));
    const noon = await mod.as.query(api.metrics.keepingUp, { now: Date.UTC(2026, 10, 13) });
    expect(noon.days.at(-1)).toBe('2026-11-13');
    // A clock days ahead is pulled back to the server's.
    const far = await mod.as.query(api.metrics.showingUp, { now: Date.UTC(2026, 11, 25) });
    expect(far.days.at(-1)).toBe('2026-11-13');
    expect((await mod.as.query(api.metrics.coverage, { now: Number.NaN })).days.at(-1)).toBe(
      '2026-11-13',
    );
  });

  test('a member is refused', async () => {
    const t = harness();
    const m = await seedUser(t, 'm');
    await expect(m.as.query(api.metrics.keepingUp, {})).rejects.toThrow(/requires moderator/i);
  });
});

// ── Metrics: Showing up ─────────────────────────────────────────────────────────────────────────

describe('metrics.showingUp', () => {
  test('bounties each day: a season total only once every day is recorded, never a short one', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const ada = await seedUser(t, 'ada');
    const body = await seedBody(t, 'Mascoma Lake');
    await seedBounty(t, ada.id, body, NOW - 3 * DAY, 'fulfilled', NOW - HOUR);
    await seedBounty(t, ada.id, body, NOW - 3 * DAY, 'expired');
    const bounties = async () => (await mod.as.query(api.metrics.showingUp, {})).showingUp.bounties;
    // Nothing rolled up: every day not recorded, no totals.
    let b = await bounties();
    expect(b?.totals).toEqual({ posted: null, fulfilled: null });
    expect(b?.posted.every((n) => n === null)).toBe(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 43; i >= 1; i--) {
      await t.run((ctx) => rollupBountiesDay(ctx, metricDay(NOW - i * DAY)));
    }
    // Today not yet: still no totals.
    expect((await bounties())?.totals).toEqual({ posted: null, fulfilled: null });
    await t.run((ctx) => rollupBountiesDay(ctx, TODAY));
    b = await bounties();
    expect(b?.totals).toEqual({ posted: 2, fulfilled: 1 });
    // A posted day the cap withheld withholds the posted total only; the fulfilled total stands.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('metricSnapshots')
        .withIndex('by_metric_date', (q) => q.eq('metric', 'bounties_posted').eq('date', TODAY))
        .unique();
      if (row !== null)
        await ctx.db.replace(row._id, { ...row, scalar: undefined, meta: { capped: true } });
    });
    b = await bounties();
    expect(b?.totals).toEqual({ posted: null, fulfilled: 1 });
    expect(b?.fulfilled.at(-1)).toBe(1);
    expect(b?.posted.at(-1)).toBeNull();
    expect(b?.posted.at(-4)).toBe(2);
  });

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
    // Ada, Bo, Cy and Dee. Bo's first contribution (a hazard three days ago), Cy's (her report on
    // the 8th — her comment on the 4th was chatter, not a contribution) and Dee's are this week;
    // Ada's reports go back to September.
    expect(w.contributors).toEqual({ people: 4, firstTime: 3 });
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

  test('a day saved as not recorded leaves the season’s totals whole', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await seedSeason(t);
    await t.mutation(internal.analyticsRollup.rollupDayJob, { date: TODAY });
    await walkReach(t);
    // After the walk, today gets one row of every pulse kind: a report (a contribution), a comment,
    // an attached photo, a kudo and a sign-in. Each of today's reads, capped at zero, stops short.
    const pond = await seedBody(t, 'Today Pond');
    const report = await seedReport(t, mod.id, pond, NOW - HOUR);
    await seedComment(t, mod.id, report, NOW - HOUR);
    await seedPhoto(t, mod.id, NOW - HOUR, report);
    await seedRating(t, mod.id, report, 'helpful', NOW - HOUR);
    await t.run((ctx) =>
      ctx.db.insert('signInDays', { userId: mod.id, day: TODAY, firstAt: NOW - HOUR }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await t.run((ctx) => rollupPulseDay(ctx, TODAY, 0));
    vi.mocked(console.warn).mockRestore();

    const { pulse } = (await mod.as.query(api.metrics.showingUp, {})).showingUp;
    const METRIC = {
      comments: 'comments_created',
      kudos: 'positive_reactions',
      photos: 'photos_added',
      signedIn: 'signed_in',
      contributors: 'daily_contributors',
    } as const;
    for (const [key, metric] of Object.entries(METRIC) as [keyof typeof METRIC, string][]) {
      // Every one of today's counts is saved with no number, and the strip reads it not recorded...
      expect((await readSnapshot(t, metric, TODAY))?.scalar, key).toBeUndefined();
      expect(pulse[key], key).not.toBeNull();
      expect(pulse[key]?.daily.at(-1), key).toBeNull();
    }
    // ...and the totals come from the season's walk, not a sum of days, so nothing is undercounted.
    expect(pulse.kudos).toEqual(expect.objectContaining({ total: 2, over: 2 }));
    expect(pulse.signedIn).toEqual(expect.objectContaining({ total: 2 }));
    expect(pulse.contributors).toEqual(expect.objectContaining({ total: 3 }));
    expect(pulse.signedIn?.daily.at(-1)).toBeNull();
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
      { state: 'NH', bodies: 60, reports: 2, comments: 2, photos: 2, kudos: 2, contributors: 2 },
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
      imageryNudgeLowC: null,
      winterFrom: null,
      lastWinterFirst: null,
    });
    const home = await mod.as.query(api.seasonWatch.homeSummary, {});
    expect(home.watch).toBeNull();
    // No tick has counted yet: nothing counted, and nothing counted through.
    expect(home.winter).toEqual({
      state: 'not-yet',
      nights: null,
      window: null,
      needs: null,
      through: null,
      freezeC: 0,
    });
    expect(home.imagery).toEqual({
      state: 'not-started',
      granules: 0,
      lastLandedAt: null,
      lastFrameAt: null,
    });
    expect(home.firstSkate).toEqual({ first: null, lastWinter: null });
  });

  test('open, winter set in on the window, imagery running, the first skate from on the ice', async () => {
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
        winterFrom: '2026-11-03',
        winter: {
          frozen: [{ waterBodyId: a, name: 'Valley A', lowC: -2 }],
          reporting: 2,
          nights: 10,
        },
        // As the tick counted it; the tile never counts the stored lows itself.
        winterTally: {
          through: '2026-11-07',
          nights: 13,
          window: 14,
          needs: 10,
          endedOn: null,
          freezeC: 0,
        },
        sentinels: [{ waterBodyId: summit, name: 'Upper Lake of the Clouds' }],
        opening: {
          sentinels: [{ waterBodyId: summit, name: 'Upper Lake of the Clouds', lowC: -3 }],
          corpus: { frozen: 0, reporting: 2 },
        },
        imageryNudgeOn: '2026-10-20',
        imageryNudgeSites: [
          { name: 'Upper Lake of the Clouds', lowC: -8 },
          { name: 'Eagle Lake', lowC: -7 },
        ],
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
          firstDate: '2026-10-25',
          lows,
          updatedAt: NOW,
        });
      // 25 Oct – 7 Nov: Valley A froze every night but the last, half of the two reporting.
      await site(summit, 'Upper Lake of the Clouds', Array(14).fill(-9));
      await site(a, 'Valley A', [...Array(13).fill(-2), 3]);
      await site(b, 'Valley B', Array(14).fill(2));
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
    expect(tape.winterFrom).toBe('2026-11-03');
    expect(tape.imageryNudgeLowC).toBe(-8);
    expect(tape.lastWinterFirst).toEqual({
      source: 'report',
      at: Date.UTC(2025, 11, 20),
      body: 'Valley B',
    });

    const home = await mod.as.query(api.seasonWatch.homeSummary, {});
    expect(home.watch).toEqual(
      expect.objectContaining({ opensOn: '2026-10-03', openedBy: ['sentinel'], closesOn: null }),
    );
    expect(home.winter).toEqual({
      state: 'set',
      from: '2026-11-03',
      endedOn: null,
      nights: 13,
      window: 14,
      through: '2026-11-07',
      freezeC: 0,
    });
    expect(home.imagery).toEqual({
      state: 'running',
      granules: 4,
      lastLandedAt: null,
      lastFrameAt: null,
    });
    expect(home.firstSkate).toEqual({
      first: { source: 'report', at: NOW - 2 * DAY, body: 'Valley A' },
      lastWinter: { source: 'report', at: Date.UTC(2025, 11, 20), body: 'Valley B' },
    });
  });

  test('first skated is the first on-ice report; a staff date only for a season with none', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const ada = await seedUser(t, 'ada');
    const crystal = await seedBody(t, 'Crystal Lake');
    await seedReport(t, ada.id, crystal, NOW - 2 * DAY, { observedFrom: 'on_ice' });
    await t.run(async (ctx) => {
      await ctx.db.insert('seasonFieldDates', {
        season: 'winter-2026-27',
        kind: 'last_skated',
        date: '2026-10-30',
        enteredBy: mod.id,
        enteredAt: NOW,
      });
      // An earlier staff date this season: the report still wins.
      await ctx.db.insert('seasonFieldDates', {
        season: 'winter-2026-27',
        kind: 'first_skated',
        date: '2026-11-01',
        waterBodyId: crystal,
        enteredBy: mod.id,
        enteredAt: NOW,
      });
      // Last winter has no on-ice report: its staff date stands in, marked as staff's.
      await ctx.db.insert('seasonFieldDates', {
        season: 'winter-2025-26',
        kind: 'first_skated',
        date: '2025-12-06',
        place: 'Low Plains',
        enteredBy: mod.id,
        enteredAt: NOW,
      });
    });
    const home = await mod.as.query(api.seasonWatch.homeSummary, {});
    expect(home.firstSkate).toEqual({
      first: { source: 'report', at: NOW - 2 * DAY, body: 'Crystal Lake' },
      lastWinter: { source: 'field', day: '2025-12-06', body: 'Low Plains' },
    });
  });

  test('looks for the first skate through the page’s day — within a few minutes of the server’s', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    const ada = await seedUser(t, 'ada');
    const crystal = await seedBody(t, 'Crystal Lake');
    // Two minutes before midnight, a page whose clock has turned asks for its new day; the season's
    // first on-ice report ended a minute into that day.
    vi.setSystemTime(Date.UTC(2026, 10, 13, 23, 58));
    const at = Date.UTC(2026, 10, 14, 0, 1);
    await seedReport(t, ada.id, crystal, at, { observedFrom: 'on_ice' });
    const turned = await mod.as.query(api.seasonWatch.homeSummary, { now: Date.UTC(2026, 10, 14) });
    expect(turned.firstSkate?.first).toEqual({ source: 'report', at, body: 'Crystal Lake' });
    // The server's own day ends at midnight, and a clock weeks behind is pulled up to it.
    expect((await mod.as.query(api.seasonWatch.homeSummary, {})).firstSkate?.first).toBeNull();
    const behind = await mod.as.query(api.seasonWatch.homeSummary, { now: Date.UTC(2026, 9, 2) });
    expect(behind.firstSkate?.first).toBeNull();
  });

  test('a closed watch ends imagery, with the capture of its last frame', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await t.run(async (ctx) => {
      await ctx.db.insert('imageryIngestSeasons', {
        season: 'winter-2025-26',
        opensOn: '2025-10-04',
        openedBy: ['sentinel'],
        winterFrom: null,
        closesOn: '2026-05-05',
        closedAt: Date.UTC(2026, 4, 6),
        imageryStartedAt: Date.UTC(2025, 10, 1),
        sitesSampled: 3,
        detectedAt: Date.UTC(2025, 9, 5),
      });
      await ctx.db.insert('imageryFrames', {
        season: 'winter-2025-26',
        manifestKey: 'k',
        granuleId: 'g',
        capturedAt: '2026-04-12T15:30:00Z',
        cloudCoverPct: 10,
        bodyCount: 3,
        bands: [],
      });
    });
    const home = await mod.as.query(api.seasonWatch.homeSummary, { season: 2025 });
    expect(home.imagery).toEqual(
      expect.objectContaining({ state: 'ended', lastFrameAt: Date.UTC(2026, 3, 12, 15, 30) }),
    );
  });

  test('a watch that closed with imagery never started has ended, never "not started"', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await t.run((ctx) =>
      ctx.db.insert('imageryIngestSeasons', {
        season: 'winter-2025-26',
        opensOn: '2025-10-04',
        openedBy: ['corpus'],
        winterFrom: null,
        closesOn: '2026-05-05',
        closedAt: Date.UTC(2026, 4, 6),
        sitesSampled: 3,
        detectedAt: Date.UTC(2025, 9, 5),
      }),
    );
    const home = await mod.as.query(api.seasonWatch.homeSummary, { season: 2025 });
    expect(home.imagery).toEqual({
      state: 'ended',
      granules: 0,
      lastLandedAt: null,
      lastFrameAt: null,
    });
  });

  test('a past season’s imagery has ended even when its record never closed', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await t.run((ctx) =>
      ctx.db.insert('imageryIngestSeasons', {
        season: 'winter-2025-26',
        opensOn: '2025-10-04',
        openedBy: ['sentinel'],
        winterFrom: null,
        imageryStartedAt: Date.UTC(2025, 10, 1),
        imageryPausedAt: Date.UTC(2026, 1, 1),
        sitesSampled: 3,
        detectedAt: Date.UTC(2025, 9, 5),
      }),
    );
    const home = await mod.as.query(api.seasonWatch.homeSummary, { season: 2025 });
    expect(home.imagery.state).toBe('ended');
  });

  test('a paused imagery run, and a winter with no lows to count', async () => {
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
    // A winter no tick has counted since still reads as set, with nothing counted and no end.
    expect(home.winter).toEqual({
      state: 'set',
      from: '2026-11-05',
      endedOn: null,
      nights: null,
      window: null,
      through: null,
      freezeC: 0,
    });
  });

  test('an ended winter, labelled with the line it was counted under, not a later edit', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod', 'moderator');
    await t.run(async (ctx) => {
      await ctx.db.insert('imageryIngestSeasons', {
        season: 'winter-2026-27',
        opensOn: '2026-10-03',
        openedBy: ['corpus'],
        winterFrom: '2026-11-03',
        winterTally: {
          through: '2026-11-15',
          nights: 4,
          window: 14,
          needs: 10,
          endedOn: '2026-11-15',
          freezeC: 0,
        },
        sitesSampled: 1,
        detectedAt: NOW - 40 * DAY,
      });
      await ctx.db.insert('seasonWatchSettings', {
        version: 1,
        settings: { ...DEFAULT_SEASON_WATCH_SETTINGS, freezeC: -2 },
        sentinels: [],
        pinned: [],
        savedAt: NOW,
      });
    });
    expect((await mod.as.query(api.seasonWatch.homeSummary, {})).winter).toEqual({
      state: 'set',
      from: '2026-11-03',
      endedOn: '2026-11-15',
      nights: 4,
      window: 14,
      through: '2026-11-15',
      // Saved as 28 °F since; these nights were counted at 32 °F.
      freezeC: 0,
    });
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

  const POLL_JOB = 'poll for new satellite imagery';
  const PUMP_JOB = 'pump live satellite imagery';
  const INDEX_JOB = 'rebuild the live imagery index';
  type Beat = Omit<Doc<'cronHeartbeats'>, '_id' | '_creationTime' | 'job'>;
  const beat = (t: T, job: string, hb: Beat) =>
    t.run(async (ctx) => {
      const old = await ctx.db
        .query('cronHeartbeats')
        .withIndex('by_job', (q) => q.eq('job', job))
        .first();
      if (old !== null) await ctx.db.delete(old._id);
      await ctx.db.insert('cronHeartbeats', { job, ...hb });
    });
  const cronRun = (t: T, job: string, outcome: Doc<'cronRuns'>['outcome'], at: number) =>
    t.run((ctx) =>
      ctx.db.insert('cronRuns', {
        job,
        startedAt: at,
        finishedAt: at,
        outcome,
        trigger: 'cron' as const,
        keepUntil: at + 200 * DAY,
      }),
    );

  test('trouble first, then a few ok; the untracked crons are never called ok', async () => {
    const t = harness();
    const admin = await seedUser(t, 'adm', 'admin');
    const refused = await cronRun(t, INDEX_JOB, 'refused', NOW - 5 * MINUTE);
    await beat(t, POLL_JOB, { lastTickAt: NOW - HOUR, lastOutcome: 'failed' });
    await beat(t, PUMP_JOB, { lastTickAt: NOW - MINUTE, lastOutcome: 'ok' });
    await beat(t, INDEX_JOB, {
      lastTickAt: NOW - 5 * MINUTE,
      lastOutcome: 'worked',
      lastRunId: refused,
    });
    // The old record is read by nothing now: a failure there changes no row.
    await t.run((ctx) =>
      ctx.db.insert('imageryRuns', {
        season: 'winter-2026-27',
        kind: 'pump',
        startedAt: NOW - MINUTE,
        finishedAt: NOW - MINUTE,
        outcome: 'failed',
      }),
    );
    await snapshot(t, 'flag_queue_depth', TODAY, { scalar: 0, meta: {} });

    const card = await admin.as.query(api.machinery.overviewJobs, { now: NOW });
    expect(card?.jobs.map((j) => [j.id, j.state, j.at])).toEqual([
      ['imagery-poll', 'failed', NOW - HOUR],
      // On time, but its last run was a cut the machine host turned down: retried.
      ['imagery-index', 'retried', NOW - 5 * MINUTE],
      ['imagery-pump', 'ok', NOW - MINUTE],
      ['metrics-rollup', 'ok', expect.any(Number)],
      ['coverage-sweep', 'never', null],
    ]);
    expect(card?.untracked).toBeGreaterThan(0);
    expect(card?.moreAllOk).toBe(false);
  });

  test('the imagery rows name registered crons, in the card’s order', () => {
    expect(IMAGERY_CARD_JOBS.map((j) => cronJob(j.job)?.pipeline)).toEqual([
      'imagery',
      'imagery',
      'imagery',
    ]);
  });

  test('each imagery row is the cron cards’ verdict at the same now', async () => {
    const t = harness();
    const admin = await seedUser(t, 'adm', 'admin');
    const cases: { name: string; hb: Beat | null; state: JobState; at: number | null }[] = [
      { name: 'never', hb: null, state: 'never', at: null },
      {
        name: 'ok',
        hb: { lastTickAt: NOW - MINUTE, lastOutcome: 'ok' },
        state: 'ok',
        at: NOW - MINUTE,
      },
      {
        name: 'worked',
        hb: { lastTickAt: NOW - 2 * MINUTE, lastOutcome: 'worked' },
        state: 'ok',
        at: NOW - 2 * MINUTE,
      },
      {
        name: 'failed',
        hb: { lastTickAt: NOW - MINUTE, lastOutcome: 'failed', lastError: 'Fly 503' },
        state: 'failed',
        at: NOW - MINUTE,
      },
      // The pump ticks every three minutes: late past six, stalled past thirty.
      {
        name: 'late',
        hb: { lastTickAt: NOW - 7 * MINUTE, lastOutcome: 'ok' },
        state: 'late',
        at: NOW - 7 * MINUTE,
      },
      {
        name: 'stalled',
        hb: { lastTickAt: NOW - HOUR, lastOutcome: 'ok' },
        state: 'stalled',
        at: NOW - HOUR,
      },
      {
        name: 'running',
        hb: { lastTickAt: NOW - 4 * MINUTE, lastOutcome: 'ok', runningSince: NOW - MINUTE },
        state: 'running',
        at: NOW - MINUTE,
      },
      // Began and never finished, past the action limit: it needs a look.
      {
        name: 'killed',
        hb: { lastTickAt: NOW - 20 * MINUTE, lastOutcome: 'ok', runningSince: NOW - 15 * MINUTE },
        state: 'failed',
        at: NOW - 15 * MINUTE,
      },
      {
        name: 'a killed tick recorded',
        hb: { lastTickAt: NOW - MINUTE, lastOutcome: 'killed' },
        state: 'failed',
        at: NOW - MINUTE,
      },
    ];
    for (const c of cases) {
      await t.run(async (ctx) => {
        for (const row of await ctx.db.query('cronHeartbeats').collect())
          await ctx.db.delete(row._id);
      });
      if (c.hb !== null) await beat(t, PUMP_JOB, c.hb);
      const card = await admin.as.query(api.machinery.overviewJobs, { now: NOW });
      const row = card?.jobs.find((j) => j.id === 'imagery-pump');
      expect([c.name, row?.state, row?.at]).toEqual([c.name, c.state, c.at]);
      // The same rows at the same now, read the way Machinery's cron cards read them.
      const [view] = await admin.as.query(api.machineryCrons.jobs, { names: [PUMP_JOB], now: NOW });
      if (view === undefined) throw new Error('no view');
      expect(view.liveness).toEqual(cronLiveness(view.inputs, view.schedule, NOW));
      expect([c.name, cronJobState(view.liveness, view.lastRun)]).toEqual([c.name, row?.state]);
    }
  });

  test('right after the deploy that began recording: not yet ticked is quiet, never red or ok', async () => {
    const t = harness();
    const admin = await seedUser(t, 'adm', 'admin');
    // The history copy may have run (or not): a copied failure is history, not the cron's state.
    await cronRun(t, POLL_JOB, 'failed', NOW - 3 * HOUR);
    await snapshot(t, 'flag_queue_depth', TODAY, { scalar: 0, meta: {} });
    const card = await admin.as.query(api.machinery.overviewJobs, { now: NOW });
    const imagery = card?.jobs.filter((j) => j.id.startsWith('imagery-'));
    expect(imagery?.map((j) => [j.id, j.state, j.at])).toEqual([
      ['imagery-poll', 'never', null],
      ['imagery-pump', 'never', null],
      ['imagery-index', 'never', null],
    ]);
    // Nothing needs a look, and the card never says "all ok" over a cron it hasn't heard from.
    expect(card?.jobs[0]?.id).toBe('metrics-rollup');
    expect(card?.moreAllOk).toBe(false);
    // A never-ticked cron left off the card keeps its foot from saying all ok.
    const left = cardRows(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
        id,
        name: id,
        state: 'never' as const,
        at: null,
      })),
      0,
    );
    expect([left.more, left.moreAllOk]).toEqual([1, false]);
    // The pump's first tick, three minutes on, and its row reads its own verdict.
    await beat(t, PUMP_JOB, { lastTickAt: NOW, lastOutcome: 'ok' });
    const after = await admin.as.query(api.machinery.overviewJobs, { now: NOW });
    expect(after?.jobs.find((j) => j.id === 'imagery-pump')?.state).toBe('ok');
  });

  test('the caller’s clock moves a job late, but only within a minute of the server’s', async () => {
    const t = harness();
    const admin = await seedUser(t, 'adm', 'admin');
    await snapshot(t, 'flag_queue_depth', TODAY, { scalar: 0, meta: {} });
    const rollup = async (now?: number) =>
      (
        await admin.as.query(api.machinery.overviewJobs, now === undefined ? {} : { now })
      )?.jobs.find((j) => j.id === 'metrics-rollup')?.state;
    // The rollup stamped `NOW`; twelve hours on is late — but a client can't claim it.
    expect(await rollup(NOW + 13 * HOUR)).toBe('ok');
    expect(await rollup(Number.NaN)).toBe('ok');
    vi.setSystemTime(NOW + 13 * HOUR);
    expect(await rollup(NOW + 13 * HOUR)).toBe('late');
    expect(await rollup()).toBe('late');
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
