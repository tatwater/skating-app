/**
 * **When stored geometry goes stale** (B01-3b, after Greptile on #118): every input of a body's facts
 * marks them — its creation (the cell index's choke point), its outline, each outline it holds a copy
 * of (`bodyGeoLinks`, fanned out when a stamp changes), the places layer — and a drift repair catches
 * what a mark missed. The fan-out ends: a property test over random clusters drains to every held
 * ring matching the current outline, with nothing left stale, in a bounded number of recomputations.
 */

import { convexTest } from 'convex-test';
import fc from 'fast-check';
import type { Polygon } from 'geojson';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { FANOUT_INLINE } from './bodyGeo';
import { markGeoStale, outlineStamp, simplifiedRing } from './lib/bodyGeo';
import { rebuildBodyLibrary } from './lib/bodyLibrary';
import { syncWaterBodyCells } from './lib/cellIndex';
import { noteAdminAreasChanged } from './lib/geoStale';
import { demoteBody } from './lib/standing';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
const NOW = Date.UTC(2027, 0, 15, 12);
/** A square's half-side: 0.01° — two squares 0.02° apart share an edge. */
const R = 0.01;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A square at (lng, lat) whose edges carry `perEdge` points each — more points, same box. */
function square(lng: number, lat: number, perEdge = 1): Polygon {
  const corners: [number, number][] = [
    [lng - R, lat - R],
    [lng + R, lat - R],
    [lng + R, lat + R],
    [lng - R, lat + R],
  ];
  const ring: number[][] = [];
  for (let c = 0; c < 4; c++) {
    const [a, b] = [corners[c], corners[(c + 1) % 4]] as [[number, number], [number, number]];
    for (let i = 0; i < perEdge; i++) {
      const f = i / perEdge;
      ring.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    }
  }
  ring.push(ring[0] as number[]);
  return { type: 'Polygon', coordinates: [ring] };
}

const boxAt = (lng: number, lat: number) => ({
  minLng: lng - R,
  maxLng: lng + R,
  minLat: lat - R,
  maxLat: lat + R,
});

/** A listed body, indexed and in the library, the way the import leaves one. */
async function seedBody(t: T, name: string, lng: number, lat = 44): Promise<Id<'waterBodies'>> {
  return t.run(async (ctx) => {
    const bbox = boxAt(lng, lat);
    const id = await ctx.db.insert('waterBodies', {
      name,
      searchText: name,
      type: 'lakePond',
      source: 'osm',
      polygon: square(lng, lat),
      bbox,
      centroid: { lat, lng },
      states: ['VT'],
      dedupStatus: 'clean',
      createdAt: NOW,
      minVisibleZoom: 8,
      displayScore: 1,
    });
    await syncWaterBodyCells(ctx, id, { bbox, minVisibleZoom: 8, listed: true });
    await rebuildBodyLibrary(ctx, id);
    return id;
  });
}

/** Redraw a body's outline inside the same box (more points), as an import with a moved footprint. */
async function redraw(t: T, id: Id<'waterBodies'>, perEdge: number, mark = true) {
  await t.run(async (ctx) => {
    const body = await ctx.db.get(id);
    if (!body) throw new Error('no body');
    await ctx.db.patch(id, { polygon: square(body.centroid.lng, body.centroid.lat, perEdge) });
    if (mark) await markGeoStale(ctx, [id]);
  });
}

const facts = (t: T, id: Id<'waterBodies'>) =>
  t.run((ctx) =>
    ctx.db
      .query('bodyGeoFacts')
      .withIndex('by_body', (q) => q.eq('waterBodyId', id))
      .first(),
  );

/** Drain the work, scheduled fan-outs included; returns how many computations it took. */
async function drain(t: T): Promise<number> {
  let computed = 0;
  for (let i = 0; i < 20; i++) {
    const r = await t.action(internal.bodyGeo.computeDue, {});
    await t.finishAllScheduledFunctions(() => {});
    computed += r.computed;
    const stale = await t.run((ctx) =>
      ctx.db
        .query('bodyGeoFacts')
        .withIndex('by_parked_stale', (q) => q.eq('parkedAt', undefined).gt('staleAt', 0))
        .first(),
    );
    if (stale === null) return computed;
  }
  throw new Error('the work never drained');
}

/** Every held ring and stamp equals its neighbor's current outline's. */
async function heldCopiesAreCurrent(t: T): Promise<boolean> {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query('bodyGeoFacts').collect();
    for (const row of rows) {
      for (const n of row.neighbors ?? []) {
        const body = await ctx.db.get(n.waterBodyId);
        if (!body) return false;
        if (n.stamp !== outlineStamp(body)) return false;
        if (JSON.stringify(n.ring) !== JSON.stringify(simplifiedRing(body.polygon as Polygon))) {
          return false;
        }
      }
    }
    return true;
  });
}

describe('only a geometry change marks a body (B01-3c)', () => {
  test('a rollover’s demotion and a prominence change re-cell a body but mark nothing', async () => {
    const t = harness();
    const id = await seedBody(t, 'Kept Shape', -72);
    await drain(t);
    await t.run(async (ctx) => {
      const body = await ctx.db.get(id);
      if (!body) throw new Error('no body');
      // A zoom rung far from the seeded one moves the body's cells.
      await syncWaterBodyCells(ctx, id, { bbox: body.bbox, minVisibleZoom: 14, listed: true });
      await demoteBody(ctx, body, { reason: 'inactive' });
    });
    const cells = await t.run((ctx) =>
      ctx.db
        .query('waterBodyCells')
        .withIndex('by_body', (q) => q.eq('waterBodyId', id))
        .collect(),
    );
    expect(cells.every((c) => c.minVisibleZoom !== 8)).toBe(true);
    expect((await facts(t, id))?.staleAt).toBeUndefined();
  });
});

describe('every creation path marks a body’s facts', () => {
  test('a body the import inserts is owed its facts with no other write', async () => {
    const t = harness();
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [
        {
          source: 'osm',
          externalId: 'way/1',
          osmId: 'way/1',
          name: 'Imported',
          type: 'lakePond',
          polygon: square(-72, 44),
          bbox: boxAt(-72, 44),
          centroid: { lat: 44, lng: -72 },
          surfaceAreaSqM: 1_000_000,
        },
      ],
    });
    const body = (await t.run((ctx) => ctx.db.query('waterBodies').collect()))[0];
    expect((await facts(t, body?._id as Id<'waterBodies'>))?.staleAt).toEqual(expect.any(Number));
    await drain(t);
    expect((await facts(t, body?._id as Id<'waterBodies'>))?.computedAt).toBe(NOW);
  });

  test('a re-import that moves only the interior point marks the body; an unchanged one does not', async () => {
    const t = harness();
    const record = {
      source: 'osm' as const,
      externalId: 'way/1',
      osmId: 'way/1',
      name: 'Imported',
      type: 'lakePond' as const,
      polygon: square(-72, 44),
      bbox: boxAt(-72, 44),
      centroid: { lat: 44, lng: -72 },
      surfaceAreaSqM: 1_000_000,
    };
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [record] });
    await drain(t);
    const id = (await t.run((ctx) => ctx.db.query('waterBodies').collect()))[0]?._id;
    // The same record again: nothing a body's facts read moved.
    await t.mutation(internal.waterBodies.importCanonical, { bodies: [record] });
    expect((await facts(t, id as Id<'waterBodies'>))?.staleAt).toBeUndefined();
    // Only the interior point: the first town and the county are read there.
    await t.mutation(internal.waterBodies.importCanonical, {
      bodies: [{ ...record, interiorPoint: { lat: 44.005, lng: -72.005 } }],
    });
    expect((await facts(t, id as Id<'waterBodies'>))?.staleAt).toEqual(expect.any(Number));
  });
});

describe('the places layer', () => {
  const area = (name: string) => ({
    externalId: 'relation/town',
    name,
    level: 'town' as const,
    state: 'VT',
    polygon: square(-72, 44),
    bbox: boxAt(-72, 44),
    centroid: { lat: 44, lng: -72 },
  });
  const marks = (t: T) =>
    t.run(async (ctx) => (await ctx.db.query('geoInputMarks').collect()).length);

  test('an insert, a change and a delete each mark it; an unchanged re-import does not', async () => {
    const t = harness();
    await t.mutation(internal.adminAreas.importCanonical, { areas: [area('Town')] });
    expect(await marks(t)).toBe(1);
    await t.mutation(internal.adminAreas.importCanonical, { areas: [area('Town')] });
    expect(await marks(t)).toBe(1);
    await t.mutation(internal.adminAreas.importCanonical, { areas: [area('Renamed')] });
    expect(await marks(t)).toBe(2);
    await t.mutation(internal.adminAreas.deleteByExternalIds, { externalIds: ['relation/town'] });
    expect(await marks(t)).toBe(3);
    await t.mutation(internal.adminAreas.importCanonical, { areas: [area('Town')] });
    expect(await marks(t)).toBe(4);
    // Retiring the OSM-sourced rows is a delete too; a dry run writes nothing.
    await t.mutation(internal.adminAreas.retireOsmSourcedAreas, {});
    expect(await marks(t)).toBe(4);
    await t.mutation(internal.adminAreas.retireOsmSourcedAreas, { apply: true });
    expect(await marks(t)).toBe(5);
  });
});

describe('a neighbor’s outline', () => {
  test('two bodies still touching after one is redrawn: the other’s held ring follows', async () => {
    const t = harness();
    const a = await seedBody(t, 'A', -72);
    const b = await seedBody(t, 'B', -72 + 2 * R);
    await drain(t);
    expect((await facts(t, b))?.neighbors?.map((n) => n.waterBodyId)).toEqual([a]);
    await redraw(t, a, 12);
    await drain(t);
    // Still touching, so neither list moved — only the stamp did, and B was marked by it.
    const held = (await facts(t, b))?.neighbors?.[0];
    const now = await t.run((ctx) => ctx.db.get(a));
    expect(held?.stamp).toBe(outlineStamp(now as never));
    expect(held?.ring).toEqual(simplifiedRing(now?.polygon as Polygon));
  });

  test('a reshape at the same vertex count inside the same box still reaches the holders', async () => {
    const t = harness();
    const a = await seedBody(t, 'A', -72);
    await seedBody(t, 'B', -72 + 2 * R);
    await redraw(t, a, 4);
    await drain(t);
    expect(await heldCopiesAreCurrent(t)).toBe(true);
    // One mid-edge point of A's west side pulled in: same count, same box, a different shoreline.
    await t.run(async (ctx) => {
      const body = await ctx.db.get(a);
      if (!body) throw new Error('no body');
      const ring = (body.polygon as Polygon).coordinates[0] as number[][];
      const nudged = ring.map((p, i) =>
        i === 14 ? [(p[0] as number) + R / 2, p[1] as number] : p,
      );
      await ctx.db.patch(a, { polygon: { type: 'Polygon', coordinates: [nudged] } });
      await markGeoStale(ctx, [a]);
    });
    await drain(t);
    expect(await heldCopiesAreCurrent(t)).toBe(true);
  });

  test('an outline held by more bodies than the inline bound is fanned out by a chained job', async () => {
    const t = harness();
    const hub = await seedBody(t, 'Hub', -72);
    await drain(t);
    // Holders beyond the inline bound (links as their own computations would have written them).
    const holders: Id<'waterBodies'>[] = [];
    for (let i = 0; i < FANOUT_INLINE + 2; i++) holders.push(await seedBody(t, `H${i}`, -60 + i));
    await drain(t);
    const stamp = (await facts(t, hub))?.stamp as string;
    await t.run(async (ctx) => {
      for (const waterBodyId of holders) {
        await ctx.db.insert('bodyGeoLinks', { waterBodyId, neighborId: hub, neighborStamp: stamp });
      }
    });
    await redraw(t, hub, 8);
    await t.action(internal.bodyGeo.computeDue, {});
    await t.finishAllScheduledFunctions(() => {});
    for (const id of holders) expect((await facts(t, id))?.staleAt).toEqual(expect.any(Number));
  });

  test('the fan-out ends on any cluster: every held ring current, none stale, bounded work', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Up to six squares on a line, each touching the last or a gap away; some redrawn.
        fc.array(fc.record({ touches: fc.boolean(), redraw: fc.boolean() }), {
          minLength: 2,
          maxLength: 6,
        }),
        async (cells) => {
          const t = harness();
          const ids: Id<'waterBodies'>[] = [];
          let lng = -72;
          for (const [i, cell] of cells.entries()) {
            if (i > 0) lng += cell.touches ? 2 * R : 4 * R;
            ids.push(await seedBody(t, `S${i}`, lng));
          }
          await drain(t);
          for (const [i, cell] of cells.entries()) {
            if (cell.redraw) await redraw(t, ids[i] as Id<'waterBodies'>, 6 + i);
          }
          const work = await drain(t);
          expect(await heldCopiesAreCurrent(t)).toBe(true);
          // Each redrawn body once, each holder of it once, and a relation's second side: ≤ 3n.
          expect(work).toBeLessThanOrEqual(3 * cells.length);
        },
      ),
      { numRuns: 8 },
    );
  }, 180_000);
});

describe('the drift repair', () => {
  test('a row computed before towns carried their states is behind (B01-3c)', async () => {
    const t = harness();
    const old = await seedBody(t, 'Old Towns', -72);
    // Stored without them (a store from an older action, mid-deploy): empty lists beside a town.
    const bare = await seedBody(t, 'Bare Towns', -60);
    await drain(t);
    await t.run(async (ctx) => {
      const cases: [Id<'waterBodies'>, Partial<Doc<'bodyGeoFacts'>>][] = [
        [old, { townStates: undefined }],
        [bare, { townStates: [], townIds: [] }],
      ];
      for (const [id, lists] of cases) {
        const row = await ctx.db
          .query('bodyGeoFacts')
          .withIndex('by_body', (q) => q.eq('waterBodyId', id))
          .first();
        if (row) await ctx.db.patch(row._id, { towns: ['Somewhere'], ...lists });
      }
    });
    vi.setSystemTime(NOW + 1_000);
    expect(await t.mutation(internal.bodyGeo.repairDrift, {})).toMatchObject({ marked: 2 });
    expect((await facts(t, old))?.staleAt).toBe(NOW + 1_000);
    expect((await facts(t, bare))?.staleAt).toBe(NOW + 1_000);
  });

  test('finds an outline changed with no mark, a stale held copy, a newer places layer, a missing row', async () => {
    const t = harness();
    const a = await seedBody(t, 'A', -72);
    const b = await seedBody(t, 'B', -72 + 2 * R);
    const c = await seedBody(t, 'C', -60);
    await drain(t);
    // A's outline changes with no mark at all.
    vi.setSystemTime(NOW + 1_000);
    await redraw(t, a, 10, false);
    expect(await t.mutation(internal.bodyGeo.repairDrift, {})).toMatchObject({ marked: 1 });
    expect((await facts(t, a))?.staleAt).toBe(NOW + 1_000);
    await drain(t);
    expect(await heldCopiesAreCurrent(t)).toBe(true);
    // B's held copy of A falls behind with no fan-out: the repair sees it against A's answer.
    await t.run(async (ctx) => {
      const link = await ctx.db
        .query('bodyGeoLinks')
        .withIndex('by_holder', (q) => q.eq('waterBodyId', b))
        .first();
      if (link) await ctx.db.patch(link._id, { neighborStamp: 'an older outline' });
    });
    vi.setSystemTime(NOW + 2_000);
    expect(await t.mutation(internal.bodyGeo.repairDrift, {})).toMatchObject({ marked: 1 });
    expect((await facts(t, b))?.staleAt).toBe(NOW + 2_000);
    await drain(t);
    // The places layer changes: every body computed before it is behind.
    vi.setSystemTime(NOW + 3_000);
    await t.run((ctx) => noteAdminAreasChanged(ctx));
    expect(await t.mutation(internal.bodyGeo.repairDrift, {})).toMatchObject({ marked: 3 });
    await drain(t);
    expect(await t.mutation(internal.bodyGeo.repairDrift, {})).toMatchObject({ marked: 0 });
    // A body with no facts row at all is found from the library.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('bodyGeoFacts')
        .withIndex('by_body', (q) => q.eq('waterBodyId', c))
        .first();
      if (row) await ctx.db.delete(row._id);
    });
    expect(await t.mutation(internal.bodyGeo.repairMissing, {})).toMatchObject({
      marked: 1,
      isDone: true,
    });
    expect((await facts(t, c))?.staleAt).toEqual(expect.any(Number));
  });

  test('a row computed before the links and marks existed is found and recomputed', async () => {
    const t = harness();
    const a = await seedBody(t, 'A', -72);
    await drain(t);
    // As an earlier build left it: computed, never checked, no links.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('bodyGeoFacts')
        .withIndex('by_body', (q) => q.eq('waterBodyId', a))
        .first();
      if (row) await ctx.db.patch(row._id, { checkedAt: undefined, areasAt: undefined });
    });
    vi.setSystemTime(NOW + 1_000);
    expect(await t.mutation(internal.bodyGeo.repairDrift, {})).toMatchObject({ marked: 1 });
    expect((await facts(t, a))?.staleAt).toBe(NOW + 1_000);
    await drain(t);
    expect((await facts(t, a))?.checkedAt).toBe(NOW + 1_000);
  });

  test('a held copy of a parked neighbor is judged against that neighbor’s outline', async () => {
    const t = harness();
    const a = await seedBody(t, 'A', -72);
    const b = await seedBody(t, 'B', -72 + 2 * R);
    await drain(t);
    // A is parked (its answer never lands, so it never fans out), and its outline moves.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('bodyGeoFacts')
        .withIndex('by_body', (q) => q.eq('waterBodyId', a))
        .first();
      if (row) await ctx.db.patch(row._id, { staleAt: NOW, parkedAt: NOW, attempts: 3 });
    });
    await redraw(t, a, 9, false);
    vi.setSystemTime(NOW + 1_000);
    expect(await t.mutation(internal.bodyGeo.repairDrift, {})).toMatchObject({ marked: 1 });
    expect((await facts(t, b))?.staleAt).toBe(NOW + 1_000);
    await drain(t);
    const held = (await facts(t, b))?.neighbors?.[0];
    const now = await t.run((ctx) => ctx.db.get(a));
    expect(held?.stamp).toBe(outlineStamp(now as never));
  });
});
