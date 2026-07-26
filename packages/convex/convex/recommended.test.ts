import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function harness() {
  const t = convexTest(schema, modules);
  return t;
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

async function seedUser(t: ReturnType<typeof harness>, subject: string, reputationPoints = 0) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

let bodySeq = 0;
async function seedBody(t: ReturnType<typeof harness>) {
  const offset = bodySeq++;
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: `Pond ${offset}`,
      type: 'lake' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [offset, 0],
            [offset, 1],
            [offset + 1, 1],
            [offset + 1, 0],
            [offset, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: offset, maxLat: 1, maxLng: offset + 1 },
      centroid: { lat: 0.5, lng: offset + 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  );
}

/** Seed a photo row backed by a real stored blob so the feed-card hydration resolves a thumb URL. */
async function seedPhoto(t: ReturnType<typeof harness>, uploaderId: Id<'profiles'>) {
  return t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(['img']));
    return ctx.db.insert('photos', {
      storageId,
      thumbStorageId: storageId,
      uploaderId,
      placeOnMap: false,
      createdAt: Date.now(),
    });
  });
}

/**
 * Build a report that clears every recommended gate at once: `great` + black ice, ≥2 photos, authored by
 * an expert (≥60 pts), with 3 corroborators (`report_corroborated` ledger rows keyed to it), skated now.
 */
async function seedExceptionalReport(
  t: ReturnType<typeof harness>,
  author: Awaited<ReturnType<typeof seedUser>>,
  waterBodyId: Id<'waterBodies'>,
): Promise<Id<'reports'>> {
  const reportId = (await author.as.mutation(api.reports.create, {
    waterBodyId,
    skateEndTime: Date.now(),
    iceTypes: ['black_ice'],
    skateQuality: 'great',
  })) as Id<'reports'>;
  const p1 = await seedPhoto(t, author.id);
  const p2 = await seedPhoto(t, author.id);
  await t.run(async (ctx) => {
    await ctx.db.patch(reportId, { photoIds: [p1, p2] });
    for (let i = 0; i < 3; i++) {
      await ctx.db.insert('pointEvents', {
        userId: author.id,
        delta: 4,
        reason: 'report_corroborated' as const,
        refId: reportId,
        createdAt: Date.now(),
      });
    }
  });
  return reportId;
}

describe('reports.recommended', () => {
  test('surfaces a fully-qualifying report as one distinct card', async () => {
    const t = harness();
    const author = await seedUser(t, 'expert', 60); // expert trust
    const viewer = await seedUser(t, 'viewer');
    const body = await seedBody(t);
    const reportId = await seedExceptionalReport(t, author, body);

    const res = await viewer.as.query(api.reports.recommended, {});
    expect(res).toHaveLength(1);
    expect(res[0]?.waterBodyId).toBe(body);
    expect(res[0]?.cards.map((c) => c.reportId)).toContain(reportId);
  });

  test('returns nothing when the author is below the trust bar', async () => {
    const t = harness();
    const author = await seedUser(t, 'novice', 0); // below expert
    const viewer = await seedUser(t, 'viewer');
    const body = await seedBody(t);
    await seedExceptionalReport(t, author, body);

    expect(await viewer.as.query(api.reports.recommended, {})).toHaveLength(0);
  });

  test('returns nothing when corroboration is below the floor', async () => {
    const t = harness();
    const author = await seedUser(t, 'expert', 60);
    const viewer = await seedUser(t, 'viewer');
    const body = await seedBody(t);
    // A great, photo-backed, expert report — but no corroboration events → below the floor.
    const reportId = (await author.as.mutation(api.reports.create, {
      waterBodyId: body,
      skateEndTime: Date.now(),
      iceTypes: ['black_ice'],
      skateQuality: 'great',
    })) as Id<'reports'>;
    const p1 = await seedPhoto(t, author.id);
    const p2 = await seedPhoto(t, author.id);
    await t.run((ctx) => ctx.db.patch(reportId, { photoIds: [p1, p2] }));

    expect(await viewer.as.query(api.reports.recommended, {})).toHaveLength(0);
  });

  test('never breaks a block — a blocked author’s exceptional report is excluded (D3)', async () => {
    const t = harness();
    const author = await seedUser(t, 'expert', 60);
    const viewer = await seedUser(t, 'viewer');
    const body = await seedBody(t);
    await seedExceptionalReport(t, author, body);
    await t.run((ctx) =>
      ctx.db.insert('blocks', {
        blockerId: viewer.id,
        blockedId: author.id,
        createdAt: Date.now(),
      }),
    );

    expect(await viewer.as.query(api.reports.recommended, {})).toHaveLength(0);
  });

  test('returns nothing for a signed-out viewer (personalized filter-breaker)', async () => {
    const t = harness();
    const author = await seedUser(t, 'expert', 60);
    const body = await seedBody(t);
    await seedExceptionalReport(t, author, body);

    expect(await t.query(api.reports.recommended, {})).toHaveLength(0);
  });
});
