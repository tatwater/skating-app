import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
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

async function seedUser(t: ReturnType<typeof harness>, subject: string) {
  const id = await t.run((ctx) =>
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
  return { id, as: t.withIdentity({ subject }) };
}

async function seedBody(t: ReturnType<typeof harness>) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Shelburne Pond',
      type: 'lake' as const,
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
  );
}

type Actor = Awaited<ReturnType<typeof seedUser>>;

interface ReportOpts {
  skateEndTime?: number;
  iceTypes?: ('black_ice' | 'white_ice' | 'snow_ice')[];
  skateQuality?: 'great' | 'good' | 'fair' | 'poor';
  measured?: boolean;
  estimated?: boolean;
  withPhoto?: boolean;
}

async function seedReport(
  t: ReturnType<typeof harness>,
  actor: Actor,
  waterBodyId: Id<'waterBodies'>,
  opts: ReportOpts = {},
): Promise<Id<'reports'>> {
  let photoIds: Id<'photos'>[] | undefined;
  if (opts.withPhoto) {
    const photoId = await t.run((ctx) =>
      ctx.db.insert('photos', {
        storageId: 'storage',
        thumbStorageId: 'thumb',
        uploaderId: actor.id,
        placeOnMap: false,
        createdAt: Date.now(),
      }),
    );
    photoIds = [photoId];
  }
  const method = opts.measured ? 'measured' : opts.estimated ? 'estimated' : undefined;
  return actor.as.mutation(api.reports.create, {
    waterBodyId,
    skateEndTime: opts.skateEndTime ?? Date.now(),
    iceTypes: opts.iceTypes ?? ['black_ice'],
    ...(opts.skateQuality ? { skateQuality: opts.skateQuality } : {}),
    ...(method ? { iceThickness: { readings: [{ valueCm: 12, method }] } } : {}),
    ...(photoIds ? { photoIds } : {}),
  }) as Promise<Id<'reports'>>;
}

async function profile(t: ReturnType<typeof harness>, id: Id<'profiles'>) {
  return t.run((ctx) => ctx.db.get(id));
}

async function eventCount(
  t: ReturnType<typeof harness>,
  userId: Id<'profiles'>,
  reason: string,
): Promise<number> {
  const events = await t.run((ctx) =>
    ctx.db
      .query('pointEvents')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect(),
  );
  return events.filter((e) => e.reason === reason).length;
}

describe('per-report awards', () => {
  test('report_submitted (+2), plus photo_evidence (+3) and measured_thickness (+2), once each', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);

    await seedReport(t, author, waterBodyId, { withPhoto: true, measured: true });
    expect((await profile(t, author.id))?.reputationPoints).toBe(2 + 3 + 2);
  });

  test('estimated-only thickness earns no measured_thickness boost', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);

    await seedReport(t, author, waterBodyId, { estimated: true });
    expect((await profile(t, author.id))?.reputationPoints).toBe(2);
    expect(await eventCount(t, author.id, 'measured_thickness')).toBe(0);
  });
});

describe('corroboration', () => {
  test('a fresh agreeing report awards report_corroborated (+4) to both authors', async () => {
    const t = harness();
    const a = await seedUser(t, 'a');
    const b = await seedUser(t, 'b');
    const waterBodyId = await seedBody(t);

    await seedReport(t, a, waterBodyId, { iceTypes: ['black_ice'] });
    await seedReport(t, b, waterBodyId, { iceTypes: ['black_ice'] }); // shares an ice type ⇒ agrees

    expect((await profile(t, a.id))?.reputationPoints).toBe(2 + 4);
    expect((await profile(t, b.id))?.reputationPoints).toBe(2 + 4);
  });

  test('self-corroboration is excluded', async () => {
    const t = harness();
    const a = await seedUser(t, 'a');
    const waterBodyId = await seedBody(t);

    await seedReport(t, a, waterBodyId);
    await seedReport(t, a, waterBodyId);

    expect(await eventCount(t, a.id, 'report_corroborated')).toBe(0);
    expect((await profile(t, a.id))?.reputationPoints).toBe(2 + 2);
  });

  test('a disagreeing report does not corroborate', async () => {
    const t = harness();
    const a = await seedUser(t, 'a');
    const b = await seedUser(t, 'b');
    const waterBodyId = await seedBody(t);

    await seedReport(t, a, waterBodyId, { iceTypes: ['black_ice'], skateQuality: 'great' });
    // No shared ice type, and quality two steps apart (great vs fair) ⇒ no agreement.
    await seedReport(t, b, waterBodyId, { iceTypes: ['snow_ice'], skateQuality: 'fair' });

    expect(await eventCount(t, b.id, 'report_corroborated')).toBe(0);
  });

  test('caps corroborators counted per report', async () => {
    const t = harness();
    const waterBodyId = await seedBody(t);
    // Four agreeing priors, then a fifth new report scans them — capped at 3.
    for (const name of ['p1', 'p2', 'p3', 'p4']) {
      const u = await seedUser(t, name);
      await seedReport(t, u, waterBodyId, { iceTypes: ['black_ice'] });
    }
    const last = await seedUser(t, 'last');
    await seedReport(t, last, waterBodyId, { iceTypes: ['black_ice'] });

    expect(await eventCount(t, last.id, 'report_corroborated')).toBe(3);
  }, 15000);

  test('an out-of-window prior does not corroborate', async () => {
    const t = harness();
    const a = await seedUser(t, 'a');
    const b = await seedUser(t, 'b');
    const waterBodyId = await seedBody(t);
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago, past the 7-day window

    await seedReport(t, a, waterBodyId, { skateEndTime: old, iceTypes: ['black_ice'] });
    await seedReport(t, b, waterBodyId, { iceTypes: ['black_ice'] });

    expect(await eventCount(t, b.id, 'report_corroborated')).toBe(0);
  });
});

describe('hazard confirmation retrofit', () => {
  async function seedHazard(author: Actor, waterBodyId: Id<'waterBodies'>) {
    return author.as.mutation(api.hazards.create, {
      waterBodyId,
      type: 'open_water',
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [0.5, 0.5] },
      radiusMeters: 40,
    }) as Promise<Id<'hazards'>>;
  }

  test('confirmers earn hazard_confirmed reputation; the author earns hazard_corroborated once at 2 peers', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const waterBodyId = await seedBody(t);
    const hazardId = await seedHazard(author, waterBodyId);

    const c1 = await seedUser(t, 'c1');
    const c2 = await seedUser(t, 'c2');
    const c3 = await seedUser(t, 'c3');
    for (const c of [c1, c2, c3]) {
      await c.as.mutation(api.hazardConfirmations.confirm, {
        hazardId,
        verdict: 'still_there',
        via: 'app_open_nearby',
      });
    }

    // Each confirmer got the +1 reputation the retrofit now bumps (previously ledger-only).
    expect((await profile(t, c1.id))?.reputationPoints).toBe(1);
    // The author earned hazard_corroborated exactly once (at the 2-peer crossing), not per extra confirm.
    expect(await eventCount(t, author.id, 'hazard_corroborated')).toBe(1);
    expect((await profile(t, author.id))?.reputationPoints).toBe(4);
  }, 15000);
});

describe('badges', () => {
  test('measured badge after enough measured reports; corroborator badge on a corroboration', async () => {
    const t = harness();
    const a = await seedUser(t, 'a');
    const b = await seedUser(t, 'b');
    const waterBodyId = await seedBody(t);

    for (let i = 0; i < 3; i++) await seedReport(t, a, waterBodyId, { measured: true });
    expect((await profile(t, a.id))?.badges).toContain('measured');

    // b's agreeing report corroborates one of a's ⇒ b earns the corroborator badge (first tier = 1).
    await seedReport(t, b, waterBodyId, { iceTypes: ['black_ice'] });
    expect((await profile(t, b.id))?.badges).toContain('corroborator');
  }, 15000);
});

describe('backfillReputation', () => {
  test('ledger ↔ counter parity, and idempotent restore of a corrupted counter', async () => {
    const t = harness();
    const author = await seedUser(t, 'author');
    const rater = await seedUser(t, 'rater');
    const waterBodyId = await seedBody(t);
    const reportId = await seedReport(t, author, waterBodyId, { measured: true });
    await rater.as.mutation(api.ratings.rate, {
      targetType: 'report',
      targetId: reportId,
      verdict: 'helpful',
    });

    const expected = (await profile(t, author.id))?.reputationPoints;
    // A clean backfill changes nothing (parity holds).
    expect((await t.mutation(internal.reputation.backfillReputation, {})).patched).toBe(0);

    // Corrupt the denormalized counter, then backfill restores it from the ledger.
    await t.run((ctx) => ctx.db.patch(author.id, { reputationPoints: 999 }));
    const res = await t.mutation(internal.reputation.backfillReputation, {});
    expect(res.patched).toBe(1);
    expect((await profile(t, author.id))?.reputationPoints).toBe(expected);
  }, 15000);
});
