/**
 * The determinate orphan check (`photoReconcile`).
 *
 * The property under test is the one the capped fast path can't offer: **it terminates with a correct
 * answer** for an uploader of any size, without ever deleting a referenced photo. Page sizes are forced
 * to 1 so the multi-transaction continuation — the whole reason this job exists — is what's exercised,
 * rather than a single page that happens to fit.
 */
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { PHOTO_ORPHAN_GRACE_MS } from './lib/photoOrphans';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

const T0 = Date.UTC(2026, 0, 15, 14, 0, 0);
/** Comfortably past the orphan grace, so a photo is a deletion candidate. */
const OLD = T0 - PHOTO_ORPHAN_GRACE_MS - 24 * 3600_000;

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

function harness() {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  return convexTest(schema, modules);
}

afterEach(() => {
  vi.useRealTimers();
});

async function seedUploader(t: ReturnType<typeof convexTest>, subject: string) {
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
        externalId: 'osm/reconcile-1',
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

/**
 * A photo with **real stored blobs**, not id-shaped strings — the trap `storageHygiene.test.ts`
 * documents. `storage.delete` on a nonsense id throws, the row is then kept as the only pointer to
 * blobs that don't exist, and an assertion reading "the photo is gone" fails for a reason that has
 * nothing to do with the logic under test.
 */
async function seedPhoto(
  t: ReturnType<typeof convexTest>,
  uploaderId: Id<'profiles'>,
  label: string,
  createdAt = OLD,
) {
  return t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([`photo-${label}`]));
    const thumbStorageId = await ctx.storage.store(new Blob([`thumb-${label}`]));
    return ctx.db.insert('photos', {
      storageId,
      thumbStorageId,
      uploaderId,
      caption: 'a caption',
      placeOnMap: false,
      createdAt,
    });
  });
}

/** Drive the staged job the way the scheduler would, forcing the continuation path. */
async function reconcile(
  t: ReturnType<typeof convexTest>,
  uploaderId: Id<'profiles'>,
  pageSize = 1,
) {
  await t.mutation(internal.photoReconcile.reconcileUploaderPhotos, { uploaderId, pageSize });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe('photoReconcile — the answer the capped scan cannot give', () => {
  test('deletes an unreferenced photo and keeps referenced ones, across pages', async () => {
    const t = harness();
    const uploader = await seedUploader(t, 'prolific');
    const bodyId = await seedBody(t);

    const orphan = await seedPhoto(t, uploader, 'orphan');
    const onReport = await seedPhoto(t, uploader, 'on-report');
    const onHazard = await seedPhoto(t, uploader, 'on-hazard');

    await t.run((ctx) =>
      ctx.db.insert('reports', {
        waterBodyId: bodyId,
        authorId: uploader,
        point: { lat: 0.5, lng: 0.5 },
        skateEndTime: OLD,
        reportTime: OLD,
        source: 'native' as const,
        iceTypes: ['black_ice' as const],
        surfaceTags: [],
        photoIds: [onReport],
        moderationStatus: 'visible' as const,
        hazardIdsCreated: [],
        createdAt: OLD,
        updatedAt: OLD,
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert('hazards', {
        waterBodyId: bodyId,
        type: 'pressure_ridge' as const,
        geometryKind: 'point_radius' as const,
        geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
        bbox: { minLat: 0.4, minLng: 0.4, maxLat: 0.6, maxLng: 0.6 },
        createdByUserId: uploader,
        photoIds: [onHazard],
        status: 'active' as const,
        moderationStatus: 'visible' as const,
        firstReportedAt: OLD,
        lastConfirmedAt: OLD,
        confirmCount: 0,
        goneCount: 0,
        createdAt: OLD,
      }),
    );

    await reconcile(t, uploader);

    expect(await t.run((ctx) => ctx.db.get(orphan))).toBeNull(); // named by nothing
    expect(await t.run((ctx) => ctx.db.get(onReport))).not.toBeNull(); // named by a report
    expect(await t.run((ctx) => ctx.db.get(onHazard))).not.toBeNull(); // named by a hazard
  });

  test('leaves no marks behind — the flag is scratch, not state', async () => {
    const t = harness();
    const uploader = await seedUploader(t, 'prolific');
    const young = await seedPhoto(t, uploader, 'young', T0 - 60_000); // inside the grace

    await reconcile(t, uploader);

    const photo = await t.run((ctx) => ctx.db.get(young));
    expect(photo).not.toBeNull(); // mid-submission, not abandoned
    expect(photo?.orphanCandidate).toBeUndefined();
  });

  test('is idempotent — a second run over a settled uploader changes nothing', async () => {
    const t = harness();
    const uploader = await seedUploader(t, 'prolific');
    const orphan = await seedPhoto(t, uploader, 'orphan');

    await reconcile(t, uploader);
    expect(await t.run((ctx) => ctx.db.get(orphan))).toBeNull();

    await expect(reconcile(t, uploader)).resolves.not.toThrow();
    expect(await t.run((ctx) => ctx.db.query('photos').collect())).toHaveLength(0);
  });

  /**
   * The reason this job is keyed on `uploaderId` and nothing else: it reclaims a **tombstone's** photos
   * as readily as a live account's. Deletion keeps the observation, so a departed uploader's reports
   * survive them — their reference scan stays exactly as capped as it was in life, and the fast path
   * would have gone on failing forever with the account no longer around to notice.
   */
  test('still works after the account is a tombstone', async () => {
    const t = harness();
    const uploader = await seedUploader(t, 'prolific');
    const orphan = await seedPhoto(t, uploader, 'orphan');

    await t.run((ctx) =>
      ctx.db.patch(uploader, {
        status: 'deleted' as const,
        deletedAt: T0,
        deletionRequestedAt: undefined,
      }),
    );

    await reconcile(t, uploader);

    expect(await t.run((ctx) => ctx.db.get(orphan))).toBeNull();
  });

  /**
   * A photo whose blob outlives the attempt keeps its row — it is the only pointer to those blobs — and
   * must be **unmarked**, so the next run re-derives the verdict instead of inheriting a stale one.
   */
  test('a photo whose blob will not delete keeps its row and loses its mark', async () => {
    const t = harness();
    const uploader = await seedUploader(t, 'prolific');
    const stuck = await seedPhoto(t, uploader, 'stuck');
    await t.run((ctx) => ctx.db.patch(stuck, { storageId: 'not-a-storage-id' }));

    await reconcile(t, uploader);

    const photo = await t.run((ctx) => ctx.db.get(stuck));
    expect(photo).not.toBeNull();
    expect(photo?.orphanCandidate).toBeUndefined();
  });
});

describe('sweepOrphanPhotos escalates instead of skipping forever', () => {
  /**
   * Skipping a capped uploader was never the bug — keeping a photo it can't prove is unreferenced is
   * correct. The bug was that skipping was the *end of it*: the cap is a property of the uploader, not
   * of the moment, so the same `null` came back every tick and nothing ever reclaimed the blobs. The
   * cron now hands them to the job that can finish the question.
   *
   * This asserts the ordinary path stays inline — nothing is escalated when the fast scan can answer,
   * which is what keeps the cron cheap for everybody who isn't pathological.
   */
  test('a determinable uploader is handled inline, with nothing escalated', async () => {
    const t = harness();
    const uploader = await seedUploader(t, 'ordinary');
    await seedPhoto(t, uploader, 'orphan');

    const swept = await t.mutation(internal.storageHygiene.sweepOrphanPhotos, {});

    expect(swept).toMatchObject({ scanned: 1, deleted: 1, skipped: 0, escalated: 0 });
  });
});
