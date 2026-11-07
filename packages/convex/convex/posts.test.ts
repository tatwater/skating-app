import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { postSearchText } from './lib/postSync';
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

async function seedProfile(
  t: ReturnType<typeof convexTest>,
  subject = 'clerk_a',
): Promise<Id<'profiles'>> {
  return t.run((ctx) =>
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
    }),
  );
}

/** A signed-in adult contributor, for the mutations. */
async function seedUser(t: ReturnType<typeof convexTest>, subject: string) {
  const id = await seedProfile(t, subject);
  return { id, as: t.withIdentity({ subject }) };
}

/** An uploaded photo row owned by `uploaderId`, unattached. */
async function seedPhoto(
  t: ReturnType<typeof convexTest>,
  uploaderId: Id<'profiles'>,
): Promise<Id<'photos'>> {
  return t.run((ctx) =>
    ctx.db.insert('photos', {
      storageId: 's',
      thumbStorageId: 't',
      uploaderId,
      placeOnMap: false,
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
    expect(result).toEqual({
      scanned: 2,
      created: 2,
      photosStamped: 1,
      photosShared: [],
      isDone: true,
    });

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
    expect(first).toEqual({
      scanned: 2,
      created: 2,
      photosStamped: 0,
      photosShared: [],
      isDone: false,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query('posts').collect())).toHaveLength(5);

    const again = await t.mutation(internal.posts.backfillFromReports, {});
    expect(again).toEqual({
      scanned: 5,
      created: 0,
      photosStamped: 0,
      photosShared: [],
      isDone: true,
    });
    expect(await t.run((ctx) => ctx.db.query('posts').collect())).toHaveLength(5);
  });

  /**
   * Nothing before A10 stopped one photo id being listed on two of an author's reports. The pass
   * links the earlier report and *says so* — a silent skip would leave the second report's Post
   * listing a photo that documents another (Greptile P1 on PR #71).
   */
  test('reports a photo two legacy reports both list, and links the earlier one', async () => {
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
    const earlier = await seedLegacyReport(t, authorId, bodyId, { photoIds: [photoId] });
    await seedLegacyReport(t, authorId, bodyId, { photoIds: [photoId, photoId] });

    const result = await t.mutation(internal.posts.backfillFromReports, {});
    expect(result).toEqual({
      scanned: 2,
      created: 2,
      photosStamped: 1,
      photosShared: [photoId],
      isDone: true,
    });
    expect((await t.run((ctx) => ctx.db.get(photoId)))?.reportId).toBe(earlier);
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

  test('lifts a single sighting into the located list, and keeps a list an edit already wrote (D210)', () => {
    expect(a10ShapePatch(legacyRow({ sighting: 'open' }))).toEqual({
      sightings: [{ type: 'open' }],
      sighting: undefined,
    });
    expect(
      a10ShapePatch(
        legacyRow({ sighting: 'open', sightings: [{ type: 'frozen', where: { sector: 'N' } }] }),
      ),
    ).toEqual({ sightings: [{ type: 'frozen', where: { sector: 'N' } }], sighting: undefined });
    expect(a10ShapePatch(legacyRow({ sightings: [{ type: 'skim' }] }))).toBeNull();
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

describe('posts.create (A10-2 §2.4 / D186) — one transaction, every rule', () => {
  const FRESH = { suitability: 'experienced_only' as const, surfaceTags: ['glass' as const] };

  test('writes the Post and its Reports together: order kept, postId on each, sort key the max, photos the union', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const bodyA = await seedBody(t);
    const bodyB = await seedBody(t);
    const p1 = await seedPhoto(t, author.id);
    const p2 = await seedPhoto(t, author.id);
    const { postId, reportIds } = await author.as.mutation(api.posts.create, {
      title: '  Morey and the pond, 1/10 ',
      body: 'Glass on Morey; the pond was a mess.',
      idempotencyKey: 'post-1',
      reports: [
        { ...FRESH, waterBodyId: bodyA, skateEndTime: T0 - 3 * 3_600_000, photoIds: [p1] },
        {
          ...FRESH,
          waterBodyId: bodyB,
          skateEndTime: T0,
          photoIds: [p2],
          idempotencyKey: 'report-b',
        },
      ],
    });
    expect(reportIds).toHaveLength(2);
    const post = await t.run((ctx) => ctx.db.get(postId));
    expect(post).toMatchObject({
      authorId: author.id,
      title: 'Morey and the pond, 1/10',
      body: 'Glass on Morey; the pond was a mess.',
      reportIds,
      photoIds: [p1, p2],
      latestSkateEndTime: T0,
      moderationStatus: 'visible',
      idempotencyKey: 'post-1',
    });
    for (const [i, reportId] of reportIds.entries()) {
      const report = await t.run((ctx) => ctx.db.get(reportId));
      expect(report?.postId).toBe(postId);
      expect(report?.waterBodyId).toBe(i === 0 ? bodyA : bodyB);
    }
    // The second Report's own key is stored beside the Post's.
    const second = reportIds[1];
    if (!second) throw new Error('no second report');
    expect((await t.run((ctx) => ctx.db.get(second)))?.idempotencyKey).toBe('report-b');
    // One photo, one report: `photos.reportId` names the member that listed it.
    expect((await t.run((ctx) => ctx.db.get(p1)))?.reportId).toBe(reportIds[0]);
    expect((await t.run((ctx) => ctx.db.get(p2)))?.reportId).toBe(second);
  });

  test('a photo one member lists cannot be listed by another — one photo, one report', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const bodyId = await seedBody(t);
    const p1 = await seedPhoto(t, author.id);
    await expect(
      author.as.mutation(api.posts.create, {
        reports: [
          { ...FRESH, waterBodyId: bodyId, skateEndTime: T0, photoIds: [p1] },
          { ...FRESH, waterBodyId: bodyId, skateEndTime: T0 - 3_600_000, photoIds: [p1] },
        ],
      }),
    ).rejects.toThrow(/already belongs to another report/);
    expect(await t.run((ctx) => ctx.db.query('posts').collect())).toHaveLength(0);
  });

  test('a Post key replays to the same Post; another author reusing it is refused', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const other = await seedUser(t, 'clerk_other');
    const bodyId = await seedBody(t);
    const args = {
      idempotencyKey: 'post-retry',
      reports: [{ ...FRESH, waterBodyId: bodyId, skateEndTime: T0 }],
    };
    const first = await author.as.mutation(api.posts.create, args);
    const second = await author.as.mutation(api.posts.create, args);
    expect(second).toEqual(first);
    expect(await t.run((ctx) => ctx.db.query('posts').collect())).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query('reports').collect())).toHaveLength(1);
    await expect(other.as.mutation(api.posts.create, args)).rejects.toThrow(/Idempotency key/);
  });

  test('a Report key can never name two Reports', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const bodyId = await seedBody(t);
    const report = { ...FRESH, waterBodyId: bodyId, skateEndTime: T0, idempotencyKey: 'r-1' };
    await author.as.mutation(api.posts.create, { idempotencyKey: 'p-1', reports: [report] });
    await expect(
      author.as.mutation(api.posts.create, { idempotencyKey: 'p-2', reports: [report] }),
    ).rejects.toThrow(/Idempotency key conflict/);
  });

  test('nothing lands when a later Report fails — the first is rolled back with it', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const bodyId = await seedBody(t);
    await expect(
      author.as.mutation(api.posts.create, {
        reports: [
          { ...FRESH, waterBodyId: bodyId, skateEndTime: T0 },
          { waterBodyId: bodyId, skateEndTime: T0, notes: 'nothing observed' },
        ],
      }),
    ).rejects.toThrow(/minimum_set/);
    expect(await t.run((ctx) => ctx.db.query('posts').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('reports').collect())).toHaveLength(0);
  });

  test('the minimum set (D189) names its gaps; a hazard is an observation; a sighting needs a shore', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const bodyId = await seedBody(t);
    const gapsOf = async (report: Record<string, unknown>) => {
      try {
        await author.as.mutation(api.posts.create, {
          reports: [{ waterBodyId: bodyId, skateEndTime: T0, ...report }],
        } as never);
        return [];
      } catch (e) {
        return (e as { data?: { gaps?: string[] } }).data?.gaps ?? ['<other error>'];
      }
    };
    expect(await gapsOf({ notes: "don't skate here" })).toEqual(['howWasIt', 'observation']);
    expect(await gapsOf({ skateQuality: 'poor' })).toEqual(['observation']);
    expect(await gapsOf({ iceTypes: ['black_ice'] })).toEqual(['howWasIt']);
    expect(
      await gapsOf({
        suitability: 'dont_go',
        hazards: [
          {
            type: 'open_water',
            geometryKind: 'point_radius',
            geometry: { type: 'Point', coordinates: [0.5, 0.5] },
            radiusMeters: 40,
          },
        ],
      }),
    ).toEqual([]);
    expect(
      await gapsOf({ suitability: 'dont_go', observedFrom: 'shore', sighting: 'open' }),
    ).toEqual([]);
  });

  test('the freshness window (D199): a week is inside, a week and a minute is not, the future is not', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const bodyId = await seedBody(t);
    const now = Date.now();
    const week = 7 * 24 * 3_600_000;
    const post = (skateEndTime: number) =>
      author.as.mutation(api.posts.create, {
        reports: [{ ...FRESH, waterBodyId: bodyId, skateEndTime }],
      });
    await expect(post(now - week)).resolves.toBeTruthy();
    await expect(post(now - week - 60_000)).rejects.toThrow(/up to a week/);
    await expect(post(now + 2 * 3_600_000)).rejects.toThrow(/in the future/);
  });

  test('a Post needs a Report, takes at most POST_MAX_REPORTS, and bounds its title', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const bodyId = await seedBody(t);
    await expect(author.as.mutation(api.posts.create, { reports: [] })).rejects.toThrow(
      /at least one report/,
    );
    const one = { ...FRESH, waterBodyId: bodyId, skateEndTime: T0 };
    await expect(
      author.as.mutation(api.posts.create, { reports: Array.from({ length: 11 }, () => one) }),
    ).rejects.toThrow(/at most 10/);
    await expect(
      author.as.mutation(api.posts.create, { title: 'x'.repeat(121), reports: [one] }),
    ).rejects.toThrow(/invalid_post/);
  });

  test('reports.create is the one-Report form of the same path', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const bodyId = await seedBody(t);
    const reportId = await author.as.mutation(api.reports.create, {
      ...FRESH,
      waterBodyId: bodyId,
      skateEndTime: T0,
      idempotencyKey: 'legacy-key',
    });
    const report = await t.run((ctx) => ctx.db.get(reportId));
    const postId = report?.postId;
    if (!postId) throw new Error('report born without a Post');
    const post = await t.run((ctx) => ctx.db.get(postId));
    expect(post).toMatchObject({
      reportIds: [reportId],
      latestSkateEndTime: T0,
      idempotencyKey: 'legacy-key',
    });
    expect(post?.title).toBeUndefined();
    // The same key replays to the same Report through the Post's key.
    expect(
      await author.as.mutation(api.reports.create, {
        ...FRESH,
        waterBodyId: bodyId,
        skateEndTime: T0,
        idempotencyKey: 'legacy-key',
      }),
    ).toBe(reportId);
  });
});

describe('authors edit and delete what they shared (A10-3)', () => {
  const FRESH = { suitability: 'experienced_only' as const, surfaceTags: ['glass' as const] };

  async function twoLakePost(t: ReturnType<typeof convexTest>) {
    const author = await seedUser(t, 'clerk_author');
    const bodyA = await seedBody(t);
    const bodyB = await seedBody(t);
    const { postId, reportIds } = await author.as.mutation(api.posts.create, {
      title: 'Two lakes',
      body: 'Glass on both.',
      reports: [
        { ...FRESH, waterBodyId: bodyA, skateEndTime: T0 - 3_600_000 },
        { ...FRESH, waterBodyId: bodyB, skateEndTime: T0 },
      ],
    });
    return { author, bodyA, bodyB, postId, reportIds: reportIds as [Id<'reports'>, Id<'reports'>] };
  }

  test('posts.update rewrites the words, stamps editedAt, and keeps what they were', async () => {
    const t = convexTest(schema, modules);
    const { author, postId } = await twoLakePost(t);
    await author.as.mutation(api.posts.update, {
      postId,
      title: ' Two lakes, revised ',
      body: undefined,
    });
    const post = await t.run((ctx) => ctx.db.get(postId));
    expect(post).toMatchObject({ title: 'Two lakes, revised' });
    expect(post?.body).toBeUndefined(); // last-write-wins: an omitted field is a cleared one
    expect(post?.editedAt).toBeDefined();
    const revisions = await t.run((ctx) =>
      ctx.db
        .query('contentRevisions')
        .withIndex('by_target', (q) => q.eq('targetType', 'post').eq('targetId', postId))
        .collect(),
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.snapshot).toEqual({ title: 'Two lakes', body: 'Glass on both.' });
    expect(revisions[0]?.authorId).toBe(author.id);
  });

  test('posts.update refuses a stranger, a moderated Post, and a title past its bound', async () => {
    const t = convexTest(schema, modules);
    const { author, postId } = await twoLakePost(t);
    const stranger = await seedUser(t, 'clerk_stranger');
    await expect(
      stranger.as.mutation(api.posts.update, { postId, title: 'Mine now' }),
    ).rejects.toThrow(/Only the author/);
    await expect(
      author.as.mutation(api.posts.update, { postId, title: 'x'.repeat(200) }),
    ).rejects.toThrow(/invalid_post/);
    await t.run((ctx) => ctx.db.patch(postId, { moderationStatus: 'hidden' }));
    await expect(author.as.mutation(api.posts.update, { postId, title: 'Still' })).rejects.toThrow(
      /moderated/,
    );
  });

  test('reports.update keeps the content block as it stood, once per edit', async () => {
    const t = convexTest(schema, modules);
    const { author, reportIds } = await twoLakePost(t);
    const [reportId] = reportIds;
    await author.as.mutation(api.reports.update, {
      ...FRESH,
      reportId,
      skateEndTime: T0 - 3_600_000,
      notes: 'Actually it was shell ice at the north end.',
      iceTypes: [{ type: 'shell_ice', where: { sector: 'N' } }],
    });
    await author.as.mutation(api.reports.update, {
      ...FRESH,
      reportId,
      skateEndTime: T0 - 3_600_000,
      notes: 'Third thoughts.',
    });
    const revisions = await t.run((ctx) =>
      ctx.db
        .query('contentRevisions')
        .withIndex('by_target', (q) => q.eq('targetType', 'report').eq('targetId', reportId))
        .collect(),
    );
    expect(revisions.map((r) => r.snapshot)).toEqual([
      expect.objectContaining({
        surfaceTags: [{ type: 'glass' }],
        iceTypes: [],
        suitability: 'experienced_only',
      }),
      expect.objectContaining({
        notes: 'Actually it was shell ice at the north end.',
        iceTypes: [{ type: 'shell_ice', where: { sector: 'N' } }],
      }),
    ]);
    // Stamps never travel in a snapshot.
    expect(revisions[0]?.snapshot).not.toHaveProperty('authorId');
    expect(revisions[0]?.snapshot).not.toHaveProperty('moderationStatus');
    expect(revisions[0]?.snapshot).not.toHaveProperty('place');
  });

  test('reports.update carries its Post’s words in the same edit — both halves, one history row each', async () => {
    const t = convexTest(schema, modules);
    const { author, postId, reportIds } = await twoLakePost(t);
    const [reportId] = reportIds;
    await author.as.mutation(api.reports.update, {
      ...FRESH,
      reportId,
      skateEndTime: T0 - 3_600_000,
      notes: 'Shell ice by the north shore.',
      post: { title: 'Two lakes, revised', body: 'Glass on one.' },
    });
    expect(await t.run((ctx) => ctx.db.get(reportId))).toMatchObject({
      notes: 'Shell ice by the north shore.',
    });
    const post = await t.run((ctx) => ctx.db.get(postId));
    expect(post).toMatchObject({ title: 'Two lakes, revised', body: 'Glass on one.' });
    expect(post?.editedAt).toBeDefined();
    const history = await t.run((ctx) => ctx.db.query('contentRevisions').collect());
    expect(history.map((r) => r.targetType).sort()).toEqual(['post', 'report']);
  });

  test('a refusal of either half lands neither — the Report edit rolls back with its Post’s words', async () => {
    const t = convexTest(schema, modules);
    const { author, postId, reportIds } = await twoLakePost(t);
    const [reportId] = reportIds;
    const edit = (post: { title?: string; body?: string }) =>
      author.as.mutation(api.reports.update, {
        ...FRESH,
        reportId,
        skateEndTime: T0 - 3_600_000,
        notes: 'This should not land.',
        post,
      });
    await expect(edit({ title: 'x'.repeat(200) })).rejects.toThrow(/invalid_post/);
    // A Post taken down on its own (the Report still visible): the edit is refused whole.
    await t.run((ctx) => ctx.db.patch(postId, { moderationStatus: 'hidden' }));
    await expect(edit({ title: 'Still' })).rejects.toThrow(/moderated/);
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.notes).not.toBe('This should not land.');
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.editedAt).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query('contentRevisions').collect())).toEqual([]);
  });

  test('words re-sent unchanged write nothing — no history row, no edited mark on the Post', async () => {
    const t = convexTest(schema, modules);
    const { author, postId, reportIds } = await twoLakePost(t);
    const [reportId] = reportIds;
    await author.as.mutation(api.reports.update, {
      ...FRESH,
      reportId,
      skateEndTime: T0 - 3_600_000,
      notes: 'Only the chips changed.',
      post: { title: ' Two lakes ', body: 'Glass on both.' },
    });
    expect((await t.run((ctx) => ctx.db.get(postId)))?.editedAt).toBeUndefined();
    const history = await t.run((ctx) => ctx.db.query('contentRevisions').collect());
    expect(history.map((r) => r.targetType)).toEqual(['report']);
  });

  test('Post words on a Report with no Post are refused, not dropped', async () => {
    const t = convexTest(schema, modules);
    const { author, reportIds } = await twoLakePost(t);
    const [reportId] = reportIds;
    // A Report the Post backfill has not reached — the only kind without a `postId`.
    await t.run((ctx) => ctx.db.patch(reportId, { postId: undefined }));
    await expect(
      author.as.mutation(api.reports.update, {
        ...FRESH,
        reportId,
        skateEndTime: T0 - 3_600_000,
        post: { title: 'Nowhere to go' },
      }),
    ).rejects.toThrow(/no post to edit/);
  });

  test('deleting one Report removes it, keeps the Post; deleting the last removes the Post too', async () => {
    const t = convexTest(schema, modules);
    const { author, postId, reportIds, bodyA } = await twoLakePost(t);
    const [first, second] = reportIds;
    const stranger = await seedUser(t, 'clerk_stranger');
    await expect(stranger.as.mutation(api.reports.remove, { reportId: first })).rejects.toThrow(
      /Only the author/,
    );

    await author.as.mutation(api.reports.remove, { reportId: first });
    expect((await t.run((ctx) => ctx.db.get(first)))?.moderationStatus).toBe('removed');
    expect((await t.run((ctx) => ctx.db.get(postId)))?.moderationStatus).toBe('visible');
    // The Post's sort key follows its visible members, and the author's count moves.
    expect((await t.run((ctx) => ctx.db.get(postId)))?.latestSkateEndTime).toBe(T0);
    expect((await t.run((ctx) => ctx.db.get(author.id)))?.reportCount).toBe(1);
    const cardA = await t.query(api.reports.listByWaterBody, {
      waterBodyId: bodyA,
      paginationOpts: { numItems: 5, cursor: null },
    });
    expect(cardA.page).toHaveLength(0);

    await author.as.mutation(api.reports.remove, { reportId: second });
    expect((await t.run((ctx) => ctx.db.get(postId)))?.moderationStatus).toBe('removed');
    const actions = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) => q.eq('targetType', 'post').eq('targetId', postId))
        .collect(),
    );
    // Exactly one row on the Post, the author's own — never a `hide` in their name from the
    // derived-visibility rule running first, and the prior status is what the Post really was.
    expect(actions.map((a) => a.action)).toEqual(['author_delete']);
    expect(actions[0]).toMatchObject({
      actorId: author.id,
      metadata: { priorStatus: 'visible', newStatus: 'removed', derivedFromReportId: second },
    });
    // Idempotent: deleting again changes nothing and writes nothing.
    await author.as.mutation(api.reports.remove, { reportId: second });
    const again = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) => q.eq('targetType', 'report').eq('targetId', second))
        .collect(),
    );
    expect(again.filter((a) => a.action === 'author_delete')).toHaveLength(1);
  });

  test('deleting a Post removes every member with the cascade named, and leaves the feed', async () => {
    const t = convexTest(schema, modules);
    const { author, postId, reportIds } = await twoLakePost(t);
    const stranger = await seedUser(t, 'clerk_stranger');
    await expect(stranger.as.mutation(api.posts.remove, { postId })).rejects.toThrow(
      /Only the author/,
    );

    await author.as.mutation(api.posts.remove, { postId });
    expect((await t.run((ctx) => ctx.db.get(postId)))?.moderationStatus).toBe('removed');
    for (const id of reportIds) {
      expect((await t.run((ctx) => ctx.db.get(id)))?.moderationStatus).toBe('removed');
      const actions = await t.run((ctx) =>
        ctx.db
          .query('moderationActions')
          .withIndex('by_target', (q) => q.eq('targetType', 'report').eq('targetId', id))
          .collect(),
      );
      expect(actions[0]).toMatchObject({
        action: 'author_delete',
        actorId: author.id,
        metadata: { cascadedFromPostId: postId },
      });
    }
    const feed = await author.as.query(api.posts.listFeed, {
      paginationOpts: { numItems: 5, cursor: null },
    });
    expect(feed.page).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.get(author.id)))?.reportCount).toBe(0);
  });
});

describe('a flagged Post is triageable (A10 / D186)', () => {
  test('the queue resolves the Post to its author and its title, or its prose, or "Post"', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const flagger = await seedUser(t, 'clerk_flagger');
    const mod = await seedUser(t, 'clerk_mod');
    await t.run((ctx) => ctx.db.patch(mod.id, { role: 'moderator' }));
    const bodyId = await seedBody(t);
    const FRESH = { suitability: 'experienced_only' as const, surfaceTags: ['glass' as const] };
    const make = (post: { title?: string; body?: string }) =>
      author.as.mutation(api.posts.create, {
        ...post,
        reports: [{ ...FRESH, waterBodyId: bodyId, skateEndTime: T0 }],
      });
    const titled = (await make({ title: 'Morey 1/10', body: 'Glass.' })).postId;
    const prose = (await make({ body: 'A long paragraph about the north bay and the wind.' }))
      .postId;
    const bare = (await make({})).postId;
    for (const targetId of [titled, prose, bare]) {
      await flagger.as.mutation(api.contentFlags.flag, {
        targetType: 'post',
        targetId,
        reason: 'spam',
      });
    }
    const { priority, standard } = await mod.as.query(api.moderation.listFlags, {});
    const rows = [...priority, ...standard];
    const summary = (id: Id<'posts'>) => rows.find((f) => f.targetId === id)?.target;
    expect(summary(titled)).toMatchObject({ exists: true, summary: 'Morey 1/10' });
    expect(summary(titled)?.author?.username).toBe('clerk_author');
    expect(summary(prose)?.summary).toBe('A long paragraph about the north bay and the wind.');
    expect(summary(bare)?.summary).toBe('Post');
  });
});

describe('posts.listFeed — a Post feed with per-Report filters (A10 §2.4)', () => {
  const FRESH = { suitability: 'experienced_only' as const, surfaceTags: ['glass' as const] };
  const ALL = { paginationOpts: { numItems: 50, cursor: null } };

  test('a filter shows the Post with only its matching members and counts the rest; none matching ⇒ no Post', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const bodyA = await seedBody(t);
    const bodyB = await seedBody(t);
    const { postId, reportIds } = await author.as.mutation(api.posts.create, {
      title: 'Two lakes',
      reports: [
        { ...FRESH, waterBodyId: bodyA, skateEndTime: T0 - 3_600_000, skateQuality: 'great' },
        { ...FRESH, waterBodyId: bodyB, skateEndTime: T0, skateQuality: 'poor' },
      ],
    });
    const whole = await t.query(api.posts.listFeed, ALL);
    expect(whole.page).toHaveLength(1);
    expect(whole.page[0]).toMatchObject({ postId, title: 'Two lakes', omittedCount: 0 });
    expect(whole.page[0]?.reports.map((r) => r.reportId)).toEqual(reportIds);
    expect(whole.page[0]?.latestSkateEndTime).toBe(T0);

    const narrowed = await t.query(api.posts.listFeed, {
      ...ALL,
      filters: { qualityFloor: 'good' },
    });
    expect(narrowed.page).toHaveLength(1);
    expect(narrowed.page[0]?.reports.map((r) => r.reportId)).toEqual([reportIds[0]]);
    expect(narrowed.page[0]?.omittedCount).toBe(1);

    const none = await t.query(api.posts.listFeed, {
      ...ALL,
      filters: { thicknessFloorCm: 1, qualityFloor: 'great', recencyHours: 1 },
    });
    expect(none.page).toEqual([]);
  });

  test('a member a moderator hid is neither shown nor counted; the Post keeps its prose', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const mod = await seedUser(t, 'clerk_mod');
    await t.run((ctx) => ctx.db.patch(mod.id, { role: 'moderator' }));
    const bodyA = await seedBody(t);
    const bodyB = await seedBody(t);
    const { reportIds } = await author.as.mutation(api.posts.create, {
      body: 'The prose survives a member going.',
      reports: [
        { ...FRESH, waterBodyId: bodyA, skateEndTime: T0 - 3_600_000 },
        { ...FRESH, waterBodyId: bodyB, skateEndTime: T0 },
      ],
    });
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: reportIds[1] as Id<'reports'>,
      status: 'hidden',
      reason: 'wrong lake',
    });
    const feed = await t.query(api.posts.listFeed, ALL);
    expect(feed.page).toHaveLength(1);
    expect(feed.page[0]).toMatchObject({
      body: 'The prose survives a member going.',
      omittedCount: 0,
      latestSkateEndTime: T0 - 3_600_000,
    });
    expect(feed.page[0]?.reports.map((r) => r.reportId)).toEqual([reportIds[0]]);
  });
});

describe('posts.getForReport (A10 §12.1) — the words a Report was posted with, and its other lakes', () => {
  const FRESH = { suitability: 'experienced_only' as const, surfaceTags: ['glass' as const] };

  test('returns the title, the prose and the visible siblings; null for a hidden Post', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const mod = await seedUser(t, 'clerk_mod');
    await t.run((ctx) => ctx.db.patch(mod.id, { role: 'moderator' }));
    const bodyA = await seedBody(t);
    const bodyB = await seedBody(t);
    const { postId, reportIds } = await author.as.mutation(api.posts.create, {
      title: 'Two lakes',
      body: 'Morey first, then the pond.',
      reports: [
        { ...FRESH, waterBodyId: bodyA, skateEndTime: T0 - 3_600_000 },
        { ...FRESH, waterBodyId: bodyB, skateEndTime: T0 },
      ],
    });
    const [first, second] = reportIds;
    if (!first || !second) throw new Error('seed');
    const forFirst = await t.query(api.posts.getForReport, { reportId: first });
    expect(forFirst).toMatchObject({
      postId,
      title: 'Two lakes',
      body: 'Morey first, then the pond.',
    });
    expect(forFirst?.siblings.map((s) => s.reportId)).toEqual([second]);
    // A hidden sibling is not offered.
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'report',
      targetId: second,
      status: 'hidden',
      reason: 'wrong lake',
    });
    expect((await t.query(api.posts.getForReport, { reportId: first }))?.siblings).toEqual([]);
    // And the hidden Report's own id is not a handle to the Post's words.
    expect(await t.query(api.posts.getForReport, { reportId: second })).toBeNull();
    // A hidden Post is null, words included.
    await mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'post',
      targetId: postId,
      status: 'hidden',
      reason: 'spam',
    });
    expect(await t.query(api.posts.getForReport, { reportId: first })).toBeNull();
  });

  test('reports.get names the bays a chip’s where points at', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const bodyId = await seedBody(t);
    const bayId = await t.run((ctx) =>
      ctx.db.insert('waterBodySubAreas', {
        waterBodyId: bodyId,
        name: 'North Bay',
        searchText: 'north bay',
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
        surfaceAreaSqM: 100_000,
        displayScore: 1,
        minVisibleZoom: 10,
        createdByUserId: author.id,
        createdAt: T0,
        updatedAt: T0,
      }),
    );
    const reportId = await author.as.mutation(api.reports.create, {
      ...FRESH,
      waterBodyId: bodyId,
      skateEndTime: T0,
      iceTypes: [{ type: 'black_ice', where: { sector: 'N', subAreaId: bayId } }],
    });
    const report = await t.query(api.reports.get, { reportId });
    expect(report?.bayNames).toEqual({ [bayId]: 'North Bay' });
  });
});

describe('the silhouette on a card (A10 §12.3)', () => {
  const FRESH = { suitability: 'experienced_only' as const, surfaceTags: ['glass' as const] };
  const ALL = { paginationOpts: { numItems: 50, cursor: null } };
  const track = {
    type: 'LineString' as const,
    // ~0.6° across a 1° square — long enough that D58's clip leaves a middle.
    coordinates: Array.from({ length: 40 }, (_, i) => [0.2 + i * 0.015, 0.5]) as number[][],
  };

  test('carries the outline, the apex, the put-in, the skate, the chips’ sector and the bay ring', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const bodyId = await seedBody(t);
    const bayId = await t.run((ctx) =>
      ctx.db.insert('waterBodySubAreas', {
        waterBodyId: bodyId,
        name: 'North Bay',
        searchText: 'north bay',
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
        surfaceAreaSqM: 100_000,
        displayScore: 1,
        minVisibleZoom: 10,
        createdByUserId: author.id,
        createdAt: T0,
        updatedAt: T0,
      }),
    );
    const activityId = await author.as.mutation(api.gpsActivities.ingestTrack, {
      idempotencyKey: 'session-1',
      path: track,
      startTime: T0 - 3_600_000,
      endTime: T0,
      elapsedSeconds: 3_600,
    });
    await author.as.mutation(api.posts.create, {
      reports: [
        {
          ...FRESH,
          waterBodyId: bodyId,
          skateEndTime: T0,
          activityId,
          point: { lat: 0.5, lng: 0.2 },
          iceTypes: [{ type: 'black_ice', where: { sector: 'N', subAreaId: bayId } }],
        },
      ],
    });
    const feed = await author.as.query(api.posts.listFeed, ALL);
    const card = feed.page[0]?.reports[0];
    const s = card?.silhouette;
    expect(s).toBeDefined();
    expect(s?.rings[0]?.length).toBe(5); // the square, whole
    expect(s?.bbox).toEqual({ minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 });
    expect(s?.origin.lat).toBeGreaterThan(0);
    expect(s?.putIn).toEqual({ lat: 0.5, lng: 0.2 });
    expect(s?.path?.[0]).toEqual([0.2, 0.5]); // whole: the author sees their own put-in
    expect(s?.sector).toBe('N');
    expect(s?.bayRing?.length).toBe(5);
  });

  test('a withheld put-in drops the pin and trims the skate for a stranger, not for the author', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const stranger = await seedUser(t, 'clerk_stranger');
    const bodyId = await seedBody(t);
    const activityId = await author.as.mutation(api.gpsActivities.ingestTrack, {
      idempotencyKey: 'session-2',
      path: track,
      startTime: T0 - 3_600_000,
      endTime: T0,
      elapsedSeconds: 3_600,
    });
    await author.as.mutation(api.posts.create, {
      reports: [
        {
          ...FRESH,
          waterBodyId: bodyId,
          skateEndTime: T0,
          activityId,
          point: { lat: 0.5, lng: 0.2 },
          showPutIn: false,
        },
      ],
    });
    const mine = (await author.as.query(api.posts.listFeed, ALL)).page[0]?.reports[0]?.silhouette;
    expect(mine?.putIn).toEqual({ lat: 0.5, lng: 0.2 });
    expect(mine?.path?.[0]).toEqual([0.2, 0.5]);
    const theirs = (await stranger.as.query(api.posts.listFeed, ALL)).page[0]?.reports[0]
      ?.silhouette;
    expect(theirs?.putIn).toBeUndefined();
    expect(theirs?.path).toBeDefined();
    expect(theirs?.path?.[0]).not.toEqual([0.2, 0.5]); // the ends are trimmed (D58)
    expect(theirs?.sector).toBeUndefined();
    expect(theirs?.bayRing).toBeUndefined();
  });
});

describe('text search over Latest (B03 §11, board 4.9)', () => {
  const FRESH = { suitability: 'experienced_only' as const, surfaceTags: ['glass' as const] };
  const FIRST = { paginationOpts: { numItems: 20, cursor: null } };
  const ids = (result: { page: { postId: string }[] }) => result.page.map((p) => p.postId);

  /** A Post with these words. Every Post in these tests has some: see the harness note below. */
  async function post(
    author: Awaited<ReturnType<typeof seedUser>>,
    waterBodyId: Id<'waterBodies'>,
    words: { title?: string; body?: string; notes?: string; skateEndTime?: number },
  ) {
    const { notes, skateEndTime, ...post } = words;
    return author.as.mutation(api.posts.create, {
      ...post,
      reports: [
        {
          ...FRESH,
          waterBodyId,
          skateEndTime: skateEndTime ?? T0,
          ...(notes !== undefined ? { notes } : {}),
        },
      ],
    });
  }

  // convex-test's search throws on a row with no `searchText` (`undefined.split`), where the real
  // index simply doesn't hold it. So no test here searches over a Post with no words.

  test('finds a word in the title, the prose and every note an author typed', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const waterBodyId = await seedBody(t);
    const inTitle = await post(author, waterBodyId, { title: 'Lead at the Narrows' });
    const inBody = await post(author, waterBodyId, { body: 'Skirted the narrows by the bridge.' });
    const inNotes = await post(author, waterBodyId, { notes: 'Narrows was open.' });
    const inChips = await author.as.mutation(api.posts.create, {
      title: 'Morey',
      reports: [
        {
          suitability: 'experienced_only',
          waterBodyId,
          skateEndTime: T0,
          iceTypes: [{ type: 'black_ice', note: 'narrows looked gray' }],
          surfaceTags: [{ type: 'glass', note: 'smooth past the narrows' }],
          iceThickness: {
            readings: [{ valueCm: 13, method: 'measured', note: 'drilled at the narrows' }],
          },
        },
      ],
    });
    await post(author, waterBodyId, { title: 'The north basin' });

    const found = await t.query(api.posts.searchFeed, { query: 'narrows', ...FIRST });
    expect(new Set(ids(found))).toEqual(
      new Set([inTitle.postId, inBody.postId, inNotes.postId, inChips.postId]),
    );
    expect(found).toMatchObject({ matched: 4, truncated: false, isDone: true });
  });

  test('a blank query finds nothing, without reading anything', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    await post(author, await seedBody(t), { title: 'Narrows' });
    expect(await t.query(api.posts.searchFeed, { query: '   ', ...FIRST })).toEqual({
      page: [],
      isDone: true,
      continueCursor: '',
      matched: 0,
      truncated: false,
    });
  });

  test('a term no Post mentions is an empty, finished list', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    await post(author, await seedBody(t), { title: 'Narrows' });
    expect(await t.query(api.posts.searchFeed, { query: 'zamboni', ...FIRST })).toMatchObject({
      page: [],
      isDone: true,
      matched: 0,
    });
  });

  test('reads newest skate first and pages through without repeats', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const waterBodyId = await seedBody(t);
    const posted: Id<'posts'>[] = [];
    // Created oldest-last, so neither insertion order nor relevance could pass for skate time.
    for (const hoursAgo of [5, 1, 3, 2, 4]) {
      const { postId } = await post(author, waterBodyId, {
        title: 'Narrows',
        skateEndTime: T0 - hoursAgo * 3_600_000,
      });
      posted[hoursAgo] = postId;
    }
    const pageOf = (cursor: string | null) =>
      t.query(api.posts.searchFeed, {
        query: 'narrows',
        paginationOpts: { numItems: 2, cursor },
      });
    const first = await pageOf(null);
    expect(ids(first)).toEqual([posted[1], posted[2]]);
    expect(first.isDone).toBe(false);
    const second = await pageOf(first.continueCursor);
    expect(ids(second)).toEqual([posted[3], posted[4]]);
    const third = await pageOf(second.continueCursor);
    expect(ids(third)).toEqual([posted[5]]);
    expect(third.isDone).toBe(true);
  });

  test('a Post leaving the matches mid-scroll does not start the list over', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const waterBodyId = await seedBody(t);
    const newest = await post(author, waterBodyId, { title: 'Narrows', skateEndTime: T0 });
    const older = await post(author, waterBodyId, {
      title: 'Narrows',
      skateEndTime: T0 - 3_600_000,
    });
    const first = await t.query(api.posts.searchFeed, {
      query: 'narrows',
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(ids(first)).toEqual([newest.postId]);
    await author.as.mutation(api.posts.update, { postId: newest.postId, title: 'Renamed' });
    const next = await t.query(api.posts.searchFeed, {
      query: 'narrows',
      paginationOpts: { numItems: 1, cursor: first.continueCursor },
    });
    expect(ids(next)).toEqual([older.postId]);
    // And a cursor past the end is the end, not the beginning.
    const past = await t.query(api.posts.searchFeed, {
      query: 'narrows',
      paginationOpts: { numItems: 1, cursor: next.continueCursor },
    });
    expect(past).toMatchObject({ page: [], isDone: true });
  });

  test('says when the cap cut the matches short (D5)', async () => {
    const t = convexTest(schema, modules);
    const authorId = await seedProfile(t, 'clerk_author');
    await t.run(async (ctx) => {
      for (let i = 0; i < 101; i++) {
        await ctx.db.insert('posts', {
          authorId,
          searchText: 'narrows',
          reportIds: [],
          photoIds: [],
          latestSkateEndTime: T0 - i,
          moderationStatus: 'visible',
          createdAt: T0,
          updatedAt: T0,
        });
      }
    });
    const found = await t.query(api.posts.searchFeed, {
      query: 'narrows',
      paginationOpts: { numItems: 5, cursor: null },
    });
    expect(found).toMatchObject({ matched: 100, truncated: true, isDone: false });
  });

  test('filters still apply, per member, as they do on the feed', async () => {
    const t = convexTest(schema, modules);
    const author = await seedUser(t, 'clerk_author');
    const waterBodyId = await seedBody(t);
    const { postId, reportIds } = await author.as.mutation(api.posts.create, {
      title: 'Narrows',
      reports: [
        { ...FRESH, waterBodyId, skateEndTime: T0 - 3_600_000, skateQuality: 'great' },
        { ...FRESH, waterBodyId, skateEndTime: T0, skateQuality: 'poor' },
      ],
    });
    const found = await t.query(api.posts.searchFeed, {
      query: 'narrows',
      ...FIRST,
      filters: { qualityFloor: 'good' },
    });
    expect(ids(found)).toEqual([postId]);
    expect(found.page[0]?.reports.map((r) => r.reportId)).toEqual([reportIds[0]]);
    expect(found.page[0]?.omittedCount).toBe(1);
  });

  describe('the same visibility as listFeed', () => {
    async function moderator(t: ReturnType<typeof convexTest>) {
      const mod = await seedUser(t, 'clerk_mod');
      await t.run((ctx) => ctx.db.patch(mod.id, { role: 'moderator' }));
      return mod;
    }

    test('a hidden member’s words stop matching and come back when it is restored', async () => {
      const t = convexTest(schema, modules);
      const author = await seedUser(t, 'clerk_author');
      const mod = await moderator(t);
      const waterBodyId = await seedBody(t);
      const { postId, reportIds } = await author.as.mutation(api.posts.create, {
        title: 'Two stops',
        reports: [
          { ...FRESH, waterBodyId, skateEndTime: T0, notes: 'launched behind the marina' },
          { ...FRESH, waterBodyId, skateEndTime: T0, notes: 'north basin was glass' },
        ],
      });
      const search = (query: string) => t.query(api.posts.searchFeed, { query, ...FIRST });
      const setStatus = (status: 'hidden' | 'visible') =>
        mod.as.mutation(api.moderation.setModerationStatus, {
          targetType: 'report',
          targetId: reportIds[0] as Id<'reports'>,
          status,
          reason: 'names a private dock',
        });

      await setStatus('hidden');
      expect(ids(await search('marina'))).toEqual([]);
      // The Post still shows on its other member, and is found by the words that are still public.
      expect(ids(await search('basin'))).toEqual([postId]);

      await setStatus('visible');
      expect(ids(await search('marina'))).toEqual([postId]);
    });

    test('a hidden or removed Post is not found', async () => {
      const t = convexTest(schema, modules);
      const author = await seedUser(t, 'clerk_author');
      const mod = await moderator(t);
      const waterBodyId = await seedBody(t);
      const hidden = await post(author, waterBodyId, { title: 'Narrows' });
      const removed = await post(author, waterBodyId, { title: 'Narrows again' });
      await mod.as.mutation(api.moderation.setModerationStatus, {
        targetType: 'post',
        targetId: hidden.postId,
        status: 'hidden',
        reason: 'x',
      });
      await author.as.mutation(api.posts.remove, { postId: removed.postId });
      expect(ids(await t.query(api.posts.searchFeed, { query: 'narrows', ...FIRST }))).toEqual([]);
    });

    test('a Post on a body a takedown removed is dropped, as on the feed', async () => {
      const t = convexTest(schema, modules);
      const author = await seedUser(t, 'clerk_author');
      const waterBodyId = await seedBody(t);
      await post(author, waterBodyId, { title: 'Narrows' });
      await t.run((ctx) =>
        ctx.db.patch(waterBodyId, { removedAt: T0, removalReason: 'landowner_request' }),
      );
      expect(ids(await t.query(api.posts.searchFeed, { query: 'narrows', ...FIRST }))).toEqual([]);
    });

    test('a block never hides a report (D3): found both ways, and marked', async () => {
      const t = convexTest(schema, modules);
      const author = await seedUser(t, 'clerk_author');
      const blocker = await seedUser(t, 'clerk_blocker');
      const blocked = await seedUser(t, 'clerk_blocked');
      const waterBodyId = await seedBody(t);
      const { postId } = await post(author, waterBodyId, { title: 'Narrows' });
      await blocker.as.mutation(api.blocks.block, { targetUserId: author.id });
      await author.as.mutation(api.blocks.block, { targetUserId: blocked.id });
      for (const viewer of [blocker, blocked]) {
        const found = await viewer.as.query(api.posts.searchFeed, { query: 'narrows', ...FIRST });
        expect(ids(found)).toEqual([postId]);
        expect(found.page[0]?.blocked).toBe(true);
      }
    });

    test('a private author’s reports are public (D13), so they are found', async () => {
      const t = convexTest(schema, modules);
      const author = await seedUser(t, 'clerk_author');
      const { postId } = await post(author, await seedBody(t), { title: 'Narrows' });
      await t.run((ctx) => ctx.db.patch(author.id, { profileVisibility: 'private' }));
      expect(ids(await t.query(api.posts.searchFeed, { query: 'narrows', ...FIRST }))).toEqual([
        postId,
      ]);
    });
  });

  describe('the words stay current', () => {
    test('an edit of the Post or a Report replaces what can be found', async () => {
      const t = convexTest(schema, modules);
      const author = await seedUser(t, 'clerk_author');
      const waterBodyId = await seedBody(t);
      const { postId, reportIds } = await post(author, waterBodyId, {
        title: 'Narrows',
        notes: 'marina side',
      });
      const search = (query: string) => t.query(api.posts.searchFeed, { query, ...FIRST });

      await author.as.mutation(api.posts.update, { postId, title: 'Bridge' });
      expect(ids(await search('narrows'))).toEqual([]);
      expect(ids(await search('bridge'))).toEqual([postId]);

      await author.as.mutation(api.reports.update, {
        ...FRESH,
        reportId: reportIds[0] as Id<'reports'>,
        skateEndTime: T0,
        notes: 'boat ramp side',
      });
      expect(ids(await search('marina'))).toEqual([]);
      expect(ids(await search('ramp'))).toEqual([postId]);
    });

    test('words that did not change write nothing to the field', async () => {
      const t = convexTest(schema, modules);
      const author = await seedUser(t, 'clerk_author');
      const { postId } = await post(author, await seedBody(t), { title: 'Narrows' });
      const before = await t.run((ctx) => ctx.db.get(postId));
      await t.mutation(internal.posts.backfillSearchText, {});
      expect(await t.run((ctx) => ctx.db.get(postId))).toEqual(before);
    });

    test('postSearchText reads only visible members, and nothing typed means no field', () => {
      const member = (fields: Partial<Doc<'reports'>>) =>
        ({
          moderationStatus: 'visible',
          iceTypes: [],
          surfaceTags: [],
          ...fields,
        }) as Doc<'reports'>;
      expect(postSearchText({}, [member({})])).toBeUndefined();
      expect(
        postSearchText({ title: 'T', body: 'B' }, [
          member({ notes: 'shown' }),
          member({ notes: 'held back', moderationStatus: 'hidden' }),
        ]),
      ).toBe('T\nB\nshown');
      // A sighting chip's note is typed prose like the others (D210), and the purge clears it too.
      expect(
        postSearchText({}, [member({ sightings: [{ type: 'open', note: 'lead by the dam' }] })]),
      ).toBe('lead by the dam');
    });
  });

  describe('the backfill', () => {
    test('gives every existing Post its words, and a wordless one no field', async () => {
      const t = convexTest(schema, modules);
      const authorId = await seedProfile(t);
      const waterBodyId = await seedBody(t);
      const worded = await seedLegacyReport(t, authorId, waterBodyId, {
        notes: 'old narrows note',
      });
      const wordless = await seedLegacyReport(t, authorId, waterBodyId);
      await t.mutation(internal.posts.backfillFromReports, {});
      // As a deployment holds them today: before this field existed.
      const [wordedPost, wordlessPost] = await t.run(async (ctx) => {
        const a = (await ctx.db.get(worded))?.postId as Id<'posts'>;
        const b = (await ctx.db.get(wordless))?.postId as Id<'posts'>;
        expect((await ctx.db.get(a))?.searchText).toBe('old narrows note');
        await ctx.db.patch(a, { searchText: undefined });
        return [a, b];
      });

      await t.mutation(internal.posts.backfillSearchText, {});
      const rows = await t.run(async (ctx) => [
        await ctx.db.get(wordedPost),
        await ctx.db.get(wordlessPost),
      ]);
      expect(rows[0]?.searchText).toBe('old narrows note');
      expect(rows[1]?.searchText).toBeUndefined();
    });

    test('takes another pass until it has read every Post', async () => {
      const t = convexTest(schema, modules);
      const authorId = await seedProfile(t);
      await t.run(async (ctx) => {
        for (let i = 0; i < 101; i++) {
          await ctx.db.insert('posts', {
            authorId,
            title: 'Narrows',
            reportIds: [],
            photoIds: [],
            latestSkateEndTime: T0,
            moderationStatus: 'visible',
            createdAt: T0,
            updatedAt: T0,
          });
        }
      });
      await t.mutation(internal.posts.backfillSearchText, {});
      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
      const rows = await t.run((ctx) => ctx.db.query('posts').collect());
      expect(rows.every((row) => row.searchText === 'Narrows')).toBe(true);
    });
  });
});

describe('the skater filter on Latest (B03 §11, board 4.8)', () => {
  const FRESH = { suitability: 'experienced_only' as const, surfaceTags: ['glass' as const] };
  const FIRST = { paginationOpts: { numItems: 20, cursor: null } };
  const ids = (result: { page: { postId: string }[] }) => result.page.map((p) => p.postId);

  async function twoSkaters(t: ReturnType<typeof convexTest>) {
    const ada = await seedUser(t, 'ada');
    const bob = await seedUser(t, 'bob');
    const waterBodyId = await seedBody(t);
    const write = (who: typeof ada, skateEndTime = T0) =>
      who.as.mutation(api.posts.create, {
        reports: [{ ...FRESH, waterBodyId, skateEndTime }],
      });
    const adas = await write(ada);
    const bobs = await write(bob);
    return { ada, bob, waterBodyId, write, adas: adas.postId, bobs: bobs.postId };
  }

  test('lists only that skater’s Posts, however the handle is typed', async () => {
    const t = convexTest(schema, modules);
    const { adas } = await twoSkaters(t);
    for (const skater of ['ada', ' ADA ']) {
      const feed = await t.query(api.posts.listFeed, { ...FIRST, skater });
      expect(ids(feed)).toEqual([adas]);
      expect(feed).not.toHaveProperty('skaterUnavailable');
    }
  });

  test('without it the feed is what it was; blank is the same as absent', async () => {
    const t = convexTest(schema, modules);
    const { adas, bobs } = await twoSkaters(t);
    const absent = await t.query(api.posts.listFeed, FIRST);
    expect(new Set(ids(absent))).toEqual(new Set([adas, bobs]));
    expect(absent).not.toHaveProperty('skaterUnavailable');
    expect(
      Object.keys(await t.query(api.posts.listFeed, { ...FIRST, skater: '  ' })).sort(),
    ).toEqual(Object.keys(absent).sort());
  });

  test('pages through one skater’s Posts, newest first', async () => {
    const t = convexTest(schema, modules);
    const { ada, write, adas } = await twoSkaters(t);
    const older = (await write(ada, T0 - 3_600_000)).postId;
    const first = await t.query(api.posts.listFeed, {
      skater: 'ada',
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(ids(first)).toEqual([adas]);
    const second = await t.query(api.posts.listFeed, {
      skater: 'ada',
      paginationOpts: { numItems: 1, cursor: first.continueCursor },
    });
    expect(ids(second)).toEqual([older]);
  });

  test('a hidden Post stays out of the skater’s list, and filters still apply', async () => {
    const t = convexTest(schema, modules);
    const { ada, adas, waterBodyId } = await twoSkaters(t);
    await t.run((ctx) => ctx.db.patch(adas, { moderationStatus: 'hidden' }));
    expect(ids(await t.query(api.posts.listFeed, { ...FIRST, skater: 'ada' }))).toEqual([]);
    const great = await ada.as.mutation(api.posts.create, {
      reports: [{ ...FRESH, waterBodyId, skateEndTime: T0, skateQuality: 'great' }],
    });
    await ada.as.mutation(api.posts.create, {
      reports: [{ ...FRESH, waterBodyId, skateEndTime: T0, skateQuality: 'poor' }],
    });
    expect(
      ids(
        await t.query(api.posts.listFeed, {
          ...FIRST,
          skater: 'ada',
          filters: { qualityFloor: 'good' },
        }),
      ),
    ).toEqual([great.postId]);
  });

  describe('it answers to the profile’s rule, because it lists one person', () => {
    const unavailable = { page: [], isDone: true, skaterUnavailable: true };

    test('no such skater', async () => {
      const t = convexTest(schema, modules);
      await twoSkaters(t);
      expect(await t.query(api.posts.listFeed, { ...FIRST, skater: 'nobody' })).toMatchObject(
        unavailable,
      );
    });

    test('a private skater, to everyone but themselves, and their reports stay on the feed (D13)', async () => {
      const t = convexTest(schema, modules);
      const { ada, bob, adas } = await twoSkaters(t);
      await t.run((ctx) => ctx.db.patch(ada.id, { profileVisibility: 'private' }));
      expect(await bob.as.query(api.posts.listFeed, { ...FIRST, skater: 'ada' })).toMatchObject(
        unavailable,
      );
      expect(ids(await ada.as.query(api.posts.listFeed, { ...FIRST, skater: 'ada' }))).toEqual([
        adas,
      ]);
      expect(ids(await bob.as.query(api.posts.listFeed, FIRST))).toContain(adas);
    });

    test('a block, in either direction, and the reports stay on the feed marked (D3)', async () => {
      const t = convexTest(schema, modules);
      const { ada, bob, adas } = await twoSkaters(t);
      await bob.as.mutation(api.blocks.block, { targetUserId: ada.id });
      for (const [viewer, skater] of [
        [bob, 'ada'],
        [ada, 'bob'],
      ] as const) {
        expect(await viewer.as.query(api.posts.listFeed, { ...FIRST, skater })).toMatchObject(
          unavailable,
        );
      }
      const feed = await bob.as.query(api.posts.listFeed, FIRST);
      expect(feed.page.find((p) => p.postId === adas)?.blocked).toBe(true);
    });

    test('a skater who has left or asked to leave', async () => {
      const t = convexTest(schema, modules);
      const { ada, bob } = await twoSkaters(t);
      await t.run((ctx) => ctx.db.patch(ada.id, { deletionRequestedAt: T0 }));
      await t.run((ctx) => ctx.db.patch(bob.id, { status: 'deleted' }));
      for (const skater of ['ada', 'bob']) {
        expect(await t.query(api.posts.listFeed, { ...FIRST, skater })).toMatchObject(unavailable);
      }
    });

    test('text search narrows by skater under the same rule', async () => {
      const t = convexTest(schema, modules);
      const { ada, bob, waterBodyId } = await twoSkaters(t);
      const write = (who: typeof ada) =>
        who.as.mutation(api.posts.create, {
          title: 'Narrows',
          reports: [{ ...FRESH, waterBodyId, skateEndTime: T0 }],
        });
      const adas = await write(ada);
      await write(bob);
      await t.run(async (ctx) => {
        // Every row needs words for convex-test's search: see the note above.
        for (const row of await ctx.db.query('posts').collect()) {
          if (row.searchText === undefined) await ctx.db.patch(row._id, { searchText: 'x' });
        }
      });
      const search = (skater: string) =>
        t.query(api.posts.searchFeed, { query: 'narrows', skater, ...FIRST });
      expect(ids(await search('ada'))).toEqual([adas.postId]);
      expect(await search('nobody')).toMatchObject({ ...unavailable, matched: 0 });
    });
  });

  describe('the season it serves', () => {
    const LAST_WINTER = T0 - 365 * 24 * 3_600_000;

    /** A Post this skater wrote last winter: the clock moves for the write, as D199 asks. */
    async function postedLastWinter(
      who: Awaited<ReturnType<typeof seedUser>>,
      waterBodyId: Id<'waterBodies'>,
    ) {
      const now = Date.now();
      vi.setSystemTime(LAST_WINTER + 60_000);
      const { postId } = await who.as.mutation(api.posts.create, {
        reports: [{ ...FRESH, waterBodyId, skateEndTime: LAST_WINTER }],
      });
      vi.setSystemTime(now);
      return postId;
    }

    test('falls back to the newest season this skater posted in, and says so', async () => {
      const t = convexTest(schema, modules);
      const { waterBodyId } = await twoSkaters(t);
      const cal = await seedUser(t, 'cal');
      const postId = await postedLastWinter(cal, waterBodyId);
      const feed = await t.query(api.posts.listFeed, { ...FIRST, skater: 'cal' });
      expect(ids(feed)).toEqual([postId]);
      expect(feed.isPastSeason).toBe(true);
    });

    test('an explicit season is still honored', async () => {
      const t = convexTest(schema, modules);
      const { adas, ada, waterBodyId } = await twoSkaters(t);
      const old = await postedLastWinter(ada, waterBodyId);
      const current = await t.query(api.posts.listFeed, { ...FIRST, skater: 'ada' });
      expect(ids(current)).toEqual([adas]);
      const browsed = await t.query(api.posts.listFeed, {
        ...FIRST,
        skater: 'ada',
        season: current.season - 1,
      });
      expect(ids(browsed)).toEqual([old]);
    });

    test('a skater with nothing yet reads as this season', async () => {
      const t = convexTest(schema, modules);
      await twoSkaters(t);
      await seedUser(t, 'cal');
      expect(await t.query(api.posts.listFeed, { ...FIRST, skater: 'cal' })).toMatchObject({
        page: [],
        isPastSeason: false,
      });
    });
  });
});
