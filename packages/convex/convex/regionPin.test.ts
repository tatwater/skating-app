/**
 * A moderator's pinned towns (B01-3g, D266): the founder's determination outranks the shoreline rule.
 * Set and cleared through one audited, undoable, whole-list write; listed by the facts whatever the
 * rule says; respected by the import; moved by a merge; left by a removal; and written by nothing else.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { syncAdminAreaCells } from './lib/cellIndex';
import { undoState } from './lib/undo';
import schema from './schema';
import { MAX_MODERATOR_TOWNS } from './waterBodies';

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
    await admin.as.mutation(api.waterBodies.setModeratorTowns, { waterBodyId: id, townKeys: [] });
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

  test('a merge folds the loser’s pins into the survivor, within the cap; the loser carries none', async () => {
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
      .filter(({ l }) => /moderatorTownKeys\s*:/.test(l) && !/metadata:|v\.optional/.test(l));
    expect(pinWrites).toHaveLength(3);
    for (const { i } of pinWrites) {
      expect(source.slice(i - 2, i + 3).join('\n')).toMatch(/regionStatesFields\(/);
    }
  });
});
