import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { legacyPostFor } from './posts';
import { a10ShapePatch } from './reports';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const T0 = Date.UTC(2026, 0, 10, 15);

// Fake timers from before the first schedule (the `subAreas.test.ts` note): the backfill is a
// `scheduler.runAfter(0)` chain, and convex-test leaves such a job pending until a timer fires.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 60_000);
});
afterEach(() => {
  vi.useRealTimers();
});

async function seedProfile(t: ReturnType<typeof convexTest>): Promise<Id<'profiles'>> {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: 'clerk_a',
      displayName: 'a',
      username: 'a',
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
    }),
  );
}

async function seedBody(t: ReturnType<typeof convexTest>): Promise<Id<'waterBodies'>> {
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
      dedupStatus: 'clean',
      createdAt: T0,
    }),
  );
}

/** A report row with no Post (the Post backfill's input); chips in the stored shape. */
async function seedLegacyReport(
  t: ReturnType<typeof convexTest>,
  authorId: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
  overrides: Partial<Doc<'reports'>> = {},
): Promise<Id<'reports'>> {
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: T0,
      reportTime: T0 + 1000,
      source: 'native',
      iceTypes: [{ type: 'black_ice' }],
      surfaceTags: [{ type: 'glass' }, { type: 'orange_peel' }],
      photoIds: [],
      hazardIdsCreated: [],
      moderationStatus: 'visible',
      createdAt: T0 + 1000,
      updatedAt: T0 + 1000,
      ...overrides,
    }),
  );
}

describe('posts.backfillFromReports (A10-1)', () => {
  test('gives every Post-less Report the one-body Post create would have written, and stamps its photos', async () => {
    const t = convexTest(schema, modules);
    const authorId = await seedProfile(t);
    const bodyId = await seedBody(t);
    const photoId = await t.run((ctx) =>
      ctx.db.insert('photos', {
        storageId: 's',
        thumbStorageId: 't',
        uploaderId: authorId,
        placeOnMap: false,
        createdAt: T0,
      }),
    );
    const edited = await seedLegacyReport(t, authorId, bodyId, {
      photoIds: [photoId],
      editedAt: T0 + 5000,
      moderationStatus: 'hidden',
    });
    const plain = await seedLegacyReport(t, authorId, bodyId);

    const result = await t.mutation(internal.posts.backfillFromReports, {});
    expect(result).toEqual({ scanned: 2, created: 2, photosStamped: 1, isDone: true });

    const posts = await t.run((ctx) => ctx.db.query('posts').collect());
    expect(posts).toHaveLength(2);
    const editedReport = await t.run((ctx) => ctx.db.get(edited));
    const editedPost = posts.find((p) => p._id === editedReport?.postId);
    expect(editedPost).toMatchObject({
      authorId,
      reportIds: [edited],
      photoIds: [photoId],
      latestSkateEndTime: T0,
      moderationStatus: 'hidden', // the Post inherits the Report's moderation, so a hidden report stays hidden
      editedAt: T0 + 5000,
    });
    expect(editedPost?.title).toBeUndefined(); // nothing invented: no title, no body
    expect(editedPost?.body).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(photoId)))?.reportId).toBe(edited);
    const plainReport = await t.run((ctx) => ctx.db.get(plain));
    expect(plainReport?.postId).toBeDefined();
    expect(plainReport?.postId).not.toBe(editedReport?.postId);
  });

  test('is idempotent — a second run creates nothing, and pages through a larger table', async () => {
    const t = convexTest(schema, modules);
    const authorId = await seedProfile(t);
    const bodyId = await seedBody(t);
    for (let i = 0; i < 5; i++) await seedLegacyReport(t, authorId, bodyId);

    const first = await t.mutation(internal.posts.backfillFromReports, { batchSize: 2 });
    expect(first).toEqual({ scanned: 2, created: 2, photosStamped: 0, isDone: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query('posts').collect())).toHaveLength(5);

    const again = await t.mutation(internal.posts.backfillFromReports, {});
    expect(again).toEqual({ scanned: 5, created: 0, photosStamped: 0, isDone: true });
    expect(await t.run((ctx) => ctx.db.query('posts').collect())).toHaveLength(5);
  });

  test('legacyPostFor is exactly the one-body shape', () => {
    const report = {
      _id: 'r1' as Id<'reports'>,
      authorId: 'p1' as Id<'profiles'>,
      photoIds: ['ph1' as Id<'photos'>],
      skateEndTime: 10,
      moderationStatus: 'visible' as const,
      createdAt: 11,
      updatedAt: 12,
    } as Doc<'reports'>;
    expect(legacyPostFor(report)).toEqual({
      authorId: 'p1',
      reportIds: ['r1'],
      photoIds: ['ph1'],
      latestSkateEndTime: 10,
      moderationStatus: 'visible',
      createdAt: 11,
      updatedAt: 12,
    });
  });
});

describe('reports.backfillA10Shapes (A10-1)', () => {
  // The schema is narrowed, so convex-test refuses to insert a pre-A10 row; the migration's
  // decision is the pure `a10ShapePatch`, tested here over the legacy shape through a cast, and
  // the mutation's paging is the same loop `backfillFromReports` exercises above.
  const legacyRow = (over: Record<string, unknown>) =>
    ({ iceTypes: [], surfaceTags: [], ...over }) as unknown as Doc<'reports'>;

  test('lifts bare chips and folds snowCoverCm into snow.depthCm', () => {
    expect(
      a10ShapePatch(
        legacyRow({
          iceTypes: ['black_ice'],
          surfaceTags: ['glass', 'orange_peel'],
          snowCoverCm: 3,
        }),
      ),
    ).toEqual({
      iceTypes: [{ type: 'black_ice' }],
      surfaceTags: [{ type: 'glass' }, { type: 'orange_peel' }],
      snow: { depthCm: 3 },
      snowCoverCm: undefined,
    });
  });

  test('leaves a located chip alone, and the object depth wins over a stale number', () => {
    expect(
      a10ShapePatch(
        legacyRow({
          iceTypes: [{ type: 'black_ice', where: { sector: 'N' } }, 'shell_ice'],
          snowCoverCm: 9,
          snow: { coverage: 'lanes', depthCm: 4 },
        }),
      ),
    ).toEqual({
      iceTypes: [{ type: 'black_ice', where: { sector: 'N' } }, { type: 'shell_ice' }],
      snow: { coverage: 'lanes', depthCm: 4 },
      snowCoverCm: undefined,
    });
  });

  test('keeps facets when folding the number in, and returns null for a lifted row', () => {
    expect(a10ShapePatch(legacyRow({ iceTypes: [{ type: 'black_ice' }] }))).toBeNull();
    expect(a10ShapePatch(legacyRow({ snowCoverCm: 2, snow: { coverage: 'patches' } }))).toEqual({
      snow: { coverage: 'patches', depthCm: 2 },
      snowCoverCm: undefined,
    });
  });

  test('the mutation is a no-op over lifted rows', async () => {
    const t = convexTest(schema, modules);
    const authorId = await seedProfile(t);
    const bodyId = await seedBody(t);
    await seedLegacyReport(t, authorId, bodyId);
    expect(await t.mutation(internal.reports.backfillA10Shapes, {})).toEqual({
      scanned: 1,
      patched: 0,
      isDone: true,
    });
  });
});
