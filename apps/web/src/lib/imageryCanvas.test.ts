import { type BBox, groundMetersPerPixel, toMercatorBox } from '@skating/core';
import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  composeImagery,
  compositeCanvasSize,
  imageryCorners,
  MASK_SCALE,
  MAX_COMPOSITE_PX,
  traceShape,
} from './imageryCanvas';

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

/** A canvas stub that records every drawing call and every state assignment. */
function fakeCanvas(width = 0, height = 0) {
  const ops: Record<string, unknown>[] = [];
  const state: Record<string, unknown> = {};
  const ctx = {
    clearRect: () => ops.push({ op: 'clearRect' }),
    drawImage: (image: unknown, ...rest: number[]) => ops.push({ op: 'drawImage', image, rest }),
    beginPath: () => ops.push({ op: 'beginPath' }),
    closePath: () => ops.push({ op: 'closePath' }),
    moveTo: (x: number, y: number) => ops.push({ op: 'moveTo', x, y }),
    lineTo: (x: number, y: number) => ops.push({ op: 'lineTo', x, y }),
    arc: (x: number, y: number, r: number) => ops.push({ op: 'arc', x, y, r }),
    fill: () => ops.push({ op: 'fill' }),
    stroke: () =>
      ops.push({
        op: 'stroke',
        lineWidth: state.lineWidth,
        lineJoin: state.lineJoin,
        lineCap: state.lineCap,
      }),
    save: () => ops.push({ op: 'save' }),
    restore: () => ops.push({ op: 'restore' }),
  } as Record<string, unknown>;
  for (const key of [
    'lineWidth',
    'lineJoin',
    'lineCap',
    'fillStyle',
    'strokeStyle',
    'globalCompositeOperation',
    'filter',
  ]) {
    Object.defineProperty(ctx, key, {
      get: () => state[key] ?? 'none',
      set: (value) => {
        state[key] = value;
        ops.push({ op: `set:${key}`, value });
      },
      enumerable: true,
      configurable: true,
    });
  }
  const canvas = {
    width,
    height,
    getContext: () => ctx as unknown as CanvasRenderingContext2D,
  } as unknown as HTMLCanvasElement;
  return { canvas, ops, state };
}

const TILE_IMAGE = {} as CanvasImageSource;

function compose(masks: Parameters<typeof composeImagery>[0]['masks'], clip = true) {
  const target = fakeCanvas(1000, 1000);
  const mask = fakeCanvas();
  const feathered = composeImagery({
    canvas: target.canvas,
    maskCanvas: mask.canvas,
    tiles: [{ tile: { level: 12, x: 0, y: 0, box: REVEAL_M }, image: TILE_IMAGE }],
    bounds: REVEAL_M,
    masks,
    solidMeters: 20,
    featherMeters: 80,
    clip,
  });
  return { target, mask, feathered };
}

describe('composeImagery — the buffer is rasterised, not geometry', () => {
  it('dilates a lake by stroking its own ring at twice the buffer', () => {
    // The whole reason `revealShape`'s Turf buffer left the render path: a stroke is centred on its
    // path, so fill + stroke(2 × solid) IS the ring dilated outward by `solid` — at rasteriser cost
    // rather than fifty geodesic buffers on the main thread, and portable to a canvas with no Turf.
    const { mask } = compose([{ polygon: POND }]);
    const stroke = mask.ops.find((o) => o.op === 'stroke');
    expect(stroke).toBeDefined();

    const groundPerPixel = groundMetersPerPixel(REVEAL_M, 1000);
    const expected = (20 / groundPerPixel) * MASK_SCALE * 2;
    expect(stroke?.lineWidth as number).toBeCloseTo(expected, 4);
  });

  it('rounds its joins, so a spit of shoreline cannot grow a mitre spike', () => {
    const { mask } = compose([{ polygon: POND }]);
    const stroke = mask.ops.find((o) => o.op === 'stroke');
    expect(stroke?.lineJoin).toBe('round');
    expect(stroke?.lineCap).toBe('round');
  });

  it('fills as well as strokes — the stroke is the ring, the fill is the water', () => {
    const { mask } = compose([{ polygon: POND }]);
    expect(mask.ops.filter((o) => o.op === 'fill').length).toBeGreaterThanOrEqual(1);
  });

  it('covers the walk and the parking, which is what D146 asked for', () => {
    const { mask } = compose([
      {
        polygon: POND,
        approachPaths: [
          [
            { lat: 44.451, lng: -73.199 },
            { lat: 44.452, lng: -73.198 },
          ],
        ],
        parkingCoords: [{ lat: 44.4515, lng: -73.1985 }],
        markerCoords: [{ lat: 44.4525, lng: -73.1975 }],
      },
    ]);
    // Two strokes: the shoreline ring and the approach line.
    expect(mask.ops.filter((o) => o.op === 'stroke')).toHaveLength(2);
    // A disc each for the lot and the put-in, at the buffer radius.
    expect(mask.ops.filter((o) => o.op === 'arc')).toHaveLength(2);
  });

  it('ignores a one-point approach — a marker that lost its other end', () => {
    const { mask } = compose([{ polygon: POND, approachPaths: [[{ lat: 44.451, lng: -73.199 }]] }]);
    expect(mask.ops.filter((o) => o.op === 'stroke')).toHaveLength(1);
  });

  it('unions many bodies by overlapping alpha, with no geometry to merge', () => {
    const { mask } = compose([{ polygon: POND }, { polygon: POND }]);
    expect(mask.ops.filter((o) => o.op === 'stroke')).toHaveLength(2);
  });

  it('applies the mask with one destination-in, never a fill and then a stroke', () => {
    // Two sequential `destination-in` passes would INTERSECT — keeping only the interior and
    // throwing the buffer ring away. That is why the mask is assembled on its own canvas first.
    const { target } = compose([{ polygon: POND }]);
    const composites = target.ops.filter((o) => o.op === 'set:globalCompositeOperation');
    expect(composites).toHaveLength(1);
    expect(composites[0]?.value).toBe('destination-in');
    // The tile, then the finished mask.
    expect(target.ops.filter((o) => o.op === 'drawImage')).toHaveLength(2);
  });

  it('feathers in ground metres, so the ramp does not change width with the zoom', () => {
    const { target, feathered } = compose([{ polygon: POND }]);
    expect(feathered).toBe(true);
    const blur = target.ops.find((o) => o.op === 'set:filter');
    const groundPerPixel = groundMetersPerPixel(REVEAL_M, 1000);
    expect(blur?.value).toBe(`blur(${(80 / 2 / groundPerPixel).toFixed(2)}px)`);
  });

  it('skips the mask entirely when unmasked — the editor needs the ground past the line', () => {
    const { target, mask, feathered } = compose([{ polygon: POND }], false);
    expect(feathered).toBe(false);
    expect(mask.ops).toHaveLength(0);
    expect(target.ops.filter((o) => o.op === 'set:globalCompositeOperation')).toHaveLength(0);
  });
});
