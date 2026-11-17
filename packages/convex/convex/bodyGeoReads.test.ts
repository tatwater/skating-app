/**
 * **The geometry facts' reads, made cheap and kept identical** (B01-3p). `townCandidates` read its
 * cells one after another (up to 2,000 calls a page — 1.47 s on dev); it now reads a column of cells
 * a call, in waves. `candidates` shipped every candidate's whole outline; it now ships summaries and
 * the action reads only the outlines it tests. Each is checked against the old algorithm, kept here
 * as the reference: the same towns, in the same order, for any boundaries and any box.
 */

import { bboxIntersects, cellRangeCovering } from '@skating/core';
import { convexTest } from 'convex-test';
import fc from 'fast-check';
import type { Polygon } from 'geojson';
import { beforeAll, describe, expect, test } from 'vitest';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { ActionCtx, QueryCtx } from './_generated/server';
import { CANDIDATE_CELL_READS, COLUMN_ROWS, NamesakeReads } from './bodyGeo';
import {
  coverTiles,
  geoFactsOf,
  outlineStamp,
  paddedBox,
  placesOf,
  simplifiedRing,
  TOUCH_CANDIDATES,
  touches,
  townCellPage,
  townColumnsOf,
  townNamesOf,
  vertexCount,
} from './lib/bodyGeo';
import { ADMIN_AREA_LADDER, syncAdminAreaCells, syncWaterBodyCells } from './lib/cellIndex';
import { ROW_MAX, TX_BUDGET, TX_CALLS, TX_DOCS } from './lib/readBudget';
import schema from './schema';
import { bodiesCoveringBox } from './waterBodies';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;
type Box = { minLat: number; minLng: number; maxLat: number; maxLng: number };
type Level = 'town' | 'county' | 'state';
type Area = { name: string; level: Level; state: string; box: Box };

const rectangle = (b: Box): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [b.minLng, b.minLat],
      [b.maxLng, b.minLat],
      [b.maxLng, b.maxLat],
      [b.minLng, b.maxLat],
      [b.minLng, b.minLat],
    ],
  ],
});

/** Boundaries, indexed as the import indexes them, in one transaction. */
async function seedAreas(t: T, areas: readonly Area[]): Promise<void> {
  await t.run(async (ctx) => {
    for (const [k, a] of areas.entries()) {
      const id = await ctx.db.insert('adminAreas', {
        name: a.name,
        level: a.level,
        state: a.state,
        externalId: `tiger/${a.level}-${k}`,
        polygon: rectangle(a.box),
        bbox: a.box,
        centroid: {
          lat: (a.box.minLat + a.box.maxLat) / 2,
          lng: (a.box.minLng + a.box.maxLng) / 2,
        },
        createdAt: 0,
      });
      await syncAdminAreaCells(ctx, id, { bbox: a.box, level: a.level });
    }
  });
}

/** **The old algorithm**, as it stood before B01-3p: every cell read on its own, one after another. */
async function referenceTownIds(ctx: QueryCtx, box: Box): Promise<Id<'adminAreas'>[]> {
  const ids = new Set<Id<'adminAreas'>>();
  for (let z = ADMIN_AREA_LADDER.minZ; z <= ADMIN_AREA_LADDER.maxZ; z++) {
    const range = cellRangeCovering(box, z);
    const width = range.maxX - range.minX + 1;
    for (let i = 0; i < range.count; i++) {
      const x = range.minX + (i % width);
      const y = range.minY + Math.floor(i / width);
      const rows = await ctx.db
        .query('adminAreaCells')
        .withIndex('by_cell', (q) => q.eq('z', z).eq('x', x).eq('y', y).eq('level', 'town'))
        .take(65);
      if (rows.length > 64) throw new Error(`a town cell holds more than 64 rows (z ${z})`);
      for (const row of rows) ids.add(row.adminAreaId);
    }
  }
  return [...ids];
}

/** The new pages, walked as the action walks them: first-seen across pages. */
async function pagedTownIds(
  t: T,
  box: Box,
  seams: { pageCells?: number; columnRows?: number } = {},
): Promise<{
  ids: Id<'adminAreas'>[];
  pages: { calls: number; waves: number; columns: number }[];
}> {
  const ids: Id<'adminAreas'>[] = [];
  const seen = new Set<string>();
  const pages: { calls: number; waves: number; columns: number }[] = [];
  let from: { z: number; i: number } | undefined;
  for (;;) {
    const page = await t.query(internal.bodyGeo.townCandidates, {
      box,
      ...(from ? { from } : {}),
      ...seams,
    });
    const plan = townCellPage(box, from, seams.pageCells ?? CANDIDATE_CELL_READS);
    pages.push({ calls: page.calls, waves: page.waves, columns: townColumnsOf(plan.cells).length });
    for (const id of page.ids) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    if (page.next === null) return { ids, pages };
    if (from !== undefined) {
      expect(page.next.z > from.z || (page.next.z === from.z && page.next.i > from.i)).toBe(true);
    }
    from = page.next;
  }
}

describe('the read plan', () => {
  test('a page covers the cells the old walk read, and ends where it ended', () => {
    const box = { minLng: -74.3, maxLng: -71.7, minLat: 43.6, maxLat: 44.9 };
    let total = 0;
    for (let z = ADMIN_AREA_LADDER.minZ; z <= ADMIN_AREA_LADDER.maxZ; z++) {
      total += cellRangeCovering(box, z).count;
    }
    const first = townCellPage(box, undefined, CANDIDATE_CELL_READS);
    expect(first.cells).toHaveLength(CANDIDATE_CELL_READS);
    const second = townCellPage(box, first.next ?? undefined, CANDIDATE_CELL_READS);
    expect(second.next).toBeNull();
    expect(first.cells.length + second.cells.length).toBe(total);
    // The cursor names the first cell of the next page.
    expect(second.cells[0]).toMatchObject(first.next ?? {});
  });

  const boxes = fc
    .record({
      lng: fc.double({ min: -74, max: -71, noNaN: true }),
      lat: fc.double({ min: 43, max: 45, noNaN: true }),
      w: fc.double({ min: 0.0001, max: 0.8, noNaN: true }),
      h: fc.double({ min: 0.0001, max: 0.8, noNaN: true }),
    })
    .map(({ lng, lat, w, h }) => ({ minLng: lng, maxLng: lng + w, minLat: lat, maxLat: lat + h }));
  const columnsCover = fc.property(boxes, fc.integer({ min: 1, max: 400 }), (box, max) => {
    let from: { z: number; i: number } | undefined;
    for (let pages = 0; pages < 50; pages++) {
      const { cells, next } = townCellPage(box, from, max);
      const columns = townColumnsOf(cells);
      // Every cell in exactly one column; a column's cells are every row from its first to its last.
      expect(columns.reduce((n, c) => n + c.cells.length, 0)).toBe(cells.length);
      // In the order of their first cells: the waves' overflow is a suffix, so the page's cut is too.
      for (let k = 1; k < columns.length; k++) {
        expect(columns[k]?.first).toBeGreaterThan(columns[k - 1]?.first ?? -1);
      }
      for (const c of columns) {
        expect(c.cells.length).toBe(c.maxY - c.minY + 1);
        for (const index of c.cells) expect(cells[index]).toMatchObject({ z: c.z, x: c.x });
        expect(c.first).toBe(c.cells[0]);
      }
      if (next === null) return;
      from = next;
    }
  });
  test.each([11, 404, 2026])('columns cover a page exactly (seed %i)', (seed) => {
    fc.assert(columnsCover, { seed, numRuns: 60 });
  });
  test('columns cover a page exactly (a random seed, logged)', () => {
    const seed = Date.now() % 2_147_483_647;
    console.info(`town columns: seed ${seed}`);
    fc.assert(columnsCover, { seed, numRuns: 60 });
  });
});

describe('the same towns as before, for any boundaries', () => {
  const area = fc
    .record({
      level: fc.constantFrom<Level>('town', 'town', 'town', 'county', 'state'),
      lng: fc.double({ min: -73.6, max: -73.0, noNaN: true }),
      lat: fc.double({ min: 44.0, max: 44.6, noNaN: true }),
      // From a town smaller than the finest cell to one spanning several rungs.
      size: fc.constantFrom(0.002, 0.01, 0.04, 0.1, 0.3),
      tall: fc.double({ min: 0.3, max: 2, noNaN: true }),
    })
    .map(({ level, lng, lat, size, tall }) => ({
      name: 'Area',
      level,
      state: lng < -73.3 ? 'NY' : 'VT',
      box: {
        minLng: lng,
        maxLng: lng + (level === 'town' ? size : size * 4),
        minLat: lat,
        maxLat: lat + (level === 'town' ? size * tall : size * 4),
      },
    }));
  const world = fc.record({
    areas: fc.array(area, { minLength: 0, maxLength: 24 }),
    box: fc
      .record({
        lng: fc.double({ min: -73.7, max: -73.0, noNaN: true }),
        lat: fc.double({ min: 43.9, max: 44.6, noNaN: true }),
        w: fc.double({ min: 0.001, max: 0.4, noNaN: true }),
        h: fc.double({ min: 0.001, max: 0.4, noNaN: true }),
      })
      .map(({ lng, lat, w, h }) => ({
        minLng: lng,
        maxLng: lng + w,
        minLat: lat,
        maxLat: lat + h,
      })),
    // Small pages and small column reads, so paging, the cell-by-cell fallback and both together
    // are all reached; the real sizes too.
    pageCells: fc.option(fc.integer({ min: 1, max: 60 }), { nil: undefined }),
    columnRows: fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
  });
  /** What the runs reached, so a run that only ever met empty boxes can't pass for a proof. */
  const reached = { towns: 0, paged: 0, fellBack: 0 };
  const same = fc.asyncProperty(world, async ({ areas, box, pageCells, columnRows }) => {
    const t = harness();
    await seedAreas(t, areas);
    const before = await t.run((ctx) => referenceTownIds(ctx, box));
    const after = await pagedTownIds(t, box, {
      ...(pageCells !== undefined ? { pageCells } : {}),
      ...(columnRows !== undefined ? { columnRows } : {}),
    });
    expect(after.ids).toEqual(before);
    if (before.length > 0) reached.towns++;
    if (after.pages.length > 1) reached.paged++;
    if (after.pages.some((p) => p.calls > p.columns)) reached.fellBack++;
  });
  test.each([7, 1337, 90210])('identical candidates, in order (seed %i)', async (seed) => {
    await fc.assert(same, { seed, numRuns: 30 });
  });
  test('identical candidates, in order (a random seed, logged)', async () => {
    const seed = Date.now() % 2_147_483_647;
    console.info(`town candidates equivalence: seed ${seed}`);
    await fc.assert(same, { seed, numRuns: 30 });
    // Over the pinned seeds and this one: towns found, pages chained, columns read again by cell.
    expect(reached.towns).toBeGreaterThan(20);
    expect(reached.paged).toBeGreaterThan(10);
    expect(reached.fellBack).toBeGreaterThan(5);
  });

  test('a cell over its cap still throws, by column read or by cell', async () => {
    const t = harness();
    const tiny = { minLng: -72, maxLng: -71.999, minLat: 44, maxLat: 44.001 };
    await seedAreas(
      t,
      Array.from({ length: 65 }, (_, k) => ({
        name: `Tiny ${k}`,
        level: 'town',
        state: 'VT',
        box: tiny,
      })),
    );
    const box = { minLng: -72.01, maxLng: -71.99, minLat: 43.99, maxLat: 44.01 };
    for (const columnRows of [undefined, 3]) {
      await expect(
        t.query(internal.bodyGeo.townCandidates, {
          box,
          ...(columnRows !== undefined ? { columnRows } : {}),
        }),
      ).rejects.toThrow(/more than 64 rows/);
    }
  });
});

describe('the worst real case: thousands of cells across two states', () => {
  // A box 2.6° by 1.3° across New York and Vermont — wider than Lake Champlain's — over 338 towns of
  // 0.1°, 120 towns smaller than the finest cell, 0.5° counties and the two states. ~2,550 cells:
  // two pages.
  const box = { minLng: -74.3, maxLng: -71.7, minLat: 43.6, maxLat: 44.9 };
  const t = harness();
  let before: Id<'adminAreas'>[] = [];
  beforeAll(async () => {
    const areas: Area[] = [];
    for (let i = 0; i < 26; i++) {
      for (let j = 0; j < 13; j++) {
        const minLng = box.minLng + i * 0.1;
        const minLat = box.minLat + j * 0.1;
        areas.push({
          name: `Town ${i}-${j}`,
          level: 'town',
          state: minLng < -73.35 ? 'NY' : 'VT',
          box: { minLng, maxLng: minLng + 0.1, minLat, maxLat: minLat + 0.1 },
        });
      }
    }
    for (let k = 0; k < 120; k++) {
      const minLng = box.minLng + 0.013 + (k % 40) * 0.065;
      const minLat = box.minLat + 0.017 + Math.floor(k / 40) * 0.41;
      areas.push({
        name: `Village ${k}`,
        level: 'town',
        state: minLng < -73.35 ? 'NY' : 'VT',
        box: { minLng, maxLng: minLng + 0.008, minLat, maxLat: minLat + 0.006 },
      });
    }
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        const minLng = box.minLng + i * 0.5;
        const minLat = box.minLat + j * 0.5;
        areas.push({
          name: `County ${i}-${j}`,
          level: 'county',
          state: minLng < -73.35 ? 'NY' : 'VT',
          box: { minLng, maxLng: minLng + 0.5, minLat, maxLat: minLat + 0.5 },
        });
      }
    }
    areas.push(
      {
        name: 'New York',
        level: 'state',
        state: 'NY',
        box: { minLng: -79.8, maxLng: -73.35, minLat: 40.5, maxLat: 45.0 },
      },
      {
        name: 'Vermont',
        level: 'state',
        state: 'VT',
        box: { minLng: -73.44, maxLng: -71.46, minLat: 42.72, maxLat: 45.02 },
      },
    );
    await seedAreas(t, areas);
    before = await t.run((ctx) => referenceTownIds(ctx, box));
  });

  test('the same 458 towns, in the same order', async () => {
    const after = await pagedTownIds(t, box);
    expect(before).toHaveLength(458);
    expect(after.ids).toEqual(before);
  });

  test('each page’s calls are its columns, not its cells — a guard on the cost', async () => {
    const after = await pagedTownIds(t, box);
    expect(after.pages).toHaveLength(2);
    let from: { z: number; i: number } | undefined;
    for (const page of after.pages) {
      const plan = townCellPage(box, from, CANDIDATE_CELL_READS);
      const columns = townColumnsOf(plan.cells);
      // One call a column (no column here fills its read), against one a cell before.
      expect(page.calls).toBe(columns.length);
      expect(page.calls).toBeLessThanOrEqual(160);
      // Concurrent: a handful of rounds, never one a call.
      expect(page.waves).toBeLessThanOrEqual(4);
      from = plan.next ?? undefined;
    }
  });
});

describe('the plan fits a query on any outline in the region', () => {
  test('every page of the region-wide box reads within the transaction’s limits, with margin', () => {
    // Wider than any body could be: the five states' whole extent.
    const box = { minLng: -80, maxLng: -66.9, minLat: 40.4, maxLat: 47.5 };
    let from: { z: number; i: number } | undefined;
    let pages = 0;
    for (;;) {
      const { cells, next } = townCellPage(box, from, CANDIDATE_CELL_READS);
      const columns = townColumnsOf(cells);
      // Planned: one call a column, each at most COLUMN_ROWS rows of a bounded row.
      expect(columns.length).toBeLessThanOrEqual(CANDIDATE_CELL_READS);
      expect(columns.length).toBeLessThan(TX_CALLS);
      // A wave holds at least a few dozen columns, by every axis of the budget.
      const perWave = Math.min(
        Math.floor(TX_BUDGET / (COLUMN_ROWS * ROW_MAX.areaCell)),
        Math.floor(TX_DOCS / COLUMN_ROWS),
        TX_CALLS,
      );
      expect(perWave).toBeGreaterThanOrEqual(40);
      // Even at a page's worst — every column full, every cell read again — a page stays under
      // Convex's 4,096 calls; the budget's own limit (3,500) would end the page early first.
      expect(columns.length + cells.length).toBeLessThan(4_096);
      pages++;
      if (next === null) break;
      from = next;
    }
    expect(pages).toBeGreaterThan(1);
  });

  test('a boundary cell row weighs far less than its planned worst case', async () => {
    const t = harness();
    await seedAreas(t, [
      {
        name: 'Town',
        level: 'town',
        state: 'VT',
        box: { minLng: -72.1, maxLng: -72, minLat: 44, maxLat: 44.1 },
      },
    ]);
    const { getDocumentSize } = await import('convex/values');
    const row = await t.run((ctx) => ctx.db.query('adminAreaCells').first());
    expect(getDocumentSize(row as never)).toBeLessThan(ROW_MAX.areaCell / 4);
  });
});

// ── The touching bodies: summaries, and only the tested outlines ──────────────────────────────

/** An ellipse of `n` vertices. */
function ellipse(cx: number, cy: number, rx: number, ry: number, n: number): Polygon {
  const ring: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    ring.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  ring.push(ring[0] as number[]);
  return { type: 'Polygon', coordinates: [ring] };
}

type Pond = { at: [number, number]; r: [number, number]; n: number; zoom: number; score: number };

/** Bodies as the corpus holds them: indexed in their cells, each marked owed its computation. */
async function seedPonds(t: T, ponds: readonly Pond[]): Promise<Id<'waterBodies'>[]> {
  return t.run(async (ctx) => {
    const ids: Id<'waterBodies'>[] = [];
    for (const [k, p] of ponds.entries()) {
      const bbox = {
        minLng: p.at[0] - p.r[0],
        maxLng: p.at[0] + p.r[0],
        minLat: p.at[1] - p.r[1],
        maxLat: p.at[1] + p.r[1],
      };
      const id = await ctx.db.insert('waterBodies', {
        name: `Pond ${k}`,
        searchText: `Pond ${k}`,
        type: 'lakePond',
        source: 'osm',
        polygon: ellipse(p.at[0], p.at[1], p.r[0], p.r[1], p.n),
        bbox,
        centroid: { lat: p.at[1], lng: p.at[0] },
        states: ['VT'],
        dedupStatus: 'clean',
        createdAt: 0,
        minVisibleZoom: p.zoom,
        displayScore: p.score,
      });
      await syncWaterBodyCells(ctx, id, { bbox, minVisibleZoom: p.zoom, listed: true });
      ids.push(id);
    }
    return ids;
  });
}

/**
 * **The old neighbor step**, as it stood before B01-3p: every tile's candidates read whole, the most
 * prominent twelve whose boxes meet the padded box tested, the whole outline where it is small enough.
 */
async function referenceNeighbors(ctx: QueryCtx, waterBodyId: Id<'waterBodies'>) {
  const body = await ctx.db.get(waterBodyId);
  if (body === null) throw new Error('no body');
  const geom = body.polygon as unknown as Polygon;
  const padded = paddedBox(body.bbox);
  const { tiles, truncated } = coverTiles(padded);
  let capped = truncated;
  const seen = new Map<Id<'waterBodies'>, Doc<'waterBodies'>>();
  for (const tile of tiles) {
    const near = await bodiesCoveringBox(ctx, tile, { limit: TOUCH_CANDIDATES + 1 });
    if (near.truncated) capped = true;
    for (const b of near.byId.values()) {
      if (b._id !== waterBodyId && !seen.has(b._id)) seen.set(b._id, b);
    }
  }
  const ranked = [...seen.values()]
    .filter((b) => bboxIntersects(b.bbox, padded))
    .sort((a, b) => (b.displayScore ?? 0) - (a.displayScore ?? 0));
  const neighbors = ranked
    .slice(0, TOUCH_CANDIDATES)
    .filter((b) => {
      const outline = b.polygon as unknown as Polygon;
      const whole = vertexCount(outline) <= 20_000;
      return touches(
        geom,
        whole ? outline : { type: 'Polygon', coordinates: [simplifiedRing(outline)] },
        whole,
      );
    })
    .map((b) => ({
      waterBodyId: b._id,
      name: b.name,
      ring: simplifiedRing(b.polygon as unknown as Polygon),
      stamp: outlineStamp(b),
    }));
  return { neighbors, neighborsCapped: capped || ranked.length > TOUCH_CANDIDATES };
}

describe('the touching bodies are the same as before', () => {
  const pond = fc.record({
    at: fc.tuple(
      fc.double({ min: -72.05, max: -71.95, noNaN: true }),
      fc.double({ min: 44.1, max: 44.18, noNaN: true }),
    ),
    r: fc.tuple(
      fc.double({ min: 0.0005, max: 0.08, noNaN: true }),
      fc.double({ min: 0.0005, max: 0.05, noNaN: true }),
    ),
    n: fc.integer({ min: 8, max: 64 }),
    zoom: fc.integer({ min: 8, max: 13 }),
    score: fc.integer({ min: 0, max: 50 }),
  });
  const reached = { touching: 0 };
  const same = fc.asyncProperty(fc.array(pond, { minLength: 1, maxLength: 20 }), async (ponds) => {
    const t = harness();
    const ids = await seedPonds(t, ponds);
    const before = new Map(
      await t.run(async (ctx) => {
        const out: [string, Awaited<ReturnType<typeof referenceNeighbors>>][] = [];
        for (const id of ids) out.push([id, await referenceNeighbors(ctx, id)]);
        return out;
      }),
    );
    expect(await t.action(internal.bodyGeo.computeDue, {})).toMatchObject({ failed: 0 });
    for (const id of ids) {
      const row = await t.run((ctx) =>
        ctx.db
          .query('bodyGeoFacts')
          .withIndex('by_body', (q) => q.eq('waterBodyId', id))
          .first(),
      );
      const want = before.get(id);
      expect({ neighbors: row?.neighbors, neighborsCapped: row?.neighborsCapped }).toEqual(want);
      if ((want?.neighbors.length ?? 0) > 0) reached.touching++;
    }
  });
  test.each([3, 2718])('identical neighbors for every body (seed %i)', async (seed) => {
    await fc.assert(same, { seed, numRuns: 12 });
  });
  test('identical neighbors for every body (a random seed, logged)', async () => {
    const seed = Date.now() % 2_147_483_647;
    console.info(`touching equivalence: seed ${seed}`);
    await fc.assert(same, { seed, numRuns: 12 });
    expect(reached.touching).toBeGreaterThan(10);
  });

  test('a crowd past the twelve tested: capped, and the same twelve as before', async () => {
    const t = harness();
    const ponds: Pond[] = Array.from({ length: 16 }, (_, k) => ({
      at: [-72 + (k % 4) * 0.001, 44.1 + Math.floor(k / 4) * 0.001],
      r: [0.0025, 0.0018],
      n: 24,
      zoom: 10 + (k % 3),
      score: k,
    }));
    const ids = await seedPonds(t, ponds);
    const before = await t.run(async (ctx) => {
      const out: Awaited<ReturnType<typeof referenceNeighbors>>[] = [];
      for (const id of ids) out.push(await referenceNeighbors(ctx, id));
      return out;
    });
    expect(before.some((b) => b.neighborsCapped)).toBe(true);
    await t.action(internal.bodyGeo.computeDue, {});
    for (const [k, id] of ids.entries()) {
      const row = await t.run((ctx) =>
        ctx.db
          .query('bodyGeoFacts')
          .withIndex('by_body', (q) => q.eq('waterBodyId', id))
          .first(),
      );
      expect({ neighbors: row?.neighbors, neighborsCapped: row?.neighborsCapped }).toEqual(
        before[k],
      );
    }
  });

  test('a tile’s candidates carry no outline; a giant neighbor is tested by its samples', async () => {
    const t = harness();
    // A lake past the whole-outline bound, and a pond touching it.
    const ponds: Pond[] = [
      { at: [-72, 44.2], r: [0.05, 0.03], n: 20_050, zoom: 8, score: 90 },
      { at: [-72, 44.2305], r: [0.002, 0.001], n: 32, zoom: 12, score: 5 },
    ];
    const [lake, beside] = await seedPonds(t, ponds);
    const summary = await t.query(internal.bodyGeo.candidates, {
      box: paddedBox({ minLng: -72.002, maxLng: -71.998, minLat: 44.2295, maxLat: 44.2315 }),
    });
    expect(summary.bodies.length).toBeGreaterThan(0);
    for (const b of summary.bodies) expect(b).not.toHaveProperty('polygon');
    expect(summary.bodies.find((b) => b.id === lake)?.whole).toBe(false);
    const before = await t.run((ctx) => referenceNeighbors(ctx, beside as Id<'waterBodies'>));
    await t.action(internal.bodyGeo.computeDue, {});
    const row = await t.run((ctx) =>
      ctx.db
        .query('bodyGeoFacts')
        .withIndex('by_body', (q) => q.eq('waterBodyId', beside as Id<'waterBodies'>))
        .first(),
    );
    expect(row?.neighbors).toEqual(before.neighbors);
    expect(row?.neighbors?.map((n) => n.waterBodyId)).toContain(lake);
  });

  test('an outline is read only as its summary was cut: gone or reshaped reads nothing', async () => {
    const t = harness();
    const [id] = await seedPonds(t, [
      { at: [-72, 44.2], r: [0.01, 0.01], n: 24, zoom: 10, score: 3 },
    ]);
    const body = await t.run((ctx) => ctx.db.get(id as Id<'waterBodies'>));
    if (body === null) throw new Error('no body');
    const stamp = outlineStamp(body);
    const read = (s: string) =>
      t.query(internal.bodyGeo.candidateOutline, { waterBodyId: body._id, stamp: s });
    expect(await read(stamp)).toEqual(body.polygon);
    expect(await read(`${stamp}x`)).toBeNull();
    await t.run((ctx) => ctx.db.delete(body._id));
    expect(await read(stamp)).toBeNull();
  });
});

// ── The namesakes: each name once a run ─────────────────────────────────────────────────────────

describe('a run asks each town name once', () => {
  const strip = (x0: number, x1: number) => ({
    level: 'town' as const,
    state: 'NY',
    polygon: rectangle({ minLng: x0, maxLng: x1, minLat: 44.6, maxLat: 44.7 }),
    bbox: { minLat: 44.6, minLng: x0, maxLat: 44.7, maxLng: x1 },
    centroid: { lat: 44.65, lng: (x0 + x1) / 2 },
  });

  test('three ponds across the two Plattsburghs: one read of the name, every label told', async () => {
    const t = harness();
    await t.mutation(internal.adminAreas.importCanonical, {
      areas: [
        {
          ...strip(-73.5, -73.45),
          externalId: 'tiger/3601958420',
          name: 'Plattsburgh',
          fullName: 'Plattsburgh city',
        },
        {
          ...strip(-73.45, -73.4),
          externalId: 'tiger/3601958431',
          name: 'Plattsburgh',
          fullName: 'Plattsburgh town',
        },
      ],
    });
    const ids = await seedPonds(
      t,
      [44.62, 44.65, 44.68].map((lat) => ({
        at: [-73.45, lat],
        r: [0.005, 0.003],
        n: 32,
        zoom: 12,
        score: 1,
      })),
    );
    const run = await t.action(internal.bodyGeo.computeDue, {});
    expect(run).toMatchObject({ computed: 3, failed: 0, namesRead: 1 });
    for (const id of ids) {
      const geo = await t.run((ctx) => geoFactsOf(ctx, id));
      expect(townNamesOf(placesOf(geo))?.sort()).toEqual([
        'Plattsburgh (city)',
        'Plattsburgh (town)',
      ]);
    }
  });

  test('bodies computed together wait on one read; a read that fails is asked again', async () => {
    let calls = 0;
    let fail = true;
    const ctx = {
      runQuery: async () => {
        calls++;
        if (fail) {
          fail = false;
          throw new Error('down');
        }
        return [{ id: 'a', kind: 'city' }];
      },
    } as unknown as ActionCtx;
    const names = new NamesakeReads();
    await expect(names.of(ctx, 1, 'NY', 'Plattsburgh')).rejects.toThrow('down');
    // Forgotten once it failed: the next body asks again, and two at once share the one read.
    const [a, b] = await Promise.all([
      names.of(ctx, 1, 'NY', 'Plattsburgh'),
      names.of(ctx, 1, 'NY', 'Plattsburgh'),
    ]);
    expect(a).toBe(b);
    expect(calls).toBe(2);
    // Another places-layer mark is another read.
    await names.of(ctx, 2, 'NY', 'Plattsburgh');
    expect(calls).toBe(3);
    expect(names.reads).toBe(3);
  });

  test('a body marked stale after a held read started reads afresh: a full-name load moves no mark', async () => {
    let calls = 0;
    const ctx = {
      runQuery: async () => {
        calls++;
        return [{ id: 'a', kind: calls === 1 ? null : 'town' }];
      },
    } as unknown as ActionCtx;
    const names = new NamesakeReads();
    const before = Date.now() - 1;
    const first = await names.of(ctx, 1, 'NY', 'Plattsburgh', before);
    // Marked before the held read started: shared.
    expect(await names.of(ctx, 1, 'NY', 'Plattsburgh', before)).toBe(first);
    expect(calls).toBe(1);
    // Marked after it (a `seedAll` that follows a full-name load, mid-run): read again, and held.
    const later = Date.now() + 60_000;
    const fresh = await names.of(ctx, 1, 'NY', 'Plattsburgh', later);
    expect(fresh).not.toBe(first);
    expect(fresh[0]?.kind).toBe('town');
    expect(calls).toBe(2);
    expect(await names.of(ctx, 1, 'NY', 'Plattsburgh', null)).toBe(fresh);
    expect(calls).toBe(2);
  });
});

// ── The rollout's check: the stored answers are the ones computed now ─────────────────────────

describe('checkStored', () => {
  test('says same for every stored answer, names a field that differs, and writes nothing', async () => {
    const t = harness();
    await seedAreas(t, [
      {
        name: 'West',
        level: 'town',
        state: 'VT',
        box: { minLng: -72.1, maxLng: -72.0, minLat: 44.1, maxLat: 44.2 },
      },
      {
        name: 'East',
        level: 'town',
        state: 'VT',
        box: { minLng: -72.0, maxLng: -71.9, minLat: 44.1, maxLat: 44.2 },
      },
    ]);
    const [across, beside, unknown] = await seedPonds(t, [
      { at: [-72, 44.15], r: [0.004, 0.002], n: 32, zoom: 12, score: 4 },
      { at: [-72, 44.1525], r: [0.001, 0.0005], n: 16, zoom: 13, score: 1 },
      { at: [-71.95, 44.18], r: [0.001, 0.0005], n: 16, zoom: 13, score: 1 },
    ]);
    // The third is never computed.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('bodyGeoFacts')
        .withIndex('by_body', (q) => q.eq('waterBodyId', unknown as Id<'waterBodies'>))
        .first();
      if (row) await ctx.db.delete(row._id);
    });
    // Two runs: each body's first answer marks the other, whose relation moved, for one more.
    await t.action(internal.bodyGeo.computeDue, {});
    await t.action(internal.bodyGeo.computeDue, {});
    const ids = [across, beside, unknown] as Id<'waterBodies'>[];
    const rowOf = (id: Id<'waterBodies'>) =>
      t.run((ctx) =>
        ctx.db
          .query('bodyGeoFacts')
          .withIndex('by_body', (q) => q.eq('waterBodyId', id))
          .first(),
      );
    const before = await rowOf(across as Id<'waterBodies'>);
    expect(before?.townEntries).toHaveLength(2);
    expect(before?.neighbors?.map((n) => n.waterBodyId)).toEqual([beside]);
    expect(await t.action(internal.bodyGeo.checkStored, { waterBodyIds: ids })).toEqual([
      { waterBodyId: across, status: 'same', stale: false, differs: [] },
      { waterBodyId: beside, status: 'same', stale: false, differs: [] },
      { waterBodyId: unknown, status: 'not computed', stale: false, differs: [] },
    ]);
    // Nothing written.
    expect(await rowOf(across as Id<'waterBodies'>)).toEqual(before);
    // A stored answer that is not the code's: named by field.
    await t.run((ctx) => ctx.db.patch(before?._id as Id<'bodyGeoFacts'>, { counties: ['Other'] }));
    expect(
      await t.action(internal.bodyGeo.checkStored, { waterBodyIds: [across as Id<'waterBodies'>] }),
    ).toEqual([{ waterBodyId: across, status: 'differs', stale: false, differs: ['counties'] }]);
    // Computed for another outline: behind, whatever it holds.
    await t.run((ctx) =>
      ctx.db.patch(before?._id as Id<'bodyGeoFacts'>, { stamp: 'another outline' }),
    );
    expect(
      (
        await t.action(internal.bodyGeo.checkStored, {
          waterBodyIds: [across as Id<'waterBodies'>],
        })
      )[0]?.status,
    ).toBe('behind');
    await t.run((ctx) => ctx.db.delete(beside as Id<'waterBodies'>));
    expect(
      (
        await t.action(internal.bodyGeo.checkStored, {
          waterBodyIds: [beside as Id<'waterBodies'>],
        })
      )[0]?.status,
    ).toBe('gone');
    await expect(
      t.action(internal.bodyGeo.checkStored, {
        waterBodyIds: Array.from({ length: 26 }, () => across as Id<'waterBodies'>),
      }),
    ).rejects.toThrow(/at most 25/);
  });
});
