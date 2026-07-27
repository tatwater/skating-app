import fc from 'fast-check';
import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { pointInPolygon, surfaceAreaSqM } from './geometry';
import {
  clipSubAreaToParent,
  SUB_AREA_CLIP_MESSAGES,
  SUB_AREA_MIN_RETAINED_FRACTION,
  smallestContainingSubArea,
} from './subArea';

/** An axis-aligned rectangle as a GeoJSON Polygon, in the Champlain latitude band. */
function rect(minLng: number, minLat: number, maxLng: number, maxLat: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minLng, minLat],
        [maxLng, minLat],
        [maxLng, maxLat],
        [minLng, maxLat],
        [minLng, minLat],
      ],
    ],
  };
}

/** A stand-in parent body: 1° × 1° at Champlain's latitude. */
const PARENT = rect(-73.5, 44.0, -72.5, 45.0);

describe('clipSubAreaToParent', () => {
  it('stores a wholly-inside shape as drawn, without re-noding it', () => {
    const drawn = rect(-73.2, 44.2, -73.0, 44.4);
    const result = clipSubAreaToParent(drawn, PARENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Identity, not an equal-looking copy: an untouched draw must not drift through the clipper.
    expect(result.polygon).toBe(drawn);
    expect(result.clipped).toBe(false);
    expect(result.retainedFraction).toBeCloseTo(1, 6);
  });

  it('clips a shape that overhangs the parent, and reports what survived', () => {
    // The ordinary authoring case: a traced bay that cut across the shoreline, ~25% of it on land.
    const drawn = rect(-73.55, 44.2, -73.35, 44.4);
    const result = clipSubAreaToParent(drawn, PARENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clipped).toBe(true);
    expect(result.retainedFraction).toBeCloseTo(0.75, 2);
    // The stored shape is inside the parent — the whole point of Decision 10.
    expect(result.polygon).not.toBe(drawn);
  });

  it('refuses a half-in half-out draw: 40% loss is the line, and this is past it', () => {
    const result = clipSubAreaToParent(rect(-73.6, 44.2, -73.4, 44.4), PARENT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('mostly_outside');
    expect(result.retainedFraction).toBeCloseTo(0.5, 2);
  });

  it('refuses a shape that is mostly outside rather than saving the sliver', () => {
    // ~10% inside: a bay drawn on the wrong lake that happens to graze this one.
    const drawn = rect(-74.4, 44.2, -73.4, 44.4);
    const result = clipSubAreaToParent(drawn, PARENT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('mostly_outside');
    expect(result.retainedFraction).toBeLessThan(SUB_AREA_MIN_RETAINED_FRACTION);
    expect(SUB_AREA_CLIP_MESSAGES[result.reason]).toMatch(/outside/i);
  });

  it('refuses a shape that misses the parent entirely', () => {
    const result = clipSubAreaToParent(rect(-70.0, 44.2, -69.8, 44.4), PARENT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('disjoint');
  });

  it('refuses a zero-area draw', () => {
    const collapsed: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-73.2, 44.2],
          [-73.2, 44.2],
          [-73.2, 44.2],
          [-73.2, 44.2],
        ],
      ],
    };
    const result = clipSubAreaToParent(collapsed, PARENT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('degenerate');
  });

  it('honors a caller-supplied threshold in both directions', () => {
    const halfOut = rect(-73.6, 44.2, -73.4, 44.4); // ~50% retained
    expect(clipSubAreaToParent(halfOut, PARENT, 0.9).ok).toBe(false);
    expect(clipSubAreaToParent(halfOut, PARENT, 0.1).ok).toBe(true);
  });

  /**
   * The property Decision 10 rests on: whatever we accept is inside the parent. Stated over the
   * *stored* polygon's own vertices, since that's the shape everything downstream indexes and draws.
   */
  it('property: an accepted shape never has a vertex outside the parent', () => {
    fc.assert(
      fc.property(
        fc.record({
          lng: fc.double({ min: -74.0, max: -72.6, noNaN: true }),
          lat: fc.double({ min: 43.6, max: 44.9, noNaN: true }),
          w: fc.double({ min: 0.02, max: 0.6, noNaN: true }),
          h: fc.double({ min: 0.02, max: 0.6, noNaN: true }),
        }),
        ({ lng, lat, w, h }) => {
          const result = clipSubAreaToParent(rect(lng, lat, lng + w, lat + h), PARENT);
          if (!result.ok) return;
          const ring = result.polygon.type === 'Polygon' ? result.polygon.coordinates.flat() : [];
          for (const [vLng, vLat] of ring as [number, number][]) {
            // A tolerance of ~1e-8° (≈1 mm) absorbs the clipper's own re-noding rounding; the
            // failure this guards against is a whole edge outside, not a sub-millimetre one.
            expect(pointInPolygon({ lat: vLat, lng: vLng }, PARENT)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('property: retainedFraction is always a sane fraction', () => {
    fc.assert(
      fc.property(
        fc.record({
          lng: fc.double({ min: -75, max: -71, noNaN: true }),
          lat: fc.double({ min: 42, max: 47, noNaN: true }),
          w: fc.double({ min: 0.01, max: 2, noNaN: true }),
          h: fc.double({ min: 0.01, max: 2, noNaN: true }),
        }),
        ({ lng, lat, w, h }) => {
          const result = clipSubAreaToParent(rect(lng, lat, lng + w, lat + h), PARENT);
          expect(result.retainedFraction).toBeGreaterThanOrEqual(0);
          expect(result.retainedFraction).toBeLessThanOrEqual(1);
          if (result.ok) {
            expect(result.retainedFraction).toBeGreaterThanOrEqual(SUB_AREA_MIN_RETAINED_FRACTION);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('smallestContainingSubArea', () => {
  const outer = rect(-73.3, 44.5, -73.0, 44.8);
  const inner = rect(-73.2, 44.6, -73.1, 44.7);
  const candidates = [
    { ref: 'outer', polygon: outer, surfaceAreaSqM: surfaceAreaSqM(outer) },
    { ref: 'inner', polygon: inner, surfaceAreaSqM: surfaceAreaSqM(inner) },
  ];

  it('takes the smaller of two overlapping sub-areas — most specific name wins', () => {
    expect(smallestContainingSubArea({ lat: 44.65, lng: -73.15 }, candidates)).toBe('inner');
  });

  it('falls back to the containing one when the smaller does not contain the point', () => {
    expect(smallestContainingSubArea({ lat: 44.55, lng: -73.25 }, candidates)).toBe('outer');
  });

  it('returns null when no sub-area contains the point', () => {
    expect(smallestContainingSubArea({ lat: 40.0, lng: -73.15 }, candidates)).toBeNull();
  });

  it('returns null for an empty candidate set — the case for 116,068 of 116,070 bodies', () => {
    expect(smallestContainingSubArea({ lat: 44.65, lng: -73.15 }, [])).toBeNull();
  });

  /**
   * The reason this rule exists rather than first-match (Decision 9, on N1's evidence): the answer
   * must be a property of the geometry, not of which row `by_parent` happened to return first.
   */
  it('property: the answer is independent of candidate order', () => {
    fc.assert(
      fc.property(
        fc.record({
          lat: fc.double({ min: 44.4, max: 44.9, noNaN: true }),
          lng: fc.double({ min: -73.4, max: -72.9, noNaN: true }),
          shuffle: fc.boolean(),
        }),
        ({ lat, lng, shuffle }) => {
          const ordered = shuffle ? [...candidates].reverse() : candidates;
          expect(smallestContainingSubArea({ lat, lng }, ordered)).toBe(
            smallestContainingSubArea({ lat, lng }, candidates),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
