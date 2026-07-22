import geospatial from '@convex-dev/geospatial/test';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function convexTestWithGeo() {
  const t = convexTest(schema, modules);
  geospatial.register(t);
  geospatial.register(t, 'adminAreasGeo');
  return t;
}

const POLYGON = {
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
};

/** Seed a canonical water body (needed as a report's target). */
async function seedBody(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        externalId: 'osm/1',
        name: 'Lake Morey',
        type: 'lake',
        polygon: POLYGON,
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.5, lng: 0.5 },
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  const body = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === 'osm/1',
  );
  if (!body) throw new Error('seed failed');
  return body._id;
}

/** Attach `photoIds` to a fresh (public, D13) report by `asAuthor`. */
async function seedReport(
  asAuthor: ReturnType<ReturnType<typeof convexTest>['withIdentity']>,
  waterBodyId: Id<'waterBodies'>,
  photoIds: Id<'photos'>[],
) {
  return asAuthor.mutation(api.reports.create, {
    waterBodyId,
    skateEndTime: SKATE,
    photoIds,
  });
}

const NOTIF_PREFS = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyFulfilled: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: false,
  greatReportNearby: false,
};

async function seedUser(t: ReturnType<typeof convexTest>, subject: string) {
  await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return t.withIdentity({ subject });
}

/** Store a throwaway blob and return its storage id (convex-test's in-memory storage). */
async function storeBlob(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) => ctx.storage.store(new Blob(['img'])));
}

const COORD = { lat: 44.2, lng: -72.5 };
const SKATE = Date.UTC(2026, 0, 10);

describe('photos.generateUploadUrl', () => {
  test('requires authentication', async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.photos.generateUploadUrl, {})).rejects.toThrow(
      /not authenticated/i,
    );
  });

  test('returns an upload URL for a signed-in user', async () => {
    const t = convexTest(schema, modules);
    const asUser = await seedUser(t, 'clerk_a');
    expect(typeof (await asUser.mutation(api.photos.generateUploadUrl, {}))).toBe('string');
  });
});

describe('photos.create (D42 coord gate)', () => {
  test('retains coord only when placeOnMap is true', async () => {
    const t = convexTest(schema, modules);
    const asUser = await seedUser(t, 'clerk_a');
    const storageId = await storeBlob(t);
    const thumbStorageId = await storeBlob(t);

    const pinned = await asUser.mutation(api.photos.create, {
      storageId,
      thumbStorageId,
      coord: COORD,
      takenAt: SKATE,
      placeOnMap: true,
    });
    expect((await t.run((ctx) => ctx.db.get(pinned)))?.coord).toEqual(COORD);
  });

  test('drops coord when placeOnMap is false, even if a coord is passed (leak guard)', async () => {
    const t = convexTest(schema, modules);
    const asUser = await seedUser(t, 'clerk_a');
    const storageId = await storeBlob(t);

    const notPinned = await asUser.mutation(api.photos.create, {
      storageId,
      thumbStorageId: storageId,
      coord: COORD, // passed, but must be dropped server-side
      placeOnMap: false,
    });
    const photo = await t.run((ctx) => ctx.db.get(notPinned));
    expect(photo?.coord).toBeUndefined();
    expect(photo?.placeOnMap).toBe(false);
  });

  test('requires authentication', async () => {
    const t = convexTest(schema, modules);
    const storageId = await storeBlob(t);
    await expect(
      t.mutation(api.photos.create, { storageId, thumbStorageId: storageId, placeOnMap: false }),
    ).rejects.toThrow(/not authenticated/i);
  });
});

describe('photos.getUrls (report-gated, D13/D42)', () => {
  test('resolves full + thumb serving URLs and echoes safe metadata', async () => {
    const t = convexTestWithGeo();
    const bodyId = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    const storageId = await storeBlob(t);
    const thumbStorageId = await storeBlob(t);
    const photoId = await asUser.mutation(api.photos.create, {
      storageId,
      thumbStorageId,
      caption: 'north bay',
      coord: COORD,
      placeOnMap: true,
    });
    const reportId = await seedReport(asUser, bodyId, [photoId]);
    const [row] = await asUser.query(api.photos.getUrls, { reportId });
    expect(row?.photoId).toEqual(photoId);
    expect(typeof row?.url).toBe('string');
    expect(typeof row?.thumbUrl).toBe('string');
    expect(row?.caption).toBe('north bay');
    expect(row?.coord).toEqual(COORD);
  });

  test('any viewer can resolve URLs for a public report (all reports public, D13)', async () => {
    const t = convexTestWithGeo();
    const bodyId = await seedBody(t);
    const asAuthor = await seedUser(t, 'clerk_author');
    const storageId = await storeBlob(t);
    const photoId = await asAuthor.mutation(api.photos.create, {
      storageId,
      thumbStorageId: storageId,
      coord: COORD,
      placeOnMap: true,
    });
    const reportId = await seedReport(asAuthor, bodyId, [photoId]);

    // The author, another signed-in user, and an anon caller all resolve the media — reports are public.
    expect((await asAuthor.query(api.photos.getUrls, { reportId })).length).toBe(1);
    const asOther = await seedUser(t, 'clerk_other');
    expect((await asOther.query(api.photos.getUrls, { reportId })).length).toBe(1);
    expect((await t.query(api.photos.getUrls, { reportId })).length).toBe(1);
  });

  test('returns [] for a hidden (moderated) report', async () => {
    const t = convexTestWithGeo();
    const bodyId = await seedBody(t);
    const asAuthor = await seedUser(t, 'clerk_author');
    const storageId = await storeBlob(t);
    const photoId = await asAuthor.mutation(api.photos.create, {
      storageId,
      thumbStorageId: storageId,
      placeOnMap: false,
    });
    const reportId = await seedReport(asAuthor, bodyId, [photoId]);
    await t.run((ctx) => ctx.db.patch(reportId, { moderationStatus: 'hidden' }));
    expect(await asAuthor.query(api.photos.getUrls, { reportId })).toEqual([]);
  });

  test('skips a missing photo row', async () => {
    const t = convexTestWithGeo();
    const bodyId = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    const storageId = await storeBlob(t);
    const photoId = await asUser.mutation(api.photos.create, {
      storageId,
      thumbStorageId: storageId,
      placeOnMap: false,
    });
    const reportId = await seedReport(asUser, bodyId, [photoId]);
    // Delete the row → getUrls should skip it (returns empty, not throw).
    await t.run((ctx) => ctx.db.delete(photoId));
    expect(await asUser.query(api.photos.getUrls, { reportId })).toEqual([]);
  });

  test('returns a null URL for a photo whose stored file is gone (guarded)', async () => {
    const t = convexTestWithGeo();
    const bodyId = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    const storageId = await storeBlob(t);
    const photoId = await asUser.mutation(api.photos.create, {
      storageId,
      thumbStorageId: storageId,
      placeOnMap: false,
    });
    const reportId = await seedReport(asUser, bodyId, [photoId]);
    // Delete the underlying blob but keep the row → serving URL resolves to null.
    await t.run((ctx) => ctx.storage.delete(storageId));
    const [row] = await asUser.query(api.photos.getUrls, { reportId });
    expect(row?.url).toBeNull();
  });
});

describe('photos.remove (orphan cleanup)', () => {
  test('the uploader deletes their photo row + stored blobs', async () => {
    const t = convexTest(schema, modules);
    const asUser = await seedUser(t, 'clerk_a');
    const storageId = await storeBlob(t);
    const thumbStorageId = await storeBlob(t);
    const photoId = await asUser.mutation(api.photos.create, {
      storageId,
      thumbStorageId,
      placeOnMap: false,
    });
    await asUser.mutation(api.photos.remove, { photoId });
    expect(await t.run((ctx) => ctx.db.get(photoId))).toBeNull();
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).toBeNull();
    expect(await t.run((ctx) => ctx.storage.getUrl(thumbStorageId))).toBeNull();
  });

  test('a non-owner cannot remove someone else’s photo', async () => {
    const t = convexTest(schema, modules);
    const asOwner = await seedUser(t, 'clerk_owner');
    const storageId = await storeBlob(t);
    const photoId = await asOwner.mutation(api.photos.create, {
      storageId,
      thumbStorageId: storageId,
      placeOnMap: false,
    });
    const asOther = await seedUser(t, 'clerk_other');
    await expect(asOther.mutation(api.photos.remove, { photoId })).rejects.toThrow(
      /not your photo/i,
    );
    expect(await t.run((ctx) => ctx.db.get(photoId))).not.toBeNull(); // untouched
  });

  test('still deletes the row when a blob is already gone (concurrent teardown reclaim)', async () => {
    const t = convexTest(schema, modules);
    const asUser = await seedUser(t, 'clerk_a');
    const storageId = await storeBlob(t);
    const thumbStorageId = await storeBlob(t);
    const photoId = await asUser.mutation(api.photos.create, {
      storageId,
      thumbStorageId,
      placeOnMap: false,
    });
    // Simulate a racing `removeBlob` having already reclaimed one blob.
    await t.run((ctx) => ctx.storage.delete(storageId));
    await asUser.mutation(api.photos.remove, { photoId }); // must not throw on the missing blob
    expect(await t.run((ctx) => ctx.db.get(photoId))).toBeNull(); // row still cleaned up
    expect(await t.run((ctx) => ctx.storage.getUrl(thumbStorageId))).toBeNull();
  });

  test('is idempotent — removing a since-deleted photo is a no-op', async () => {
    const t = convexTest(schema, modules);
    const asUser = await seedUser(t, 'clerk_a');
    const storageId = await storeBlob(t);
    const photoId = await asUser.mutation(api.photos.create, {
      storageId,
      thumbStorageId: storageId,
      placeOnMap: false,
    });
    await t.run((ctx) => ctx.db.delete(photoId));
    // A double-cleanup (or a since-deleted photo) must not throw.
    await asUser.mutation(api.photos.remove, { photoId });
    expect(await t.run((ctx) => ctx.db.get(photoId))).toBeNull();
  });

  test('requires authentication', async () => {
    const t = convexTest(schema, modules);
    const asUser = await seedUser(t, 'clerk_a');
    const storageId = await storeBlob(t);
    const photoId = await asUser.mutation(api.photos.create, {
      storageId,
      thumbStorageId: storageId,
      placeOnMap: false,
    });
    await expect(t.mutation(api.photos.remove, { photoId })).rejects.toThrow(/not authenticated/i);
  });
});

describe('photos.removeBlob (storage-only cleanup)', () => {
  test('deletes an uploaded-but-unattached blob', async () => {
    const t = convexTest(schema, modules);
    const asUser = await seedUser(t, 'clerk_a');
    const storageId = await storeBlob(t);
    await asUser.mutation(api.photos.removeBlob, { storageId });
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).toBeNull();
  });

  test('is idempotent — removing a since-deleted blob is a no-op', async () => {
    const t = convexTest(schema, modules);
    const asUser = await seedUser(t, 'clerk_a');
    const storageId = await storeBlob(t);
    await t.run((ctx) => ctx.storage.delete(storageId));
    await asUser.mutation(api.photos.removeBlob, { storageId }); // must not throw
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).toBeNull();
  });

  test('requires authentication', async () => {
    const t = convexTest(schema, modules);
    const storageId = await storeBlob(t);
    await expect(t.mutation(api.photos.removeBlob, { storageId })).rejects.toThrow(
      /not authenticated/i,
    );
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).not.toBeNull(); // untouched
  });
});

/** Seed an under-18 (read-only, D41) profile and return its identity. */
async function seedMinor(t: ReturnType<typeof convexTest>, subject: string) {
  await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'private' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(new Date().getUTCFullYear() - 16, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return t.withIdentity({ subject });
}

describe('photos — minor gate (D41)', () => {
  test('a minor can neither mint an upload URL nor create a photo row', async () => {
    const t = convexTest(schema, modules);
    const asMinor = await seedMinor(t, 'clerk_minor');
    await expect(asMinor.mutation(api.photos.generateUploadUrl, {})).rejects.toThrow(/minor/i);
    const storageId = await storeBlob(t);
    await expect(
      asMinor.mutation(api.photos.create, {
        storageId,
        thumbStorageId: storageId,
        placeOnMap: false,
      }),
    ).rejects.toThrow(/minor/i);
    // Nothing minted: the blob is still there but no photo row exists.
    expect(await t.run((ctx) => ctx.db.query('photos').collect())).toEqual([]);
  });
});
