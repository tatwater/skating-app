/**
 * Audit rows linked to the bodies they concern (B01-3b): written by `writeAudit`, backfilled for the
 * rows before it, and read by a body's History as one indexed range per body in its merge chain.
 */

import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { writeAudit } from './lib/audit';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.now();

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
const square: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72.01, 43.99],
      [-71.99, 43.99],
      [-71.99, 44.01],
      [-72.01, 44.01],
      [-72.01, 43.99],
    ],
  ],
};

async function seed(t: T) {
  return t.run(async (ctx) => {
    const mod = await ctx.db.insert('profiles', {
      clerkUserId: 'links-mod',
      displayName: 'M',
      username: 'links-m',
      dateOfBirth: Date.UTC(1990, 0, 1),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: NOTIF_PREFS,
      reputationPoints: 0,
      role: 'moderator',
      status: 'active',
      createdAt: NOW,
    });
    const body = (name: string) =>
      ctx.db.insert('waterBodies', {
        name,
        searchText: name,
        type: 'lakePond',
        source: 'osm',
        polygon: square,
        bbox: { minLat: 43.99, minLng: -72.01, maxLat: 44.01, maxLng: -71.99 },
        centroid: { lat: 44, lng: -72 },
        dedupStatus: 'clean',
        createdAt: NOW,
      });
    const a = await body('A');
    const b = await body('B');
    const lot = await ctx.db.insert('parkingAreas', {
      coord: { lat: 44, lng: -72 },
      source: 'official',
      status: 'visible',
      amenities: [],
      createdAt: NOW,
    });
    for (const waterBodyId of [a, b]) {
      await ctx.db.insert('parkingAreaBodies', {
        parkingAreaId: lot,
        waterBodyId,
        inferred: false,
        createdAt: NOW,
      });
    }
    return { mod, a, b, lot };
  });
}

describe('links written at the write', () => {
  test('a body row, a lot serving two bodies, and the body-only and verb options', async () => {
    const t = harness();
    const { mod, a, b, lot } = await seed(t);
    const as = t.withIdentity({ subject: 'links-mod' });
    await t.run(async (ctx) => {
      await writeAudit(ctx, {
        actorId: mod,
        action: 'set_curated_boost',
        targetType: 'waterbody',
        targetId: a,
        reason: 'r',
        createdAt: NOW - 3000,
      });
      await writeAudit(ctx, {
        actorId: mod,
        action: 'set_parking_area',
        targetType: 'parkingArea',
        targetId: lot,
        reason: 'r',
        createdAt: NOW - 2000,
      });
    });
    // No backfill: the write linked them. The lot's row concerns both bodies.
    for (const id of [a, b]) {
      const h = await as.query(api.bodyConsole.history, { waterBodyId: id });
      expect(h.entries.map((e) => e.action)).toContain('set_parking_area');
      expect(h.capped).toBe(false);
    }
    const own = await as.query(api.bodyConsole.history, { waterBodyId: a, bodyOnly: true });
    expect(own.entries.map((e) => e.action)).toEqual(['set_curated_boost']);
    const boosts = await as.query(api.bodyConsole.history, {
      waterBodyId: a,
      action: 'set_curated_boost',
    });
    expect(boosts.entries).toHaveLength(1);
    // The audit's own reader for the body agrees with History's body-only, verb-filtered rows.
    const listed = await as.query(api.moderation.listActions, {
      targetType: 'waterbody',
      targetId: a,
      action: 'set_curated_boost',
    });
    const historyRows = await as.query(api.bodyConsole.history, {
      waterBodyId: a,
      action: 'set_curated_boost',
      bodyOnly: true,
    });
    expect(historyRows.entries.map((e) => e.id)).toEqual(listed.map((r) => r.id));
    // The feed names the body from its stored library row (S5); a lot has no label.
    await t.mutation(internal.bodyLibrary.refreshOne, { waterBodyId: a });
    await t.run((ctx) =>
      writeAudit(ctx, {
        actorId: mod,
        action: 'set_posting_permission',
        targetType: 'user',
        targetId: mod,
        reason: 'r',
        createdAt: NOW - 1000,
      }),
    );
    const feed = await as.query(api.moderation.listActions, {});
    expect(feed.find((r) => r.action === 'set_curated_boost')?.targetLabel).toBe('A');
    expect(feed.find((r) => r.action === 'set_parking_area')).not.toHaveProperty('targetLabel');
    expect(feed.find((r) => r.action === 'set_posting_permission')?.targetLabel).toBe('M');
  });

  test('a merged-away id reads its survivor’s history; capped means only more rows than the limit', async () => {
    const t = harness();
    const { mod, a, b } = await seed(t);
    const as = t.withIdentity({ subject: 'links-mod' });
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await writeAudit(ctx, {
          actorId: mod,
          action: 'set_curated_boost',
          targetType: 'waterbody',
          targetId: b,
          reason: 'r',
          createdAt: NOW - 100 * i,
        });
      }
      await ctx.db.patch(b, { dedupStatus: 'merged', mergedIntoId: a });
    });
    const viaLoser = await as.query(api.bodyConsole.history, { waterBodyId: b, limit: 3 });
    const viaSurvivor = await as.query(api.bodyConsole.history, { waterBodyId: a, limit: 3 });
    expect(viaLoser).toEqual(viaSurvivor);
    expect(viaSurvivor).toMatchObject({ capped: false });
    expect(viaSurvivor.entries).toHaveLength(3);
    expect(await as.query(api.bodyConsole.history, { waterBodyId: a, limit: 2 })).toMatchObject({
      capped: true,
    });
  });
});

describe('the backfill', () => {
  test('links the rows written before, once, and counts a row it cannot resolve without stopping', async () => {
    const t = harness();
    const { mod, a } = await seed(t);
    const ids = await t.run(async (ctx) => {
      const ok = await ctx.db.insert('moderationActions', {
        actorId: mod,
        action: 'set_curated_boost',
        targetType: 'waterbody',
        targetId: a,
        reason: 'r',
        createdAt: NOW - 5000,
      });
      const orphan = await ctx.db.insert('moderationActions', {
        actorId: mod,
        action: 'remove',
        targetType: 'bodyLandmark',
        targetId: 'not an id',
        reason: 'r',
        createdAt: NOW - 4000,
      });
      return { ok, orphan };
    });
    const first = await t.mutation(internal.auditLinks.backfill, { chain: false });
    expect(first).toMatchObject({ linked: 1, isDone: true });
    const again = await t.mutation(internal.auditLinks.backfill, { chain: false });
    expect(again).toMatchObject({ linked: 0, isDone: true });
    const links = await t.run((ctx) =>
      ctx.db
        .query('auditBodyLinks')
        .withIndex('by_action', (q) => q.eq('actionId', ids.ok as Id<'moderationActions'>))
        .collect(),
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ waterBodyId: a, self: true, action: 'set_curated_boost' });
  });
});
