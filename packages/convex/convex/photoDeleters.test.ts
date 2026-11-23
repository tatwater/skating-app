/**
 * **No deleter takes a held photo; a removal's bytes go by the purge alone** (B01-5e; D248, D222). Each
 * of the paths that deletes a photo — the orphan walk and the settlement it owes to, season expiry, the
 * reconcile, account deletion and its departed-content purge, the uploader's delete — keeps a photo
 * that is moderated, under an open flag, or under a standing verdict, and deletes its unheld twin as
 * before. Then the purge, the rollout's backfill, and the export.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { PHOTO_HELD_DETACH, PHOTO_PURGE_DELAY_MS } from './lib/photoAccess';
import { deletePhotoAndBlobs } from './lib/photoOrphans';
import { PURGE_FLAG_HOLD_MAX_MS, PURGE_PAGE, PURGE_RETRY_MS } from './photoPurge';
import schema from './schema';

const failing = vi.hoisted(() => ({ ids: new Set<string>() }));
vi.mock('./lib/storageBlobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/storageBlobs')>();
  return {
    ...actual,
    deleteStoredBlob: async (ctx: Parameters<typeof actual.deleteStoredBlob>[0], id: string) =>
      failing.ids.has(id) ? 'storage refused' : actual.deleteStoredBlob(ctx, id as never),
  };
});

const modules = import.meta.glob('./**/*.*s');
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 11, 2, 12);
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  failing.ids.clear();
});
afterEach(() => vi.useRealTimers());

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

async function person(
  t: T,
  subject: string,
  over: Partial<Doc<'profiles'>> = {},
): Promise<Id<'profiles'>> {
  return t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Test-Person`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: T0 - 400 * DAY,
      ...over,
    }),
  );
}

async function photo(t: T, uploaderId: Id<'profiles'>, over: Partial<Doc<'photos'>> = {}) {
  return t.run(async (ctx) =>
    ctx.db.insert('photos', {
      storageId: await ctx.storage.store(new Blob(['full'])),
      thumbStorageId: await ctx.storage.store(new Blob(['thumb'])),
      uploaderId,
      caption: 'a caption',
      placeOnMap: false,
      createdAt: T0 - 200 * DAY,
      ...over,
    }),
  );
}

/** The ways a photo is held, each made as the app makes it (or as its rows stand). */
const HOLDS: Record<
  string,
  (t: T, photoId: Id<'photos'>, flagger: Id<'profiles'>) => Promise<void>
> = {
  hidden: (t, id) =>
    t.run(async (ctx) => void (await ctx.db.patch(id, { moderationStatus: 'hidden' }))),
  removed: (t, id) =>
    t.run(
      async (ctx) =>
        void (await ctx.db.patch(id, { moderationStatus: 'removed', purgeAt: T0 + DAY })),
    ),
  'open flag': (t, id, flagger) => flag(t, id, flagger, 'open'),
  'reviewing flag': (t, id, flagger) => flag(t, id, flagger, 'reviewing'),
  'standing verdict': (t, id) =>
    t.run(async (ctx) => {
      const photo = (await ctx.db.get(id)) as Doc<'photos'>;
      const actionId = await ctx.db.insert('moderationActions', {
        action: 'hide',
        targetType: 'photo',
        targetId: id,
        reason: 'x',
        createdAt: T0,
      });
      await ctx.db.insert('contentVerdicts', {
        subjectUserId: photo.uploaderId,
        targetType: 'photo',
        targetId: id,
        actionId,
        kind: 'hidden',
        at: T0,
        standing: true,
        superseded: false,
      });
    }),
};

async function flag(
  t: T,
  photoId: Id<'photos'>,
  flaggerId: Id<'profiles'>,
  status: 'open' | 'reviewing',
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('contentFlags', {
      targetType: 'photo',
      targetId: photoId,
      flaggerId,
      reason: 'inappropriate',
      status,
      createdAt: T0,
      origin: 'user',
    } as never);
  });
}

const exists = (t: T, id: Id<'photos'>) => t.run(async (ctx) => (await ctx.db.get(id)) !== null);
const blobAlive = (t: T, id: Id<'photos'>) =>
  t.run(async (ctx) => {
    const p = await ctx.db.get(id);
    return p !== null && (await ctx.storage.getUrl(p.storageId as Id<'_storage'>)) !== null;
  });

describe('deletePhotoAndBlobs asks photoHeld itself', () => {
  for (const [hold, make] of Object.entries(HOLDS)) {
    test(`${hold}: held — row and blobs kept`, async () => {
      const t = harness();
      const uploader = await person(t, 'uploader');
      const flagger = await person(t, 'flagger');
      const id = await photo(t, uploader);
      await make(t, id, flagger);
      const result = await t.run(async (ctx) =>
        deletePhotoAndBlobs(ctx, (await ctx.db.get(id)) as Doc<'photos'>),
      );
      expect(result).toBe('held');
      expect(await blobAlive(t, id)).toBe(true);
    });
  }

  test('unheld: deleted; a closed flag or an ended verdict holds nothing', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const flagger = await person(t, 'flagger');
    const id = await photo(t, uploader);
    await t.run(async (ctx) => {
      await ctx.db.insert('contentFlags', {
        targetType: 'photo',
        targetId: id,
        flaggerId: flagger,
        reason: 'spam',
        status: 'dismissed',
        createdAt: T0,
        origin: 'user',
      } as never);
    });
    const result = await t.run(async (ctx) =>
      deletePhotoAndBlobs(ctx, (await ctx.db.get(id)) as Doc<'photos'>),
    );
    expect(result).toBe('deleted');
    expect(await exists(t, id)).toBe(false);
  });
});

describe('every deleter keeps a held photo and deletes its unheld twin', () => {
  test('the orphan walk and the settlement it owes to', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const flagger = await person(t, 'flagger');
    const held = await photo(t, uploader);
    const loose = await photo(t, uploader);
    await HOLDS['open flag']?.(t, held, flagger);
    await t.mutation(internal.storageHygiene.sweepOrphanPhotos, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await exists(t, held)).toBe(true);
    expect(await exists(t, loose)).toBe(false);
  });

  test('an erased photo’s retry in the walk keeps one held since', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const held = await photo(t, uploader, { erasedAt: T0 - DAY, moderationStatus: 'hidden' });
    await t.mutation(internal.storageHygiene.examinePhoto, { photoId: held });
    expect(await blobAlive(t, held)).toBe(true);
  });

  test('season expiry of a departed skater’s photos', async () => {
    const t = harness();
    const gone = await person(t, 'gone', { status: 'deleted' });
    const held = await photo(t, gone, { createdAt: T0 - 300 * DAY });
    const loose = await photo(t, gone, { createdAt: T0 - 300 * DAY });
    await HOLDS.removed?.(t, held, gone);
    const out = await t.mutation(internal.storageHygiene.expireDepartedPhotos, { userId: gone });
    expect(out).toMatchObject({ deleted: 1, kept: 1 });
    expect(await exists(t, held)).toBe(true);
    expect(await exists(t, loose)).toBe(false);
  });

  test('the reconcile', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const held = await photo(t, uploader);
    const loose = await photo(t, uploader);
    await HOLDS['standing verdict']?.(t, held, uploader);
    await t.mutation(internal.photoReconcile.reconcileUploaderPhotos, {
      uploaderId: uploader,
      pageSize: 1,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await exists(t, held)).toBe(true);
    expect(await exists(t, loose)).toBe(false);
  });

  test('account deletion (and its departed-content purge)', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const flagger = await person(t, 'flagger');
    const held = await photo(t, uploader);
    const loose = await photo(t, uploader);
    await HOLDS['reviewing flag']?.(t, held, flagger);
    await t.mutation(internal.accountDeletion.finalizeNow, { userId: uploader });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await blobAlive(t, held)).toBe(true);
    expect(await exists(t, loose)).toBe(false);
  });

  test('the uploader’s detach of a held access photo is refused; a moderator’s goes, the photo kept', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const flagger = await person(t, 'flagger');
    await person(t, 'mod', { role: 'moderator' });
    const held = await photo(t, uploader);
    await HOLDS['open flag']?.(t, held, flagger);
    const attachment = await t.run(async (ctx) => {
      const waterBodyId = await ctx.db.insert('waterBodies', {
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
              [0, 0],
            ],
          ],
        },
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.5, lng: 0.5 },
        dedupStatus: 'clean' as const,
        createdAt: T0,
      });
      const putInId = await ctx.db.insert('putIns', {
        waterBodyId,
        coord: { lat: 0.5, lng: 0.5 },
        source: 'derived' as const,
        status: 'visible' as const,
        createdAt: T0,
      });
      return ctx.db.insert('accessPhotos', {
        targetType: 'put_in' as const,
        putInId,
        photoId: held,
        uploaderId: uploader,
        createdAt: T0,
      });
    });
    await expect(
      t.withIdentity({ subject: 'uploader' }).mutation(api.accessPoints.detachPhoto, {
        accessPhotoId: attachment,
      }),
    ).rejects.toThrow(PHOTO_HELD_DETACH);
    await t.withIdentity({ subject: 'mod' }).mutation(api.accessPoints.detachPhoto, {
      accessPhotoId: attachment,
    });
    expect(await blobAlive(t, held)).toBe(true);
  });
});

// ── The purge ──────────────────────────────────────────────────────────────────────────────────

async function removedPhoto(t: T, uploader: Id<'profiles'>, purgeAt: number) {
  return photo(t, uploader, { moderationStatus: 'removed', moderatedAt: T0 - 31 * DAY, purgeAt });
}

describe('the purge', () => {
  test('a due photo: blobs deleted, row a tombstone, a system purge_photo row with no undo', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    await person(t, 'mod', { role: 'moderator' });
    const id = await removedPhoto(t, uploader, T0 - 1);
    const before = await t.run((ctx) => ctx.db.get(id) as Promise<Doc<'photos'>>);
    const out = await t.mutation(internal.photoPurge.purgeDuePhotos, { now: T0 });
    expect(out).toMatchObject({ purged: 1, more: false });
    const after = await t.run((ctx) => ctx.db.get(id) as Promise<Doc<'photos'>>);
    expect(after).toMatchObject({
      uploaderId: uploader,
      purgedAt: T0,
      moderationStatus: 'removed',
    });
    expect(after.caption).toBeUndefined();
    expect(after.purgeAt).toBeUndefined();
    expect(await t.run((ctx) => ctx.storage.getUrl(before.storageId as Id<'_storage'>))).toBeNull();
    const row = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target_action', (q) =>
          q.eq('targetType', 'photo').eq('targetId', id).eq('action', 'purge_photo'),
        )
        .first(),
    );
    expect(row?.actorId).toBeUndefined();
    await expect(
      t.withIdentity({ subject: 'mod' }).mutation(api.undo.run, {
        actionId: row?._id as Id<'moderationActions'>,
      }),
    ).rejects.toThrow();
  });

  test('not yet due, or no clock at all: never read, never touched', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const later = await removedPhoto(t, uploader, T0 + DAY);
    for (let i = 0; i < 20; i++) await photo(t, uploader);
    const out = await t.mutation(internal.photoPurge.purgeDuePhotos, { now: T0 });
    expect(out).toMatchObject({ examined: 0, purged: 0 });
    expect((await t.run((ctx) => ctx.db.get(later)))?.purgedAt).toBeUndefined();
  });

  test('an open flag defers it a day; a restored photo’s stale clock is cleared; a blob that won’t delete keeps its row', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const flagger = await person(t, 'flagger');
    const flagged = await removedPhoto(t, uploader, T0 - 3);
    await HOLDS['open flag']?.(t, flagged, flagger);
    const restored = await photo(t, uploader, { moderationStatus: 'visible', purgeAt: T0 - 2 });
    const stuck = await removedPhoto(t, uploader, T0 - 1);
    const stuckRow = await t.run((ctx) => ctx.db.get(stuck) as Promise<Doc<'photos'>>);
    failing.ids.add(stuckRow.storageId);
    const out = await t.mutation(internal.photoPurge.purgeDuePhotos, { now: T0 });
    expect(out).toMatchObject({ deferred: 1, cleared: 1, retained: 1, purged: 0 });
    const rows = await t.run(async (ctx) =>
      Promise.all([flagged, restored, stuck].map((id) => ctx.db.get(id))),
    );
    expect(rows[0]?.purgeAt).toBe(T0 + PURGE_RETRY_MS);
    expect(rows[1]?.purgeAt).toBeUndefined();
    expect(rows[2]?.purgeAt).toBe(T0 + PURGE_RETRY_MS);
    expect(rows[2]?.purgedAt).toBeUndefined();
  });

  test('bounded: a page at a time, each continuing until none is due', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const ids: Id<'photos'>[] = [];
    for (let i = 0; i < 7; i++) ids.push(await removedPhoto(t, uploader, T0 - 100 + i));
    const first = await t.mutation(internal.photoPurge.purgeDuePhotos, { limit: 3, now: T0 });
    expect(first).toMatchObject({ purged: 3, more: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await t.run(async (ctx) => Promise.all(ids.map((id) => ctx.db.get(id))));
    expect(rows.every((r) => r?.purgedAt !== undefined)).toBe(true);
    expect(PURGE_PAGE).toBe(100);
  });

  test('a removal through the write purges 30 days on, not before', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    await person(t, 'mod', { role: 'moderator' });
    const id = await photo(t, uploader);
    await t.withIdentity({ subject: 'mod' }).mutation(api.moderation.setModerationStatus, {
      targetType: 'photo',
      targetId: id,
      status: 'removed',
      reason: 'x',
    });
    // The clock a minute at a time (the rotation's watch must not see a live run as dead).
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await t.finishInProgressScheduledFunctions();
    }
    const at = (await t.run((ctx) => ctx.db.get(id)))?.purgeAt as number;
    expect(await t.mutation(internal.photoPurge.purgeDuePhotos, { now: at - 1 })).toMatchObject({
      purged: 0,
    });
    expect(await t.mutation(internal.photoPurge.purgeDuePhotos, { now: at })).toMatchObject({
      purged: 1,
    });
    expect(at - T0).toBeLessThanOrEqual(PHOTO_PURGE_DELAY_MS + 1_000);
  });
});

// ── The rollout and the export ─────────────────────────────────────────────────────────────────

describe('the rollout: backfill visible, counted', () => {
  test('stamps every row lacking the field, paged; idempotent; the count reaches zero', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    for (let i = 0; i < 17; i++) await photo(t, uploader);
    const hidden = await photo(t, uploader, { moderationStatus: 'hidden' });
    expect(await t.action(internal.photoRollout.countUnstamped, { pageSize: 5 })).toEqual({
      unstamped: 17,
      scanned: 18,
    });
    const dry = await t.mutation(internal.photoRollout.backfillModerationStatus, {
      pageSize: 50,
      dryRun: true,
    });
    expect(dry).toMatchObject({ stamped: 17 });
    await t.mutation(internal.photoRollout.backfillModerationStatus, { pageSize: 5 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.action(internal.photoRollout.countUnstamped, { pageSize: 5 })).toEqual({
      unstamped: 0,
      scanned: 18,
    });
    expect((await t.run((ctx) => ctx.db.get(hidden)))?.moderationStatus).toBe('hidden');
    const again = await t.mutation(internal.photoRollout.backfillModerationStatus, {
      pageSize: 50,
    });
    expect(again).toMatchObject({ stamped: 0 });
  });
});

describe('the export', () => {
  test('their hidden photo ships with its status and bytes’ id; a purged one as a line without', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const hidden = await photo(t, uploader, { moderationStatus: 'hidden' });
    const purged = await photo(t, uploader, { moderationStatus: 'removed', purgedAt: T0 });
    const data = await t.query(internal.dataExport.collect, { userId: uploader });
    const byId = new Map(data.photos.map((p) => [p.photoId, p]));
    expect(byId.get(hidden)).toMatchObject({ moderationStatus: 'hidden' });
    expect(byId.get(hidden)?.storageId).toEqual(expect.any(String));
    expect(byId.get(purged)).toMatchObject({ purgedAt: T0 });
    expect(byId.get(purged)?.storageId).toBeUndefined();
  });
});

describe('the purge’s push-back is bounded', () => {
  test('an open flag defers a removed photo’s purge a day at a time, at most two months past its due date', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const flagger = await person(t, 'flagger');
    const id = await photo(t, uploader, {
      moderationStatus: 'removed',
      moderatedAt: T0,
      purgeAt: T0 + PHOTO_PURGE_DELAY_MS,
    });
    await HOLDS['open flag']?.(t, id, flagger);
    const due = T0 + PHOTO_PURGE_DELAY_MS;
    expect(await t.mutation(internal.photoPurge.purgeDuePhotos, { now: due })).toMatchObject({
      deferred: 1,
    });
    const last = due + PURGE_FLAG_HOLD_MAX_MS - 1;
    await t.run((ctx) => ctx.db.patch(id, { purgeAt: last }));
    expect(await t.mutation(internal.photoPurge.purgeDuePhotos, { now: last })).toMatchObject({
      deferred: 1,
    });
    const past = due + PURGE_FLAG_HOLD_MAX_MS;
    await t.run((ctx) => ctx.db.patch(id, { purgeAt: past }));
    expect(await t.mutation(internal.photoPurge.purgeDuePhotos, { now: past })).toMatchObject({
      purged: 1,
    });
  });
});

describe('what a row keeps once its bytes or its account go', () => {
  test('the purge’s tombstone: no caption, time taken or place; the uploader, report and dates stay', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const id = await removedPhoto(t, uploader, T0 - 1);
    await t.run((ctx) =>
      ctx.db.patch(id, { takenAt: T0 - 5, coord: { lat: 1, lng: 2 }, placeOnMap: true }),
    );
    await t.mutation(internal.photoPurge.purgeDuePhotos, { now: T0 });
    const row = (await t.run((ctx) => ctx.db.get(id))) as Doc<'photos'>;
    expect(row).toMatchObject({ uploaderId: uploader, purgedAt: T0, placeOnMap: false });
    expect(row.caption).toBeUndefined();
    expect(row.takenAt).toBeUndefined();
    expect(row.coord).toBeUndefined();
  });

  test('a deleted account’s held photo keeps its row and bytes, but not its caption, time taken or place', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const flagger = await person(t, 'flagger');
    const held = await photo(t, uploader, {
      takenAt: T0 - 5,
      coord: { lat: 1, lng: 2 },
      placeOnMap: true,
    });
    await HOLDS['open flag']?.(t, held, flagger);
    await t.mutation(internal.accountDeletion.finalizeNow, { userId: uploader });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const row = (await t.run((ctx) => ctx.db.get(held))) as Doc<'photos'>;
    expect(await blobAlive(t, held)).toBe(true);
    expect(row.takenAt).toBeUndefined();
    expect(row.coord).toBeUndefined();
    expect(row.caption).toBeUndefined();
    expect(row.placeOnMap).toBe(false);
  });
});
