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
import { BLOB_TAKEN, PHOTO_PURGE_DELAY_MS } from './lib/photoAccess';
import { ACTION_LIFETIME_MS, DOOMED_RETRY_MS, SCAN_PAGE } from './lib/photoFiles';
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

/** What Machinery shows for the stored-files job (`recurringJobs.health`), read as an admin. */
async function machineryRow(t: T) {
  const admin = await person(t, `admin-${Math.random()}`, 'admin');
  const { jobs } = await admin.as.query(api.recurringJobs.health, {});
  return jobs.find((j) => j.job === 'rotate or release a photo’s files');
}

/** The stored-files ledger, every row. */
const ledger = (t: T) => t.run((ctx) => ctx.db.query('photoFiles').collect());
/** A doomed file's Machinery row. */
const fileFailure = (t: T, storageId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('jobFailures')
      .withIndex('by_job_key', (q) => q.eq('job', 'photoRotation').eq('key', `file:${storageId}`))
      .first(),
  );
/**
 * Advance `later` (past the attempt's lifetime) and run the photo's watch by hand, until it lands —
 * the reconcile as a later attempt, hours on, meets it.
 */
async function reconcileLater(t: T, photoId: Id<'photos'>, later: number) {
  await vi.advanceTimersByTimeAsync(later);
  const photo = await row(t, photoId);
  for (let i = 0; i < 5; i++) {
    const out = await t.mutation(internal.photos.rotationWatch, {
      photoId,
      oldStorageId: photo.storageId,
      oldThumbStorageId: photo.thumbStorageId,
    });
    await t.finishInProgressScheduledFunctions();
    if (out === 'landed') return;
    await vi.advanceTimersByTimeAsync(60_000);
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

  test('a stale swap writes nothing: restored, re-pointed, purged, or copies not this attempt’s', async () => {
    const { t, photoId } = await world();
    const before = await row(t, photoId);
    const old = { storageId: before.storageId, thumbStorageId: before.thumbStorageId };
    await t.run((ctx) => ctx.db.patch(photoId, { moderationStatus: 'hidden' }));
    const begun = await t.mutation(internal.photos.beginRotation, { photoId });
    if (begun.kind !== 'go') throw new Error('not begun');
    const a = await t.run((ctx) => ctx.storage.store(new Blob(['full-bytes'])));
    const b = await t.run((ctx) => ctx.storage.store(new Blob(['thumb'])));
    const next = { storageId: a, thumbStorageId: b };
    // Stored but never recorded: not the swap's to take.
    const swap = (o = old) =>
      t.mutation(internal.photos.swapRotated, { attemptId: begun.attemptId, old: o, next });
    expect(await swap()).toBe('stale');
    for (const copy of [a, b]) {
      await t.mutation(internal.photos.recordRotationCopy, { attemptId: begun.attemptId, copy });
    }
    // Holding other ids: never swapped.
    expect(await swap({ ...old, storageId: 'elsewhere' })).toBe('stale');
    // Up again: never swapped.
    await t.run((ctx) => ctx.db.patch(photoId, { moderationStatus: 'visible' }));
    expect(await swap()).toBe('stale');
    expect((await row(t, photoId)).storageId).toBe(before.storageId);
    expect(await bytesOf(t, before.storageId)).toBe('full-bytes');
    // The attempt's leftovers are owed and swept once it ends: nothing unreferenced.
    await t.mutation(internal.photos.endRotation, { attemptId: begun.attemptId });
    expect(await unreferenced(t)).toEqual([]);
    expect(await ledger(t)).toEqual([]);
  });

  test('an old file that won’t delete is owed: the photo rotates, the file is retried to the end', async () => {
    const { t, photoId, set } = await world();
    const before = await row(t, photoId);
    failing.ids.add(before.storageId);
    await set('hidden');
    await runDue(t);
    // Swapped: the row names the copies; the old image is owed a deletion, never forgotten.
    expect((await row(t, photoId)).storageId).not.toBe(before.storageId);
    expect(await ledger(t)).toEqual([
      expect.objectContaining({ storageId: before.storageId, state: 'doomed', attempts: 1 }),
    ]);
    expect(await unreferenced(t)).toEqual([before.storageId]);
    // Three failures park it (Machinery lists it), then daily — the watch stays until it is gone.
    for (const wait of DOOMED_RETRY_MS) {
      await vi.advanceTimersByTimeAsync(wait);
      await t.finishInProgressScheduledFunctions();
    }
    await stepThrough(t, 2);
    expect((await ledger(t))[0]).toMatchObject({ attempts: 3, parkedAt: expect.any(Number) });
    expect(await fileFailure(t, before.storageId)).toMatchObject({ parkedAt: expect.any(Number) });
    expect(await machineryRow(t)).toMatchObject({ failing: 0, parked: 1 });
    expect(await watches(t)).toHaveLength(1);
    failing.ids.clear();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await stepThrough(t, 5);
    expect(await urlOf(t, before.storageId)).toBeNull();
    expect(await ledger(t)).toEqual([]);
    expect(await fileFailure(t, before.storageId)).toBeNull();
    expect(await machineryRow(t)).toMatchObject({ failing: 0, parked: 0 });
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

  test('a rotation that can’t land parks: three misses, then daily, never dropped', async () => {
    const big = new Blob([new Uint8Array(ROTATE_MAX_BYTES + 1)]);
    const { t, photoId, set } = await world(big);
    await set('hidden');
    await runDue(t);
    for (const wait of ROTATION_RETRY_MS) {
      await vi.advanceTimersByTimeAsync(wait);
      await t.finishInProgressScheduledFunctions();
      await runDue(t);
    }
    const [parked] = await watches(t);
    expect(parked?.args[0]).toMatchObject({ attempts: 3, parkedAt: expect.any(Number) });
    expect(await failureRow(t, 'photoRotation', photoId)).toMatchObject({
      attempts: 3,
      parkedAt: expect.any(Number),
    });
    expect(await machineryRow(t)).toMatchObject({ failing: 0, parked: 1 });
    expect(await storedCount(t)).toBe(2);
  }, 30_000);

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
    expect(await ledger(t)).toEqual([]);
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

  test('killed after a copy was stored but before it was recorded: its window’s search finds it', async () => {
    const { t, photoId } = await world();
    await t.run((ctx) => ctx.db.patch(photoId, { moderationStatus: 'hidden' }));
    const begun = await t.mutation(internal.photos.beginRotation, { photoId });
    if (begun.kind !== 'go') throw new Error('not begun');
    const lost = await t.run((ctx) => ctx.storage.store(new Blob(['full-bytes'])));
    expect(await unreferenced(t)).toEqual([lost]);
    // Its action is dead once its lifetime passes; a later attempt, hours on, finds nothing of it lost.
    await reconcileLater(t, photoId, 3 * 60 * 60 * 1000);
    expect(await urlOf(t, lost)).toBeNull();
    expect(await unreferenced(t)).toEqual([]);
  });

  test('killed after both copies were recorded, before the swap: released, rotated again, nothing unreferenced', async () => {
    const { t, photoId, set } = await world();
    const before = await row(t, photoId);
    await set('hidden');
    await t.run(async (ctx) => {
      for (const f of await ctx.db.system.query('_scheduled_functions').collect()) {
        if (f.name.includes('rotateBlobs')) await ctx.scheduler.cancel(f._id);
      }
    });
    const begun = await t.mutation(internal.photos.beginRotation, { photoId });
    if (begun.kind !== 'go') throw new Error('not begun');
    for (const bytes of ['full-bytes', 'thumb']) {
      const copy = await t.run((ctx) => ctx.storage.store(new Blob([bytes])));
      await t.mutation(internal.photos.recordRotationCopy, { attemptId: begun.attemptId, copy });
    }
    // Reserved while recorded: no write takes their ids.
    const copies = (await ledger(t)).map((r) => r.storageId);
    await expect(
      t.withIdentity({ subject: 'uploader' }).mutation(api.photos.create, {
        storageId: copies[0] as Id<'_storage'>,
        thumbStorageId: copies[1] as Id<'_storage'>,
        placeOnMap: false,
      }),
    ).rejects.toThrow(BLOB_TAKEN);
    await stepThrough(t, 30);
    expect((await row(t, photoId)).storageId).not.toBe(before.storageId);
    expect(await storedCount(t)).toBe(2);
    expect(await unreferenced(t)).toEqual([]);
    expect(await ledger(t)).toEqual([]);
  });

  test('a legacy row sharing the source: the rotation copies for its own row and never deletes the shared file', async () => {
    const { t, photoId, uploader, set } = await world();
    const before = await row(t, photoId);
    const twin = await t.run((ctx) =>
      ctx.db.insert('photos', {
        storageId: before.storageId,
        thumbStorageId: before.thumbStorageId,
        uploaderId: uploader.id,
        placeOnMap: false,
        createdAt: T0,
        moderationStatus: 'hidden',
      }),
    );
    await set('hidden');
    await stepThrough(t, 30);
    expect((await row(t, photoId)).storageId).not.toBe(before.storageId);
    expect(await bytesOf(t, before.storageId)).toBe('full-bytes');
    expect((await row(t, twin)).storageId).toBe(before.storageId);
    expect(await unreferenced(t)).toEqual([]);
    expect(await ledger(t)).toEqual([]);
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

describe('the attempt window’s search', () => {
  test('paged to the end: a lost copy behind more than a page of other uploads is found; the others untouched', async () => {
    const { t, photoId } = await world();
    await t.run((ctx) => ctx.db.patch(photoId, { moderationStatus: 'hidden' }));
    const begun = await t.mutation(internal.photos.beginRotation, { photoId });
    if (begun.kind !== 'go') throw new Error('not begun');
    const others = await t.run(async (ctx) => {
      const out: string[] = [];
      for (let i = 0; i < SCAN_PAGE + 50; i++)
        out.push(await ctx.storage.store(new Blob([`u${i}`])));
      return out;
    });
    const lost = await t.run((ctx) => ctx.storage.store(new Blob(['full-bytes'])));
    vi.setSystemTime(T0 + ACTION_LIFETIME_MS + 1);
    let passes = 0;
    for (; passes < 5; passes++) {
      const done = await t.run(async (ctx) => {
        const { reconcileAttempt } = await import('./lib/photoFiles');
        const a = await ctx.db.get(begun.attemptId);
        return a ? reconcileAttempt(ctx, a, Date.now()) : true;
      });
      if (done) break;
    }
    expect(passes).toBeGreaterThan(0); // more than one page
    expect(await urlOf(t, lost)).toBeNull();
    for (const id of others.slice(0, 3)) expect(await urlOf(t, id)).not.toBeNull();
  });
});
