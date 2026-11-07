/**
 * The real chain, end to end, on a lake built by hand (B03 §2).
 *
 * `bands.ts` and `bandCheck.ts` are unit-tested; this proves they compose — that GMT and GDAL, run the
 * way `bandChain.ts` runs them, turn a known set of isobaths into the bands they must make. It runs
 * the binaries, so it is **skipped where GMT or GDAL is not installed** (CI); run it locally after
 * touching the chain. The lake has every case the corpus throws at it at once:
 *
 * - an **island** in the shallows, which must stay dry (a hole in the shore band);
 * - a closed 20 ft ring with nothing inside — a **pit**, which a harmonic surface leaves flat until it
 *   is seeded, and which must come out as the deepest band;
 * - a small closed 10 ft ring inside the 10–20 ft band — a **shoal**, which must come out as shore band
 *   water, not be swallowed by the band around it;
 * - a contour **broken open** by the shoreline, the shape 79% of the surveyed lane's lines arrive in.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Polygon, Position } from 'geojson';
import { afterAll, describe, expect, it } from 'vitest';
import { traceBands } from './bandChain';
import { bandVerdict, checkBands, IndexedArea } from './bandCheck';

const hasTools =
  spawnSync('gmt', ['--version']).status === 0 &&
  spawnSync('gdal_contour', ['--version']).status === 0;

const LNG = -72;
const LAT = 43.6;
const M_PER_LAT = 111_320;
const M_PER_LNG = M_PER_LAT * Math.cos((LAT * Math.PI) / 180);

/** A point `x` m east and `y` m north of the lake's center. */
function at(x: number, y: number): Position {
  return [LNG + x / M_PER_LNG, LAT + y / M_PER_LAT];
}

/** A closed circle, counter-clockwise (reverse for a hole, which GeoJSON winds the other way). */
function circle(cx: number, cy: number, r: number, n = 96): Position[] {
  const ring = Array.from({ length: n }, (_, i) => {
    const t = (i / n) * 2 * Math.PI;
    return at(cx + r * Math.cos(t), cy + r * Math.sin(t));
  });
  ring.push(ring[0] as Position);
  return ring;
}

const lake: Polygon = {
  type: 'Polygon',
  coordinates: [circle(0, 0, 600), circle(480, 0, 50).reverse()],
};
const lines = [
  { depthFt: 10, coordinates: circle(0, 0, 400) },
  { depthFt: 20, coordinates: circle(0, 0, 200) },
  { depthFt: 10, coordinates: circle(0, 300, 40) },
  // The 5 ft line, broken by the shoreline into an open arc on the west shore.
  {
    depthFt: 5,
    coordinates: Array.from({ length: 40 }, (_, i) => {
      const t = Math.PI / 2 + (i / 39) * Math.PI;
      return at(500 * Math.cos(t), 500 * Math.sin(t));
    }),
  },
];

const work = mkdtempSync(join(tmpdir(), 'bands-chain-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasTools)('traceBands — the real GMT/GDAL chain on an island lake', () => {
  it('traces shore, middle and deep bands that pass every check', async () => {
    const traced = await traceBands('island-lake', lines, lake, work);
    expect(traced.note).toBeUndefined();
    expect(traced.plan.boundaries).toEqual([5, 10, 20]);
    expect(traced.bands.map((b) => b.spec)).toEqual([
      { bandIndex: 0, minDepthFt: 0, maxDepthFt: 5 },
      { bandIndex: 1, minDepthFt: 5, maxDepthFt: 10 },
      { bandIndex: 2, minDepthFt: 10, maxDepthFt: 20 },
      { bandIndex: 3, minDepthFt: 20 },
    ]);
    // The pit and the shoal were both empty rings at a boundary level, and both were read.
    expect(traced.seededRings).toBe(2);
    expect(traced.ambiguousRings).toBe(0);

    const check = checkBands({ lake, bands: traced.bands, lines });
    expect(bandVerdict(check)).toEqual([]);

    const bandAt = (x: number, y: number) =>
      traced.bands
        .filter((b) => new IndexedArea(b.geometry).contains(at(x, y)))
        .map((b) => b.spec.minDepthFt);
    expect(bandAt(0, 0)).toEqual([20]); // the pit
    expect(bandAt(0, 300)).toEqual([5]); // the shoal: shallower than the 10–20 ft water around it
    expect(bandAt(300, 0)).toEqual([10]);
    expect(bandAt(480, 0)).toEqual([]); // the island stays dry
    expect(bandAt(-550, 0)).toEqual([0]); // west shallows, outside the broken 5 ft arc
    expect(bandAt(-450, 0)).toEqual([5]);
    expect(bandAt(700, 0)).toEqual([]); // off the lake
  }, 60_000);

  it('declines a lake with nothing past the first band edge rather than drawing one band', async () => {
    const traced = await traceBands(
      'shallow-pond',
      [{ depthFt: 3, coordinates: circle(0, 0, 300) }],
      lake,
      work,
    );
    expect(traced.bands).toEqual([]);
    expect(traced.note).toMatch(/first band edge/);
  });

  it('declines a lake whose every line is degenerate, and counts them', async () => {
    const traced = await traceBands(
      'degenerate',
      [{ depthFt: 10, coordinates: [at(0, 0), at(0, 0)] }],
      lake,
      work,
    );
    expect(traced.note).toMatch(/no drawable lines/);
    expect(traced.degenerateLines).toBe(1);
  });
});
