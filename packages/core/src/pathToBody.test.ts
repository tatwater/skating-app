import fc from 'fast-check';
import type { LineString } from 'geojson';
import { describe, expect, it } from 'vitest';
import { bboxIntersects, pointInPolygon } from './geometry';
import { PATH_BUFFER_M, pathToBody } from './pathToBody';

const LAT = 43.9;
const LNG = -72.15;
const DEG_PER_M = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));

/** A straight eastward skate `n` points long, `stepM` apart. */
function line(n: number, stepM = 100): LineString {
  return {
    type: 'LineString',
    coordinates: Array.from({ length: n }, (_, i) => [LNG + i * stepM * DEG_PER_M, LAT]),
  };
}

/** A lap around a small pond. */
function loop(): LineString {
  const d = 300 * DEG_PER_M;
  return {
    type: 'LineString',
    coordinates: [
      [LNG, LAT],
      [LNG + d, LAT],
      [LNG + d, LAT + d * 0.7],
      [LNG, LAT + d * 0.7],
      [LNG, LAT],
    ],
  };
}

describe('pathToBody', () => {
  it('derives a polygon, an on-water centroid, a bbox and an area from a track', () => {
    const derived = pathToBody(line(10));
    expect(derived).not.toBeNull();
    if (!derived) return;
    expect(['Polygon', 'MultiPolygon']).toContain(derived.polygon.type);
    expect(derived.surfaceAreaSqM).toBeGreaterThan(0);
    expect(bboxIntersects(derived.bbox, derived.bbox)).toBe(true);
  });

  it('puts the centroid INSIDE the polygon (D48) — never a mean that could land on land', () => {
    for (const path of [line(10), loop(), line(3, 2000)]) {
      const derived = pathToBody(path);
      expect(derived).not.toBeNull();
      if (!derived) continue;
      expect(pointInPolygon(derived.centroid, derived.polygon)).toBe(true);
    }
  });

  it('the derived shape contains the track it came from', () => {
    const path = loop();
    const derived = pathToBody(path);
    expect(derived).not.toBeNull();
    if (!derived) return;
    for (const [lng, lat] of path.coordinates as [number, number][]) {
      expect(pointInPolygon({ lat, lng }, derived.polygon)).toBe(true);
    }
  });

  it('a lap around a pond fills in — a hole at the lake centre would break later resolution', () => {
    const derived = pathToBody(loop());
    expect(derived).not.toBeNull();
    if (!derived) return;
    // The middle of the lap is enclosed by the buffered corridor at this scale.
    const d = 300 * DEG_PER_M;
    expect(pointInPolygon({ lat: LAT + d * 0.35, lng: LNG + d / 2 }, derived.polygon)).toBe(true);
  });

  it('under-claims rather than over-claims: a straight crossing stays a corridor', () => {
    // 10 km straight line. A convex hull would claim nothing extra here, but the point is the width:
    // the shape is ~2× the buffer wide, not a lake-sized blob.
    const derived = pathToBody(line(2, 10_000));
    expect(derived).not.toBeNull();
    if (!derived) return;
    const widthDeg = derived.bbox.maxLat - derived.bbox.minLat;
    const widthM = widthDeg * 111_320;
    expect(widthM).toBeGreaterThan(PATH_BUFFER_M);
    expect(widthM).toBeLessThan(PATH_BUFFER_M * 3);
  });

  it('a wider buffer produces a larger body — the one knob that tunes generosity', () => {
    const narrow = pathToBody(line(10), { bufferMeters: 50 });
    const wide = pathToBody(line(10), { bufferMeters: 200 });
    expect(narrow).not.toBeNull();
    expect(wide).not.toBeNull();
    if (!narrow || !wide) return;
    expect(wide.surfaceAreaSqM).toBeGreaterThan(narrow.surfaceAreaSqM);
  });

  it('returns null for a path too short or degenerate to be new water', () => {
    expect(pathToBody({ type: 'LineString', coordinates: [] })).toBeNull();
    expect(pathToBody({ type: 'LineString', coordinates: [[LNG, LAT]] })).toBeNull();
    // A "recording" that never moved: every fix identical. Turf will happily buffer this into a
    // perfect circle, which is exactly the parking-lot pond the extent guard exists to refuse.
    expect(
      pathToBody({
        type: 'LineString',
        coordinates: [
          [LNG, LAT],
          [LNG, LAT],
          [LNG, LAT],
        ],
      }),
    ).toBeNull();
    // ...and one that shuffled a few metres is still not a skate.
    expect(pathToBody(line(3, 5))).toBeNull();
  });

  it('property: never throws, and any result is self-consistent', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            dLng: fc.double({ min: -0.05, max: 0.05, noNaN: true }),
            dLat: fc.double({ min: -0.05, max: 0.05, noNaN: true }),
          }),
          { maxLength: 30 },
        ),
        (steps) => {
          const coords = steps.map((s) => [LNG + s.dLng, LAT + s.dLat]);
          const derived = pathToBody({ type: 'LineString', coordinates: coords });
          if (derived === null) return;
          expect(derived.surfaceAreaSqM).toBeGreaterThan(0);
          expect(pointInPolygon(derived.centroid, derived.polygon)).toBe(true);
          expect(derived.bbox.minLat).toBeLessThanOrEqual(derived.bbox.maxLat);
          expect(derived.bbox.minLng).toBeLessThanOrEqual(derived.bbox.maxLng);
        },
      ),
    );
  });
});
