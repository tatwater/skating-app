import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type BBox,
  destinationPoint,
  type LatLng,
  polygonBBox,
  polygonDistanceMeters,
} from './geometry';
import {
  bboxExtentMeters,
  type ClusterableHazard,
  clusterHazards,
  DUPLICATE_MATCH_METERS,
  DUPLICATE_MAX_CLUSTER_SPREAD_M,
  hazardFamilyFor,
  RECURRENCE_FAMILIES,
  RECURRENCE_MATCH_METERS,
} from './hazardCluster';
import { hazardFootprint } from './hazardGeometry';
import { HAZARD_TYPES, type HazardType } from './types';

const ORIGIN: LatLng = { lat: 44.5, lng: -72.5 };

/** A point+radius hazard `metersEast` east of the origin. */
function circle(
  id: string,
  type: HazardType,
  metersEast: number,
  radiusMeters = 20,
  firstReportedAt = 1,
): ClusterableHazard {
  const at = destinationPoint(ORIGIN, 90, metersEast);
  return {
    id,
    type,
    geometryKind: 'point_radius',
    geometry: { type: 'Point', coordinates: [at.lng, at.lat] },
    radiusMeters,
    firstReportedAt,
  };
}

/** A buffered line from `fromEast` to `toEast` metres east of the origin, offset `northOf` metres north. */
function band(
  id: string,
  type: HazardType,
  fromEast: number,
  toEast: number,
  northOf = 0,
  firstReportedAt = 1,
): ClusterableHazard {
  const leg = (east: number) => {
    const alongEast = destinationPoint(ORIGIN, 90, east);
    const shifted = destinationPoint(alongEast, 0, northOf);
    return [shifted.lng, shifted.lat];
  };
  return {
    id,
    type,
    geometryKind: 'line',
    geometry: { type: 'LineString', coordinates: [leg(fromEast), leg(toEast)] },
    bufferMeters: 15,
    firstReportedAt,
  };
}

const duplicateOptions = {
  matchMeters: DUPLICATE_MATCH_METERS,
  maxSpreadMeters: DUPLICATE_MAX_CLUSTER_SPREAD_M,
};

/** Cluster member ids, sorted, so a comparison doesn't depend on grouping order. */
function idsOf(clusters: { members: ClusterableHazard[] }[]): string[][] {
  return clusters.map((c) => [...c.members.map((m) => m.id)].sort());
}

/** The box enclosing every member's footprint — what the span guard is measured on. */
function footprintBBoxOf(members: readonly ClusterableHazard[]): BBox {
  return members
    .map((m) =>
      polygonBBox(
        hazardFootprint({
          geometryKind: m.geometryKind,
          geometry: m.geometry,
          ...(m.radiusMeters !== undefined ? { radiusMeters: m.radiusMeters } : {}),
          ...(m.bufferMeters !== undefined ? { bufferMeters: m.bufferMeters } : {}),
        }),
      ),
    )
    .reduce((a, b) => ({
      minLat: Math.min(a.minLat, b.minLat),
      minLng: Math.min(a.minLng, b.minLng),
      maxLat: Math.max(a.maxLat, b.maxLat),
      maxLng: Math.max(a.maxLng, b.maxLng),
    }));
}

describe('hazardFamilyFor', () => {
  it('assigns every hazard type except the passage marker to a family', () => {
    for (const type of HAZARD_TYPES) {
      const family = hazardFamilyFor(type);
      if (type === 'ridge_crossing') expect(family).toBeNull();
      else expect(family).not.toBeNull();
    }
  });

  it('mirrors promotionTargetFor for the four promotable families', () => {
    expect(hazardFamilyFor('pressure_ridge')).toBe('ridge');
    expect(hazardFamilyFor('ice_heave')).toBe('ridge');
    expect(hazardFamilyFor('spring_current')).toBe('spring');
    expect(hazardFamilyFor('gas_hole')).toBe('gas');
    expect(hazardFamilyFor('reef_hole')).toBe('reef');
  });

  it('keeps cracks clusterable — dedup is about identity, promotion is about permanence', () => {
    expect(hazardFamilyFor('wet_crack')).toBe('crack');
    expect(RECURRENCE_FAMILIES).not.toContain('crack');
  });
});

describe('clusterHazards', () => {
  it('collapses two overlapping pins of the same type into one cluster', () => {
    const clusters = clusterHazards(
      [circle('a', 'thin_ice', 0), circle('b', 'thin_ice', 10)],
      duplicateOptions,
    );
    expect(idsOf(clusters)).toEqual([['a', 'b']]);
  });

  it('never matches across families — a spring and a ridge in one bay are two facts', () => {
    const clusters = clusterHazards(
      [circle('spring', 'spring_current', 0), circle('ridge', 'pressure_ridge', 5)],
      duplicateOptions,
    );
    expect(idsOf(clusters)).toEqual([['ridge'], ['spring']]);
  });

  it('drops passage markers entirely rather than returning them as singletons', () => {
    // Merging two crossings would claim a wider crossable span than anyone reported.
    const clusters = clusterHazards(
      [circle('x', 'ridge_crossing', 0), circle('y', 'ridge_crossing', 5)],
      duplicateOptions,
    );
    expect(clusters).toEqual([]);
  });

  it('honours the family filter, so the cross-season window can exclude cracks', () => {
    const clusters = clusterHazards([circle('c', 'wet_crack', 0)], {
      ...duplicateOptions,
      families: RECURRENCE_FAMILIES,
    });
    expect(clusters).toEqual([]);
  });

  it('separates pins beyond the tolerance', () => {
    const clusters = clusterHazards(
      // 20 m radii, 120 m apart: an 80 m gap between footprints, far past the 25 m duplicate bar.
      [circle('a', 'thin_ice', 0), circle('b', 'thin_ice', 120)],
      duplicateOptions,
    );
    expect(idsOf(clusters)).toEqual([['a'], ['b']]);
  });

  it('matches on footprints, not centroids — the case a centroid test gets backwards', () => {
    // Two people drawing the same 500 m ridge, disagreeing about where it ends by 100 m. Their
    // centroids are 100 m apart — four times the duplicate tolerance, so a centroid test calls them
    // distinct — while their footprints overlap along 400 m.
    const clusters = clusterHazards(
      [band('west', 'pressure_ridge', 0, 500), band('east', 'pressure_ridge', 100, 600)],
      duplicateOptions,
    );
    expect(idsOf(clusters)).toEqual([['east', 'west']]);
  });

  it('reads crossing bands as overlapping even with no vertex of either inside the other', () => {
    // Two ridge bands crossing at right angles: every vertex is out beyond the other's width, so a
    // vertex-containment test alone would report a positive gap for shapes that plainly overlap.
    const eastWest = band('ew', 'pressure_ridge', -200, 200);
    const northSouth: ClusterableHazard = {
      id: 'ns',
      type: 'pressure_ridge',
      geometryKind: 'line',
      geometry: {
        type: 'LineString',
        coordinates: [
          [ORIGIN.lng, destinationPoint(ORIGIN, 180, 200).lat],
          [ORIGIN.lng, destinationPoint(ORIGIN, 0, 200).lat],
        ],
      },
      bufferMeters: 15,
      firstReportedAt: 1,
    };
    expect(
      polygonDistanceMeters(
        hazardFootprint({
          geometryKind: 'line',
          geometry: eastWest.geometry,
          bufferMeters: 15,
        }),
        hazardFootprint({
          geometryKind: 'line',
          geometry: northSouth.geometry,
          bufferMeters: 15,
        }),
      ),
    ).toBe(0);
    expect(idsOf(clusterHazards([eastWest, northSouth], duplicateOptions))).toEqual([['ew', 'ns']]);
  });

  describe('the chaining guard', () => {
    // Ten 20 m pins strung 50 m apart: every neighbour pair is a 10 m gap, well inside the tolerance,
    // and the whole line spans 450 m. Single-link without a guard swallows the lot.
    const chain = Array.from({ length: 10 }, (_, i) =>
      circle(`c${i}`, 'thin_ice', i * 50, 20, i + 1),
    );

    it('refuses to let a chain of near-neighbours span the lake', () => {
      const clusters = clusterHazards(chain, duplicateOptions);
      expect(clusters.length).toBeGreaterThan(1);
      // Every member is a 20 m circle, so no cluster may reach further than one of those plus the
      // allowance — a long way short of the 450 m the unguarded chain would have covered.
      const widestMember = bboxExtentMeters(footprintBBoxOf([chain[0] as ClusterableHazard]));
      for (const cluster of clusters) {
        const extent = bboxExtentMeters(footprintBBoxOf(cluster.members));
        expect(extent.eastWest).toBeLessThanOrEqual(
          widestMember.eastWest + DUPLICATE_MAX_CLUSTER_SPREAD_M,
        );
      }
    });

    it('still clusters the whole chain when the guard is wide enough to allow it', () => {
      expect(
        idsOf(
          clusterHazards(chain, { matchMeters: DUPLICATE_MATCH_METERS, maxSpreadMeters: 10_000 }),
        ),
      ).toEqual([chain.map((c) => c.id).sort()]);
    });
  });

  it('survives a hazard whose geometry cannot be buffered, without losing the others', () => {
    const broken: ClusterableHazard = {
      id: 'broken',
      type: 'thin_ice',
      geometryKind: 'line',
      // A zero-length line: Turf's buffer throws rather than returning empty.
      geometry: { type: 'LineString', coordinates: [] },
      bufferMeters: 10,
      firstReportedAt: 1,
    };
    const clusters = clusterHazards(
      [broken, circle('a', 'thin_ice', 0), circle('b', 'thin_ice', 10)],
      duplicateOptions,
    );
    expect(idsOf(clusters)).toEqual([['broken'], ['a', 'b']].map((ids) => ids.sort()).sort());
  });

  it('keeps the earliest sighting first in every cluster — the survivor a merge would pick', () => {
    const [cluster] = clusterHazards(
      [circle('late', 'thin_ice', 10, 20, 500), circle('early', 'thin_ice', 0, 20, 100)],
      duplicateOptions,
    );
    expect(cluster?.members.map((m) => m.id)).toEqual(['early', 'late']);
  });

  it('is invariant under input order', () => {
    // Greedy agglomeration is order-dependent by nature, so this is the property that makes the
    // canonical sort load-bearing rather than cosmetic — two clients holding the same hazards in
    // different orders must draw the same consensus footprints.
    const arbHazard = fc
      .record({
        id: fc.string({ minLength: 1, maxLength: 6 }),
        east: fc.integer({ min: 0, max: 400 }),
        radius: fc.integer({ min: 5, max: 40 }),
        at: fc.integer({ min: 1, max: 100 }),
        type: fc.constantFrom<HazardType>('thin_ice', 'pressure_ridge', 'wet_crack'),
      })
      .map(({ id, east, radius, at, type }) => circle(id, type, east, radius, at));

    fc.assert(
      fc.property(
        fc
          .uniqueArray(arbHazard, { minLength: 2, maxLength: 8, selector: (h) => h.id })
          .chain((hazards) =>
            fc.tuple(
              fc.constant(hazards),
              fc.shuffledSubarray(hazards, { minLength: hazards.length }),
            ),
          ),
        ([ordered, shuffled]) => {
          const a = idsOf(clusterHazards(ordered, duplicateOptions))
            .map((ids) => ids.join(','))
            .sort();
          const b = idsOf(clusterHazards(shuffled, duplicateOptions))
            .map((ids) => ids.join(','))
            .sort();
          expect(b).toEqual(a);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('is a partition — every eligible hazard lands in exactly one cluster', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc
            .record({
              id: fc.string({ minLength: 1, maxLength: 6 }),
              east: fc.integer({ min: 0, max: 600 }),
              at: fc.integer({ min: 1, max: 100 }),
            })
            .map(({ id, east, at }) => circle(id, 'thin_ice', east, 20, at)),
          { minLength: 1, maxLength: 10, selector: (h) => h.id },
        ),
        (hazards) => {
          const clusters = clusterHazards(hazards, {
            matchMeters: RECURRENCE_MATCH_METERS,
            maxSpreadMeters: 10_000,
          });
          const seen = clusters.flatMap((c) => c.members.map((m) => m.id)).sort();
          expect(seen).toEqual(hazards.map((h) => h.id).sort());
        },
      ),
      { numRuns: 60 },
    );
  });
});
