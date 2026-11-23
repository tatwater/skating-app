/**
 * Storage hygiene (A03). The interesting assertions aren't "it deletes things" — they're the two places
 * where the sweep must decline to act: a photo it can't prove is unreferenced, and a photo still inside
 * its grace window.
 */
import { seasonOf, seasonStartMs } from '@skating/core';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import { describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { PHOTO_ORPHAN_GRACE_MS } from './lib/photoOrphans';
import * as recurringWork from './lib/recurringWork';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);

const HOUR_MS = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 15, 14, 0, 0);

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
        states: ['VT'],
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

describe('purgeLastSeasonNotifications (A08 §1.5)', () => {
  test('deletes every row from before the current season’s start, read or not, and nothing newer', async () => {
    const t = harness();
    const userId = await seedUser(t, 'u');
    const seasonStart = seasonStartMs(seasonOf(T0));
    const insert = (createdAt: number, readAt?: number) =>
      t.run((ctx) =>
        ctx.db.insert('notifications', {
          userId,
          type: 'report_rated',
          payload: {},
          ...(readAt !== undefined ? { readAt } : {}),
          createdAt,
        }),
      );
    await insert(seasonStart - 1); // last season, unread
    await insert(seasonStart - 30 * 24 * HOUR_MS, seasonStart - 29 * 24 * HOUR_MS); // last season, read
    const kept = await insert(seasonStart); // the boundary itself is this season
    const keptToo = await insert(T0, T0 + HOUR_MS);

    const res = await t.mutation(internal.storageHygiene.purgeLastSeasonNotifications, { now: T0 });
    expect(res).toMatchObject({ deleted: 2, truncated: false, seasonStart });
    const left = await t.run((ctx) => ctx.db.query('notifications').collect());
    expect(left.map((n) => n._id).sort()).toEqual([kept, keptToo].sort());
  });

  test('a pass that fills its cap schedules the next one rather than waiting a day', async () => {
    const t = harness();
    const userId = await seedUser(t, 'u');
    const seasonStart = seasonStartMs(seasonOf(T0));
    await t.run(async (ctx) => {
      for (let i = 0; i < 501; i++) {
        await ctx.db.insert('notifications', {
          userId,
          type: 'report_rated',
          payload: {},
          createdAt: seasonStart - 1 - i,
        });
      }
    });
    // Fake timers for the `runAfter(0)` continuation — the same reason the departed-photo sweep's
    // test below needs them.
    vi.useFakeTimers();
    try {
      const first = await t.mutation(internal.storageHygiene.purgeLastSeasonNotifications, {
        now: T0,
      });
      expect(first).toMatchObject({ deleted: 500, truncated: true });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    expect(await t.run((ctx) => ctx.db.query('notifications').collect())).toHaveLength(0);
  });
});

/** A lap of the orphan walk, then the photo settlement it owes to (D258). */
async function sweepOrphans(t: ReturnType<typeof convexTest>) {
  const result = await t.mutation(internal.storageHygiene.sweepOrphanPhotos, {});
  await t.mutation(internal.erasure.settleOwed, {});
  return result;
}

async function seedHazard(
  t: ReturnType<typeof convexTest>,
  userId: Id<'profiles'>,
  bodyId: Id<'waterBodies'>,
  photoIds: Id<'photos'>[],
  at: number,
) {
  return t.run((ctx) =>
    ctx.db.insert('hazards', {
      waterBodyId: bodyId,
      createdByUserId: userId,
      type: 'open_water' as const,
      geometryKind: 'point_radius' as const,
      geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
      radiusMeters: 25,
      bbox: { minLat: 0.49, minLng: 0.49, maxLat: 0.51, maxLng: 0.51 },
      photoIds,
      status: 'active' as const,
      moderationStatus: 'visible' as const,
      firstReportedAt: at,
      lastConfirmedAt: at,
      confirmCount: 0,
      goneCount: 0,
      createdAt: at,
    }),
  );
}

describe('sweepOrphanPhotos (D258: a lap from a saved position, owed to the settlement)', () => {
  test('deletes an abandoned upload past the grace window — row and both blobs', async () => {
    const t = harness();
    const userId = await seedUser(t, 'uploader');
    const orphan = await seedPhoto(t, userId, Date.now() - PHOTO_ORPHAN_GRACE_MS - HOUR_MS);
    const row = await t.run((ctx) => ctx.db.get(orphan));

    const result = await sweepOrphans(t);
    expect(result).toMatchObject({ examined: 1, owed: 1, failed: 0, lapDone: true });
    expect(await t.run((ctx) => ctx.db.get(orphan))).toBeNull();
    expect(await t.run((ctx) => ctx.storage.getUrl(row?.storageId as Id<'_storage'>))).toBeNull();
    expect(
      await t.run((ctx) => ctx.storage.getUrl(row?.thumbStorageId as Id<'_storage'>)),
    ).toBeNull();
  });

  /**
   * PR #29 review (Greptile P1, security): the row is the **only** pointer to those two blobs — this
   * sweep is what finds them — so deleting it after a failed `storage.delete` leaves private image
   * bytes that nothing in the system can name again. The settlement keeps the row, stripped and
   * marked `erasedAt`; every later lap tries the blob again, directly, until it goes.
   */
  test('a photo whose blob cannot be reclaimed is gone; its file is owed on the ledger and retried (B01-5e)', async () => {
    const t = harness();
    const userId = await seedUser(t, 'uploader');
    const stuck = await seedPhoto(t, userId, Date.now() - PHOTO_ORPHAN_GRACE_MS - HOUR_MS);
    await t.run((ctx) => ctx.db.patch(stuck, { storageId: 'not-a-storage-id' }));
    await sweepOrphans(t);
    expect(await t.run((ctx) => ctx.db.get(stuck))).toBeNull();
    const owed = await t.run((ctx) =>
      ctx.db
        .query('photoFiles')
        .withIndex('by_storage', (q) => q.eq('storageId', 'not-a-storage-id'))
        .first(),
    );
    expect(owed).toMatchObject({ state: 'doomed', attempts: 1 });
  });

  test('leaves a photo still inside its grace window alone — it may be mid-submission', async () => {
    const t = harness();
    const userId = await seedUser(t, 'uploader');
    const fresh = await seedPhoto(t, userId, Date.now() - HOUR_MS);

    const result = await sweepOrphans(t);
    expect(result).toMatchObject({ examined: 0, owed: 0, lapDone: true });
    expect(await t.run((ctx) => ctx.db.get(fresh))).not.toBeNull();
  });

  /**
   * The soundness case. `reports.update` can attach a photo long after either row was created, and a
   * pre-A10 report photo carries no back-link — so the walk owes it, and the settlement, reading the
   * uploader's Reports, keeps it.
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

    const result = await sweepOrphans(t);
    expect(result).toMatchObject({ examined: 2, owed: 2 });
    expect(await t.run((ctx) => ctx.db.get(attached))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(orphan))).toBeNull();
  });

  test('a photo referenced by a hazard is kept too', async () => {
    const t = harness();
    const userId = await seedUser(t, 'uploader');
    const bodyId = await seedBody(t);
    const old = Date.now() - PHOTO_ORPHAN_GRACE_MS - HOUR_MS;
    const attached = await seedPhoto(t, userId, old);
    await seedHazard(t, userId, bodyId, [attached], old);

    await sweepOrphans(t);
    expect(await t.run((ctx) => ctx.db.get(attached))).not.toBeNull();
  });

  test('a photo a hazard filed mid-walk shows survives: the settlement reads the hazards to the end, beside the delete', async () => {
    const t = harness();
    const userId = await seedUser(t, 'uploader');
    const bodyId = await seedBody(t);
    const photo = await seedPhoto(t, userId, Date.now() - PHOTO_ORPHAN_GRACE_MS - HOUR_MS);

    // The walk owes it: nothing cheap says it is shown.
    expect(await t.mutation(internal.storageHygiene.sweepOrphanPhotos, {})).toMatchObject({
      owed: 1,
    });
    // Before the settlement runs, a hazard is filed showing it.
    await seedHazard(t, userId, bodyId, [photo], Date.now());
    await t.mutation(internal.erasure.settleOwed, {});
    expect(await t.run((ctx) => ctx.db.get(photo))).not.toBeNull();
  });

  /**
   * The bug this fixes: the walk read the oldest 500 photos past grace every day and passed the ones
   * in use without marking them — so 600 old photos in use hid every newer orphan for ever.
   */
  test('600 old photos in use, then newer orphans: the orphans are reached and removed in one run, and nothing in use goes', async () => {
    vi.useFakeTimers();
    try {
      const t = harness();
      const userId = await seedUser(t, 'uploader');
      const bodyId = await seedBody(t);
      const old = Date.now() - PHOTO_ORPHAN_GRACE_MS - 400 * 24 * HOUR_MS;
      const reportId = await t.run((ctx) =>
        ctx.db.insert('reports', {
          authorId: userId,
          waterBodyId: bodyId,
          point: { lat: 0.5, lng: 0.5 },
          skateEndTime: old,
          reportTime: old,
          source: 'native' as const,
          iceTypes: [],
          surfaceTags: [],
          photoIds: [],
          hazardIdsCreated: [],
          moderationStatus: 'visible' as const,
          createdAt: old,
          updatedAt: old,
        }),
      );
      // In use through the back-link a Report keeps (`photos.reportId`) — 600 of them, oldest.
      await t.run(async (ctx) => {
        for (let i = 0; i < 600; i++) {
          await ctx.db.insert('photos', {
            storageId: `kept-${i}`,
            thumbStorageId: `kept-thumb-${i}`,
            uploaderId: userId,
            placeOnMap: false,
            reportId,
            createdAt: old + i,
          });
        }
      });
      const orphans = [];
      for (let i = 0; i < 3; i++) {
        orphans.push(await seedPhoto(t, userId, Date.now() - PHOTO_ORPHAN_GRACE_MS - HOUR_MS - i));
      }

      // A lap small enough to need its chain: 100 photos a pass.
      await t.mutation(internal.storageHygiene.sweepOrphanPhotos, { limit: 100 });
      await t.finishAllScheduledFunctions(vi.runAllTimers, 100);

      for (const id of orphans) expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
      expect(
        await t.run((ctx) =>
          ctx.db
            .query('photos')
            .withIndex('by_report', (q) => q.eq('reportId', reportId))
            .collect(),
        ),
      ).toHaveLength(600);
      const lap = await t.run((ctx) => ctx.db.query('jobPositions').collect());
      expect(lap[0]).toMatchObject({ job: 'orphanPhotos', lapsCompleted: 1 });
      expect(lap[0]?.value).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a lap owns its chain: a cron tick stands down while it runs, and a superseded pass stops', async () => {
    const t = harness();
    const userId = await seedUser(t, 'uploader');
    for (let i = 0; i < 3; i++) {
      await seedPhoto(t, userId, Date.now() - PHOTO_ORPHAN_GRACE_MS - HOUR_MS - i);
    }
    const first = await t.mutation(internal.storageHygiene.sweepOrphanPhotos, { limit: 1 });
    expect(first).toMatchObject({ examined: 1, lapDone: false });
    expect(await t.mutation(internal.storageHygiene.sweepOrphanPhotos, {})).toEqual({
      skipped: 'a lap is running',
    });
    expect(
      await t.mutation(internal.storageHygiene.sweepOrphanPhotos, { run: 'someone-else' }),
    ).toEqual({ skipped: 'superseded' });
    // A lap whose chain died (its lease ran out) is taken over where it stopped.
    await t.run(async (ctx) => {
      const lap = await ctx.db.query('jobPositions').first();
      if (lap) await ctx.db.patch(lap._id, { leaseUntil: Date.now() - 1 });
    });
    expect(await t.mutation(internal.storageHygiene.sweepOrphanPhotos, {})).toMatchObject({
      examined: 2,
      lapDone: true,
    });
  });

  test("a failing photo that is gone by the next lap: the lap's end forgets its failure", async () => {
    const t = harness();
    const userId = await seedUser(t, 'uploader');
    const bodyId = await seedBody(t);
    const kept = await seedPhoto(t, userId, Date.now() - PHOTO_ORPHAN_GRACE_MS - HOUR_MS);
    await seedHazard(t, userId, bodyId, [kept], Date.now());
    // A photo that failed in an earlier lap and has since been deleted by its uploader.
    await t.run((ctx) =>
      ctx.db.insert('jobFailures', {
        job: 'orphanPhotos',
        key: 'a-photo-since-deleted',
        attempts: 3,
        errorClass: 'Error',
        firstFailedAt: Date.now() - 3 * 24 * HOUR_MS,
        lastFailedAt: Date.now() - 24 * HOUR_MS,
        parkedAt: Date.now() - 24 * HOUR_MS,
      }),
    );
    expect(await sweepOrphans(t)).toMatchObject({ examined: 1, failed: 0, lapDone: true });
    expect(await t.run((ctx) => ctx.db.query('jobFailures').collect())).toEqual([]);
  });
});

describe('sweepOrphanPhotos under failure (D258)', () => {
  const RUNS = 5;

  test('over any photos and any that always fail: each healthy photo is examined once a lap; a failing one is counted once a lap, parked at its third, and freed by the lap after it heals', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 1, max: RUNS }),
        async (failing, healsAfter) => {
          vi.restoreAllMocks();
          const t = harness();
          const userId = await seedUser(t, 'uploader');
          const bodyId = await seedBody(t);
          // Every photo is in use (shown by a hazard), so it survives every lap and is examined again.
          const ids: Id<'photos'>[] = [];
          for (const [i] of failing.entries()) {
            ids.push(await seedPhoto(t, userId, Date.now() - PHOTO_ORPHAN_GRACE_MS - HOUR_MS - i));
          }
          await seedHazard(t, userId, bodyId, ids, Date.now());
          const poison = new Set(ids.filter((_, i) => failing[i]).map(String));
          const real = recurringWork.clearFailure;
          const calls = vi
            .spyOn(recurringWork, 'clearFailure')
            .mockImplementation(async (ctx, job, key) => {
              if (job === 'orphanPhotos' && poison.has(key)) throw new Error('poison');
              return real(ctx, job, key);
            });
          for (let run = 1; run <= RUNS; run++) {
            if (run > healsAfter) poison.clear();
            calls.mockClear();
            await sweepOrphans(t);
            for (const id of ids) {
              const tries = calls.mock.calls.filter(
                ([, job, key]) => job === 'orphanPhotos' && key === id,
              );
              // Once a lap, every photo — failing or not.
              expect(tries).toHaveLength(1);
              const row = await t.run((ctx) =>
                ctx.db
                  .query('jobFailures')
                  .withIndex('by_job_key', (q) => q.eq('job', 'orphanPhotos').eq('key', id))
                  .first(),
              );
              const failedRuns = failing[ids.indexOf(id)] ? Math.min(run, healsAfter) : 0;
              if (failedRuns === 0 || run > healsAfter) expect(row).toBeNull();
              else {
                expect(row?.attempts).toBe(failedRuns);
                expect(row?.parkedAt !== undefined).toBe(failedRuns >= 3);
              }
            }
            // Nothing in use is ever deleted.
            for (const id of ids) expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
          }
          vi.restoreAllMocks();
        },
      ),
      { numRuns: 15 },
    );
  }, 120_000);
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

  /**
   * D258: a bundle whose blob can't be deleted keeps its row, and enough of them at the head of the
   * oldest-first read held every tick's page. Each tick now starts after the last one stopped.
   */
  test('bundles whose blob will not delete never hold the page: the next tick starts after them', async () => {
    const t = harness();
    const userId = await seedUser(t, 'exporter');
    const stuck: Id<'dataExports'>[] = [];
    for (let i = 0; i < 2; i++) {
      stuck.push(
        (await t.run((ctx) =>
          ctx.db.insert('dataExports', {
            userId,
            status: 'ready' as const,
            storageId: 'not-a-storage-id',
            requestedAt: Date.now() - 100 * HOUR_MS,
            expiresAt: Date.now() - 10 * HOUR_MS + i,
          }),
        )) as Id<'dataExports'>,
      );
    }
    const healthy = (await t.run((ctx) =>
      ctx.db.insert('dataExports', {
        userId,
        status: 'ready' as const,
        requestedAt: Date.now() - 100 * HOUR_MS,
        expiresAt: Date.now() - HOUR_MS,
      }),
    )) as Id<'dataExports'>;

    expect(await t.mutation(internal.storageHygiene.sweepExpiredExports, { limit: 2 })).toEqual({
      deleted: 0,
      retained: 2,
    });
    // The next tick reaches the bundle behind them.
    expect(await t.mutation(internal.storageHygiene.sweepExpiredExports, { limit: 2 })).toEqual({
      deleted: 1,
      retained: 0,
    });
    expect(await t.run((ctx) => ctx.db.get(healthy))).toBeNull();
    for (const id of stuck) expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
    // And it wraps: the stuck ones come round again.
    expect(await t.mutation(internal.storageHygiene.sweepExpiredExports, { limit: 2 })).toEqual({
      deleted: 0,
      retained: 2,
    });
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

  /**
   * The A06d carve-out from D66, and the reason it is a carve-out rather than an exception.
   *
   * A report photo documents **conditions**, which expire with their season. An access photo
   * documents **infrastructure** — a parking lot looks the same next November — so the argument that
   * retires the first does not reach the second. It stays under A03 deletion the whole time, by the
   * D62 second amendment's redact-don't-erase: the departed skater's photo of a gravel pull-off is
   * reassigned to anonymous, not destroyed, because there is no person in a picture of a pull-off.
   *
   * `durablePhotoIds` is what makes it true, and it was the half of this phase with no test — the
   * failure would have been a cron quietly deleting the access layer's photos one season later.
   */
  test('keeps an access-point photo, which is infrastructure rather than a condition', async () => {
    const t = harness();
    const userId = await seedTombstone(t, 'departed');
    const pullOff = await seedPhoto(t, userId, lastSeason());
    const morningShot = await seedPhoto(t, userId, lastSeason());
    const waterBodyId = await seedBody(t);
    const putInId = await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId,
        coord: { lat: 0.5, lng: 0.5 },
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: lastSeason(),
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert('accessPhotos', {
        targetType: 'put_in' as const,
        putInId,
        photoId: pullOff,
        uploaderId: userId,
        createdAt: lastSeason(),
      }),
    );

    const result = await t.mutation(internal.storageHygiene.expireDepartedPhotos, { userId });

    expect(await t.run((ctx) => ctx.db.get(pullOff))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(morningShot))).toBeNull();
    expect(result).toMatchObject({ deleted: 1, kept: 1 });
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

  test('a canceled deletion restores an account whose photos are on no clock at all', async () => {
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

describe('pruneForecastCache (A06c §2.5b, self-review 2026-08-10)', () => {
  const HOUR = 3_600_000;
  function row(forecastBucketMs: number) {
    return {
      samplePointKey: '44.5,-73.2',
      forecastBucketMs,
      hours: [
        {
          startMs: forecastBucketMs,
          temperatureC: -4,
          windSpeedKph: 8,
          precipitationMm: 0,
          snowfallCm: 0,
        },
      ],
      fetchedAt: forecastBucketMs,
    };
  }

  /**
   * The index for this sweep shipped before the sweep did. Without it the table grows by one row per
   * sample point per hour, for ever — and every one of those rows is *unaddressable* the moment its
   * bucket passes, since the cache key contains the bucket.
   */
  test('deletes rows whose hour bucket has passed and keeps the current one', async () => {
    const t = harness();
    const now = Date.now();
    const stale = (await t.run((ctx) =>
      ctx.db.insert('weatherForecastCache', row(now - 48 * HOUR)),
    )) as Id<'weatherForecastCache'>;
    const live = (await t.run((ctx) =>
      ctx.db.insert('weatherForecastCache', row(now)),
    )) as Id<'weatherForecastCache'>;

    expect(await t.mutation(internal.storageHygiene.pruneForecastCache, {})).toMatchObject({
      deleted: 1,
    });
    expect(await t.run((ctx) => ctx.db.get(stale))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(live))).not.toBeNull();
  });

  test('reports truncation so a backlog is visible rather than silently half-swept', async () => {
    const t = harness();
    const result = await t.mutation(internal.storageHygiene.pruneForecastCache, {});
    expect(result).toMatchObject({ deleted: 0, truncated: false });
  });
});
