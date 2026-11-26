import type { NaipManifest, NaipState } from '@skating/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildCellIndex,
  type CellFrameTotals,
  encodeCellIndex,
  totalCounts,
} from './assemble/cellIndex';
import { syntheticItem } from './assemble/synthetic';
import { checkCellIndex, isRealDay, itemIdDate, undatedTiles } from './verifyDates';

const FLIGHTS: { state: NaipState; gsd: number; acquired: string }[] = [
  { state: 'VT', gsd: 0.3, acquired: '2025-07-14' },
  { state: 'NY', gsd: 0.6, acquired: '2024-08-02' },
  { state: 'NY', gsd: 0.6, acquired: '2019-06-30' },
  { state: 'ME', gsd: 0.3, acquired: '2023-10-02' },
];

const CELLS = ['4407301ne', '4407301nw', '4407302se', '4407302sw', '4507264sw'];

/** A manifest of `CELLS`, each with every flight in its stack (pick = flight `pickOf(cell)`). */
function manifestFor(pickOf: (i: number) => number): NaipManifest {
  const frames: NaipManifest['frames'] = {};
  const cells = CELLS.map((key, i) => {
    const items = FLIGHTS.map((f) => {
      const id = syntheticItem(key, f.state, f.gsd, f.acquired);
      frames[id] = {
        acquired: f.acquired,
        gsd: f.gsd,
        state: f.state,
        year: Number(f.acquired.slice(0, 4)),
      };
      return id;
    });
    const p = pickOf(i);
    return {
      key,
      states: ['NY', 'VT'] as NaipState[],
      pick: items[p] as string,
      step: 'leafOn' as const,
      stack: items.filter((_, j) => j !== p),
      partial: true,
      cloudScore: null,
      workTiles: ['11/603/731'],
    };
  });
  return {
    version: 1,
    campaign: 'naip-20261212',
    pilot: null,
    createdAt: '2026-12-12T00:00:00Z',
    ruleVersion: 1,
    catalog: { walkedOn: '2026-12-01', items: 0, perState: {}, archivedAt: null },
    exclusionsHash: '0'.repeat(64),
    offSeasonCells: [],
    basedOn: null,
    frames,
    cells,
    workTiles: [],
  };
}

const item = (_m: NaipManifest, cell: number, flight: number) => {
  const f = FLIGHTS[flight] as (typeof FLIGHTS)[number];
  return syntheticItem(CELLS[cell] as string, f.state, f.gsd, f.acquired);
};

/** Counts: per cell, per flight index, pixels (0 = absent). */
const arbCounts = fc.array(fc.array(fc.nat({ max: 5 }), { minLength: 4, maxLength: 4 }), {
  minLength: CELLS.length,
  maxLength: CELLS.length,
});

const totalsOf = (m: NaipManifest, counts: number[][]): CellFrameTotals => {
  const t: CellFrameTotals = new Map();
  counts.forEach((row, c) => {
    const frames = new Map<string, number>();
    row.forEach((n, f) => {
      if (n > 0) frames.set(item(m, c, f), n);
    });
    if (frames.size > 0) t.set(CELLS[c] as string, frames);
  });
  return t;
};

describe('the date index, built and checked (properties)', () => {
  it('lists exactly the cells with pixels, by exactly the flights that supply them, pick first', () => {
    fc.assert(
      fc.property(
        arbCounts,
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 5, maxLength: 5 }),
        (counts, picks) => {
          const m = manifestFor((i) => picks[i] as number);
          const totals = totalsOf(m, counts);
          const index = buildCellIndex(m, totals, 'naip-summer-20261212.pmtiles');
          expect(
            checkCellIndex({
              json: index,
              archiveName: 'naip-summer-20261212.pmtiles',
              manifest: m,
              totals,
            }),
          ).toEqual([]);
          // Flights distinct, sorted, each used.
          const keys = index.flights.map((f) => `${f.date}|${f.gsd}|${f.state}`);
          expect(new Set(keys).size).toBe(keys.length);
          counts.forEach((row, c) => {
            const listed = index.cells[CELLS[c] as string];
            const supplying = row.flatMap((n, f) => (n > 0 ? [f] : []));
            if (supplying.length === 0) {
              expect(listed).toBeUndefined();
              return;
            }
            const dates = (listed as number[]).map((i) => index.flights[i]?.date);
            expect(new Set(dates)).toEqual(new Set(supplying.map((f) => FLIGHTS[f]?.acquired)));
            const pick = picks[c] as number;
            if ((row[pick] as number) > 0) expect(dates[0]).toBe(FLIGHTS[pick]?.acquired);
            // After the pick, most pixels first.
            const rest = (listed as number[]).slice((row[pick] as number) > 0 ? 1 : 0);
            const pixels = rest.map(
              (i) => row[FLIGHTS.findIndex((f) => f.acquired === index.flights[i]?.date)] as number,
            );
            expect([...pixels].sort((a, b) => b - a)).toEqual(pixels);
          });
        },
      ),
    );
  });

  it('an index missing any cell with pixels is refused as undated (property)', () => {
    fc.assert(
      fc.property(
        arbCounts.filter((c) => c.some((r) => r.some((n) => n > 0))),
        (counts) => {
          const m = manifestFor(() => 0);
          const totals = totalsOf(m, counts);
          const index = buildCellIndex(m, totals, 'a.pmtiles');
          const [victim] = Object.keys(index.cells);
          const { [victim as string]: _, ...rest } = index.cells;
          const problems = checkCellIndex({
            json: { ...index, cells: rest },
            archiveName: 'a.pmtiles',
            manifest: m,
            totals,
          });
          expect(problems.some((p) => p.includes(`cell ${victim} has pixels and no date`))).toBe(
            true,
          );
        },
      ),
    );
  });
});

describe('checkCellIndex refuses', () => {
  const m = manifestFor(() => 0);
  const totals = totalsOf(m, [
    [5, 1, 0, 0],
    [3, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 4, 0, 0],
    [0, 0, 0, 2],
  ]);
  const good = buildCellIndex(m, totals, 'a.pmtiles');
  const run = (json: unknown, manifest = m) =>
    checkCellIndex({ json, archiveName: 'a.pmtiles', manifest, totals });

  it('nothing in a good index', () => {
    expect(run(good)).toEqual([]);
  });

  it('another archive’s index, another version, a shape that isn’t one', () => {
    expect(run({ ...good, archive: 'b.pmtiles' })).toEqual([
      'the index names "b.pmtiles", not a.pmtiles',
    ]);
    expect(run({ ...good, version: 2 })).toEqual(['the index is version 2, not 1']);
    expect(run(null)).toEqual(['the index is not an object']);
    expect(run({ ...good, flights: 3 })).toContain('the index has no flights list');
    expect(run({ ...good, cells: [] })).toContain('the index has no cells');
  });

  it('a flight that is not a real day, a resolution, one of the seven, or distinct', () => {
    const f = (patch: object) => ({
      ...good,
      flights: good.flights.map((x, i) => (i === 0 ? { ...x, ...patch } : x)),
    });
    expect(run(f({ date: '2025-02-30' })).join()).toContain('flight 0 has no real day');
    expect(run(f({ gsd: 0 })).join()).toContain('flight 0 has no resolution');
    expect(run(f({ state: 'QC' })).join()).toContain('is not one of the seven');
    expect(run({ ...good, flights: [...good.flights, good.flights[0]] }).join()).toContain(
      'repeats',
    );
  });

  it('a cell with no flight, an out-of-range flight, a flight twice, a missing or extra flight', () => {
    const c = (patch: Record<string, unknown>) => ({ ...good, cells: { ...good.cells, ...patch } });
    expect(run(c({ '4407301nw': [] })).join()).toContain('names no flight: an undated cell');
    expect(run(c({ '4407301nw': [99] })).join()).toContain("which isn't in the list");
    const twice = good.cells['4407301nw']?.[0] as number;
    expect(run(c({ '4407301nw': [twice, twice] })).join()).toContain('twice');
    const ne = good.cells['4407301ne'] as number[];
    expect(run(c({ '4407301ne': [ne[0]] })).join()).toContain("supplies pixels and isn't named");
    const extra = good.flights.findIndex((x) => x.state === 'ME');
    expect(run(c({ '4407301nw': [twice, extra] })).join()).toContain('supplies it no pixel');
  });

  it('the pick’s flight not first', () => {
    const ne = good.cells['4407301ne'] as number[];
    expect(
      run({ ...good, cells: { ...good.cells, '4407301ne': [...ne].reverse() } }).join(),
    ).toContain("isn't first");
  });

  it('a dated cell no frame supplied, a key that isn’t a cell, an unused flight', () => {
    const someFlight = good.cells['4407301ne']?.[0] as number;
    expect(run({ ...good, cells: { ...good.cells, '4407302se': [someFlight] } }).join()).toContain(
      'is dated but no frame supplied it a pixel',
    );
    expect(run({ ...good, cells: { ...good.cells, nope: [someFlight] } }).join()).toContain(
      'is not a cell key',
    );
    expect(
      run({
        ...good,
        flights: [...good.flights, { date: '2010-07-01', gsd: 1, state: 'VT' }],
      }).join(),
    ).toContain('is used by no cell');
  });

  it('a frame whose day isn’t its id’s, or isn’t a day, or isn’t in the manifest', () => {
    const it0 = item(m, 0, 0);
    const bad = (acquired: string) => ({
      ...m,
      frames: {
        ...m.frames,
        [it0]: { ...(m.frames[it0] as NaipManifest['frames'][string]), acquired },
      },
    });
    expect(run(good, bad('2025-07-15')).join()).toContain('but its id says 2025-07-14');
    expect(run(good, bad('2025-13-01')).join()).toContain('is not a real day');
    const { [it0]: _, ...frames } = m.frames;
    expect(run(good, { ...m, frames }).join()).toContain("isn't in the manifest");
    expect(run(good, { ...m, cells: m.cells.slice(1) }).join()).toContain(
      "has pixels but isn't in the manifest",
    );
  });
});

describe('buildCellIndex refuses a pixel it can’t date', () => {
  const m = manifestFor(() => 0);
  it('a cell the manifest doesn’t hold, or a frame outside the cell’s stack or the manifest', () => {
    expect(() => buildCellIndex(m, new Map([['4407399ne', new Map([['x', 1]])]]), 'a')).toThrow(
      "doesn't hold",
    );
    expect(() => buildCellIndex(m, new Map([['4407301ne', new Map([['x', 1]])]]), 'a')).toThrow(
      'neither its pick nor its stack',
    );
    const it0 = item(m, 0, 0);
    const { [it0]: _, ...frames } = m.frames;
    expect(() =>
      buildCellIndex({ ...m, frames }, new Map([['4407301ne', new Map([[it0, 1]])]]), 'a'),
    ).toThrow('not in the manifest');
  });

  it('drops zero counts, sums work tiles, and encodes deterministically', () => {
    const totals = totalCounts([
      { '4407301ne': { [item(m, 0, 0)]: 2, [item(m, 0, 1)]: 0 } },
      { '4407301ne': { [item(m, 0, 0)]: 3 } },
    ]);
    expect(totals.get('4407301ne')?.get(item(m, 0, 0))).toBe(5);
    const index = buildCellIndex(m, totals, 'a');
    expect(index.cells).toEqual({ '4407301ne': [0] });
    const a = encodeCellIndex(index);
    expect(a.sha256).toBe(encodeCellIndex(index).sha256);
    expect(a.gzip.length).toBeLessThan(a.json.length + 30);
  });
});

describe('item dates and days', () => {
  it('reads the first date of an id, never the processing date', () => {
    expect(itemIdDate('me_m_4407028_ne_19_030_20231002_20240103')).toBe('2023-10-02');
    expect(itemIdDate('vt_m_4507264_sw_18_030_20250920')).toBe('2025-09-20');
    expect(itemIdDate('not-an-id')).toBeNull();
    expect(isRealDay('2024-02-29')).toBe(true);
    expect(isRealDay('2023-02-29')).toBe(false);
    expect(isRealDay(20240229)).toBe(false);
  });
});

describe('undated tiles', () => {
  const box = (id: number) => ({ west: id, south: 0, east: id + 1, north: 1 });
  const cellsIn = (b: { minLng: number }) => (Math.floor(b.minLng) % 3 === 0 ? ['a', 'b'] : ['c']);
  it('counts tiles whose cells are all undated, and samples them', () => {
    const out = undatedTiles([0, 1, 2, 3, 4], { cells: { a: [0] } }, box, cellsIn, 1);
    expect(out).toEqual({ count: 3, sample: [1] });
    expect(undatedTiles([0, 3], { cells: { b: [0] } }, box, cellsIn).count).toBe(0);
  });
});
