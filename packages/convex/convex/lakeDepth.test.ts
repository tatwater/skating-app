/**
 * Lake depth: the operator override and the ETL loader (N6a / D68).
 *
 * The load-bearing property here is the one the roadmap's "own data PR" framing would have missed —
 * a re-runnable global join must never silently undo a moderator's survey reading.
 */

import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function square(half: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
        [-half, -half],
      ],
    ],
  };
}

async function seedBody(
  t: ReturnType<typeof convexTest>,
  externalId = 'way/1',
  extra: Record<string, unknown> = {},
) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Test Lake',
      type: 'lake' as const,
      source: 'osm' as const,
      externalId,
      polygon: square(0.05),
      bbox: { minLat: 43.95, minLng: -72.05, maxLat: 44.05, maxLng: -71.95 },
      centroid: { lat: 44.0, lng: -72.0 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
      ...extra,
    }),
  ) as Promise<Id<'waterBodies'>>;
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: 'member' | 'moderator' | 'admin' = 'member',
) {
  const id = await t.run((ctx) =>
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
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

describe('waterBodies.setDepth (D68 rung 1)', () => {
  test('a member cannot set a depth', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const member = await seedUser(t, 'member');
    await expect(
      member.as.mutation(api.waterBodies.setDepth, { waterBodyId: body, maxDepthM: 12 }),
    ).rejects.toThrow(/moderator/i);
  });

  test('stores both depths as `operator`-sourced and audits the write', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setDepth, {
      waterBodyId: body,
      meanDepthM: 4,
      maxDepthM: 18,
    });

    const row = await t.run((ctx) => ctx.db.get(body));
    expect(row?.meanDepthM).toBe(4);
    expect(row?.meanDepthSource).toBe('operator');
    expect(row?.maxDepthM).toBe(18);
    expect(row?.maxDepthSource).toBe('operator');

    const audits = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) =>
          q.eq('targetType', 'waterbody').eq('targetId', body as string),
        )
        .collect(),
    );
    expect(audits.map((a) => a.action)).toEqual(['set_lake_depth']);
    expect(audits[0]?.reason).toContain('mean 4 m');
  });

  test('a max with no mean is a normal state — no mean is invented from it', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setDepth, { waterBodyId: body, maxDepthM: 8 });
    const row = await t.run((ctx) => ctx.db.get(body));
    expect(row?.maxDepthM).toBe(8);
    expect(row?.meanDepthM).toBeUndefined();
    expect(row?.meanDepthSource).toBeUndefined();
  });

  test('clearing a value clears its source too — never provenance without a number', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/1', {
      meanDepthM: 4,
      meanDepthSource: 'lagos_us' as const,
      maxDepthM: 18,
      maxDepthSource: 'globathy' as const,
    });
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setDepth, { waterBodyId: body });
    const row = await t.run((ctx) => ctx.db.get(body));
    expect(row?.meanDepthM).toBeUndefined();
    expect(row?.meanDepthSource).toBeUndefined();
    expect(row?.maxDepthM).toBeUndefined();
    expect(row?.maxDepthSource).toBeUndefined();
  });

  test('refuses a non-positive or implausible depth', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await expect(
      mod.as.mutation(api.waterBodies.setDepth, { waterBodyId: body, maxDepthM: 0 }),
    ).rejects.toThrow(/positive/i);
    await expect(
      mod.as.mutation(api.waterBodies.setDepth, { waterBodyId: body, maxDepthM: 900 }),
    ).rejects.toThrow(/deeper than any lake/i);
  });

  test('refuses a mean deeper than the max (the transposition that flips isShallowDepth)', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await expect(
      mod.as.mutation(api.waterBodies.setDepth, {
        waterBodyId: body,
        meanDepthM: 30,
        maxDepthM: 6,
      }),
    ).rejects.toThrow(/transposed/i);
  });
});

describe('waterBodies.importDepths (the D68 ladder, enforced at the write boundary)', () => {
  test('stamps depths onto a body matched by externalId', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/42');
    const result = await t.mutation(internal.waterBodies.importDepths, {
      depths: [
        {
          source: 'osm' as const,
          externalId: 'way/42',
          meanDepthM: 3.2,
          meanDepthSource: 'hydrolakes_modeled' as const,
          maxDepthM: 9,
          maxDepthSource: 'globathy' as const,
        },
      ],
    });
    expect(result).toEqual({ updated: 1, unmatched: 0, skipped: 0 });
    const row = await t.run((ctx) => ctx.db.get(body));
    expect(row?.meanDepthM).toBe(3.2);
    expect(row?.maxDepthSource).toBe('globathy');
  });

  test('NEVER overwrites an operator value — the durability half of rung 1', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/42', {
      meanDepthM: 1.5,
      meanDepthSource: 'operator' as const,
    });
    const result = await t.mutation(internal.waterBodies.importDepths, {
      depths: [
        {
          source: 'osm' as const,
          externalId: 'way/42',
          meanDepthM: 11,
          meanDepthSource: 'lagos_us' as const,
        },
      ],
    });
    expect(result.skipped).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(body)))?.meanDepthM).toBe(1.5);
  });

  test('a worse rung never displaces a better one, per measurement', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/42', {
      meanDepthM: 4,
      meanDepthSource: 'lagos_us' as const,
    });
    // Modelled mean loses; the max is unset, so it lands.
    await t.mutation(internal.waterBodies.importDepths, {
      depths: [
        {
          source: 'osm' as const,
          externalId: 'way/42',
          meanDepthM: 9,
          meanDepthSource: 'hydrolakes_modeled' as const,
          maxDepthM: 20,
          maxDepthSource: 'globathy' as const,
        },
      ],
    });
    const row = await t.run((ctx) => ctx.db.get(body));
    expect(row?.meanDepthM).toBe(4); // measured mean held
    expect(row?.meanDepthSource).toBe('lagos_us');
    expect(row?.maxDepthM).toBe(20); // modelled max filled an empty slot
  });

  test('a better rung does displace a worse one, in either load order', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/42', {
      meanDepthM: 9,
      meanDepthSource: 'hydrolakes_modeled' as const,
    });
    await t.mutation(internal.waterBodies.importDepths, {
      depths: [
        {
          source: 'osm' as const,
          externalId: 'way/42',
          meanDepthM: 4,
          meanDepthSource: 'lagos_us' as const,
        },
      ],
    });
    expect((await t.run((ctx) => ctx.db.get(body)))?.meanDepthM).toBe(4);
  });

  test('re-running the same source updates the value (a republished correction lands)', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/42', {
      meanDepthM: 4,
      meanDepthSource: 'lagos_us' as const,
    });
    await t.mutation(internal.waterBodies.importDepths, {
      depths: [
        {
          source: 'osm' as const,
          externalId: 'way/42',
          meanDepthM: 4.6,
          meanDepthSource: 'lagos_us' as const,
        },
      ],
    });
    expect((await t.run((ctx) => ctx.db.get(body)))?.meanDepthM).toBe(4.6);
  });

  test('counts an unmatched externalId instead of throwing (a batch must not die on one miss)', async () => {
    const t = convexTest(schema, modules);
    await seedBody(t, 'way/42');
    const result = await t.mutation(internal.waterBodies.importDepths, {
      depths: [
        {
          source: 'osm' as const,
          externalId: 'way/does-not-exist',
          maxDepthM: 5,
          maxDepthSource: 'globathy' as const,
        },
      ],
    });
    expect(result).toEqual({ updated: 0, unmatched: 1, skipped: 0 });
  });

  test('a canonical re-import leaves depth untouched (importCanonical patches a field list)', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/42', {
      meanDepthM: 1.5,
      meanDepthSource: 'operator' as const,
    });
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          name: 'Test Lake (renamed upstream)',
          type: 'lake' as const,
          source: 'osm' as const,
          externalId: 'way/42',
          polygon: square(0.06),
          bbox: { minLat: 43.94, minLng: -72.06, maxLat: 44.06, maxLng: -71.94 },
          centroid: { lat: 44.0, lng: -72.0 },
          surfaceAreaSqM: 1e6,
        },
      ],
    });
    const row = await t.run((ctx) => ctx.db.get(body));
    expect(row?.name).toBe('Test Lake (renamed upstream)'); // the re-import did run
    expect(row?.meanDepthM).toBe(1.5); // and depth survived it
    expect(row?.meanDepthSource).toBe('operator');
  });
});
