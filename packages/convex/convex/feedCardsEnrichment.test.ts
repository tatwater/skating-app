import { CARD_COUNT_CAP } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const T0 = Date.UTC(2026, 0, 10, 15);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 60_000);
});
afterEach(() => vi.useRealTimers());

type T = ReturnType<typeof convexTest>;

async function seedUser(t: T, subject: string, extra: Partial<Doc<'profiles'>> = {}) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
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
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      source: 'osm',
      name: 'Lake Morey',
      searchText: 'Lake Morey',
      type: 'lakePond',
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
      interiorPoint: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean',
      createdAt: T0,
    }),
  );
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

async function seedPutIn(t: T, waterBodyId: Id<'waterBodies'>, extra: Partial<Doc<'putIns'>> = {}) {
  return t.run((ctx) =>
    ctx.db.insert('putIns', {
      waterBodyId,
      coord: { lat: 0.9, lng: 0.5 },
      source: 'osm',
      status: 'visible',
      createdAt: T0,
      ...extra,
    }),
  );
}

async function cardsFor(as: { query: T['query'] } | T, waterBodyId: Id<'waterBodies'>) {
  const res = await as.query(api.reports.listCardsByWaterBody, {
    waterBodyId,
    paginationOpts: { numItems: 20, cursor: null },
  });
  return res.page;
}

describe('the B03 card fields (§11)', () => {
  test('a card carries the thickness summary, the notes excerpt, the tallies and the put-in name', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'author');
    const fan = await seedUser(t, 'fan');
    const critic = await seedUser(t, 'critic');
    const body = await seedBody(t);
    const putInId = await seedPutIn(t, body, { name: 'Lake Morey Boat Ramp' });
    const reportId = await seedReport(t, author.id, body, {
      putInId,
      notes: 'Glass from the ramp to the island.\n\nSnow beyond.',
      iceThickness: {
        readings: [
          { valueCm: 12, method: 'measured' },
          { minCm: 9, maxCm: 11, method: 'estimated' },
        ],
      },
    });
    await t.run(async (ctx) => {
      for (const [raterId, verdict] of [
        [fan.id, 'helpful'],
        [critic.id, 'unhelpful'],
      ] as const) {
        await ctx.db.insert('reportRatings', {
          targetType: 'report',
          targetId: reportId,
          raterId,
          verdict,
          createdAt: T0,
        });
      }
      await ctx.db.insert('comments', {
        reportId,
        authorId: fan.id,
        body: 'Thanks!',
        source: 'native',
        moderationStatus: 'visible',
        createdAt: T0,
      });
      await ctx.db.insert('comments', {
        reportId,
        authorId: critic.id,
        body: 'gone',
        source: 'native',
        moderationStatus: 'removed',
        createdAt: T0,
      });
    });
    const [card] = await cardsFor(t, body);
    expect(card).toMatchObject({
      reportId,
      thickness: { readingCount: 2, minCm: 9, maxCm: 12, methods: ['measured', 'estimated'] },
      notesExcerpt: 'Glass from the ramp to the island. Snow beyond.',
      helpfulCount: 1,
      commentCount: 1,
      putInName: 'Lake Morey Boat Ramp',
    });
    expect(card?.helpfulCountCapped).toBeUndefined();
  });

  test("a blocked author's comments aren't counted for the viewer who can't see them", async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'author');
    const viewer = await seedUser(t, 'viewer');
    const troll = await seedUser(t, 'troll');
    const body = await seedBody(t);
    const reportId = await seedReport(t, author.id, body);
    await t.run(async (ctx) => {
      await ctx.db.insert('comments', {
        reportId,
        authorId: troll.id,
        body: 'hi',
        source: 'native',
        moderationStatus: 'visible',
        createdAt: T0,
      });
      await ctx.db.insert('blocks', { blockerId: viewer.id, blockedId: troll.id, createdAt: T0 });
    });
    expect((await cardsFor(viewer.as, body))[0]?.commentCount).toBe(0);
    expect((await cardsFor(t, body))[0]?.commentCount).toBe(1);
  });

  test('the tallies stop at the cap and say so', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'author');
    const body = await seedBody(t);
    const reportId = await seedReport(t, author.id, body);
    await t.run(async (ctx) => {
      for (let i = 0; i <= CARD_COUNT_CAP; i++) {
        await ctx.db.insert('reportRatings', {
          targetType: 'report',
          targetId: reportId,
          raterId: author.id,
          verdict: 'helpful',
          createdAt: T0,
        });
        await ctx.db.insert('comments', {
          reportId,
          authorId: author.id,
          body: `c${i}`,
          source: 'native',
          moderationStatus: 'visible',
          createdAt: T0,
        });
      }
    });
    const [card] = await cardsFor(t, body);
    expect(card).toMatchObject({
      helpfulCount: CARD_COUNT_CAP,
      helpfulCountCapped: true,
      commentCount: CARD_COUNT_CAP,
      commentCountCapped: true,
    });
  });

  test('a withheld put-in withholds its name too; the author still sees it', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'author');
    const stranger = await seedUser(t, 'stranger');
    const body = await seedBody(t);
    const putInId = await seedPutIn(t, body, { name: 'Private Dock' });
    await seedReport(t, author.id, body, { putInId, showPutIn: false });
    expect((await cardsFor(stranger.as, body))[0]?.putInName).toBeUndefined();
    expect((await cardsFor(author.as, body))[0]?.putInName).toBe('Private Dock');
  });

  test('an unnamed launch takes its compass name; a hidden one, none; nothing measured, no summary', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'author');
    const body = await seedBody(t);
    const unnamed = await seedPutIn(t, body);
    const hidden = await seedPutIn(t, body, { name: 'Hidden', status: 'hidden' });
    await seedReport(t, author.id, body, { putInId: unnamed, skateEndTime: T0 });
    await seedReport(t, author.id, body, { putInId: hidden, skateEndTime: T0 - 1 });
    await seedReport(t, author.id, body, { putInId: unnamed, skateEndTime: T0 - 2 });
    const cards = await cardsFor(t, body);
    expect(cards[0]?.putInName).toBe('N launch');
    expect(cards[1]?.putInName).toBeUndefined();
    expect(cards[2]?.putInName).toBe('N launch');
    expect(cards[0]?.thickness).toBeUndefined();
    expect(cards[0]?.notesExcerpt).toBeUndefined();
  });
});

describe('reports.listCardsByWaterBody (B03 §11)', () => {
  test('the same page as listByWaterBody, as cards, with the put-in opt-out honored', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'author');
    const body = await seedBody(t);
    await seedReport(t, author.id, body, { showPutIn: false, point: { lat: 0.9, lng: 0.9 } });
    await seedReport(t, author.id, body, { skateEndTime: T0 - 1 });
    await seedReport(t, author.id, body, { skateEndTime: T0 - 2, moderationStatus: 'hidden' });
    const docs = await t.query(api.reports.listByWaterBody, {
      waterBodyId: body,
      paginationOpts: { numItems: 20, cursor: null },
    });
    const cards = await cardsFor(t, body);
    expect(cards.map((c) => c.reportId)).toEqual(docs.page.map((d) => d._id));
    // The redacted card draws no put-in on its silhouette.
    expect(cards[0]?.silhouette?.putIn).toBeUndefined();
    expect(cards[1]?.silhouette?.putIn).toEqual({ lat: 0.5, lng: 0.5 });
  });

  test('narrows to a bay through the same join as the raw list', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'author');
    const body = await seedBody(t);
    const other = await seedBody(t);
    const bay = await t.run((ctx) =>
      ctx.db.insert('waterBodySubAreas', {
        waterBodyId: body,
        name: 'North Bay',
        searchText: 'North Bay',
        polygon: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0.5],
              [0, 1],
              [1, 1],
              [1, 0.5],
              [0, 0.5],
            ],
          ],
        },
        bbox: { minLat: 0.5, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.75, lng: 0.5 },
        surfaceAreaSqM: 1,
        displayScore: 1,
        minVisibleZoom: 10,
        createdByUserId: author.id,
        createdAt: T0,
        updatedAt: T0,
      }),
    );
    const inBay = await seedReport(t, author.id, body, { subAreaId: bay });
    await t.run((ctx) =>
      ctx.db.insert('reportSubAreas', {
        reportId: inBay,
        subAreaId: bay,
        waterBodyId: body,
        moderationStatus: 'visible',
        skateEndTime: T0,
      }),
    );
    await seedReport(t, author.id, body, { skateEndTime: T0 - 1 });
    const res = await t.query(api.reports.listCardsByWaterBody, {
      waterBodyId: body,
      subAreaId: bay,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(res.page.map((c) => c.reportId)).toEqual([inBay]);
    await expect(
      t.query(api.reports.listCardsByWaterBody, {
        waterBodyId: other,
        subAreaId: bay,
        paginationOpts: { numItems: 20, cursor: null },
      }),
    ).rejects.toThrow(/not on this water body/);
  });
});
