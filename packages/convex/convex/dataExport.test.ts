/**
 * Data export (D33/D62). The assertions that matter are the ones about what a bundle must NOT contain
 * (a live OAuth token, the Clerk subject) and the one that makes the whole feature worth building the
 * expensive way: photo bytes travel inside the file, so the export still works after the account it
 * describes is gone.
 */
import { DATA_EXPORT_TTL_MS } from '@skating/core';
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { retainOrphanedBundle } from './lib/exportBundles';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function harness() {
  vi.useFakeTimers();
  return convexTest(schema, modules);
}

afterEach(() => {
  vi.useRealTimers();
});

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

async function seedUser(t: ReturnType<typeof convexTest>, subject: string) {
  const id = (await t.run((ctx) =>
    ctx.db.insert('profiles', {
      // The Clerk subject is deliberately NOT the display name here: reusing one string would let the
      // "omits the Clerk subject" test pass on the display name instead of on the thing it names.
      clerkUserId: `clerk_${subject}`,
      displayName: subject,
      username: subject,
      homeCoord: { lat: 44.5, lng: -73.2 },
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 12,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: T0,
    }),
  )) as Id<'profiles'>;
  return { id, as: t.withIdentity({ subject: `clerk_${subject}` }) };
}

async function seedBody(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm' as const,
        externalId: 'osm/export-1',
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

describe('requestExport', () => {
  test('creates a building row and does not start a second build for a double-tap', async () => {
    const t = harness();
    const user = await seedUser(t, 'exporter');

    const first = await user.as.mutation(api.dataExport.requestExport, {});
    const second = await user.as.mutation(api.dataExport.requestExport, {});

    expect(second).toBe(first);
    const rows = await t.run((ctx) => ctx.db.query('dataExports').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('building');
  });

  test('myExports is owner-scoped', async () => {
    const t = harness();
    const mine = await seedUser(t, 'mine');
    const theirs = await seedUser(t, 'theirs');
    await mine.as.mutation(api.dataExport.requestExport, {});

    expect(await mine.as.query(api.dataExport.myExports, {})).toHaveLength(1);
    expect(await theirs.as.query(api.dataExport.myExports, {})).toHaveLength(0);
    expect(await t.query(api.dataExport.myExports, {})).toHaveLength(0); // signed out
  });
});

describe('collect — what a bundle carries', () => {
  test('includes the account’s own content', async () => {
    const t = harness();
    const user = await seedUser(t, 'exporter');
    const bodyId = await seedBody(t);
    const reportId = await user.as.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: T0,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
      notes: 'Glass.',
    });
    await user.as.mutation(api.comments.create, { reportId, body: 'Still good.' });

    const data = await t.query(internal.dataExport.collect, { userId: user.id });

    expect(data.reports).toHaveLength(1);
    expect(data.reports[0]?.notes).toBe('Glass.');
    expect(data.comments).toHaveLength(1);
    expect(data.profile.displayName).toBe('exporter');
    expect(data.profile.homeCoord).toEqual({ lat: 44.5, lng: -73.2 });
  });

  /**
   * The two omissions, as tests rather than comments. A downloadable copy of a live Strava token is a
   * credential sitting in a Downloads folder; the Clerk subject is the join key a leaked bundle would
   * make most use of. Neither is something the person needs back.
   */
  test('strips OAuth secrets but keeps the connection record', async () => {
    const t = harness();
    const user = await seedUser(t, 'exporter');
    await t.run((ctx) =>
      ctx.db.insert('activityConnections', {
        userId: user.id,
        provider: 'strava' as const,
        externalUserId: 'athlete-1',
        accessToken: 'ACCESS-SECRET',
        refreshToken: 'REFRESH-SECRET',
        scopes: ['activity:write'],
        connectedAt: T0,
      }),
    );

    const data = await t.query(internal.dataExport.collect, { userId: user.id });
    const serialized = JSON.stringify(data);

    expect(data.activityConnections).toHaveLength(1);
    expect(data.activityConnections[0]?.provider).toBe('strava');
    expect(serialized).not.toContain('ACCESS-SECRET');
    expect(serialized).not.toContain('REFRESH-SECRET');
  });

  test('omits the Clerk subject', async () => {
    const t = harness();
    const user = await seedUser(t, 'exporter');

    const data = await t.query(internal.dataExport.collect, { userId: user.id });

    expect('clerkUserId' in data.profile).toBe(false);
    expect(JSON.stringify(data)).not.toContain('clerk_exporter');
  });
});

describe('buildExport', () => {
  test('produces a downloadable bundle with the photo bytes inside it', async () => {
    const t = harness();
    const user = await seedUser(t, 'exporter');
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(['not-really-a-jpeg'], { type: 'image/jpeg' })),
    );
    await t.run((ctx) =>
      ctx.db.insert('photos', {
        storageId,
        thumbStorageId: storageId,
        uploaderId: user.id,
        placeOnMap: false,
        createdAt: T0,
      }),
    );

    const exportId = await user.as.mutation(api.dataExport.requestExport, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const row = await t.run((ctx) => ctx.db.get(exportId));
    expect(row?.status).toBe('ready');
    expect(row?.photoCount).toBe(1);
    expect(row?.omittedPhotoCount).toBe(0);
    expect(row?.storageId).toBeDefined();

    // The bundle is self-contained — which is the whole reason bytes are embedded rather than linked.
    const bundle = JSON.parse(
      await t.run(async (ctx) => {
        // Read to text *inside* `t.run` — a Blob isn't a Convex value and can't cross the boundary.
        const blob = await ctx.storage.get(row?.storageId as Id<'_storage'>);
        return (blob as Blob).text();
      }),
    );
    expect(bundle.format).toBe('skating-data-export/1');
    expect(bundle.photoFiles).toHaveLength(1);
    expect(atob(bundle.photoFiles[0].base64)).toBe('not-really-a-jpeg');
  });

  test('a bundle survives the deletion of the account it describes', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const exportId = await user.as.mutation(api.dataExport.requestExport, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const row = await t.run((ctx) => ctx.db.get(exportId));
    const downloaded = await t.run(async (ctx) => {
      const blob = await ctx.storage.get(row?.storageId as Id<'_storage'>);
      return (blob as Blob).text();
    });

    await t.mutation(internal.accountDeletion.finalizeNow, { userId: user.id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Our copy is gone (an assembled export of a deleted account would undo the deletion in one file)…
    expect(await t.run((ctx) => ctx.db.get(exportId))).toBeNull();
    // …but what the user already downloaded still reads, because nothing in it was a link.
    expect(JSON.parse(downloaded).profile.displayName).toBe('leaver');
  });

  test('records a failure on the row rather than leaving it building forever', async () => {
    const t = harness();
    const user = await seedUser(t, 'exporter');
    const exportId = await user.as.mutation(api.dataExport.requestExport, {});
    // Delete the profile out from under the build — `collect` throws, which is the generic failure path.
    await t.run((ctx) => ctx.db.delete(user.id));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const row = await t.run((ctx) => ctx.db.get(exportId));
    expect(row?.status).toBe('failed');
    expect(row?.error).toBeTruthy();
  });

  test('no email goes out when Resend is unprovisioned, and the bundle is still ready', async () => {
    const t = harness();
    const user = await seedUser(t, 'exporter');
    const exportId = await user.as.mutation(api.dataExport.requestExport, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const row = await t.run((ctx) => ctx.db.get(exportId));
    expect(row?.status).toBe('ready');
    expect(row?.emailedAt).toBeUndefined(); // the in-app listing is the path that works today
  });
});

/**
 * PR #29 review (Greptile P1, both security-tagged). Two paths could remove the **only** database
 * pointer to a stored bundle while leaving the blob behind — which is worse than an ordinary orphan,
 * because a bundle is a complete copy of one account and a Convex storage URL stays valid until the
 * file is deleted. So these tests are about what happens when reclaiming *fails*.
 */
describe('bundle reclamation (PR #29 review)', () => {
  /**
   * **Coverage note, stated rather than implied.** convex-test can't make a *present* blob
   * undeletable, so the keep-the-row branch is driven by a storage id storage refuses to resolve — a
   * stand-in for the general failure, not a perfect one, but it runs the real code path end to end
   * including the attempt counter and the operator alert. The rest of the discrimination is pinned
   * directly: `getUrl` telling an already-gone blob (drop the row) from a live one (delete, then drop).
   */
  test('the happy path removes the row and the blob together', async () => {
    const t = harness();
    const user = await seedUser(t, 'exporter');
    const exportId = await user.as.mutation(api.dataExport.requestExport, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const storageId = (await t.run((ctx) => ctx.db.get(exportId)))?.storageId as Id<'_storage'>;

    await t.run((ctx) => ctx.db.patch(exportId, { expiresAt: Date.now() - 1000 }));
    const swept = await t.mutation(internal.storageHygiene.sweepExpiredExports, {});

    expect(swept).toEqual({ deleted: 1, retained: 0 });
    expect(await t.run((ctx) => ctx.db.get(exportId))).toBeNull();
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).toBeNull();
  });

  test('a row whose blob is already gone is dropped rather than retried forever', async () => {
    const t = harness();
    const user = await seedUser(t, 'exporter');
    const exportId = await user.as.mutation(api.dataExport.requestExport, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const row = await t.run((ctx) => ctx.db.get(exportId));

    // Blob vanishes independently (a manual dashboard delete, say). `storage.delete` would THROW on
    // it, so without the getUrl pre-check this row would be retried until the alert threshold.
    await t.run((ctx) => ctx.storage.delete(row?.storageId as Id<'_storage'>));
    await t.run((ctx) => ctx.db.patch(exportId, { expiresAt: Date.now() - 1000 }));

    expect(await t.mutation(internal.storageHygiene.sweepExpiredExports, {})).toEqual({
      deleted: 1,
      retained: 0,
    });
    expect(await t.run((ctx) => ctx.db.get(exportId))).toBeNull();
  });

  test('an expired row serves no download URL, even before the sweep reaches it', async () => {
    const t = harness();
    const user = await seedUser(t, 'exporter');
    const exportId = await user.as.mutation(api.dataExport.requestExport, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await user.as.query(api.dataExport.myExports, {}))[0]?.url).not.toBeNull();
    await t.run((ctx) => ctx.db.patch(exportId, { expiresAt: Date.now() - 1000 }));

    const listed = (await user.as.query(api.dataExport.myExports, {}))[0];
    expect(listed?.expired).toBe(true);
    expect(listed?.url).toBeNull();
  });

  /**
   * The branch the whole first pass was built around, now that an unresolvable id can drive it: a
   * bundle whose blob won't go **keeps its row**, because that row is the only handle anyone — us or
   * the founder — has on the file. It counts attempts and pages a human exactly once at the threshold,
   * so a genuinely stuck bundle produces one email rather than one an hour, forever.
   */
  test('a bundle that will not delete keeps its row, counts attempts, and pages once', async () => {
    const t = harness();
    const user = await seedUser(t, 'exporter');
    const exportId = await user.as.mutation(api.dataExport.requestExport, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.run((ctx) =>
      ctx.db.patch(exportId, { storageId: 'not-a-storage-id', expiresAt: Date.now() - 1000 }),
    );

    for (let tick = 1; tick <= 5; tick++) {
      expect(await t.mutation(internal.storageHygiene.sweepExpiredExports, {})).toEqual({
        deleted: 0,
        retained: 1,
      });
      expect((await t.run((ctx) => ctx.db.get(exportId)))?.cleanupAttempts).toBe(tick);
    }

    // One page, at the threshold — scheduled, not sent, since Resend is unprovisioned.
    const alerts = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    const paged = alerts.filter((a) => a.name.includes('operatorAlerts'));
    expect(paged).toHaveLength(1);
    expect(JSON.stringify(paged[0]?.args)).toContain('not-a-storage-id');

    // Sixth tick: still kept, still no second page.
    await t.mutation(internal.storageHygiene.sweepExpiredExports, {});
    expect(await t.run((ctx) => ctx.db.get(exportId))).not.toBeNull();
    expect(
      (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).filter((a) =>
        a.name.includes('operatorAlerts'),
      ),
    ).toHaveLength(1);
  });

  /**
   * The second P1: the account is deleted *while* a bundle is building. `buildExport` stores the blob
   * before `finishExport` runs, so the row it would have recorded the `storageId` on is already gone —
   * and returning early would leave a complete copy of a just-deleted person's data in storage with
   * nothing pointing at it.
   */
  test('a build that finishes after its account is deleted reclaims its own blob', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');

    // Hand `finishExport` a storageId for a row that no longer exists — exactly the race, without
    // needing to interleave the scheduler by hand.
    const exportId = await user.as.mutation(api.dataExport.requestExport, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const orphan = await t.run((ctx) =>
      ctx.storage.store(new Blob(['{"a":1}'], { type: 'application/json' })),
    );
    await t.run((ctx) => ctx.db.delete(exportId));

    await t.mutation(internal.dataExport.finishExport, {
      exportId,
      userId: user.id,
      storageId: orphan,
      sizeBytes: 7,
    });

    expect(await t.run((ctx) => ctx.storage.getUrl(orphan))).toBeNull();
    // Reclaimed, so nothing to remember it by — the re-created pointer below is for the case where
    // the reclaim *fails*, and manufacturing one here would be a pointer to a file that isn't there.
    expect(await t.run((ctx) => ctx.db.query('dataExports').collect())).toHaveLength(0);
  });

  /**
   * The same race where the blob was *already* reclaimed by the deletion that removed the row — which
   * is the common case, since account finalization deletes the blob and the row together. `storage
   * .delete` throws on a missing file, so the pre-check is the only thing keeping that throw from
   * being read as "reclaim failed" and re-inserting a pointer to nothing.
   */
  test('a mid-build orphan whose blob is already gone leaves no phantom pointer', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const exportId = await user.as.mutation(api.dataExport.requestExport, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const gone = (await t.run((ctx) => ctx.db.get(exportId)))?.storageId as Id<'_storage'>;
    await t.run(async (ctx) => {
      await ctx.storage.delete(gone);
      await ctx.db.delete(exportId);
    });

    await t.mutation(internal.dataExport.finishExport, {
      exportId,
      userId: user.id,
      storageId: gone,
    });

    expect(await t.run((ctx) => ctx.db.query('dataExports').collect())).toHaveLength(0);
  });

  /**
   * The branch the coverage note above says convex-test can't force — a `storage.delete` that fails on
   * a blob that *is* there — reached from its other end. What that branch does is call
   * `retainOrphanedBundle`, so the thing worth pinning is that its output is a working retry: an
   * already-expired row the hourly sweep finds, reclaims and drops on its own, with no operator email
   * in the loop (unconfigured until the prod cutover, which is why a log line wasn't a record).
   */
  test('a bundle whose pointer was re-created is reclaimed by the ordinary sweep', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const stranded = await t.run((ctx) =>
      ctx.storage.store(new Blob(['{"whole":"account"}'], { type: 'application/json' })),
    );

    await t.run((ctx) =>
      retainOrphanedBundle(ctx, { userId: user.id, storageId: stranded, error: 'storage said no' }),
    );

    const [pointer] = await t.run((ctx) => ctx.db.query('dataExports').collect());
    expect(pointer?.storageId).toBe(stranded);
    expect(pointer?.status).toBe('failed');
    expect(pointer?.expiresAt).toBeLessThanOrEqual(Date.now());
    // Inert as an export: no download is offered for a bundle nobody was promised.
    expect((await user.as.query(api.dataExport.myExports, {}))[0]?.url).toBeNull();

    vi.setSystemTime(Date.now() + 60 * 60 * 1000); // the next hourly tick
    expect(await t.mutation(internal.storageHygiene.sweepExpiredExports, {})).toEqual({
      deleted: 1,
      retained: 0,
    });
    expect(await t.run((ctx) => ctx.storage.getUrl(stranded))).toBeNull();
    expect(await t.run((ctx) => ctx.db.query('dataExports').collect())).toHaveLength(0);
  });

  /**
   * A build that stored its blob and then broke. The `storageId` exists only in the action's own
   * variable at that moment; if the failure path doesn't hand it over, the row goes `failed` with no
   * pointer and the bundle sits in storage unreachable.
   */
  test('a failure after the blob lands records it and expires it immediately', async () => {
    const t = harness();
    const user = await seedUser(t, 'exporter');
    const exportId = await user.as.mutation(api.dataExport.requestExport, {});
    const stored = await t.run((ctx) =>
      ctx.storage.store(new Blob(['{"a":1}'], { type: 'application/json' })),
    );

    await t.mutation(internal.dataExport.finishExport, {
      exportId,
      userId: user.id,
      storageId: stored,
      error: 'mutation failed after the store',
    });

    const row = await t.run((ctx) => ctx.db.get(exportId));
    expect(row?.status).toBe('failed');
    expect(row?.storageId).toBe(stored);
    expect(row?.expiresAt).toBeLessThanOrEqual(Date.now()); // no reason to hold the bytes for 7 days
    expect((await user.as.query(api.dataExport.myExports, {}))[0]?.url).toBeNull();

    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    await t.mutation(internal.storageHygiene.sweepExpiredExports, {});
    expect(await t.run((ctx) => ctx.storage.getUrl(stored))).toBeNull();
  });

  /**
   * The email race, from the row's side: a late failure — a mail step that threw, an account deleted
   * mid-send — must not walk a landed bundle back to `failed`. It used to, and the walk-back was the
   * call that dropped the `storageId`.
   */
  test('a late failure cannot unready a bundle that already landed', async () => {
    const t = harness();
    const user = await seedUser(t, 'exporter');
    const exportId = await user.as.mutation(api.dataExport.requestExport, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const ready = await t.run((ctx) => ctx.db.get(exportId));

    await t.mutation(internal.dataExport.finishExport, {
      exportId,
      userId: user.id,
      error: 'the email blew up',
    });

    const row = await t.run((ctx) => ctx.db.get(exportId));
    expect(row?.status).toBe('ready');
    expect(row?.storageId).toBe(ready?.storageId);
    expect(row?.error).toBeUndefined();
  });

  /**
   * The email resolver is a *second* place URLs are minted, and it only checked `ready` — so a bundle
   * that finished after its own expiry would have had a fresh link minted and mailed, which is the one
   * way to hand someone a download for data we've already told them is gone.
   *
   * Both halves of the fix are here: the lifetime is rebased onto `readyAt`, so an ordinary slow build
   * lands with its full window rather than a shortened one, and `exportUrl` refuses an expired row
   * regardless, so nothing downstream depends on that rebase having happened.
   */
  test('a bundle’s lifetime runs from when it exists, not from when it was asked for', async () => {
    const t = harness();
    const user = await seedUser(t, 'exporter');
    const exportId = await user.as.mutation(api.dataExport.requestExport, {});
    const requested = (await t.run((ctx) => ctx.db.get(exportId)))?.expiresAt as number;

    vi.setSystemTime(Date.now() + 60 * 60 * 1000); // a build that took an hour
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const row = await t.run((ctx) => ctx.db.get(exportId));
    expect(row?.expiresAt).toBe((row?.readyAt ?? 0) + DATA_EXPORT_TTL_MS);
    expect(row?.expiresAt).toBeGreaterThan(requested); // not the shortened window the email would lie about
  });

  test('the email resolver mints no URL for a bundle past its lifetime', async () => {
    const t = harness();
    const user = await seedUser(t, 'exporter');
    const exportId = await user.as.mutation(api.dataExport.requestExport, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(internal.dataExport.exportUrl, { exportId })).not.toBeNull();
    await t.run((ctx) => ctx.db.patch(exportId, { expiresAt: Date.now() - 1000 }));

    // Same answer as `myExports` — the two minting paths must not disagree.
    expect(await t.query(internal.dataExport.exportUrl, { exportId })).toBeNull();
    expect((await user.as.query(api.dataExport.myExports, {}))[0]?.url).toBeNull();
  });

  /** Deleted between "ready" and the email bookkeeping — nothing to record, and not an error. */
  test('markEmailed on a vanished row is a no-op', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const exportId = await user.as.mutation(api.dataExport.requestExport, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.run((ctx) => ctx.db.delete(exportId));

    await expect(t.mutation(internal.dataExport.markEmailed, { exportId })).resolves.toBeNull();
  });

  test('account deletion leaves no export blob behind', async () => {
    const t = harness();
    const user = await seedUser(t, 'leaver');
    const exportId = await user.as.mutation(api.dataExport.requestExport, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const storageId = (await t.run((ctx) => ctx.db.get(exportId)))?.storageId as Id<'_storage'>;

    await t.mutation(internal.accountDeletion.finalizeNow, { userId: user.id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.run((ctx) => ctx.db.get(exportId))).toBeNull();
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).toBeNull();
  });
});
