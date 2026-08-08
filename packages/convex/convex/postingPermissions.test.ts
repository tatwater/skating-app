import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const SKATE_TIME = Date.now() - 3 * 3_600_000;

function harness() {
  const t = convexTest(schema, modules);
  return t;
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  perms: { canPostReports?: boolean; canPostHazards?: boolean; canPostComments?: boolean } = {},
) {
  await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: {
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
      },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
      ...perms,
    }),
  );
  return t.withIdentity({ subject });
}

async function seedBody(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Shelburne Pond',
      searchText: 'Shelburne Pond',
      type: 'lakePond' as const,
      source: 'osm' as const,
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
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  ) as Promise<Id<'waterBodies'>>;
}

const hazardArgs = (waterBodyId: Id<'waterBodies'>) => ({
  waterBodyId,
  type: 'open_water' as const,
  geometryKind: 'point_radius' as const,
  geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
  radiusMeters: 40,
});

const reportArgs = (waterBodyId: Id<'waterBodies'>) => ({
  waterBodyId,
  skateEndTime: SKATE_TIME,
  iceTypes: ['black_ice' as const],
});

describe('D57 granular posting permissions', () => {
  test('absent permission ⇒ allowed (default-on for adults)', async () => {
    const t = harness();
    const as = await seedUser(t, 'ok');
    const waterBodyId = await seedBody(t);
    await expect(as.mutation(api.reports.create, reportArgs(waterBodyId))).resolves.toBeTruthy();
    await expect(as.mutation(api.hazards.create, hazardArgs(waterBodyId))).resolves.toBeTruthy();
  });

  test('canPostReports:false blocks reports but NOT hazards (finer than a ban)', async () => {
    const t = harness();
    const as = await seedUser(t, 'noreports', { canPostReports: false });
    const waterBodyId = await seedBody(t);
    await expect(as.mutation(api.reports.create, reportArgs(waterBodyId))).rejects.toThrow(
      /report posting has been restricted/,
    );
    // The hazard surface is untouched by the report restriction.
    await expect(as.mutation(api.hazards.create, hazardArgs(waterBodyId))).resolves.toBeTruthy();
  });

  test('canPostHazards:false blocks hazards but NOT plain reports', async () => {
    const t = harness();
    const as = await seedUser(t, 'nohazards', { canPostHazards: false });
    const waterBodyId = await seedBody(t);
    await expect(as.mutation(api.hazards.create, hazardArgs(waterBodyId))).rejects.toThrow(
      /hazard posting has been restricted/,
    );
    await expect(as.mutation(api.reports.create, reportArgs(waterBodyId))).resolves.toBeTruthy();
  });

  test('a hazard-restricted user cannot slip a hazard in via an in-report draw', async () => {
    const t = harness();
    const as = await seedUser(t, 'nohazards2', { canPostHazards: false });
    const waterBodyId = await seedBody(t);
    await expect(
      as.mutation(api.reports.create, {
        ...reportArgs(waterBodyId),
        hazards: [
          {
            type: 'open_water' as const,
            geometryKind: 'point_radius' as const,
            geometry: { type: 'Point' as const, coordinates: [0.5, 0.5] },
            radiusMeters: 40,
          },
        ],
      }),
    ).rejects.toThrow(/hazard posting has been restricted/);
  });

  test('canPostComments:false mutes comments but leaves reports standing', async () => {
    const t = harness();
    // An author who can still report but has had comments revoked — the D57 payoff.
    const as = await seedUser(t, 'nocomments', { canPostComments: false });
    const waterBodyId = await seedBody(t);
    const reportId = await as.mutation(api.reports.create, reportArgs(waterBodyId));
    await expect(as.mutation(api.comments.create, { reportId, body: 'nice ice' })).rejects.toThrow(
      /comment posting has been restricted/,
    );
  });

  test('absent canPostComments ⇒ comments allowed', async () => {
    const t = harness();
    const as = await seedUser(t, 'cancomment');
    const waterBodyId = await seedBody(t);
    const reportId = await as.mutation(api.reports.create, reportArgs(waterBodyId));
    await expect(
      as.mutation(api.comments.create, { reportId, body: 'looks solid' }),
    ).resolves.toBeTruthy();
  });
});
