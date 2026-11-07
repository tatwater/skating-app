import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { LIST_ANSWER_VERIFY_CAP, WANTERS_SHOWN_CAP } from './bounties';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const T0 = Date.UTC(2026, 0, 10, 15);
const HOUR = 3_600_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

type T = ReturnType<typeof convexTest>;

async function seedUser(t: T, subject: string, extra: Partial<Doc<'profiles'>> = {}) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      profileImageUrl: `https://img/${subject}`,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: {
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
      },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member',
      status: 'active',
      createdAt: T0,
      ...extra,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function seedBody(t: T) {
  const waterBodyId = await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Mascoma Lake',
      searchText: 'Mascoma Lake',
      type: 'lakePond',
      source: 'osm',
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [1, 0],
            [0, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean',
      createdAt: T0,
    }),
  );
  const { id: moderator } = await seedUser(t, 'moderator');
  const subAreaId = await t.run((ctx) =>
    ctx.db.insert('waterBodySubAreas', {
      waterBodyId,
      name: 'The Narrows',
      searchText: 'The Narrows',
      centroid: { lat: 0.25, lng: 0.25 },
      surfaceAreaSqM: 1,
      displayScore: 1,
      minVisibleZoom: 10,
      createdByUserId: moderator,
      updatedAt: T0,
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [0, 0.5],
            [0.5, 0.5],
            [0.5, 0],
            [0, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: 0, maxLat: 0.5, maxLng: 0.5 },
      createdAt: T0,
    }),
  );
  return { waterBodyId, subAreaId };
}

async function seedReport(
  t: T,
  authorId: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
  extra: Partial<Doc<'reports'>> = {},
) {
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: T0,
      reportTime: T0,
      source: 'native',
      iceTypes: [],
      surfaceTags: [],
      photoIds: [],
      hazardIdsCreated: [],
      moderationStatus: 'visible',
      createdAt: T0,
      updatedAt: T0,
      ...extra,
    }),
  );
}

async function seedBounty(
  t: T,
  requesterId: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
  extra: Partial<Doc<'bounties'>> = {},
) {
  return t.run((ctx) =>
    ctx.db.insert('bounties', {
      requesterId,
      waterBodyId,
      windowHours: 24,
      status: 'open',
      rewardPoints: 10,
      fulfillingReportIds: [],
      createdAt: T0 - 2 * HOUR,
      expiresAt: T0 + 24 * HOUR,
      ...extra,
    }),
  );
}

describe('bounties.getDetail — board 2.6 (B03 §11)', () => {
  test("carries each candidate's claims, duration and author image, and the requester's image", async () => {
    const t = convexTest(schema, modules);
    const requester = await seedUser(t, 'req');
    const author = await seedUser(t, 'author');
    const { waterBodyId } = await seedBody(t);
    const reportId = await seedReport(t, author.id, waterBodyId, {
      skateStartTime: T0 - HOUR,
      suitability: 'dont_go',
      observedFrom: 'shore',
    });
    const bountyId = await seedBounty(t, requester.id, waterBodyId, {
      fulfillingReportIds: [reportId],
    });
    const detail = await requester.as.query(api.bounties.getDetail, { bountyId });
    expect(detail?.requester.profileImageUrl).toBe('https://img/req');
    expect(detail?.fulfillingReports).toEqual([
      expect.objectContaining({
        _id: reportId,
        skateStartTime: T0 - HOUR,
        skateEndTime: T0,
        suitability: 'dont_go',
        observedFrom: 'shore',
        author: expect.objectContaining({ profileImageUrl: 'https://img/author' }),
      }),
    ]);
  });

  test('the wanters are the open asks on the same target, requester first, with avatars', async () => {
    const t = convexTest(schema, modules);
    const req = await seedUser(t, 'req');
    const alsoLake = await seedUser(t, 'also');
    const bayAsker = await seedUser(t, 'bay');
    const blocker = await seedUser(t, 'blocker');
    const ghost = await seedUser(t, 'ghost', { deletionRequestedAt: T0 });
    const closed = await seedUser(t, 'closed');
    const { waterBodyId, subAreaId } = await seedBody(t);
    const bountyId = await seedBounty(t, req.id, waterBodyId);
    await seedBounty(t, alsoLake.id, waterBodyId);
    await seedBounty(t, alsoLake.id, waterBodyId); // the same person twice is one wanter
    await seedBounty(t, bayAsker.id, waterBodyId, { subAreaId }); // a different target
    await seedBounty(t, blocker.id, waterBodyId);
    await seedBounty(t, ghost.id, waterBodyId);
    await seedBounty(t, closed.id, waterBodyId, { status: 'expired' });
    await t.run((ctx) =>
      ctx.db.insert('blocks', { blockerId: blocker.id, blockedId: req.id, createdAt: T0 }),
    );
    const detail = await req.as.query(api.bounties.getDetail, { bountyId });
    expect(detail?.wanters.map((w) => w.userId)).toEqual([req.id, alsoLake.id]);
    expect(detail?.wanters[1]?.profileImageUrl).toBe('https://img/also');
    // Counted, people all: the blocked and the departing still asked.
    expect(detail?.wantersCount).toBe(4);
  });

  test('draws at most WANTERS_SHOWN_CAP people and counts the rest', async () => {
    const t = convexTest(schema, modules);
    const req = await seedUser(t, 'req');
    const { waterBodyId } = await seedBody(t);
    const bountyId = await seedBounty(t, req.id, waterBodyId);
    for (let i = 0; i < WANTERS_SHOWN_CAP + 2; i++) {
      const u = await seedUser(t, `w${i}`);
      await seedBounty(t, u.id, waterBodyId);
    }
    const detail = await t.query(api.bounties.getDetail, { bountyId });
    expect(detail?.wanters).toHaveLength(WANTERS_SHOWN_CAP);
    expect(detail?.wantersCount).toBe(WANTERS_SHOWN_CAP + 3);
  });
});

describe('the bounty lists honor the skate-time rule and name their place (B03 §11)', () => {
  test('listForBody: subAreaId, lake and bay names, and only answering reports counted', async () => {
    const t = convexTest(schema, modules);
    const req = await seedUser(t, 'req');
    const author = await seedUser(t, 'author');
    const { waterBodyId, subAreaId } = await seedBody(t);
    const answers = await seedReport(t, author.id, waterBodyId);
    // Skated before the bounty opened — attached by an older rule, or re-dated since.
    const stale = await seedReport(t, author.id, waterBodyId, { skateEndTime: T0 - 3 * HOUR });
    const hidden = await seedReport(t, author.id, waterBodyId, { moderationStatus: 'hidden' });
    await seedBounty(t, req.id, waterBodyId, {
      subAreaId,
      fulfillingReportIds: [answers, stale, hidden],
    });
    const rows = await t.query(api.bounties.listForBody, { waterBodyId });
    expect(rows).toEqual([
      expect.objectContaining({
        subAreaId,
        waterBodyName: 'Mascoma Lake',
        subAreaName: 'The Narrows',
        fulfillingCount: 1,
      }),
    ]);
  });

  test('listOpen counts the same way, and carries subAreaId', async () => {
    const t = convexTest(schema, modules);
    const req = await seedUser(t, 'req');
    const author = await seedUser(t, 'author');
    const { waterBodyId, subAreaId } = await seedBody(t);
    const stale = await seedReport(t, author.id, waterBodyId, { skateEndTime: T0 - 3 * HOUR });
    await seedBounty(t, req.id, waterBodyId, { subAreaId, fulfillingReportIds: [stale] });
    const [row] = await t.query(api.bounties.listOpen, {});
    expect(row).toMatchObject({ subAreaId, subAreaName: 'The Narrows', fulfillingCount: 0 });
  });

  test('past the verify cap, an attachment counts on the rule it passed when it attached', async () => {
    const t = convexTest(schema, modules);
    const req = await seedUser(t, 'req');
    const author = await seedUser(t, 'author');
    const { waterBodyId } = await seedBody(t);
    const ids: Id<'reports'>[] = [];
    for (let i = 0; i < LIST_ANSWER_VERIFY_CAP + 2; i++) {
      ids.push(await seedReport(t, author.id, waterBodyId));
    }
    await seedBounty(t, req.id, waterBodyId, { fulfillingReportIds: ids });
    const [row] = await t.query(api.bounties.listForBody, { waterBodyId });
    expect(row?.fulfillingCount).toBe(LIST_ANSWER_VERIFY_CAP + 2);
  });

  test('myBounties: names, the answering count, and who answered, once each', async () => {
    const t = convexTest(schema, modules);
    const req = await seedUser(t, 'req');
    const author = await seedUser(t, 'author');
    const { waterBodyId, subAreaId } = await seedBody(t);
    const r1 = await seedReport(t, author.id, waterBodyId);
    const r2 = await seedReport(t, author.id, waterBodyId, { skateEndTime: T0 - HOUR / 2 });
    const stale = await seedReport(t, author.id, waterBodyId, { skateEndTime: T0 - 3 * HOUR });
    const bountyId = await seedBounty(t, req.id, waterBodyId, {
      subAreaId,
      fulfillingReportIds: [r1, r2, stale],
    });
    await seedBounty(t, req.id, waterBodyId, { status: 'expired', createdAt: T0 - 5 * HOUR });
    const rows = await req.as.query(api.bounties.myBounties, {});
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      _id: bountyId,
      subAreaId,
      waterBodyName: 'Mascoma Lake',
      subAreaName: 'The Narrows',
      fulfillingCount: 2,
    });
    expect(rows[0]?.answeredBy.map((a) => a.username)).toEqual(['author']);
    expect(rows[1]?.answeredBy).toEqual([]);
    expect(await t.query(api.bounties.myBounties, {})).toEqual([]);
  });
});
