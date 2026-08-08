/**
 * Storage hygiene (N3). The interesting assertions aren't "it deletes things" — they're the two places
 * where the sweep must decline to act: a photo it can't prove is unreferenced, and a photo still inside
 * its grace window.
 */
import { seasonOf, seasonStartMs } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { PHOTO_ORPHAN_GRACE_MS } from './lib/photoOrphans';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);

const HOUR_MS = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 15, 14, 0, 0);

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

const EMPTY_SUMMARY = {
  hours: 0,
  peakTempC: null,
  minTempC: null,
  hoursNearFreezing: 0,
  hoursAboveFreezing: 0,
  nightsBelowFreezing: null,
  hoursOfSun: 0,
  totalPrecipMm: 0,
  rainMm: 0,
  snowfallCm: 0,
  maxSnowDepthM: null,
  maxWindKph: null,
  maxWindGustKph: null,
  windRunKm: 0,
  freezingDegreeHours: 0,
  thawDegreeHours: 0,
  insolationWhM2: 0,
  longestFreezeRunHours: 0,
  freezeThawCycles: 0,
};

async function seedUser(t: ReturnType<typeof convexTest>, subject: string) {
  return (await t.run((ctx) =>
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
      createdAt: T0,
    }),
  )) as Id<'profiles'>;
}

async function seedBody(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm' as const,
        externalId: 'osm/hygiene-1',
        osmId: 'osm/hygiene-1',
        name: 'Shelburne Pond',
        type: 'lakePond' as const,
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
      },
    ],
  });
  const bodies = await t.run((ctx) => ctx.db.query('waterBodies').collect());
  // biome-ignore lint/style/noNonNullAssertion: the import above just wrote it.
  return bodies[0]!._id;
}

/**
 * Seeds a photo with **real stored blobs**, not id-shaped strings. The fake ids these used to carry
 * made the sweep tests silently weaker than they read: `storage.delete` on a nonsense id throws, the
 * old code swallowed that, and the assertion "the row is gone" passed without a byte ever moving.
 */
async function seedPhoto(
  t: ReturnType<typeof convexTest>,
  uploaderId: Id<'profiles'>,
  createdAt: number,
) {
  return t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([`photo-${createdAt}`]));
    const thumbStorageId = await ctx.storage.store(new Blob([`thumb-${createdAt}`]));
    return ctx.db.insert('photos', {
      storageId,
      thumbStorageId,
      uploaderId,
      placeOnMap: false,
      createdAt,
    });
  });
}

describe('pruneWeatherCache', () => {
  test('deletes rows whose hour bucket has passed and keeps the current one', async () => {
    const t = harness();
    const now = Date.now();
    const stale = (await t.run((ctx) =>
      ctx.db.insert('weatherCache', {
        samplePointKey: '44.5,-73.2',
        windowStartMs: now - 100 * HOUR_MS,
        windowEndBucketMs: now - 48 * HOUR_MS,
        summary: EMPTY_SUMMARY,
        fetchedAt: now - 48 * HOUR_MS,
      }),
    )) as Id<'weatherCache'>;
    const live = (await t.run((ctx) =>
      ctx.db.insert('weatherCache', {
        samplePointKey: '44.5,-73.2',
        windowStartMs: now - 100 * HOUR_MS,
        windowEndBucketMs: now,
        summary: EMPTY_SUMMARY,
        fetchedAt: now,
      }),
    )) as Id<'weatherCache'>;

    expect(await t.mutation(internal.storageHygiene.pruneWeatherCache, {})).toMatchObject({
      deleted: 1,
    });
    expect(await t.run((ctx) => ctx.db.get(stale))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(live))).not.toBeNull();
  });

  /**
   * The retention margin. A row one hour into the past is already unreachable — the cache key contains
   * the hour bucket — but it's kept anyway, so clock skew can never delete a row a caller is about to
   * read. This test is what stops someone "optimizing" the retention down to an hour.
   */
  test('keeps a row from the previous hour, despite it being unreachable', async () => {
    const t = harness();
    const now = Date.now();
    const recent = (await t.run((ctx) =>
      ctx.db.insert('weatherCache', {
        samplePointKey: '44.5,-73.2',
        windowStartMs: now - 100 * HOUR_MS,
        windowEndBucketMs: now - 2 * HOUR_MS,
        summary: EMPTY_SUMMARY,
        fetchedAt: now - 2 * HOUR_MS,
      }),
    )) as Id<'weatherCache'>;

    await t.mutation(internal.storageHygiene.pruneWeatherCache, {});
    expect(await t.run((ctx) => ctx.db.get(recent))).not.toBeNull();
  });
});

describe('sweepOrphanPhotos', () => {
  test('deletes an abandoned upload past the grace window — row and both blobs', async () => {
    const t = harness();
    const userId = await seedUser(t, 'uploader');
    const orphan = await seedPhoto(t, userId, Date.now() - PHOTO_ORPHAN_GRACE_MS - HOUR_MS);
    const row = await t.run((ctx) => ctx.db.get(orphan));

    const result = await t.mutation(internal.storageHygiene.sweepOrphanPhotos, {});
    expect(result).toMatchObject({ deleted: 1, skipped: 0, retained: 0 });
    expect(await t.run((ctx) => ctx.db.get(orphan))).toBeNull();
    expect(await t.run((ctx) => ctx.storage.getUrl(row?.storageId as Id<'_storage'>))).toBeNull();
    expect(
      await t.run((ctx) => ctx.storage.getUrl(row?.thumbStorageId as Id<'_storage'>)),
    ).toBeNull();
  });

  /**
   * PR #29 review (Greptile P1, security): the row is the **only** pointer to those two blobs — this
   * sweep is what finds them — so deleting it after a failed `storage.delete` leaves private image
   * bytes that nothing in the system can name again. Not a leak a later job cleans up: a leak no later
   * job can see.
   *
   * The unreclaimable blob here is a storage id that storage refuses to resolve. That's a stand-in for
   * the general failure and not a perfect one — convex-test can't make a *present* blob undeletable —
   * but it drives the real branch: `deleteStoredBlob` reports a failure, the row is kept, and the
   * photo comes back to the front of tomorrow's oldest-first sweep.
   */
  test('a photo whose blob cannot be reclaimed keeps its row for the next tick', async () => {
    const t = harness();
    const userId = await seedUser(t, 'uploader');
    const stuck = await seedPhoto(t, userId, Date.now() - PHOTO_ORPHAN_GRACE_MS - HOUR_MS);
    await t.run((ctx) => ctx.db.patch(stuck, { storageId: 'not-a-storage-id' }));

    expect(await t.mutation(internal.storageHygiene.sweepOrphanPhotos, {})).toMatchObject({
      deleted: 0,
      retained: 1,
    });
    expect(await t.run((ctx) => ctx.db.get(stuck))).not.toBeNull();

    // And it is retried rather than parked: the next tick tries again, and succeeds once the id resolves.
    const real = await t.run((ctx) => ctx.storage.store(new Blob(['recovered'])));
    await t.run((ctx) => ctx.db.patch(stuck, { storageId: real }));
    expect(await t.mutation(internal.storageHygiene.sweepOrphanPhotos, {})).toMatchObject({
      deleted: 1,
      retained: 0,
    });
    expect(await t.run((ctx) => ctx.db.get(stuck))).toBeNull();
    expect(await t.run((ctx) => ctx.storage.getUrl(real))).toBeNull();
  });

  test('leaves a photo still inside its grace window alone — it may be mid-submission', async () => {
    const t = harness();
    const userId = await seedUser(t, 'uploader');
    const fresh = await seedPhoto(t, userId, Date.now() - HOUR_MS);

    const result = await t.mutation(internal.storageHygiene.sweepOrphanPhotos, {});
    expect(result).toMatchObject({ scanned: 0, deleted: 0 });
    expect(await t.run((ctx) => ctx.db.get(fresh))).not.toBeNull();
  });

  /**
   * The soundness case. `reports.update` can attach a photo long after either row was created, so a
   * creation-time reference window would miss it — which is exactly why `referencedPhotoIds` scans by
   * *author* instead. An old photo newly attached to an old report must survive the sweep.
   */
  test('keeps a photo attached to a report, however long after the fact it was attached', async () => {
    const t = harness();
    const userId = await seedUser(t, 'uploader');
    const bodyId = await seedBody(t);
    const old = Date.now() - PHOTO_ORPHAN_GRACE_MS - 90 * 24 * HOUR_MS;
    const attached = await seedPhoto(t, userId, old);
    const orphan = await seedPhoto(t, userId, old + 1000);

    await t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId: userId,
        waterBodyId: bodyId,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: old,
        reportTime: old,
        source: 'native' as const,
        iceTypes: [],
        surfaceTags: [],
        photoIds: [attached],
        hazardIdsCreated: [],
        moderationStatus: 'visible' as const,
        createdAt: old,
        updatedAt: Date.now(), // attached in an edit, decades after either row was written
      }),
    );

    const result = await t.mutation(internal.storageHygiene.sweepOrphanPhotos, {});
    expect(result).toMatchObject({ deleted: 1 });
    expect(await t.run((ctx) => ctx.db.get(attached))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(orphan))).toBeNull();
  });

  test('a photo referenced by a hazard is kept too', async () => {
    const t = harness();
    const userId = await seedUser(t, 'uploader');
    const bodyId = await seedBody(t);
    const old = Date.now() - PHOTO_ORPHAN_GRACE_MS - HOUR_MS;
    const attached = await seedPhoto(t, userId, old);

    await t.run((ctx) =>
      ctx.db.insert('hazards', {
        waterBodyId: bodyId,
        createdByUserId: userId,
        type: 'open_water' as const,
        geometryKind: 'point_radius' as const,
        geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
        radiusMeters: 25,
        bbox: { minLat: 0.49, minLng: 0.49, maxLat: 0.51, maxLng: 0.51 },
        photoIds: [attached],
        status: 'active' as const,
        moderationStatus: 'visible' as const,
        firstReportedAt: old,
        lastConfirmedAt: old,
        confirmCount: 0,
        goneCount: 0,
        createdAt: old,
      }),
    );

    await t.mutation(internal.storageHygiene.sweepOrphanPhotos, {});
    expect(await t.run((ctx) => ctx.db.get(attached))).not.toBeNull();
  });
});

describe('sweepExpiredExports', () => {
  test('deletes an expired bundle row', async () => {
    const t = harness();
    const userId = await seedUser(t, 'exporter');
    const expired = (await t.run((ctx) =>
      ctx.db.insert('dataExports', {
        userId,
        status: 'ready' as const,
        requestedAt: Date.now() - 100 * HOUR_MS,
        readyAt: Date.now() - 99 * HOUR_MS,
        expiresAt: Date.now() - HOUR_MS,
      }),
    )) as Id<'dataExports'>;
    const live = (await t.run((ctx) =>
      ctx.db.insert('dataExports', {
        userId,
        status: 'ready' as const,
        requestedAt: Date.now(),
        expiresAt: Date.now() + 100 * HOUR_MS,
      }),
    )) as Id<'dataExports'>;

    expect(await t.mutation(internal.storageHygiene.sweepExpiredExports, {})).toEqual({
      deleted: 1,
      retained: 0,
    });
    expect(await t.run((ctx) => ctx.db.get(expired))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(live))).not.toBeNull();
  });

  /** The crash case: an action that died before writing its storageId leaves a row saying "building". */
  test('sweeps a stuck building row once it expires', async () => {
    const t = harness();
    const userId = await seedUser(t, 'exporter');
    const stuck = (await t.run((ctx) =>
      ctx.db.insert('dataExports', {
        userId,
        status: 'building' as const,
        requestedAt: Date.now() - 100 * HOUR_MS,
        expiresAt: Date.now() - HOUR_MS,
      }),
    )) as Id<'dataExports'>;

    await t.mutation(internal.storageHygiene.sweepExpiredExports, {});
    expect(await t.run((ctx) => ctx.db.get(stuck))).toBeNull();
  });
});

/**
 * D66 — a departed skater's photos split on evidential value, expiring with their season. Every one of
 * these is about an irreversible deletion, so they are written as "what survives" rather than "what
 * goes".
 */
describe('expireDepartedPhotos (D66)', () => {
  const lastSeason = () => seasonStartMs(seasonOf(Date.now())) - HOUR_MS;

  /** A tombstoned account — the only state this sweep touches. */
  async function seedTombstone(t: ReturnType<typeof convexTest>, subject: string) {
    const userId = await seedUser(t, subject);
    await t.run((ctx) => ctx.db.patch(userId, { status: 'deleted', deletedAt: Date.now() }));
    return userId;
  }

  /** A hazard carrying one photo — the evidential case the split exists to protect. */
  async function attachToHazard(
    t: ReturnType<typeof convexTest>,
    userId: Id<'profiles'>,
    photoId: Id<'photos'>,
  ) {
    const waterBodyId = await seedBody(t);
    return t.run((ctx) =>
      ctx.db.insert('hazards', {
        waterBodyId,
        type: 'open_water' as const,
        geometryKind: 'point_radius' as const,
        geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
        radiusMeters: 40,
        bbox: { minLat: 0.4, minLng: 0.4, maxLat: 0.6, maxLng: 0.6 },
        createdByUserId: userId,
        photoIds: [photoId],
        status: 'active' as const,
        moderationStatus: 'visible' as const,
        firstReportedAt: lastSeason(),
        lastConfirmedAt: lastSeason(),
        confirmCount: 0,
        goneCount: 0,
        createdAt: lastSeason(),
      }),
    );
  }

  test('keeps a hazard photo and expires everything else from a past season', async () => {
    const t = harness();
    const userId = await seedTombstone(t, 'departed');
    const evidence = await seedPhoto(t, userId, lastSeason());
    const morningShot = await seedPhoto(t, userId, lastSeason());
    await attachToHazard(t, userId, evidence);

    const result = await t.mutation(internal.storageHygiene.expireDepartedPhotos, { userId });

    // A picture of an open lead is worth more than any sentence describing one.
    expect(await t.run((ctx) => ctx.db.get(evidence))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(morningShot))).toBeNull();
    expect(result).toMatchObject({ deleted: 1, kept: 1, done: true });
  });

  test('leaves this season alone — the clock is the season boundary, not the deletion', async () => {
    const t = harness();
    const userId = await seedTombstone(t, 'departed');
    // Somebody who left in January keeps their January pictures until July. This is exactly why the
    // rule cannot be a finalize stage: finalization lands mid-season by construction.
    const thisSeason = await seedPhoto(t, userId, Date.now() - HOUR_MS);

    await t.mutation(internal.storageHygiene.expireDepartedPhotos, { userId });
    expect(await t.run((ctx) => ctx.db.get(thisSeason))).not.toBeNull();
  });

  test('never touches a living account, however old the photo', async () => {
    const t = harness();
    const userId = await seedUser(t, 'still-here');
    const old = await seedPhoto(t, userId, lastSeason());

    const result = await t.mutation(internal.storageHygiene.expireDepartedPhotos, { userId });
    // Aging never removes anything. Erasure has exactly one trigger, and it is a person leaving.
    expect(await t.run((ctx) => ctx.db.get(old))).not.toBeNull();
    expect(result).toMatchObject({ deleted: 0 });
  });

  test('a cancelled deletion restores an account whose photos are on no clock at all', async () => {
    const t = harness();
    const userId = await seedTombstone(t, 'departed');
    const photoId = await seedPhoto(t, userId, lastSeason());
    await t.run((ctx) => ctx.db.patch(userId, { status: 'active', deletedAt: undefined }));

    await t.mutation(internal.storageHygiene.expireDepartedPhotos, { userId });
    expect(await t.run((ctx) => ctx.db.get(photoId))).not.toBeNull();
  });

  test('the account sweep hands every tombstone to the per-account job', async () => {
    const t = harness();
    const departed = await seedTombstone(t, 'departed');
    await seedUser(t, 'still-here');
    const photoId = await seedPhoto(t, departed, lastSeason());

    // Fake timers only for this test: the fan-out is `scheduler.runAfter(0)`, which convex-test leaves
    // pending until a timer fires — without them `finishAllScheduledFunctions` drains nothing and the
    // assertion reads a photo the job never reached, failing as a plausible-looking "it didn't work".
    vi.useFakeTimers();
    try {
      await t.mutation(internal.storageHygiene.sweepDepartedPhotos, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    expect(await t.run((ctx) => ctx.db.get(photoId))).toBeNull();
  });

  /**
   * The completion marker, and why it isn't an optimization. Without it the daily cron re-paginated
   * every tombstone's whole photo table forever, so the cost grew with every departure the app had
   * ever had — and nothing in the result would have looked wrong.
   */
  test('marks an account done for the season and stops offering it to the sweep', async () => {
    const t = harness();
    const userId = await seedTombstone(t, 'departed');
    await seedPhoto(t, userId, lastSeason());

    await t.mutation(internal.storageHygiene.expireDepartedPhotos, { userId });
    const marked = await t.run((ctx) => ctx.db.get(userId));
    expect(marked?.photosExpiredForSeason).toBe(seasonOf(Date.now()));

    // The second tick's range excludes it — the whole point.
    const second = await t.mutation(internal.storageHygiene.sweepDepartedPhotos, {});
    expect(second.accounts).toBe(0);
  });

  test('an unmarked tombstone is what the sweep queue actually contains', async () => {
    const t = harness();
    await seedTombstone(t, 'never-swept');
    const first = await t.mutation(internal.storageHygiene.sweepDepartedPhotos, {});
    // `photosExpiredForSeason` is absent until the first pass, and a Convex index is not sparse —
    // `undefined` sorts before every number, so the never-swept accounts are exactly what a
    // `lt(currentSeason)` range returns. No backfill, no migration.
    expect(first.accounts).toBe(1);
  });

  test('a stale marker comes back round when the boundary turns over', async () => {
    const t = harness();
    const userId = await seedTombstone(t, 'departed');
    // Swept last season; this season's boundary has since passed, so there is new work.
    await t.run((ctx) =>
      ctx.db.patch(userId, { photosExpiredForSeason: seasonOf(Date.now()) - 1 }),
    );
    const result = await t.mutation(internal.storageHygiene.sweepDepartedPhotos, {});
    expect(result.accounts).toBe(1);
  });
});
