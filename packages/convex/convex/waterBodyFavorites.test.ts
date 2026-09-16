import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

function convexTestWithGeo() {
  const t = convexTest(schema, modules);
  return t;
}

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
};

async function seedUser(t: ReturnType<typeof convexTest>, subject: string) {
  await t.run((ctx) =>
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
  return t.withIdentity({ subject });
}

const POLYGON = {
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
};

async function seedBody(
  t: ReturnType<typeof convexTest>,
  externalId = 'osm/1',
  name = 'Lake Morey',
) {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        externalId,
        osmId: externalId,
        name,
        type: 'lakePond',
        polygon: POLYGON,
        bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        centroid: { lat: 0.5, lng: 0.5 },
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  const body = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  );
  if (!body) throw new Error('seed failed');
  return body._id;
}

describe('waterBodyFavorites.toggle', () => {
  test('requires authentication', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    await expect(t.mutation(api.waterBodyFavorites.toggle, { waterBodyId: id })).rejects.toThrow(
      /not authenticated/i,
    );
  });

  test('adds then removes on repeat toggles, one row per pair', async () => {
    const t = convexTestWithGeo();
    const asUser = await seedUser(t, 'clerk_a');
    const id = await seedBody(t);

    expect(await asUser.mutation(api.waterBodyFavorites.toggle, { waterBodyId: id })).toEqual({
      favorited: true,
    });
    expect(await asUser.query(api.waterBodyFavorites.isFavorite, { waterBodyId: id })).toBe(true);

    expect(await asUser.mutation(api.waterBodyFavorites.toggle, { waterBodyId: id })).toEqual({
      favorited: false,
    });
    expect(await asUser.query(api.waterBodyFavorites.isFavorite, { waterBodyId: id })).toBe(false);

    // Never more than one row for the pair.
    const rows = await t.run((ctx) => ctx.db.query('waterBodyFavorites').collect());
    expect(rows).toHaveLength(0);
  });

  test('rejects favoriting a delisted (removed) body', async () => {
    const t = convexTestWithGeo();
    const asUser = await seedUser(t, 'clerk_a');
    const id = await seedBody(t);
    await t.run((ctx) => ctx.db.patch(id, { removedAt: Date.now() }));
    await expect(
      asUser.mutation(api.waterBodyFavorites.toggle, { waterBodyId: id }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('waterBodyFavorites.isFavorite / listForUser', () => {
  test('isFavorite is false when signed out', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    expect(await t.query(api.waterBodyFavorites.isFavorite, { waterBodyId: id })).toBe(false);
  });

  test('listForUser returns favorited bodies newest-first with names', async () => {
    const t = convexTestWithGeo();
    const asUser = await seedUser(t, 'clerk_a');
    const a = await seedBody(t, 'osm/1', 'Lake A');
    const b = await seedBody(t, 'osm/2', 'Lake B');
    await asUser.mutation(api.waterBodyFavorites.toggle, { waterBodyId: a });
    await asUser.mutation(api.waterBodyFavorites.toggle, { waterBodyId: b });

    const list = await asUser.query(api.waterBodyFavorites.listForUser, {});
    expect(list.map((e) => e.name)).toEqual(['Lake B', 'Lake A']); // newest first
  });

  test('listForUser drops a favorite whose body later delisted', async () => {
    const t = convexTestWithGeo();
    const asUser = await seedUser(t, 'clerk_a');
    const a = await seedBody(t, 'osm/1', 'Lake A');
    await asUser.mutation(api.waterBodyFavorites.toggle, { waterBodyId: a });
    await t.run((ctx) => ctx.db.patch(a, { removedAt: Date.now() }));
    expect(await asUser.query(api.waterBodyFavorites.listForUser, {})).toEqual([]);
  });

  test('listForUser follows a merged body to its survivor name', async () => {
    const t = convexTestWithGeo();
    const asUser = await seedUser(t, 'clerk_a');
    const survivor = await seedBody(t, 'osm/1', 'Survivor');
    const loser = await seedBody(t, 'osm/2', 'Loser');
    await asUser.mutation(api.waterBodyFavorites.toggle, { waterBodyId: loser });
    await t.run((ctx) => ctx.db.patch(loser, { mergedIntoId: survivor, dedupStatus: 'merged' }));
    const list = await asUser.query(api.waterBodyFavorites.listForUser, {});
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('Survivor');
  });

  test('listForUser is empty when signed out', async () => {
    const t = convexTestWithGeo();
    expect(await t.query(api.waterBodyFavorites.listForUser, {})).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// N9 (D175): a favorite can name a bay
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A bay covering the west half of the fixture lake, drawn straight into the table. */
async function seedBay(
  t: ReturnType<typeof convexTest>,
  waterBodyId: Awaited<ReturnType<typeof seedBody>>,
  name = 'West Bay',
) {
  const author = await t.run(async (ctx) => {
    const profile = await ctx.db.query('profiles').first();
    if (!profile) throw new Error('seed a profile first');
    return profile._id;
  });
  return t.run((ctx) =>
    ctx.db.insert('waterBodySubAreas', {
      waterBodyId,
      name,
      searchText: name,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [0.5, 1],
            [0.5, 0],
            [0, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 0.5 },
      centroid: { lat: 0.5, lng: 0.25 },
      surfaceAreaSqM: 500_000,
      displayScore: 1,
      minVisibleZoom: 10,
      createdByUserId: author,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

describe('bay favorites (N9)', () => {
  test('the lake and a bay of it are separate favorites, each with its own heart', async () => {
    const t = convexTestWithGeo();
    const asUser = await seedUser(t, 'clerk_a');
    const id = await seedBody(t, 'osm/1', 'Lake Champlain');
    const bay = await seedBay(t, id, 'Malletts Bay');

    expect(
      await asUser.mutation(api.waterBodyFavorites.toggle, { waterBodyId: id, subAreaId: bay }),
    ).toEqual({ favorited: true });
    expect(
      await asUser.query(api.waterBodyFavorites.isFavorite, { waterBodyId: id, subAreaId: bay }),
    ).toBe(true);
    // The lake's own heart is untouched by the bay's.
    expect(await asUser.query(api.waterBodyFavorites.isFavorite, { waterBodyId: id })).toBe(false);

    expect(await asUser.mutation(api.waterBodyFavorites.toggle, { waterBodyId: id })).toEqual({
      favorited: true,
    });
    const rows = await t.run((ctx) => ctx.db.query('waterBodyFavorites').collect());
    expect(rows.map((r) => r.subAreaId).sort()).toEqual([bay, undefined]);

    // The list names the bay beside its lake; a second toggle on the bay removes only that row.
    const list = await asUser.query(api.waterBodyFavorites.listForUser, {});
    expect(list.map((f) => [f.name, f.subAreaName])).toEqual([
      ['Lake Champlain', undefined],
      ['Lake Champlain', 'Malletts Bay'],
    ]);
    expect(
      await asUser.mutation(api.waterBodyFavorites.toggle, { waterBodyId: id, subAreaId: bay }),
    ).toEqual({ favorited: false });
    expect(await asUser.query(api.waterBodyFavorites.isFavorite, { waterBodyId: id })).toBe(true);
  });

  test("refuses a bay that is not this lake's, and one that has been delisted", async () => {
    const t = convexTestWithGeo();
    const asUser = await seedUser(t, 'clerk_a');
    const morey = await seedBody(t, 'osm/1', 'Lake Morey');
    const champlain = await seedBody(t, 'osm/2', 'Lake Champlain');
    const bay = await seedBay(t, champlain);
    await expect(
      asUser.mutation(api.waterBodyFavorites.toggle, { waterBodyId: morey, subAreaId: bay }),
    ).rejects.toThrow(/not on this water body/i);
    await t.run((ctx) => ctx.db.patch(bay, { removedAt: Date.now() }));
    await expect(
      asUser.mutation(api.waterBodyFavorites.toggle, { waterBodyId: champlain, subAreaId: bay }),
    ).rejects.toThrow(/not on this water body/i);
  });

  test('a favorite of a bay that later delists is skipped from the list, not surfaced', async () => {
    const t = convexTestWithGeo();
    const asUser = await seedUser(t, 'clerk_a');
    const id = await seedBody(t);
    const bay = await seedBay(t, id);
    await asUser.mutation(api.waterBodyFavorites.toggle, { waterBodyId: id, subAreaId: bay });
    await t.run((ctx) => ctx.db.patch(bay, { removedAt: Date.now() }));
    expect(await asUser.query(api.waterBodyFavorites.listForUser, {})).toEqual([]);
  });
});
