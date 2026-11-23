/**
 * **A storage id is not a key anyone can turn** (B01-5e, the review's blocker). A blob belongs to at
 * most one photo row; `photos.create` refuses an id any row holds; `photos.removeBlob` takes only a
 * fresh upload no row names; no delete takes a blob another row still names; and no read hands an id
 * out (the export ships bytes, never ids). Each attack as the review reproduced it, and its variants:
 * the thumbnail's id alone, an id from a purged tombstone, another person's id.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { BLOB_NOT_FOUND, BLOB_TAKEN } from './lib/photoAccess';
import { deletePhotoAndBlobs } from './lib/photoOrphans';
import { BLOB_ATTACHED, PENDING_UPLOAD_MS } from './photos';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const T0 = Date.UTC(2026, 11, 2, 12);
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
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

async function person(t: T, subject: string) {
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
      role: 'member' as const,
      status: 'active' as const,
      createdAt: T0 - 86_400_000,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

const blob = (t: T, bytes = 'bytes') => t.run((ctx) => ctx.storage.store(new Blob([bytes])));
const alive = (t: T, id: string) =>
  t.run(async (ctx) => (await ctx.storage.getUrl(id as Id<'_storage'>)) !== null);

/** A hidden photo of the uploader's, its two blob ids as an old export handed them out. */
async function heldPhoto(t: T, uploaderId: Id<'profiles'>, over: Partial<Doc<'photos'>> = {}) {
  const storageId = await blob(t, 'full');
  const thumbStorageId = await blob(t, 'thumb');
  const photoId = await t.run((ctx) =>
    ctx.db.insert('photos', {
      storageId,
      thumbStorageId,
      uploaderId,
      placeOnMap: false,
      createdAt: T0,
      moderationStatus: 'hidden',
      ...over,
    }),
  );
  return { photoId, storageId, thumbStorageId };
}

const created = (as: ReturnType<T['withIdentity']>, storageId: string, thumbStorageId: string) =>
  as.mutation(api.photos.create, {
    storageId: storageId as Id<'_storage'>,
    thumbStorageId: thumbStorageId as Id<'_storage'>,
    placeOnMap: false,
  });

describe('attack A: removeBlob on a held photo’s blob', () => {
  test('the image’s id, the thumbnail’s, another person’s: each refused, the bytes kept', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const stranger = await person(t, 'stranger');
    const { storageId, thumbStorageId } = await heldPhoto(t, uploader.id);
    for (const [who, id] of [
      [uploader, storageId],
      [uploader, thumbStorageId],
      [stranger, storageId],
    ] as const) {
      await expect(who.as.mutation(api.photos.removeBlob, { storageId: id })).rejects.toThrow(
        BLOB_ATTACHED,
      );
      expect(await alive(t, id)).toBe(true);
    }
  });

  test('a purged tombstone’s id names no file: a no-op, never another row’s bytes', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const { storageId } = await heldPhoto(t, uploader.id, { purgedAt: T0 });
    await t.run((ctx) => ctx.storage.delete(storageId));
    await uploader.as.mutation(api.photos.removeBlob, { storageId });
    expect(await alive(t, storageId)).toBe(false);
  });

  test('a fresh upload no photo uses is removed; one older than a form’s life is refused', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const fresh = await blob(t);
    await uploader.as.mutation(api.photos.removeBlob, { storageId: fresh });
    expect(await alive(t, fresh)).toBe(false);
    const old = await blob(t);
    vi.setSystemTime(T0 + PENDING_UPLOAD_MS + 10);
    await expect(uploader.as.mutation(api.photos.removeBlob, { storageId: old })).rejects.toThrow(
      BLOB_ATTACHED,
    );
    expect(await alive(t, old)).toBe(true);
  });
});

describe('attack B: a second row on a held photo’s blobs', () => {
  test('both ids, the image’s alone, the thumbnail’s alone, another person’s: refused; remove can’t reach them', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const stranger = await person(t, 'stranger');
    const { storageId, thumbStorageId } = await heldPhoto(t, uploader.id);
    const loose = await blob(t, 'loose');
    for (const [who, a, b] of [
      [uploader, storageId, thumbStorageId],
      [uploader, storageId, loose],
      [uploader, loose, thumbStorageId],
      [stranger, storageId, thumbStorageId],
    ] as const) {
      await expect(created(who.as, a, b)).rejects.toThrow(BLOB_TAKEN);
    }
    expect(await alive(t, storageId)).toBe(true);
    expect(await alive(t, thumbStorageId)).toBe(true);
  });

  test('the same id twice, or an id naming no file, is refused; a fresh pair is a photo', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const a = await blob(t, 'a');
    const b = await blob(t, 'b');
    await expect(created(uploader.as, a, a)).rejects.toThrow(BLOB_TAKEN);
    await t.run((ctx) => ctx.storage.delete(b));
    await expect(created(uploader.as, a, b)).rejects.toThrow(BLOB_NOT_FOUND);
    const c = await blob(t, 'c');
    expect(await created(uploader.as, a, c)).toEqual(expect.any(String));
  });

  test('a row written before the rule that shares a blob: its delete leaves the other row’s bytes', async () => {
    const t = harness();
    const uploader = await person(t, 'uploader');
    const { photoId, storageId, thumbStorageId } = await heldPhoto(t, uploader.id);
    const twin = await t.run((ctx) =>
      ctx.db.insert('photos', {
        storageId,
        thumbStorageId: thumbStorageId,
        uploaderId: uploader.id,
        placeOnMap: false,
        createdAt: T0,
        moderationStatus: 'visible',
      }),
    );
    const out = await t.run(async (ctx) =>
      deletePhotoAndBlobs(ctx, (await ctx.db.get(twin)) as Doc<'photos'>),
    );
    expect(out).toBe('deleted');
    expect(await alive(t, storageId)).toBe(true);
    expect(await alive(t, thumbStorageId)).toBe(true);
    expect(await t.run((ctx) => ctx.db.get(photoId))).not.toBeNull();
  });
});
