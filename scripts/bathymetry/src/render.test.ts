import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  boundsOfLines,
  boundsOfPoints,
  boundsOfPolygon,
  fitProjection,
  isEmptyBounds,
  unionBounds,
} from './render';

const square: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72.1, 43.9],
      [-71.9, 43.9],
      [-71.9, 44.1],
      [-72.1, 44.1],
      [-72.1, 43.9],
    ],
  ],
};

describe('bounds', () => {
  it('brackets a point cloud', () => {
    expect(
      boundsOfPoints([
        { lng: -72, lat: 44 },
        { lng: -71.5, lat: 44.5 },
      ]),
    ).toEqual({ minLng: -72, maxLng: -71.5, minLat: 44, maxLat: 44.5 });
  });

  it('brackets a polygon, interior rings included', () => {
    expect(boundsOfPolygon(square)).toEqual({
      minLng: -72.1,
      maxLng: -71.9,
      minLat: 43.9,
      maxLat: 44.1,
    });
  });

  it('brackets a set of lines', () => {
    expect(
      boundsOfLines([
        [
          [-72, 44],
          [-71.8, 44.2],
        ],
      ]),
    ).toEqual({ minLng: -72, maxLng: -71.8, minLat: 44, maxLat: 44.2 });
  });

  it('reports empty rather than returning infinities that quietly propagate', () => {
    expect(isEmptyBounds(boundsOfPoints([]))).toBe(true);
    expect(isEmptyBounds(boundsOfPoints([{ lng: 1, lat: 1 }]))).toBe(false);
  });

  it('unions, skipping empties', () => {
    // The case that matters: soundings that stop well short of the bank. The union must be the LAKE,
    // not the survey — framing to the data is what pushed shorelines off the card.
    const soundings = boundsOfPoints([{ lng: -72.0, lat: 44.0 }]);
    const united = unionBounds(soundings, boundsOfPolygon(square), boundsOfPoints([]));
    expect(united).toEqual({ minLng: -72.1, maxLng: -71.9, minLat: 43.9, maxLat: 44.1 });
  });
});

describe('fitProjection', () => {
  it('frames the whole lake inside the card, padding included', () => {
    const p = fitProjection(boundsOfPolygon(square), 320, 8);
    for (const [lng, lat] of square.coordinates[0] as number[][]) {
      const x = p.x(lng as number);
      const y = p.y(lat as number);
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(p.width + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(p.height + 1e-9);
    }
  });

  it('puts north at the top', () => {
    const p = fitProjection(boundsOfPolygon(square), 320, 8);
    expect(p.y(44.1)).toBeLessThan(p.y(43.9));
  });

  it('preserves true ground aspect — a 0.2° box at 44°N is wider in degrees than in metres', () => {
    // The bug: scaling lng and lat by the same factor renders this square box as a square card, which
    // is wrong. On the ground it is ~28% narrower east-west than it is north-south.
    const p = fitProjection(boundsOfPolygon(square), 320, 0);
    expect(p.width / p.height).toBeCloseTo(Math.cos((44 * Math.PI) / 180), 2);
  });

  it('sizes the card to the lake rather than letterboxing into a square', () => {
    const wide = fitProjection(
      { minLng: -72.4, maxLng: -72.0, minLat: 44.0, maxLat: 44.05 },
      320,
      0,
    );
    expect(wide.width).toBeGreaterThan(wide.height);
    expect(Math.max(wide.width, wide.height)).toBeCloseTo(320, 6);
  });

  it('clamps a degenerate sliver and says that it did', () => {
    // Champlain: 174 km long, a few km wide. At true aspect its card is a handful of pixels tall.
    const champlainish = fitProjection(
      { minLng: -73.4, maxLng: -73.2, minLat: 43.6, maxLat: 45.0 },
      320,
      0,
      0.25,
    );
    expect(champlainish.stretched).toBe(true);
    expect(Math.min(champlainish.width, champlainish.height)).toBeCloseTo(320 * 0.25, 6);
  });

  it('leaves a well-proportioned lake unstretched', () => {
    expect(fitProjection(boundsOfPolygon(square), 320, 8).stretched).toBe(false);
  });

  it('degrades to a blank card on empty bounds rather than emitting NaN coordinates', () => {
    // A lake that failed to interpolate still has to render something; NaN in a path `d` attribute
    // silently blanks the whole SVG instead of just that lake.
    const p = fitProjection(boundsOfPoints([]), 320, 8);
    expect(Number.isFinite(p.x(-72))).toBe(true);
    expect(Number.isFinite(p.y(44))).toBe(true);
  });
});
