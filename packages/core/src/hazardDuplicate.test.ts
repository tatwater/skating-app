import { describe, expect, it } from 'vitest';
import { destinationPoint, type LatLng } from './geometry';
import type { ClusterableHazard } from './hazardCluster';
import { findDuplicateCandidate } from './hazardDuplicate';
import type { HazardType } from './types';

const ORIGIN: LatLng = { lat: 44.5, lng: -72.5 };

function circle(
  id: string,
  type: HazardType,
  metersEast: number,
  firstReportedAt = 1,
): ClusterableHazard {
  const at = destinationPoint(ORIGIN, 90, metersEast);
  return {
    id,
    type,
    geometryKind: 'point_radius',
    geometry: { type: 'Point', coordinates: [at.lng, at.lat] },
    radiusMeters: 20,
    firstReportedAt,
  };
}

/** The draft a skater is about to submit, `metersEast` of the origin. */
function draft(type: HazardType, metersEast: number) {
  const at = destinationPoint(ORIGIN, 90, metersEast);
  return {
    type,
    geometryKind: 'point_radius' as const,
    geometry: { type: 'Point' as const, coordinates: [at.lng, at.lat] },
    radiusMeters: 20,
  };
}

describe('findDuplicateCandidate', () => {
  it('offers the pin a skater is about to mark again', () => {
    const found = findDuplicateCandidate(draft('thin_ice', 10), [circle('a', 'thin_ice', 0)]);
    expect(found?.hazard.id).toBe('a');
    expect(found?.distanceMeters).toBe(0);
  });

  it('says nothing when the nearest same-family pin is beyond the tolerance', () => {
    // 20 m radii 120 m apart: an 80 m gap, far past the 25 m duplicate bar. Two different leads.
    expect(findDuplicateCandidate(draft('thin_ice', 120), [circle('a', 'thin_ice', 0)])).toBeNull();
  });

  it('never offers a pin from another family', () => {
    // A spring and a ridge in one bay are two facts about the lake, not one.
    expect(
      findDuplicateCandidate(draft('pressure_ridge', 5), [circle('a', 'spring_current', 0)]),
    ).toBeNull();
  });

  it('never nudges for a passage marker', () => {
    // Merging two crossings would claim a wider crossable span than anyone reported, and suggesting
    // it at draw time is the same claim, earlier.
    expect(
      findDuplicateCandidate(draft('ridge_crossing', 5), [circle('a', 'ridge_crossing', 0)]),
    ).toBeNull();
  });

  it('offers the nearest of several candidates', () => {
    const found = findDuplicateCandidate(draft('thin_ice', 45), [
      circle('far', 'thin_ice', 0),
      circle('near', 'thin_ice', 60),
    ]);
    expect(found?.hazard.id).toBe('near');
  });

  it('breaks a tie on the freshest sighting — the confirmation worth the most', () => {
    const found = findDuplicateCandidate(draft('thin_ice', 0), [
      circle('older', 'thin_ice', 0, 1_000),
      circle('newer', 'thin_ice', 0, 9_000),
    ]);
    expect(found?.hazard.id).toBe('newer');
  });

  it('says nothing on an empty lake', () => {
    expect(findDuplicateCandidate(draft('thin_ice', 0), [])).toBeNull();
  });

  it('never offers the draft back to itself, whatever ids the caller uses', () => {
    // The synthetic draft id must not be returnable — a nudge pointing at the thing being drawn is
    // the one output that would make the affordance nonsense.
    const found = findDuplicateCandidate(draft('thin_ice', 0), [circle('~draft', 'thin_ice', 0)]);
    expect(found?.hazard.id).toBe('~draft'); // a real hazard that happens to be named that is fine
  });

  it('survives a stored hazard whose geometry cannot be buffered', () => {
    const broken: ClusterableHazard = {
      id: 'broken',
      type: 'thin_ice',
      geometryKind: 'line',
      geometry: { type: 'LineString', coordinates: [] },
      bufferMeters: 10,
      firstReportedAt: 1,
    };
    const found = findDuplicateCandidate(draft('thin_ice', 10), [
      broken,
      circle('a', 'thin_ice', 0),
    ]);
    expect(found?.hazard.id).toBe('a');
  });
});
