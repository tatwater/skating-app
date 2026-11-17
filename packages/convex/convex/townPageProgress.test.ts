/**
 * **Every town page advances or is done** (B01-3p, Greptile on #143). A page reads its columns in
 * waves and then reads its full columns again cell by cell; the columns could spend the whole budget
 * first, leaving nothing for the first cell's own read, so the page ended where it began and the
 * action failed the body with *made no progress*. The page now settles its first cell before anything
 * else can spend on it (`ReadBudget.reserveFirst`), and a budget that can't hold that much is its own
 * named failure (`CannotAdvance`). Driven here without a database: the cell index is a synthetic one.
 */

import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Id } from './_generated/dataModel';
import { COLUMN_ROWS, settleTownPage, type TownCellReads } from './bodyGeo';
import type { TownCell } from './lib/bodyGeo';
import { CannotAdvance, ReadBudget, TX_BUDGET, TX_CALLS, TX_DOCS } from './lib/readBudget';

/** A synthetic rung: `width` cells a row, each with its town rows and rows of other levels. */
type World = { width: number; cells: { towns: string[]; others: number }[] };

/** The cell walk over the world, row-major, as `townCellPage` lays a rung out. */
const walk = (w: World): TownCell[] =>
  w.cells.map((_, i) => ({ z: 13, i, x: i % w.width, y: Math.floor(i / w.width) }));

/** The cell index's two reads over the world, in `by_cell` order (a cell's levels sort county, state, town). */
function index(w: World): TownCellReads & { calls: number } {
  const at = (x: number, y: number) => w.cells[y * w.width + x];
  const io = {
    calls: 0,
    column: async (c: { x: number; minY: number; maxY: number }, n: number) => {
      io.calls++;
      const rows: { y: number; level: string; adminAreaId: Id<'adminAreas'> }[] = [];
      for (let y = c.minY; y <= c.maxY && rows.length < n; y++) {
        const cell = at(c.x, y);
        if (cell === undefined) continue;
        for (let k = 0; k < cell.others; k++) {
          rows.push({ y, level: 'county', adminAreaId: `other-${k}` as Id<'adminAreas'> });
        }
        for (const t of cell.towns)
          rows.push({ y, level: 'town', adminAreaId: t as Id<'adminAreas'> });
      }
      return rows.slice(0, n);
    },
    cell: async (c: TownCell, n: number) => {
      io.calls++;
      return (at(c.x, c.y)?.towns ?? [])
        .slice(0, n)
        .map((t) => ({ adminAreaId: t as Id<'adminAreas'> }));
    },
  };
  return io;
}

/** The old walk's answer: every cell's towns, in walk order. */
const reference = (w: World): string[] => [...new Set(w.cells.flatMap((c) => c.towns))];

/** A budget of `bytes`, `calls` and `docs`, made from a whole transaction's by reserving the rest. */
function budget(bytes: number, calls: number, docs: number): ReadBudget {
  const b = new ReadBudget(bytes);
  b.reserveCalls(TX_CALLS - calls, TX_DOCS - docs);
  return b;
}

/** Every page of the world, as the action walks them: each from where the last said to go on. */
async function pages(
  w: World,
  pageCells: number,
  columnRows: number,
  fresh: () => ReadBudget,
): Promise<{ ids: string[]; pages: number; cut: number }> {
  const all = walk(w);
  const io = index(w);
  const ids: string[] = [];
  let from = 0;
  let count = 0;
  // Pages the budget ended short of their planned end.
  let cut = 0;
  for (;;) {
    const cells = all.slice(from, from + pageCells);
    const planned = from + pageCells < all.length ? { z: 13, i: from + pageCells } : null;
    const page = await settleTownPage(cells, planned, columnRows, io, fresh());
    count++;
    for (const id of page.ids) if (!ids.includes(id)) ids.push(id);
    if (page.next === null) return { ids, pages: count, cut };
    if (page.next.i < from + cells.length) cut++;
    // Strictly onward, every page.
    expect(page.next.i).toBeGreaterThan(from);
    from = page.next.i;
    if (count > all.length) throw new Error('more pages than cells');
  }
}

const full = (k: number) => ({ towns: [`full-${k}-a`, `full-${k}-b`], others: 300 });

describe('a page always advances or is done', () => {
  test('Greptile’s case: 109 full columns and one of 96 rows spend all 28,000 documents', async () => {
    // One row of 110 single-cell columns: the first full, the second 96 rows, the rest full —
    // 109 × 256 + 96 = 28,000 documents, every one the budget has, before any cell is read again.
    const w: World = {
      width: 110,
      cells: Array.from({ length: 110 }, (_, k) =>
        k === 1 ? { towns: ['short-a', 'short-b'], others: 94 } : full(k),
      ),
    };
    expect(109 * COLUMN_ROWS + 96).toBe(TX_DOCS);
    const cells = walk(w);
    const page = await settleTownPage(cells, null, COLUMN_ROWS, index(w));
    // The first cell is settled — its column, then the column's own cell read — so the page moves on.
    expect(page.next === null || page.next.i > 0).toBe(true);
    expect(page.ids.slice(0, 2)).toEqual(['full-0-a', 'full-0-b']);
    // And the walk over every page is the old walk's answer.
    expect((await pages(w, 2_000, COLUMN_ROWS, () => new ReadBudget())).ids).toEqual(reference(w));
  });

  test('a budget too small for the first cell’s reads is a named failure on the first call', async () => {
    const w: World = { width: 3, cells: [full(0), full(1), full(2)] };
    const unit = COLUMN_ROWS + 65;
    await expect(
      settleTownPage(walk(w), null, COLUMN_ROWS, index(w), budget(TX_BUDGET, 2, unit - 1)),
    ).rejects.toBeInstanceOf(CannotAdvance);
    await expect(
      settleTownPage(walk(w), null, COLUMN_ROWS, index(w), budget(TX_BUDGET, 1, unit)),
    ).rejects.toBeInstanceOf(CannotAdvance);
    // Exactly one unit is enough: the page settles its first cell and goes on from the second.
    const page = await settleTownPage(
      walk(w),
      null,
      COLUMN_ROWS,
      index(w),
      budget(TX_BUDGET, 2, unit),
    );
    expect(page.next).toEqual({ z: 13, i: 1 });
  });

  const world = fc
    .record({
      width: fc.integer({ min: 1, max: 12 }),
      cells: fc.array(
        fc.oneof(
          fc.constant({ towns: [] as string[], others: 0 }),
          fc.record({
            towns: fc.array(
              fc.integer({ min: 0, max: 30 }).map((t) => `town-${t}`),
              {
                maxLength: 4,
              },
            ),
            others: fc.integer({ min: 0, max: 3 }),
          }),
          fc.record({
            towns: fc.array(
              fc.integer({ min: 0, max: 30 }).map((t) => `town-${t}`),
              {
                maxLength: 4,
              },
            ),
            others: fc.integer({ min: 4, max: 40 }),
          }),
        ),
        { minLength: 1, maxLength: 90 },
      ),
    })
    .map((w) => ({ ...w, cells: w.cells.map((c) => ({ ...c, towns: [...new Set(c.towns)] })) }));
  const reached = { cut: 0, towns: 0 };
  const property = fc.asyncProperty(
    world,
    fc.integer({ min: 1, max: 40 }),
    fc.integer({ min: 1, max: 24 }),
    // A budget from barely one unit to many: calls and documents, the axes the columns spend.
    fc.integer({ min: 2, max: 40 }),
    fc.integer({ min: 0, max: 600 }),
    async (w, pageCells, columnRows, calls, spareDocs) => {
      const docs = columnRows + 65 + spareDocs;
      const out = await pages(w, pageCells, columnRows, () => budget(TX_BUDGET, calls, docs));
      reached.cut += out.cut;
      if (out.ids.length > 0) reached.towns++;
      // The union of the pages is the old walk's answer, in its order.
      expect(out.ids).toEqual(reference(w));
      // Each page settles at least one cell, and with room for a whole page no more pages are needed
      // than a page's worth of cells divides the walk into.
      expect(out.pages).toBeLessThanOrEqual(w.cells.length);
    },
  );
  /** Runs the property and checks it reached what it is about: pages the budget cut short. */
  async function holds(seed: number) {
    reached.cut = 0;
    reached.towns = 0;
    await fc.assert(property, { seed, numRuns: 150 });
    expect(reached.cut).toBeGreaterThan(10);
    expect(reached.towns).toBeGreaterThan(100);
  }
  test.each([1, 99, 2027])('every page advances or is done (seed %i)', async (seed) => {
    await holds(seed);
  });
  test('every page advances or is done (a random seed, logged)', async () => {
    const seed = Date.now() % 2_147_483_647;
    console.info(`town page progress: seed ${seed}`);
    await holds(seed);
  });

  test('with the whole budget, the pages are exactly the walk divided by the page', async () => {
    const w: World = {
      width: 7,
      cells: Array.from({ length: 50 }, (_, k) => ({ towns: [`t${k % 9}`], others: k % 3 })),
    };
    for (const pageCells of [1, 6, 50, 2_000]) {
      const out = await pages(w, pageCells, COLUMN_ROWS, () => new ReadBudget());
      expect(out.pages).toBe(Math.ceil(w.cells.length / pageCells));
      expect(out.ids).toEqual(reference(w));
    }
  });
});
