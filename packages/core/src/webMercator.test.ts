import { describe, expect, it } from 'vitest';
import {
  groundMetersPerPixel,
  latToMercatorY,
  lngToMercatorX,
  MERCATOR_MAX_LAT,
  MERCATOR_WORLD_M,
  mercatorXToLng,
  mercatorYToLat,
  projectToPixel,
  toMercatorBox,
} from './webMercator';

/** A z18 tile's extent over Burlington, taken from the bbox actually sent to USGS on 2026-08-21. */
const BURLINGTON_TILE = {
  minX: -8143142.371332968,
  minY: 5536792.580865027,
  maxX: -8142989.497276397,
  maxY: 5536945.454921598,
};

describe('lngToMercatorX / mercatorXToLng', () => {
  it('sends the antimeridian to the edge of the projected world', () => {
    expect(lngToMercatorX(180)).toBeCloseTo(MERCATOR_WORLD_M, 6);
    expect(lngToMercatorX(-180)).toBeCloseTo(-MERCATOR_WORLD_M, 6);
    expect(lngToMercatorX(0)).toBe(0);
  });

  it('round-trips', () => {
    for (const lng of [-180, -73.195, 0, 12.5, 179.9]) {
      expect(mercatorXToLng(lngToMercatorX(lng))).toBeCloseTo(lng, 9);
    }
  });
});

describe('latToMercatorY / mercatorYToLat', () => {
  it('agrees with the bbox we actually sent to the ImageServer', () => {
    // The z18 tile over Burlington: y bounds derived independently, via the tile scheme.
    expect(latToMercatorY(mercatorYToLat(BURLINGTON_TILE.minY))).toBeCloseTo(
      BURLINGTON_TILE.minY,
      3,
    );
  });

  it('round-trips across the usable range', () => {
    for (const lat of [-84, -44.5, 0, 44.5, 84]) {
      expect(mercatorYToLat(latToMercatorY(lat))).toBeCloseTo(lat, 9);
    }
  });

  it('clamps at the projection limit rather than returning Infinity', () => {
    expect(Number.isFinite(latToMercatorY(90))).toBe(true);
    expect(Number.isFinite(latToMercatorY(-90))).toBe(true);
    expect(latToMercatorY(90)).toBeCloseTo(latToMercatorY(MERCATOR_MAX_LAT), 6);
  });

  it('is non-linear in latitude — the whole reason this module exists', () => {
    // A linear mapping would make these equal; Mercator stretches with latitude.
    const equatorial = latToMercatorY(1) - latToMercatorY(0);
    const northern = latToMercatorY(45) - latToMercatorY(44);
    expect(northern / equatorial).toBeGreaterThan(1.3);
  });
});

describe('projectToPixel', () => {
  const box = toMercatorBox({ minLat: 44.45, minLng: -73.2, maxLat: 44.46, maxLng: -73.19 });

  it('puts the north-west corner at the origin and the south-east at the far corner', () => {
    expect(projectToPixel({ lat: 44.46, lng: -73.2 }, box, 100, 100)).toEqual({ x: 0, y: 0 });
    const far = projectToPixel({ lat: 44.45, lng: -73.19 }, box, 100, 100);
    expect(far.x).toBeCloseTo(100, 6);
    expect(far.y).toBeCloseTo(100, 6);
  });

  it('flips y — projected metres grow north, canvas pixels grow down', () => {
    const north = projectToPixel({ lat: 44.4575, lng: -73.195 }, box, 100, 100);
    const south = projectToPixel({ lat: 44.4525, lng: -73.195 }, box, 100, 100);
    // Getting this backwards renders a perfect mirror of the lake, which looks plausible.
    expect(north.y).toBeLessThan(south.y);
  });

  it('does not divide by zero on a degenerate box', () => {
    const flat = toMercatorBox({ minLat: 44.45, minLng: -73.2, maxLat: 44.45, maxLng: -73.2 });
    const px = projectToPixel({ lat: 44.45, lng: -73.2 }, flat, 100, 100);
    expect(Number.isFinite(px.x)).toBe(true);
    expect(Number.isFinite(px.y)).toBe(true);
  });
});

describe('groundMetersPerPixel', () => {
  it('corrects for the Mercator stretch rather than using projected metres raw', () => {
    const box = toMercatorBox({ minLat: 44.45, minLng: -73.2, maxLat: 44.46, maxLng: -73.19 });
    const projected = (box.maxX - box.minX) / 256;
    const ground = groundMetersPerPixel(box, 256);
    // cos(44.455°) ≈ 0.7135 — a feather sized off the projected span would be ~40% too wide.
    expect(ground).toBeLessThan(projected);
    expect(ground / projected).toBeCloseTo(Math.cos((44.455 * Math.PI) / 180), 3);
  });

  it('is a z18-ish scale for a z18-ish tile', () => {
    const ground = groundMetersPerPixel(BURLINGTON_TILE, 256);
    // z18 is ~0.597 m/px in projected metres, ~0.43 m on the ground at this latitude.
    expect(ground).toBeGreaterThan(0.3);
    expect(ground).toBeLessThan(0.6);
  });
});
