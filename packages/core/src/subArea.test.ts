import fc from 'fast-check';
import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { pointInPolygon, surfaceAreaSqM } from './geometry';
import {
  clipSubAreaToParent,
  memberSubAreaIds,
  resolveTrackSubAreas,
  SUB_AREA_CLIP_MESSAGES,
  SUB_AREA_MIN_RETAINED_FRACTION,
  SUB_AREA_PUT_IN_TOLERANCE_M,
  smallestContainingSubArea,
  subAreaForPutIn,
  subAreaMembershipFields,
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
   * The reason this rule exists rather than first-match (Decision 9, on A01's evidence): the answer
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A09 (D175): the rules that tag what sits in a bay
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('subAreaForPutIn — by distance to the outline, not containment (A09 call 3)', () => {
  // Two bays sharing the parent's west shore; the small one is nested inside the big one.
  const big = { ref: 'big', polygon: rect(-73.5, 44.2, -73.2, 44.6), surfaceAreaSqM: 1e9 };
  const small = { ref: 'small', polygon: rect(-73.5, 44.3, -73.4, 44.4), surfaceAreaSqM: 1e8 };
  const candidates = [big, small];

  it('a launch a few meters *outside* the outline still belongs to the bay', () => {
    // ~10 m west of the shared west shore at 44.5°N — outside both polygons by point-in-polygon.
    const coord = { lat: 44.5, lng: -73.5 - 10 / (111_320 * Math.cos((44.5 * Math.PI) / 180)) };
    expect(pointInPolygon(coord, big.polygon)).toBe(false);
    expect(subAreaForPutIn(coord, candidates)).toBe('big');
  });

  it('smallest wins on a shared shore even when the two distances differ by float noise', () => {
    // The nested bay's west edge sits a nanometre east of the big bay's — the re-noding a clip
    // introduces — so an exact tie never happens, and a bit-level rule would pick the *bigger* bay.
    const nudged = {
      ref: 'small',
      polygon: rect(-73.5 + 1e-11, 44.3, -73.4, 44.4),
      surfaceAreaSqM: 1e8,
    };
    const coord = { lat: 44.35, lng: -73.5 - 2 / (111_320 * Math.cos((44.35 * Math.PI) / 180)) };
    expect(subAreaForPutIn(coord, [big, nudged])).toBe('small');
    expect(subAreaForPutIn(coord, [nudged, big])).toBe('small');
  });

  it('smallest wins when two bays are within tolerance', () => {
    const coord = { lat: 44.35, lng: -73.5 - 5 / (111_320 * Math.cos((44.35 * Math.PI) / 180)) };
    expect(subAreaForPutIn(coord, candidates)).toBe('small');
  });

  it('beyond the tolerance it is open-lake access', () => {
    const meters = SUB_AREA_PUT_IN_TOLERANCE_M * 3;
    const coord = { lat: 44.5, lng: -73.5 - meters / (111_320 * Math.cos((44.5 * Math.PI) / 180)) };
    expect(subAreaForPutIn(coord, candidates)).toBeNull();
  });

  it('no bays, no tag', () => {
    expect(subAreaForPutIn({ lat: 44.5, lng: -73.5 }, [])).toBeNull();
  });
});

describe('resolveTrackSubAreas — the two-bay skate (A09 kickoff Q4)', () => {
  const west = { ref: 'west', polygon: rect(-73.5, 44.2, -73.3, 44.6), surfaceAreaSqM: 5e8 };
  const east = { ref: 'east', polygon: rect(-72.8, 44.2, -72.5, 44.6), surfaceAreaSqM: 6e8 };
  const inner = { ref: 'inner', polygon: rect(-73.5, 44.5, -73.4, 44.6), surfaceAreaSqM: 5e7 };
  const candidates = [west, east, inner];
  const at = (lng: number, lat = 44.4) => ({ lat, lng });

  it('primary is the bay with the most samples, and every bay touched is listed most-visited first', () => {
    // Five samples in the east bay, three in the west, none in open water.
    const samples = [
      at(-73.45),
      at(-73.4),
      at(-73.35),
      at(-72.7),
      at(-72.65),
      at(-72.6),
      at(-72.55),
      at(-72.75),
    ];
    const out = resolveTrackSubAreas(samples, candidates, PARENT);
    expect(out.primary).toBe('east');
    expect(out.all).toEqual(['east', 'west']);
    expect(out.leftSubArea).toBe(false);
  });

  it('a sample on the parent outside every bay is the mouth-line evidence', () => {
    const samples = [at(-73.45), at(-73.4), at(-73.1) /* open water, on the parent */];
    const out = resolveTrackSubAreas(samples, candidates, PARENT);
    expect(out.primary).toBe('west');
    expect(out.all).toEqual(['west']);
    expect(out.leftSubArea).toBe(true);
  });

  it('a sample off the parent (shoreline jitter on the way to the car) is not evidence', () => {
    const samples = [at(-73.45), at(-73.4), at(-73.6) /* west of the lake entirely */];
    expect(resolveTrackSubAreas(samples, candidates, PARENT).leftSubArea).toBe(false);
  });

  it('a bay one sample brushed past is not a member — the floor (SUB_AREA_MEMBERSHIP_MIN_SHARE)', () => {
    // 19 samples in open water and one in the west bay: 5%, under the 10% floor. No bay, no
    // primary — the skate was on the lake — but the mouth line was crossed on the way past.
    const samples = [...Array.from({ length: 19 }, () => at(-73.1)), at(-73.45)];
    const out = resolveTrackSubAreas(samples, candidates, PARENT);
    expect(out).toEqual({ primary: null, all: [], leftSubArea: true });
    // Two of twenty clears it.
    const two = [...Array.from({ length: 18 }, () => at(-73.1)), at(-73.45), at(-73.4)];
    expect(resolveTrackSubAreas(two, candidates, PARENT).all).toEqual(['west']);
  });

  it('a track that never entered a bay is not evidence about any mouth line', () => {
    const out = resolveTrackSubAreas([at(-73.1), at(-73.0)], candidates, PARENT);
    expect(out).toEqual({ primary: null, all: [], leftSubArea: false });
  });

  it('a sample in nested bays counts once, for the smaller (Decision 9)', () => {
    const out = resolveTrackSubAreas([at(-73.45, 44.55), at(-73.45, 44.55)], candidates, PARENT);
    expect(out.all).toEqual(['inner']);
  });

  it('the answer is independent of candidate order', () => {
    const samples = [at(-73.45), at(-72.7), at(-72.65), at(-73.1)];
    const a = resolveTrackSubAreas(samples, candidates, PARENT);
    const b = resolveTrackSubAreas(samples, [...candidates].reverse(), PARENT);
    expect(b).toEqual(a);
  });
});

describe('membership fields — the stored convention (A09)', () => {
  it('one member is the label alone; two or more fill the list', () => {
    expect(subAreaMembershipFields(['a'])).toEqual({ subAreaId: 'a', subAreaIds: undefined });
    expect(subAreaMembershipFields(['a', 'b'])).toEqual({ subAreaId: 'a', subAreaIds: ['a', 'b'] });
    expect(subAreaMembershipFields([])).toEqual({ subAreaId: undefined, subAreaIds: undefined });
  });

  it('memberSubAreaIds reads either shape back, primary first', () => {
    expect(memberSubAreaIds({})).toEqual([]);
    expect(memberSubAreaIds({ subAreaId: 'a' })).toEqual(['a']);
    expect(memberSubAreaIds({ subAreaId: 'a', subAreaIds: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('round-trips', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({ minLength: 1 }), { maxLength: 4 }), (ids) => {
        const fields = subAreaMembershipFields(ids);
        expect(memberSubAreaIds(fields)).toEqual(ids);
      }),
    );
  });
});
