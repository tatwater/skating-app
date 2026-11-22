/**
 * The audit feed's target labels, read once per distinct target (B01-3c): a full page of 100 rows
 * makes at most 100 label reads, and a page on a few targets makes a few.
 */

import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { auditTargetLabels } from './lib/auditReads';
import { rebuildBodyLibrary } from './lib/bodyLibrary';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
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
  moderatorDecision: false,
};

/** A ctx whose database calls are counted. */
function counting(ctx: QueryCtx): { ctx: QueryCtx; calls: () => number } {
  let n = 0;
  const db = new Proxy(ctx.db, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if ((prop === 'query' || prop === 'get') && typeof v === 'function') {
        return (...args: unknown[]) => {
          n++;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ctx: { ...ctx, db } as QueryCtx, calls: () => n };
}

async function seed(t: ReturnType<typeof convexTest>, bodies: number, rows: number) {
  return t.run(async (ctx) => {
    const mod = await ctx.db.insert('profiles', {
      clerkUserId: 'labels-mod',
      displayName: 'M',
      username: 'labels-m',
      dateOfBirth: Date.UTC(1990, 0, 1),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: NOTIF_PREFS,
      reputationPoints: 0,
      role: 'moderator',
      status: 'active',
      createdAt: NOW,
    });
    const ids: Id<'waterBodies'>[] = [];
    for (let i = 0; i < bodies; i++) {
      const id = await ctx.db.insert('waterBodies', {
        name: `Body ${i}`,
        searchText: `body ${i}`,
        type: 'lakePond',
        source: 'osm',
        polygon: { type: 'Polygon', coordinates: [] },
        bbox: { minLat: 44, minLng: -72, maxLat: 44.01, maxLng: -71.99 },
        centroid: { lat: 44, lng: -72 },
        dedupStatus: 'clean',
        createdAt: NOW,
      });
      await rebuildBodyLibrary(ctx, id);
      ids.push(id);
    }
    for (let i = 0; i < rows; i++) {
      await ctx.db.insert('moderationActions', {
        actorId: mod,
        action: 'set_curated_boost',
        targetType: 'waterbody',
        targetId: ids[i % bodies] as string,
        reason: 'r',
        createdAt: NOW - i,
      });
    }
    return ids;
  });
}

describe('auditTargetLabels', () => {
  test('one read per distinct target, shared across the page', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 4, 100);
    const { labels, calls } = await t.run(async (raw) => {
      const rows = await raw.db.query('moderationActions').order('desc').take(100);
      const c = counting(raw);
      const labels = await auditTargetLabels(c.ctx, rows);
      return { labels: [...labels.values()], calls: c.calls() };
    });
    expect(labels.sort()).toEqual(['Body 0', 'Body 1', 'Body 2', 'Body 3']);
    expect(calls).toBe(4);
  });

  test('a full page of 100 distinct targets: every row labeled, at most 100 reads', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 100, 100);
    const calls = await t.run(async (raw) => {
      const rows = await raw.db.query('moderationActions').order('desc').take(100);
      const c = counting(raw);
      await auditTargetLabels(c.ctx, rows);
      return c.calls();
    });
    expect(calls).toBe(100);
    const feed = await t.withIdentity({ subject: 'labels-mod' }).query(api.moderation.listActions, {
      limit: 100,
    });
    expect(feed).toHaveLength(100);
    expect(feed.every((r) => typeof r.targetLabel === 'string')).toBe(true);
  });
});
