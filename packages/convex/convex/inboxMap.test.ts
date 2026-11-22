/**
 * `inbox.itemMap` (B01-5): each kind's scene, outlines sent whole within their bound and simplified
 * past it, the whole answer bounded on bytes with `capped` said; and the drawn item's overlap share
 * and the Access item's two stored facts (the ruling's reason, the open contest asks).
 */

import { getDocumentSize } from 'convex/values';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { bodySource, fileMember } from './lib/inboxItems';
import { MAP_BOUNDS } from './lib/inboxViews';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

const PREFS = {
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

async function person(t: T, subject: string, role: 'member' | 'moderator' | 'admin' = 'member') {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `${subject} Test-Person`,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

/** A ring of `n` points around (x, 0). */
function ring(x: number, n: number, r = 0.5): Polygon {
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [x + r * Math.cos(a), r * Math.sin(a)];
  });
  return { type: 'Polygon', coordinates: [[...pts, pts[0] as number[]]] };
}

/**
 * An outline of about `n` points that a deployment can store: the shore a ring of up to 8,000 (an
 * array caps at 8,192 items), the rest small islands near the middle, each a ring under the cap.
 */
function heavyOutline(x: number, n: number): Polygon {
  const rings = ring(x, Math.min(n, 8_000)).coordinates;
  for (let left = n - 8_000, k = 0; left > 0; left -= 8_000, k++) {
    const hole = ring(x + 0.1 * (k - 1), Math.min(left, 8_000), 0.02).coordinates[0] as number[][];
    rings.push(hole);
  }
  return { type: 'Polygon', coordinates: rings };
}

async function lake(t: T, externalId: string, x: number, points = 8) {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        states: ['NH'],
        externalId,
        osmId: externalId,
        name: `Pond ${externalId}`,
        type: 'lakePond',
        polygon: ring(x, points),
        bbox: { minLat: -0.5, minLng: x - 0.5, maxLat: 0.5, maxLng: x + 0.5 },
        centroid: { lat: 0, lng: x },
        surfaceAreaSqM: 1_000_000,
      },
    ],
  });
  const row = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  );
  if (!row) throw new Error('seed failed');
  return row._id;
}

/** A skater's drawing lying inside a known body, filed as an Inbox item. */
async function drawnWorld() {
  const t = harness();
  const mod = await person(t, 'mod', 'moderator');
  const s = await person(t, 's');
  const known = await lake(t, 'osm/K', 0);
  const drawn = await t.run(async (ctx) => {
    const id = await ctx.db.insert('waterBodies', {
      name: 'Drawn',
      searchText: 'Drawn',
      type: 'lakePond',
      source: 'user',
      polygon: ring(0.1, 16, 0.3),
      bbox: { minLat: -0.3, minLng: -0.2, maxLat: 0.3, maxLng: 0.4 },
      centroid: { lat: 0, lng: 0.1 },
      createdByUserId: s.id,
      reviewStatus: 'pending',
      dedupStatus: 'near_certain',
      duplicateCandidateIds: [known],
      createdAt: 1,
    } as never);
    await fileMember(ctx, bodySource(id as Id<'waterBodies'>));
    return id as Id<'waterBodies'>;
  });
  return { t, mod, known, drawn };
}

describe('inbox.itemMap', () => {
  test('a flag on a report: the body’s outline, whole, and the flagged point', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const s = await person(t, 's');
    const a = await lake(t, 'osm/A', 0);
    const report = await t.run((ctx) =>
      ctx.db.insert('reports', {
        authorId: s.id,
        waterBodyId: a,
        point: { lat: 0.1, lng: 0.2 },
        skateEndTime: 1,
        reportTime: 1,
        source: 'native',
        iceTypes: [],
        surfaceTags: [],
        photoIds: [],
        moderationStatus: 'visible',
        hazardIdsCreated: [],
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const flag = await s.as.mutation(api.contentFlags.flag, {
      targetType: 'report',
      targetId: report,
      reason: 'spam',
    });
    const { map } = await mod.as.query(api.inbox.itemMap, { ref: `flag:${flag}` });
    expect(map?.body).toMatchObject({ id: a, name: 'Pond osm/A', simplified: false });
    expect(map?.points).toEqual([{ id: report, at: [0.2, 0.1] }]);
    expect(map?.capped).toBe(false);
  });

  test('access: the body and its put-ins; an outline past its bound is simplified and says so', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const s = await person(t, 's');
    // 30,000 points stored as-is (past the import's own simplification), in rings a deployment can
    // hold: over the embed's bound.
    const a = await lake(t, 'osm/Big', 0);
    await t.run((ctx) => ctx.db.patch(a, { polygon: heavyOutline(0, 30_000) }));
    await t.run((ctx) =>
      ctx.db.insert('putIns', {
        waterBodyId: a,
        coord: { lat: 0.4, lng: 0.1 },
        source: 'derived',
        status: 'visible',
        name: 'Town beach',
        createdAt: 1,
      }),
    );
    await s.as.mutation(api.contentFlags.flag, {
      targetType: 'waterbody',
      targetId: a,
      reason: 'no_public_access',
    });
    await mod.as.mutation(api.waterBodies.setPublicAccess, {
      waterBodyId: a,
      verdict: 'open',
      reason: 'Town says the beach lot is public',
    });
    await person(t, 's2');
    const dispute = await t.withIdentity({ subject: 's2' }).mutation(api.contentFlags.flag, {
      targetType: 'waterbody',
      targetId: a,
      reason: 'no_public_access',
      note: 'Gated now',
    });
    const item = (await mod.as.query(api.inbox.item, { ref: `flag:${dispute}` })).item;
    if (item?.kind !== 'access') throw new Error('expected an access item');
    expect(item.ruling).toMatchObject({
      verdict: 'open',
      reason: 'Town says the beach lot is public',
    });
    expect(item.contestAsks).toEqual({ count: 0, capped: false });
    const { map } = await mod.as.query(api.inbox.itemMap, { ref: `flag:${dispute}` });
    expect(map?.body?.simplified).toBe(true);
    const outline = map?.body?.outline as Polygon;
    expect(outline.coordinates[0]?.length).toBeLessThanOrEqual(513);
    expect(map?.access).toEqual([
      { id: expect.any(String), at: [0.1, 0.4], kind: 'putIn', name: 'Town beach' },
    ]);
  });

  test('a drawn body: its outline, the known body it overlaps, and the share', async () => {
    const { mod, known, drawn } = await drawnWorld();
    const item = (await mod.as.query(api.inbox.item, { ref: `body:${drawn}` })).item;
    if (item?.kind !== 'drawn') throw new Error('expected a drawn item');
    expect(item.overlap?.share).toBeGreaterThan(0.99);
    expect(item.overlap?.suggested).toBe(true);
    const { map } = await mod.as.query(api.inbox.itemMap, { ref: `body:${drawn}` });
    expect(map?.body?.id).toBe(drawn);
    expect(map?.others.map((o) => [o.id, o.simplified])).toEqual([[known, true]]);
    expect(map?.overlapShare).toBe(item.overlap?.share);
  });

  test('a request with no body: the catalog feature, and each ask’s point', async () => {
    const t = harness();
    const mod = await person(t, 'mod', 'moderator');
    const s = await person(t, 's');
    const requestId = await s.as.mutation(api.corpusRequests.create, {
      kind: 'admit',
      coord: { lat: 30, lng: 30 },
    });
    await t.mutation(internal.corpusRequests.recordResolution, {
      requestId,
      resolvedAt: 1,
      candidate: {
        source: '3dhp',
        externalId: 'EXT',
        name: 'Unseen',
        featureType: 1,
        polygon: ring(30, 10, 0.01),
        bbox: { minLat: 29.99, minLng: 29.99, maxLat: 30.01, maxLng: 30.01 },
        centroid: { lat: 30, lng: 30 },
        surfaceAreaSqM: 10,
        serviceUrl: 'https://example.invalid',
        fetchedAt: 1,
      },
    });
    const { map } = await mod.as.query(api.inbox.itemMap, { ref: `request:${requestId}` });
    expect(map?.body).toBeNull();
    expect(map?.candidate).toMatchObject({ id: 'EXT', name: 'Unseen', simplified: false });
    expect(map?.points).toEqual([{ id: requestId, at: [30, 30] }]);
  });

  test('the answer is bounded on bytes: an outline that doesn’t fit is left out, and capped says so', async () => {
    const { mod, known, drawn } = await drawnWorld();
    const whole = (await mod.as.query(api.inbox.itemMap, { ref: `body:${drawn}` })).map;
    const bodyBytes = getDocumentSize(whole?.body?.outline as never);
    const saved = { ...MAP_BOUNDS };
    try {
      // Room for the drawing's outline and not the known body's: the neighbor is left out.
      MAP_BOUNDS.answerBytes = bodyBytes;
      const tight = (await mod.as.query(api.inbox.itemMap, { ref: `body:${drawn}` })).map;
      expect(tight?.body?.id).toBe(drawn);
      expect(tight?.others).toEqual([]);
      expect(tight?.capped).toBe(true);
      // Room for nothing: no outline at all, still honest.
      MAP_BOUNDS.answerBytes = 8;
      const none = (await mod.as.query(api.inbox.itemMap, { ref: `body:${drawn}` })).map;
      expect(none?.body).toBeNull();
      expect(none?.capped).toBe(true);
      // An own outline past its whole-outline bound is sent simplified to the ring's points.
      MAP_BOUNDS.answerBytes = saved.answerBytes;
      MAP_BOUNDS.outlineBytes = 8;
      MAP_BOUNDS.ringPoints = 4;
      const simple = (await mod.as.query(api.inbox.itemMap, { ref: `body:${drawn}` })).map;
      expect(simple?.body?.simplified).toBe(true);
      expect((simple?.body?.outline as Polygon | undefined)?.coordinates[0]).toHaveLength(5);
      expect(simple?.others.map((o) => o.id)).toEqual([known]);
    } finally {
      Object.assign(MAP_BOUNDS, saved);
    }
  });
});
