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

  test('an UNTOUCHED field keeps its value and its rung — no provenance laundering', async () => {
    // The review regression (2026-07-31). The editor pre-filled every field and the mutation stamped
    // `operator` on everything it received, so saving a max you did know relabelled the imported mean
    // beside it as a survey reading: the public caption lost its `~` and the ETL could never fix it.
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/1', {
      meanDepthM: 4,
      meanDepthSource: 'hydrolakes_modeled' as const,
    });
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setDepth, { waterBodyId: body, maxDepthM: 18 });
    const row = await t.run((ctx) => ctx.db.get(body));
    expect(row?.maxDepthM).toBe(18);
    expect(row?.maxDepthSource).toBe('operator');
    expect(row?.meanDepthM).toBe(4); // untouched…
    expect(row?.meanDepthSource).toBe('hydrolakes_modeled'); // …and still a model's number
  });

  test('a save that touches nothing writes nothing at all', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/1', {
      meanDepthM: 4,
      meanDepthSource: 'lagos_us' as const,
    });
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setDepth, { waterBodyId: body });
    const row = await t.run((ctx) => ctx.db.get(body));
    expect(row?.meanDepthM).toBe(4);
    expect(row?.meanDepthSource).toBe('lagos_us');
    const audits = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(audits).toHaveLength(0); // nothing happened, so nothing is logged
  });

  test('an explicit `null` rejects a value and leaves the operator rung as a tombstone', async () => {
    // "A human read HydroLAKES' 14 m and says it's wrong" is a durable claim about the lake, so it has
    // to outlive the next import — which means the rung stays even though the number goes.
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/1', {
      meanDepthM: 14,
      meanDepthSource: 'hydrolakes_modeled' as const,
    });
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setDepth, { waterBodyId: body, meanDepthM: null });
    const row = await t.run((ctx) => ctx.db.get(body));
    expect(row?.meanDepthM).toBeUndefined();
    expect(row?.meanDepthSource).toBe('operator');
  });

  test('the tombstone keeps the import out, and `clearDepthOverride` lets it back in', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/1', {
      meanDepthM: 14,
      meanDepthSource: 'hydrolakes_modeled' as const,
    });
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setDepth, { waterBodyId: body, meanDepthM: null });

    const offer = {
      depths: [
        {
          source: 'osm' as const,
          externalId: 'way/1',
          meanDepthM: 14,
          meanDepthSource: 'hydrolakes_modeled' as const,
        },
      ],
    };
    const held = await t.mutation(internal.waterBodies.importDepths, offer);
    expect(held.operatorHeld).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(body)))?.meanDepthM).toBeUndefined();

    // Reversible, which is what makes the rejection safe to make in the first place.
    await mod.as.mutation(api.waterBodies.clearDepthOverride, {
      waterBodyId: body,
      measurements: ['mean'],
    });
    expect((await t.run((ctx) => ctx.db.get(body)))?.meanDepthSource).toBeUndefined();
    await t.mutation(internal.waterBodies.importDepths, offer);
    expect((await t.run((ctx) => ctx.db.get(body)))?.meanDepthM).toBe(14);
  });

  test('`clearDepthOverride` never touches an automated rung', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/1', {
      maxDepthM: 20,
      maxDepthSource: 'globathy' as const,
    });
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.clearDepthOverride, {
      waterBodyId: body,
      measurements: ['mean', 'max'],
    });
    const row = await t.run((ctx) => ctx.db.get(body));
    expect(row?.maxDepthM).toBe(20); // the thing released is the override, not the number
    expect(row?.maxDepthSource).toBe('globathy');
  });

  test('the audit row carries the prior values, not just the new ones', async () => {
    // A log that records only what a field became can answer "who changed this" and never "from what".
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/1', {
      meanDepthM: 4,
      meanDepthSource: 'lagos_us' as const,
    });
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setDepth, { waterBodyId: body, meanDepthM: 2 });
    const audit = (await t.run((ctx) => ctx.db.query('moderationActions').collect()))[0];
    expect(audit?.metadata).toMatchObject({
      meanDepthM: 2,
      prev: { meanDepthM: 4, meanDepthSource: 'lagos_us' },
    });
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
    expect(result).toMatchObject({ updated: 1, unmatched: 0, skipped: 0 });
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
    expect(result).toMatchObject({ updated: 0, unmatched: 1, skipped: 0 });
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

describe('waterBodies.matchAndImportDepths (the geometric join)', () => {
  /**
   * A body at (44, -72) spanning `half` degrees. Inserted, then run **through `importCanonical`** on the
   * same `externalId` — the insert is what gives us a typed id to assert on, and the import is what
   * builds the N1 cell rows. Those rows are what `listedBodiesNearCoord` reads, so a body without them
   * is unreachable from any spatial lookup (the same property that keeps an unlisted body invisible);
   * hand-inserting one guesses at the ladder rung and gets it wrong.
   */
  async function seedSquareBody(
    t: ReturnType<typeof convexTest>,
    half: number,
    areaSqM: number,
    name = 'Test Lake',
  ) {
    const externalId = `way/${name}`;
    const polygon = {
      type: 'Polygon' as const,
      coordinates: [
        [
          [-72 - half, 44 - half],
          [-72 + half, 44 - half],
          [-72 + half, 44 + half],
          [-72 - half, 44 + half],
          [-72 - half, 44 - half],
        ],
      ],
    };
    const bbox = { minLat: 44 - half, minLng: -72 - half, maxLat: 44 + half, maxLng: -72 + half };
    const id = await seedBody(t, externalId, {
      name,
      polygon,
      bbox,
      centroid: { lat: 44, lng: -72 },
      surfaceAreaSqM: areaSqM,
    });
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          name,
          type: 'lake' as const,
          source: 'osm' as const,
          externalId,
          polygon,
          bbox,
          centroid: { lat: 44, lng: -72 },
          surfaceAreaSqM: areaSqM,
        },
      ],
    });
    return id;
  }

  test('stamps depth on the body the source lake’s point falls inside', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t, 0.05, 1e7);
    const result = await t.mutation(internal.waterBodies.matchAndImportDepths, {
      lakes: [
        {
          key: 'hylak/1',
          point: { lat: 44, lng: -72 },
          areaSqM: 1.2e7,
          meanDepthM: 6,
          meanDepthSource: 'hydrolakes_modeled' as const,
        },
      ],
    });
    expect(result.updated).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(body)))?.meanDepthM).toBe(6);
  });

  test('rejects an order-of-magnitude area mismatch, naming the body it declined', async () => {
    // The one failure mode of a spatial join that produces a WRONG answer rather than no answer:
    // a big lake's representative point landing inside the small pond next door.
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t, 0.005, 1e5, 'Little Pond');
    const result = await t.mutation(internal.waterBodies.matchAndImportDepths, {
      lakes: [
        {
          key: 'hylak/9',
          point: { lat: 44, lng: -72 },
          areaSqM: 8e7, // 800× our pond
          maxDepthM: 60,
          maxDepthSource: 'globathy' as const,
        },
      ],
    });
    expect(result).toMatchObject({ updated: 0, areaRejected: 1 });
    expect(result.rejects[0]?.reason).toContain('Little Pond');
    expect((await t.run((ctx) => ctx.db.get(body)))?.maxDepthM).toBeUndefined();
  });

  test('counts a point that lands on no body, and does not fall back to the nearest', async () => {
    const t = convexTest(schema, modules);
    await seedSquareBody(t, 0.005, 1e5);
    const result = await t.mutation(internal.waterBodies.matchAndImportDepths, {
      lakes: [
        {
          key: 'hylak/7',
          // The polygon spans 43.995–44.005 (0.005° ≈ 555 m), so this sits ~330 m off its north
          // shore — outside the body, but well inside the 0.01° box the lookup searches.
          point: { lat: 44.008, lng: -72 },
          areaSqM: 1e5,
          maxDepthM: 9,
          maxDepthSource: 'globathy' as const,
        },
      ],
    });
    expect(result).toMatchObject({ updated: 0, unmatched: 1 });
    expect(result.rejects[0]?.reason).toMatch(/no listed body/);
  });

  test('skips the area gate when either side has no area (and still stamps)', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t, 0.05, 0);
    const result = await t.mutation(internal.waterBodies.matchAndImportDepths, {
      lakes: [
        {
          key: 'lagos/3',
          point: { lat: 44, lng: -72 },
          maxDepthM: 14,
          maxDepthSource: 'lagos_us' as const,
        },
      ],
    });
    expect(result.updated).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(body)))?.maxDepthM).toBe(14);
  });

  test('honors the ladder — an operator value survives a geometric match too', async () => {
    const t = convexTest(schema, modules);
    const body = await seedSquareBody(t, 0.05, 1e7);
    await t.run((ctx) => ctx.db.patch(body, { maxDepthM: 3, maxDepthSource: 'operator' as const }));
    const result = await t.mutation(internal.waterBodies.matchAndImportDepths, {
      lakes: [
        {
          key: 'hylak/1',
          point: { lat: 44, lng: -72 },
          areaSqM: 1e7,
          maxDepthM: 40,
          maxDepthSource: 'globathy' as const,
        },
      ],
    });
    expect(result.skipped).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(body)))?.maxDepthM).toBe(3);
  });
});

describe('waterBodies.setDepth — the source note (D68 amendment)', () => {
  test('stores a trimmed note and carries it into the audit reason', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setDepth, {
      waterBodyId: body,
      maxDepthM: 18,
      sourceNote: '  NH Fish & Game bathymetry, 1998  ',
    });
    expect((await t.run((ctx) => ctx.db.get(body)))?.depthSourceNote).toBe(
      'NH Fish & Game bathymetry, 1998',
    );
    // The moderation log is where you ask "who claimed this, on what basis" — so the basis is in it.
    const audits = await t.run((ctx) =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) =>
          q.eq('targetType', 'waterbody').eq('targetId', body as string),
        )
        .collect(),
    );
    expect(audits[0]?.reason).toContain('NH Fish & Game bathymetry, 1998');
  });

  test('clearing both depths clears the note — it can never outlive the claim', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/1', {
      maxDepthM: 18,
      maxDepthSource: 'operator' as const,
      depthSourceNote: 'VT DEC chart, 2012',
    });
    const mod = await seedUser(t, 'mod', 'moderator');
    // Rejecting the last operator number leaves a tombstone but no claim for the note to substantiate.
    await mod.as.mutation(api.waterBodies.setDepth, { waterBodyId: body, maxDepthM: null });
    expect((await t.run((ctx) => ctx.db.get(body)))?.depthSourceNote).toBeUndefined();
  });

  test('a whitespace-only note stores as absent, not as an empty citation', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await mod.as.mutation(api.waterBodies.setDepth, {
      waterBodyId: body,
      maxDepthM: 9,
      sourceNote: '   ',
    });
    expect((await t.run((ctx) => ctx.db.get(body)))?.depthSourceNote).toBeUndefined();
  });

  test('refuses a note long enough to be a paragraph (it renders inline)', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    const mod = await seedUser(t, 'mod', 'moderator');
    await expect(
      mod.as.mutation(api.waterBodies.setDepth, {
        waterBodyId: body,
        maxDepthM: 9,
        sourceNote: 'x'.repeat(200),
      }),
    ).rejects.toThrow(/keep it under/i);
  });
});

/**
 * The pair invariant (Greptile, PR #33). The ladder resolves each measurement independently — D68
 * working as designed, since mean and max routinely come from different rungs — but independently
 * resolved is not jointly valid. Two sources that matched slightly different lakes can each win their
 * own slot and leave `mean 30 m` beside `max 6 m`: impossible for one basin, shown to skaters as fact,
 * and worse than cosmetic because `isShallowDepth` prefers the mean, so the contradicted number is the
 * one deciding the safety classification.
 */
describe('the depth pair is never left inverted', () => {
  /** A cell-indexed square body at (44, -72), so the geometric join can find it. */
  async function seedMatchableBody(t: ReturnType<typeof convexTest>) {
    const polygon = square(0.05);
    const shifted = {
      ...polygon,
      coordinates: [
        polygon.coordinates[0]?.map(([x, y]) => [(x as number) - 72, (y as number) + 44]),
      ],
    } as Polygon;
    const bbox = { minLat: 43.95, minLng: -72.05, maxLat: 44.05, maxLng: -71.95 };
    const id = await seedBody(t, 'way/pair', { polygon: shifted, bbox });
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          name: 'Pair Lake',
          type: 'lake' as const,
          source: 'osm' as const,
          externalId: 'way/pair',
          polygon: shifted,
          bbox,
          centroid: { lat: 44, lng: -72 },
          surfaceAreaSqM: 1e7,
        },
      ],
    });
    return id;
  }

  test('a later record cannot leave a mean deeper than the stored max', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/42', {
      maxDepthM: 6,
      maxDepthSource: 'lagos_us' as const,
    });
    const result = await t.mutation(internal.waterBodies.importDepths, {
      depths: [
        {
          source: 'osm' as const,
          externalId: 'way/42',
          meanDepthM: 30,
          meanDepthSource: 'hydrolakes_modeled' as const,
        },
      ],
    });
    const row = await t.run((ctx) => ctx.db.get(body));
    // The measured max outranks the modelled mean, so the mean is refused — not stored beside it.
    expect(row?.maxDepthM).toBe(6);
    expect(row?.meanDepthM).toBeUndefined();
    expect(result.inverted).toBe(1);
    expect(result.rejects[0]?.reason).toMatch(/exceeds max/);
  });

  test('a better-ranked incoming max retracts the modelled mean it contradicts', async () => {
    // The other direction of arrival, and the reason a refusal alone isn't enough: leaving the stored
    // mean would keep the impossible pair on display and in the classifier.
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/42', {
      meanDepthM: 30,
      meanDepthSource: 'hydrolakes_modeled' as const,
    });
    await t.mutation(internal.waterBodies.importDepths, {
      depths: [
        {
          source: 'osm' as const,
          externalId: 'way/42',
          maxDepthM: 9,
          maxDepthSource: 'lagos_us' as const,
        },
      ],
    });
    const row = await t.run((ctx) => ctx.db.get(body));
    expect(row?.maxDepthM).toBe(9);
    expect(row?.meanDepthM).toBeUndefined();
    expect(row?.meanDepthSource).toBeUndefined(); // the rung goes too, so a later run may refill it
  });

  test('one record carrying both keeps the better-ranked half', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/42');
    await t.mutation(internal.waterBodies.importDepths, {
      depths: [
        {
          source: 'osm' as const,
          externalId: 'way/42',
          meanDepthM: 12,
          meanDepthSource: 'hydrolakes_modeled' as const,
          maxDepthM: 9,
          maxDepthSource: 'globathy' as const,
        },
      ],
    });
    const row = await t.run((ctx) => ctx.db.get(body));
    expect(row?.meanDepthM).toBe(12); // hydrolakes_modeled outranks globathy
    expect(row?.maxDepthM).toBeUndefined();
  });

  test('on a rank tie the MEAN goes — the conservative half (D69)', async () => {
    // Dropping the mean routes the body through the generous max fallback, which is the direction that
    // keeps a shallow lake classified shallow when we are least sure.
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/42');
    await t.mutation(internal.waterBodies.importDepths, {
      depths: [
        {
          source: 'osm' as const,
          externalId: 'way/42',
          meanDepthM: 20,
          meanDepthSource: 'lagos_us' as const,
          maxDepthM: 5,
          maxDepthSource: 'lagos_us' as const,
        },
      ],
    });
    const row = await t.run((ctx) => ctx.db.get(body));
    expect(row?.meanDepthM).toBeUndefined();
    expect(row?.maxDepthM).toBe(5);
  });

  test('an operator value is never the half that gets dropped', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/42', {
      meanDepthM: 4,
      meanDepthSource: 'operator' as const,
    });
    await t.mutation(internal.waterBodies.importDepths, {
      depths: [
        {
          source: 'osm' as const,
          externalId: 'way/42',
          maxDepthM: 2,
          maxDepthSource: 'lagos_us' as const,
        },
      ],
    });
    const row = await t.run((ctx) => ctx.db.get(body));
    expect(row?.meanDepthM).toBe(4); // rung 1 stands…
    expect(row?.maxDepthM).toBeUndefined(); // …and the contradicting offer is what gives way
  });

  test('the geometric join enforces it too — one rule, both entry points', async () => {
    const t = convexTest(schema, modules);
    const body = await seedMatchableBody(t);
    await t.mutation(internal.waterBodies.matchAndImportDepths, {
      lakes: [
        {
          key: 'hylak/5',
          point: { lat: 44, lng: -72 },
          areaSqM: 1e7,
          meanDepthM: 40,
          meanDepthSource: 'hydrolakes_modeled' as const,
          maxDepthM: 8,
          maxDepthSource: 'globathy' as const,
        },
      ],
    });
    const row = await t.run((ctx) => ctx.db.get(body));
    // Asserted positively, so the test proves the join matched rather than passing on a miss.
    expect(row?.meanDepthM).toBe(40); // hydrolakes_modeled outranks globathy
    expect(row?.maxDepthM).toBeUndefined();
  });

  test('a consistent pair is left entirely alone', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t, 'way/42');
    const result = await t.mutation(internal.waterBodies.importDepths, {
      depths: [
        {
          source: 'osm' as const,
          externalId: 'way/42',
          meanDepthM: 4,
          meanDepthSource: 'lagos_us' as const,
          maxDepthM: 18,
          maxDepthSource: 'globathy' as const,
        },
      ],
    });
    const row = await t.run((ctx) => ctx.db.get(body));
    expect(row?.meanDepthM).toBe(4);
    expect(row?.maxDepthM).toBe(18);
    expect(result.inverted).toBe(0);
  });
});
