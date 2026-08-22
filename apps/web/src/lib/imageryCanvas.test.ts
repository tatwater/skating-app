import { type BBox, toMercatorBox } from '@skating/core';
import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { compositeCanvasSize, imageryCorners, MAX_COMPOSITE_PX, traceShape } from './imageryCanvas';

const REVEAL: BBox = { minLat: 44.45, minLng: -73.2, maxLat: 44.46, maxLng: -73.19 };
const REVEAL_M = toMercatorBox(REVEAL);
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

describe('compositeCanvasSize', () => {
  /** The invariant that matters: the pixel grid must match the box it is painted onto. */
  const aspectError = (box: BBox, size: { width: number; height: number }) => {
    const merc = toMercatorBox(box);
    const boxAspect = (merc.maxX - merc.minX) / (merc.maxY - merc.minY);
    return Math.abs(size.width / size.height - boxAspect) / boxAspect;
  };

  it('always matches the Mercator aspect — a mismatch stretches every feature in the image', () => {
    for (const box of [
      REVEAL,
      // Champlain-shaped: very tall, very narrow — the worst case, and the one that showed it.
      { minLat: 43.6, minLng: -73.45, maxLat: 45.05, maxLng: -73.15 },
      // And the opposite, a wide shallow box.
      { minLat: 44.45, minLng: -73.6, maxLat: 44.47, maxLng: -72.9 },
    ]) {
      const merc = toMercatorBox(box);
      expect(
        aspectError(box, compositeCanvasSize(merc, (merc.maxX - merc.minX) / 1200)),
      ).toBeLessThan(0.01);
    }
  });

  it('does not derive height from degrees, which is a 40% error at our latitude', () => {
    const tall = { minLat: 43.6, minLng: -73.45, maxLat: 45.05, maxLng: -73.15 };
    const merc = toMercatorBox(tall);
    const size = compositeCanvasSize(merc, (merc.maxX - merc.minX) / 1200);
    const degreeAspect = (tall.maxLng - tall.minLng) / (tall.maxLat - tall.minLat);
    expect(Math.abs(size.width / size.height - degreeAspect)).toBeGreaterThan(0.05);
  });

  it('sizes to the requested sharpness', () => {
    const span = REVEAL_M.maxX - REVEAL_M.minX;
    expect(compositeCanvasSize(REVEAL_M, span / 800).width).toBe(800);
  });

  it('clamps the longer side and lets the other follow, so the cap cannot skew the aspect', () => {
    const tall = toMercatorBox({ minLat: 43.6, minLng: -73.45, maxLat: 45.05, maxLng: -73.15 });
    // 0.3 m/px over ~160 km of latitude would be a half-million-pixel canvas.
    const size = compositeCanvasSize(tall, 0.3);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(MAX_COMPOSITE_PX);
    expect(
      Math.abs(size.width / size.height - (tall.maxX - tall.minX) / (tall.maxY - tall.minY)),
    ).toBeLessThan(0.5);
  });

  it('a 4,096-square texture is 67 MB, so the cap is a memory budget and not a nicety', () => {
    expect(MAX_COMPOSITE_PX).toBeLessThanOrEqual(4096);
  });

  it('is at least one pixel — a zero-size canvas throws in MapLibre', () => {
    const tiny = toMercatorBox({
      minLat: 44.45,
      minLng: -73.2,
      maxLat: 44.4500001,
      maxLng: -73.1999999,
    });
    const size = compositeCanvasSize(tiny, 1000);
    expect(size.width).toBeGreaterThanOrEqual(1);
    expect(size.height).toBeGreaterThanOrEqual(1);
  });

  it('survives a nonsense sharpness rather than producing NaN', () => {
    for (const mpp of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const size = compositeCanvasSize(REVEAL_M, mpp);
      expect(Number.isFinite(size.width)).toBe(true);
      expect(size.width).toBeGreaterThanOrEqual(1);
      expect(size.height).toBeGreaterThanOrEqual(1);
    }
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
    traceShape(ctx, POND, REVEAL_M, 100, 100);
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
    traceShape(ctx, withIsland, REVEAL_M, 100, 100);
    expect(calls.filter((c) => c.op === 'close')).toHaveLength(1);
  });

  it('keeps every polygon of a multipolygon', () => {
    const { calls, ctx } = recorder();
    traceShape(
      ctx,
      { type: 'MultiPolygon', coordinates: [POND.coordinates, POND.coordinates] as never },
      REVEAL_M,
      100,
      100,
    );
    expect(calls.filter((c) => c.op === 'close')).toHaveLength(2);
  });

  it('does not open its own path, so many bodies can be traced into one fill', () => {
    // The whole reason one fetch can serve a viewport of lakes: nonzero winding unions them, so
    // there is no geometric union to compute. A `beginPath` here would erase the previous shape.
    const { calls, ctx } = recorder();
    traceShape(ctx, POND, REVEAL_M, 100, 100);
    expect(calls.filter((c) => c.op === 'begin')).toHaveLength(0);
  });
});
