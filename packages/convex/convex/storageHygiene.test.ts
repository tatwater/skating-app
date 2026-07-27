/**
 * Storage hygiene (N3). The interesting assertions aren't "it deletes things" — they're the two places
 * where the sweep must decline to act: a photo it can't prove is unreferenced, and a photo still inside
 * its grace window.
 */
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
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
        name: 'Shelburne Pond',
        type: 'lake' as const,
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

async function seedPhoto(
  t: ReturnType<typeof convexTest>,
  uploaderId: Id<'profiles'>,
  createdAt: number,
) {
  return (await t.run((ctx) =>
    ctx.db.insert('photos', {
      storageId: `blob-${createdAt}-${Math.round(createdAt % 1000)}`,
      thumbStorageId: `thumb-${createdAt}`,
      uploaderId,
      placeOnMap: false,
      createdAt,
    }),
  )) as Id<'photos'>;
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
  test('deletes an abandoned upload past the grace window', async () => {
    const t = harness();
    const userId = await seedUser(t, 'uploader');
    const orphan = await seedPhoto(t, userId, Date.now() - PHOTO_ORPHAN_GRACE_MS - HOUR_MS);

    const result = await t.mutation(internal.storageHygiene.sweepOrphanPhotos, {});
    expect(result).toMatchObject({ deleted: 1, skipped: 0 });
    expect(await t.run((ctx) => ctx.db.get(orphan))).toBeNull();
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
