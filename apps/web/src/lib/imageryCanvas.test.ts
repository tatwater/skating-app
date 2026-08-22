import { type BBox, toMercatorBox } from '@skating/core';
import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { imageryCanvasSize, imageryCorners, imageryViewBox, traceShape } from './imageryCanvas';

const REVEAL: BBox = { minLat: 44.45, minLng: -73.2, maxLat: 44.46, maxLng: -73.19 };
const POND: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-73.2, 44.45],
      [-73.19, 44.45],
      [-73.19, 44.46],
      [-73.2, 44.46],
      [-73.2, 44.45],
    ],
  ],
};

describe('imageryViewBox', () => {
  it('never asks for more ground than the reveal, however far out the map is', () => {
    // The pond is 400 m of a 200 km view — fetching the view would render half of Vermont.
    const region: BBox = { minLat: 42, minLng: -75, maxLat: 46, maxLng: -71 };
    const box = imageryViewBox(region, REVEAL);
    expect(box).toEqual(REVEAL);
  });

  it('follows the view when zoomed inside the reveal', () => {
    const zoomed: BBox = { minLat: 44.453, minLng: -73.197, maxLat: 44.456, maxLng: -73.194 };
    const box = imageryViewBox(zoomed, REVEAL);
    // Padded beyond the view, but still inside the reveal.
    expect(box?.minLat).toBeLessThan(zoomed.minLat);
    expect(box?.maxLat).toBeGreaterThan(zoomed.maxLat);
    expect(box?.minLat).toBeGreaterThanOrEqual(REVEAL.minLat);
    expect(box?.maxLat).toBeLessThanOrEqual(REVEAL.maxLat);
  });

  it('is null when the reveal is off screen — a zero-width request is an error, not a blank', () => {
    const elsewhere: BBox = { minLat: 40, minLng: -80, maxLat: 41, maxLng: -79 };
    expect(imageryViewBox(elsewhere, REVEAL)).toBeNull();
  });
});

describe('imageryCanvasSize', () => {
  const viewport = { width: 1200, height: 800 };

  /** The invariant that matters: the pixel grid must match the bbox the URL asks for. */
  const aspectMatchesBox = (box: BBox, size: { width: number; height: number }) => {
    const merc = toMercatorBox(box);
    const boxAspect = (merc.maxX - merc.minX) / (merc.maxY - merc.minY);
    return Math.abs(size.width / size.height - boxAspect) / boxAspect;
  };

  it('always matches the Mercator aspect — a mismatch makes the service widen the extent', () => {
    // Measured 2026-08-21: a 3000x3000 m bbox asked for at 512x300 came back covering 5120x3000 m,
    // announced only in `f=json`. Painting that on the requested corners is the misregistration.
    for (const box of [
      { minLat: 44.45, minLng: -73.2, maxLat: 44.46, maxLng: -73.19 },
      // Champlain-shaped: very tall, very narrow — the worst case, and the one that showed it.
      { minLat: 43.6, minLng: -73.45, maxLat: 45.05, maxLng: -73.15 },
      // And the opposite, a wide shallow box.
      { minLat: 44.45, minLng: -73.6, maxLat: 44.47, maxLng: -72.9 },
    ]) {
      expect(aspectMatchesBox(box, imageryCanvasSize(box, box, viewport, 2))).toBeLessThan(0.01);
    }
  });

  it('does not derive height from degrees, which is a 40% error at our latitude', () => {
    const tall = { minLat: 43.6, minLng: -73.45, maxLat: 45.05, maxLng: -73.15 };
    const size = imageryCanvasSize(tall, tall, viewport, 1);
    const degreeAspect = (tall.maxLng - tall.minLng) / (tall.maxLat - tall.minLat);
    // Mercator stretches latitude by 1/cos(phi); a degrees-derived height would be visibly wider.
    expect(Math.abs(size.width / size.height - degreeAspect)).toBeGreaterThan(0.05);
  });

  it('sizes width to the box share of the viewport, at device pixel ratio', () => {
    const size = imageryCanvasSize(REVEAL, REVEAL, viewport, 2);
    expect(size.width).toBe(2400);
  });

  it('shrinks with the box when the reveal is a small part of the view', () => {
    const region: BBox = { minLat: 42, minLng: -75, maxLat: 46, maxLng: -71 };
    const size = imageryCanvasSize(REVEAL, region, viewport, 1);
    expect(size.width).toBeLessThan(100);
    expect(size.width).toBeGreaterThan(0);
  });

  it('clamps the longer side and lets the other follow, so the cap cannot skew the aspect', () => {
    const tall: BBox = { minLat: 43.6, minLng: -73.45, maxLat: 45.05, maxLng: -73.15 };
    const size = imageryCanvasSize(tall, tall, { width: 8000, height: 8000 }, 3);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(4000);
    expect(aspectMatchesBox(tall, size)).toBeLessThan(0.01);
  });

  it('is at least one pixel — a zero-size canvas throws in MapLibre', () => {
    const tiny: BBox = { minLat: 44.45, minLng: -73.2, maxLat: 44.4500001, maxLng: -73.1999999 };
    const region: BBox = { minLat: 42, minLng: -75, maxLat: 46, maxLng: -71 };
    const size = imageryCanvasSize(tiny, region, viewport, 1);
    expect(size.width).toBeGreaterThanOrEqual(1);
    expect(size.height).toBeGreaterThanOrEqual(1);
  });
});

describe('imageryCorners', () => {
  it('is top-left, top-right, bottom-right, bottom-left — the order MapLibre expects', () => {
    expect(imageryCorners(REVEAL)).toEqual([
      [-73.2, 44.46],
      [-73.19, 44.46],
      [-73.19, 44.45],
      [-73.2, 44.45],
    ]);
  });
});

describe('traceShape', () => {
  /** A recording stub — enough to assert the path, without a DOM canvas. */
  function recorder() {
    const calls: { op: string; x?: number; y?: number }[] = [];
    return {
      calls,
      ctx: {
        beginPath: () => calls.push({ op: 'begin' }),
        closePath: () => calls.push({ op: 'close' }),
        moveTo: (x: number, y: number) => calls.push({ op: 'move', x, y }),
        lineTo: (x: number, y: number) => calls.push({ op: 'line', x, y }),
      } as unknown as CanvasRenderingContext2D,
    };
  }

  it('traces the ring in the box pixel space, north-west at the origin', () => {
    const { calls, ctx } = recorder();
    traceShape(ctx, POND, REVEAL, 100, 100);
    const move = calls.find((c) => c.op === 'move');
    // The pond's first vertex is its south-west corner ⇒ x=0, y=100 (y grows downward).
    expect(move?.x).toBeCloseTo(0, 6);
    expect(move?.y).toBeCloseTo(100, 6);
  });

  it('drops island rings — they are part of what the photograph shows', () => {
    const withIsland: Polygon = {
      type: 'Polygon',
      coordinates: [
        POND.coordinates[0] as number[][],
        [
          [-73.196, 44.454],
          [-73.194, 44.454],
          [-73.194, 44.456],
          [-73.196, 44.454],
        ],
      ],
    };
    const { calls, ctx } = recorder();
    traceShape(ctx, withIsland, REVEAL, 100, 100);
    // One ring traced ⇒ exactly one `closePath`.
    expect(calls.filter((c) => c.op === 'close')).toHaveLength(1);
  });

  it('keeps every polygon of a multipolygon', () => {
    const { calls, ctx } = recorder();
    traceShape(
      ctx,
      { type: 'MultiPolygon', coordinates: [POND.coordinates, POND.coordinates] as never },
      REVEAL,
      100,
      100,
    );
    expect(calls.filter((c) => c.op === 'close')).toHaveLength(2);
  });
});
