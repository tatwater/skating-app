/**
 * **A takedown moves the bytes** (B01-5e; the founder's call, proven on dev): `photos.rotateBlobs`, as the
 * public writes schedule it — a hide rotates, a restore serves the new copy and never rotates back, a
 * restore before the rotation runs leaves everything as it was, a hide then a removal rotates once, a
 * failed swap drops its copies and retries by the attempts rule, an oversized photo parks, a photo
 * missing a blob carries what it has, and the purge after a rotation deletes the new blobs.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { PHOTO_PURGE_DELAY_MS } from './lib/photoAccess';
import { ROTATE_MAX_BYTES, ROTATION_RETRY_MS } from './photos';
import schema from './schema';

/** A switch the swap's old-blob delete reads: set, that delete fails (a blob storage won't let go). */
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

async function person(t: T, subject: string, role: Doc<'profiles'>['role'] = 'member') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Test-Person`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: T0 - 86_400_000,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function world(full: Blob = new Blob(['full-bytes']), thumb: Blob = new Blob(['thumb'])) {
  const t = harness();
  const uploader = await person(t, 'uploader');
  const mod = await person(t, 'mod', 'moderator');
  const photoId = await t.run(async (ctx) =>
    ctx.db.insert('photos', {
      storageId: await ctx.storage.store(full),
      thumbStorageId: await ctx.storage.store(thumb),
      uploaderId: uploader.id,
      placeOnMap: false,
      createdAt: T0,
    }),
  );
  const set = (status: 'hidden' | 'removed' | 'visible') =>
    mod.as.mutation(api.moderation.setModerationStatus, {
      targetType: 'photo',
      targetId: photoId,
      status,
      reason: 'x',
    });
  return { t, uploader, mod, photoId, set };
}

const row = (t: T, id: Id<'photos'>) => t.run((ctx) => ctx.db.get(id) as Promise<Doc<'photos'>>);
/** A job's `jobFailures` row for a photo — what Machinery lists (`photoPurge`, `photoRotation`). */
const failureRow = (t: T, job: 'photoPurge' | 'photoRotation', id: Id<'photos'>) =>
  t.run((ctx) =>
    ctx.db
      .query('jobFailures')
      .withIndex('by_job_key', (q) => q.eq('job', job).eq('key', id))
      .first(),
  );
const urlOf = (t: T, id: string) => t.run((ctx) => ctx.storage.getUrl(id as Id<'_storage'>));
const bytesOf = (t: T, id: string) =>
  t.run(async (ctx) => (await ctx.storage.get(id as Id<'_storage'>))?.text() ?? null);
/**
 * Run the schedule a minute at a time, as a deployment's clock moves — never `runAllTimers`, whose
 * jumps put the watch ten minutes on while an action it scheduled is still mid-flight.
 */
async function stepThrough(t: T, minutes: number) {
  for (let i = 0; i < minutes; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
    await t.finishInProgressScheduledFunctions();
  }
}

/** Stored files no photo row names. */
const unreferenced = (t: T) =>
  t.run(async (ctx) => {
    const rows = await ctx.db.query('photos').collect();
    const named = new Set(rows.flatMap((p) => [p.storageId, p.thumbStorageId]));
    return (await ctx.db.system.query('_storage').collect())
      .map((f) => f._id as string)
      .filter((id) => !named.has(id));
  });
const storedCount = (t: T) =>
  t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length);
const pending = (t: T, fn: string) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query('_scheduled_functions').collect()).filter(
      (f) => f.name.includes(fn) && f.state.kind === 'pending',
    ),
  );
const rotationsScheduled = (t: T) => pending(t, 'rotateBlobs');
const watches = (t: T) => pending(t, 'rotationWatch');
/** Run what is due now (each zero-delay step), never the far retries. */
async function runDue(t: T) {
  await vi.advanceTimersByTimeAsync(1);
  await t.finishInProgressScheduledFunctions();
}

describe('the rotation through the public writes', () => {
  test('hide → rotate: new ids, same bytes, old addresses dead; restore serves the new copy', async () => {
    const { t, photoId, set } = await world();
    const before = await row(t, photoId);
    await set('hidden');
    await stepThrough(t, 90);
    const after = await row(t, photoId);
    expect(after.storageId).not.toBe(before.storageId);
    expect(after.thumbStorageId).not.toBe(before.thumbStorageId);
    expect(await urlOf(t, before.storageId)).toBeNull();
    expect(await urlOf(t, before.thumbStorageId)).toBeNull();
    expect(await bytesOf(t, after.storageId)).toBe('full-bytes');
    expect(await bytesOf(t, after.thumbStorageId)).toBe('thumb');
    expect(await storedCount(t)).toBe(2);

    await set('visible');
    await stepThrough(t, 90);
    const restored = await row(t, photoId);
    expect(restored.storageId).toBe(after.storageId); // never rotated back
    const reportId = await t.run(async (ctx) => {
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
      return ctx.db.insert('reports', {
        authorId: restored.uploaderId,
        waterBodyId,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: T0,
        reportTime: T0,
        source: 'native' as const,
        iceTypes: [],
        surfaceTags: [],
        photoIds: [photoId],
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: T0,
        updatedAt: T0,
      });
    });
    const served = await t.withIdentity({ subject: 'uploader' }).query(api.photos.getUrls, {
      reportId,
    });
    expect(served[0]?.url).toBe(await urlOf(t, after.storageId));
  });

  test('hide → restore before the rotation runs: nothing swapped, nothing orphaned or deleted twice', async () => {
    const { t, photoId, set } = await world();
    const before = await row(t, photoId);
    await set('hidden');
    await set('visible');
    await stepThrough(t, 90);
    const after = await row(t, photoId);
    expect(after.storageId).toBe(before.storageId);
    expect(await bytesOf(t, before.storageId)).toBe('full-bytes');
    expect(await storedCount(t)).toBe(2);
  });

  test('hide → remove schedules one rotation, not two', async () => {
    const { t, set } = await world();
    await set('hidden');
    await set('removed');
    expect(await rotationsScheduled(t)).toHaveLength(1);
  });

  test('the uploader’s withdrawal of a flagged photo rotates too', async () => {
    const { t, uploader, photoId } = await world();
    const skater = await person(t, 'skater');
    await skater.as.mutation(api.contentFlags.flag, {
      targetType: 'photo',
      targetId: photoId,
      reason: 'inappropriate',
    });
    const before = await row(t, photoId);
    await uploader.as.mutation(api.photos.remove, { photoId });
    await stepThrough(t, 90);
    expect((await row(t, photoId)).storageId).not.toBe(before.storageId);
  });

  test('a stale swap writes nothing: restored, re-pointed, or purged since the copies were made', async () => {
    const { t, photoId, set } = await world();
    const before = await row(t, photoId);
    const next = { storageId: 'x-new', thumbStorageId: 'y-new' };
    const old = { storageId: before.storageId, thumbStorageId: before.thumbStorageId };
    // Still up: never swapped.
    expect(await t.mutation(internal.photos.swapRotated, { photoId, old, next })).toBe('stale');
    await t.run((ctx) => ctx.db.patch(photoId, { moderationStatus: 'hidden' }));
    // Holding other ids: never swapped.
    expect(
      await t.mutation(internal.photos.swapRotated, {
        photoId,
        old: { ...old, storageId: 'elsewhere' },
        next,
      }),
    ).toBe('stale');
    await t.run((ctx) => ctx.db.patch(photoId, { purgedAt: T0 }));
    expect(await t.mutation(internal.photos.swapRotated, { photoId, old, next })).toBe('stale');
    expect((await row(t, photoId)).storageId).toBe(before.storageId);
    expect(await bytesOf(t, before.storageId)).toBe('full-bytes');
    void set;
  });

  test('a swap whose old blob won’t delete rolls back and drops its copies; its watch runs it again', async () => {
    const { t, photoId, set } = await world();
    const before = await row(t, photoId);
    failing.ids.add(before.storageId);
    await set('hidden');
    await runDue(t);
    // Rolled back: the row still points at what still answers; the copies are gone.
    expect((await row(t, photoId)).storageId).toBe(before.storageId);
    expect(await storedCount(t)).toBe(2);
    expect(await rotationsScheduled(t)).toHaveLength(0);
    const [watch] = await watches(t);
    expect(watch?.args[0]).toMatchObject({ photoId, oldStorageId: before.storageId });
    expect(
      Math.abs((watch?.scheduledTime ?? 0) - (T0 + (ROTATION_RETRY_MS[0] as number))),
    ).toBeLessThan(10);
    // Storage lets go: the watch finds it unrotated and runs it again, which lands.
    failing.ids.clear();
    // Run everything to its end: the watch runs it again, it lands, the next watch ends the chain.
    await stepThrough(t, 90);
    expect((await row(t, photoId)).storageId).not.toBe(before.storageId);
    expect(await urlOf(t, before.storageId)).toBeNull();
    expect(await watches(t)).toHaveLength(0);
  });

  test('a rotation the runtime kills is never dropped: the watch, a mutation, runs it again', async () => {
    const { t, photoId, set } = await world();
    const before = await row(t, photoId);
    await set('hidden');
    // The action never ran (a transient runtime failure is outside its own catch): cancel it.
    await t.run(async (ctx) => {
      for (const f of await ctx.db.system.query('_scheduled_functions').collect()) {
        if (f.name.includes('rotateBlobs')) await ctx.scheduler.cancel(f._id);
      }
    });
    await stepThrough(t, 90);
    expect((await row(t, photoId)).storageId).not.toBe(before.storageId);
    expect(await watches(t)).toHaveLength(0);
  });

  test('three misses park it; a parked rotation is retried daily, never dropped', async () => {
    const { t, photoId, set } = await world();
    const before = await row(t, photoId);
    failing.ids.add(before.storageId);
    await set('hidden');
    await runDue(t);
    for (const wait of ROTATION_RETRY_MS) {
      await vi.advanceTimersByTimeAsync(wait);
      await t.finishInProgressScheduledFunctions();
      await runDue(t);
    }
    const [parked] = await watches(t);
    expect(parked?.args[0]).toMatchObject({ attempts: 3, parkedAt: expect.any(Number) });
    expect(
      Math.abs((parked?.scheduledTime ?? 0) - (Date.now() + 24 * 60 * 60 * 1000)),
    ).toBeLessThan(10);
    expect(await storedCount(t)).toBe(2);
    // Machinery lists it, parked, by the photo (the watch's attempts, mirrored).
    expect(await failureRow(t, 'photoRotation', photoId)).toMatchObject({
      attempts: 3,
      parkedAt: expect.any(Number),
    });
    // Storage lets go: the daily retry lands, and the watch that sees it forgets the row.
    failing.ids.clear();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await stepThrough(t, 5);
    expect((await row(t, photoId)).storageId).not.toBe(before.storageId);
    // The next daily watch sees it landed and forgets the row.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await stepThrough(t, 5);
    expect(await failureRow(t, 'photoRotation', photoId)).toBeNull();
  });

  test('a photo past the rotation’s byte bound is never copied: it parks, stays hidden', async () => {
    const big = new Blob([new Uint8Array(ROTATE_MAX_BYTES + 1)]);
    const { t, photoId, set } = await world(big);
    const before = await row(t, photoId);
    await set('hidden');
    await runDue(t);
    expect((await row(t, photoId)).storageId).toBe(before.storageId);
    expect(await storedCount(t)).toBe(2);
    expect(await watches(t)).toHaveLength(1);
  }, 30_000);

  test('a photo with a blob gone: never half-rotated; marked, shown once on Machinery, the watch ends, no restore', async () => {
    const { t, photoId, set } = await world();
    const before = await row(t, photoId);
    await t.run((ctx) => ctx.storage.delete(before.thumbStorageId as Id<'_storage'>));
    await set('hidden');
    await stepThrough(t, 90);
    const after = await row(t, photoId);
    expect(after.storageId).toBe(before.storageId);
    expect(after.thumbStorageId).toBe(before.thumbStorageId);
    expect(after.bytesMissingAt).toEqual(expect.any(Number));
    expect(after.rotation).toBeUndefined();
    expect(await storedCount(t)).toBe(1); // the image alone: no copy of anything
    expect(await watches(t)).toHaveLength(0);
    const failures = await t.run((ctx) =>
      ctx.db
        .query('jobFailures')
        .withIndex('by_job_key', (q) => q.eq('job', 'photoRotation').eq('key', photoId))
        .collect(),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ errorClass: 'BytesMissing', parkedAt: expect.any(Number) });
    await expect(set('visible')).rejects.toThrow('nothing left to act on');
  });

  test('killed after a copy was stored but before it was recorded: the watch’s scan sweeps it', async () => {
    const { t, photoId, set } = await world();
    await set('hidden');
    // The run as the runtime left it: begun, one copy stored, nothing recorded, no swap.
    await t.run(async (ctx) => {
      for (const f of await ctx.db.system.query('_scheduled_functions').collect()) {
        if (f.name.includes('rotateBlobs')) await ctx.scheduler.cancel(f._id);
      }
    });
    await t.mutation(internal.photos.beginRotation, { photoId });
    const lost = await t.run((ctx) => ctx.storage.store(new Blob(['full-bytes'])));
    expect(await storedCount(t)).toBe(3);
    await stepThrough(t, 120);
    expect(await urlOf(t, lost)).toBeNull();
    expect(await unreferenced(t)).toEqual([]);
    expect((await row(t, photoId)).rotation).toBeUndefined();
  });

  test('killed after both copies were recorded, before the swap: swept, rotated again, nothing unreferenced', async () => {
    const { t, photoId, set } = await world();
    const before = await row(t, photoId);
    await set('hidden');
    await t.run(async (ctx) => {
      for (const f of await ctx.db.system.query('_scheduled_functions').collect()) {
        if (f.name.includes('rotateBlobs')) await ctx.scheduler.cancel(f._id);
      }
    });
    await t.mutation(internal.photos.beginRotation, { photoId });
    for (const bytes of ['full-bytes', 'thumb']) {
      const copy = await t.run((ctx) => ctx.storage.store(new Blob([bytes])));
      expect(await t.mutation(internal.photos.recordRotationCopy, { photoId, copy })).toBe(true);
    }
    expect((await row(t, photoId)).rotation?.copies).toHaveLength(2);
    // While it stands, no deleter takes the photo.
    expect(
      await t.run(async (ctx) => {
        const { photoHeld } = await import('./lib/photoAccess');
        return photoHeld(ctx, (await ctx.db.get(photoId)) as Doc<'photos'>);
      }),
    ).toBe(true);
    await stepThrough(t, 120);
    const after = await row(t, photoId);
    expect(after.storageId).not.toBe(before.storageId);
    expect(after.rotation).toBeUndefined();
    expect(await storedCount(t)).toBe(2);
    expect(await unreferenced(t)).toEqual([]);
  });

  test('the purge after a rotation deletes the new blobs', async () => {
    const { t, photoId, set } = await world();
    await set('removed');
    await stepThrough(t, 90);
    const rotated = await row(t, photoId);
    await t.mutation(internal.photoPurge.purgeDuePhotos, { now: T0 + PHOTO_PURGE_DELAY_MS + 1 });
    expect(await urlOf(t, rotated.storageId)).toBeNull();
    expect(await urlOf(t, rotated.thumbStorageId)).toBeNull();
    expect((await row(t, photoId)).purgedAt).toBeDefined();
    expect(await storedCount(t)).toBe(0);
  });
});

describe('the rotation record’s guards', () => {
  test('the swap takes only recorded copies; a photo restored mid-rotation is held until the watch sweeps', async () => {
    const { t, photoId, set } = await world();
    const before = await row(t, photoId);
    await set('hidden');
    await t.run(async (ctx) => {
      for (const f of await ctx.db.system.query('_scheduled_functions').collect()) {
        if (f.name.includes('rotateBlobs')) await ctx.scheduler.cancel(f._id);
      }
    });
    await t.mutation(internal.photos.beginRotation, { photoId });
    const a = await t.run((ctx) => ctx.storage.store(new Blob(['full-bytes'])));
    const b = await t.run((ctx) => ctx.storage.store(new Blob(['thumb'])));
    // Stored but never recorded: not the swap's to take.
    expect(
      await t.mutation(internal.photos.swapRotated, {
        photoId,
        old: { storageId: before.storageId, thumbStorageId: before.thumbStorageId },
        next: { storageId: a, thumbStorageId: b },
      }),
    ).toBe('stale');
    // Restored before the watch: up again, but the record stands, so no deleter takes it yet.
    await set('visible');
    const result = await t.run(async (ctx) => {
      const { deletePhotoAndBlobs } = await import('./lib/photoOrphans');
      return deletePhotoAndBlobs(ctx, (await ctx.db.get(photoId)) as Doc<'photos'>);
    });
    expect(result).toBe('held');
    await stepThrough(t, 30);
    expect((await row(t, photoId)).rotation).toBeUndefined();
    expect(await unreferenced(t)).toEqual([]);
  });
});
