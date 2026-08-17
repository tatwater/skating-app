import { seasonOf, seasonStartMs } from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
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
  bountyFulfilled: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: false,
  greatReportNearby: false,
};

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: 'member' | 'moderator' | 'admin' = 'member',
) {
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
      role,
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

async function seedBody(t: ReturnType<typeof convexTest>, externalId = 'osm/1') {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        externalId,
        osmId: externalId,
        name: 'Lake Morey',
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
  return body._id as Id<'waterBodies'>;
}

const SKATE_TIME = Date.UTC(2026, 0, 10);

describe('putIns.listForBody', () => {
  test('returns [] for an unknown body', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    await t.run((ctx) => ctx.db.delete(id));
    expect(await t.query(api.putIns.listForBody, { waterBodyId: id })).toEqual([]);
  });

  test('derives a clustered marker snapped to shore from visible report points', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    // Two reports at the centroid (default point) cluster into one marker.
    await asUser.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });
    await asUser.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME + 1 });

    const markers = await t.query(api.putIns.listForBody, { waterBodyId: id });
    expect(markers).toHaveLength(1);
    expect(markers[0]?.source).toBe('derived');
    expect(markers[0]?.reportCount).toBe(2);
    // Snapped to the polygon boundary — one coordinate sits on an edge (0 or 1).
    const coord = markers[0]?.coord ?? { lat: 0.5, lng: 0.5 };
    const onEdge = [coord.lat, coord.lng].some((c) => Math.abs(c) < 1e-6 || Math.abs(c - 1) < 1e-6);
    expect(onEdge).toBe(true);
  });

  // The N5a trap, asserted rather than commented: put-ins derive from reports, and reports are the
  // most thoroughly season-scoped read in the app. A bound added here would narrow access points to
  // this winter's with no error and no empty state — losing exactly what the exemption protects.
  test('survives the seasonal reset — where you get on the ice is not a seasonal fact (D63)', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    const reportId = await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
    });
    // Drag the report two seasons back. The lake's list and the feed stop showing it; the access
    // point it revealed does not stop being where you park.
    const twoSeasonsAgo = seasonStartMs(seasonOf(Date.now()) - 2) + 1;
    await t.run((ctx) => ctx.db.patch(reportId, { skateEndTime: twoSeasonsAgo }));

    const markers = await t.query(api.putIns.listForBody, { waterBodyId: id });
    expect(markers).toHaveLength(1);
    // …and it says how old it is instead of pretending to be last week (D62 second amendment).
    expect(markers[0]?.lastUsedAt).toBe(twoSeasonsAgo);
  });

  test('excludes reports that opted out of showPutIn (private property)', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    await asUser.mutation(api.reports.create, {
      waterBodyId: id,
      skateEndTime: SKATE_TIME,
      showPutIn: false,
    });
    expect(await t.query(api.putIns.listForBody, { waterBodyId: id })).toEqual([]);
  });

  test('lists official markers first, then derived', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await asUser.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });
    // Official marker well away from the derived cluster's shore point.
    await asMod.mutation(api.putIns.setOfficial, {
      waterBodyId: id,
      coord: { lat: 0.9, lng: 0.1 },
    });

    const markers = await t.query(api.putIns.listForBody, { waterBodyId: id });
    expect(markers[0]?.source).toBe('official');
    expect(markers.some((m) => m.source === 'derived')).toBe(true);
  });

  test('a moderator hide suppresses a derived coord', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asUser = await seedUser(t, 'clerk_a');
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await asUser.mutation(api.reports.create, { waterBodyId: id, skateEndTime: SKATE_TIME });

    const before = await t.query(api.putIns.listForBody, { waterBodyId: id });
    expect(before).toHaveLength(1);
    const target = before[0]?.coord ?? { lat: 0.5, lng: 0.5 };

    await asMod.mutation(api.putIns.hide, {
      waterBodyId: id,
      coord: target,
      reason: 'private access',
    });
    const after = await t.query(api.putIns.listForBody, { waterBodyId: id });
    expect(after).toEqual([]);
  });
});

describe('putIns.setOfficial / hide (auth + audit)', () => {
  test('setOfficial requires a moderator and writes an audit row', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asMember = await seedUser(t, 'clerk_member');
    await expect(
      asMember.mutation(api.putIns.setOfficial, { waterBodyId: id, coord: { lat: 0.5, lng: 0 } }),
    ).rejects.toThrow(/moderator/i);

    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await asMod.mutation(api.putIns.setOfficial, { waterBodyId: id, coord: { lat: 0.5, lng: 0 } });
    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions).toHaveLength(1);
    expect(actions[0]?.targetType).toBe('waterbody');
    expect(actions[0]?.action).toBe('set_put_in'); // a dedicated verb, not the misleading 'restore'
  });

  /**
   * The operator UI (N6f) can name a hand-placed launch. `osm` arrives with OSM's name and `derived`
   * is labelled by compass bearing, so `official` was the one rung that could never be named —
   * despite being the rung where somebody actually knows what the place is called.
   */
  test('setOfficial stores an operator-supplied name, and says it in the audit line', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await asMod.mutation(api.putIns.setOfficial, {
      waterBodyId: id,
      coord: { lat: 0.5, lng: 0 },
      name: '  Town Beach  ',
    });

    const rows = await t.run((ctx) => ctx.db.query('putIns').collect());
    expect(rows[0]?.name).toBe('Town Beach'); // trimmed
    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions[0]?.reason).toBe('Set official put-in: Town Beach');
  });

  test('a blank name stores as absent, so the compass fallback still applies', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await asMod.mutation(api.putIns.setOfficial, {
      waterBodyId: id,
      coord: { lat: 0.5, lng: 0 },
      name: '   ',
    });
    const rows = await t.run((ctx) => ctx.db.query('putIns').collect());
    expect(rows[0]?.name).toBeUndefined();
  });

  test('refuses a name long enough to be a description', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await expect(
      asMod.mutation(api.putIns.setOfficial, {
        waterBodyId: id,
        coord: { lat: 0.5, lng: 0 },
        name: 'x'.repeat(80),
      }),
    ).rejects.toThrow(/Keep the name under/);
  });

  /**
   * `official` was the only rung stored raw (N6f): `derived` clusters are snapped in `listForBody`
   * because a report's point is where somebody *skated*, and `osm` launches arrive on the shore by
   * construction. A put-in coord is the directions destination (D#7), and the stated reason put-ins
   * exist at all is that routing to a point on the water sends you into the middle of the lake — so a
   * hand-placed floating pin reintroduces exactly that, one lake at a time.
   */
  test('snaps a mid-water click to the shoreline before storing it', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t); // the unit square [0,1]²
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');

    // Dead centre of the body — as far from any shore as this lake gets.
    await asMod.mutation(api.putIns.setOfficial, {
      waterBodyId: id,
      coord: { lat: 0.5, lng: 0.5 },
    });

    const row = (await t.run((ctx) => ctx.db.query('putIns').collect()))[0];
    // It landed on an edge of the square, not where the click was.
    const onEdge =
      Math.min(
        Math.abs((row?.coord.lat ?? 0) - 0),
        Math.abs((row?.coord.lat ?? 0) - 1),
        Math.abs((row?.coord.lng ?? 0) - 0),
        Math.abs((row?.coord.lng ?? 0) - 1),
      ) < 1e-6;
    expect(onEdge).toBe(true);
    expect(row?.coord).not.toEqual({ lat: 0.5, lng: 0.5 });
  });

  test('a click just outside the shore snaps in rather than being refused', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    // ~1 m outside the western edge — an ordinary slightly-off tap.
    await asMod.mutation(api.putIns.setOfficial, {
      waterBodyId: id,
      coord: { lat: 0.5, lng: -0.00001 },
    });
    expect(await t.run((ctx) => ctx.db.query('putIns').collect())).toHaveLength(1);
  });

  /**
   * The bound is only ever reached from *outside*: `distanceToPolygonMeters` reads 0 anywhere on the
   * water, so a mid-lake click can never trip it however big the lake. A click well inland is not a
   * missed shoreline — it is somebody marking a trailhead — and silently dragging it half a kilometre
   * onto the water would turn a mistake into a plausible wrong answer that directions would honour.
   */
  test('refuses a click far inland instead of silently relocating it', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await expect(
      asMod.mutation(api.putIns.setOfficial, {
        waterBodyId: id,
        coord: { lat: 0.5, lng: -0.05 }, // ~5.5 km west of the shore
      }),
    ).rejects.toThrow(/too far to snap/i);
    expect(await t.run((ctx) => ctx.db.query('putIns').collect())).toHaveLength(0);
  });

  test('the audit row records the snapped coord, not the raw click', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await asMod.mutation(api.putIns.setOfficial, {
      waterBodyId: id,
      coord: { lat: 0.5, lng: 0.5 },
    });
    const audit = (await t.run((ctx) => ctx.db.query('moderationActions').collect()))[0];
    const stored = (await t.run((ctx) => ctx.db.query('putIns').collect()))[0];
    const metadata = audit?.metadata as { coord?: unknown } | undefined;
    expect(metadata?.coord).toEqual(stored?.coord);
  });

  test('hide requires a non-empty reason', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await expect(
      asMod.mutation(api.putIns.hide, {
        waterBodyId: id,
        coord: { lat: 0.5, lng: 0 },
        reason: '  ',
      }),
    ).rejects.toThrow(/reason is required/i);
  });

  test('setOfficial rejects an unknown body', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await t.run((ctx) => ctx.db.delete(id));
    await expect(
      asMod.mutation(api.putIns.setOfficial, { waterBodyId: id, coord: { lat: 0.5, lng: 0 } }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('OSM-derived launches on the map (N6d)', () => {
  /**
   * ⚠ Caught in pre-PR review, and it would have shipped silently. `loadPutInRows` bucketed rows as
   * `official` or `derived`; an `osm` row is neither, so the **3,588 launches the access ETL imported
   * were invisible to the map's marker query** while the drawer — which reads `accessForBody`
   * directly — described them perfectly happily. The most visible artefact of the phase, missing.
   */
  test('an osm put-in renders, carrying its OSM name', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId: body,
        coord: { lat: 44.02, lng: -72 },
        name: 'Lake Fairlee Boat Ramp',
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: Date.now(),
      }),
    );

    const markers = await t.query(api.putIns.listForBody, { waterBodyId: body });
    expect(markers).toHaveLength(1);
    expect(markers[0]?.source).toBe('osm');
    expect(markers[0]?.name).toBe('Lake Fairlee Boat Ramp');
  });

  /** The ladder, on screen: an operator's pin outranks a mapped slipway. */
  test('an official marker sorts ahead of an osm one', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('putIns', {
        waterBodyId: body,
        coord: { lat: 44.02, lng: -72 },
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: Date.now(),
      });
      await ctx.db.insert('putIns', {
        waterBodyId: body,
        coord: { lat: 44.03, lng: -72 },
        name: 'The Real Landing',
        source: 'official' as const,
        status: 'visible' as const,
        createdAt: Date.now(),
      });
    });

    const markers = await t.query(api.putIns.listForBody, { waterBodyId: body });
    expect(markers.map((m) => m.source)).toEqual(['official', 'osm']);
    expect(markers[0]?.name).toBe('The Real Landing');
  });

  /** A moderator's `hide` must suppress an imported launch exactly as it suppresses any other. */
  test('a hidden coord suppresses an osm marker', async () => {
    const t = convexTest(schema, modules);
    const body = await seedBody(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('putIns', {
        waterBodyId: body,
        coord: { lat: 44.02, lng: -72 },
        source: 'osm' as const,
        status: 'visible' as const,
        createdAt: Date.now(),
      });
      await ctx.db.insert('putIns', {
        waterBodyId: body,
        coord: { lat: 44.02, lng: -72 },
        source: 'derived' as const,
        status: 'hidden' as const,
        createdAt: Date.now(),
      });
    });

    expect(await t.query(api.putIns.listForBody, { waterBodyId: body })).toHaveLength(0);
  });
});
