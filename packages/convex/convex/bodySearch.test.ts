/**
 * A body is found by a moderator's alias in every search a skater can run (B01-3h): one builder
 * (`bodySearchTextFor`) behind `waterBodies.searchText`, rebuilt by every writer of a name, and the
 * hit saying which other name matched. A removed or rejected body is found by no name; a merged-away
 * duplicate's names find its survivor. Plus the repair pass, and the search read's cost.
 */

import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import schema from './schema';
import { MAX_MODERATOR_ALIAS_CHARS, MAX_MODERATOR_ALIASES, searchByNameImpl } from './waterBodies';

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
const square = (x: number, side = 0.02) => ({
  type: 'Polygon' as const,
  coordinates: [
    [
      [x, 44],
      [x + side, 44],
      [x + side, 44 + side],
      [x, 44 + side],
      [x, 44],
    ],
  ],
});

let seq = 0;
async function moderator(t: T) {
  const n = seq++;
  const subject = `search-${n}`;
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `Sam ${n}`,
      username: `sam-${n}`,
      dateOfBirth: Date.UTC(1990, 0, 1),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: NOTIF_PREFS,
      reputationPoints: 0,
      role: 'admin',
      status: 'active',
      createdAt: NOW,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

async function imported(
  t: T,
  externalId: string,
  name: string,
  x = -72,
  polygon: unknown = square(x),
  nameClaims?: { source: string; value: string }[],
): Promise<Id<'waterBodies'>> {
  await t.mutation(internal.waterBodies.importCanonical, {
    bodies: [
      {
        source: 'osm',
        externalId,
        osmId: externalId,
        name,
        type: 'lakePond',
        polygon: polygon as never,
        bbox: { minLat: 44, minLng: x, maxLat: 44.02, maxLng: x + 0.02 },
        centroid: { lat: 44.01, lng: x + 0.01 },
        surfaceAreaSqM: 40_000,
        ...(nameClaims !== undefined ? { nameClaims: nameClaims as never } : {}),
      },
    ],
  });
  const body = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  );
  if (!body) throw new Error('not imported');
  return body._id;
}

const search = (t: T, query: string, limit?: number) =>
  t.query(api.waterBodies.searchByName, { query, ...(limit !== undefined ? { limit } : {}) });
const lastAction = (t: T, action: Doc<'moderationActions'>['action']) =>
  t.run(async (ctx) => {
    const rows = await ctx.db.query('moderationActions').order('desc').collect();
    return rows.find((r) => r.action === action) as Doc<'moderationActions'>;
  });

describe('a moderator’s alias in skater search', () => {
  test('found by the alias, saying which matched; gone again with the undo, back with its undo', async () => {
    const t = harness();
    const mod = await moderator(t);
    const id = await imported(t, 'way/1', 'Mirror Lake');
    expect(await search(t, 'Glass Pond')).toEqual([]);
    await mod.as.mutation(api.waterBodies.setAliases, { waterBodyId: id, aliases: ['Glass Pond'] });
    const [hit] = await search(t, 'Glass Pond');
    expect(hit).toMatchObject({
      waterBodyId: id,
      name: 'Mirror Lake',
      aliases: ['Glass Pond'],
      matchedAlias: 'Glass Pond',
    });
    // The shown name matching says no alias matched.
    expect((await search(t, 'Mirror'))[0]?.matchedAlias).toBeUndefined();
    const set = await lastAction(t, 'set_aliases');
    await mod.as.mutation(api.undo.run, { actionId: set._id });
    expect(await search(t, 'Glass Pond')).toEqual([]);
    await mod.as.mutation(api.undo.run, { actionId: (await lastAction(t, 'set_aliases'))._id });
    expect((await search(t, 'Glass Pond'))[0]?.waterBodyId).toBe(id);
  });

  test('survives a re-import, a name override and its clear — the console’s library finds it the same', async () => {
    const t = harness();
    const mod = await moderator(t);
    const claims = [
      { source: 'osm', value: 'Mirror Lake' },
      { source: 'nhd', value: 'Mirror Pond' },
    ];
    const id = await imported(t, 'way/1', 'Mirror Lake', -72, square(-72), claims);
    await mod.as.mutation(api.waterBodies.setAliases, { waterBodyId: id, aliases: ['Glass Pond'] });
    await imported(t, 'way/1', 'Mirror Lake', -72, square(-72), claims);
    expect((await search(t, 'Glass Pond'))[0]?.waterBodyId).toBe(id);
    await mod.as.mutation(api.waterBodies.setWaterBodyName, {
      waterBodyId: id,
      name: 'Mirror Pond',
    });
    expect((await search(t, 'Glass Pond'))[0]?.waterBodyId).toBe(id);
    await mod.as.mutation(api.waterBodies.setWaterBodyName, { waterBodyId: id, name: null });
    expect((await search(t, 'Glass Pond'))[0]?.waterBodyId).toBe(id);
    const found = await mod.as.query(api.bodies.listPage, {
      lane: 'all',
      q: 'glass',
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(found.page.map((r) => r.id)).toEqual([id]);
  });

  test('a removed or rejected body is found by no name; a merged-away duplicate’s alias finds its survivor', async () => {
    const t = harness();
    const mod = await moderator(t);
    const removed = await imported(t, 'way/1', 'Upper Pond', -72);
    const rejected = await imported(t, 'way/2', 'Middle Pond', -71.9);
    const loser = await imported(t, 'way/3', 'Lower Pond', -71.8);
    const survivor = await imported(t, 'way/4', 'Long Lake', -71.7);
    for (const [waterBodyId, alias] of [
      [removed, 'Hemlock Cove'],
      [rejected, 'Birch Hollow'],
      [loser, 'Cedar Narrows'],
    ] as const) {
      await mod.as.mutation(api.waterBodies.setAliases, { waterBodyId, aliases: [alias] });
    }
    await t.run(async (ctx) => {
      await ctx.db.patch(removed, { removedAt: NOW, removalReason: 'junk' });
      await ctx.db.patch(rejected, { reviewStatus: 'rejected' });
    });
    await mod.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    expect(await search(t, 'Hemlock Cove')).toEqual([]);
    expect(await search(t, 'Birch Hollow')).toEqual([]);
    const viaLoser = await search(t, 'Cedar Narrows');
    expect(viaLoser).toHaveLength(1);
    expect(viaLoser[0]).toMatchObject({ waterBodyId: survivor, matchedAlias: 'Cedar Narrows' });
    // The duplicate's own name finds the survivor once, never twice.
    const both = await search(t, 'Pond');
    expect(both.filter((h) => h.waterBodyId === survivor)).toHaveLength(1);
    expect(both.map((h) => h.waterBodyId)).not.toContain(loser);
  });
});

describe('the repair pass (backfillSearchText)', () => {
  test('dry by default, writes only stale bodies, chains to the end and logs where it is', async () => {
    const t = harness();
    const ids: Id<'waterBodies'>[] = [];
    for (let i = 0; i < 5; i++) ids.push(await imported(t, `way/${i}`, `Pond ${i}`, -72 + i * 0.1));
    // Two bodies a rule change left one rule behind: aliases with no text for them.
    await t.run(async (ctx) => {
      await ctx.db.patch(ids[1] as Id<'waterBodies'>, { moderatorAliases: ['Hidden One'] });
      await ctx.db.patch(ids[3] as Id<'waterBodies'>, { moderatorAliases: ['Hidden Three'] });
    });
    const dry = await t.mutation(internal.waterBodies.backfillSearchText, {});
    expect(dry).toMatchObject({ applied: false, written: 2, alreadyCorrect: 3, failed: [] });
    expect(await search(t, 'Hidden One')).toEqual([]);
    const first = await t.mutation(internal.waterBodies.backfillSearchText, {
      apply: true,
      batchSize: 2,
      chain: true,
    });
    expect(first).toMatchObject({ scanned: 2, isDone: false, stopped: false });
    await t.finishAllScheduledFunctions(() => undefined);
    expect((await search(t, 'Hidden One'))[0]?.waterBodyId).toBe(ids[1]);
    expect((await search(t, 'Hidden Three'))[0]?.waterBodyId).toBe(ids[3]);
    const again = await t.mutation(internal.waterBodies.backfillSearchText, { apply: true });
    expect(again).toMatchObject({ written: 0, alreadyCorrect: 5, isDone: true });
  });
});

describe('the search read’s cost (B01-3h, measured)', () => {
  test('the worst case: a full page, every alias at its bound, every hit a merged duplicate', async () => {
    const t = harness();
    const mod = await moderator(t);
    // A heavy outline (1,000 vertices) on every body, so a page's bytes are its outlines.
    const ring = Array.from({ length: 1_000 }, (_, i) => {
      const a = (2 * Math.PI * i) / 1_000;
      return [-72 + 0.01 * Math.cos(a), 44 + 0.01 * Math.sin(a)];
    });
    const heavy = { type: 'Polygon' as const, coordinates: [[...ring, ring[0]]] };
    const bytesOf = (query: string) =>
      t.run(async (ctx) => {
        const before = (await ctx.meta.getTransactionMetrics()).bytesRead.used;
        const hits = await searchByNameImpl(ctx, { query, limit: 2 });
        const after = (await ctx.meta.getTransactionMetrics()).bytesRead.used;
        return { bytes: after - before, hits: hits.length };
      });
    const ids: Id<'waterBodies'>[] = [];
    for (let i = 0; i < 8; i++)
      ids.push(await imported(t, `way/${i}`, `Twin Pond ${i}`, -72, heavy));
    const base = await bytesOf('Twin Pond');
    // After: every alias a body may carry, at its longest, on every body; half the corpus merged.
    const long = (i: number, j: number) => `Twin ${i} ${j} `.padEnd(MAX_MODERATOR_ALIAS_CHARS, 'x');
    for (const [i, id] of ids.entries()) {
      await mod.as.mutation(api.waterBodies.setAliases, {
        waterBodyId: id,
        aliases: Array.from({ length: MAX_MODERATOR_ALIASES }, (_, j) => long(i, j)),
      });
    }
    for (let i = 0; i < 4; i++) {
      await mod.as.mutation(api.waterBodies.merge, {
        survivorId: ids[4 + i] as Id<'waterBodies'>,
        loserId: ids[i] as Id<'waterBodies'>,
      });
    }
    const worst = await bytesOf('Twin Pond');
    // Recorded for the PR: the reads are the same page plus at most eight survivors.
    console.log(`search bytes read: before ${base.bytes}, worst case after ${worst.bytes}`);
    expect(base.hits).toBe(2);
    expect(worst.hits).toBeGreaterThan(0);
    // Bounded: the page the index returns (four times the limit) plus the survivor reads.
    expect(worst.bytes).toBeLessThan(base.bytes * (1 + 4 / 8) * 1.1);
  });
});
