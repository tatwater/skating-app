/**
 * Data export (D33/D62). The assertions that matter are the ones about what a bundle must NOT contain
 * (a live OAuth token, the Clerk subject) and the one that makes the whole feature worth building the
 * expensive way: photo bytes travel inside the file, so the export still works after the account it
 * describes is gone.
 */
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
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
