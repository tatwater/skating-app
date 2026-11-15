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
import type { Id } from './_generated/dataModel';
import { FANOUT_INLINE } from './bodyGeo';
import { markGeoStale, outlineStamp, simplifiedRing } from './lib/bodyGeo';
import { rebuildBodyLibrary } from './lib/bodyLibrary';
import { syncWaterBodyCells } from './lib/cellIndex';
import { noteAdminAreasChanged } from './lib/geoStale';
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
});
