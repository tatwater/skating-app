import { fitGridLevel, imageryTilesFor, tileKey, toMercatorBox } from '@skating/core';
import { describe, expect, it } from 'vitest';
import { tileUrl } from './imageryCache';

const VIEW = toMercatorBox({ minLat: 44.453, maxLat: 44.498, minLng: -73.26, maxLng: -73.2 });

describe('tileUrl', () => {
  it('is a pure function of the cell address — the property the whole cache rests on', () => {
    // Measured 2026-08-21: an identical URL is 0.08 s off CloudFront against 29.3 s for a render.
    // If this ever stops holding, every fetch silently goes back to being a cold render.
    const [tile] = imageryTilesFor(VIEW, 13);
    expect(tile).toBeDefined();
    if (!tile) return;
    expect(tileUrl(tile)).toBe(tileUrl({ ...tile, box: { ...tile.box } }));
  });

  it('does not vary with the camera that happened to ask for it', () => {
    // Two different viewports landing on the same cell must produce the same string. This is the
    // exact case the pre-grid code got wrong: bbox came from `map.getBounds()`, so it never repeated.
    const nudged = { ...VIEW, minX: VIEW.minX + 137, maxX: VIEW.maxX + 137 };
    const a = imageryTilesFor(VIEW, 12);
    const b = imageryTilesFor(nudged, 12);
    expect(b.map(tileKey)).toEqual(a.map(tileKey));
    expect(b.map(tileUrl)).toEqual(a.map(tileUrl));
  });

  it('differs between neighbouring cells', () => {
    const tiles = imageryTilesFor({ ...VIEW, maxX: VIEW.maxX + 40_000 }, 12);
    expect(tiles.length).toBeGreaterThan(1);
    expect(new Set(tiles.map(tileUrl)).size).toBe(tiles.length);
  });

  it('always asks for a square at the grid size, so the aspect can never mismatch', () => {
    // `exportImage` silently widens the extent when size and bbox disagree, reporting it only in
    // `f=json` — a cell is square in Mercator, so a square request is the one that stays honest.
    const { tiles } = fitGridLevel(VIEW, 2);
    for (const tile of tiles) {
      expect(tileUrl(tile)).toContain('size=2048%2C2048');
    }
  });

  it('carries the projected bbox and asks for jpg', () => {
    const [tile] = imageryTilesFor(VIEW, 13);
    if (!tile) throw new Error('no tile');
    const url = tileUrl(tile);
    expect(url).toContain('bboxSR=3857');
    expect(url).toContain('format=jpg');
  });
});
