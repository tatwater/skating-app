/**
 * A moderator's pinned towns (B01-3g, D266): the founder's determination outranks the shoreline rule.
 * Set and cleared through one audited, undoable, whole-list write; listed by the facts whatever the
 * rule says; respected by the import; moved by a merge; left by a removal; and written by nothing else.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIT_REASON_MAX,
  AUDIT_REASON_TOO_LONG,
  bodySearchTextFor,
  MAX_REFERENCE_LINKS,
} from '@skating/core';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import type { Polygon } from 'geojson';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { PLACES_RULE, pinnedFactsFor, placesOf } from './lib/bodyGeo';
import { syncAdminAreaCells } from './lib/cellIndex';
import { undoState } from './lib/undo';
import schema from './schema';
import { MAX_MODERATOR_ALIASES, MAX_MODERATOR_TOWNS } from './waterBodies';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.UTC(2027, 0, 15, 12);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

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

function rect(x0: number, y0: number, x1: number, y1: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
      ],
    ],
  };
}

/** North East, NY — a town well away from the bodies, so the rule alone never places them in it. */
const NORTH_EAST = 'tiger/3602751550';
const DUTCHESS = 'tiger/36027';
const SOUTHBRIDGE = 'tiger/2502764145';

async function area(
  t: T,
  name: string,
  level: 'town' | 'county',
  state: string,
  externalId: string,
  polygon: Polygon,
): Promise<Id<'adminAreas'>> {
  return t.run(async (ctx) => {
    const ring = polygon.coordinates[0] ?? [];
    const xs = ring.map((p) => p[0] as number);
    const ys = ring.map((p) => p[1] as number);
    const bbox = {
      minLng: Math.min(...xs),
      maxLng: Math.max(...xs),
      minLat: Math.min(...ys),
      maxLat: Math.max(...ys),
    };
    const id = await ctx.db.insert('adminAreas', {
      name,
      level,
      state,
      externalId,
      polygon,
      bbox,
      centroid: { lat: bbox.minLat, lng: bbox.minLng },
      createdAt: NOW,
    });
    await syncAdminAreaCells(ctx, id, { bbox, level });
    return id;
  });
}

let seq = 0;
async function person(t: T, role: 'moderator' | 'admin' = 'admin') {
  const n = seq++;
  const subject = `pin-${n}`;
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: `Pin ${n}`,
      username: `pin-${n}`,
      dateOfBirth: Date.UTC(1990, 0, 1),
      driveTimePrefMinutes: 60,
      profileVisibility: 'public',
      notificationPrefs: NOTIF_PREFS,
      reputationPoints: 0,
      role,
      status: 'active',
      createdAt: NOW,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

/** A body through the import, in Connecticut — no loaded town holds its shore. */
const record = (externalId: string, states: string[] = []) => ({
  source: 'osm' as const,
  externalId,
  osmId: externalId,
  name: `Pond ${externalId}`,
  type: 'lakePond' as const,
  polygon: rect(-73.49, 41.99, -73.48, 42.0),
  bbox: { minLng: -73.49, maxLng: -73.48, minLat: 41.99, maxLat: 42.0 },
  centroid: { lat: 41.995, lng: -73.485 },
  surfaceAreaSqM: 500_000,
  states,
});

async function imported(t: T, externalId: string, states: string[] = ['NY']) {
  await t.mutation(internal.waterBodies.importCanonical, { bodies: [record(externalId, states)] });
  const body = (await t.run((ctx) => ctx.db.query('waterBodies').collect())).find(
    (b) => b.externalId === externalId,
  );
  if (!body) throw new Error('not imported');
  return body._id;
}

async function seedTowns(t: T) {
  await area(t, 'North East', 'town', 'NY', NORTH_EAST, rect(-73.6, 42.01, -73.5, 42.1));
  await area(t, 'Dutchess', 'county', 'NY', DUTCHESS, rect(-74, 41.5, -73.4, 42.2));
  await area(t, 'Southbridge Town', 'town', 'MA', SOUTHBRIDGE, rect(-72.1, 42.03, -72.0, 42.1));
}

const get = (t: T, id: Id<'waterBodies'>) => t.run((ctx) => ctx.db.get(id));
const recompute = (t: T) => t.action(internal.bodyGeo.computeDue, {});
/** The retire pass as the ETL script runs it: in batches, carrying the retired keys and the lists. */
async function retireInBatches(
  t: T,
  pairs: {
    survivor: { source: string; externalId: string };
    absorbed: { source: string; externalId: string };
  }[],
  batch: number,
  apply: boolean,
): Promise<{ retired: string[]; refused: string[] }> {
  const retired: string[] = [];
  const refused: string[] = [];
  let taken: {
    key: string;
    pins: string[];
    aliases: string[];
    links: { label: string; url: string }[];
  }[] = [];
  for (let i = 0; i < pairs.length; i += batch) {
    const res = await t.mutation(internal.waterBodies.retireAbsorbedBodies, {
      pairs: pairs.slice(i, i + batch),
      ...(apply ? { apply: true } : {}),
      ...(retired.length > 0 ? { alreadyRetired: retired } : {}),
      ...(taken.length > 0 ? { taken } : {}),
    });
    retired.push(...res.retiredKeys);
    taken = res.taken;
    for (const sk of res.skippedSamples) if (/pass a cap/.test(sk.why)) refused.push(sk.pair);
  }
  return { retired, refused };
}

const lastAction = (t: T, action: Doc<'moderationActions'>['action']) =>
  t.run(async (ctx) => {
    const rows = await ctx.db.query('moderationActions').order('desc').collect();
    return rows.find((r) => r.action === action) as Doc<'moderationActions'>;
  });

describe('setModeratorTowns', () => {
  test('pins loaded towns by their stable key; refuses an unknown key, a key outside the five, past the cap, and a moved list', async () => {
    const t = harness();
    await seedTowns(t);
    const admin = await person(t);
    const id = await imported(t, 'way/1');
    const set = (townKeys: string[], expected?: string[]) =>
      admin.as.mutation(api.waterBodies.setModeratorTowns, {
        waterBodyId: id,
        townKeys,
        ...(expected !== undefined ? { expected } : {}),
      });
    await expect(set(['tiger/3602799999'])).rejects.toThrow(/No loaded town/);
    await expect(set(['tiger/0900104720'])).rejects.toThrow(/not a town of a loaded state/);
    await expect(set([DUTCHESS])).rejects.toThrow(/not a town of a loaded state/);
    // A "not defined" water unit is never listed as a town, so a pin on one would vanish.
    await expect(set(['tiger/3602700000'])).rejects.toThrow(/open water between towns/);
    await expect(
      set(Array.from({ length: MAX_MODERATOR_TOWNS + 1 }, (_, i) => `tiger/36027${10000 + i}`)),
    ).rejects.toThrow(/at most 8/);
    await set([` ${NORTH_EAST} `, NORTH_EAST], []);
    expect((await get(t, id))?.moderatorTownKeys).toEqual([NORTH_EAST]);
    expect(await lastAction(t, 'set_moderator_towns')).toMatchObject({
      reason: 'Pinned in 1 town',
      metadata: { moderatorTownKeys: [NORTH_EAST], prev: { moderatorTownKeys: [] } },
    });
    // Built on a list that has since moved: refused, with the list as it stands now.
    await expect(set([SOUTHBRIDGE], [])).rejects.toMatchObject({
      data: { code: 'list_changed', current: [NORTH_EAST] },
    });
  });

  test('a pin an undo restores on a "not defined" water unit is never listed as a town — its county and state still count — and towns sharing a county read it once', async () => {
    const t = harness();
    await seedTowns(t);
    const UNIT = 'tiger/3602700000';
    await area(
      t,
      'County subdivisions not defined',
      'town',
      'NY',
      UNIT,
      rect(-73.7, 42.0, -73.6, 42.1),
    );
    const OTHER = 'tiger/3602751551';
    await area(t, 'Amenia', 'town', 'NY', OTHER, rect(-73.6, 41.9, -73.5, 42.0));
    const facts = await t.run((ctx) => pinnedFactsFor(ctx, [UNIT, NORTH_EAST, OTHER]));
    expect(facts.pinnedTowns.map((p) => p.county)).toEqual(['Dutchess', 'Dutchess', 'Dutchess']);
    const geo = placesOf({
      _id: 'f',
      _creationTime: 0,
      waterBodyId: 'b',
      placesRule: PLACES_RULE,
      computedAt: NOW,
      towns: [],
      townStates: [],
      townIds: [],
      townEntries: [],
      counties: [],
      states: [],
      ...facts,
    } as unknown as Doc<'bodyGeoFacts'>);
    expect(geo).toMatchObject({
      towns: ['North East', 'Amenia'],
      counties: ['Dutchess'],
      states: ['NY'],
    });
    expect(geo?.townEntries?.map((e) => e.name)).toEqual(['North East', 'Amenia']);
  });

  test('a pin write that removes any pin asks why — trimmed, capped, audited; one that only adds is defaulted and marked so', async () => {
    const t = harness();
    await seedTowns(t);
    const admin = await person(t);
    const id = await imported(t, 'way/1');
    const set = (townKeys: string[], reason?: string) =>
      admin.as.mutation(api.waterBodies.setModeratorTowns, {
        waterBodyId: id,
        townKeys,
        ...(reason !== undefined ? { reason } : {}),
      });
    // Only adding: no reason needed; the default is recorded and marked defaulted.
    await set([NORTH_EAST, SOUTHBRIDGE]);
    expect(await lastAction(t, 'set_moderator_towns')).toMatchObject({
      reason: 'Pinned in 2 towns',
      metadata: { reasonDefaulted: true },
    });
    // Adding with a reason: kept, trimmed, not defaulted.
    await set([NORTH_EAST, SOUTHBRIDGE], '  Public launch on the in-state shore  ');
    const given = await lastAction(t, 'set_moderator_towns');
    expect(given.reason).toBe('Public launch on the in-state shore');
    expect(given.metadata.reasonDefaulted).toBeUndefined();
    // Removing one pin without a reason (or with only spaces) is refused, as every takeaway is.
    await expect(set([NORTH_EAST])).rejects.toThrow('A reason is required');
    await expect(set([NORTH_EAST], '   ')).rejects.toThrow('A reason is required');
    await expect(set([NORTH_EAST], 'x'.repeat(AUDIT_REASON_MAX + 1))).rejects.toThrow(
      AUDIT_REASON_TOO_LONG,
    );
    expect((await get(t, id))?.moderatorTownKeys).toEqual([NORTH_EAST, SOUTHBRIDGE]);
    await set([NORTH_EAST], 'Southbridge holds none of the shore');
    expect(await lastAction(t, 'set_moderator_towns')).toMatchObject({
      reason: 'Southbridge holds none of the shore',
      metadata: {
        moderatorTownKeys: [NORTH_EAST],
        prev: { moderatorTownKeys: [NORTH_EAST, SOUTHBRIDGE] },
      },
    });
    // Its undo puts Southbridge back — a give, so it asks no reason; undoing that removes it again
    // — a takeaway, so it does.
    const removal = await lastAction(t, 'set_moderator_towns');
    const stateOf = (row: Doc<'moderationActions'>) =>
      t.run(async (ctx) => {
        const viewer = await ctx.db.get(admin.id);
        const fresh = await ctx.db.get(row._id);
        if (!viewer || !fresh) throw new Error('missing');
        return undoState(ctx, viewer, fresh);
      });
    expect(await stateOf(removal)).toMatchObject({ state: 'available', needsReason: false });
    await admin.as.mutation(api.undo.run, { actionId: removal._id });
    expect((await get(t, id))?.moderatorTownKeys).toEqual([NORTH_EAST, SOUTHBRIDGE]);
    expect(await stateOf(await lastAction(t, 'set_moderator_towns'))).toMatchObject({
      state: 'available',
      needsReason: true,
    });
  });

  test('an undo offered without a reason runs even when the row’s reason sits at the cap — the cap is on the person’s words, not the undo’s', async () => {
    const t = harness();
    await seedTowns(t);
    const admin = await person(t);
    const id = await imported(t, 'way/1');
    await admin.as.mutation(api.waterBodies.setModeratorTowns, {
      waterBodyId: id,
      townKeys: [NORTH_EAST, SOUTHBRIDGE],
    });
    await admin.as.mutation(api.waterBodies.setModeratorTowns, {
      waterBodyId: id,
      townKeys: [NORTH_EAST],
      reason: 'x'.repeat(AUDIT_REASON_MAX),
    });
    // The undo only adds, so it asks none; its own reason quotes the row's, past the cap.
    await admin.as.mutation(api.undo.run, {
      actionId: (await lastAction(t, 'set_moderator_towns'))._id,
    });
    expect((await get(t, id))?.moderatorTownKeys).toEqual([NORTH_EAST, SOUTHBRIDGE]);
  });

  test('a Bodies write accepted with the person’s words at or near the cap has an undo that runs — never refused for length', async () => {
    // A pin's removal (its reason) and a body's removal (its note): each undo gives back, so it asks
    // no reason, and its own line quotes the row's — composed, so shortened rather than refused.
    const check = async (write: 'unpin' | 'remove', length: number) => {
      const t = harness();
      await seedTowns(t);
      const admin = await person(t);
      const id = await imported(t, 'way/1');
      const words = 'w'.repeat(length);
      let action: Doc<'moderationActions'>['action'];
      if (write === 'unpin') {
        await admin.as.mutation(api.waterBodies.setModeratorTowns, {
          waterBodyId: id,
          townKeys: [NORTH_EAST, SOUTHBRIDGE],
        });
        await admin.as.mutation(api.waterBodies.setModeratorTowns, {
          waterBodyId: id,
          townKeys: [NORTH_EAST],
          reason: words,
        });
        action = 'set_moderator_towns';
      } else {
        await admin.as.mutation(api.waterBodies.remove, {
          waterBodyId: id,
          reason: 'other',
          note: words,
        });
        action = 'remove';
      }
      const row = await lastAction(t, action);
      await admin.as.mutation(api.undo.run, { actionId: row._id });
      const after = await get(t, id);
      if (write === 'unpin') expect(after?.moderatorTownKeys).toEqual([NORTH_EAST, SOUTHBRIDGE]);
      else expect(after?.removedAt).toBeUndefined();
    };
    const near = fc.asyncProperty(
      fc.constantFrom('unpin' as const, 'remove' as const),
      fc.integer({ min: AUDIT_REASON_MAX - 40, max: AUDIT_REASON_MAX }),
      check,
    );
    // Pinned seeds, so a failure replays; then one run on a fresh seed.
    for (const seed of [20261116, 9]) await fc.assert(near, { seed, numRuns: 3 });
    await fc.assert(near, { numRuns: 2 });
    // The cap itself, for each write.
    await check('unpin', AUDIT_REASON_MAX);
    await check('remove', AUDIT_REASON_MAX);
  });

  test('a pin reaches every reader at once — the body’s states, skater search, the library, the facts — and its clear takes back only what it added (Greptile on #130)', async () => {
    const t = harness();
    await seedTowns(t);
    const admin = await person(t);
    // The rule says New York; nothing holds its shore in any loaded town here.
    const id = await imported(t, 'way/1', ['NY']);
    await recompute(t);
    expect(await admin.as.query(api.bodyConsole.places, { waterBodyId: id })).toMatchObject({
      towns: [],
      states: [],
    });
    await admin.as.mutation(api.waterBodies.setModeratorTowns, {
      waterBodyId: id,
      townKeys: [NORTH_EAST, SOUTHBRIDGE],
    });
    // No recompute: every reader has it in the write's own transaction.
    expect(await get(t, id)).toMatchObject({ states: ['MA', 'NY'], regionStates: ['NY'] });
    const hit = (await t.query(api.waterBodies.searchByName, { query: 'Pond way' })).find(
      (h) => h._id === id,
    );
    expect(hit?.states).toEqual(['MA', 'NY']);
    const scopes = await t.run(async (ctx) =>
      (
        await ctx.db
          .query('bodyLibraryRows')
          .withIndex('by_body', (q) => q.eq('waterBodyId', id))
          .collect()
      ).map((r) => r.scope),
    );
    expect(scopes).toEqual(expect.arrayContaining(['MA', 'NY']));
    expect(await admin.as.query(api.bodyConsole.places, { waterBodyId: id })).toMatchObject({
      towns: ['North East', 'Southbridge Town'],
      counties: ['Dutchess'],
      states: ['MA', 'NY'],
      pinned: [
        { name: 'North East', state: 'NY' },
        { name: 'Southbridge Town', state: 'MA' },
      ],
      pinnedMissing: [],
    });
    // A recompute rebuilds both halves and changes nothing a reader sees.
    await t.run((ctx) =>
      ctx.db
        .query('bodyGeoFacts')
        .withIndex('by_body', (q) => q.eq('waterBodyId', id))
        .first()
        .then((r) => (r ? ctx.db.patch(r._id, { staleAt: NOW }) : undefined)),
    );
    await recompute(t);
    expect((await admin.as.query(api.bodyConsole.places, { waterBodyId: id }))?.towns).toEqual([
      'North East',
      'Southbridge Town',
    ]);
    // Clearing the pins takes back Massachusetts and leaves the rule's New York.
    await admin.as.mutation(api.waterBodies.setModeratorTowns, {
      waterBodyId: id,
      townKeys: [],
      reason: 'Pinned by mistake',
    });
    expect(await get(t, id)).toMatchObject({ states: ['NY'], regionStates: ['NY'] });
    expect(await admin.as.query(api.bodyConsole.places, { waterBodyId: id })).toMatchObject({
      towns: [],
      pinned: [],
    });
    // Its undo puts the pins, and the state they add, back at once.
    await admin.as.mutation(api.undo.run, {
      actionId: (await lastAction(t, 'set_moderator_towns'))._id,
    });
    expect((await get(t, id))?.states).toEqual(['MA', 'NY']);
    expect(
      (await admin.as.query(api.bodyConsole.places, { waterBodyId: id }))?.pinned,
    ).toHaveLength(2);
  });

  test('a boundary reload keeps the pin on the same town; a town that is gone is shown missing, never dropped or thrown on', async () => {
    const t = harness();
    await seedTowns(t);
    const admin = await person(t);
    const id = await imported(t, 'way/1');
    await admin.as.mutation(api.waterBodies.setModeratorTowns, {
      waterBodyId: id,
      townKeys: [NORTH_EAST, SOUTHBRIDGE],
    });
    // The loader re-imports North East, redrawn: same key, same document.
    await t.mutation(internal.adminAreas.importCanonical, {
      areas: [
        {
          externalId: NORTH_EAST,
          name: 'North East',
          level: 'town',
          state: 'NY',
          polygon: rect(-73.61, 42.01, -73.5, 42.11),
          bbox: { minLng: -73.61, maxLng: -73.5, minLat: 42.01, maxLat: 42.11 },
          centroid: { lat: 42.05, lng: -73.55 },
        },
      ],
    });
    // Southbridge leaves the layer.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('adminAreas')
        .withIndex('by_external_id', (q) => q.eq('externalId', SOUTHBRIDGE))
        .first();
      if (row) await ctx.db.delete(row._id);
    });
    await t.run((ctx) =>
      ctx.db
        .query('bodyGeoFacts')
        .withIndex('by_body', (q) => q.eq('waterBodyId', id))
        .first()
        .then((r) => (r ? ctx.db.patch(r._id, { staleAt: NOW }) : undefined)),
    );
    expect(await recompute(t)).toMatchObject({ computed: 1, failed: 0 });
    expect((await get(t, id))?.moderatorTownKeys).toEqual([NORTH_EAST, SOUTHBRIDGE]);
    expect(await admin.as.query(api.bodyConsole.places, { waterBodyId: id })).toMatchObject({
      towns: ['North East'],
      pinnedMissing: [SOUTHBRIDGE],
    });
  });

  test('undone through the same write — the clear asks a reason — and never offered once the list moved', async () => {
    const t = harness();
    await seedTowns(t);
    const admin = await person(t);
    const id = await imported(t, 'way/1');
    await admin.as.mutation(api.waterBodies.setModeratorTowns, {
      waterBodyId: id,
      townKeys: [NORTH_EAST],
    });
    const first = await lastAction(t, 'set_moderator_towns');
    const stateOf = (row: Doc<'moderationActions'>) =>
      t.run(async (ctx) => {
        const viewer = await ctx.db.get(admin.id);
        const fresh = await ctx.db.get(row._id);
        if (!viewer || !fresh) throw new Error('missing');
        return undoState(ctx, viewer, fresh);
      });
    // Undoing the first pin clears it: a takeaway, so it asks a reason.
    expect(await stateOf(first)).toMatchObject({ state: 'available', needsReason: true });
    await admin.as.mutation(api.undo.run, { actionId: first._id, reason: 'Pinned by mistake' });
    expect((await get(t, id))?.moderatorTownKeys).toBeUndefined();
    // Its undo pins again, and asks none.
    const clear = await lastAction(t, 'set_moderator_towns');
    expect(await stateOf(clear)).toMatchObject({ state: 'available', needsReason: false });
    await admin.as.mutation(api.undo.run, { actionId: clear._id });
    expect((await get(t, id))?.moderatorTownKeys).toEqual([NORTH_EAST]);
    // A merge folds a loser's pins into this body with no row of its own on it: the list the undo
    // would put back no longer follows, so the undo is not offered.
    const repin = await lastAction(t, 'set_moderator_towns');
    const loser = await imported(t, 'way/2');
    await admin.as.mutation(api.waterBodies.setModeratorTowns, {
      waterBodyId: loser,
      townKeys: [SOUTHBRIDGE],
    });
    await t.run((ctx) => ctx.db.patch(loser, { dedupStatus: 'near_certain' }));
    await admin.as.mutation(api.waterBodies.merge, { survivorId: id, loserId: loser });
    expect((await get(t, id))?.moderatorTownKeys).toEqual([NORTH_EAST, SOUTHBRIDGE]);
    expect(await stateOf(repin)).toMatchObject({
      state: 'unavailable',
      why: expect.stringMatching(/pinned towns/),
    });
  });
});

describe('the pin against the other writers', () => {
  test('the import adds a pinned body’s states, never reads it as out of region, and never writes the pin', async () => {
    const t = harness();
    await seedTowns(t);
    const admin = await person(t);
    const id = await imported(t, 'way/1');
    await admin.as.mutation(api.waterBodies.setModeratorTowns, {
      waterBodyId: id,
      townKeys: [NORTH_EAST, SOUTHBRIDGE],
    });
    // The rule now places it in no town: kept in region by the pin, not surfaced.
    const res = await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [record('way/1', [])],
    });
    expect(res).toMatchObject({
      outOfRegion: 0,
      outOfRegionKept: 0,
      keptByPin: 1,
      outsideRegion: [],
    });
    expect(await get(t, id)).toMatchObject({
      states: ['MA', 'NY'],
      // No town holds its shore: the stored rule half stands, as for any stored body.
      regionStates: ['NY'],
      moderatorTownKeys: [NORTH_EAST, SOUTHBRIDGE],
    });
    // A rule answer is unioned with the pins.
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [record('way/1', ['VT'])] });
    expect((await get(t, id))?.states).toEqual(['MA', 'NY', 'VT']);
    // The recompute and the drift repair leave it alone too.
    await recompute(t);
    await t.mutation(internal.bodyGeo.repairDrift, {});
    expect((await get(t, id))?.moderatorTownKeys).toEqual([NORTH_EAST, SOUTHBRIDGE]);
  });

  test('a merge folds the loser’s pins into the survivor; the loser carries none', async () => {
    const t = harness();
    await seedTowns(t);
    const admin = await person(t);
    const survivor = await imported(t, 'way/1');
    const loser = await imported(t, 'way/2');
    await admin.as.mutation(api.waterBodies.setModeratorTowns, {
      waterBodyId: survivor,
      townKeys: [NORTH_EAST],
    });
    await admin.as.mutation(api.waterBodies.setModeratorTowns, {
      waterBodyId: loser,
      townKeys: [SOUTHBRIDGE, NORTH_EAST],
    });
    await t.run((ctx) => ctx.db.patch(loser, { dedupStatus: 'near_certain' }));
    await admin.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    expect((await get(t, survivor))?.moderatorTownKeys).toEqual([NORTH_EAST, SOUTHBRIDGE]);
    // The state the loser's pin added comes with it, at once.
    expect((await get(t, survivor))?.states).toEqual(['MA', 'NY']);
    expect((await get(t, loser))?.moderatorTownKeys).toBeUndefined();
    expect((await get(t, loser))?.states).toEqual(['NY']);
    const merge = await lastAction(t, 'merge_waterbody');
    const snap = await t.run((ctx) =>
      ctx.db
        .query('auditSnapshots')
        .withIndex('by_action', (q) => q.eq('actionId', merge._id))
        .first(),
    );
    expect(JSON.stringify(snap ?? {})).toContain('pinsBefore');
  });

  test('a merge that cannot hold both bodies’ pins is refused, with a sentence, and changes nothing (Greptile on #130)', async () => {
    const t = harness();
    await seedTowns(t);
    const admin = await person(t);
    const survivor = await imported(t, 'way/1');
    const loser = await imported(t, 'way/2');
    const keys = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => `tiger/36027${String(10_000 + from + i)}`);
    // Pinned directly: the keys stand for nine distinct towns between them.
    await t.run(async (ctx) => {
      await ctx.db.patch(survivor, { moderatorTownKeys: keys(0, 6) });
      await ctx.db.patch(loser, { moderatorTownKeys: keys(6, 3), dedupStatus: 'near_certain' });
    });
    await expect(
      admin.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser }),
    ).rejects.toThrow(
      /together the bodies hold 9 pinned towns, more than the 8 one body can\. Clear some first\./,
    );
    expect((await get(t, survivor))?.moderatorTownKeys).toEqual(keys(0, 6));
    expect(await get(t, loser)).toMatchObject({
      moderatorTownKeys: keys(6, 3),
      dedupStatus: 'near_certain',
    });
    // The automated merge skips the pair and names it; the batch goes on.
    const res = await t.mutation(internal.waterBodies.retireAbsorbedBodies, {
      pairs: [
        {
          survivor: { source: 'osm', externalId: 'way/1' },
          absorbed: { source: 'osm', externalId: 'way/2' },
        },
      ],
      apply: true,
    });
    expect(res).toMatchObject({
      retired: 0,
      skippedSamples: [{ why: expect.stringMatching(/a person merges them/) }],
    });
    expect((await get(t, loser))?.dedupStatus).toBe('near_certain');
  });

  test('the import’s dry run predicts its apply when one survivor takes two rows that fit only one at a time', async () => {
    const t = harness();
    const keys = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => `tiger/36027${String(10_000 + from + i)}`);
    const survivor = await imported(t, 'way/1');
    const first = await imported(t, 'way/2');
    const second = await imported(t, 'way/3');
    // 4 + 3 fits, 4 + 3 + 3 doesn't.
    await t.run(async (ctx) => {
      await ctx.db.patch(survivor, { moderatorTownKeys: keys(0, 4) });
      await ctx.db.patch(first, { moderatorTownKeys: keys(4, 3) });
      await ctx.db.patch(second, { moderatorTownKeys: keys(7, 3) });
    });
    const pairs = ['way/2', 'way/3'].map((externalId) => ({
      survivor: { source: 'osm', externalId: 'way/1' },
      absorbed: { source: 'osm', externalId },
    }));
    const dry = await t.mutation(internal.waterBodies.retireAbsorbedBodies, { pairs });
    const applied = await t.mutation(internal.waterBodies.retireAbsorbedBodies, {
      pairs,
      apply: true,
    });
    for (const res of [dry, applied]) {
      expect(res).toMatchObject({
        retired: 1,
        retiredKeys: ['osm:way/2'],
        skippedSamples: [{ pair: expect.stringContaining('way/3'), why: expect.any(String) }],
      });
    }
    expect((await get(t, survivor))?.moderatorTownKeys).toEqual(keys(0, 7));
    expect((await get(t, second))?.moderatorTownKeys).toEqual(keys(7, 3));
  });

  test('a merge carries the loser’s aliases and reference links too: the survivor holds both bodies’ lists', async () => {
    const t = harness();
    await seedTowns(t);
    const admin = await person(t);
    const survivor = await imported(t, 'way/1');
    const loser = await imported(t, 'way/2');
    await t.run(async (ctx) => {
      await ctx.db.patch(survivor, {
        moderatorAliases: ['The Mirror'],
        referenceLinks: [{ label: 'Association', url: 'https://example.org/a' }],
      });
      await ctx.db.patch(loser, {
        moderatorAliases: ['the mirror', 'Glass Pond'],
        referenceLinks: [
          { label: 'Same', url: 'https://example.org/a' },
          { label: 'Town page', url: 'https://example.org/b' },
        ],
        dedupStatus: 'near_certain',
      });
    });
    await admin.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    // Its search text carries the alias it took, in the merge's own transaction.
    expect((await get(t, survivor))?.searchText.toLowerCase()).toContain('glass pond');
    // The alias moved: off the tombstone, so a moderator who removes it from the survivor removes it.
    expect((await get(t, loser))?.moderatorAliases).toBeUndefined();
    expect((await get(t, loser))?.searchText.toLowerCase()).not.toContain('glass pond');
    expect(await get(t, survivor)).toMatchObject({
      moderatorAliases: ['The Mirror', 'Glass Pond'],
      referenceLinks: [
        { label: 'Association', url: 'https://example.org/a' },
        { label: 'Town page', url: 'https://example.org/b' },
      ],
    });
  });

  test('property: no merge, by hand or by import, ends with less than the union of both bodies’ lists — and a refused one writes nothing', async () => {
    const side = fc.record({
      pins: fc.uniqueArray(fc.integer({ min: 0, max: 11 }), { maxLength: 6 }),
      aliases: fc.uniqueArray(fc.integer({ min: 0, max: 30 }), { maxLength: 12 }),
      links: fc.uniqueArray(fc.integer({ min: 0, max: 11 }), { maxLength: 5 }),
    });
    const prop = fc.asyncProperty(side, side, fc.boolean(), async (s, l, byImport) => {
      const t = harness();
      const admin = await person(t);
      const survivor = await imported(t, 'way/1');
      const loser = await imported(t, 'way/2');
      const lists = (x: typeof s) => ({
        moderatorTownKeys: x.pins.map((n) => `tiger/36027${String(10_000 + n)}`),
        moderatorAliases: x.aliases.map((n) => `Alias ${n}`),
        referenceLinks: x.links.map((n) => ({ label: `L${n}`, url: `https://example.org/${n}` })),
      });
      await t.run(async (ctx) => {
        await ctx.db.patch(survivor, lists(s));
        await ctx.db.patch(loser, { ...lists(l), dedupStatus: 'near_certain' });
        // Each body's search text with its aliases, as `setAliases` keeps it.
        for (const id of [survivor, loser]) {
          const doc = await ctx.db.get(id);
          if (doc) await ctx.db.patch(id, { searchText: bodySearchTextFor(doc) });
        }
      });
      const before = await t.run(async (ctx) => [
        await ctx.db.get(survivor),
        await ctx.db.get(loser),
      ]);
      let merged: boolean;
      if (byImport) {
        const res = await t.mutation(internal.waterBodies.retireAbsorbedBodies, {
          pairs: [
            {
              survivor: { source: 'osm', externalId: 'way/1' },
              absorbed: { source: 'osm', externalId: 'way/2' },
            },
          ],
          apply: true,
        });
        merged = res.retired === 1;
      } else {
        merged = await admin.as
          .mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser })
          .then(() => true)
          // Only the cap's refusal counts as a refusal: any other error fails the property.
          .catch((e: unknown) => {
            expect(String(e)).toMatch(/Can't merge into .*Clear some first\./);
            return false;
          });
      }
      const union = (pick: (x: ReturnType<typeof lists>) => unknown[], key: (v: never) => string) =>
        new Set([...pick(lists(s)), ...pick(lists(l))].map((v) => key(v as never)));
      const pins = union(
        (x) => x.moderatorTownKeys,
        (k: string) => k,
      );
      const aliases = union(
        (x) => x.moderatorAliases,
        (a: string) => a.toLowerCase(),
      );
      const links = union(
        (x) => x.referenceLinks,
        (x: { url: string }) => x.url,
      );
      // A merge happens exactly when every union fits its cap — never refused short of one.
      expect(merged).toBe(
        pins.size <= MAX_MODERATOR_TOWNS &&
          aliases.size <= MAX_MODERATOR_ALIASES &&
          links.size <= MAX_REFERENCE_LINKS,
      );
      const after = await t.run(async (ctx) => [
        await ctx.db.get(survivor),
        await ctx.db.get(loser),
      ]);
      if (merged) {
        const got = after[0] as Doc<'waterBodies'>;
        expect(new Set(got.moderatorTownKeys ?? [])).toEqual(pins);
        expect(new Set((got.moderatorAliases ?? []).map((a) => a.toLowerCase()))).toEqual(aliases);
        expect(new Set((got.referenceLinks ?? []).map((x) => x.url))).toEqual(links);
        // Findable by every alias it now holds: its search text rebuilt in the merge's transaction.
        expect(got.searchText).toBe(bodySearchTextFor(got));
      } else {
        // Refused by hand: neither body changed at all. Skipped by the import: the same, except the
        // pair now waits in the duplicate queue for a person.
        const listsOf = (b: Doc<'waterBodies'> | null) => ({
          pins: b?.moderatorTownKeys,
          aliases: b?.moderatorAliases,
          links: b?.referenceLinks,
          states: b?.states,
          merged: b?.mergedIntoId,
        });
        if (byImport) {
          expect(after.map(listsOf)).toEqual(before.map(listsOf));
          expect(after.map((b) => b?.dedupStatus)).toEqual(['near_certain', 'near_certain']);
        } else {
          expect(after).toEqual(before);
        }
      }
    });
    for (const seed of [7, 2026]) await fc.assert(prop, { seed, numRuns: 6 });
    await fc.assert(prop, { numRuns: 6 });
  });

  test('a merge that changes the survivor’s aliases or links takes back their older undo, which would be refused', async () => {
    const t = harness();
    const admin = await person(t);
    const survivor = await imported(t, 'way/1');
    const loser = await imported(t, 'way/2');
    await admin.as.mutation(api.waterBodies.setAliases, {
      waterBodyId: survivor,
      aliases: ['The Mirror'],
    });
    await admin.as.mutation(api.waterBodies.setReferenceLinks, {
      waterBodyId: survivor,
      links: [{ label: 'Association', url: 'https://example.org/a' }],
    });
    const aliasRow = await lastAction(t, 'set_aliases');
    const linkRow = await lastAction(t, 'set_reference_links');
    const stateOf = (row: Doc<'moderationActions'>) =>
      t.run(async (ctx) => {
        const viewer = await ctx.db.get(admin.id);
        const fresh = await ctx.db.get(row._id);
        if (!viewer || !fresh) throw new Error('missing');
        return undoState(ctx, viewer, fresh);
      });
    expect(await stateOf(linkRow)).toMatchObject({ state: 'available' });
    await t.run((ctx) =>
      ctx.db.patch(loser, {
        moderatorAliases: ['Glass Pond'],
        referenceLinks: [{ label: 'Town page', url: 'https://example.org/b' }],
        dedupStatus: 'near_certain',
      }),
    );
    await admin.as.mutation(api.waterBodies.merge, { survivorId: survivor, loserId: loser });
    // The merge's row is on the loser, so neither older row is overtaken: the refusal answers.
    expect(await stateOf(aliasRow)).toMatchObject({
      state: expect.stringMatching(/unavailable|overtaken/),
    });
    expect(await stateOf(linkRow)).toMatchObject({
      state: 'unavailable',
      why: expect.stringMatching(/reference links/),
    });
  });

  test('the dry run predicts the apply across batch boundaries (Greptile on #130)', async () => {
    // A survivor at four pins absorbing two bodies of three distinct pins each, one pair a batch:
    // only one can merge, in the dry run as in the apply.
    const t = harness();
    const s = await imported(t, 'way/1');
    const a = await imported(t, 'way/2');
    const b = await imported(t, 'way/3');
    const keys = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => `tiger/36027${String(10_000 + from + i)}`);
    await t.run(async (ctx) => {
      await ctx.db.patch(s, { moderatorTownKeys: keys(0, 4) });
      await ctx.db.patch(a, { moderatorTownKeys: keys(4, 3) });
      await ctx.db.patch(b, { moderatorTownKeys: keys(7, 3) });
    });
    const pairs = [
      {
        survivor: { source: 'osm', externalId: 'way/1' },
        absorbed: { source: 'osm', externalId: 'way/2' },
      },
      {
        survivor: { source: 'osm', externalId: 'way/1' },
        absorbed: { source: 'osm', externalId: 'way/3' },
      },
    ];
    expect((await retireInBatches(t, pairs, 1, false)).retired).toEqual(['osm:way/2']);
    expect((await retireInBatches(t, pairs, 1, true)).retired).toEqual(['osm:way/2']);
  });

  test('the dry run predicts the apply through a chain: a survivor absorbed earlier in the pass takes nothing more, and an alias matching a body’s own name is dropped as the merge drops it', async () => {
    const pond = (n: number) => ({ source: 'osm', externalId: `way/${n}` });
    for (const batch of [1, 2, 3]) {
      // Body 1 folds into 0, then 2 into 1 — which the apply has tombstoned by then.
      const t = harness();
      for (const n of [0, 1, 2]) await imported(t, `way/${n}`);
      const pairs = [
        { survivor: pond(0), absorbed: pond(1) },
        { survivor: pond(1), absorbed: pond(2) },
      ];
      const dry = await retireInBatches(t, pairs, batch, false);
      expect(dry.retired).toEqual(['osm:way/1']);
      expect((await retireInBatches(t, pairs, batch, true)).retired).toEqual(dry.retired);
    }
    for (const batch of [1, 2]) {
      // Body 1 takes body 2's alias for its own name, which the merge drops; body 0, at the alias cap,
      // then takes body 1 with nothing new.
      const t = harness();
      const s = await imported(t, 'way/0');
      await imported(t, 'way/1');
      const b = await imported(t, 'way/2');
      await t.run(async (ctx) => {
        await ctx.db.patch(s, {
          moderatorAliases: Array.from({ length: MAX_MODERATOR_ALIASES }, (_, i) => `Alias ${i}`),
        });
        await ctx.db.patch(b, { moderatorAliases: ['pond way/1'] });
      });
      const pairs = [
        { survivor: pond(1), absorbed: pond(2) },
        { survivor: pond(0), absorbed: pond(1) },
      ];
      const dry = await retireInBatches(t, pairs, batch, false);
      expect(dry).toEqual({ retired: ['osm:way/2', 'osm:way/1'], refused: [] });
      expect(await retireInBatches(t, pairs, batch, true)).toEqual(dry);
    }
  });

  test('property: for any pairs — chains and cycles too — lists and batch size, the dry run’s merged and refused sets equal the apply’s', async () => {
    const BODIES = 6;
    const prop = fc.asyncProperty(
      fc.array(
        fc.record({
          pins: fc.uniqueArray(fc.integer({ min: 0, max: 9 }), { maxLength: 5 }),
          // Some aliases are another body's name, which a merge into that body drops.
          aliases: fc.uniqueArray(fc.integer({ min: 0, max: 30 + BODIES - 1 }), { maxLength: 12 }),
        }),
        { minLength: BODIES, maxLength: BODIES },
      ),
      fc.array(
        fc.tuple(fc.integer({ min: 0, max: BODIES - 1 }), fc.integer({ min: 0, max: BODIES - 1 })),
        { minLength: 2, maxLength: 6 },
      ),
      fc.integer({ min: 1, max: 4 }),
      async (lists, drawn, batch) => {
        const t = harness();
        const ids: Id<'waterBodies'>[] = [];
        for (let i = 0; i < BODIES; i++) ids.push(await imported(t, `way/${i}`));
        await t.run(async (ctx) => {
          for (const [i, l] of lists.entries()) {
            await ctx.db.patch(ids[i] as Id<'waterBodies'>, {
              moderatorTownKeys: l.pins.map((n) => `tiger/36027${String(10_000 + n)}`),
              // Never the body's own name: the aliases writer refuses that.
              moderatorAliases: l.aliases
                .filter((n) => n !== 30 + i)
                .map((n) => (n >= 30 ? `Pond way/${n - 30}` : `Alias ${n}`)),
            });
          }
        });
        const pairs = drawn.map(([si, ai]) => ({
          survivor: { source: 'osm', externalId: `way/${si}` },
          absorbed: { source: 'osm', externalId: `way/${ai}` },
        }));
        const dry = await retireInBatches(t, pairs, batch, false);
        const applied = await retireInBatches(t, pairs, batch, true);
        expect(dry.retired.sort()).toEqual(applied.retired.sort());
        expect(dry.refused.sort()).toEqual(applied.refused.sort());
      },
    );
    for (const seed of [11, 2027]) await fc.assert(prop, { seed, numRuns: 6 });
    await fc.assert(prop, { numRuns: 6 });
  });

  test('a removal leaves the pin, so undoing the removal brings the body back pinned', async () => {
    const t = harness();
    await seedTowns(t);
    const admin = await person(t);
    const id = await imported(t, 'way/1');
    await admin.as.mutation(api.waterBodies.setModeratorTowns, {
      waterBodyId: id,
      townKeys: [NORTH_EAST],
    });
    await admin.as.mutation(api.waterBodies.remove, { waterBodyId: id, reason: 'other' });
    expect((await get(t, id))?.moderatorTownKeys).toEqual([NORTH_EAST]);
    await admin.as.mutation(api.undo.run, {
      actionId: (await lastAction(t, 'remove'))._id,
      reason: 'Removed by mistake',
    });
    expect(await get(t, id)).toMatchObject({ moderatorTownKeys: [NORTH_EAST] });
    expect((await get(t, id))?.removedAt).toBeUndefined();
  });

  test('nothing but the moderator write, its undo and a merge writes the pins — and each rebuilds the states it feeds', () => {
    // A guard over the functions' own source: any other writer of the pins, or of the rule's states
    // apart from the one builder, fails here.
    const dir = dirname(fileURLToPath(import.meta.url));
    const files = [
      ...readdirSync(dir).map((f) => f),
      ...readdirSync(join(dir, 'lib')).map((f) => `lib/${f}`),
    ].filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('_generated'));
    const writersOf = (field: string) =>
      files.filter((f) =>
        new RegExp(`\\b${field}\\s*:`).test(
          readFileSync(join(dir, f), 'utf8')
            // The schema declares the field; reads are `body.<field>`, never `<field>:`.
            .replace(new RegExp(`${field}: v\\.optional[^\\n]*`, 'g'), '')
            // An audit row's metadata names the list it records, which is no write of the field.
            .replace(new RegExp(`metadata: \\{ ${field}[^\\n]*`, 'g'), ''),
        ),
      );
    expect(writersOf('moderatorTownKeys').sort()).toEqual(['waterBodies.ts']);
    // The rule's states are written by the one builder alone.
    expect(writersOf('regionStates').sort()).toEqual(['waterBodies.ts']);
    const source = readFileSync(join(dir, 'waterBodies.ts'), 'utf8').split('\n');
    expect(source.filter((l) => /^\s+regionStates: \S/.test(l) && !/readonly/.test(l))).toEqual([
      '    regionStates: [...regionStates],',
    ]);
    // Each write of the pins rebuilds the states in the same patch: the write itself, and the merge's
    // two (the survivor's union, the loser's clear).
    const pinWrites = source
      .map((l, i) => ({ l, i }))
      .filter(
        ({ l, i }) =>
          /moderatorTownKeys\s*:/.test(l) &&
          // A schema line, an audit row's metadata, and the retire pass's in-memory list of what a
          // survivor took (no write) are not writes of the field.
          !/metadata:|v\.optional|t\?\.pins|prev: \{ moderatorTownKeys/.test(l) &&
          !/metadata: \{$/.test(source[i - 1] ?? ''),
      );
    expect(pinWrites).toHaveLength(3);
    for (const { i } of pinWrites) {
      expect(source.slice(i - 2, i + 3).join('\n')).toMatch(/regionStatesFields\(/);
    }
  });
});
