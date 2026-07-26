import fc from 'fast-check';
import type { LineString, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  classifyDedup,
  DEDUP_THRESHOLDS,
  type DedupShape,
  nameSimilarity,
  scoreDedupPair,
} from './dedup';
import { polygonBBox } from './geometry';

/** A square polygon of `size` degrees with its lower-left corner at (`lng`, `lat`). */
function square(lng: number, lat: number, size: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lng, lat],
        [lng + size, lat],
        [lng + size, lat + size],
        [lng, lat + size],
        [lng, lat],
      ],
    ],
  };
}

function shape(
  name: string,
  geometry: Polygon | LineString,
  centroid?: [number, number],
): DedupShape {
  const bbox = polygonBBox(geometry);
  return {
    name,
    geometry,
    centroid: centroid
      ? { lng: centroid[0], lat: centroid[1] }
      : { lng: (bbox.minLng + bbox.maxLng) / 2, lat: (bbox.minLat + bbox.maxLat) / 2 },
    bbox,
  };
}

const withRef = <T extends DedupShape>(s: T, ref: string, official = false) => ({
  ...s,
  ref,
  official,
});

describe('nameSimilarity', () => {
  it('is 1 for identical names and for word-order variants', () => {
    expect(nameSimilarity('Lake Morey', 'Lake Morey')).toBe(1);
    // The generic word is stripped, so ordering stops mattering — the most common way one lake gets
    // typed two ways.
    expect(nameSimilarity('Lake Morey', 'Morey Lake')).toBe(1);
  });

  it('ignores case and punctuation', () => {
    expect(nameSimilarity("Joe's Pond", 'joes pond')).toBeGreaterThan(0.9);
  });

  it('does not score two different lakes as similar just because both are "Lake"', () => {
    // Without stripping the generic word these would share a big chunk of their bigrams.
    expect(nameSimilarity('Lake Morey', 'Lake Champlain')).toBeLessThan(DEDUP_THRESHOLDS.nameBoost);
    expect(nameSimilarity('Mud Pond', 'Spring Pond')).toBeLessThan(DEDUP_THRESHOLDS.nameBoost);
  });

  it('treats an absent name as no evidence, not as agreement', () => {
    expect(nameSimilarity('', '')).toBe(0);
    expect(nameSimilarity('Lake Morey', '')).toBe(0);
    // A name that is *only* a generic word normalizes to empty — still no evidence.
    expect(nameSimilarity('Pond', 'Lake')).toBe(0);
  });

  it('property: symmetric, and always within [0, 1]', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 24 }), fc.string({ maxLength: 24 }), (a, b) => {
        const forward = nameSimilarity(a, b);
        expect(forward).toBe(nameSimilarity(b, a));
        expect(forward).toBeGreaterThanOrEqual(0);
        expect(forward).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe('scoreDedupPair (D36 thresholds)', () => {
  const existing = withRef(shape('Shelburne Pond', square(0, 0, 0.1)), 'existing');

  it('returns null for bodies that are nowhere near each other', () => {
    expect(scoreDedupPair(shape('Elsewhere', square(40, 40, 0.1)), existing)).toBeNull();
  });

  it('near-certain on a near-identical polygon', () => {
    const match = scoreDedupPair(shape('Something Else', square(0, 0, 0.1)), existing);
    expect(match?.verdict).toBe('near_certain');
    expect(match?.iou).toBeGreaterThanOrEqual(DEDUP_THRESHOLDS.iouNearCertain);
  });

  it('suspected on a partial overlap', () => {
    // Shifted by 0.015° so IoU lands at ~0.57 — between the two thresholds. (0.02° would fall to
    // ~0.47, below `iouSuspected`, and would then match via the point-in-polygon rule instead,
    // which is a different code path than the one this test is pinning.)
    const match = scoreDedupPair(shape('Something Else', square(0.015, 0.015, 0.1)), existing);
    expect(match?.verdict).toBe('suspected_duplicate');
    expect(match?.iou).toBeGreaterThanOrEqual(DEDUP_THRESHOLDS.iouSuspected);
    expect(match?.iou).toBeLessThan(DEDUP_THRESHOLDS.iouNearCertain);
  });

  it('a matching name bumps a partial overlap up a tier', () => {
    const match = scoreDedupPair(shape('Shelburne Pond', square(0.015, 0.015, 0.1)), existing);
    expect(match?.verdict).toBe('near_certain');
    expect(match?.nameSimilarity).toBeGreaterThanOrEqual(DEDUP_THRESHOLDS.nameBoost);
  });

  it('a matching name alone is NOT a match — hundreds of Mud Ponds exist', () => {
    const farAway = withRef(shape('Mud Pond', square(40, 40, 0.1)), 'far');
    expect(scoreDedupPair(shape('Mud Pond', square(0, 0, 0.1)), farAway)).toBeNull();
  });

  it('near-coincident centroids suspect a duplicate even with little overlap (small bodies)', () => {
    // Two tiny ponds ~30 m apart: their polygons barely intersect, but they are obviously the same.
    const tinyA = withRef(shape('Pond A', square(0, 0, 0.0002)), 'a');
    const tinyB = shape('Pond B', square(0.0003, 0, 0.0002));
    const match = scoreDedupPair(tinyB, tinyA);
    expect(match?.verdict).toBe('suspected_duplicate');
    expect(match?.centroidDistanceM).toBeLessThan(DEDUP_THRESHOLDS.centroidSuspectedM);
  });

  it('a point landing inside an existing body is strong evidence on its own', () => {
    // A tiny candidate wholly inside the existing polygon: IoU is negligible, but the centroid is in.
    const inside = shape('Unnamed', square(0.05, 0.05, 0.0005));
    const match = scoreDedupPair(inside, existing);
    expect(match).not.toBeNull();
    expect(match?.iou).toBeLessThan(DEDUP_THRESHOLDS.iouSuspected);
  });
});

describe('rivers are compared as reaches, not areas (D4)', () => {
  const reach = (lat: number): LineString => ({
    type: 'LineString',
    coordinates: [
      [0, lat],
      [0.05, lat],
      [0.1, lat],
    ],
  });

  it('two nearly-coincident reaches read as the same water', () => {
    const match = scoreDedupPair(
      shape('Winooski River', reach(0.0001)),
      withRef(shape('Winooski River', reach(0)), 'r1'),
    );
    expect(match?.reachOverlap).not.toBeNull();
    expect(match?.iou).toBeNull(); // never scored as an area
    expect(match?.verdict).toBe('near_certain');
  });

  it('reaches far apart on the same river do not match', () => {
    const far: LineString = {
      type: 'LineString',
      coordinates: [
        [5, 5],
        [5.05, 5],
      ],
    };
    expect(
      scoreDedupPair(
        shape('Winooski River', far),
        withRef(shape('Winooski River', reach(0)), 'r1'),
      ),
    ).toBeNull();
  });
});

describe('classifyDedup', () => {
  const candidate = shape('Shelburne Pond', square(0, 0, 0.1));

  it('is clean when nothing is nearby — the create proceeds without a steer', () => {
    const result = classifyDedup(candidate, [withRef(shape('Far', square(40, 40, 0.1)), 'far')]);
    expect(result.status).toBe('clean');
    expect(result.matches).toEqual([]);
  });

  it('reports the strongest verdict across all candidates', () => {
    const result = classifyDedup(candidate, [
      withRef(shape('Partial', square(0.015, 0.015, 0.1)), 'partial'),
      withRef(shape('Exact', square(0, 0, 0.1)), 'exact'),
    ]);
    expect(result.status).toBe('near_certain');
    expect(result.matches[0]?.ref).toBe('exact');
  });

  it('ranks an OFFICIAL body above a user one at the same tier (D36 prefers attaching to official)', () => {
    const result = classifyDedup(candidate, [
      withRef(shape('User copy', square(0, 0, 0.1)), 'user', false),
      withRef(shape('OSM body', square(0, 0, 0.1)), 'osm', true),
    ]);
    expect(result.matches[0]?.ref).toBe('osm');
    expect(result.matches[0]?.official).toBe(true);
  });

  it('property: status is never clean while matches exist, and never non-clean without them', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 0.3, noNaN: true }), { maxLength: 6 }),
        (offsets) => {
          const others = offsets.map((o, i) =>
            withRef(shape(`Body ${i}`, square(o, o, 0.1)), `b${i}`),
          );
          const result = classifyDedup(candidate, others);
          expect(result.status === 'clean').toBe(result.matches.length === 0);
        },
      ),
    );
  });
});
