import geospatial from '@convex-dev/geospatial/test'
import { convexTest } from 'convex-test'
import { describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import schema from './schema'

const modules = import.meta.glob('./**/*.*s')

/** A `convexTest` instance with the geospatial component registered (D5). */
function convexTestWithGeo() {
  const t = convexTest(schema, modules)
  geospatial.register(t)
  return t
}

/** A viewport (bbox) centered on SAMPLE_BODY's centroid, and one far away. */
const VIEWPORT_CONTAINING = { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 }
const VIEWPORT_ELSEWHERE = { minLat: 40, minLng: -80, maxLat: 41, maxLng: -79 }

type Role = 'member' | 'moderator' | 'admin'
type Status = 'active' | 'suspended' | 'banned' | 'deleted'

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
}

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
}

/** The `_id` of the single water body in the DB (import/seed helpers create exactly one). */
async function onlyBodyId(t: ReturnType<typeof convexTest>): Promise<Id<'waterBodies'>> {
  const bodies = await t.run((ctx) => ctx.db.query('waterBodies').collect())
  const id = bodies[0]?._id
  if (!id) throw new Error('expected exactly one water body')
  return id
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
      requireFollowApproval: false,
      notificationPrefs: {
        activityDetected: true,
        bountyRequest: true,
        followedPostedNearby: true,
        hazardConfirmation: true,
        bountyFulfilled: true,
        newFollower: true,
        reportRated: true,
        contentFlagResolved: true,
      },
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status,
      ...(suspendedUntil !== undefined ? { suspendedUntil } : {}),
      createdAt: Date.now(),
    }),
  )
  return t.withIdentity({ subject })
}

describe('waterBodies.create', () => {
  test('rejects unauthenticated callers', async () => {
    const t = convexTestWithGeo()
    await expect(t.mutation(api.waterBodies.create, SAMPLE_BODY)).rejects.toThrow(
      /not authenticated/i,
    )
  })

  test('rejects a banned account (status gate, D37)', async () => {
    const t = convexTestWithGeo()
    const asBanned = await seedUser(t, 'clerk_banned', 'member', 'banned')
    await expect(asBanned.mutation(api.waterBodies.create, SAMPLE_BODY)).rejects.toThrow(
      /not active/i,
    )
  })

  test('rejects an account under active suspension (D37)', async () => {
    const t = convexTestWithGeo()
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000
    const asSuspended = await seedUser(t, 'clerk_susp', 'member', 'suspended', future)
    await expect(asSuspended.mutation(api.waterBodies.create, SAMPLE_BODY)).rejects.toThrow(
      /suspended/i,
    )
  })

  test('allows an account whose suspension has lapsed (D37)', async () => {
    const t = convexTestWithGeo()
    const past = Date.now() - 1000
    const asLapsed = await seedUser(t, 'clerk_lapsed', 'member', 'suspended', past)
    await expect(asLapsed.mutation(api.waterBodies.create, SAMPLE_BODY)).resolves.toBeDefined()
  })

  test('rejects a malformed (non-GeoJSON) polygon at the validator boundary (D5)', async () => {
    const t = convexTestWithGeo()
    const asMember = await seedUser(t, 'clerk_member')
    await expect(
      asMember.mutation(api.waterBodies.create, {
        ...SAMPLE_BODY,
        // Deliberately invalid geometry — cast past the arg type to exercise the
        // runtime validator (the whole point of the structured `geoJson` union).
        polygon: { type: 'Blob', coordinates: [] } as unknown as (typeof SAMPLE_BODY)['polygon'],
      }),
    ).rejects.toThrow()
  })

  test('a member creates a pending, user-sourced body attributed to them', async () => {
    const t = convexTestWithGeo()
    const asMember = await seedUser(t, 'clerk_member')

    const id = await asMember.mutation(api.waterBodies.create, SAMPLE_BODY)
    const body = await t.run((ctx) => ctx.db.get(id))

    expect(body?.source).toBe('user')
    expect(body?.reviewStatus).toBe('pending')
    expect(body?.dedupStatus).toBe('clean')
    expect(body?.name).toBe('Lake Morey')
  })
})

describe('waterBodies.approve (role gating + audit log, D37)', () => {
  async function seedPendingBody(t: ReturnType<typeof convexTest>): Promise<Id<'waterBodies'>> {
    const asMember = await seedUser(t, 'clerk_member')
    return asMember.mutation(api.waterBodies.create, SAMPLE_BODY)
  }

  test('a member cannot approve', async () => {
    const t = convexTestWithGeo()
    const bodyId = await seedPendingBody(t)
    const asMember = t.withIdentity({ subject: 'clerk_member' })
    await expect(
      asMember.mutation(api.waterBodies.approve, { waterBodyId: bodyId }),
    ).rejects.toThrow(/moderator/i)
  })

  test('a moderator approves and writes exactly one audit row', async () => {
    const t = convexTestWithGeo()
    const bodyId = await seedPendingBody(t)
    const asMod = await seedUser(t, 'clerk_mod', 'moderator')

    const returned = await asMod.mutation(api.waterBodies.approve, { waterBodyId: bodyId })
    expect(returned).toEqual(bodyId)

    const body = await t.run((ctx) => ctx.db.get(bodyId))
    expect(body?.reviewStatus).toBe('approved')

    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect())
    expect(actions).toHaveLength(1)
    expect(actions[0]?.action).toBe('approve_waterbody')
    expect(actions[0]?.targetType).toBe('waterbody')
    expect(actions[0]?.targetId).toBe(bodyId)
  })

  test('an admin may also approve (role precedence)', async () => {
    const t = convexTestWithGeo()
    const bodyId = await seedPendingBody(t)
    const asAdmin = await seedUser(t, 'clerk_admin', 'admin')

    await expect(
      asAdmin.mutation(api.waterBodies.approve, { waterBodyId: bodyId }),
    ).resolves.toEqual(bodyId)
  })

  test('cannot approve a body that is not pending (no rejection-reversal, no dup audit)', async () => {
    const t = convexTestWithGeo()
    const bodyId = await seedPendingBody(t)
    const asMod = await seedUser(t, 'clerk_mod', 'moderator')

    await asMod.mutation(api.waterBodies.approve, { waterBodyId: bodyId })
    // Second approve on the now-approved body must be rejected.
    await expect(asMod.mutation(api.waterBodies.approve, { waterBodyId: bodyId })).rejects.toThrow(
      /not pending/i,
    )

    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect())
    expect(actions).toHaveLength(1) // exactly one audit row, not two
  })

  test('cannot approve a canonical (non-user) body', async () => {
    const t = convexTestWithGeo()
    const asMod = await seedUser(t, 'clerk_mod', 'moderator')
    const canonicalId = await t.run((ctx) =>
      ctx.db.insert('waterBodies', {
        ...SAMPLE_BODY,
        source: 'osm',
        externalId: 'osm/123',
        dedupStatus: 'clean',
        createdAt: Date.now(),
      }),
    )
    await expect(
      asMod.mutation(api.waterBodies.approve, { waterBodyId: canonicalId }),
    ).rejects.toThrow(/user-created/i)
  })

  test('approving a missing body throws', async () => {
    const t = convexTestWithGeo()
    const asMod = await seedUser(t, 'clerk_mod', 'moderator')
    // Create then delete to obtain a well-formed but dangling id.
    const bodyId = await t.run(async (ctx) => {
      const id = await ctx.db.insert('waterBodies', {
        ...SAMPLE_BODY,
        source: 'user',
        dedupStatus: 'clean',
        createdAt: Date.now(),
      })
      await ctx.db.delete(id)
      return id
    })
    await expect(asMod.mutation(api.waterBodies.approve, { waterBodyId: bodyId })).rejects.toThrow(
      /not found/i,
    )
  })
})

describe('waterBodies.listInViewport (geospatial, D5)', () => {
  test('a pending user body is auto-visible (D37/D48) and stays visible after approval', async () => {
    const t = convexTestWithGeo()
    const asMember = await seedUser(t, 'clerk_member')
    const bodyId = await asMember.mutation(api.waterBodies.create, SAMPLE_BODY)

    // D48 fix: a fresh (pending) user body is listed immediately — not hidden until approved.
    const whilePending = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
    })
    expect(whilePending.map((b) => b._id)).toEqual([bodyId])
    expect(whilePending[0]?.name).toBe('Lake Morey')

    const asMod = await seedUser(t, 'clerk_mod', 'moderator')
    await asMod.mutation(api.waterBodies.approve, { waterBodyId: bodyId })

    const afterApprove = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
    })
    expect(afterApprove.map((b) => b._id)).toEqual([bodyId])
  })

  test('excludes a body whose bbox does not intersect the viewport', async () => {
    const t = convexTestWithGeo()
    const asMember = await seedUser(t, 'clerk_member')
    await asMember.mutation(api.waterBodies.create, SAMPLE_BODY)

    const elsewhere = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_ELSEWHERE,
    })
    expect(elsewhere).toHaveLength(0)
  })

  test('returns a large body whose centroid is off-screen but whose bbox overlaps (tier-2, D5)', async () => {
    const t = convexTestWithGeo()
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
    })
    const tinyViewport = { minLat: 0, minLng: 0, maxLat: 0.1, maxLng: 0.1 }
    const inView = await t.query(api.waterBodies.listInViewport, { viewport: tinyViewport })
    expect(inView.map((b) => b.name)).toEqual(['Big Lake'])
  })

  test('refines out a small body whose centroid is in the tier-1 margin but bbox is not in view', async () => {
    const t = convexTestWithGeo()
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
    })
    const near = await t.run((ctx) => ctx.db.query('waterBodies').collect())
    expect(near[0]?.isLarge).toBe(false) // caught by tier 1, not the large short list
    const tinyViewport = { minLat: 0, minLng: 0, maxLat: 0.1, maxLng: 0.1 }
    expect(await t.query(api.waterBodies.listInViewport, { viewport: tinyViewport })).toHaveLength(
      0,
    )
  })

  test('finds a small body at city zoom via the tier-1 centroid prefilter', async () => {
    const t = convexTestWithGeo()
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
    })
    const cityViewport = { minLat: 0, minLng: 0, maxLat: 0.1, maxLng: 0.1 }
    const inView = await t.query(api.waterBodies.listInViewport, { viewport: cityViewport })
    expect(inView.map((b) => b.name)).toEqual(['Small Pond'])
  })

  test('excludes a large body whose bbox does not intersect the viewport (tier-2 refine)', async () => {
    const t = convexTestWithGeo()
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
    })
    const tinyViewport = { minLat: 0, minLng: 0, maxLat: 0.1, maxLng: 0.1 }
    expect(await t.query(api.waterBodies.listInViewport, { viewport: tinyViewport })).toHaveLength(
      0,
    )
  })

  test('warns (does not silently drop) when the tier-1 cap is hit at a wide zoom (D5/D49)', async () => {
    const t = convexTestWithGeo()
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
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const inView = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
      limit: 2,
    })
    expect(inView).toHaveLength(2) // capped
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('prefilter cap'))
    warn.mockRestore()
  })

  test('sanitizes a bogus limit (0/negative) to the default rather than emptying tier 1', async () => {
    const t = convexTestWithGeo()
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
    })
    // limit: 0 must NOT wipe the tier-1 prefilter (which would leave only large bodies); it falls
    // back to the default, so all three small bodies still come back.
    for (const limit of [0, -5]) {
      const inView = await t.query(api.waterBodies.listInViewport, {
        viewport: VIEWPORT_CONTAINING,
        limit,
      })
      expect(inView).toHaveLength(3)
    }
  })

  test('returns only the bodies inside the viewport when several exist', async () => {
    const t = convexTestWithGeo()
    const asMember = await seedUser(t, 'clerk_member')
    const asMod = await seedUser(t, 'clerk_mod', 'moderator')

    // Inside VIEWPORT_CONTAINING (centroid 0.5, 0.5).
    const insideId = await asMember.mutation(api.waterBodies.create, SAMPLE_BODY)
    // Outside: centroid at (50, 50).
    const outsideId = await asMember.mutation(api.waterBodies.create, {
      ...SAMPLE_BODY,
      name: 'Far Pond',
      bbox: { minLat: 49, minLng: 49, maxLat: 51, maxLng: 51 },
      centroid: { lat: 50, lng: 50 },
    })
    await asMod.mutation(api.waterBodies.approve, { waterBodyId: insideId })
    await asMod.mutation(api.waterBodies.approve, { waterBodyId: outsideId })

    const inView = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
    })
    expect(inView.map((b) => b._id)).toEqual([insideId])
  })
})

describe('waterBodies.importCanonical (idempotent OSM upsert, D14/D48)', () => {
  test('inserts a canonical body (listed) and is idempotent on re-import', async () => {
    const t = convexTestWithGeo()

    const r1 = await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] })
    expect(r1).toEqual({ inserted: 1, updated: 0 })

    // Re-import with a changed name: same row updated, geometry/name patched, no new row.
    const r2 = await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, name: 'Lake Champlain (renamed)' }],
    })
    expect(r2).toEqual({ inserted: 0, updated: 1 })

    const all = await t.run((ctx) => ctx.db.query('waterBodies').collect())
    expect(all).toHaveLength(1)
    expect(all[0]?.source).toBe('osm')
    expect(all[0]?.name).toBe('Lake Champlain (renamed)')

    // Canonical bodies are auto-listed (no reviewStatus), so they render on the map.
    const inView = await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT_CONTAINING })
    expect(inView.map((b) => b._id)).toEqual([all[0]?._id])
  })

  test('a removed canonical body stays removed across re-import (landowner takedown, D48)', async () => {
    const t = convexTestWithGeo()
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] })
    const bodyId = await onlyBodyId(t)

    const asAdmin = await seedUser(t, 'clerk_admin', 'admin')
    await asAdmin.mutation(api.waterBodies.remove, {
      waterBodyId: bodyId,
      reason: 'landowner_request',
    })
    expect(
      await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT_CONTAINING }),
    ).toHaveLength(0)

    // The idempotent re-import must NOT resurrect the takedown.
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] })
    const body = await t.run((ctx) => ctx.db.get(bodyId))
    expect(body?.removedAt).toBeDefined()
    expect(
      await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT_CONTAINING }),
    ).toHaveLength(0)
  })

  test('keeps OSM and NHD distinct even when they share an externalId (source in the key)', async () => {
    const t = convexTestWithGeo()
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        { ...CANONICAL_ITEM, source: 'osm', externalId: 'shared/1', name: 'From OSM' },
        { ...CANONICAL_ITEM, source: 'nhd', externalId: 'shared/1', name: 'From NHD' },
      ],
    })
    const all = await t.run((ctx) => ctx.db.query('waterBodies').collect())
    expect(all).toHaveLength(2) // not collapsed into one
    expect(all.map((b) => b.source).sort()).toEqual(['nhd', 'osm'])
  })

  test('flags isLarge from bbox extent — the tier-2 short list for listInViewport (D5)', async () => {
    const t = convexTestWithGeo()
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
    })
    const bodies = await t.run((ctx) => ctx.db.query('waterBodies').collect())
    const flags = Object.fromEntries(bodies.map((b) => [b.name, b.isLarge]))
    expect(flags).toEqual({ Big: true, Small: false })
  })

  test('re-import re-derives isLarge when a body grows past the threshold', async () => {
    const t = convexTestWithGeo()
    // Import small, then re-import the same externalId with a large bbox: the flag flips.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, bbox: { minLat: 0, minLng: 0, maxLat: 0.02, maxLng: 0.02 } }],
    })
    expect((await t.run((ctx) => ctx.db.query('waterBodies').collect()))[0]?.isLarge).toBe(false)

    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...CANONICAL_ITEM, bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 } }],
    })
    expect((await t.run((ctx) => ctx.db.query('waterBodies').collect()))[0]?.isLarge).toBe(true)
  })
})

describe('waterBodies.backfillListed (listed key-switch migration, D48)', () => {
  test('re-indexes a body that has no geospatial entry so it becomes queryable', async () => {
    const t = convexTestWithGeo()
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
    )
    // Not on the map before the backfill.
    expect(
      await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT_CONTAINING }),
    ).toHaveLength(0)

    const result = await t.mutation(internal.waterBodies.backfillListed, {})
    expect(result).toEqual({ reindexed: 1 })

    // Backfill also derives isLarge (SAMPLE_BODY spans 1°) so tier 2 can find it.
    expect((await t.run((ctx) => ctx.db.get(bodyId)))?.isLarge).toBe(true)

    // Now visible.
    const inView = await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT_CONTAINING })
    expect(inView.map((b) => b._id)).toEqual([bodyId])
  })
})

describe('waterBodies.remove / restore (admin soft-delist, D48)', () => {
  async function seedCanonical(t: ReturnType<typeof convexTest>): Promise<Id<'waterBodies'>> {
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [CANONICAL_ITEM] })
    return onlyBodyId(t)
  }

  test('a moderator cannot remove (admin-only)', async () => {
    const t = convexTestWithGeo()
    const id = await seedCanonical(t)
    const asMod = await seedUser(t, 'clerk_mod', 'moderator')
    await expect(
      asMod.mutation(api.waterBodies.remove, { waterBodyId: id, reason: 'junk' }),
    ).rejects.toThrow(/admin/i)
  })

  test('an admin removes (off the map, audited) then restores (back on the map, audited)', async () => {
    const t = convexTestWithGeo()
    const id = await seedCanonical(t)
    const asAdmin = await seedUser(t, 'clerk_admin', 'admin')

    await asAdmin.mutation(api.waterBodies.remove, { waterBodyId: id, reason: 'landowner_request' })
    let body = await t.run((ctx) => ctx.db.get(id))
    expect(body?.removedAt).toBeDefined()
    expect(body?.removedByUserId).toBeDefined()
    expect(body?.removalReason).toBe('landowner_request')
    expect(
      await t.query(api.waterBodies.listInViewport, { viewport: VIEWPORT_CONTAINING }),
    ).toHaveLength(0)

    await asAdmin.mutation(api.waterBodies.restore, { waterBodyId: id })
    body = await t.run((ctx) => ctx.db.get(id))
    expect(body?.removedAt).toBeUndefined()
    expect(body?.removedByUserId).toBeUndefined()
    expect(body?.removalReason).toBeUndefined()
    const restored = await t.query(api.waterBodies.listInViewport, {
      viewport: VIEWPORT_CONTAINING,
    })
    expect(restored.map((b) => b._id)).toEqual([id])

    // One audit row per action, correctly typed, with the reason captured in metadata.
    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect())
    expect(actions.map((a) => a.action).sort()).toEqual(['remove', 'restore'])
    const removeRow = actions.find((a) => a.action === 'remove')
    expect(removeRow?.targetType).toBe('waterbody')
    expect(removeRow?.targetId).toBe(id)
    expect(removeRow?.metadata?.removalReason).toBe('landowner_request')
  })

  test('no double-remove or double-restore (idempotency guard, no duplicate audit rows)', async () => {
    const t = convexTestWithGeo()
    const id = await seedCanonical(t)
    const asAdmin = await seedUser(t, 'clerk_admin', 'admin')

    await asAdmin.mutation(api.waterBodies.remove, { waterBodyId: id, reason: 'junk' })
    await expect(
      asAdmin.mutation(api.waterBodies.remove, { waterBodyId: id, reason: 'junk' }),
    ).rejects.toThrow(/already removed/i)

    await asAdmin.mutation(api.waterBodies.restore, { waterBodyId: id })
    await expect(asAdmin.mutation(api.waterBodies.restore, { waterBodyId: id })).rejects.toThrow(
      /not removed/i,
    )

    const actions = await t.run((ctx) => ctx.db.query('moderationActions').collect())
    expect(actions).toHaveLength(2) // exactly one remove + one restore
  })

  test('remove/restore on a missing body throws', async () => {
    const t = convexTestWithGeo()
    const asAdmin = await seedUser(t, 'clerk_admin', 'admin')
    const danglingId = await t.run(async (ctx) => {
      const cid = await ctx.db.insert('waterBodies', {
        ...SAMPLE_BODY,
        source: 'osm',
        externalId: 'osm/gone',
        dedupStatus: 'clean',
        createdAt: Date.now(),
      })
      await ctx.db.delete(cid)
      return cid
    })
    await expect(
      asAdmin.mutation(api.waterBodies.remove, { waterBodyId: danglingId, reason: 'other' }),
    ).rejects.toThrow(/not found/i)
    await expect(
      asAdmin.mutation(api.waterBodies.restore, { waterBodyId: danglingId }),
    ).rejects.toThrow(/not found/i)
  })
})

describe('waterBodies.listPendingReview', () => {
  test('a member cannot read the review queue', async () => {
    const t = convexTestWithGeo()
    const asMember = await seedUser(t, 'clerk_member')
    await expect(asMember.query(api.waterBodies.listPendingReview, {})).rejects.toThrow(
      /moderator/i,
    )
  })

  test('a moderator sees pending bodies but not approved ones', async () => {
    const t = convexTestWithGeo()
    const asMember = await seedUser(t, 'clerk_member')
    const pendingId = await asMember.mutation(api.waterBodies.create, SAMPLE_BODY)
    const otherId = await asMember.mutation(api.waterBodies.create, {
      ...SAMPLE_BODY,
      name: 'Joes Pond',
    })

    const asMod = await seedUser(t, 'clerk_mod', 'moderator')
    await asMod.mutation(api.waterBodies.approve, { waterBodyId: otherId })

    const queue = await asMod.query(api.waterBodies.listPendingReview, {})
    expect(queue).toHaveLength(1)
    expect(queue[0]?._id).toEqual(pendingId)
  })
})
