import fc from 'fast-check';
import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { BBox, LatLng } from './geometry';
import {
  axisCompassLabel,
  COMPASS_POINTS_16,
  compassPointFor,
  FETCH_BEARING_COUNT,
  fetchBucketFor,
  fetchProfileMeters,
  lakeAxes,
  lakeGeometryStats,
  shorelineMeters,
} from './lakeGeometry';

// --- Test helpers (analytic ground truth) ---

/** An axis-aligned rectangle as a GeoJSON Polygon (`[lng, lat]` order, closed, CCW). */
function rect(b: BBox): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [b.minLng, b.minLat],
        [b.maxLng, b.minLat],
        [b.maxLng, b.maxLat],
        [b.minLng, b.maxLat],
        [b.minLng, b.minLat],
      ],
    ],
  };
}

/** A square centred on the origin, `halfDeg` degrees to a side's midpoint. */
function square(halfDeg: number, centre: LatLng = { lat: 44, lng: -73 }): Polygon {
  return rect({
    minLat: centre.lat - halfDeg,
    maxLat: centre.lat + halfDeg,
    minLng: centre.lng - halfDeg,
    maxLng: centre.lng + halfDeg,
  });
}

/** Metres per degree of latitude, on the mean-radius sphere the module uses. */
const M_PER_DEG_LAT = (Math.PI / 180) * 6_371_008.8;

describe('compass buckets', () => {
  it('has 16 points, one per bearing bucket', () => {
    expect(COMPASS_POINTS_16).toHaveLength(FETCH_BEARING_COUNT);
    expect(new Set(COMPASS_POINTS_16).size).toBe(FETCH_BEARING_COUNT);
  });

  it('names the cardinals and the ordinals at their exact bearings', () => {
    expect(compassPointFor(0)).toBe('N');
    expect(compassPointFor(90)).toBe('E');
    expect(compassPointFor(180)).toBe('S');
    expect(compassPointFor(270)).toBe('W');
    expect(compassPointFor(45)).toBe('NE');
    expect(compassPointFor(315)).toBe('NW');
    expect(compassPointFor(22.5)).toBe('NNE');
  });

  it('wraps: 360 and -22.5 are N and NNW', () => {
    expect(compassPointFor(360)).toBe('N');
    expect(compassPointFor(-22.5)).toBe('NNW');
    expect(compassPointFor(720 + 90)).toBe('E');
  });

  it('rounds to the nearest point, so 350° is N and not NNW', () => {
    expect(compassPointFor(350)).toBe('N');
    expect(compassPointFor(340)).toBe('NNW');
  });

  it('always returns a bucket in range for any finite bearing', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), (deg) => {
        const bucket = fetchBucketFor(deg);
        expect(Number.isInteger(bucket)).toBe(true);
        expect(bucket).toBeGreaterThanOrEqual(0);
        expect(bucket).toBeLessThan(FETCH_BEARING_COUNT);
      }),
    );
  });

  it('labels an axis with a point and its opposite', () => {
    expect(axisCompassLabel(22.5)).toBe('NNE–SSW');
    expect(axisCompassLabel(0)).toBe('N–S');
    expect(axisCompassLabel(90)).toBe('E–W');
    // Undirected: the reciprocal bearing produces the mirrored label, same axis.
    expect(axisCompassLabel(202.5)).toBe('SSW–NNE');
  });
});

describe('shorelineMeters', () => {
  it('measures a square as four sides', () => {
    // A 0.01° square at 44°N: north/south sides are 0.02° of latitude each.
    const northSouth = 0.02 * M_PER_DEG_LAT;
    const measured = shorelineMeters(square(0.01));
    // Two lat sides exactly; two lng sides shortened by cos(44°). Allow 1% for the geodesic.
    const eastWest = 0.02 * M_PER_DEG_LAT * Math.cos((44 * Math.PI) / 180);
    expect(measured).toBeCloseTo(2 * northSouth + 2 * eastWest, -1);
  });

  it('counts island shorelines — the conventional definition, and what HydroLAKES measures', () => {
    const outer = square(0.01).coordinates[0] as number[][];
    const island = square(0.002).coordinates[0] as number[][];
    const withIsland: Polygon = { type: 'Polygon', coordinates: [outer, island] };
    const withoutIsland: Polygon = { type: 'Polygon', coordinates: [outer] };
    expect(shorelineMeters(withIsland)).toBeGreaterThan(shorelineMeters(withoutIsland));
    // The island contributes exactly its own perimeter.
    expect(shorelineMeters(withIsland) - shorelineMeters(withoutIsland)).toBeCloseTo(
      shorelineMeters({ type: 'Polygon', coordinates: [island] }),
      3,
    );
  });

  it('sums every component of a MultiPolygon', () => {
    const a = square(0.01, { lat: 44, lng: -73 });
    const b = square(0.01, { lat: 44, lng: -72 });
    const multi: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [a.coordinates, b.coordinates],
    };
    expect(shorelineMeters(multi)).toBeCloseTo(shorelineMeters(a) + shorelineMeters(b), 3);
  });

  it('is the property that matters: simplification only ever shortens it', () => {
    // The coastline paradox in one assertion — the reason D85 exists. A crenellated ring is
    // strictly longer than the straight chord its simplification would collapse to.
    const crenellated: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-73, 44],
          [-72.99, 44.001],
          [-72.98, 44],
          [-72.97, 44.001],
          [-72.96, 44],
          [-72.96, 44.02],
          [-73, 44.02],
          [-73, 44],
        ],
      ],
    };
    const smoothed: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-73, 44],
          [-72.96, 44],
          [-72.96, 44.02],
          [-73, 44.02],
          [-73, 44],
        ],
      ],
    };
    expect(shorelineMeters(crenellated)).toBeGreaterThan(shorelineMeters(smoothed));
  });

  it('skips unusable rings rather than throwing', () => {
    const broken: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-73, 44],
          [Number.NaN, 44],
          [-72.9, 44.1],
          [-73, 44],
        ],
      ],
    };
    expect(shorelineMeters(broken)).toBe(0);
  });

  it('is non-negative and finite for any well-formed ring', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.0005, max: 0.5, noNaN: true }),
        fc.double({ min: -70, max: 70, noNaN: true }),
        (half, lat) => {
          const s = shorelineMeters(square(half, { lat, lng: -73 }));
          expect(Number.isFinite(s)).toBe(true);
          expect(s).toBeGreaterThan(0);
        },
      ),
    );
  });
});

describe('lakeAxes', () => {
  it('measures the sides of a lat/lng square, not its diagonal', () => {
    // A lat/lng square projects to a rectangle taller than it is wide (longitude shrinks by
    // cos(lat)), so the minimum-area rectangle is that rectangle: sides, never the diagonal.
    const axes = lakeAxes(square(0.01));
    expect(axes).not.toBeNull();
    const northSouth = 0.02 * M_PER_DEG_LAT;
    const eastWest = northSouth * Math.cos((44 * Math.PI) / 180);
    expect(axes?.longAxisM).toBeCloseTo(northSouth, -1);
    expect(axes?.shortAxisM).toBeCloseTo(eastWest, -1);
    expect(axisCompassLabel(axes?.longAxisBearingDeg ?? 0)).toBe('N–S');
  });

  it('does not double the short axis on a long thin lake (the plan-method bug)', () => {
    // Regression guard for the method this file replaced: hull-diameter + perpendicular-extent
    // reports 2× the true width on an elongated rectangle, because the two extreme corners sit on
    // opposite sides of the diagonal. A 5 × 1 mile lake would have read as "5 × 2 miles".
    const thin = rect({ minLat: 44, maxLat: 44.1, minLng: -73, maxLng: -72.997 });
    const trueWidth = 0.003 * M_PER_DEG_LAT * Math.cos((44 * Math.PI) / 180);
    const axes = lakeAxes(thin);
    expect(axes?.shortAxisM).toBeCloseTo(trueWidth, -1);
    expect(axes?.shortAxisM).toBeLessThan(trueWidth * 1.5);
  });

  it('reports an east–west lake as an E–W axis', () => {
    // Much wider than tall ⇒ the long axis runs east–west ⇒ bearing ≈ 90°.
    const wide = rect({ minLat: 44, maxLat: 44.002, minLng: -73, maxLng: -72.9 });
    const axes = lakeAxes(wide);
    expect(axes?.longAxisBearingDeg).toBeGreaterThan(80);
    expect(axes?.longAxisBearingDeg).toBeLessThan(100);
    expect(axisCompassLabel(axes?.longAxisBearingDeg ?? 0)).toBe('E–W');
  });

  it('reports a north–south lake as an N–S axis, folded into [0, 180)', () => {
    const tall = rect({ minLat: 44, maxLat: 44.1, minLng: -73, maxLng: -72.998 });
    const axes = lakeAxes(tall);
    expect(axes).not.toBeNull();
    const bearing = axes?.longAxisBearingDeg ?? -1;
    expect(bearing).toBeGreaterThanOrEqual(0);
    expect(bearing).toBeLessThan(180);
    expect(axisCompassLabel(bearing)).toBe('N–S');
  });

  it('measures the short axis perpendicular to the long one', () => {
    // A long thin lake: ~11 km × ~220 m.
    const thin = rect({ minLat: 44, maxLat: 44.1, minLng: -73, maxLng: -72.997 });
    const axes = lakeAxes(thin);
    expect(axes).not.toBeNull();
    expect(axes?.longAxisM).toBeGreaterThan((axes?.shortAxisM ?? 0) * 10);
    // ~0.003° of longitude at 44°N.
    const expectedWidth = 0.003 * M_PER_DEG_LAT * Math.cos((44 * Math.PI) / 180);
    expect(axes?.shortAxisM).toBeCloseTo(expectedWidth, -2);
  });

  it('excludes islands from the hull — a hole never extends a lake', () => {
    const outer = square(0.01).coordinates[0] as number[][];
    const island = square(0.002).coordinates[0] as number[][];
    const holed: Polygon = { type: 'Polygon', coordinates: [outer, island] };
    expect(lakeAxes(holed)?.longAxisM).toBeCloseTo(lakeAxes(square(0.01))?.longAxisM ?? 0, 3);
  });

  it('spans every component of a MultiPolygon', () => {
    const a = square(0.005, { lat: 44, lng: -73 });
    const b = square(0.005, { lat: 44, lng: -72.5 });
    const multi: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [a.coordinates, b.coordinates],
    };
    // The overall extent reaches across both parts, so it exceeds either alone.
    expect(lakeAxes(multi)?.longAxisM).toBeGreaterThan((lakeAxes(a)?.longAxisM ?? 0) * 5);
  });

  it('returns null on degenerate geometry rather than a zero that reads as a measurement', () => {
    const collapsed: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-73, 44],
          [-73, 44],
          [-73, 44],
          [-73, 44],
        ],
      ],
    };
    expect(lakeAxes(collapsed)).toBeNull();
    expect(lakeAxes({ type: 'Polygon', coordinates: [] })).toBeNull();
  });

  it('the long axis is always at least the short axis', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 0.2, noNaN: true }),
        fc.double({ min: 0.001, max: 0.2, noNaN: true }),
        (dLat, dLng) => {
          const axes = lakeAxes(
            rect({ minLat: 44, maxLat: 44 + dLat, minLng: -73, maxLng: -73 + dLng }),
          );
          expect(axes).not.toBeNull();
          expect(axes?.longAxisM).toBeGreaterThanOrEqual((axes?.shortAxisM ?? 0) - 1e-6);
          expect(axes?.longAxisBearingDeg).toBeGreaterThanOrEqual(0);
          expect(axes?.longAxisBearingDeg).toBeLessThan(180);
        },
      ),
    );
  });

  it('barely moves when the projection origin does', () => {
    // The equirectangular projection scales longitude by cos(origin.lat), so a different origin
    // shifts every length slightly. Sub-0.1% across a 10 km lake — far inside the uncertainty of a
    // number we round to the nearest mile, and the reason `lakeGeometryStats` always passes the
    // centroid rather than letting the default anchor drift to a corner.
    const poly = rect({ minLat: 44, maxLat: 44.05, minLng: -73, maxLng: -72.9 });
    const a = lakeAxes(poly, { lat: 44, lng: -73 });
    const b = lakeAxes(poly, { lat: 44.05, lng: -72.9 });
    const relative = Math.abs((a?.longAxisM ?? 0) - (b?.longAxisM ?? 0)) / (a?.longAxisM ?? 1);
    expect(relative).toBeLessThan(0.001);
    expect(a?.longAxisBearingDeg).toBeCloseTo(b?.longAxisBearingDeg ?? 0, 1);
  });
});

describe('fetchProfileMeters', () => {
  const centre: LatLng = { lat: 44, lng: -73 };

  it('returns one distance per compass point', () => {
    const profile = fetchProfileMeters(square(0.01));
    expect(profile).toHaveLength(FETCH_BEARING_COUNT);
    expect(profile?.every((d) => Number.isFinite(d) && d > 0)).toBe(true);
  });

  it('measures the half-width to the shore due north', () => {
    const profile = fetchProfileMeters(square(0.01), centre);
    const north = profile?.[fetchBucketFor(0)] ?? 0;
    expect(north).toBeCloseTo(0.01 * M_PER_DEG_LAT, -1);
  });

  it('is indexed by the direction the wind blows FROM', () => {
    // A big lake with the sample point tucked into its SE corner: there is ~10 km of open water to
    // its north-west and a few hundred metres to its south-east. Wind *out of* the north-west has
    // crossed all that water; wind out of the south-east has crossed almost none. Reading the
    // profile with the opposite convention returns a plausible number that is exactly wrong, which
    // is why this is asserted rather than left to the doc comment.
    const lake = rect({ minLat: 44.0, maxLat: 44.1, minLng: -73.1, maxLng: -73.0 });
    const inTheSouthEastCorner: LatLng = { lat: 44.005, lng: -73.005 };
    const profile = fetchProfileMeters(lake, inTheSouthEastCorner);
    expect(profile).not.toBeNull();
    const fromNorthWest = profile?.[fetchBucketFor(315)] ?? 0;
    const fromSouthEast = profile?.[fetchBucketFor(135)] ?? 0;
    expect(fromNorthWest).toBeGreaterThan(5000);
    expect(fromSouthEast).toBeLessThan(1000);
  });

  it('stops at an island rather than summing across it', () => {
    // An island squarely north of the centroid: the northward fetch must end at its near shore,
    // not carry on to the far wall. Overstating exposure is the wrong direction to be wrong in.
    const outer = square(0.05).coordinates[0] as number[][];
    const island: number[][] = [
      [-73.005, 44.01],
      [-72.995, 44.01],
      [-72.995, 44.02],
      [-73.005, 44.02],
      [-73.005, 44.01],
    ];
    const holed: Polygon = { type: 'Polygon', coordinates: [outer, island] };
    const open: Polygon = { type: 'Polygon', coordinates: [outer] };

    const north = fetchBucketFor(0);
    const holedNorth = fetchProfileMeters(holed, centre)?.[north] ?? 0;
    const openNorth = fetchProfileMeters(open, centre)?.[north] ?? 0;

    expect(holedNorth).toBeLessThan(openNorth);
    expect(holedNorth).toBeCloseTo(0.01 * M_PER_DEG_LAT, -1); // the island's near shore
  });

  it('uses the largest component, not a detached basin', () => {
    const small = square(0.005, { lat: 44, lng: -73 });
    const large = square(0.05, { lat: 44, lng: -72.5 });
    const multi: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [small.coordinates, large.coordinates],
    };
    // Fetch across open land to a detached basin is not fetch: the profile must match the large
    // component exactly, whichever order the components arrive in.
    expect(fetchProfileMeters(multi)).toEqual(fetchProfileMeters(large));
  });

  it('ignores a supplied origin that is not in the water, and derives one instead', () => {
    // The load-bearing guard. `waterBodies.centroid` is Turf's `pointOnFeature`, which returns a
    // point ON the boundary whenever the bbox centre falls outside the polygon — true for any
    // curved or narrow lake. Casting rays from there produced 0.0 on half the compass.
    const lake = square(0.02, centre);
    const onTheShore: LatLng = { lat: 44, lng: -73.02 }; // exactly on the west edge
    const profile = fetchProfileMeters(lake, onTheShore);
    expect(profile).not.toBeNull();
    expect(profile?.every((d) => d > 0)).toBe(true);
    expect(profile).toEqual(fetchProfileMeters(lake));
  });

  it('honours a supplied origin that IS strictly inside', () => {
    const lake = square(0.02, centre);
    const offCentre: LatLng = { lat: 44.01, lng: -73 };
    // A point well inside but off-centre has more water south of it than north.
    const profile = fetchProfileMeters(lake, offCentre) ?? [];
    expect(profile[fetchBucketFor(180)]).toBeGreaterThan(profile[fetchBucketFor(0)] as number);
  });

  it('returns null when the geometry has no interior at all', () => {
    const collapsed: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-73, 44],
          [-73, 44],
          [-73, 44],
          [-73, 44],
        ],
      ],
    };
    expect(fetchProfileMeters(collapsed)).toBeNull();
  });

  it('never returns a zero bearing on a well-formed lake', () => {
    // The regression this whole `fetchOrigin` mechanism exists for. A closed ring seen from a
    // strictly interior point must be crossed in every direction; a 0 means we cast from the shore.
    fc.assert(
      fc.property(
        fc.double({ min: 0.002, max: 0.2, noNaN: true }),
        fc.double({ min: 0.002, max: 0.2, noNaN: true }),
        (dLat, dLng) => {
          const profile =
            fetchProfileMeters(
              rect({ minLat: 44, maxLat: 44 + dLat, minLng: -73, maxLng: -73 + dLng }),
            ) ?? [];
          expect(profile).toHaveLength(FETCH_BEARING_COUNT);
          for (const d of profile) expect(d).toBeGreaterThan(0);
        },
      ),
    );
  });

  it('is symmetric on a symmetric lake', () => {
    const profile = fetchProfileMeters(square(0.02), centre) ?? [];
    for (let k = 0; k < FETCH_BEARING_COUNT / 2; k++) {
      const opposite = (k + FETCH_BEARING_COUNT / 2) % FETCH_BEARING_COUNT;
      expect(profile[k]).toBeCloseTo(profile[opposite] as number, 0);
    }
  });

  it('never exceeds the bounding rectangle diagonal — no chord can', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.002, max: 0.2, noNaN: true }),
        fc.double({ min: 0.002, max: 0.2, noNaN: true }),
        (dLat, dLng) => {
          const poly = rect({
            minLat: 44 - dLat,
            maxLat: 44 + dLat,
            minLng: -73 - dLng,
            maxLng: -73 + dLng,
          });
          const profile = fetchProfileMeters(poly) ?? [];
          const axes = lakeAxes(poly, centre);
          // The bound is the bounding rectangle's DIAGONAL, not its long side. `longAxisM` became
          // a side when this module moved off hull-diameter onto the minimum-area rectangle, and a
          // ray cast toward a corner runs along the diagonal — which is up to 1.41x the long side
          // on a square. The old assertion survived because fast-check had not yet drawn a nearly
          // square lake with an off-centre fetch origin; it did on seed -298658357.
          const diagonal = Math.hypot(axes?.longAxisM ?? 0, axes?.shortAxisM ?? 0);
          for (const d of profile) expect(d).toBeLessThanOrEqual(diagonal + 1);
        },
      ),
    );
  });
});

describe('lakeGeometryStats', () => {
  const centre: LatLng = { lat: 44, lng: -73 };

  it('composes every stat for a well-formed body', () => {
    const stats = lakeGeometryStats(square(0.01), centre);
    expect(stats.shorelineM).toBeGreaterThan(0);
    expect(stats.longAxisM).toBeGreaterThan(0);
    expect(stats.shortAxisM).toBeGreaterThan(0);
    expect(stats.longAxisBearingDeg).toBeGreaterThanOrEqual(0);
    expect(stats.fetchProfileM).toHaveLength(FETCH_BEARING_COUNT);
  });

  it('omits a stat rather than zeroing it when the geometry cannot support it', () => {
    // Nothing measurable at all: every field absent rather than zeroed.
    const stats = lakeGeometryStats({ type: 'Polygon', coordinates: [] }, { lat: 44, lng: -73 });
    expect(stats.fetchProfileM).toBeUndefined();
    expect(stats.longAxisM).toBeUndefined();
  });

  it('returns an empty block for wholly degenerate geometry, never a throw', () => {
    const empty: Polygon = { type: 'Polygon', coordinates: [] };
    expect(lakeGeometryStats(empty, centre)).toEqual({});
  });
});
