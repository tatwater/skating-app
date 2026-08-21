import { describe, expect, test } from 'vitest';
import {
  type AccessParking,
  type AccessPutIn,
  APPROACH_KINDS,
  APPROACH_PATH_MAX_VERTICES,
  approachKindFor,
  approachPathWanted,
  bodyAccessKind,
  chooseAccessTarget,
  compassSideLabel,
  DRIVE_UP_MAX_M,
  describeApproach,
  HIKE_IN_ASSERT_M,
  isHikeIn,
  MAX_PLAUSIBLE_APPROACH_M,
  orsFootHikingBody,
  PARKING_INFER_RADIUS_M,
  PUTIN_SHORE_RADIUS_M,
  parseOrsFootHikingRoute,
  plausibleApproach,
  requiresHikeInAssertion,
  resolveApproachKind,
  resolvePutInName,
  SHORT_WALK_MAX_M,
  straightLineApproach,
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

describe('the approach leg (D87)', () => {
  const LOT = { lat: 44.5, lng: -72.5 };
  const LAUNCH = { lat: 44.507, lng: -72.495 };

  /**
   * The guard D87 asked for in as many words. ORS's ascent/descent oddities live on out-and-back
   * routes, and the figure we want is one-way parking → put-in; the return climb is the descent.
   * Building the body in core is what makes "we never asked for a round trip" a property of the code.
   */
  test('the request is exactly two coordinates and never a round trip', () => {
    const body = orsFootHikingBody(LOT, LAUNCH) as {
      coordinates: number[][];
      elevation: boolean;
      options?: unknown;
    };
    expect(body.coordinates).toHaveLength(2);
    expect(body.coordinates[0]).toEqual([LOT.lng, LOT.lat]);
    expect(body.coordinates[1]).toEqual([LAUNCH.lng, LAUNCH.lat]);
    expect(body.coordinates[0]).not.toEqual(body.coordinates[1]);
    expect(body.options).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('round_trip');
  });

  /** No `elevation: true`, no ascent at all — a distance with a silently missing climb. */
  test('elevation is always requested, because ascent does not come back without it', () => {
    expect((orsFootHikingBody(LOT, LAUNCH) as { elevation: boolean }).elevation).toBe(true);
  });

  test('parses the one-way distance and ascent off the first feature', () => {
    const leg = parseOrsFootHikingRoute({
      features: [
        { properties: { summary: { distance: 1123.4, duration: 900 }, ascent: 91.2, descent: 12 } },
      ],
    });
    expect(leg).toEqual({ meters: 1123.4, ascentM: 91.2, routed: true });
  });

  /**
   * `summary.distance` is the total for the requested route. Summing `segments` is the shape that
   * doubles the moment anything adds a via-point, which is precisely the round-trip failure.
   */
  test('reads the summary, not a sum over segments', () => {
    const leg = parseOrsFootHikingRoute({
      features: [
        {
          properties: {
            summary: { distance: 1000 },
            ascent: 50,
            // A hostile shape: were we summing segments, this would read 2000.
            ...({ segments: [{ distance: 1000 }, { distance: 1000 }] } as object),
          },
        },
      ],
    });
    expect(leg?.meters).toBe(1000);
  });

  test('missing elevation data yields a distance with no climb rather than a zero climb', () => {
    const leg = parseOrsFootHikingRoute({
      features: [{ properties: { summary: { distance: 400 } } }],
    });
    expect(leg).toEqual({ meters: 400, ascentM: undefined, routed: true });
  });

  /**
   * The N6e Workstream 0 half: the line ORS hands us for free, which the first version of this
   * parser dropped on the floor. Recovering it cost a re-route of every hike-in leg against a
   * 2,000/day quota, so these tests pin the shape rather than the happy path alone.
   */
  describe('the approach line', () => {
    /** `[lng, lat, elevation]` — the shape `elevation: true` actually returns. */
    const legWithLine = (distance: number, coordinates: number[][]) =>
      parseOrsFootHikingRoute({
        features: [
          { properties: { summary: { distance }, ascent: 40 }, geometry: { coordinates } },
        ],
      });

    test('keeps the routed line on a hike-in leg, with the elevation ordinate stripped', () => {
      const leg = legWithLine(1200, [
        [-72.5, 44.5, 210],
        [-72.502, 44.5008, 232],
        [-72.504, 44.502, 251],
      ]);
      expect(leg?.path).toEqual([
        { lat: 44.5, lng: -72.5 },
        { lat: 44.5008, lng: -72.502 },
        { lat: 44.502, lng: -72.504 },
      ]);
      // A stored triple would be a third of the array's weight in a number no map reads, and the
      // climb is already on the row as `approachAscentM`.
      expect(JSON.stringify(leg?.path)).not.toContain('210');
    });

    test('simplifies to the shoreline tolerance rather than storing every ORS vertex', () => {
      // Eleven points on one straight line: everything between the ends is within tolerance of it.
      const straight = Array.from({ length: 11 }, (_, i) => [-72.5 + i * 0.0002, 44.5, 200]);
      expect(legWithLine(1000, straight)?.path).toHaveLength(2);
    });

    /**
     * The whole reason `approachPathWanted` is a shared predicate: the ETL decides what to re-route
     * with it, and the parser decides what to keep with it. Were they to drift, a leg would be paid
     * for against the quota and then have its geometry discarded.
     */
    test('drops the line below the hike-in threshold, however much geometry came back', () => {
      const line = [
        [-72.5, 44.5, 200],
        [-72.5004, 44.5006, 204],
      ];
      expect(legWithLine(SHORT_WALK_MAX_M, line)?.path).toBeUndefined();
      expect(legWithLine(SHORT_WALK_MAX_M + 1, line)?.path).toBeDefined();
    });

    /**
     * A truncated route is a walk that stops in the woods — a wrong answer wearing the shape of a
     * right one. No line falls back to the distance, which is honest.
     */
    test('drops a path that survives simplification over the cap, rather than truncating it', () => {
      const zigzag = Array.from({ length: APPROACH_PATH_MAX_VERTICES * 3 }, (_, i) => [
        -72.5 + i * 0.0002,
        44.5 + (i % 2) * 0.0003,
        200,
      ]);
      const leg = legWithLine(9_000, zigzag);
      expect(leg?.meters).toBe(9_000);
      expect(leg?.path).toBeUndefined();
    });

    test.each([
      ['no geometry at all', undefined],
      ['a single position', [[-72.5, 44.5, 200]]],
      ['positions that are not numbers', [['a', 'b'], [null]] as unknown as number[][]],
    ])('yields a distance with no line for %s', (_label, coordinates) => {
      const leg = parseOrsFootHikingRoute({
        features: [
          {
            properties: { summary: { distance: 1200 } },
            ...(coordinates ? { geometry: { coordinates } } : {}),
          },
        ],
      });
      expect(leg?.meters).toBe(1200);
      expect(leg?.path).toBeUndefined();
    });

    /**
     * Drawing a crow-flies segment would render a trail that does not exist, straight through
     * whatever lies between the lot and the launch — and it would look exactly like the routed lines
     * beside it. A number can carry the hedge "at least"; a line on a map cannot.
     */
    test('a straight-line fallback carries no line', () => {
      expect(straightLineApproach(LOT, LAUNCH).path).toBeUndefined();
    });

    test('approachPathWanted is the hike-in line, and it is exclusive at the boundary', () => {
      expect(approachPathWanted(SHORT_WALK_MAX_M)).toBe(false);
      expect(approachPathWanted(SHORT_WALK_MAX_M + 1)).toBe(true);
    });
  });

  /**
   * Found by drawing the lines: three legs in the corpus are **99 km** long, between a lot and a
   * launch 250 m apart. ORS is not wrong — that is the shortest walk when the two are on opposite
   * sides of an inlet with no bridge. It is not an *approach*, and once drawn it is a dashed trail
   * crossing three counties out of a lake's parking marker.
   */
  describe('plausibleApproach', () => {
    const LOT = { lat: 44.5, lng: -72.5 };
    const LAUNCH = destinationPoint(LOT, 90, 250);

    test('leaves an ordinary walk alone', () => {
      const leg = { meters: 1_240, ascentM: 96, routed: true, path: [LOT, LAUNCH] };
      expect(plausibleApproach(leg, LOT, LAUNCH)).toBe(leg);
    });

    test('demotes a leg routed the long way round the water to the straight-line rung', () => {
      const demoted = plausibleApproach(
        { meters: 99_151, ascentM: 900, routed: true, path: [LOT, LAUNCH] },
        LOT,
        LAUNCH,
      );
      expect(demoted.routed).toBe(false);
      expect(demoted.meters).toBeCloseTo(250, 0);
      // Both halves matter: the number was wrong, and the line would have drawn it.
      expect(demoted.path).toBeUndefined();
      expect(demoted.ascentM).toBeUndefined();
    });

    test('holds at the boundary rather than a metre either side of it', () => {
      const at = { meters: MAX_PLAUSIBLE_APPROACH_M, routed: true };
      const over = { meters: MAX_PLAUSIBLE_APPROACH_M + 1, routed: true };
      expect(plausibleApproach(at, LOT, LAUNCH).routed).toBe(true);
      expect(plausibleApproach(over, LOT, LAUNCH).routed).toBe(false);
    });

    /** A straight-line leg is already the fallback; re-deriving it would be a no-op with a cost. */
    test('leaves an unrouted leg untouched, however long', () => {
      const leg = { meters: 40_000, routed: false };
      expect(plausibleApproach(leg, LOT, LAUNCH)).toBe(leg);
    });

    /** The ceiling has to sit well clear of the range a human is made to assert (D144). */
    test('is far above the distance at which a person must assert the association', () => {
      expect(MAX_PLAUSIBLE_APPROACH_M).toBeGreaterThan(HIKE_IN_ASSERT_M * 2);
    });
  });

  test.each([
    ['no path found', {}],
    ['an empty feature list', { features: [] }],
    ['a feature with no summary', { features: [{ properties: {} }] }],
    [
      'a non-numeric distance',
      { features: [{ properties: { summary: { distance: Number.NaN } } }] },
    ],
  ])('returns null for %s, so the caller falls back rather than recording a zero', (_label, res) => {
    expect(parseOrsFootHikingRoute(res)).toBeNull();
  });

  test('the straight-line fallback is flagged, and carries no invented climb', () => {
    const leg = straightLineApproach(LOT, LAUNCH);
    expect(leg.routed).toBe(false);
    expect(leg.ascentM).toBeUndefined();
    expect(leg.meters).toBeCloseTo(haversineMeters(LOT, LAUNCH), 6);
  });

  /**
   * The reason the flag exists: a straight line is a **floor**. A caption that says "about" where it
   * should say "at least" understates exactly the trips that most need not to be understated.
   */
  test('the fallback never exceeds the routed distance for the same pair', () => {
    const routed = parseOrsFootHikingRoute({
      features: [{ properties: { summary: { distance: 1500 } } }],
    });
    expect(straightLineApproach(LOT, LAUNCH).meters).toBeLessThan(routed?.meters ?? 0);
  });
});

describe('chooseAccessTarget — the routing rule (D72)', () => {
  const LAUNCH = { lat: 44.51, lng: -72.5 };
  const LOT_COORD = { lat: 44.515, lng: -72.502 };

  const launch = (over: Partial<AccessPutIn> = {}): AccessPutIn => ({
    id: 'p1',
    coord: LAUNCH,
    source: 'osm',
    ...over,
  });
  const lot = (over: Partial<AccessParking> = {}): AccessParking => ({
    id: 'lot1',
    coord: LOT_COORD,
    source: 'osm',
    ...over,
  });

  /** The bug the phase exists for: a maps app handed a destination it cannot route a car to. */
  test('directions target the lot when one exists, and the launch when none does', () => {
    const withLot = chooseAccessTarget([launch({ parkingAreaId: 'lot1' })], [lot()]);
    expect(withLot?.coord).toEqual(LOT_COORD);
    expect(withLot?.via).toBe('parking');

    const without = chooseAccessTarget([launch()], []);
    expect(without?.coord).toEqual(LAUNCH);
    expect(without?.via).toBe('put_in');
  });

  test('the source ladder decides between launches', () => {
    const chosen = chooseAccessTarget(
      [
        launch({ id: 'derived', source: 'derived' }),
        launch({ id: 'official', source: 'official' }),
      ],
      [],
    );
    expect(chosen?.putIn.id).toBe('official');
  });

  test('between equals, the shorter walk wins', () => {
    const chosen = chooseAccessTarget(
      [launch({ id: 'far', approachMeters: 900 }), launch({ id: 'near', approachMeters: 120 })],
      [],
    );
    expect(chosen?.putIn.id).toBe('near');
  });

  /**
   * Annotate, never suppress (open question 3). A lake with three launches and one blocked gate is
   * still a lake worth telling someone about.
   */
  test('a blocked launch is de-prioritized, not removed', () => {
    const chosen = chooseAccessTarget(
      [launch({ id: 'blocked', source: 'official' }), launch({ id: 'open', source: 'derived' })],
      [],
      new Set(['blocked']),
    );
    // Sorts below an open one *despite* outranking it on the ladder.
    expect(chosen?.putIn.id).toBe('open');
    expect(chosen?.alerted).toBe(false);
  });

  test('when every launch is blocked, the best one is still returned and flagged', () => {
    const chosen = chooseAccessTarget([launch({ id: 'only' })], [], new Set(['only']));
    expect(chosen?.putIn.id).toBe('only');
    expect(chosen?.alerted).toBe(true);
  });

  test('an alert on the lot blocks the launch it serves', () => {
    const chosen = chooseAccessTarget(
      [launch({ parkingAreaId: 'lot1' })],
      [lot()],
      new Set(['lot1']),
    );
    expect(chosen?.alerted).toBe(true);
  });

  /** No access point is honestly nothing — never the centroid, which is water. */
  test('returns null when there is no access point at all', () => {
    expect(chooseAccessTarget([], [lot()])).toBeNull();
  });

  test('an operator override survives even with no parking to measure from', () => {
    const chosen = chooseAccessTarget([launch({ approachKindOverride: 'hike_in' })], []);
    expect(chosen?.approachKind).toBe('hike_in');
    expect(chosen?.approachMeters).toBeUndefined();
  });

  test('the approach is only reported when there is a lot to walk from', () => {
    const chosen = chooseAccessTarget([launch({ approachMeters: 700 })], []);
    expect(chosen?.approachMeters).toBeUndefined();
  });
});

describe('describeApproach', () => {
  const base = {
    coord: { lat: 44, lng: -72 },
    via: 'parking' as const,
    putIn: { id: 'p', coord: { lat: 44, lng: -72 }, source: 'osm' as const },
    alerted: false,
  };

  test('a routed walk reads "about"; a straight-line fallback reads "at least"', () => {
    const routed = describeApproach(
      { ...base, approachMeters: 400, approachRouted: true, approachKind: 'short_walk' },
      'metric',
    );
    expect(routed).toBe('Park here, then about 400 m on foot.');

    const flown = describeApproach(
      { ...base, approachMeters: 400, approachRouted: false, approachKind: 'short_walk' },
      'metric',
    );
    // A straight line under-reports, so the floor has to sound like one.
    expect(flown).toBe('Park here, then at least 400 m on foot.');
  });

  test('climb is included when measured and omitted when not — never zeroed', () => {
    expect(
      describeApproach(
        {
          ...base,
          approachMeters: 1100,
          approachAscentM: 90,
          approachRouted: true,
          approachKind: 'hike_in',
        },
        'metric',
      ),
    ).toBe('Park here, then about 1.1 km on foot, 90 m of climb.');

    expect(
      describeApproach(
        { ...base, approachMeters: 1100, approachRouted: true, approachKind: 'hike_in' },
        'metric',
      ),
    ).toBe('Park here, then about 1.1 km on foot.');
  });

  test('imperial switches units without changing the hedge', () => {
    expect(
      describeApproach(
        {
          ...base,
          approachMeters: 2000,
          approachAscentM: 30,
          approachRouted: true,
          approachKind: 'hike_in',
        },
        'imperial',
      ),
    ).toBe('Park here, then about 1.2 mi on foot, 98 ft of climb.');
  });

  /** For a pull-off and a bank, the honest thing to say is nothing at all. */
  test('says nothing for a drive-up, or when no walk was measured', () => {
    expect(
      describeApproach({ ...base, approachMeters: 40, approachKind: 'drive_up' }, 'metric'),
    ).toBeNull();
    expect(describeApproach(base, 'metric')).toBeNull();
  });
});

describe('bodyAccessKind', () => {
  /**
   * The minimum, not the maximum. A lake with a drive-up ramp and a remote hike-in launch is not a
   * hike-in lake — the trip a skater will actually make is the easy one. Taking the maximum would put
   * a Hike-In chip on Lake Champlain.
   */
  test('reports the easiest known way onto the lake', () => {
    expect(bodyAccessKind(['hike_in', 'drive_up'])).toBe('drive_up');
    expect(bodyAccessKind(['hike_in', 'short_walk'])).toBe('short_walk');
    expect(bodyAccessKind(['hike_in'])).toBe('hike_in');
  });

  test('ignores launches with no known approach, and says nothing when none are known', () => {
    expect(bodyAccessKind([undefined, 'hike_in', undefined])).toBe('hike_in');
    expect(bodyAccessKind([undefined, undefined])).toBeUndefined();
    expect(bodyAccessKind([])).toBeUndefined();
  });

  test('is order-independent', () => {
    expect(bodyAccessKind(['drive_up', 'hike_in'])).toBe(bodyAccessKind(['hike_in', 'drive_up']));
  });
});
