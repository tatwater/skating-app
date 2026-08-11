import { describe, expect, test } from 'vitest';
import {
  APPROACH_KINDS,
  approachKindFor,
  compassSideLabel,
  DRIVE_UP_MAX_M,
  HIKE_IN_ASSERT_M,
  isHikeIn,
  PARKING_INFER_RADIUS_M,
  PUTIN_SHORE_RADIUS_M,
  requiresHikeInAssertion,
  resolveApproachKind,
  resolvePutInName,
  SHORT_WALK_MAX_M,
} from './access';
import { bearingDegrees, destinationPoint, haversineMeters } from './geometry';

const CENTRE = { lat: 44.5, lng: -72.5 };

describe('approachKindFor', () => {
  test('classifies at the D144 boundaries, inclusive of the lower kind', () => {
    expect(approachKindFor(0)).toBe('drive_up');
    expect(approachKindFor(DRIVE_UP_MAX_M)).toBe('drive_up');
    expect(approachKindFor(DRIVE_UP_MAX_M + 1)).toBe('short_walk');
    expect(approachKindFor(SHORT_WALK_MAX_M)).toBe('short_walk');
    expect(approachKindFor(SHORT_WALK_MAX_M + 1)).toBe('hike_in');
    expect(approachKindFor(5_000)).toBe('hike_in');
  });

  /**
   * The distinction the whole module turns on: "we don't know about the walk" must never render as
   * "you can drive up". Most of the corpus has no parking associated at all, so a default here would
   * be a false drive-up claim on thousands of lakes.
   */
  test('an absent or nonsensical distance yields no kind at all, never a default', () => {
    expect(approachKindFor(undefined)).toBeUndefined();
    expect(approachKindFor(Number.NaN)).toBeUndefined();
    expect(approachKindFor(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(approachKindFor(-1)).toBeUndefined();
  });

  test('every kind is reachable, so the enum has no dead member', () => {
    const reached = new Set(
      [0, DRIVE_UP_MAX_M + 1, SHORT_WALK_MAX_M + 1].map((m) => approachKindFor(m)),
    );
    expect([...reached].sort()).toEqual([...APPROACH_KINDS].sort());
  });
});

describe('resolveApproachKind', () => {
  test('an operator override wins over the derived value, including against a routed number', () => {
    expect(resolveApproachKind(50, 'hike_in')).toBe('hike_in');
    expect(resolveApproachKind(5_000, 'drive_up')).toBe('drive_up');
  });

  test('falls through to the derivation when there is no override', () => {
    expect(resolveApproachKind(400, undefined)).toBe('short_walk');
  });

  /** An override with no distance still answers — that is the case it exists for. */
  test('an override alone answers when no distance was ever routed', () => {
    expect(resolveApproachKind(undefined, 'hike_in')).toBe('hike_in');
    expect(resolveApproachKind(undefined, undefined)).toBeUndefined();
  });
});

describe('requiresHikeInAssertion', () => {
  test('demands the assertion strictly beyond a mile, and not at it', () => {
    expect(requiresHikeInAssertion(HIKE_IN_ASSERT_M)).toBe(false);
    expect(requiresHikeInAssertion(HIKE_IN_ASSERT_M + 1)).toBe(true);
    expect(requiresHikeInAssertion(undefined)).toBe(false);
  });

  /**
   * The gate has to sit *above* the derivation, or it would fire on ordinary hike-in lakes and the
   * demand would become the noise it exists to avoid.
   */
  test('the assertion gate is strictly looser than the hike-in derivation', () => {
    expect(HIKE_IN_ASSERT_M).toBeGreaterThan(SHORT_WALK_MAX_M);
    expect(requiresHikeInAssertion(SHORT_WALK_MAX_M + 1)).toBe(false);
    expect(approachKindFor(SHORT_WALK_MAX_M + 1)).toBe('hike_in');
  });
});

describe('isHikeIn', () => {
  test('only the hike-in kind chips, and an unknown approach never does', () => {
    expect(isHikeIn('hike_in')).toBe(true);
    expect(isHikeIn('short_walk')).toBe(false);
    expect(isHikeIn('drive_up')).toBe(false);
    expect(isHikeIn(undefined)).toBe(false);
  });
});

describe('compassSideLabel', () => {
  test.each([
    [0, 'N launch'],
    [45, 'NE launch'],
    [90, 'E launch'],
    [180, 'S launch'],
    [270, 'W launch'],
    [315, 'NW launch'],
  ])('a launch %i° off the interior point reads as %s', (bearing, expected) => {
    const point = destinationPoint(CENTRE, bearing, 600);
    expect(compassSideLabel(point, CENTRE)).toBe(expected);
  });

  /** Re-derivable on every import is the entire reason this exists rather than a stored string. */
  test('is deterministic — the same inputs always produce the same label', () => {
    const point = destinationPoint(CENTRE, 112, 900);
    expect(compassSideLabel(point, CENTRE)).toBe(compassSideLabel(point, CENTRE));
  });

  test('a coincident point still yields a label rather than NaN', () => {
    expect(compassSideLabel(CENTRE, CENTRE)).toBe('N launch');
  });

  /** 16 points, not 4: long narrow bodies would collide constantly on a coarser rose. */
  test('two launches on the same side of a narrow lake get distinguishable labels', () => {
    const north = destinationPoint(CENTRE, 5, 1_000);
    const northNorthEast = destinationPoint(CENTRE, 30, 1_000);
    expect(compassSideLabel(north, CENTRE)).not.toBe(compassSideLabel(northNorthEast, CENTRE));
  });
});

describe('resolvePutInName', () => {
  test("OSM's name wins when it has one", () => {
    const point = destinationPoint(CENTRE, 0, 500);
    expect(resolvePutInName('Lake Fairlee Boat Ramp', point, CENTRE)).toBe(
      'Lake Fairlee Boat Ramp',
    );
  });

  test('a blank or whitespace name falls through to the compass label', () => {
    const point = destinationPoint(CENTRE, 180, 500);
    expect(resolvePutInName('   ', point, CENTRE)).toBe('S launch');
    expect(resolvePutInName(undefined, point, CENTRE)).toBe('S launch');
  });

  /**
   * No interior point means no bearing to take, and a compass point computed from nothing would be a
   * confident label pointing in an arbitrary direction.
   */
  test('with no interior point it returns nothing rather than inventing a direction', () => {
    const point = destinationPoint(CENTRE, 180, 500);
    expect(resolvePutInName(undefined, point, undefined)).toBeUndefined();
    expect(resolvePutInName('Town Beach', point, undefined)).toBe('Town Beach');
  });
});

describe('bearingDegrees', () => {
  test('round-trips against destinationPoint at lake scale', () => {
    for (const bearing of [0, 30, 95, 180, 271, 359]) {
      const target = destinationPoint(CENTRE, bearing, 1_200);
      expect(bearingDegrees(CENTRE, target)).toBeCloseTo(bearing, 1);
    }
  });

  test('normalizes into [0, 360) and never returns NaN for coincident points', () => {
    const west = destinationPoint(CENTRE, 270, 400);
    expect(bearingDegrees(CENTRE, west)).toBeGreaterThanOrEqual(0);
    expect(bearingDegrees(CENTRE, west)).toBeLessThan(360);
    expect(bearingDegrees(CENTRE, CENTRE)).toBe(0);
  });
});

describe('the association radii', () => {
  /**
   * The shore radius finds *which lake*; the parking radius finds *which launch*. Inverting them
   * would attach lots to lakes they don't serve and refuse launches that are plainly on the water.
   */
  test('the shore radius is far tighter than the parking-inference radius', () => {
    expect(PUTIN_SHORE_RADIUS_M).toBeLessThan(PARKING_INFER_RADIUS_M);
  });

  /** Inference must stay well inside the range where a walk is still a walk. */
  test('the inference radius cannot itself imply a hike', () => {
    expect(approachKindFor(PARKING_INFER_RADIUS_M)).toBe('short_walk');
    expect(PARKING_INFER_RADIUS_M).toBeLessThan(SHORT_WALK_MAX_M);
  });

  test('a point just inside the shore radius is nearer than one just outside', () => {
    const near = destinationPoint(CENTRE, 90, PUTIN_SHORE_RADIUS_M - 5);
    const far = destinationPoint(CENTRE, 90, PUTIN_SHORE_RADIUS_M + 5);
    expect(haversineMeters(CENTRE, near)).toBeLessThan(PUTIN_SHORE_RADIUS_M);
    expect(haversineMeters(CENTRE, far)).toBeGreaterThan(PUTIN_SHORE_RADIUS_M);
  });
});
