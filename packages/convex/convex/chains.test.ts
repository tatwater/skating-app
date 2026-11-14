/**
 * Every continuing job D248 added, on an adversarial page: every row takes the dearest branch its
 * loop has (an item gone, a hold to check, a row to look up and rewrite), every row as heavy as an
 * uncapped field lets it be, under Convex's real transaction limits. Each chain must reach its end —
 * no pass may throw (`OverBudget` included), and none may stall — and leave what it is for.
 */
import { WITHDRAWN_ERASE_MS } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2027, 0, 14, 12);
/** Near the document limit: what an uncapped field can weigh. */
const HEAVY = 'h'.repeat(1000 * 1024);

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
  nearbyReportDigest: false,
  greatReportNearby: false,
};

async function seedUser(t: T, subject: string, role: 'member' | 'moderator' = 'member') {
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

async function setup() {
  vi.setSystemTime(T0);
  const t = convexTest({ schema, modules, transactionLimits: true });
  const author = await seedUser(t, 'author');
  const other = await seedUser(t, 'other');
  const mod = await seedUser(t, 'mod', 'moderator');
  const waterBodyId = await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Lake Morey',
      searchText: 'Lake Morey',
      type: 'lakePond' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
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
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  );
  return { t, author, other, mod, waterBodyId };
}

/** A Report with notes near the document limit, written on its own. */
function heavyReport(
  t: T,
  authorId: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
  extra: Record<string, unknown> = {},
) {
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: Date.now(),
      reportTime: Date.now(),
      source: 'native' as const,
      iceTypes: [{ type: 'black_ice' as const }],
      surfaceTags: [],
      photoIds: [],
      notes: HEAVY,
      moderationStatus: 'visible' as const,
      hazardIdsCreated: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...extra,
    }),
  );
}

/** An audit row with a reason near the document limit, written on its own. */
function heavyAudit(
  t: T,
  row: {
    actorId?: Id<'profiles'>;
    action: 'hide' | 'remove' | 'restore' | 'author_delete' | 'dismiss_flag';
    targetType: 'report' | 'post' | 'comment';
    targetId: string;
    undoesActionId?: Id<'moderationActions'>;
  },
) {
  return t.run((ctx) =>
    ctx.db.insert('moderationActions', {
      ...row,
      reason: HEAVY,
      metadata: { priorStatus: 'visible', newStatus: 'hidden' },
      createdAt: Date.now(),
    }),
  );
}

/** Run the chain out; then nothing it scheduled may have failed. */
async function runOut(t: T, start: () => Promise<unknown>) {
  await start();
  await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
  const failed = (
    await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
  ).filter((job) => job.state.kind === 'failed');
  expect(failed.map((job) => job.name)).toEqual([]);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('every chain reaches its end on its dearest page', () => {
  test('backfillVerdicts: every row its item’s newest, every item gone, every row heavy', async () => {
    const { t, author, mod, waterBodyId } = await setup();
    for (let i = 0; i < 8; i++) {
      const reportId = await heavyReport(t, author.id, waterBodyId);
      await heavyAudit(t, {
        actorId: mod.id,
        action: 'hide',
        targetType: 'report',
        targetId: reportId,
      });
      await t.run((ctx) => ctx.db.delete(reportId));
    }
    await runOut(t, () => t.mutation(internal.contentRecord.backfillVerdicts, { clocks: false }));
    expect(await t.run((ctx) => ctx.db.query('contentVerdicts').collect())).toEqual([]);
  });

  test('replayVerdictHistory: every row ends a verdict and has a stray to drop, every row heavy', async () => {
    const { t, author, mod, waterBodyId } = await setup();
    const reportId = await heavyReport(t, author.id, waterBodyId);
    const rows: Id<'moderationActions'>[] = [];
    for (let i = 0; i < 16; i++) {
      rows.push(
        await heavyAudit(t, {
          actorId: mod.id,
          action: i % 2 === 0 ? 'hide' : 'restore',
          targetType: 'report',
          targetId: reportId,
        }),
      );
    }
    // An earlier build's rows, all wrong: every hide standing, a verdict minted for every restore.
    await t.run(async (ctx) => {
      for (const actionId of rows) {
        await ctx.db.insert('contentVerdicts', {
          subjectUserId: author.id,
          targetType: 'report',
          targetId: reportId,
          actionId,
          kind: 'hidden',
          at: T0,
          standing: true,
        });
      }
    });
    await runOut(t, () => t.mutation(internal.contentRecord.backfillVerdicts, { clocks: false }));
    const all = await t.run((ctx) => ctx.db.query('contentVerdicts').collect());
    expect(all).toHaveLength(8);
    expect(all.filter((v) => v.standing)).toEqual([]);
  });

  test('backfillFromAudit and stampWithdrawal: heavy deletions, each restored and undone, a heavy Post’s members', async () => {
    const { t, author, mod, waterBodyId } = await setup();
    const reportIds: Id<'reports'>[] = [];
    for (let i = 0; i < 10; i++) {
      reportIds.push(await heavyReport(t, author.id, waterBodyId, { moderationStatus: 'removed' }));
    }
    const postId = await t.run((ctx) =>
      ctx.db.insert('posts', {
        authorId: author.id,
        reportIds,
        photoIds: [],
        latestSkateEndTime: T0,
        moderationStatus: 'removed',
        createdAt: T0,
        updatedAt: T0,
      }),
    );
    for (const id of reportIds) await t.run((ctx) => ctx.db.patch(id, { postId }));
    // Author deletions whose items are gone: a real id each, so each one's lookup is made (and
    // charged) and finds nothing — an id that doesn't normalize would skip the read entirely.
    for (let i = 0; i < 6; i++) {
      const goneId = await t.run(async (ctx) => {
        const id = await ctx.db.insert('reports', {
          authorId: author.id,
          waterBodyId,
          point: { lat: 0.5, lng: 0.5 },
          skateEndTime: T0,
          reportTime: T0,
          source: 'native' as const,
          iceTypes: [{ type: 'black_ice' as const }],
          surfaceTags: [],
          photoIds: [],
          moderationStatus: 'removed' as const,
          hazardIdsCreated: [],
          createdAt: T0,
          updatedAt: T0,
        });
        await ctx.db.delete(id);
        return id;
      });
      await heavyAudit(t, {
        actorId: author.id,
        action: 'author_delete',
        targetType: 'report',
        targetId: goneId,
      });
    }
    // The Post's deletion, then restores every one of which a moderator undid — the restores first,
    // so a whole page of them each pays its undo.
    await heavyAudit(t, {
      actorId: author.id,
      action: 'author_delete',
      targetType: 'post',
      targetId: postId,
    });
    const restores: Id<'moderationActions'>[] = [];
    for (let i = 0; i < 6; i++) {
      restores.push(
        await heavyAudit(t, {
          actorId: mod.id,
          action: 'restore',
          targetType: 'post',
          targetId: postId,
        }),
      );
    }
    for (const restore of restores) {
      await heavyAudit(t, {
        actorId: mod.id,
        action: 'hide',
        targetType: 'post',
        targetId: postId,
        undoesActionId: restore,
      });
    }
    await runOut(t, () => t.mutation(internal.authorDeletions.backfillFromAudit, {}));
    expect((await t.run((ctx) => ctx.db.get(postId)))?.authorDeletedAt).toBeDefined();
    for (const id of reportIds) {
      expect((await t.run((ctx) => ctx.db.get(id)))?.authorDeletedAt).toBeDefined();
    }
  });

  test('backfillCommentDeletions and commentLastWord: removed comments whose heavy histories never decide', async () => {
    const { t, author, mod, waterBodyId } = await setup();
    const reportId = await heavyReport(t, author.id, waterBodyId);
    const comments: Id<'comments'>[] = [];
    for (let i = 0; i < 3; i++) {
      const commentId = await t.run((ctx) =>
        ctx.db.insert('comments', {
          reportId,
          authorId: author.id,
          body: 'x'.repeat(2000),
          source: 'native' as const,
          moderationStatus: 'removed' as const,
          createdAt: Date.now(),
        }),
      );
      for (let j = 0; j < 14; j++) {
        await heavyAudit(t, {
          actorId: mod.id,
          action: 'dismiss_flag',
          targetType: 'comment',
          targetId: commentId,
        });
      }
      comments.push(commentId);
    }
    await runOut(t, () => t.mutation(internal.authorDeletions.backfillCommentDeletions, {}));
    for (const id of comments) {
      expect((await t.run((ctx) => ctx.db.get(id)))?.authorDeletedAt).toBeDefined();
    }
  });

  test('eraseDue: every due item a heavy Report held by a heavy open flag on its Post', async () => {
    const { t, author, other, waterBodyId } = await setup();
    const reportIds: Id<'reports'>[] = [];
    for (let i = 0; i < 6; i++) {
      const reportId = await heavyReport(t, author.id, waterBodyId, {
        moderationStatus: 'removed',
        authorDeletedAt: T0,
        eraseAt: T0 + WITHDRAWN_ERASE_MS,
      });
      const postId = await t.run((ctx) =>
        ctx.db.insert('posts', {
          authorId: author.id,
          reportIds: [reportId],
          photoIds: [],
          latestSkateEndTime: T0,
          moderationStatus: 'removed',
          createdAt: T0,
          updatedAt: T0,
        }),
      );
      await t.run(async (ctx) => {
        await ctx.db.patch(reportId, { postId });
        // A flag that reached the table without moving the clock: the sweep's own check must hold it.
        await ctx.db.insert('contentFlags', {
          flaggerId: other.id,
          targetType: 'post',
          targetId: postId,
          reason: 'harassment',
          note: HEAVY,
          status: 'open',
          origin: 'user',
          createdAt: T0,
        });
      });
      reportIds.push(reportId);
    }
    vi.setSystemTime(T0 + 31 * DAY);
    await runOut(t, () => t.mutation(internal.erasure.eraseDue, {}));
    for (const id of reportIds) {
      const row = await t.run((ctx) => ctx.db.get(id));
      expect(row).not.toBeNull();
      expect(row?.eraseAt).toBeUndefined();
    }
  });

  test('settlePhotos: heavy hazards to read, then heavy photos on access points to check', async () => {
    const { t, author, waterBodyId } = await setup();
    for (let i = 0; i < 14; i++) {
      await t.run((ctx) =>
        ctx.db.insert('hazards', {
          waterBodyId,
          type: 'pressure_ridge' as const,
          geometryKind: 'point_radius' as const,
          geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
          radiusMeters: 30,
          bbox: { minLat: 0.4, minLng: 0.4, maxLat: 0.6, maxLng: 0.6 },
          createdByUserId: author.id,
          description: HEAVY,
          photoIds: [],
          status: 'active' as const,
          moderationStatus: 'visible' as const,
          firstReportedAt: T0,
          lastConfirmedAt: T0,
          confirmCount: 0,
          goneCount: 0,
          createdAt: T0,
        }),
      );
    }
    const putInId = await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId,
        coord: { lat: 0.5, lng: 0.5 },
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: T0,
      }),
    );
    const photoIds: Id<'photos'>[] = [];
    for (let i = 0; i < 12; i++) {
      const photoId = await t.run(async (ctx) =>
        ctx.db.insert('photos', {
          storageId: await ctx.storage.store(new Blob([`full ${i}`])),
          thumbStorageId: await ctx.storage.store(new Blob([`thumb ${i}`])),
          uploaderId: author.id,
          caption: HEAVY,
          placeOnMap: false,
          createdAt: T0,
        }),
      );
      // Every one used by an access point: each pays its whole check and stays.
      await t.run((ctx) =>
        ctx.db.insert('accessPhotos', {
          targetType: 'put_in' as const,
          putInId,
          photoId,
          uploaderId: author.id,
          createdAt: T0,
        }),
      );
      photoIds.push(photoId);
    }
    await runOut(t, () =>
      t.mutation(internal.erasure.settlePhotos, { uploaderId: author.id, photoIds }),
    );
    for (const id of photoIds) expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
  });

  test('backfillClocks: every row withdrawn, heavy, and held by a heavy open flag', async () => {
    const { t, author, other, waterBodyId } = await setup();
    const reportIds: Id<'reports'>[] = [];
    for (let i = 0; i < 8; i++) {
      const reportId = await heavyReport(t, author.id, waterBodyId, {
        moderationStatus: 'removed',
        authorDeletedAt: T0,
      });
      await t.run((ctx) =>
        ctx.db.insert('contentFlags', {
          flaggerId: other.id,
          targetType: 'report',
          targetId: reportId,
          reason: 'spam',
          note: HEAVY,
          status: 'open',
          origin: 'user',
          createdAt: T0,
        }),
      );
      reportIds.push(reportId);
    }
    await runOut(t, () => t.mutation(internal.erasure.backfillClocks, { kind: 'report' }));
    for (const id of reportIds) {
      expect((await t.run((ctx) => ctx.db.get(id)))?.eraseAt).toBeUndefined();
    }
  });

  test('refreshMemberClocks and dropErasedMember: a heavy Post of ten heavy withdrawn members', async () => {
    const { t, author, other, waterBodyId } = await setup();
    const reportIds: Id<'reports'>[] = [];
    for (let i = 0; i < 10; i++) {
      reportIds.push(
        await heavyReport(t, author.id, waterBodyId, {
          moderationStatus: 'removed',
          authorDeletedAt: T0,
          eraseAt: T0 + WITHDRAWN_ERASE_MS,
        }),
      );
    }
    const postId = await t.run((ctx) =>
      ctx.db.insert('posts', {
        authorId: author.id,
        reportIds,
        photoIds: [],
        title: 't',
        body: 'b',
        latestSkateEndTime: T0,
        moderationStatus: 'removed',
        authorDeletedAt: T0,
        createdAt: T0,
        updatedAt: T0,
      }),
    );
    for (const id of reportIds) await t.run((ctx) => ctx.db.patch(id, { postId }));
    const flagId = await other.as.mutation(api.contentFlags.flag, {
      targetType: 'post',
      targetId: postId,
      reason: 'harassment',
    });
    await runOut(t, async () => {});
    for (const id of reportIds) {
      expect((await t.run((ctx) => ctx.db.get(id)))?.eraseAt).toBeUndefined();
    }
    await other.as.mutation(api.contentFlags.retract, { flagId });
    // The members' clocks follow the released hold, a few a pass.
    await runOut(t, async () => {});
    vi.setSystemTime(T0 + 31 * DAY);
    await runOut(t, () => t.mutation(internal.erasure.eraseDue, {}));
    for (const id of reportIds) expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(postId))).toBeNull();
  });
});
