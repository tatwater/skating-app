import geospatial from '@convex-dev/geospatial/test';
import { convexTest } from 'convex-test';
import { describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');

/** A `convexTest` instance with the geospatial component registered (D5). */
function convexTestWithGeo() {
  const t = convexTest(schema, modules);
  geospatial.register(t);
  geospatial.register(t, 'adminAreasGeo');
  return t;
}

/** A viewport (bbox) centered on SAMPLE_BODY's centroid, and one far away. */
const VIEWPORT_CONTAINING = { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 };
const VIEWPORT_ELSEWHERE = { minLat: 40, minLng: -80, maxLat: 41, maxLng: -79 };

type Role = 'member' | 'moderator' | 'admin';
type Status = 'active' | 'suspended' | 'banned' | 'deleted';

const SAMPLE_BODY = {
  name: 'Lake Morey',
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
};

/** A canonical (OSM) body as the ETL would hand it to `importCanonical`. */
const CANONICAL_ITEM = {
  source: 'osm' as const,
  externalId: 'osm/way/1',
  name: 'Lake Champlain',
  type: 'lake' as const,
  polygon: SAMPLE_BODY.polygon,
  bbox: SAMPLE_BODY.bbox,
  centroid: SAMPLE_BODY.centroid,
  surfaceAreaSqM: 1_000_000,
};

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

describe('waterBodies.create', () => {
  test('rejects unauthenticated callers', async () => {
    const t = convexTestWithGeo();
    await expect(t.mutation(api.waterBodies.create, SAMPLE_BODY)).rejects.toThrow(
      /not authenticated/i,
    );
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
    await expect(asMinor.mutation(api.waterBodies.create, SAMPLE_BODY)).rejects.toThrow(
      /under 18/i,
    );
  });

  test('rejects a banned account (status gate, D37)', async () => {
    const t = convexTestWithGeo();
    const asBanned = await seedUser(t, 'clerk_banned', 'member', 'banned');
    await expect(asBanned.mutation(api.waterBodies.create, SAMPLE_BODY)).rejects.toThrow(
      /not active/i,
    );
  });

  test('rejects an account under active suspension (D37)', async () => {
    const t = convexTestWithGeo();
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const asSuspended = await seedUser(t, 'clerk_susp', 'member', 'suspended', future);
    await expect(asSuspended.mutation(api.waterBodies.create, SAMPLE_BODY)).rejects.toThrow(
      /suspended/i,
    );
  });

  test('allows an account whose suspension has lapsed (D37)', async () => {
    const t = convexTestWithGeo();
    const past = Date.now() - 1000;
    const asLapsed = await seedUser(t, 'clerk_lapsed', 'member', 'suspended', past);
    await expect(asLapsed.mutation(api.waterBodies.create, SAMPLE_BODY)).resolves.toBeDefined();
  });

  test('rejects a malformed (non-GeoJSON) polygon at the validator boundary (D5)', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');
    await expect(
      asMember.mutation(api.waterBodies.create, {
        ...SAMPLE_BODY,
        // Deliberately invalid geometry — cast past the arg type to exercise the
        // runtime validator (the whole point of the structured `geoJson` union).
        polygon: { type: 'Blob', coordinates: [] } as unknown as (typeof SAMPLE_BODY)['polygon'],
      }),
    ).rejects.toThrow();
  });

  test('a member creates a pending, user-sourced body attributed to them', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');

    const id = await asMember.mutation(api.waterBodies.create, SAMPLE_BODY);
    const body = await t.run((ctx) => ctx.db.get(id));

    expect(body?.source).toBe('user');
    expect(body?.reviewStatus).toBe('pending');
    expect(body?.dedupStatus).toBe('clean');
    expect(body?.name).toBe('Lake Morey');
  });
});

describe('waterBodies.approve (role gating + audit log, D37)', () => {
  async function seedPendingBody(t: ReturnType<typeof convexTest>): Promise<Id<'waterBodies'>> {
    const asMember = await seedUser(t, 'clerk_member');
    return asMember.mutation(api.waterBodies.create, SAMPLE_BODY);
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

describe('waterBodies.listInViewport (geospatial, D5)', () => {
  test('a pending user body is auto-visible (D37/D48) and stays visible after approval', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');
    const bodyId = await asMember.mutation(api.waterBodies.create, SAMPLE_BODY);

    // D48 fix: a fresh (pending) user body is listed immediately — not hidden until approved.
    const whilePending = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
    });
    expect(whilePending.map((b) => b._id)).toEqual([bodyId]);
    expect(whilePending[0]?.name).toBe('Lake Morey');

    const asMod = await seedUser(t, 'clerk_mod', 'moderator');
    await asMod.mutation(api.waterBodies.approve, { waterBodyId: bodyId });

    const afterApprove = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
    });
    expect(afterApprove.map((b) => b._id)).toEqual([bodyId]);
  });

  test('excludes a body whose bbox does not intersect the viewport', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');
    await asMember.mutation(api.waterBodies.create, SAMPLE_BODY);

    const elsewhere = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_ELSEWHERE,
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
          name: 'Big Lake',
          type: 'lake',
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
    const inView = await t.query(api.waterBodies.listInViewport, { viewport: tinyViewport });
    expect(inView.map((b) => b.name)).toEqual(['Big Lake']);
  });

  test('refines out a small body whose centroid is in the tier-1 margin but bbox is not in view', async () => {
    const t = convexTestWithGeo();
    // A small pond (0.03° span, < the 0.05° margin, so NOT large): its centroid (0.13, 0.13)
    // falls inside the tier-1 rectangle (viewport + 0.05° margin) but its bbox (0.11–0.14)
    // doesn't touch the viewport — the bboxIntersects refine drops it.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          source: 'osm',
          externalId: 'osm/near',
          name: 'Near Pond',
          type: 'pond',
          polygon: SAMPLE_BODY.polygon,
          bbox: { minLat: 0.11, minLng: 0.11, maxLat: 0.14, maxLng: 0.14 },
          centroid: { lat: 0.13, lng: 0.13 },
        },
      ],
    });
    const near = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    expect(near[0]?.isLarge).toBe(false); // caught by tier 1, not the large short list
    const tinyViewport = { minLat: 0, minLng: 0, maxLat: 0.1, maxLng: 0.1 };
    expect(await t.query(api.waterBodies.listInViewport, { viewport: tinyViewport })).toHaveLength(
      0,
    );
  });

  test('finds a small body at city zoom via the tier-1 centroid prefilter', async () => {
    const t = convexTestWithGeo();
    // A small pond fully inside a small viewport — the common case tier 1 serves.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          source: 'osm',
          externalId: 'osm/small',
          name: 'Small Pond',
          type: 'pond',
          polygon: SAMPLE_BODY.polygon,
          bbox: { minLat: 0.04, minLng: 0.04, maxLat: 0.06, maxLng: 0.06 },
          centroid: { lat: 0.05, lng: 0.05 },
        },
      ],
    });
    const cityViewport = { minLat: 0, minLng: 0, maxLat: 0.1, maxLng: 0.1 };
    const inView = await t.query(api.waterBodies.listInViewport, { viewport: cityViewport });
    expect(inView.map((b) => b.name)).toEqual(['Small Pond']);
  });

  test('excludes a large body whose bbox does not intersect the viewport (tier-2 refine)', async () => {
    const t = convexTestWithGeo();
    // A large body (extent 2°, so isLarge → always tier-2 scanned) far from the viewport.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          source: 'osm',
          externalId: 'osm/far-big',
          name: 'Far Big Lake',
          type: 'lake',
          polygon: SAMPLE_BODY.polygon,
          bbox: { minLat: 40, minLng: 40, maxLat: 42, maxLng: 42 },
          centroid: { lat: 41, lng: 41 },
        },
      ],
    });
    const tinyViewport = { minLat: 0, minLng: 0, maxLat: 0.1, maxLng: 0.1 };
    expect(await t.query(api.waterBodies.listInViewport, { viewport: tinyViewport })).toHaveLength(
      0,
    );
  });

  test('warns (does not silently drop) when the tier-1 cap is hit at a wide zoom (D5/D49)', async () => {
    const t = convexTestWithGeo();
    // Three small listed bodies (0.02° span, not large → tier-1 only) inside the viewport; a
    // limit of 2 forces the tier-1 centroid prefilter to truncate before the refine.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [0.3, 0.5, 0.7].map((c) => ({
        source: 'osm' as const,
        externalId: `osm/${c}`,
        name: `Body ${c}`,
        type: 'pond' as const,
        polygon: SAMPLE_BODY.polygon,
        bbox: { minLat: c - 0.01, minLng: c - 0.01, maxLat: c + 0.01, maxLng: c + 0.01 },
        centroid: { lat: c, lng: c },
      })),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const inView = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      limit: 2,
    });
    expect(inView).toHaveLength(2); // capped
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('prefilter cap'));
    warn.mockRestore();
  });

  test('sanitizes a bogus limit (0/negative) to the default rather than emptying tier 1', async () => {
    const t = convexTestWithGeo();
    // Three small (tier-1-only) bodies inside the viewport.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [0.3, 0.5, 0.7].map((c) => ({
        source: 'osm' as const,
        externalId: `osm/${c}`,
        name: `Body ${c}`,
        type: 'pond' as const,
        polygon: SAMPLE_BODY.polygon,
        bbox: { minLat: c - 0.01, minLng: c - 0.01, maxLat: c + 0.01, maxLng: c + 0.01 },
        centroid: { lat: c, lng: c },
      })),
    });
    // limit: 0 must NOT wipe the tier-1 prefilter (which would leave only large bodies); it falls
    // back to the default, so all three small bodies still come back.
    for (const limit of [0, -5]) {
      const inView = await t.query(api.waterBodies.listInViewport, {
        viewport: VIEWPORT_CONTAINING,
        limit,
      });
      expect(inView).toHaveLength(3);
    }
  });

  test('clamps an over-large client limit so tier-1 stays under the read cap (D5, regression)', async () => {
    // Guards the fix for a live crash: the geospatial component reads roughly ∝ `maxResults`, so
    // a big client `limit` made it read past Convex's 4,096-reads cap and *crash* (not page
    // slowly). `sanitizeLimit` clamps any client value to `MAX_VIEWPORT_LIMIT`. Seed *more* than
    // the cap, all in-view + small (tier-1 only), and confirm a huge limit returns the same
    // bounded set as the default — never the unclamped 300. (convex-test can't reproduce the real
    // read cap itself; this locks the clamp that keeps us under it.)
    const t = convexTestWithGeo();
    const OVER = 300; // > MAX_VIEWPORT_LIMIT (256)
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: Array.from({ length: OVER }, (_, i) => {
        const c = 0.001 + (i * 0.998) / OVER; // spread across [0,1), inside VIEWPORT_CONTAINING
        return {
          source: 'osm' as const,
          externalId: `osm/clamp/${i}`,
          name: `Body ${i}`,
          type: 'pond' as const,
          polygon: SAMPLE_BODY.polygon,
          bbox: { minLat: c - 0.0005, minLng: c - 0.0005, maxLat: c + 0.0005, maxLng: c + 0.0005 },
          centroid: { lat: c, lng: c },
        };
      }),
    });
    const atDefault = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
    });
    const atHugeLimit = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      limit: 1_000_000,
    });
    expect(atDefault.length).toBeLessThan(OVER); // clamped — not all 300 come back
    expect(atHugeLimit.length).toBe(atDefault.length); // a huge limit is clamped to the same cap
    // Seeding 300 bodies (each a geospatial insert reading ~15–20 S2-cell docs) + two viewport
    // queries runs well past the 5 s default on a slow CI runner; this is inherently heavy, not
    // flaky logic, so give it headroom rather than shrinking the seed below the 256 cap it tests.
  }, 30_000);

  test('returns only the bodies inside the viewport when several exist', async () => {
    const t = convexTestWithGeo();
    const asMember = await seedUser(t, 'clerk_member');
    const asMod = await seedUser(t, 'clerk_mod', 'moderator');

    // Inside VIEWPORT_CONTAINING (centroid 0.5, 0.5).
    const insideId = await asMember.mutation(api.waterBodies.create, SAMPLE_BODY);
    // Outside: centroid at (50, 50).
    const outsideId = await asMember.mutation(api.waterBodies.create, {
      ...SAMPLE_BODY,
      name: 'Far Pond',
      bbox: { minLat: 49, minLng: 49, maxLat: 51, maxLng: 51 },
      centroid: { lat: 50, lng: 50 },
    });
    await asMod.mutation(api.waterBodies.approve, { waterBodyId: insideId });
    await asMod.mutation(api.waterBodies.approve, { waterBodyId: outsideId });

    const inView = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
    });
    expect(inView.map((b) => b._id)).toEqual([insideId]);
  });
});

describe('waterBodies.importCanonical (idempotent OSM upsert, D14/D48)', () => {
  test('inserts a canonical body (listed) and is idempotent on re-import', async () => {
    const t = convexTestWithGeo();

    const r1 = await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    expect(r1).toEqual({ inserted: 1, updated: 0 });

    // Re-import with a changed name: same row updated, geometry/name patched, no new row.
    const r2 = await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, name: 'Lake Champlain (renamed)' }],
    });
    expect(r2).toEqual({ inserted: 0, updated: 1 });

    const all = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    expect(all).toHaveLength(1);
    expect(all[0]?.source).toBe('osm');
    expect(all[0]?.name).toBe('Lake Champlain (renamed)');

    // Canonical bodies are auto-listed (no reviewStatus), so they render on the map.
    const inView = await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT_CONTAINING });
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
      await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT_CONTAINING }),
    ).toHaveLength(0);

    // The idempotent re-import must NOT resurrect the takedown.
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const body = await t.run((ctx) => ctx.db.get(bodyId));
    expect(body?.removedAt).toBeDefined();
    expect(
      await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT_CONTAINING }),
    ).toHaveLength(0);
  });

  test('keeps OSM and NHD distinct even when they share an externalId (source in the key)', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        { ...CANONICAL_ITEM, source: 'osm', externalId: 'shared/1', name: 'From OSM' },
        { ...CANONICAL_ITEM, source: 'nhd', externalId: 'shared/1', name: 'From NHD' },
      ],
    });
    const all = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    expect(all).toHaveLength(2); // not collapsed into one
    expect(all.map((b) => b.source).sort()).toEqual(['nhd', 'osm']);
  });

  test('flags isLarge from bbox extent — the tier-2 short list for listInViewport (D5)', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/big',
          name: 'Big',
          // Wider than the 0.05° margin in latitude → large (tier-2 scanned).
          bbox: { minLat: 0, minLng: 0, maxLat: 0.2, maxLng: 0.02 },
        },
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/small',
          name: 'Small',
          // Both axes under the margin → not large (tier-1 only).
          bbox: { minLat: 0, minLng: 0, maxLat: 0.02, maxLng: 0.02 },
        },
      ],
    });
    const bodies = await t.run((ctx) => ctx.db.query('waterBodies').collect());
    const flags = Object.fromEntries(bodies.map((b) => [b.name, b.isLarge]));
    expect(flags).toEqual({ Big: true, Small: false });
  });

  test('re-import re-derives isLarge when a body grows past the threshold', async () => {
    const t = convexTestWithGeo();
    // Import small, then re-import the same externalId with a large bbox: the flag flips.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, bbox: { minLat: 0, minLng: 0, maxLat: 0.02, maxLng: 0.02 } }],
    });
    expect((await t.run((ctx) => ctx.db.query('waterBodies').collect()))[0]?.isLarge).toBe(false);

    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 } }],
    });
    expect((await t.run((ctx) => ctx.db.query('waterBodies').collect()))[0]?.isLarge).toBe(true);
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

describe('waterBodies.backfillListed (listed key-switch migration, D48)', () => {
  test('re-indexes a body that has no geospatial entry so it becomes queryable', async () => {
    const t = convexTestWithGeo();
    // Insert a row directly WITHOUT a geospatial entry — mimics a body indexed under the old
    // reviewStatus key (which a `listed` filter can't find) / never indexed.
    const bodyId = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        ...SAMPLE_BODY,
        source: 'osm',
        externalId: 'osm/stale',
        dedupStatus: 'clean',
        createdAt: Date.now(),
      }),
    );
    // Not on the map before the backfill.
    expect(
      await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT_CONTAINING }),
    ).toHaveLength(0);

    const result = await t.mutation(internal.waterBodies.backfillListed, {});
    expect(result).toEqual({ reindexed: 1 });

    // Backfill also derives isLarge (SAMPLE_BODY spans 1°) so tier 2 can find it.
    expect((await t.run((ctx) => ctx.db.get(bodyId)))?.isLarge).toBe(true);

    // Now visible.
    const inView = await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT_CONTAINING });
    expect(inView.map((b) => b._id)).toEqual([bodyId]);
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
      await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT_CONTAINING }),
    ).toHaveLength(0);

    await asAdmin.mutation(api.waterBodies.restore, { waterBodyId: id });
    body = await t.run((ctx) => ctx.db.get(id));
    expect(body?.removedAt).toBeUndefined();
    expect(body?.removedByUserId).toBeUndefined();
    expect(body?.removalReason).toBeUndefined();
    const restored = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
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
    const pendingId = await asMember.mutation(api.waterBodies.create, SAMPLE_BODY);
    const otherId = await asMember.mutation(api.waterBodies.create, {
      ...SAMPLE_BODY,
      name: 'Joes Pond',
    });

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
        { ...CANONICAL_ITEM, externalId: 'osm/loser', name: 'Loser' },
        { ...CANONICAL_ITEM, externalId: 'osm/survivor', name: 'Survivor' },
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
        dedupStatus: 'clean',
        createdAt: Date.now(),
      });
      await ctx.db.delete(cid);
      return cid;
    });
    expect(await t.query(api.waterBodies.get, { waterBodyId: dangling })).toBeNull();
  });
});

describe('waterBodies.setCuratedBoost (D49, admin)', () => {
  test('a member cannot set the boost', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const id = await onlyBodyId(t);
    const asMember = await seedUser(t, 'clerk_member');
    await expect(
      asMember.mutation(api.waterBodies.setCuratedBoost, { waterBodyId: id, curatedBoost: 0.5 }),
    ).rejects.toThrow(/admin/i);
  });

  test('an admin sets the boost — raises prominence + writes one audit row', async () => {
    const t = convexTestWithGeo();
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] });
    const id = await onlyBodyId(t);
    const before = await t.run((ctx) => ctx.db.get(id));
    const asAdmin = await seedUser(t, 'clerk_admin', 'admin');

    await asAdmin.mutation(api.waterBodies.setCuratedBoost, { waterBodyId: id, curatedBoost: 1 });
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
          name: 'Prominent',
          surfaceAreaSqM: 1_000_000_000,
          bbox: { minLat: 0.4, minLng: 0.4, maxLat: 0.42, maxLng: 0.42 },
          centroid: { lat: 0.41, lng: 0.41 },
        },
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/tiny',
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

    const deep = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      zoom: 14,
    });
    expect(deep.map((b) => b.name).sort()).toEqual(['Prominent', 'Tiny']);
  });

  test('the zoom cutoff also drops a low-prominence LARGE body (tier-2 refine)', async () => {
    const t = convexTestWithGeo();
    // A large-bbox (isLarge → tier-2) but tiny-area body: minVisibleZoom ~14. At a wide zoom the
    // tier-2 JS refine must drop it (the geospatial sortKey filter only guards tier 1).
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/bigfaint',
          name: 'Big Faint',
          surfaceAreaSqM: 200, // tiny area ⇒ high minVisibleZoom
          bbox: { minLat: 0, minLng: 0, maxLat: 0.5, maxLng: 0.5 }, // wide ⇒ isLarge (tier-2)
          centroid: { lat: 0.25, lng: 0.25 },
        },
      ],
    });
    expect((await t.run((ctx) => ctx.db.query('waterBodies').collect()))[0]?.isLarge).toBe(true);
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

  test('a viewer’s favorite is pinned visible at every zoom, but only when it’s in view', async () => {
    const t = convexTestWithGeo();
    // A tiny pond (high minVisibleZoom) that a wide zoom would otherwise drop.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/belovedtiny',
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
          name: 'Loser Pond',
          surfaceAreaSqM: 200,
          bbox: { minLat: 0.5, minLng: 0.5, maxLat: 0.52, maxLng: 0.52 },
          centroid: { lat: 0.51, lng: 0.51 },
        },
        {
          ...CANONICAL_ITEM,
          externalId: 'osm/survivor',
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
        type: 'lake' as const,
        source: 'osm' as const,
        externalId: `osm/way/${name}`,
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
      type: 'lake',
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
    name,
    type: 'pond' as const,
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
