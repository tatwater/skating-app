import { describe, expect, it } from 'vitest';
import {
  AERIAL_MAX_GRID_LEVEL,
  AERIAL_TILE_PX,
  fitGridLevel,
  gridResolution,
  gridSpan,
  imageryGridLevel,
  imageryTilesFor,
  tileBox,
  tileKey,
  tilesBounds,
} from './imageryTiles';
import { toMercatorBox } from './webMercator';

/** Burlington waterfront, ~5 km across — an ordinary lake view. */
const BURLINGTON = toMercatorBox({
  minLat: 44.453,
  maxLat: 44.498,
  minLng: -73.26,
  maxLng: -73.2,
});

describe('the grid ladder', () => {
  it('lands on NAIP resolution at the sharpest level', () => {
    // The whole reason the ceiling is 16: asking for more upsamples and returns no more information.
    expect(gridResolution(AERIAL_MAX_GRID_LEVEL)).toBeCloseTo(0.3, 1);
  });

  it('halves the span and the resolution at each level', () => {
    expect(gridSpan(11)).toBeCloseTo(gridSpan(10) / 2);
    expect(gridResolution(11)).toBeCloseTo(gridResolution(10) / 2);
  });

  it('picks a level at least as sharp as asked, never coarser', () => {
    for (const target of [0.5, 1, 2.6, 10, 60, 400]) {
      const level = imageryGridLevel(target);
      expect(gridResolution(level)).toBeLessThanOrEqual(target);
    }
  });

  it('clamps rather than running past NAIP, or below the world', () => {
    expect(imageryGridLevel(0.01)).toBe(AERIAL_MAX_GRID_LEVEL);
    expect(imageryGridLevel(1e9)).toBe(0);
  });

  it('answers the sharpest level for nonsense input rather than NaN', () => {
    // A degenerate box divides to 0 or NaN upstream; the safe direction is a small sharp request,
    // not `2 ** NaN` cells.
    expect(imageryGridLevel(0)).toBe(AERIAL_MAX_GRID_LEVEL);
    expect(imageryGridLevel(Number.NaN)).toBe(AERIAL_MAX_GRID_LEVEL);
    expect(imageryGridLevel(-5)).toBe(AERIAL_MAX_GRID_LEVEL);
  });
});

describe('tile addressing', () => {
  it('is stable — the same ground is the same key, which is the point of the module', () => {
    const once = imageryTilesFor(BURLINGTON, 14);
    const again = imageryTilesFor({ ...BURLINGTON }, 14);
    expect(once.map(tileKey)).toEqual(again.map(tileKey));
  });

  it('a one-metre shift of the view does NOT change the cells', () => {
    // The exact case that made every request a cold render before the grid existed.
    const shifted = {
      minX: BURLINGTON.minX + 1,
      maxX: BURLINGTON.maxX + 1,
      minY: BURLINGTON.minY,
      maxY: BURLINGTON.maxY,
    };
    expect(imageryTilesFor(shifted, 12).map(tileKey)).toEqual(
      imageryTilesFor(BURLINGTON, 12).map(tileKey),
    );
  });

  it('tiles tile — every cell abuts its neighbour with no gap and no overlap', () => {
    const a = tileBox(12, 1200, 1500);
    const right = tileBox(12, 1201, 1500);
    const below = tileBox(12, 1200, 1501);
    expect(right.minX).toBeCloseTo(a.maxX, 6);
    expect(below.maxY).toBeCloseTo(a.minY, 6);
  });

  it('row 0 is the north edge of the world', () => {
    expect(tileBox(3, 0, 0).maxY).toBeCloseTo(gridSpan(0) / 2, 6);
    expect(tileBox(3, 0, 0).minX).toBeCloseTo(-gridSpan(0) / 2, 6);
  });

  it('covers the box it was asked about', () => {
    const tiles = imageryTilesFor(BURLINGTON, 14);
    const bounds = tilesBounds(tiles);
    expect(bounds).not.toBeNull();
    expect(bounds?.minX).toBeLessThanOrEqual(BURLINGTON.minX);
    expect(bounds?.maxX).toBeGreaterThanOrEqual(BURLINGTON.maxX);
    expect(bounds?.minY).toBeLessThanOrEqual(BURLINGTON.minY);
    expect(bounds?.maxY).toBeGreaterThanOrEqual(BURLINGTON.maxY);
  });

  it('clamps at the world edge rather than wrapping', () => {
    const world = { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 };
    const tiles = imageryTilesFor(world, 2);
    expect(tiles).toHaveLength(16);
    expect(tiles.every((t) => t.x >= 0 && t.x < 4 && t.y >= 0 && t.y < 4)).toBe(true);
  });

  it('tilesBounds is null for no tiles, not an inverted box', () => {
    expect(tilesBounds([])).toBeNull();
  });
});

describe('fitGridLevel', () => {
  it('keeps an ordinary lake view inside the concurrency budget', () => {
    const metersPerPixel = (BURLINGTON.maxX - BURLINGTON.minX) / 1920;
    const { tiles } = fitGridLevel(BURLINGTON, metersPerPixel);
    expect(tiles.length).toBeLessThanOrEqual(4);
    expect(tiles.length).toBeGreaterThan(0);
  });

  it('steps DOWN a level rather than dropping cells', () => {
    // A photograph with four of nine cells missing reads as broken; uniformly coarser reads as
    // zoomed out. This is that choice, pinned.
    const wide = toMercatorBox({ minLat: 43.5, maxLat: 45.1, minLng: -73.6, maxLng: -71.5 });
    const sharp = fitGridLevel(wide, 0.3, 4);
    expect(sharp.tiles.length).toBeLessThanOrEqual(4);
    expect(sharp.level).toBeLessThan(imageryGridLevel(0.3));
    // Still complete coverage at the coarser level.
    const bounds = tilesBounds(sharp.tiles);
    expect(bounds?.minX).toBeLessThanOrEqual(wide.minX);
    expect(bounds?.maxX).toBeGreaterThanOrEqual(wide.maxX);
  });

  it('terminates at level 0 rather than looping when even one cell is over budget', () => {
    const world = { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 };
    const { level, tiles } = fitGridLevel(world, 0.3, 0);
    expect(level).toBe(0);
    expect(tiles).toHaveLength(1);
  });

  it('a cell is always renderable in one exportImage call', () => {
    // AERIAL_MAX_EXPORT_PX is 4,000; anything above it silently returns a smaller image, which
    // would rescale the alpha mask against the wrong pixels.
    expect(AERIAL_TILE_PX).toBeLessThanOrEqual(4000);
  });
});
