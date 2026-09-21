import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
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
    expect(actions.map((a) => a.action)).toContain('author_delete');
    expect(actions.find((a) => a.action === 'author_delete')?.metadata).toMatchObject({
      newStatus: 'removed',
      derivedFromReportId: second,
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
