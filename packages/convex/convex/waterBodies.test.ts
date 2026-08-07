import {
  belongsInCorpus,
  HARD_MIN_SURFACE_AREA_SQM,
  isWetlandClass,
  meetsAreaFloor,
} from '@skating/core';
import { convexTest } from 'convex-test';
import { describe, expect, it, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/** A `convexTest` instance. (It used to register the geospatial component; N1 retired it.) */
function convexTestWithGeo() {
  const t = convexTest(schema, modules);
  return t;
}

/** A viewport (bbox) centered on SAMPLE_BODY's centroid, and one far away. */
const VIEWPORT_CONTAINING = { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 };
const VIEWPORT_ELSEWHERE = { minLat: 40, minLng: -80, maxLat: 41, maxLng: -79 };

type Role = 'member' | 'moderator' | 'admin';
type Status = Doc<'profiles'>['status'];

const SAMPLE_BODY = {
  name: 'Lake Morey',
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
};

/**
 * A canonical (OSM) body as the ETL would hand it to `importCanonical`.
 *
 * **`osmId` is now required in practice** (N7 / D93): the upsert keys on the catalogue ids, and a
 * record carrying none cannot be identified at all — `resolveUpsert` returns `conflict` rather than
 * inventing one. It used to be derived from `source` + `externalId`, which is the conflation D93
 * exists to undo.
 */
const CANONICAL_ITEM = {
  source: 'osm' as const,
  externalId: 'osm/way/1',
  osmId: 'osm/way/1',
  name: 'Lake Champlain',
  type: 'lakePond' as const,
  polygon: SAMPLE_BODY.polygon,
  bbox: SAMPLE_BODY.bbox,
  centroid: SAMPLE_BODY.centroid,
  surfaceAreaSqM: 1_000_000,
};

/** `onlyBodyId` from inside an existing `t.run` context. */
// biome-ignore lint/suspicious/noExplicitAny: convex-test's ctx type is not exported.
async function onlyBodyIdIn(ctx: any): Promise<Id<'waterBodies'>> {
  const rows = await ctx.db.query('waterBodies').collect();
  return rows[0]._id as Id<'waterBodies'>;
}

/** The `_id` of the single water body in the DB (import/seed helpers create exactly one). */
async function onlyBodyId(t: ReturnType<typeof convexTest>): Promise<Id<'waterBodies'>> {
  const bodies = await t.run((ctx) => ctx.db.query('waterBodies').collect());
  const id = bodies[0]?._id;
  if (!id) throw new Error('expected exactly one water body');
  return id;
}

/** Seed a provisioned profile with a given role/status and return an identity-scoped tester. */
async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: Role = 'member',
  status: Status = 'active',
  suspendedUntil?: number,
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
      role,
      status,
      ...(suspendedUntil !== undefined ? { suspendedUntil } : {}),
      createdAt: Date.now(),
    }),
  );
  return t.withIdentity({ subject });
}

/**
 * Seed a recorded skate for `subject` and return the `create` args derived from it.
 *
 * Phase 8 made `waterBodies.create` **path-only** (D14/D36): the client cannot supply a polygon at
 * all — the server derives it from a trusted GPS track. So every create test now needs a real
 * recorded activity behind it, which is the point: there is no way to mint a body without one.
 *
 * The track is a ~1 km line well away from the fixtures at 0..1, so it never dedup-matches them.
 */
async function seedTrackCreateArgs(
  t: ReturnType<typeof convexTest>,
  subject: string,
  overrides: { name?: string; lat?: number; lng?: number } = {},
) {
  const lat = overrides.lat ?? 20;
  const lng = overrides.lng ?? 20;
  const profiles = await t.run((ctx) => ctx.db.query('profiles').collect());
  const profile = profiles.find((p) => p.clerkUserId === subject);
  if (!profile) throw new Error(`no profile for ${subject}`);
  const activityId = await t.run((ctx) =>
    ctx.db.insert('gpsActivities', {
      userId: profile._id,
      provider: 'native' as const,
      providerActivityId: `track-${subject}-${lat}-${lng}`,
      sportType: 'IceSkate',
      startTime: Date.now() - 3_600_000,
      endTime: Date.now(),
      path: {
        type: 'LineString' as const,
        coordinates: Array.from({ length: 12 }, (_, i) => [lng + i * 0.001, lat]),
      },
      promptState: 'pending' as const,
      detectedAt: Date.now(),
    }),
  );
  return {
    name: overrides.name ?? 'Lake Morey',
    type: 'lakePond' as const,
    activityId,
    confirmedNew: true,
  };
}

describe('waterBodies.create (path-only, D14/D36)', () => {
  test('rejects unauthenticated callers', async () => {
    const t = convexTestWithGeo();
    await seedUser(t, 'clerk_member');
    const args = await seedTrackCreateArgs(t, 'clerk_member');
    await expect(t.mutation(api.waterBodies.create, args)).rejects.toThrow(/not authenticated/i);
  });

  test('rejects a minor — read-only (D41)', async () => {
    const t = convexTestWithGeo();
    await t.run((ctx) =>
      ctx.db.insert('profiles', {
        clerkUserId: 'clerk_minor',
        displayName: 'minor',
        username: 'minor',
        driveTimePrefMinutes: 60,
        profileVisibility: 'private' as const,
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
        dateOfBirth: Date.UTC(new Date().getUTCFullYear() - 16, 0, 1),
        reputationPoints: 0,
        role: 'member' as const,
        status: 'active' as const,
        createdAt: Date.now(),
      }),
    );
    const asMinor = t.withIdentity({ subject: 'clerk_minor' });
    const args = await seedTrackCreateArgs(t, 'clerk_minor');
    await expect(asMinor.mutation(api.waterBodies.create, args)).rejects.toThrow(/under 18/i);
  });

  test('rejects a banned account (status gate, D37)', async () => {
    const t = convexTestWithGeo();
    const asBanned = await seedUser(t, 'clerk_banned', 'member', 'banned');
    const args = await seedTrackCreateArgs(t, 'clerk_banned');
    await expect(asBanned.mutation(api.waterBodies.create, args)).rejects.toThrow(/not active/i);
  });

  test('rejects an account under active suspension (D37)', async () => {
    const t = convexTestWithGeo();
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const asSuspended = await seedUser(t, 'clerk_susp', 'member', 'suspended', future);
    const args = await seedTrackCreateArgs(t, 'clerk_susp');
    await expect(asSuspended.mutation(api.waterBodies.create, args)).rejects.toThrow(/suspended/i);
  });

  test('allows an account whose suspension has lapsed (D37)', async () => {
    const t = convexTestWithGeo();
    const past = Date.now() - 1000;
    const asLapsed = await seedUser(t, 'clerk_lapsed', 'member', 'suspended', past);
    const args = await seedTrackCreateArgs(t, 'clerk_lapsed');
    await expect(asLapsed.mutation(api.waterBodies.create, args)).resolves.toBeDefined();
  });

  test('a client CANNOT supply geometry at all — there is no freehand path into the map', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');
    const args = await seedTrackCreateArgs(t, 'clerk_member');
    // The old contract took a client polygon and validated its shape. The Phase 8 contract doesn't
    // take one, so a hand-drawn blob is rejected by the arg validator before any handler logic runs
    // — the "no freehand drawing, ever" rule enforced at the trust boundary rather than in the UI.
    await expect(
      asMember.mutation(api.waterBodies.create, {
        ...args,
        polygon: { type: 'Polygon', coordinates: [] },
      } as unknown as typeof args),
    ).rejects.toThrow();
  });

  test('rejects a skate that is not yours, and one with no recorded path', async () => {
    const t = convexTestWithGeo();
    await seedUser(t, 'clerk_owner');
    const asOther = await seedUser(t, 'clerk_other');
    const owned = await seedTrackCreateArgs(t, 'clerk_owner');
    await expect(asOther.mutation(api.waterBodies.create, owned)).rejects.toThrow(
      /Not your activity/i,
    );

    const pathless = await seedTrackCreateArgs(t, 'clerk_other', { lat: 25, lng: 25 });
    await t.run((ctx) => ctx.db.patch(pathless.activityId, { path: undefined }));
    await expect(asOther.mutation(api.waterBodies.create, pathless)).rejects.toThrow(
      /no recorded path/i,
    );
  });

  test('rejects a skate that already resolved to a known lake', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');
    const args = await seedTrackCreateArgs(t, 'clerk_member');
    const existing = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name: 'Known',
        type: 'lakePond' as const,
        source: 'osm' as const,
        polygon: SAMPLE_BODY.polygon,
        bbox: SAMPLE_BODY.bbox,
        centroid: SAMPLE_BODY.centroid,
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
      }),
    );
    await t.run((ctx) => ctx.db.patch(args.activityId, { waterBodyId: existing }));
    await expect(asMember.mutation(api.waterBodies.create, args)).rejects.toThrow(
      /already resolved/i,
    );
  });

  test('a member creates a pending, user-sourced body whose shape came from their track', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');
    const args = await seedTrackCreateArgs(t, 'clerk_member');

    const id = await asMember.mutation(api.waterBodies.create, args);
    const body = await t.run((ctx) => ctx.db.get(id));

    expect(body?.source).toBe('user');
    expect(body?.reviewStatus).toBe('pending');
    expect(body?.dedupStatus).toBe('clean');
    expect(body?.name).toBe('Lake Morey');
    // The geometry is derived, not supplied — a real polygon around where they actually skated.
    expect(body?.polygon.type).toBe('Polygon');
    expect(body?.surfaceAreaSqM ?? 0).toBeGreaterThan(0);
    // ...and the skate is now bound to the water it discovered, so the report flow carries on.
    const activity = await t.run((ctx) => ctx.db.get(args.activityId));
    expect(activity?.waterBodyId).toBe(id);
  });

  test('refuses to mint a duplicate silently — the user must say "none of these" (D36)', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');
    const first = await seedTrackCreateArgs(t, 'clerk_member', { name: 'Hidden Pond' });
    await asMember.mutation(api.waterBodies.create, first);

    // A second skate over the same water, without the explicit confirmation.
    const second = await seedTrackCreateArgs(t, 'clerk_member', {
      name: 'Hidden Pond',
      lat: 20.0005,
    });
    await expect(
      asMember.mutation(api.waterBodies.create, { ...second, confirmedNew: false }),
    ).rejects.toThrow(/already know about/i);
  });

  test('stamps the dedup verdict + candidates even when the user confirms it is new — this is what feeds the merge queue', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');
    const first = await seedTrackCreateArgs(t, 'clerk_member', { name: 'Hidden Pond' });
    const firstId = await asMember.mutation(api.waterBodies.create, first);

    const second = await seedTrackCreateArgs(t, 'clerk_member', {
      name: 'Hidden Pond',
      lat: 20.0005,
    });
    const secondId = await asMember.mutation(api.waterBodies.create, second);
    const body = await t.run((ctx) => ctx.db.get(secondId));

    expect(body?.dedupStatus).not.toBe('clean');
    expect(body?.duplicateCandidateIds).toContain(firstId);
    // ...and it is STILL listed: hiding it would take reports filed against it off the map on a
    // machine's guess (D3). A moderator merges it; the classifier never does.
    expect(body?.removedAt).toBeUndefined();
  });
});

describe('waterBodies.approve (role gating + audit log, D37)', () => {
  async function seedPendingBody(t: ReturnType<typeof convexTest>): Promise<Id<'waterBodies'>> {
    const asMember = await seedUser(t, 'clerk_member');
    return asMember.mutation(api.waterBodies.create, await seedTrackCreateArgs(t, 'clerk_member'));
  }

  test('a member cannot approve', async () => {
    const t = convexTestWithGeo();
    const bodyId = await seedPendingBody(t);
    const asMember = t.withIdentity({ subject: 'clerk_member' });
    await expect(
      asMember.mutation(api.waterBodies.approve, { waterBodyId: bodyId }),
    ).rejects.toThrow(/moderator/i);
  });

  test('a moderator approves and writes exactly one audit row', async () => {
    const t = convexTestWithGeo();
    const bodyId = await seedPendingBody(t);
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');

    const returned = await asMod.mutation(api.waterBodies.approve, { waterBodyId: bodyId });
    expect(returned).toEqual(bodyId);

    const body = await t.run((ctx) => ctx.db.get(bodyId));
    expect(body?.reviewStatus).toBe('approved');

    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe('approve_waterbody');
    expect(actions[0]?.targetType).toBe('waterbody');
    expect(actions[0]?.targetId).toBe(bodyId);
  });

  test('an admin may also approve (role precedence)', async () => {
    const t = convexTestWithGeo();
    const bodyId = await seedPendingBody(t);
    const asAdmin = await seedUser(t, 'clerk_admin', 'admin');

    await expect(
      asAdmin.mutation(api.waterBodies.approve, { waterBodyId: bodyId }),
    ).resolves.toEqual(bodyId);
  });

  test('cannot approve a body that is not pending (no rejection-reversal, no dup audit)', async () => {
    const t = convexTestWithGeo();
    const bodyId = await seedPendingBody(t);
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');

    await asMod.mutation(api.waterBodies.approve, { waterBodyId: bodyId });
    // Second approve on the now-approved body must be rejected.
    await expect(asMod.mutation(api.waterBodies.approve, { waterBodyId: bodyId })).rejects.toThrow(
      /not pending/i,
    );

    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions).toHaveLength(1); // exactly one audit row, not two
  });

  test('cannot approve a canonical (non-user) body', async () => {
    const t = convexTestWithGeo();
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    const canonicalId = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        ...SAMPLE_BODY,
        source: 'osm',
        externalId: 'osm/123',
        osmId: 'osm/123',
        dedupStatus: 'clean',
        createdAt: Date.now(),
      }),
    );
    await expect(
      asMod.mutation(api.waterBodies.approve, { waterBodyId: canonicalId }),
    ).rejects.toThrow(/user-created/i);
  });

  test('approving a missing body throws', async () => {
    const t = convexTestWithGeo();
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    // Create then delete to obtain a well-formed but dangling id.
    const bodyId = await t.run(async (ctx) => {
      const id = await ctx.db.insert('waterBodies', {
        ...SAMPLE_BODY,
        source: 'user',
        dedupStatus: 'clean',
        createdAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });
    await expect(asMod.mutation(api.waterBodies.approve, { waterBodyId: bodyId })).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('waterBodies.listInViewport (the ladder-grid read path, D5/N1)', () => {
  test('a pending user body is auto-visible (D37/D48) and stays visible after approval', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');
    const bodyId = await asMember.mutation(
      api.waterBodies.create,
      await seedTrackCreateArgs(t, 'clerk_member', { lat: 0.5, lng: 0.5 }),
    );

    // D48 fix: a fresh (pending) user body is listed immediately — not hidden until approved.
    const whilePending = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      zoom: 14,
    });
    expect(whilePending.map((b) => b._id)).toEqual([bodyId]);
    expect(whilePending[0]?.name).toBe('Lake Morey');

    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await asMod.mutation(api.waterBodies.approve, { waterBodyId: bodyId });

    const afterApprove = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      zoom: 14,
    });
    expect(afterApprove.map((b) => b._id)).toEqual([bodyId]);
  });

  test('excludes a body whose bbox does not intersect the viewport', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');
    await asMember.mutation(
      api.waterBodies.create,
      await seedTrackCreateArgs(t, 'clerk_member', { lat: 0.5, lng: 0.5 }),
    );

    const elsewhere = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_ELSEWHERE,
      zoom: 14,
    });
    expect(elsewhere).toHaveLength(0);
  });

  test('returns a large body whose centroid is off-screen but whose bbox overlaps (tier-2, D5)', async () => {
    const t = convexTestWithGeo();
    // The exact case that regressed at corpus scale: a big lake centred at (0.8, 0.8) — well
    // outside the tiny viewport AND outside the tier-1 margin — but whose bbox spans it. Only
    // the tier-2 large-body scan can catch it; tier 1's small margin never reaches its centroid.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          source: 'osm',
          externalId: 'osm/big',
          osmId: 'osm/big',
          name: 'Big Lake',
          type: 'lakePond',
          polygon: {
            type: 'Polygon',
            coordinates: [
              [
                [-1, -1],
                [-1, 1],
                [1, 1],
                [1, -1],
                [-1, -1],
              ],
            ],
          },
          bbox: { minLat: -1, minLng: -1, maxLat: 1, maxLng: 1 },
          centroid: { lat: 0.8, lng: 0.8 },
        },
      ],
    });
    const tinyViewport = { minLat: 0, minLng: 0, maxLat: 0.1, maxLng: 0.1 };
    const inView = await t.query(api.waterBodies.listInViewport, {
      viewport: tinyViewport,
      zoom: 14,
    });
    expect(inView.map((b) => b.name)).toEqual(['Big Lake']);
  });

  test('refines out a body that shares a cell with the viewport but whose bbox is not in view', async () => {
    const t = convexTestWithGeo();
    // A cell is coarser than the viewport at every rung but the finest, so "in one of these cells"
    // is a *superset* of "in view" — this pond (bbox 0.11–0.14) sits in a neighbouring cell that
    // the covering touches, and the bboxIntersects refine is what drops it.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          source: 'osm',
          externalId: 'osm/near',
          osmId: 'osm/near',
          name: 'Near Pond',
          type: 'lakePond',
          polygon: SAMPLE_BODY.polygon,
          bbox: { minLat: 0.11, minLng: 0.11, maxLat: 0.14, maxLng: 0.14 },
          centroid: { lat: 0.13, lng: 0.13 },
        },
      ],
    });
    const tinyViewport = { minLat: 0, minLng: 0, maxLat: 0.1, maxLng: 0.1 };
    expect(
      await t.query(api.waterBodies.listInViewport, { viewport: tinyViewport, zoom: 14 }),
    ).toHaveLength(0);
  });

  test('finds a small body at city zoom via the tier-1 centroid prefilter', async () => {
    const t = convexTestWithGeo();
    // A small pond fully inside a small viewport — the common case tier 1 serves.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          source: 'osm',
          externalId: 'osm/small',
          osmId: 'osm/small',
          name: 'Small Pond',
          type: 'lakePond',
          polygon: SAMPLE_BODY.polygon,
          bbox: { minLat: 0.04, minLng: 0.04, maxLat: 0.06, maxLng: 0.06 },
          centroid: { lat: 0.05, lng: 0.05 },
        },
      ],
    });
    const cityViewport = { minLat: 0, minLng: 0, maxLat: 0.1, maxLng: 0.1 };
    const inView = await t.query(api.waterBodies.listInViewport, {
      viewport: cityViewport,
      zoom: 14,
    });
    expect(inView.map((b) => b.name)).toEqual(['Small Pond']);
  });

  test('excludes a large body whose bbox does not intersect the viewport (tier-2 refine)', async () => {
    const t = convexTestWithGeo();
    // A large body (extent 2°, so it rides a coarse rung a wide query scans) far from the viewport.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          source: 'osm',
          externalId: 'osm/far-big',
          osmId: 'osm/far-big',
          name: 'Far Big Lake',
          type: 'lakePond',
          polygon: SAMPLE_BODY.polygon,
          bbox: { minLat: 40, minLng: 40, maxLat: 42, maxLng: 42 },
          centroid: { lat: 41, lng: 41 },
        },
      ],
    });
    const tinyViewport = { minLat: 0, minLng: 0, maxLat: 0.1, maxLng: 0.1 };
    expect(
      await t.query(api.waterBodies.listInViewport, { viewport: tinyViewport, zoom: 14 }),
    ).toHaveLength(0);
  });

  test('warns (does not silently drop) when the tier-1 cap is hit at a wide zoom (D5/D49)', async () => {
    const t = convexTestWithGeo();
    // Three prominent bodies inside a region-wide viewport; a limit of 2 forces the render budget
    // to truncate. Prominence matters: a 1°-wide viewport IS a wide zoom, and D49 only draws
    // prominent bodies there — so these carry a real area rather than being invisible ponds.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [0.3, 0.5, 0.7].map((c) => ({
        source: 'osm' as const,
        externalId: `osm/${c}`,
        osmId: `osm/${c}`,
        name: `Body ${c}`,
        type: 'lakePond' as const,
        polygon: SAMPLE_BODY.polygon,
        bbox: { minLat: c - 0.01, minLng: c - 0.01, maxLat: c + 0.01, maxLng: c + 0.01 },
        centroid: { lat: c, lng: c },
        surfaceAreaSqM: 1e9, // prominent enough to draw at the widest zoom
      })),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const inView = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      limit: 2,
      zoom: 8,
    });
    expect(inView).toHaveLength(2); // capped
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('render budget'));
    warn.mockRestore();
  });

  test('sanitizes a bogus limit (0/negative) to the default rather than emptying tier 1', async () => {
    const t = convexTestWithGeo();
    // Three prominent bodies inside a region-wide viewport.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [0.3, 0.5, 0.7].map((c) => ({
        source: 'osm' as const,
        externalId: `osm/${c}`,
        osmId: `osm/${c}`,
        name: `Body ${c}`,
        type: 'lakePond' as const,
        polygon: SAMPLE_BODY.polygon,
        bbox: { minLat: c - 0.01, minLng: c - 0.01, maxLat: c + 0.01, maxLng: c + 0.01 },
        centroid: { lat: c, lng: c },
        surfaceAreaSqM: 1e9,
      })),
    });
    // limit: 0 must NOT be taken literally (which would return nothing at all); it falls back to
    // the default, so all three bodies still come back.
    for (const limit of [0, -5]) {
      const inView = await t.query(api.waterBodies.listInViewport, {
        viewport: VIEWPORT_CONTAINING,
        limit,
        zoom: 8,
      });
      expect(inView).toHaveLength(3);
    }
  });

  test('returns all 300 in-view bodies — the old 256 clamp used to drop the tail (N1)', async () => {
    // The user-visible half of N1. `MAX_VIEWPORT_LIMIT` was 256, measured as a *safety* number
    // against Vermont's 9,967 bodies; across the Phase-2.5 corpus a dense viewport exceeds it, so
    // lakes silently stopped being drawn. With reads bounded by geometry the limit is only a render
    // budget, and 300 prominent bodies in view all come back. A client asking for a million still
    // gets no more than the ceiling — the clamp exists so the read-budget arithmetic holds.
    const t = convexTestWithGeo();
    const COUNT = 300;
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: Array.from({ length: COUNT }, (_, i) => {
        const c = 0.001 + (i * 0.998) / COUNT; // spread across [0,1), inside VIEWPORT_CONTAINING
        return {
          source: 'osm' as const,
          externalId: `osm/dense/${i}`,
          osmId: `osm/dense/${i}`,
          name: `Body ${i}`,
          type: 'lakePond' as const,
          polygon: SAMPLE_BODY.polygon,
          bbox: { minLat: c - 0.0005, minLng: c - 0.0005, maxLat: c + 0.0005, maxLng: c + 0.0005 },
          centroid: { lat: c, lng: c },
          surfaceAreaSqM: 1e9, // prominent, so the D49 cutoff isn't what's being measured here
        };
      }),
    });
    const atDefault = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      zoom: 8,
    });
    expect(atDefault).toHaveLength(COUNT); // nothing dropped — this was 256 before

    const atHugeLimit = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      limit: 1_000_000,
      zoom: 8,
    });
    expect(atHugeLimit).toHaveLength(COUNT); // clamped to the ceiling, which 300 is under
    // Seeding 300 bodies + two viewport queries runs past vitest's 5 s default on a slow CI runner;
    // inherently heavy, not flaky logic, so give it headroom rather than shrinking the corpus.
  }, 30_000);

  test('returns only the bodies inside the viewport when several exist', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');

    // Inside VIEWPORT_CONTAINING — a skate at (0.5, 0.5) derives a body there.
    const insideId = await asMember.mutation(
      api.waterBodies.create,
      await seedTrackCreateArgs(t, 'clerk_member', { lat: 0.5, lng: 0.5 }),
    );
    // Outside: a skate at (50, 50).
    const outsideId = await asMember.mutation(
      api.waterBodies.create,
      await seedTrackCreateArgs(t, 'clerk_member', { name: 'Far Pond', lat: 50, lng: 50 }),
    );
    await asMod.mutation(api.waterBodies.approve, { waterBodyId: insideId });
    await asMod.mutation(api.waterBodies.approve, { waterBodyId: outsideId });

    const inView = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      zoom: 14,
    });
    expect(inView.map((b) => b._id)).toEqual([insideId]);
  });
});

describe('waterBodies.backfillRepresentativePoint (the centroid rename transition)', () => {
  test('fills the new field from the old one, and is idempotent', async () => {
    // The rename cannot be atomic: Convex validates the schema against existing data on push, and
    // dev holds 116,070 rows written before the field existed. So representativePoint ships
    // optional, every writer sets both, and this fills the backlog.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const bodyId = await onlyBodyId(t);

    // Simulate a pre-rename row.
    await t.run((ctx) => ctx.db.patch(bodyId, { representativePoint: undefined }));
    expect((await t.run((ctx) => ctx.db.get(bodyId)))?.representativePoint).toBeUndefined();

    const first = await t.mutation(internal.waterBodies.backfillRepresentativePoint, {
      table: 'waterBodies',
    });
    expect(first).toMatchObject({ filled: 1, isDone: true });
    expect((await t.run((ctx) => ctx.db.get(bodyId)))?.representativePoint).toEqual(
      CANONICAL_ITEM.centroid,
    );

    // Re-running costs reads and no writes.
    expect(
      await t.mutation(internal.waterBodies.backfillRepresentativePoint, { table: 'waterBodies' }),
    ).toMatchObject({ filled: 0 });
  });

  test('a canonical import writes both fields, so nothing needs backfilling', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const body = await t.run(async (ctx) => ctx.db.get(await onlyBodyIdIn(ctx)));
    expect(body?.representativePoint).toEqual(body?.centroid);
    expect(
      await t.mutation(internal.waterBodies.backfillRepresentativePoint, { table: 'waterBodies' }),
    ).toMatchObject({ filled: 0 });
  });
});

describe('waterBodies profile-richness prominence (N6c / D2)', () => {
  test('contour coverage feeds the richness score, and a re-tile can take it away', async () => {
    // Coverage is a property of the TILESET, not the body, so it lives in a side table keyed on
    // externalId — which is also why a body that drops out of a re-tile cannot keep claiming a
    // state survey we no longer draw.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const bodyId = await onlyBodyId(t);

    await t.mutation(internal.waterBodies.backfillCells, {});
    const withoutContours = (await t.run((ctx) => ctx.db.get(bodyId)))?.displayScore ?? 0;

    expect(
      await t.mutation(internal.waterBodies.importContourCoverage, {
        source: 'osm',
        externalIds: [CANONICAL_ITEM.externalId],
        clearFirst: true,
      }),
    ).toMatchObject({ inserted: 1 });
    await t.mutation(internal.waterBodies.backfillCells, {});
    const withContours = (await t.run((ctx) => ctx.db.get(bodyId)))?.displayScore ?? 0;
    expect(withContours).toBeGreaterThan(withoutContours);

    // A re-tile that no longer draws this lake REPLACES the set rather than adding to it.
    await t.mutation(internal.waterBodies.importContourCoverage, {
      source: 'osm',
      externalIds: [],
      clearFirst: true,
    });
    await t.mutation(internal.waterBodies.backfillCells, {});
    expect((await t.run((ctx) => ctx.db.get(bodyId)))?.displayScore).toBeCloseTo(
      withoutContours,
      10,
    );
  });

  test('importContourCoverage is idempotent within a run', async () => {
    // The loader batches 400 at a time and only the first batch clears, so a retried batch must not
    // double-insert.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importContourCoverage, {
      source: 'osm',
      externalIds: ['way/1', 'way/2'],
      clearFirst: true,
    });
    expect(
      await t.mutation(internal.waterBodies.importContourCoverage, {
        source: 'osm',
        externalIds: ['way/1', 'way/2'],
      }),
    ).toMatchObject({ inserted: 0, cleared: 0 });
    expect(await t.run((ctx) => ctx.db.query('bathymetryCoverage').collect())).toHaveLength(2);
  });

  test('backfillCells raises a body that has a report, and leaves a bare one alone', async () => {
    // The founder's ask: real-world documentation should out-rank hand-curation. Activity is the
    // only term that is evidence of USE rather than of data, so it is the one that moves a body.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const bodyId = await onlyBodyId(t);
    const before = (await t.run((ctx) => ctx.db.get(bodyId)))?.displayScore ?? 0;

    // A re-score with no activity changes nothing — richness is a boost, never a penalty.
    await t.mutation(internal.waterBodies.backfillCells, {});
    const bare = (await t.run((ctx) => ctx.db.get(bodyId)))?.displayScore ?? 0;
    expect(bare).toBeGreaterThanOrEqual(before);

    const author = await seedUser(t, 'clerk_reporter', 'member');
    await author.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: Date.now(),
      iceTypes: ['black_ice'],
      surfaceTags: [],
      photoIds: [],
    });
    await t.mutation(internal.waterBodies.backfillCells, {});
    const withReport = (await t.run((ctx) => ctx.db.get(bodyId)))?.displayScore ?? 0;
    expect(withReport).toBeGreaterThan(bare);
  });

  test('a canonical re-import drops the richness term until the re-score runs', async () => {
    // Not a bug — a documented ordering constraint, asserted so it cannot drift silently.
    // importCanonical would otherwise pay two extra index reads on every one of 116,070 rows.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const bodyId = await onlyBodyId(t);
    const author = await seedUser(t, 'clerk_reporter2', 'member');
    await author.mutation(api.reports.create, {
      waterBodyId: bodyId,
      skateEndTime: Date.now(),
      iceTypes: ['black_ice'],
      surfaceTags: [],
      photoIds: [],
    });

    await t.mutation(internal.waterBodies.backfillCells, {});
    const enriched = (await t.run((ctx) => ctx.db.get(bodyId)))?.displayScore ?? 0;

    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    expect((await t.run((ctx) => ctx.db.get(bodyId)))?.displayScore).toBeLessThan(enriched);

    // …and the re-score restores it, which is why the runbook order is import → depth → backfill.
    await t.mutation(internal.waterBodies.backfillCells, {});
    expect((await t.run((ctx) => ctx.db.get(bodyId)))?.displayScore).toBeCloseTo(enriched, 10);
  });
});

describe('waterBodies wind rose (N6c A4b)', () => {
  const FETCH = [
    1900, 500, 300, 200, 200, 200, 400, 4500, 1900, 1300, 1100, 1000, 1200, 1100, 1300, 3000,
  ];
  const ROSE = Array.from({ length: 16 }, () => 1 / 16);

  async function seedBody(t: ReturnType<typeof convexTest>, extra: Record<string, unknown> = {}) {
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, fetchProfileM: FETCH }],
    });
    const id = await onlyBodyId(t);
    if (Object.keys(extra).length > 0) await t.run((ctx) => ctx.db.patch(id, extra));
    return id;
  }

  test('only offers bodies that could ever render a wind clause', async () => {
    // Requests are the scarce resource (10k/day, one point-year each), so a body whose longest
    // fetch is under the caption's own floor must not cost any: nothing would ever render it.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, fetchProfileM: Array.from({ length: 16 }, () => 100) }],
    });
    expect((await t.query(internal.waterBodies.listNeedingWindRose, {})).targets).toEqual([]);
  });

  test('offers a body with real open water, sampled at its interior point', async () => {
    const t = convexTestWithGeo();
    const at = { lat: 44.5, lng: -73.3 };
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, fetchProfileM: FETCH, interiorPoint: at }],
    });
    const id = await onlyBodyId(t);
    expect((await t.query(internal.waterBodies.listNeedingWindRose, {})).targets).toEqual([
      { waterBodyId: id, lat: at.lat, lng: at.lng },
    ]);
  });

  test('skips a body with no fetch profile at all', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    expect((await t.query(internal.waterBodies.listNeedingWindRose, {})).targets).toEqual([]);
  });

  test('resumes rather than restarts, unless asked to refresh', async () => {
    const t = convexTestWithGeo();
    await seedBody(t, { windRose: ROSE });
    expect((await t.query(internal.waterBodies.listNeedingWindRose, {})).targets).toEqual([]);
    expect(
      (await t.query(internal.waterBodies.listNeedingWindRose, { refresh: true })).targets,
    ).toHaveLength(1);
  });

  test('stores a normalized rose and REJECTS raw counts', async () => {
    // Raw hour counts are still sixteen plausible numbers; stored, they would scale every exposure
    // index by the hours sampled — invisible in a ranking, fatal to any threshold.
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    expect(
      await t.mutation(internal.waterBodies.importWindRoses, {
        roses: [{ waterBodyId: id, rose: ROSE }],
      }),
    ).toMatchObject({ updated: 1, malformed: 0 });
    expect((await t.run((ctx) => ctx.db.get(id)))?.windRoseSource).toBe('wtk_2km');

    expect(
      await t.mutation(internal.waterBodies.importWindRoses, {
        roses: [{ waterBodyId: id, rose: Array.from({ length: 16 }, () => 900) }],
      }),
    ).toMatchObject({ updated: 0, malformed: 1 });
    // The good rose survives the bad write.
    expect((await t.run((ctx) => ctx.db.get(id)))?.windRose?.[0]).toBeCloseTo(1 / 16, 10);
  });

  test('rejects a wrong-length rose', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    expect(
      await t.mutation(internal.waterBodies.importWindRoses, {
        roses: [{ waterBodyId: id, rose: [0.5, 0.5] }],
      }),
    ).toMatchObject({ updated: 0, malformed: 1 });
  });

  test('a wind rose survives a canonical re-import', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    await t.mutation(internal.waterBodies.importWindRoses, {
      roses: [{ waterBodyId: id, rose: ROSE }],
    });
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, fetchProfileM: FETCH, name: 'renamed' }],
    });
    const body = await t.run((ctx) => ctx.db.get(id));
    expect(body?.name).toBe('renamed');
    expect(body?.windRose).toHaveLength(16);
  });
});

describe('waterBodies elevation (N6c A1)', () => {
  const AT = { lat: 44.5, lng: -73.3 };

  async function seedBody(
    t: ReturnType<typeof convexTest>,
    extra: Record<string, unknown> = {},
  ): Promise<Id<'waterBodies'>> {
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, interiorPoint: AT }],
    });
    const id = await onlyBodyId(t);
    if (Object.keys(extra).length > 0) await t.run((ctx) => ctx.db.patch(id, extra));
    return id;
  }

  test('listNeedingElevation samples interiorPoint, not centroid', async () => {
    // A DEM read taken on a bank is biased upward by the bank, and `centroid` is Turf's
    // pointOnFeature, which lands on the shoreline for any curved or narrow lake.
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    const page = await t.query(internal.waterBodies.listNeedingElevation, {});
    expect(page.targets).toEqual([{ waterBodyId: id, lat: AT.lat, lng: AT.lng }]);
  });

  test('falls back to centroid for a body the re-import has not reached yet', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const page = await t.query(internal.waterBodies.listNeedingElevation, {});
    expect(page.targets[0]).toMatchObject({
      lat: CANONICAL_ITEM.centroid.lat,
      lng: CANONICAL_ITEM.centroid.lng,
    });
  });

  test('skips rows already stamped, so an interrupted 116k pass resumes rather than restarts', async () => {
    const t = convexTestWithGeo();
    await seedBody(t, { elevationM: 350, elevationSource: 'dem_glo90' });
    expect((await t.query(internal.waterBodies.listNeedingElevation, {})).targets).toEqual([]);
    // …unless explicitly asked to re-read, for the day the DEM changes.
    expect(
      (await t.query(internal.waterBodies.listNeedingElevation, { refresh: true })).targets,
    ).toHaveLength(1);
  });

  test('never returns or overwrites an operator elevation (D68 precedence)', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t, { elevationM: 412, elevationSource: 'operator' });

    // Not offered to the pass, even with --refresh: a moderator's value costs no quota.
    expect((await t.query(internal.waterBodies.listNeedingElevation, {})).targets).toEqual([]);
    expect(
      (await t.query(internal.waterBodies.listNeedingElevation, { refresh: true })).targets,
    ).toEqual([]);

    // And re-checked at WRITE time, because the read and the write are separate transactions and a
    // 116k pass takes minutes — a moderator can set an override in between, and losing it would be
    // silent.
    const result = await t.mutation(internal.waterBodies.importElevations, {
      elevations: [{ waterBodyId: id, elevationM: 999 }],
    });
    expect(result).toMatchObject({ updated: 0, operatorHeld: 1 });
    const body = await t.run((ctx) => ctx.db.get(id));
    expect(body?.elevationM).toBe(412);
    expect(body?.elevationSource).toBe('operator');
  });

  test('stores a plausible reading and drops a sentinel', async () => {
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    expect(
      await t.mutation(internal.waterBodies.importElevations, {
        elevations: [{ waterBodyId: id, elevationM: 357 }],
      }),
    ).toMatchObject({ updated: 1, implausible: 0 });
    expect((await t.run((ctx) => ctx.db.get(id)))?.elevationSource).toBe('dem_glo90');

    expect(
      await t.mutation(internal.waterBodies.importElevations, {
        elevations: [{ waterBodyId: id, elevationM: -9999 }],
      }),
    ).toMatchObject({ updated: 0, implausible: 1 });
    // The good value survives the bad write.
    expect((await t.run((ctx) => ctx.db.get(id)))?.elevationM).toBe(357);
  });

  test('elevation survives a canonical re-import', async () => {
    // importCanonical patches a named field list; elevation is deliberately not in it, so the
    // geometry pass and the depth pass can run in either order.
    const t = convexTestWithGeo();
    const id = await seedBody(t);
    await t.mutation(internal.waterBodies.importElevations, {
      elevations: [{ waterBodyId: id, elevationM: 357 }],
    });
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, name: 'renamed' }],
    });
    const body = await t.run((ctx) => ctx.db.get(id));
    expect(body?.name).toBe('renamed');
    expect(body?.elevationM).toBe(357);
    expect(body?.elevationSource).toBe('dem_glo90');
  });
});

describe('waterBodies.importCanonical (idempotent OSM upsert, D14/D48)', () => {
  test('inserts a canonical body (listed) and is idempotent on re-import', async () => {
    const t = convexTestWithGeo();

    const r1 = await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    expect(r1).toMatchObject({ inserted: 1, updated: 0, queuedForMerge: 0, conflicts: 0 });

    // Re-import with a changed name: same row updated, geometry/name patched, no new row.
    const r2 = await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, name: 'Lake Champlain (renamed)' }],
    });
    expect(r2).toMatchObject({ inserted: 0, updated: 1, queuedForMerge: 0, conflicts: 0 });

    const all = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    expect(all).toHaveLength(1);
    expect(all[0]?.source).toBe('osm');
    expect(all[0]?.name).toBe('Lake Champlain (renamed)');

    // Canonical bodies are auto-listed (no reviewStatus), so they render on the map.
    const inView = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      zoom: 14,
    });
    expect(inView.map((b) => b._id)).toEqual([all[0]?._id]);
  });

  test('a removed canonical body stays removed across re-import (landowner takedown, D48)', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const bodyId = await onlyBodyId(t);

    const asAdmin = await seedUser(t, 'clerk_admin', 'admin');
    await asAdmin.mutation(api.waterBodies.remove, {
      waterBodyId: bodyId,
      reason: 'landowner_request',
    });
    expect(
      await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT_CONTAINING, zoom: 14 }),
    ).toHaveLength(0);

    // The idempotent re-import must NOT resurrect the takedown.
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const body = await t.run((ctx) => ctx.db.get(bodyId));
    expect(body?.removedAt).toBeDefined();
    expect(
      await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT_CONTAINING, zoom: 14 }),
    ).toHaveLength(0);
  });

  test('carries the N6c shape stats onto the row, and clears them when a re-import cannot measure them', async () => {
    const t = convexTestWithGeo();

    // `importCanonical` patches a NAMED field list, which is what lets depth, curatedBoost and the
    // removal state survive a re-import. The cost of that discipline is that a new field which
    // isn't named simply never lands — silently, and visible only as a column of blanks later.
    const stats = {
      interiorPoint: { lat: 44.5, lng: -73.3 },
      shorelineM: 984_500,
      longAxisM: 171_000,
      longAxisBearingDeg: 8.5,
      shortAxisM: 23_800,
      fetchProfileM: Array.from({ length: 16 }, (_, i) => 1000 * (i + 1)),
    };
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, ...stats }],
    });
    const bodyId = await onlyBodyId(t);
    expect(await t.run((ctx) => ctx.db.get(bodyId))).toMatchObject(stats);

    // And the update path, which is a different field list in the same mutation.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, ...stats, shorelineM: 990_000 }],
    });
    expect((await t.run((ctx) => ctx.db.get(bodyId)))?.shorelineM).toBe(990_000);

    // A re-import whose geometry no longer supports a stat must CLEAR it. A stale shoreline beside
    // a fresh outline is worse than no shoreline, and an omitted key would have left it in place.
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const cleared = await t.run((ctx) => ctx.db.get(bodyId));
    expect(cleared?.shorelineM).toBeUndefined();
    expect(cleared?.fetchProfileM).toBeUndefined();
    expect(cleared?.interiorPoint).toBeUndefined();
  });

  test('keeps OSM and NHD distinct when they share an externalId but not an identity', async () => {
    // This used to be guaranteed by `source` being half the upsert key. It is now guaranteed by
    // something stronger: the two records assert *different catalogue ids*, so `resolveUpsert` finds
    // nothing in common. A shared `externalId` is a coincidence of string formatting and means
    // nothing to the upsert at all — which is the point of splitting the two fields.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          ...CANONICAL_ITEM,
          source: 'osm' as const,
          externalId: 'shared/1',
          osmId: 'shared/1',
          name: 'From OSM',
        },
        {
          ...CANONICAL_ITEM,
          source: 'nhd' as const,
          externalId: 'shared/1',
          osmId: undefined,
          nhdId: 'shared/1',
          name: 'From NHD',
        },
      ],
    });
    const all = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    expect(all).toHaveLength(2); // not collapsed into one
    expect(all.map((b) => b.source).sort()).toEqual(['nhd', 'osm']);
  });

  test('two records claiming the SAME osmId are one lake, however they arrived', async () => {
    // The mirror of the test above, and the behaviour change worth stating out loud: identity is the
    // catalogue id now, so two records asserting `osmId: 'shared/1'` are the same body even when
    // their `source` and `externalId` differ. Under the old key they would have been two rows.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        { ...CANONICAL_ITEM, externalId: 'from-extract', osmId: 'shared/1', name: 'First' },
        { ...CANONICAL_ITEM, externalId: 'from-merge', osmId: 'shared/1', name: 'Second' },
      ],
    });
    const all = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe('Second');
  });

  test('cells a body at a rung matching its size — a big body rides a coarser one (N1)', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/big',
          osmId: 'osm/big',
          name: 'Big',
          surfaceAreaSqM: 1e9,
          bbox: { minLat: 0, minLng: 0, maxLat: 0.2, maxLng: 0.02 },
        },
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/small',
          osmId: 'osm/small',
          name: 'Small',
          surfaceAreaSqM: 200,
          bbox: { minLat: 0, minLng: 0, maxLat: 0.02, maxLng: 0.02 },
        },
      ],
    });
    const bodies = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    const cells = await t.run((ctx) => ctx.db.query('waterBodyCells').collect());
    const levelOf = (name: string) => {
      const id = bodies.find((b) => b.name === name)?._id;
      return cells.filter((c) => c.waterBodyId === id).map((c) => c.z);
    };
    // Every row for a body sits on ONE rung, and the big prominent lake's is coarser than the tiny
    // pond's — which is what lets a wide query find it without a separate large-body scan. (The
    // rung is min(size, visibility): a body is never indexed finer than the zoom it draws at.)
    expect(new Set(levelOf('Big')).size).toBe(1);
    expect(new Set(levelOf('Small')).size).toBe(1);
    expect(levelOf('Big')[0]).toBeLessThan(levelOf('Small')[0] as number);
    // Theorem 2: never more than four rows per body.
    expect(levelOf('Big').length).toBeLessThanOrEqual(4);
    expect(levelOf('Small').length).toBeLessThanOrEqual(4);
  });

  test('re-import re-cells a body that grows onto a coarser rung', async () => {
    const t = convexTestWithGeo();
    const small = { ...CANONICAL_ITEM, bbox: { minLat: 0, minLng: 0, maxLat: 0.02, maxLng: 0.02 } };
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [small] });
    const before = await t.run((ctx) => ctx.db.query('waterBodyCells').collect());

    // Same body, now much bigger — its old fine-rung rows must go, or a wide viewport would still
    // be looking for it on a rung it no longer occupies.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...small, bbox: { minLat: 0, minLng: 0, maxLat: 0.9, maxLng: 0.9 } }],
    });
    const after = await t.run((ctx) => ctx.db.query('waterBodyCells').collect());
    expect(new Set(after.map((c) => c.z)).size).toBe(1); // no leftovers on the old rung
    expect(after[0]?.z).toBeLessThan(before[0]?.z as number);
  });

  test('rejects an unknown state code before any write (Phase 2.5 guard)', async () => {
    const t = convexTestWithGeo();
    await expect(
      t.mutation(internal.waterBodies.importCanonical, {
        bodies: [CANONICAL_ITEM],
        state: 'VE', // typo for VT
      }),
    ).rejects.toThrow(/unknown state code/i);
    // The whole batch is rejected — nothing is persisted with the bad tag.
    expect(await t.run((ctx) => ctx.db.query('waterBodies').collect())).toHaveLength(0);
  });
});

describe('waterBodies.backfillCells (the migration onto the ladder grid, N1)', () => {
  test('cells a body that has no index rows so it becomes queryable', async () => {
    const t = convexTestWithGeo();
    // A row written directly, with no cell rows — what every body in the deployed corpus looks
    // like the moment before this migration runs.
    const bodyId = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        ...SAMPLE_BODY,
        source: 'osm',
        externalId: 'osm/stale',
        osmId: 'osm/stale',
        dedupStatus: 'clean',
        createdAt: Date.now(),
      }),
    );
    // Not on the map before the backfill.
    expect(
      await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT_CONTAINING, zoom: 14 }),
    ).toHaveLength(0);

    const result = await t.mutation(internal.waterBodies.backfillCells, {});
    expect(result.reindexed).toBe(1);
    expect(result.isDone).toBe(true);

    // It also re-derives the D49 prominence fields the cell rows are keyed on.
    expect((await t.run((ctx) => ctx.db.get(bodyId)))?.minVisibleZoom).toBeDefined();

    // Now visible.
    const inView = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      zoom: 14,
    });
    expect(inView.map((b) => b._id)).toEqual([bodyId]);
  });

  test('resumes from its cursor instead of restarting — the ~116k-corpus path', async () => {
    const t = convexTestWithGeo();
    for (let i = 0; i < 5; i++) {
      await t.run((ctx) =>
        ctx.db.insert('waterBodies', {
          ...SAMPLE_BODY,
          source: 'osm',
          externalId: `osm/batch-${i}`,
          osmId: `osm/batch-${i}`,
          dedupStatus: 'clean',
          createdAt: Date.now(),
        }),
      );
    }

    let cursor: string | undefined;
    let done = false;
    let batches = 0;
    let total = 0;
    while (!done && batches < 10) {
      const page: { reindexed: number; cursor: string; isDone: boolean } = await t.mutation(
        internal.waterBodies.backfillCells,
        { cursor, batchSize: 2 },
      );
      cursor = page.cursor;
      done = page.isDone;
      total += page.reindexed;
      batches++;
    }
    expect(done).toBe(true);
    expect(total).toBe(5);
    expect(batches).toBeGreaterThan(1); // it really did page, rather than swallowing the batchSize

    const inView = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      zoom: 14,
    });
    expect(inView).toHaveLength(5);
  });
});

describe('waterBodies.pruneBelowAreaFloor (bringing the stored corpus to D91)', () => {
  const SMALL = 4 * 4046.8564224; // 4 acres — under the floor
  const BIG = 40 * 4046.8564224; // 40 acres — over it

  /** Insert a body directly, so the test controls fields `importCanonical` would derive. */
  async function seedBody(
    t: ReturnType<typeof convexTest>,
    overrides: Partial<Doc<'waterBodies'>> & { externalId: string },
  ): Promise<Id<'waterBodies'>> {
    return await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        ...SAMPLE_BODY,
        name: '',
        source: 'osm',
        dedupStatus: 'clean',
        surfaceAreaSqM: SMALL,
        createdAt: Date.now(),
        ...overrides,
      } as Doc<'waterBodies'>),
    );
  }

  /** Drive the paginated prune to completion, summing its tallies. */
  async function runPrune(t: ReturnType<typeof convexTest>, apply: boolean) {
    let cursor: string | undefined;
    let done = false;
    let deleted = 0;
    let scanned = 0;
    const attachedBy: Record<string, number> = {};
    const kept: Record<string, number> = {};
    while (!done) {
      const page = await t.mutation(internal.waterBodies.pruneBelowAreaFloor, {
        cursor,
        batchSize: 2,
        apply,
      });
      cursor = page.cursor;
      done = page.isDone;
      deleted += page.deleted;
      scanned += page.scanned;
      for (const [k, v] of Object.entries(page.kept)) kept[k] = (kept[k] ?? 0) + v;
      for (const [k, v] of Object.entries(page.attachedBy))
        attachedBy[k] = (attachedBy[k] ?? 0) + v;
    }
    return { deleted, scanned, kept, attachedBy };
  }

  async function remaining(t: ReturnType<typeof convexTest>): Promise<string[]> {
    const rows = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    return rows.map((r) => r.externalId ?? '(none)').sort();
  }

  test('D96: removes unnamed wetland over five acres, keeps named wetland and unnamed lakes', async () => {
    const t = convexTestWithGeo();
    await seedBody(t, { externalId: 'osm/bog', type: 'wetland', surfaceAreaSqM: BIG });
    // A long-axis exemption was designed and measured for this class, then dropped (founder,
    // 2026-08-03, "for now"). N7b's includedByRequest is what makes dropping it recoverable.
    await seedBody(t, {
      externalId: 'osm/bog-long',
      type: 'wetland',
      surfaceAreaSqM: BIG,
      longAxisM: 3000,
    });
    await seedBody(t, {
      externalId: 'osm/bog-named',
      type: 'wetland',
      surfaceAreaSqM: BIG,
      name: 'Ninemile Swamp',
    });
    await seedBody(t, { externalId: 'osm/lake', surfaceAreaSqM: BIG });

    const res = await runPrune(t, true);
    expect(res.deleted).toBe(2);
    expect(await remaining(t)).toEqual(['osm/bog-named', 'osm/lake']);
  });

  test('D96: removes a NAMED wetland in the 1-5 acre band, where a named pond survives', async () => {
    const t = convexTestWithGeo();
    await seedBody(t, { externalId: 'osm/marsh-named-small', type: 'wetland', name: 'Little Bog' });
    await seedBody(t, {
      externalId: 'osm/pond-named-small',
      type: 'lakePond',
      name: 'Keiser Pond',
    });
    const res = await runPrune(t, true);
    expect(res.deleted).toBe(1);
    expect(await remaining(t)).toEqual(['osm/pond-named-small']);
  });

  test('N7b: keeps a body admitted by request, however far under the floor', async () => {
    const t = convexTestWithGeo();
    await seedBody(t, {
      externalId: 'osm/requested',
      surfaceAreaSqM: 0.4 * 4046.8564224, // sub-acre: nothing else would save it
      includedByRequest: true,
    });
    const res = await runPrune(t, true);
    expect(res.deleted).toBe(0);
    expect(await remaining(t)).toEqual(['osm/requested']);
  });

  test('deletes an unnamed sub-floor body and its cell rows, keeping named and large ones', async () => {
    const t = convexTestWithGeo();
    const doomed = await seedBody(t, { externalId: 'osm/puddle' });
    await seedBody(t, { externalId: 'osm/named', name: 'Someones Pond' });
    await seedBody(t, { externalId: 'osm/big', surfaceAreaSqM: BIG });
    // Named but under an acre — the 2026-08-02 amendment: no name saves anything down there.
    await seedBody(t, {
      externalId: 'osm/named-puddle',
      name: 'Quarry Pond',
      surfaceAreaSqM: 0.5 * 4046.8564224,
    });
    await t.mutation(internal.waterBodies.backfillCells, {}); // give them all cell rows

    const result = await runPrune(t, true);
    expect(result.deleted).toBe(2);
    expect(result.kept.clearsFloor).toBe(2);
    expect(await remaining(t)).toEqual(['osm/big', 'osm/named']);
    // The N1 index row went with it — an orphan cell would keep the body on the map.
    const cells = await t.run((ctx) =>
      ctx.db
        .query('waterBodyCells')
        .withIndex('by_body', (q) => q.eq('waterBodyId', doomed))
        .collect(),
    );
    expect(cells).toHaveLength(0);
  });

  test('dry by default: identical tallies, nothing written', async () => {
    const t = convexTestWithGeo();
    await seedBody(t, { externalId: 'osm/puddle' });

    const dry = await runPrune(t, false);
    expect(dry.deleted).toBe(1);
    expect(await remaining(t)).toEqual(['osm/puddle']); // still there

    const wet = await runPrune(t, true);
    expect(wet.deleted).toBe(dry.deleted);
    expect(await remaining(t)).toEqual([]);
  });

  test('keeps a sub-floor body that anything is attached to, and names the table', async () => {
    const t = convexTestWithGeo();
    const bodyId = await seedBody(t, { externalId: 'osm/skated' });
    await seedUser(t, 'favouriter');
    await t.run(async (ctx) => {
      const profile = await ctx.db.query('profiles').first();
      if (!profile) throw new Error('expected the seeded profile');
      await ctx.db.insert('waterBodyFavorites', {
        userId: profile._id,
        waterBodyId: bodyId,
        createdAt: Date.now(),
      } as Doc<'waterBodyFavorites'>);
    });

    const result = await runPrune(t, true);
    expect(result.deleted).toBe(0);
    expect(result.kept.attached).toBe(1);
    expect(result.attachedBy).toEqual({ waterBodyFavorites: 1 });
    expect(await remaining(t)).toEqual(['osm/skated']);
  });

  test('keeps a sub-floor body an admin curated, delisted, merged, or drew from a track', async () => {
    const t = convexTestWithGeo();
    await seedBody(t, { externalId: 'osm/curated', curatedBoost: 2 });
    await seedBody(t, { externalId: 'osm/delisted', removedAt: Date.now() });
    await seedBody(t, { externalId: 'osm/dupe', dedupStatus: 'suspected_duplicate' });
    await seedBody(t, { externalId: 'user/drawn', source: 'user' });

    const result = await runPrune(t, true);
    expect(result.deleted).toBe(0);
    expect(result.kept).toMatchObject({
      curated: 1,
      delisted: 1,
      dedupOrMerged: 1,
      userCreated: 1,
    });
    expect(await remaining(t)).toHaveLength(4);
  });

  test('drops an unnamed 1–5 ac body even where a state agency surveyed it', async () => {
    // No bathymetry clause, on purpose (D91): agency coverage is downstream of the corpus, so a
    // clause reading it could only ever protect what a looser corpus had already found.
    const t = convexTestWithGeo();
    await seedBody(t, { externalId: 'osm/surveyed' });
    await t.run((ctx) =>
      ctx.db.insert('bathymetryCoverage', { source: 'osm', externalId: 'osm/surveyed' }),
    );

    const result = await runPrune(t, true);
    expect(result.deleted).toBe(1);
    expect(await remaining(t)).toEqual([]);
  });

  test('never deletes a body whose area we do not know — absent is not small', async () => {
    const t = convexTestWithGeo();
    await seedBody(t, { externalId: 'osm/unmeasured', surfaceAreaSqM: undefined });

    const result = await runPrune(t, true);
    expect(result.deleted).toBe(0);
    expect(result.kept.areaUnknown).toBe(1);
    expect(await remaining(t)).toEqual(['osm/unmeasured']);
  });

  test('agrees exactly with the importer: nothing it deletes would be re-imported', async () => {
    // The invariant that makes the prune safe to run repeatedly. If these two ever disagree, a
    // prune deletes rows the next canonical import puts straight back.
    const t = convexTestWithGeo();
    await seedBody(t, { externalId: 'osm/puddle' });
    await seedBody(t, { externalId: 'osm/named', name: 'Someones Pond' });
    await seedBody(t, { externalId: 'osm/big', surfaceAreaSqM: BIG });
    await runPrune(t, true);

    const survivors = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    for (const body of survivors) {
      expect(meetsAreaFloor({ name: body.name, surfaceAreaSqM: body.surfaceAreaSqM ?? 0 })).toBe(
        true,
      );
    }
  });
});

describe('waterBodies.remove / restore (admin soft-delist, D48)', () => {
  async function seedCanonical(t: ReturnType<typeof convexTest>): Promise<Id<'waterBodies'>> {
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    return onlyBodyId(t);
  }

  test('a moderator cannot remove (admin-only)', async () => {
    const t = convexTestWithGeo();
    const id = await seedCanonical(t);
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await expect(
      asMod.mutation(api.waterBodies.remove, { waterBodyId: id, reason: 'junk' }),
    ).rejects.toThrow(/admin/i);
  });

  test('an admin removes (off the map, audited) then restores (back on the map, audited)', async () => {
    const t = convexTestWithGeo();
    const id = await seedCanonical(t);
    const asAdmin = await seedUser(t, 'clerk_admin', 'admin');

    await asAdmin.mutation(api.waterBodies.remove, {
      waterBodyId: id,
      reason: 'landowner_request',
    });
    let body = await t.run((ctx) => ctx.db.get(id));
    expect(body?.removedAt).toBeDefined();
    expect(body?.removedByUserId).toBeDefined();
    expect(body?.removalReason).toBe('landowner_request');
    expect(
      await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT_CONTAINING, zoom: 14 }),
    ).toHaveLength(0);

    await asAdmin.mutation(api.waterBodies.restore, { waterBodyId: id });
    body = await t.run((ctx) => ctx.db.get(id));
    expect(body?.removedAt).toBeUndefined();
    expect(body?.removedByUserId).toBeUndefined();
    expect(body?.removalReason).toBeUndefined();
    const restored = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      zoom: 14,
    });
    expect(restored.map((b) => b._id)).toEqual([id]);

    // One audit row per action, correctly typed, with the reason captured in metadata.
    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions.map((a) => a.action).sort()).toEqual(['remove', 'restore']);
    const removeRow = actions.find((a) => a.action === 'remove');
    expect(removeRow?.targetType).toBe('waterbody');
    expect(removeRow?.targetId).toBe(id);
    expect(removeRow?.metadata?.removalReason).toBe('landowner_request');
  });

  test('no double-remove or double-restore (idempotency guard, no duplicate audit rows)', async () => {
    const t = convexTestWithGeo();
    const id = await seedCanonical(t);
    const asAdmin = await seedUser(t, 'clerk_admin', 'admin');

    await asAdmin.mutation(api.waterBodies.remove, { waterBodyId: id, reason: 'junk' });
    await expect(
      asAdmin.mutation(api.waterBodies.remove, { waterBodyId: id, reason: 'junk' }),
    ).rejects.toThrow(/already removed/i);

    await asAdmin.mutation(api.waterBodies.restore, { waterBodyId: id });
    await expect(asAdmin.mutation(api.waterBodies.restore, { waterBodyId: id })).rejects.toThrow(
      /not removed/i,
    );

    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions).toHaveLength(2); // exactly one remove + one restore
  });

  test('remove/restore on a missing body throws', async () => {
    const t = convexTestWithGeo();
    const asAdmin = await seedUser(t, 'clerk_admin', 'admin');
    const danglingId = await t.run(async (ctx) => {
      const cid = await ctx.db.insert('waterBodies', {
        ...SAMPLE_BODY,
        source: 'osm',
        externalId: 'osm/gone',
        osmId: 'osm/gone',
        dedupStatus: 'clean',
        createdAt: Date.now(),
      });
      await ctx.db.delete(cid);
      return cid;
    });
    await expect(
      asAdmin.mutation(api.waterBodies.remove, { waterBodyId: danglingId, reason: 'other' }),
    ).rejects.toThrow(/not found/i);
    await expect(
      asAdmin.mutation(api.waterBodies.restore, { waterBodyId: danglingId }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('waterBodies.listPendingReview', () => {
  test('a member cannot read the review queue', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');
    await expect(asMember.query(api.waterBodies.listPendingReview, {})).rejects.toThrow(
      /moderator/i,
    );
  });

  test('a moderator sees pending bodies but not approved ones', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');
    const pendingId = await asMember.mutation(
      api.waterBodies.create,
      await seedTrackCreateArgs(t, 'clerk_member', { lat: 0.5, lng: 0.5 }),
    );
    const otherId = await asMember.mutation(
      api.waterBodies.create,
      await seedTrackCreateArgs(t, 'clerk_member', { name: 'Joes Pond', lat: 30, lng: 30 }),
    );

    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await asMod.mutation(api.waterBodies.approve, { waterBodyId: otherId });

    const queue = await asMod.query(api.waterBodies.listPendingReview, {});
    expect(queue).toHaveLength(1);
    expect(queue[0]?._id).toEqual(pendingId);
  });
});

describe('waterBodies.get (detail + merged redirect, D36/D47)', () => {
  test('returns a listed body', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const id = await onlyBodyId(t);
    const result = await t.query(api.waterBodies.get, { waterBodyId: id });
    if (!result?.available) throw new Error('expected an available body');
    expect(result.body._id).toEqual(id);
  });

  test('follows mergedIntoId to the surviving body', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        { ...CANONICAL_ITEM, externalId: 'osm/loser', osmId: 'osm/loser', name: 'Loser' },
        { ...CANONICAL_ITEM, externalId: 'osm/survivor', osmId: 'osm/survivor', name: 'Survivor' },
      ],
    });
    const all = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    const loser = all.find((b) => b.name === 'Loser');
    const survivor = all.find((b) => b.name === 'Survivor');
    if (!loser || !survivor) throw new Error('seed failed');
    await t.run((ctx) =>
      ctx.db.patch(loser._id, { dedupStatus: 'merged', mergedIntoId: survivor._id }),
    );
    const result = await t.query(api.waterBodies.get, { waterBodyId: loser._id });
    if (!result?.available) throw new Error('expected the survivor');
    expect(result.body._id).toEqual(survivor._id);
  });

  test('signals unavailable (not null) for a removed body', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const id = await onlyBodyId(t);
    await t.run((ctx) => ctx.db.patch(id, { removedAt: Date.now() }));
    expect(await t.query(api.waterBodies.get, { waterBodyId: id })).toEqual({ available: false });
  });

  test('returns null for a non-existent body', async () => {
    const t = convexTestWithGeo();
    const dangling = await t.run(async (ctx) => {
      const cid = await ctx.db.insert('waterBodies', {
        ...SAMPLE_BODY,
        source: 'osm',
        externalId: 'osm/gone',
        osmId: 'osm/gone',
        dedupStatus: 'clean',
        createdAt: Date.now(),
      });
      await ctx.db.delete(cid);
      return cid;
    });
    expect(await t.query(api.waterBodies.get, { waterBodyId: dangling })).toBeNull();
  });
});

describe('waterBodies.setCuratedBoost (D49, moderator — D37 refined 2026-07-23)', () => {
  test('a member cannot set the boost', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const id = await onlyBodyId(t);
    const asMember = await seedUser(t, 'clerk_member');
    await expect(
      asMember.mutation(api.waterBodies.setCuratedBoost, { waterBodyId: id, curatedBoost: 0.5 }),
    ).rejects.toThrow(/moderator/i);
  });

  test('a moderator sets the boost — raises prominence + writes one audit row', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const id = await onlyBodyId(t);
    const before = await t.run((ctx) => ctx.db.get(id));
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');

    await asMod.mutation(api.waterBodies.setCuratedBoost, { waterBodyId: id, curatedBoost: 1 });
    const after = await t.run((ctx) => ctx.db.get(id));
    expect(after?.curatedBoost).toBe(1);
    // A higher score ⇒ an equal-or-lower minVisibleZoom (drawn at a wider zoom).
    expect(after?.minVisibleZoom ?? 99).toBeLessThanOrEqual(before?.minVisibleZoom ?? 99);

    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect());
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe('set_curated_boost');
    expect(actions[0]?.metadata?.curatedBoost).toBe(1);
  });

  test('throws for a missing body', async () => {
    const t = convexTestWithGeo();
    const asAdmin = await seedUser(t, 'clerk_admin', 'admin');
    const dangling = await t.run(async (ctx) => {
      const cid = await ctx.db.insert('waterBodies', {
        ...SAMPLE_BODY,
        source: 'osm',
        externalId: 'osm/gone',
        osmId: 'osm/gone',
        dedupStatus: 'clean',
        createdAt: Date.now(),
      });
      await ctx.db.delete(cid);
      return cid;
    });
    await expect(
      asAdmin.mutation(api.waterBodies.setCuratedBoost, { waterBodyId: dangling, curatedBoost: 1 }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('waterBodies.listInViewport — zoom-scored prominence (D49)', () => {
  test('a wide zoom returns only prominent bodies; a deep zoom returns all', async () => {
    const t = convexTestWithGeo();
    // Both small-bbox (tier-1) and both inside VIEWPORT_CONTAINING, but very different areas:
    // a huge lake (minVisibleZoom ~6) vs. a tiny pond (~14).
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/prominent',
          osmId: 'osm/prominent',
          name: 'Prominent',
          surfaceAreaSqM: 1_000_000_000,
          bbox: { minLat: 0.4, minLng: 0.4, maxLat: 0.42, maxLng: 0.42 },
          centroid: { lat: 0.41, lng: 0.41 },
        },
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/tiny',
          osmId: 'osm/tiny',
          name: 'Tiny',
          surfaceAreaSqM: 200,
          bbox: { minLat: 0.5, minLng: 0.5, maxLat: 0.52, maxLng: 0.52 },
          centroid: { lat: 0.51, lng: 0.51 },
        },
      ],
    });
    const wide = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      zoom: 6,
    });
    expect(wide.map((b) => b.name)).toEqual(['Prominent']);

    // A deep zoom needs a viewport that could actually BE at that zoom — a 1°-wide box is a
    // zoom-8 view, and asking for its z14 rungs would mean ~2,000 cells. Frame on the pond.
    const deep = await t.query(api.waterBodies.listInViewport, {
      viewport: { minLat: 0.49, minLng: 0.49, maxLat: 0.53, maxLng: 0.53 },
      zoom: 14,
    });
    expect(deep.map((b) => b.name).sort()).toEqual(['Tiny']);
  });

  test('the zoom cutoff drops a body that is physically large but faint (D49)', async () => {
    const t = convexTestWithGeo();
    // Big bbox, tiny area — a long marshy reach. Its size puts it on a coarse rung that a wide
    // query DOES scan, so only D49's cutoff keeps it off the map until you zoom in.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/bigfaint',
          osmId: 'osm/bigfaint',
          name: 'Big Faint',
          surfaceAreaSqM: 200, // tiny area ⇒ high minVisibleZoom
          bbox: { minLat: 0, minLng: 0, maxLat: 0.5, maxLng: 0.5 }, // wide ⇒ a coarse rung
          centroid: { lat: 0.25, lng: 0.25 },
        },
      ],
    });
    const wide = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      zoom: 6,
    });
    expect(wide).toHaveLength(0); // present spatially, but dropped by the zoom cutoff
    const deep = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      zoom: 14,
    });
    expect(deep.map((b) => b.name)).toEqual(['Big Faint']);
  });

  test('the render budget keeps the most prominent body in the box, not the first cell scanned', async () => {
    // Greptile PR #27: prominence is a *global* order, but the scan walks cells row-major. Both
    // bodies below sit on the same ladder rung (z6) in ADJACENT z6 cells, and the faint one is in
    // the cell the walk opens first — so accepting bodies as they were reached handed the render
    // budget to the pond and dropped the lake. The answer must not depend on traversal order.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/faint-early-cell',
          osmId: 'osm/faint-early-cell',
          name: 'Faint (first cell)',
          // ~1.9e7 m² ⇒ minVisibleZoom 8; a 4°-wide bbox pins it to the z6 rung anyway.
          surfaceAreaSqM: 1.9e7,
          bbox: { minLat: 0.5, minLng: 0.5, maxLat: 4.5, maxLng: 4.5 },
          centroid: { lat: 2.5, lng: 2.5 },
        },
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/prominent-later-cell',
          osmId: 'osm/prominent-later-cell',
          name: 'Prominent (later cell)',
          // Top score ⇒ minVisibleZoom 6, which is also the rung it indexes at. Small bbox, one
          // z6 cell east of the faint one (z6 cells are 5.625° wide; this straddles no boundary).
          surfaceAreaSqM: 1e10,
          bbox: { minLat: 1.0, minLng: 6.5, maxLat: 1.02, maxLng: 6.52 },
          centroid: { lat: 1.01, lng: 6.51 },
        },
      ],
    });
    const box = { minLat: 0, minLng: 0, maxLat: 5, maxLng: 7 };

    // A budget of one has to spend itself on the lake, even though the pond's cell is scanned first.
    const budgetOfOne = await t.query(api.waterBodies.listInViewport, {
      viewport: box,
      limit: 1,
      zoom: 8,
    });
    expect(budgetOfOne.map((b) => b.name)).toEqual(['Prominent (later cell)']);

    // With room for both, both come back — most prominent first.
    const roomForBoth = await t.query(api.waterBodies.listInViewport, { viewport: box, zoom: 8 });
    expect(roomForBoth.map((b) => b.name)).toEqual([
      'Prominent (later cell)',
      'Faint (first cell)',
    ]);
  });

  test('a bound row budget is shared across cells, so a later cell is not starved (N1)', async () => {
    // Greptile PR #27, round 2: ranking after the scan isn't enough on its own — if the early cells
    // can spend the whole row budget, the sort ranks a *spatially selected* prefix and the bias just
    // moves down a level. Here every cell in the box holds bodies, the row budget is tightened to 6,
    // and the single most prominent body sits in the LAST cell the walk reaches. First-come-first-
    // served spends all 6 rows on the first cell and never sees it.
    const t = convexTestWithGeo();
    // Three z6 cells across (5.625° each): lng ~1, ~7, ~13 at lat ~1. Twenty faint bodies in each of
    // the first two, one headline lake in the third.
    const bodies = [];
    for (const [cellIdx, lngBase] of [1, 7, 13].entries()) {
      for (let i = 0; i < (cellIdx === 2 ? 1 : 20); i++) {
        const lng = lngBase + i * 0.01;
        bodies.push({
          ...CANONICAL_ITEM,
          externalId: `osm/cell${cellIdx}/${i}`,
          osmId: `osm/cell${cellIdx}/${i}`,
          name: cellIdx === 2 && i === 0 ? 'Headline Lake' : `Pond ${cellIdx}-${i}`,
          // The headline lake is top-score (minVisibleZoom 6); everything else is mid (~8).
          surfaceAreaSqM: cellIdx === 2 && i === 0 ? 1e10 : 1.9e7,
          bbox: { minLat: 1.0, minLng: lng, maxLat: 1.02, maxLng: lng + 0.005 },
          centroid: { lat: 1.01, lng: lng + 0.002 },
        });
      }
    }
    // Every body needs to land on the z6 rung so the contest is between CELLS, not between rungs:
    // a 4°-wide bbox pins the faint ones there, and the headline lake's own score does the same.
    for (const b of bodies) {
      if (b.name.startsWith('Pond')) {
        b.bbox = { ...b.bbox, maxLat: b.bbox.minLat + 4, maxLng: b.bbox.minLng + 4 };
      }
    }
    await t.mutation(internal.waterBodies.importCanonical, { bodies });

    const box = { minLat: 0.5, minLng: 0.5, maxLat: 2, maxLng: 14 };
    const stats = await t.query(internal.waterBodies.viewportReadStats, {
      viewport: box,
      zoom: 8,
      maxRows: 40, // binds against the 41 bodies in view, and stays above the 28-cell plan
      names: true,
    });
    expect(stats.truncated).toBe(true); // partial answer, and it says so (D5)
    expect(stats.names).toContain('Headline Lake');
  });

  test('a truncation in the LAST cell of the plan is still reported (N1)', async () => {
    // Greptile PR #27 round 6. Clamping the probe to the remaining budget made the row ceiling exact,
    // but created a boundary: when the budget cuts the probe short, "was there more?" goes unanswered.
    // On any cell but the last, the exhausted budget flags it on the next iteration — on the last one
    // nothing would have, and the scan would return a partial answer claiming to be whole. The one
    // failure mode D5 exists to prevent.
    //
    // Reaching that branch needs the budget to run out on the plan's FINAL cell, so the plan here is
    // exactly one cell: at zoom 6 (the ladder's coarsest rung) `scanLevels` yields a single rung, and
    // a viewport well inside one z6 cell covers a single cell of it.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: Array.from({ length: 8 }, (_, i) => {
        const lng = 1.05 + i * 0.01;
        return {
          ...CANONICAL_ITEM,
          externalId: `osm/lastcell/${i}`,
          osmId: `osm/lastcell/${i}`,
          name: `Crowded ${i}`,
          surfaceAreaSqM: 1e10, // top score ⇒ minVisibleZoom 6, so all eight draw at this zoom
          bbox: { minLat: 1.05, minLng: lng, maxLat: 1.06, maxLng: lng + 0.005 },
          centroid: { lat: 1.055, lng: lng + 0.002 },
        };
      }),
    });
    const stats = await t.query(internal.waterBodies.viewportReadStats, {
      viewport: { minLat: 1.0, minLng: 1.0, maxLat: 1.2, maxLng: 1.2 },
      zoom: 6,
      maxRows: 5, // spent entirely inside the one and only cell, with rows left behind it
      names: true,
    });
    expect(stats.cellsScanned).toBe(1); // the plan really is a single cell — no next iteration
    expect(stats.cellRowsRead).toBe(5); // the ceiling means what it says
    expect(stats.bodies).toBe(5); // and three bodies were genuinely left out
    expect(stats.truncated).toBe(true); // …which is the part that has to be said out loud
  });

  test('an over-budget cell plan drops whole rungs, not the tail of one (N1)', async () => {
    // Greptile PR #27, round 7: the cell plan is built coarsest rung first and row-major within a
    // rung, so cutting it at `CELL_SCAN_BUDGET` blanked whichever corner of the box the walk reached
    // last — and pass 2 can't rank a body back in from a cell nobody looked up. The two ponds below
    // are identical in every way that the read is allowed to care about (same size, same score, same
    // z14 rung); only their longitude differs. Keeping one and dropping the other is the bug.
    //
    // The geometry is exact, not approximate. This box is 5.55° × 0.005°: wide and short, so every
    // rung stays under `MAX_CELLS_PER_LEVEL` (the finest is 254) while the ladder sums to 515 cells,
    // past the 512 budget. Rungs 6–13 are 261 cells; the old cut kept those plus the first 251 z14
    // cells, i.e. everything up to lng 6.5039 — head pond in, tail pond out.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/anchor',
          osmId: 'osm/anchor',
          name: 'Anchor Lake',
          surfaceAreaSqM: 1e10, // top score ⇒ minVisibleZoom 6, so it rides the coarsest rung
          bbox: { minLat: 1.0, minLng: 3.0, maxLat: 1.002, maxLng: 3.002 },
          centroid: { lat: 1.001, lng: 3.001 },
        },
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/head',
          osmId: 'osm/head',
          name: 'Head Pond',
          surfaceAreaSqM: 200, // ⇒ minVisibleZoom 14, and a tiny bbox ⇒ the z14 rung
          bbox: { minLat: 1.0, minLng: 1.015, maxLat: 1.002, maxLng: 1.017 },
          centroid: { lat: 1.001, lng: 1.016 },
        },
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/tail',
          osmId: 'osm/tail',
          name: 'Tail Pond', // same rung, same score — three z14 cells from the end of the plan
          surfaceAreaSqM: 200,
          bbox: { minLat: 1.0, minLng: 6.53, maxLat: 1.002, maxLng: 6.532 },
          centroid: { lat: 1.001, lng: 6.531 },
        },
      ],
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stats = await t.query(internal.waterBodies.viewportReadStats, {
      viewport: { minLat: 1.0, minLng: 1.0, maxLat: 1.005, maxLng: 6.55 },
      zoom: 14,
      names: true,
    });
    // Whichever way the budget falls, it has to fall the same way on both ponds: the answer may not
    // depend on where in the box a body sits. (Old behaviour: head in, tail out.)
    const names = stats.names ?? [];
    expect(names.includes('Head Pond')).toBe(names.includes('Tail Pond'));
    // What's dropped is the finest *rung* — the tier that only draws once you've zoomed all the way
    // in — so the rungs that did fit are scanned whole and their bodies are all here.
    expect(names).toContain('Anchor Lake');
    expect(stats.cellsScanned).toBe(261); // rungs 6–13 entire; not 512 cells cut mid-rung
    expect(stats.truncated).toBe(true); // and the partial answer says so (D5)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped whole'));
    warn.mockRestore();
  });

  test('the row floor does not ration a viewport whose budget is ample', async () => {
    // The other half of the same trade: reserving rows for later cells must not cost completeness
    // when nothing is contended. An even up-front split would cap each cell of a 28-cell plan at a
    // handful of rows and truncate a read that fits with room to spare.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: Array.from({ length: 40 }, (_, i) => {
        const lng = 1 + i * 0.01;
        return {
          ...CANONICAL_ITEM,
          externalId: `osm/ample/${i}`,
          osmId: `osm/ample/${i}`,
          name: `Ample ${i}`,
          surfaceAreaSqM: 1.9e7,
          bbox: { minLat: 1.0, minLng: lng, maxLat: 5.0, maxLng: lng + 4 },
          centroid: { lat: 1.01, lng: lng + 0.002 },
        };
      }),
    });
    const stats = await t.query(internal.waterBodies.viewportReadStats, {
      viewport: { minLat: 0.5, minLng: 0.5, maxLat: 2, maxLng: 14 },
      zoom: 8,
    });
    expect(stats.truncated).toBe(false);
    expect(stats.bodies).toBe(40);
  });

  test('a viewer’s favorite is pinned visible at every zoom, but only when it’s in view', async () => {
    const t = convexTestWithGeo();
    // A tiny pond (high minVisibleZoom) that a wide zoom would otherwise drop.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/belovedtiny',
          osmId: 'osm/belovedtiny',
          name: 'Beloved Pond',
          surfaceAreaSqM: 200,
          bbox: { minLat: 0.5, minLng: 0.5, maxLat: 0.52, maxLng: 0.52 },
          centroid: { lat: 0.51, lng: 0.51 },
        },
      ],
    });
    const bodyId = await onlyBodyId(t);
    // Signed-out, wide zoom: the pond drops below its prominence cutoff.
    expect(
      await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT_CONTAINING, zoom: 6 }),
    ).toHaveLength(0);

    // A favoriter sees it at the same wide zoom (highlight never disappears under the map).
    const asFan = await seedUser(t, 'clerk_fan');
    await asFan.mutation(api.waterBodyFavorites.toggle, { waterBodyId: bodyId });
    const favView = await asFan.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      zoom: 6,
    });
    expect(favView.map((b) => b.name)).toEqual(['Beloved Pond']);

    // But a favorite outside the viewport is NOT force-included (zoom-exempt, not pan-exempt).
    const elsewhere = await asFan.query(api.waterBodies.listInViewport, {
      viewport: { minLat: 40, minLng: 40, maxLat: 41, maxLng: 41 },
      zoom: 6,
    });
    expect(elsewhere).toHaveLength(0);
  });

  test('follows a merged favorite to its surviving body for the zoom-exempt highlight (D36)', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/loser',
          osmId: 'osm/loser',
          name: 'Loser Pond',
          surfaceAreaSqM: 200,
          bbox: { minLat: 0.5, minLng: 0.5, maxLat: 0.52, maxLng: 0.52 },
          centroid: { lat: 0.51, lng: 0.51 },
        },
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/survivor',
          osmId: 'osm/survivor',
          name: 'Survivor Pond',
          surfaceAreaSqM: 200,
          bbox: { minLat: 0.53, minLng: 0.53, maxLat: 0.55, maxLng: 0.55 },
          centroid: { lat: 0.54, lng: 0.54 },
        },
      ],
    });
    const bodies = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    const loser = bodies.find((b) => b.name === 'Loser Pond')?._id;
    const survivor = bodies.find((b) => b.name === 'Survivor Pond')?._id;
    if (!loser || !survivor) throw new Error('seed failed');

    const asFan = await seedUser(t, 'clerk_fan');
    await asFan.mutation(api.waterBodyFavorites.toggle, { waterBodyId: loser });
    // Merge the favorited body into the survivor after favoriting it.
    await t.run((ctx) => ctx.db.patch(loser, { dedupStatus: 'merged', mergedIntoId: survivor }));

    const view = await asFan.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      zoom: 6,
    });
    // The survivor rides in on the merged favorite; the merged loser itself is unlisted and absent.
    expect(view.map((b) => b.name)).toEqual(['Survivor Pond']);
  });
});

describe('waterBodies.searchByName (map search box)', () => {
  async function seedNamed(
    t: ReturnType<typeof convexTest>,
    name: string,
    extra: Record<string, unknown> = {},
  ) {
    return t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        name,
        type: 'lakePond' as const,
        source: 'osm' as const,
        externalId: `osm/way/${name}`,
        osmId: `osm/way/${name}`,
        polygon: SAMPLE_BODY.polygon,
        bbox: SAMPLE_BODY.bbox,
        centroid: SAMPLE_BODY.centroid,
        dedupStatus: 'clean' as const,
        createdAt: Date.now(),
        ...extra,
      }),
    );
  }

  test('finds a listed body by name and returns light fly-to fields incl. states', async () => {
    const t = convexTestWithGeo();
    await seedNamed(t, 'Lake George', { states: ['NY'] });
    await seedNamed(t, 'George Pond'); // matches 'george' too, but carries no states tag
    const results = await t.query(api.waterBodies.searchByName, { query: 'george' });
    const george = results.find((r) => r.name === 'Lake George');
    expect(george).toMatchObject({
      type: 'lakePond',
      centroid: { lat: 0.5, lng: 0.5 },
      states: ['NY'],
    });
    expect(george?._id).toBeDefined();
    // A body with no states tag comes back with an empty array (not undefined).
    expect(results.find((r) => r.name === 'George Pond')?.states).toEqual([]);
  });

  test('excludes unlisted bodies (removed / merged / rejected)', async () => {
    const t = convexTestWithGeo();
    await seedNamed(t, 'Hidden Pond', { removedAt: Date.now() });
    await seedNamed(t, 'Merged Pond', { dedupStatus: 'merged' });
    await seedNamed(t, 'Rejected Pond', { source: 'user', reviewStatus: 'rejected' });
    await seedNamed(t, 'Visible Pond');
    const names = (await t.query(api.waterBodies.searchByName, { query: 'pond' })).map(
      (r) => r.name,
    );
    expect(names).toContain('Visible Pond');
    expect(names).not.toContain('Hidden Pond');
    expect(names).not.toContain('Merged Pond');
    expect(names).not.toContain('Rejected Pond');
  });

  test('a <2-char or blank query returns nothing (no index scan)', async () => {
    const t = convexTestWithGeo();
    await seedNamed(t, 'Lake Champlain');
    expect(await t.query(api.waterBodies.searchByName, { query: 'L' })).toEqual([]);
    expect(await t.query(api.waterBodies.searchByName, { query: '  ' })).toEqual([]);
  });

  test('respects the result limit', async () => {
    const t = convexTestWithGeo();
    for (let i = 0; i < 5; i++) await seedNamed(t, `Mill Pond ${i}`);
    const results = await t.query(api.waterBodies.searchByName, { query: 'mill pond', limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe('waterBodies.applyCuratedBoostSeed (Phase 2.5 re-seed)', () => {
  const canonical = (externalId: string, name: string, surfaceAreaSqM: number) => ({
    source: 'osm' as const,
    externalId,
    osmId: externalId,
    name,
    type: 'lakePond' as const,
    polygon: SAMPLE_BODY.polygon,
    bbox: SAMPLE_BODY.bbox,
    centroid: SAMPLE_BODY.centroid,
    surfaceAreaSqM,
  });

  test('boosts a matched body (widens its minVisibleZoom) and reports a miss', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [canonical('osm/way/bp', 'Beloved Pond', 50_000)],
    });
    const id = await onlyBodyId(t);
    const before = await t.run((ctx) => ctx.db.get(id));

    const res = await t.mutation(internal.waterBodies.applyCuratedBoostSeed, {
      seed: [
        { name: 'Beloved Pond', boost: 0.5 },
        { name: 'Nonexistent Lake', boost: 0.5 },
      ],
    });
    const after = await t.run((ctx) => ctx.db.get(id));

    expect(after?.curatedBoost).toBe(0.5);
    // Higher score ⇒ lower (wider) minVisibleZoom bucket — the whole point of the boost.
    expect(after?.minVisibleZoom).toBeLessThan(before?.minVisibleZoom ?? Number.POSITIVE_INFINITY);
    expect(res.applied.map((a) => a.name)).toEqual(['Beloved Pond']);
    expect(res.notFound).toEqual(['Nonexistent Lake']);
  });

  test('disambiguates a repeated name by the state hint (over largest-area default)', async () => {
    const t = convexTestWithGeo();
    // Two "Twin Lake"s: the VT one is larger, so it would win the largest-area default…
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [canonical('osm/way/twin-vt', 'Twin Lake', 999_999)],
      state: 'VT',
    });
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [canonical('osm/way/twin-ny', 'Twin Lake', 10_000)],
      state: 'NY',
    });
    // …but the NY hint targets the smaller NY body instead.
    const res = await t.mutation(internal.waterBodies.applyCuratedBoostSeed, {
      seed: [{ name: 'Twin Lake', boost: 0.3, state: 'NY' }],
    });
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0]?.states).toEqual(['NY']);
  });
});

describe('waterBodies.resolveBodyForCoord (F2 offline flush / coord→lake)', () => {
  async function seedCanonical(t: ReturnType<typeof convexTest>): Promise<Id<'waterBodies'>> {
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    return onlyBodyId(t);
  }

  test('resolves a coord inside a body to that body', async () => {
    const t = convexTestWithGeo();
    const id = await seedCanonical(t);
    const res = await t.query(api.waterBodies.resolveBodyForCoord, {
      coord: { lat: 0.5, lng: 0.5 },
    });
    expect(res?.waterBodyId).toBe(id);
    expect(res?.name).toBe('Lake Champlain');
  });

  test('resolves a coord in the parking/approach buffer (just off the shore)', async () => {
    const t = convexTestWithGeo();
    const id = await seedCanonical(t);
    // ~222 m east of the east edge (0.002°) — outside the polygon but inside the 300 m buffer.
    const res = await t.query(api.waterBodies.resolveBodyForCoord, {
      coord: { lat: 0.5, lng: 1.002 },
    });
    expect(res?.waterBodyId).toBe(id);
  });

  test('returns null when the coord is beyond the buffer', async () => {
    const t = convexTestWithGeo();
    await seedCanonical(t);
    const res = await t.query(api.waterBodies.resolveBodyForCoord, {
      coord: { lat: 0.5, lng: 1.002 },
      bufferMeters: 10,
    });
    expect(res).toBeNull();
  });

  test('returns null far from any body', async () => {
    const t = convexTestWithGeo();
    await seedCanonical(t);
    const res = await t.query(api.waterBodies.resolveBodyForCoord, {
      coord: { lat: 40, lng: -79 },
    });
    expect(res).toBeNull();
  });

  test('excludes an unlisted (removed) body even when the coord is inside it', async () => {
    const t = convexTestWithGeo();
    const id = await seedCanonical(t);
    await t.run((ctx) => ctx.db.patch(id, { removedAt: Date.now() }));
    const res = await t.query(api.waterBodies.resolveBodyForCoord, {
      coord: { lat: 0.5, lng: 0.5 },
    });
    expect(res).toBeNull();
  });
});

describe('waterBodies.findMatchCandidates (the "attach here?" steer, D36)', () => {
  test('returns no matches on genuinely new water, and reports the derived area', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');
    const args = await seedTrackCreateArgs(t, 'clerk_member', { lat: 60, lng: 60 });

    const result = await asMember.query(api.waterBodies.findMatchCandidates, {
      activityId: args.activityId,
      name: 'Somewhere New',
    });
    expect(result.status).toBe('clean');
    expect(result.derivable).toBe(true);
    expect(result.matches).toEqual([]);
    expect(result.surfaceAreaSqM ?? 0).toBeGreaterThan(0);
  });

  test('ranks nearby existing water as candidates, scored against the shape that WOULD be stored', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');
    const first = await seedTrackCreateArgs(t, 'clerk_member', { name: 'Hidden Pond', lat: 61 });
    await asMember.mutation(api.waterBodies.create, first);

    const second = await seedTrackCreateArgs(t, 'clerk_member', { lat: 61.0005 });
    const result = await asMember.query(api.waterBodies.findMatchCandidates, {
      activityId: second.activityId,
      name: 'Hidden Pond',
    });
    expect(result.status).not.toBe('clean');
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.name).toBe('Hidden Pond');
    expect(result.matches[0]?.centroidDistanceM).toBeGreaterThanOrEqual(0);
  });

  test('reports a track it cannot derive a body from, rather than throwing', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');
    const args = await seedTrackCreateArgs(t, 'clerk_member', { lat: 62 });
    // A "skate" that never moved — the parking-lot pond `pathToBody` refuses to invent.
    await t.run((ctx) =>
      ctx.db.patch(args.activityId, {
        path: {
          type: 'LineString' as const,
          coordinates: [
            [62, 62],
            [62, 62],
          ],
        },
      }),
    );
    const result = await asMember.query(api.waterBodies.findMatchCandidates, {
      activityId: args.activityId,
    });
    expect(result.derivable).toBe(false);
    expect(result.matches).toEqual([]);
  });

  test("refuses to preview someone else's skate", async () => {
    const t = convexTestWithGeo();
    await seedUser(t, 'clerk_owner');
    const asOther = await seedUser(t, 'clerk_other');
    const owned = await seedTrackCreateArgs(t, 'clerk_owner', { lat: 63 });
    await expect(
      asOther.query(api.waterBodies.findMatchCandidates, { activityId: owned.activityId }),
    ).rejects.toThrow(/Not your activity/i);
  });
});

/**
 * Catalogue identity — `osmId` / `nhdId` / `geometrySource` (N6b follow-up).
 *
 * These fields exist to separate *who a lake is* from *which key we imported it under*, so that a
 * body can eventually hold both an OSM and an NHD identity and draw from either. The tests that
 * matter are the two invariants a later NHD reconciliation depends on: an import must assert only
 * what it knows, and a re-import must not erase what reconciliation worked out.
 */
describe('waterBodies catalogue identity', () => {
  test('a canonical import stamps osmId and geometrySource without a backfill', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const body = await t.run(async (ctx) => ctx.db.get(await onlyBodyIdIn(ctx)));
    expect(body?.osmId).toBe('osm/way/1');
    expect(body?.geometrySource).toBe('osm');
    // An OSM import knows nothing about NHD and must not claim to.
    expect(body?.nhdId).toBeUndefined();
  });

  test('a re-import does not clear an id it merely fails to mention', async () => {
    // The failure this guards is a load that reports success and destroys 18,383 rows of geometric
    // work: nothing in the mutation can tell a complete merged record from a partial one, so an
    // "incoming is authoritative, write all of it" rule means one single-lane load wipes every
    // reconciliation in the corpus. Silence changes nothing.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const id = await t.run(async (ctx) => onlyBodyIdIn(ctx));
    await t.run(async (ctx) => ctx.db.patch(id, { nhdId: '{C4A423E4-F036}' }));

    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, name: 'Lake Champlain (renamed upstream)' }],
    });
    const after = await t.run(async (ctx) => ctx.db.get(id));
    expect(after?.name).toBe('Lake Champlain (renamed upstream)'); // the import did land
    expect(after?.nhdId).toBe('{C4A423E4-F036}'); // …and did not clobber the reconciliation
  });

  test('a re-import DOES overwrite an id it asserts differently — the case that happens', async () => {
    // The other half of the rule, and the reason "never touch nhdId" was too strict: when the merge
    // re-runs and resolves a lake to a different NHD feature, the corpus has to be able to move.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const id = await t.run(async (ctx) => onlyBodyIdIn(ctx));
    await t.run(async (ctx) => ctx.db.patch(id, { nhdId: 'was-wrong' }));

    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, nhdId: 'now-right' }],
    });
    expect((await t.run(async (ctx) => ctx.db.get(id)))?.nhdId).toBe('now-right');
  });

  test('stores the third catalogue id and the gazetteer id D93 named', async () => {
    // `threeDhpId` is a third of `resolveUpsert`'s lookup and had no column until N7 step 5; `gnisId`
    // proposes candidates and must never decide identity (GNIS_IS_NOT_AN_UPSERT_KEY).
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, threeDhpId: 'MLBCG', gnisId: '00869848' }],
    });
    const body = await t.run(async (ctx) => ctx.db.get(await onlyBodyIdIn(ctx)));
    expect(body?.threeDhpId).toBe('MLBCG');
    expect(body?.gnisId).toBe('00869848');
  });

  test('the backfill restates what a row already carries, and never overwrites', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const id = await t.run(async (ctx) => onlyBodyIdIn(ctx));
    // A row as it existed before these fields did, plus a reconciliation the backfill must respect.
    await t.run(async (ctx) =>
      ctx.db.patch(id, { osmId: undefined, geometrySource: undefined, nhdId: 'already-known' }),
    );

    const first = await t.mutation(internal.waterBodies.backfillCatalogueIds, {});
    expect(first.patched).toBe(1);
    const body = await t.run(async (ctx) => ctx.db.get(id));
    expect(body?.osmId).toBe('osm/way/1');
    expect(body?.geometrySource).toBe('osm');
    expect(body?.nhdId).toBe('already-known');

    // Idempotent: a second pass over a corpus that is still changing must be a no-op, because it
    // will be re-run alongside the depth, elevation and wind passes rather than instead of them.
    const second = await t.mutation(internal.waterBodies.backfillCatalogueIds, {});
    expect(second.patched).toBe(0);
    expect(second.alreadySet).toBe(1);
  });
});

describe('backfillWaterBodyClasses (D109)', () => {
  /** Seed one body and force its stored `type` to a retired value, as a pre-migration row is. */
  async function seedLegacy(
    t: ReturnType<typeof convexTestWithGeo>,
    legacy: string,
    name = 'Legacy',
  ) {
    await t.run(async (ctx) => {
      await ctx.db.insert('waterBodies', {
        ...SAMPLE_BODY,
        name,
        // biome-ignore lint/suspicious/noExplicitAny: the point is to store a value the new validator refuses.
        type: legacy as any,
        source: 'osm',
        externalId: `osm/way/${name}`,
        osmId: `osm/way/${name}`,
        dedupStatus: 'clean',
        createdAt: Date.now(),
      });
    });
  }

  it('rewrites every retired value, and folds lake and pond onto one class', async () => {
    const t = convexTestWithGeo();
    await seedLegacy(t, 'lake', 'A');
    await seedLegacy(t, 'pond', 'B');
    await seedLegacy(t, 'marsh', 'C');
    await seedLegacy(t, 'other', 'D');

    const res = await t.mutation(internal.waterBodies.backfillWaterBodyClasses, { apply: true });
    expect(res.rewritten).toBe(4);
    expect(res.unmappable).toBe(0);
    expect(res.isDone).toBe(true);

    const types = await t.run(async (ctx) => {
      const rows = await ctx.db.query('waterBodies').collect();
      return Object.fromEntries(rows.map((r) => [r.name, r.type]));
    });
    // The one lossy step, and the one the whole class exists to make: lake and pond are one thing.
    expect(types.A).toBe('lakePond');
    expect(types.B).toBe('lakePond');
    expect(types.C).toBe('wetland');
    expect(types.D).toBe('unclassified');
  });

  it('writes nothing unless asked, so the scope can be read before it moves', async () => {
    const t = convexTestWithGeo();
    await seedLegacy(t, 'marsh', 'A');

    const dry = await t.mutation(internal.waterBodies.backfillWaterBodyClasses, {});
    expect(dry.applied).toBe(false);
    expect(dry.rewritten).toBe(1);
    expect(dry.byMapping['marsh->wetland']).toBe(1);

    const stored = await t.run(
      async (ctx) => (await ctx.db.query('waterBodies').collect())[0]?.type,
    );
    expect(stored).toBe('marsh');
  });

  it('is idempotent — a migrated row is skipped, not re-derived', async () => {
    const t = convexTestWithGeo();
    await seedLegacy(t, 'lake', 'A');

    const first = await t.mutation(internal.waterBodies.backfillWaterBodyClasses, { apply: true });
    expect(first.rewritten).toBe(1);
    const second = await t.mutation(internal.waterBodies.backfillWaterBodyClasses, { apply: true });
    expect(second.rewritten).toBe(0);
    expect(second.alreadyMigrated).toBe(1);
  });

  it('cannot be handed a value in neither vocabulary — the schema union is the guard', async () => {
    // The mutation counts an unmappable row rather than throwing, so one bad value cannot stall a
    // migration across 18,383. That branch is deliberately unreachable through any supported path,
    // and this is what makes it so: the union in `schema.ts` admits the two vocabularies and nothing
    // else, so a third spelling is refused at write time rather than discovered at migration time.
    const t = convexTestWithGeo();
    await expect(seedLegacy(t, 'swimming_pool', 'A')).rejects.toThrow(/Validator error/);
  });

  it('leaves prominence and cells untouched, because `type` feeds neither', async () => {
    // D49 scores on area and boost; N1 cells on bbox and prominence. A body must not move, change
    // visibility or change rank because its class was renamed.
    const t = convexTestWithGeo();
    await seedLegacy(t, 'lake', 'A');
    const before = await t.run(async (ctx) => {
      const body = (await ctx.db.query('waterBodies').collect())[0];
      const cells = await ctx.db.query('waterBodyCells').collect();
      return { score: body?.displayScore, zoom: body?.minVisibleZoom, cells: cells.length };
    });

    await t.mutation(internal.waterBodies.backfillWaterBodyClasses, { apply: true });

    const after = await t.run(async (ctx) => {
      const body = (await ctx.db.query('waterBodies').collect())[0];
      const cells = await ctx.db.query('waterBodyCells').collect();
      return { score: body?.displayScore, zoom: body?.minVisibleZoom, cells: cells.length };
    });
    expect(after).toEqual(before);
  });

  it('keeps the wetland admission rule working during the migration, in both spellings', async () => {
    // `isWetlandClass` understands 'marsh' and 'wetland' precisely so the prune cannot disagree with
    // the corpus while the two coexist. If it ever stopped, every unnamed bog above five acres would
    // be silently admitted — with no error anywhere.
    expect(isWetlandClass('marsh')).toBe(true);
    expect(isWetlandClass('wetland')).toBe(true);
    expect(belongsInCorpus({ name: '', type: 'marsh', surfaceAreaSqM: 10 * 4046.8564224 })).toBe(
      false,
    );
    expect(belongsInCorpus({ name: '', type: 'wetland', surfaceAreaSqM: 10 * 4046.8564224 })).toBe(
      false,
    );
  });
});

describe('importCanonical keyed on catalogue ids (N7 / D93)', () => {
  test('an NHD feature finds the OSM body it already is, instead of duplicating it', async () => {
    // **The failure this whole phase exists to prevent.** Under `(source, externalId)` an NHD record
    // could never match an OSM row, so importing the federal lane would have inserted a second copy
    // of every lake we hold — 18,383 duplicates, silently.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, osmId: 'way/1', nhdId: '141034078', name: 'Long Pond' }],
    });
    expect(await t.run((ctx) => ctx.db.query('waterBodies').collect())).toHaveLength(1);

    // Now the NHD lane arrives carrying only its own id — a different source, a different
    // externalId, the same lake.
    const res = await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          ...CANONICAL_ITEM,
          source: 'nhd' as const,
          externalId: '141034078',
          osmId: undefined,
          nhdId: '141034078',
          name: 'Long Pond (NHD)',
        },
      ],
    });
    expect(res).toMatchObject({ inserted: 0, updated: 1 });
    const all = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe('Long Pond (NHD)');
  });

  test('mints a waterBodyKey on insert, so no row waits on a backfill to have one', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const body = await t.run(async (ctx) => ctx.db.get(await onlyBodyIdIn(ctx)));
    expect(body?.waterBodyKey).toMatch(/^wb_/);
  });

  test('patching never moves the _id, which is what keeps user content attached', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const before = await t.run(async (ctx) => onlyBodyIdIn(ctx));
    const key = (await t.run(async (ctx) => ctx.db.get(before)))?.waterBodyKey;

    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, name: 'Renamed' }],
    });
    const after = await t.run(async (ctx) => onlyBodyIdIn(ctx));
    expect(after).toBe(before);
    // …and the minted key is not re-minted either, or every contour tile stamp would break.
    expect((await t.run(async (ctx) => ctx.db.get(after)))?.waterBodyKey).toBe(key);
  });

  test('QUEUES a merge rather than performing it, and writes neither row away', async () => {
    // Two stored rows, one incoming record whose ids point at both. D93: an automatic merge that is
    // wrong is unrecoverable in a way a queued one is not, so this flags for D36's queue and moves on.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        { ...CANONICAL_ITEM, externalId: 'a', osmId: 'way/a', name: 'A' },
        {
          ...CANONICAL_ITEM,
          source: 'nhd' as const,
          externalId: 'n1',
          osmId: undefined,
          nhdId: 'n1',
          name: 'B',
        },
      ],
    });
    expect(await t.run((ctx) => ctx.db.query('waterBodies').collect())).toHaveLength(2);

    const res = await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        { ...CANONICAL_ITEM, externalId: 'a', osmId: 'way/a', nhdId: 'n1', name: 'Merged?' },
      ],
    });
    expect(res).toMatchObject({ queuedForMerge: 1, inserted: 0, updated: 0 });
    expect(res.unresolved[0]).toMatchObject({ action: 'merge' });

    const all = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    expect(all).toHaveLength(2); // nothing collapsed
    expect(all.map((b) => b.name).sort()).toEqual(['A', 'B']); // and nothing renamed
    // Both sides flagged, so whichever a moderator opens shows the other.
    expect(all.every((b) => b.dedupStatus === 'near_certain')).toBe(true);
  });

  test('refuses a record carrying no catalogue id at all, rather than inventing one', async () => {
    const t = convexTestWithGeo();
    const res = await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, osmId: undefined, nhdId: undefined, threeDhpId: undefined }],
    });
    expect(res).toMatchObject({ conflicts: 1, inserted: 0, updated: 0 });
    expect(await t.run((ctx) => ctx.db.query('waterBodies').collect())).toHaveLength(0);
  });

  test('reports a conflict when one id resolves to two rows, without failing the batch', async () => {
    // A corrupt corpus is a finding, not a crash — and the other 149 bodies in the batch still load.
    const t = convexTestWithGeo();
    await t.run(async (ctx) => {
      for (const name of ['dup1', 'dup2']) {
        await ctx.db.insert('waterBodies', {
          ...SAMPLE_BODY,
          name,
          source: 'nhd',
          externalId: name,
          nhdId: 'same-id',
          dedupStatus: 'clean',
          createdAt: Date.now(),
        });
      }
    });

    const res = await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        { ...CANONICAL_ITEM, osmId: undefined, nhdId: 'same-id', name: 'ambiguous' },
        { ...CANONICAL_ITEM, externalId: 'fine', osmId: 'way/fine', name: 'Fine' },
      ],
    });
    expect(res).toMatchObject({ conflicts: 1, inserted: 1 });
    expect(res.unresolved[0]?.reason).toMatch(/unique/i);
    // The healthy body in the same batch still landed.
    const all = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    expect(all.map((b) => b.name)).toContain('Fine');
  });

  test('a conflict marks both rows for review, so step 6 cannot delete the evidence', async () => {
    // **The N7 second audit's hole.** The conflict branch wrote nothing at all, which was right
    // about the body and catastrophic next to step 6: neither row got a `lastCampaignId`, so
    // `pruneNotInCampaign` then saw two clean, unattached, un-reaffirmed rows and deleted BOTH —
    // resolving a corpus-uniqueness violation by destroying the evidence of it.
    const t = convexTestWithGeo();
    await t.run(async (ctx) => {
      for (const name of ['dup1', 'dup2']) {
        await ctx.db.insert('waterBodies', {
          ...SAMPLE_BODY,
          name,
          source: 'nhd',
          externalId: name,
          nhdId: 'same-id',
          dedupStatus: 'clean',
          createdAt: Date.now(),
        });
      }
    });
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, osmId: undefined, nhdId: 'same-id', name: 'ambiguous' }],
      campaignId: 'n7-2026-08-06',
    });
    const rows = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    expect(rows.map((r) => r.dedupStatus)).toEqual(['near_certain', 'near_certain']);

    // …and the prune's own protection list is what that buys: a flagged row is never deleted.
    const res = await t.mutation(internal.waterBodies.pruneNotInCampaign, {
      campaignId: 'n7-2026-08-06',
      apply: true,
    });
    expect(res).toMatchObject({ deleted: 0, kept: expect.objectContaining({ dedupOrMerged: 2 }) });
  });

  test('a 3dhp-only feature can be stored — the lake neither other catalogue draws', async () => {
    const t = convexTestWithGeo();
    const res = await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          ...CANONICAL_ITEM,
          source: '3dhp' as const,
          externalId: 'I6PYK',
          osmId: undefined,
          threeDhpId: 'I6PYK',
          geometrySource: '3dhp' as const,
          name: 'Unseen Pond',
        },
      ],
    });
    expect(res).toMatchObject({ inserted: 1 });
    const body = await t.run(async (ctx) => ctx.db.get(await onlyBodyIdIn(ctx)));
    expect(body?.threeDhpId).toBe('I6PYK');
    expect(body?.geometrySource).toBe('3dhp');
  });

  test('a removed body stays removed through a re-import (D48 landowner takedown)', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const id = await t.run(async (ctx) => onlyBodyIdIn(ctx));
    await t.run(async (ctx) =>
      ctx.db.patch(id, { removedAt: Date.now(), removalReason: 'landowner_request' }),
    );

    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, name: 'Back?' }],
    });
    const after = await t.run(async (ctx) => ctx.db.get(id));
    expect(after?.removedAt).toBeDefined();
    // A delisted body has its cell rows REMOVED rather than flagged — there is no `listed` column
    // on `waterBodyCells`, so the viewport query cannot reach it at all. (The first version of this
    // assertion read `c.listed === false`, which was `undefined === false` on every row and passed
    // vacuously over an empty array. A typecheck caught it; the test never would have.)
    const cells = await t.run((ctx) => ctx.db.query('waterBodyCells').collect());
    expect(cells).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The wire contract between the merge and the loader (N7 audit)
// ─────────────────────────────────────────────────────────────────────────────

describe('the merged record is accepted and stored whole', () => {
  /**
   * Everything `scripts/etl`'s `toCanonicalBody` can emit, in one record.
   *
   * **This test exists because the contract was broken and nothing noticed.** `merge.ts` emitted
   * `states`, `CanonicalBody` declared it — and the `canonicalBody` validator did not have the field.
   * Convex object validators are exact, so a merged load would have been rejected batch by batch,
   * 27,074 bodies deep into a campaign, on a field the plan had already recorded as "the one thing
   * that was not on the list and had to be added".
   */
  const MERGED_ITEM = {
    ...CANONICAL_ITEM,
    osmId: 'way/1',
    nhdId: '141034078',
    threeDhpId: 'MLBCG',
    gnisId: '869848',
    geometrySource: 'nhd' as const,
    states: ['NY', 'VT'],
    sourceAreaSqM: 123_456,
    inRegionFraction: 0.42,
    confidence: { name: 'high' as const, polygon: 'medium' as const, cls: 'low' as const },
    reviewReasons: ['class-conflict' as const],
  };

  test('the validator accepts every field the merge emits', async () => {
    const t = convexTestWithGeo();
    await expect(
      t.mutation(internal.waterBodies.importCanonical, { bodies: [MERGED_ITEM] }),
    ).resolves.toMatchObject({ inserted: 1 });
  });

  test('stores the merge’s own states rather than waiting for a --state flag', async () => {
    // A merged corpus loads in **one pass**, so there are no per-state batches to tag. Adding the
    // field to the validator without teaching the handler to read it would have accepted the record
    // and written nothing from it: 27,074 rows with no state, and every regional filter silently
    // empty.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [MERGED_ITEM] });
    const body = await t.run(async (ctx) => ctx.db.get(await onlyBodyIdIn(ctx)));
    expect(body?.states).toEqual(['NY', 'VT']);
  });

  test('an explicit list replaces, where a --state tag still unions', async () => {
    const t = convexTestWithGeo();
    // The OSM lane's behaviour, unchanged: one extract at a time, accumulating.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, osmId: 'way/1' }],
      state: 'VT',
    });
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, osmId: 'way/1' }],
      state: 'NY',
    });
    let body = await t.run(async (ctx) => ctx.db.get(await onlyBodyIdIn(ctx)));
    expect(body?.states).toEqual(['NY', 'VT']);

    // The merge knows the whole answer, so it replaces — otherwise a state a body no longer touches
    // could never be removed.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, osmId: 'way/1', states: ['ME'] }],
    });
    body = await t.run(async (ctx) => ctx.db.get(await onlyBodyIdIn(ctx)));
    expect(body?.states).toEqual(['ME']);
  });

  test('persists the confidence scores and review reasons instead of discarding them', async () => {
    // `@skating/core`'s `confidence.ts` is fully tested and, until this landed, had no consumer:
    // the merge computed the scores, tallied them into three lines of terminal output and dropped
    // them, so a 1,388-body review queue could never be opened by anybody.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [MERGED_ITEM] });
    const body = await t.run(async (ctx) => ctx.db.get(await onlyBodyIdIn(ctx)));
    expect(body?.confidence).toEqual({ name: 'high', polygon: 'medium', cls: 'low' });
    expect(body?.reviewReasons).toEqual(['class-conflict']);
    expect(body?.inRegionFraction).toBeCloseTo(0.42);
  });

  test('a re-import CLEARS a review reason the new evidence no longer supports', async () => {
    // Written as explicit `undefined`s rather than omitted keys, like `shapeFields`: a stale
    // `reviewReasons` would keep a moderator looking at a conflict that has since resolved.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [MERGED_ITEM] });
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...MERGED_ITEM, reviewReasons: undefined, confidence: undefined }],
    });
    const body = await t.run(async (ctx) => ctx.db.get(await onlyBodyIdIn(ctx)));
    expect(body?.reviewReasons).toBeUndefined();
    expect(body?.confidence).toBeUndefined();
  });
});

describe('pruneNotInCampaign — campaign step 6', () => {
  const CAMPAIGN = 'n7-2026-08-06';

  test('deletes a stored body the master list did not re-affirm', async () => {
    // `importCanonical` never deletes, so after a re-import the corpus is the UNION of the new master
    // list and whatever was there before — and neither set contains the other. A body the new rules
    // now refuse (a vetoed Great Lake, an out-of-region row, an unnamed wetland under the 50-acre
    // bar) survives forever: `pruneBelowAreaFloor` only sees area, `pruneOutsideCoverage` only sees
    // polygons handed to it.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, osmId: 'way/1', externalId: 'way/1' }],
    });
    const res = await t.mutation(internal.waterBodies.pruneNotInCampaign, {
      campaignId: CAMPAIGN,
      apply: true,
    });
    expect(res).toMatchObject({ deleted: 1 });
    expect(await t.run((ctx) => ctx.db.query('waterBodies').collect())).toHaveLength(0);
  });

  test('keeps a body this campaign re-affirmed', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, osmId: 'way/1' }],
      campaignId: CAMPAIGN,
    });
    const res = await t.mutation(internal.waterBodies.pruneNotInCampaign, {
      campaignId: CAMPAIGN,
      apply: true,
    });
    expect(res).toMatchObject({ deleted: 0, kept: expect.objectContaining({ reaffirmed: 1 }) });
  });

  test('is dry by default, and the tallies are identical either way', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, osmId: 'way/1' }],
    });
    const dry = await t.mutation(internal.waterBodies.pruneNotInCampaign, { campaignId: CAMPAIGN });
    expect(dry).toMatchObject({ applied: false, deleted: 1 });
    expect(await t.run((ctx) => ctx.db.query('waterBodies').collect())).toHaveLength(1);
    expect(dry.sample[0]).toMatchObject({ externalId: CANONICAL_ITEM.externalId });
  });

  test('never deletes a body carrying user content, whatever the master list says', async () => {
    // D93's closing rule, and the reason the whole campaign patches in place: user content keys off
    // the Convex `_id`. A prune that can delete an attached body makes "change a lake's geometry
    // source" a migration again.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, osmId: 'way/1' }],
    });
    const bodyId = await t.run((ctx) => onlyBodyIdIn(ctx));
    await t.run(async (ctx) => {
      await ctx.db.insert('putIns', {
        waterBodyId: bodyId,
        coord: { lat: 44, lng: -70 },
        status: 'visible',
        source: 'official',
        createdAt: Date.now(),
      });
    });
    const res = await t.mutation(internal.waterBodies.pruneNotInCampaign, {
      campaignId: CAMPAIGN,
      apply: true,
    });
    expect(res).toMatchObject({ deleted: 0, kept: expect.objectContaining({ attached: 1 }) });
  });

  test('never deletes a body somebody asked for — N7b’s whole point', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, osmId: 'way/1' }],
    });
    const bodyId = await t.run((ctx) => onlyBodyIdIn(ctx));
    await t.run((ctx) => ctx.db.patch(bodyId, { includedByRequest: true }));
    const res = await t.mutation(internal.waterBodies.pruneNotInCampaign, {
      campaignId: CAMPAIGN,
      apply: true,
    });
    expect(res).toMatchObject({
      deleted: 0,
      kept: expect.objectContaining({ includedByRequest: 1 }),
    });
  });

  test('refuses an empty campaignId rather than deleting the corpus', async () => {
    const t = convexTestWithGeo();
    await expect(
      t.mutation(internal.waterBodies.pruneNotInCampaign, { campaignId: '  ', apply: true }),
    ).rejects.toThrow(/campaignId/);
  });

  // ── The blast radius (N7 second audit) ──────────────────────────────────────
  //
  // The prune's premise is that an unstamped row is a row the master list did not contain. That
  // premise has one likely failure: `load.ts` deliberately survives isolated batch failures, and
  // every body in a skipped batch of ~150 is left unstamped and indistinguishable from a body the
  // rules now refuse. A load that reported success with three failed batches would hand this pass
  // 450 real lakes to delete, named twenty at a time in a summary nobody reads to the end.

  test('refuses a page that is mostly deletions — that is a failed load, not a rule change', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: Array.from({ length: 30 }, (_, i) => ({
        ...CANONICAL_ITEM,
        externalId: `way/${i}`,
        osmId: `way/${i}`,
      })),
    });
    await expect(
      t.mutation(internal.waterBodies.pruneNotInCampaign, { campaignId: CAMPAIGN, apply: true }),
    ).rejects.toThrow(/whole-corpus replacement/);
    // Nothing was deleted, and the refusal happened before any write.
    expect(await t.run((ctx) => ctx.db.query('waterBodies').collect())).toHaveLength(30);
  });

  test('refuses in DRY mode too, so the number is never printed for someone to act on', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: Array.from({ length: 30 }, (_, i) => ({
        ...CANONICAL_ITEM,
        externalId: `way/${i}`,
        osmId: `way/${i}`,
      })),
    });
    await expect(
      t.mutation(internal.waterBodies.pruneNotInCampaign, { campaignId: CAMPAIGN }),
    ).rejects.toThrow(/whole-corpus replacement/);
  });

  test('allows the ordinary case: a few percent of a page, which is what step 6 is for', async () => {
    const t = convexTestWithGeo();
    // 29 re-affirmed, 1 not — the shape of a real difference between two master lists.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: Array.from({ length: 29 }, (_, i) => ({
        ...CANONICAL_ITEM,
        externalId: `way/${i}`,
        osmId: `way/${i}`,
      })),
      campaignId: CAMPAIGN,
    });
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, externalId: 'way/stale', osmId: 'way/stale' }],
    });
    const res = await t.mutation(internal.waterBodies.pruneNotInCampaign, {
      campaignId: CAMPAIGN,
      apply: true,
    });
    expect(res).toMatchObject({ deleted: 1, deleteFraction: 0.033 });
  });

  test('an operator can raise the cap deliberately, per invocation', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: Array.from({ length: 30 }, (_, i) => ({
        ...CANONICAL_ITEM,
        externalId: `way/${i}`,
        osmId: `way/${i}`,
      })),
    });
    const res = await t.mutation(internal.waterBodies.pruneNotInCampaign, {
      campaignId: CAMPAIGN,
      apply: true,
      maxDeleteFraction: 1,
    });
    expect(res).toMatchObject({ deleted: 30 });
  });

  test('caps the page at the READ budget, not at the caller’s number', async () => {
    // `bodyAttachmentKind` costs 10 index reads per un-reaffirmed body against Convex's 4,096-read
    // limit, so a 500-row page of candidates asks for 5,500 and dies mid-campaign. Found by running
    // it: the first real page had 11 candidates and sailed through, which is how a data-dependent
    // limit teaches an operator the wrong lesson.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: Array.from({ length: 30 }, (_, i) => ({
        ...CANONICAL_ITEM,
        externalId: `way/${i}`,
        osmId: `way/${i}`,
      })),
      campaignId: CAMPAIGN,
    });
    const res = await t.mutation(internal.waterBodies.pruneNotInCampaign, {
      campaignId: CAMPAIGN,
      batchSize: 5000,
    });
    expect(res.scanned).toBeLessThanOrEqual(250);
  });

  test('does not fire on a page too small for a fraction to mean anything', async () => {
    // The tail page of any paginated run is short by construction, and a guard that fires there is
    // one somebody switches off.
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, osmId: 'way/1' }],
    });
    const res = await t.mutation(internal.waterBodies.pruneNotInCampaign, {
      campaignId: CAMPAIGN,
      apply: true,
    });
    expect(res).toMatchObject({ deleted: 1 });
  });
});

describe('the floor reads the area the import decided on', () => {
  test('a body admitted on its source area is not deleted on its simplified one', async () => {
    // The two differ by a fraction of a percent — the floor is applied to the source geometry, the
    // stored area is measured from the simplified polygon — and that was enough to make a body just
    // over a bar in one measure and just under it in the other. It was added by every import and
    // deleted by every prune, forever, with nothing to show for it but a row count that never settled.
    const t = convexTestWithGeo();
    const justOver = HARD_MIN_SURFACE_AREA_SQM * 1.0002;
    const justUnder = HARD_MIN_SURFACE_AREA_SQM * 0.9998;
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          ...CANONICAL_ITEM,
          osmId: 'way/1',
          name: 'Marginal Pond',
          surfaceAreaSqM: justUnder,
          sourceAreaSqM: justOver,
        },
      ],
    });
    const res = await t.mutation(internal.waterBodies.pruneBelowAreaFloor, { apply: true });
    expect(res).toMatchObject({ deleted: 0 });
  });

  test('falls back to the stored area for rows written before sourceAreaSqM existed', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          ...CANONICAL_ITEM,
          osmId: 'way/1',
          name: '',
          surfaceAreaSqM: HARD_MIN_SURFACE_AREA_SQM * 0.5,
        },
      ],
    });
    const res = await t.mutation(internal.waterBodies.pruneBelowAreaFloor, { apply: true });
    expect(res).toMatchObject({ deleted: 1 });
  });
});
