import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type BBox, bboxIntersects } from './geometry';
import {
  allLevels,
  bboxExtentDeg,
  type CellLadder,
  cellForPoint,
  cellRangeCovering,
  cellSizeDeg,
  cellsCovering,
  fitLevel,
  indexLevelFor,
  scanLevels,
} from './spatialCells';

/** The water-body ladder (D49's zoom bounds) — the one the invariants below are stated against. */
const LADDER: CellLadder = { minZ: 6, maxZ: 14 };

/** A bbox key set, for the "do these two coverings share a cell?" tests. */
function cellKeys(box: BBox, z: number): Set<string> {
  return new Set(cellsCovering(box, z).map((c) => `${c.z}/${c.x}/${c.y}`));
}

/** An arbitrary bbox somewhere in the Northeast corpus envelope, of an arbitrary size. */
const arbBBox = fc
  .record({
    lat: fc.double({ min: 40, max: 47.5, noNaN: true }),
    lng: fc.double({ min: -80, max: -67, noNaN: true }),
    h: fc.double({ min: 0, max: 2, noNaN: true }),
    w: fc.double({ min: 0, max: 2, noNaN: true }),
  })
  .map(
    ({ lat, lng, h, w }): BBox => ({
      minLat: lat,
      maxLat: lat + h,
      minLng: lng,
      maxLng: lng + w,
    }),
  );

/**
 * A pair of bboxes that provably overlap — built by growing the second one around a point taken
 * from inside the first. Generating two independent boxes and filtering would reject ~99% of
 * candidates and never actually exercise the theorem.
 */
const arbIntersectingPair = fc
  .record({
    a: arbBBox,
    fLat: fc.double({ min: 0, max: 1, noNaN: true }),
    fLng: fc.double({ min: 0, max: 1, noNaN: true }),
    up: fc.double({ min: 0, max: 2, noNaN: true }),
    down: fc.double({ min: 0, max: 2, noNaN: true }),
    left: fc.double({ min: 0, max: 2, noNaN: true }),
    right: fc.double({ min: 0, max: 2, noNaN: true }),
  })
  .map(({ a, fLat, fLng, up, down, left, right }): [BBox, BBox] => {
    const lat = a.minLat + fLat * (a.maxLat - a.minLat);
    const lng = a.minLng + fLng * (a.maxLng - a.minLng);
    return [a, { minLat: lat - down, maxLat: lat + up, minLng: lng - left, maxLng: lng + right }];
  });

describe('the grid', () => {
  it('halves the cell size each level', () => {
    expect(cellSizeDeg(0)).toBe(360);
    expect(cellSizeDeg(6)).toBeCloseTo(5.625);
    expect(cellSizeDeg(14)).toBeCloseTo(0.02197);
  });

  it('puts a point in exactly the cell its coordinates fall in', () => {
    // z=6 ⇒ 5.625° cells. Burlington VT (44.48, -73.21): x = (−73.21+180)/5.625 = 18.98 → 18.
    expect(cellForPoint({ lat: 44.48, lng: -73.21 }, 6)).toEqual({ z: 6, x: 18, y: 23 });
  });

  it('keeps a coordinate on the domain edge inside the grid', () => {
    // lat 90 / lng 180 must land in the LAST cell, never one past the end (which would be a row
    // nothing else can ever be indexed into — a silent hole at the pole).
    const corner = cellForPoint({ lat: 90, lng: 180 }, 6);
    expect(corner.x).toBe(2 ** 6 - 1);
    expect(corner.y).toBe(2 ** 5 - 1);
    // Out-of-domain input (a wrapped viewport) clamps rather than producing a negative index.
    expect(cellForPoint({ lat: 200, lng: 400 }, 6)).toEqual(corner);
    const antiCorner = cellForPoint({ lat: -200, lng: -400 }, 6);
    expect(antiCorner).toEqual({ z: 6, x: 0, y: 0 });
  });

  it('counts a covering without materializing it', () => {
    const box: BBox = { minLat: 43, maxLat: 45, minLng: -74, maxLng: -72 };
    const range = cellRangeCovering(box, 10);
    expect(range.count).toBe(cellsCovering(box, 10).length);
  });
});

describe('fitLevel / indexLevelFor', () => {
  it('picks the finest level whose cell still contains the object', () => {
    // Lake Champlain spans ~1.53° — cell size at z=7 is 2.81° (fits), at z=8 is 1.41° (does not).
    expect(fitLevel(1.53, LADDER)).toBe(7);
    expect(cellSizeDeg(7)).toBeGreaterThanOrEqual(1.53);
    expect(cellSizeDeg(8)).toBeLessThan(1.53);
  });

  it('rides the finest rung for a point-sized or degenerate extent', () => {
    expect(fitLevel(0, LADDER)).toBe(LADDER.maxZ);
    expect(fitLevel(Number.NaN, LADDER)).toBe(LADDER.maxZ);
    expect(fitLevel(1e-9, LADDER)).toBe(LADDER.maxZ);
  });

  it('clamps an object bigger than the coarsest rung rather than falling off the ladder', () => {
    expect(fitLevel(300, LADDER)).toBe(LADDER.minZ);
  });

  it('indexes at the COARSER of size and visibility — the completeness ceiling', () => {
    // A small-but-boosted pond (D49 curatedBoost) is tiny, so its fitLevel is the finest rung —
    // but it draws from zoom 8, so it must be indexed at 8. Indexing it at 14 would hide it from
    // every wide-zoom query: the exact silent-disappearance bug the ceiling exists to prevent.
    const pond: BBox = { minLat: 43.9, maxLat: 43.91, minLng: -72.15, maxLng: -72.14 };
    expect(fitLevel(bboxExtentDeg(pond), LADDER)).toBe(LADDER.maxZ);
    expect(indexLevelFor(pond, LADDER, 8)).toBe(8);
  });

  it('lets size win when the object is coarser than its visibility bucket', () => {
    // A long, thin river reach: big extent (0.5°) but small area, so D49 only draws it at z=13.
    // Size wins, and the zoom filter drops it in-query at wider zooms.
    const reach: BBox = { minLat: 43.5, maxLat: 44, minLng: -72.5, maxLng: -72.45 };
    expect(indexLevelFor(reach, LADDER, 13)).toBe(fitLevel(0.5, LADDER));
    expect(indexLevelFor(reach, LADDER, 13)).toBeLessThan(13);
  });
});

describe('scanLevels', () => {
  it('scans every rung up to the query zoom, coarsest first', () => {
    expect(scanLevels(8, LADDER)).toEqual([6, 7, 8]);
    expect(scanLevels(14, LADDER)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it('clamps a zoom outside the ladder instead of scanning nothing or everything twice', () => {
    expect(scanLevels(3, LADDER)).toEqual([6]);
    expect(scanLevels(22, LADDER)).toEqual(allLevels(LADDER));
  });

  it('never scans a level finer than the query zoom', () => {
    // This is what bounds the read cost: every scanned cell is at least as large as the viewport,
    // so each rung contributes only a handful of cells however far out you are.
    fc.assert(
      fc.property(fc.integer({ min: 6, max: 14 }), (zoom) => {
        for (const z of scanLevels(zoom, LADDER)) expect(z).toBeLessThanOrEqual(zoom);
      }),
    );
  });
});

describe('theorem 1 — completeness', () => {
  it('gives two intersecting bboxes at least one shared cell, at every level', () => {
    // The whole reason a query can drop every margin and outlier list: if the boxes overlap, the
    // overlap contains a point, that point is in exactly one cell, and both coverings contain it.
    fc.assert(
      fc.property(arbIntersectingPair, fc.integer({ min: 6, max: 14 }), ([a, b], z) => {
        expect(bboxIntersects(a, b)).toBe(true); // the generator's own premise
        const shared = [...cellKeys(a, z)].some((key) => cellKeys(b, z).has(key));
        expect(shared).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('finds every body whose bbox meets the viewport and whose zoom bucket allows it', () => {
    // The end-to-end invariant, stated the way `listInViewport` relies on it: index the body at
    // indexLevelFor(...), scan levels 6…zoom, and the body's cells intersect the query's cells.
    fc.assert(
      fc.property(
        arbIntersectingPair,
        fc.integer({ min: 6, max: 14 }),
        fc.integer({ min: 6, max: 14 }),
        ([body, viewport], minVisibleZoom, zoomOffset) => {
          // The body is meant to be visible at this zoom, so pick a zoom at or past its bucket.
          const zoom = Math.min(14, Math.max(minVisibleZoom, zoomOffset));

          const z = indexLevelFor(body, LADDER, minVisibleZoom);
          expect(scanLevels(zoom, LADDER)).toContain(z);

          const indexed = cellKeys(body, z);
          const queried = cellKeys(viewport, z);
          expect([...indexed].some((key) => queried.has(key))).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('finds every body containing a point, at whatever level it is indexed', () => {
    // The degenerate case behind `listedBodiesNearCoord` / `resolvePlaceForCoord`: scan one cell
    // per rung and you cannot miss a body you are standing on, however big or small it is.
    fc.assert(
      fc.property(
        arbBBox,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.option(fc.integer({ min: 6, max: 14 }), { nil: undefined }),
        (body, fLat, fLng, minVisibleZoom) => {
          const point = {
            lat: body.minLat + fLat * (body.maxLat - body.minLat),
            lng: body.minLng + fLng * (body.maxLng - body.minLng),
          };
          const z = indexLevelFor(body, LADDER, minVisibleZoom);
          const cell = cellForPoint(point, z);
          expect(cellKeys(body, z)).toContain(`${cell.z}/${cell.x}/${cell.y}`);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('theorem 2 — bounded writes', () => {
  it('never writes more than 4 cells for an object at its own level', () => {
    // The write bound. Without fitLevel a long river reach on a fine rung would need hundreds of
    // rows; with it, an object spans one cell per axis and can straddle at most one boundary each.
    fc.assert(
      fc.property(
        arbBBox,
        fc.option(fc.integer({ min: 6, max: 14 }), { nil: undefined }),
        (box, visibleFrom) => {
          const z = indexLevelFor(box, LADDER, visibleFrom);
          expect(cellsCovering(box, z).length).toBeLessThanOrEqual(4);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('bounds a viewport covering at every rung it scans', () => {
    // The read bound's other half: a viewport ~one zoom-cell across covers at most 2 cells per
    // axis at any coarser rung, so a full nine-rung scan stays in the tens of index reads.
    fc.assert(
      fc.property(
        fc.double({ min: 40, max: 47, noNaN: true }),
        fc.double({ min: -79, max: -68, noNaN: true }),
        fc.integer({ min: 6, max: 14 }),
        (lat, lng, zoom) => {
          const size = cellSizeDeg(zoom);
          const viewport: BBox = {
            minLat: lat,
            maxLat: lat + size,
            minLng: lng,
            maxLng: lng + size,
          };
          for (const z of scanLevels(zoom, LADDER)) {
            expect(cellRangeCovering(viewport, z).count).toBeLessThanOrEqual(4);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
