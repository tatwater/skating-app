import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  largestRingSize,
  MAX_RING_VERTICES,
  maxArrayLength,
  simplifyForStorage,
} from './polygonStorage';

describe('polygon storage', () => {
  const ring = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ];

  it('counts rings and components even if every ring fits on its own', () => {
    const withHoles: Polygon = {
      type: 'Polygon',
      coordinates: Array.from({ length: 6 }, () => ring),
    };
    const manyComponents: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: Array.from({ length: 7 }, () => [ring]),
    };
    expect(largestRingSize(withHoles)).toBe(4);
    expect(largestRingSize(manyComponents)).toBe(4);
    expect(maxArrayLength(withHoles)).toBe(6);
    expect(maxArrayLength(manyComponents)).toBe(7);
  });

  it('finds the longest ring, including holes in a later component', () => {
    const hole = [...ring, [0, 0]];
    const polygon: MultiPolygon = { type: 'MultiPolygon', coordinates: [[ring], [ring, hole]] };
    expect(largestRingSize(polygon)).toBe(5);
    expect(maxArrayLength(polygon)).toBe(5);
  });

  it('simplifies a copy so callers can still measure the original geometry', () => {
    const polygon: Polygon = {
      type: 'Polygon',
      coordinates: [[[0, 0], [0.5, 0.000001], ...ring.slice(1)]],
    };
    const original = structuredClone(polygon);
    expect(simplifyForStorage(polygon)).toEqual({ type: 'Polygon', coordinates: [ring] });
    expect(polygon).toEqual(original);
  });

  it('coarsens a ring whose sharp detail would survive the baseline over the limit', () => {
    const positionCount = 9000;
    const denseRing = Array.from({ length: positionCount + 1 }, (_, index) => {
      const position = index % positionCount; // Repeat the first position to close the ring.
      const angle = (position / positionCount) * 2 * Math.PI;
      const radius = position % 2 === 0 ? 0.5 : 0.5003;
      return [-72 + radius * Math.cos(angle), 44 + radius * Math.sin(angle)];
    });
    const polygon: Polygon = { type: 'Polygon', coordinates: [denseRing] };
    expect(largestRingSize(polygon)).toBeGreaterThan(MAX_RING_VERTICES);
    expect(largestRingSize(simplifyForStorage(polygon))).toBeLessThanOrEqual(MAX_RING_VERTICES);
    // The water ETL's original fixture reached 31.6 s under CI contention (PR #67).
  }, 120_000);
});
