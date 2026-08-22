import { destinationPoint, HIKE_IN_ASSERT_M, haversineMeters, type LatLng } from '@skating/core';
import { describe, expect, test } from 'vitest';
import {
  createTrailGraphBuilder,
  pairByTrailConnectivity,
  snapToTrail,
  TRAIL_PAIR_MAX_M,
  TRAIL_SNAP_M,
  type TrailWay,
  trailWalkMeters,
} from './trailGraph';

const ORIGIN = { lat: 44.5, lng: -72.5 };

/** A straight run of `meters` from `start` on `bearing`, vertexed every ~50 m like real OSM trail. */
function run(start: LatLng, bearing: number, meters: number): LatLng[] {
  const steps = Math.max(1, Math.round(meters / 50));
  const points: LatLng[] = [start];
  for (let i = 1; i <= steps; i++) {
    points.push(destinationPoint(start, bearing, (meters * i) / steps));
  }
  return points;
}

const graphOf = (...ways: TrailWay[]) => {
  const builder = createTrailGraphBuilder();
  for (const way of ways) builder.addWay(way);
  return builder.build();
};

describe('createTrailGraphBuilder', () => {
  /**
   * The premise the whole pass rests on: `osmium export` throws away node refs, but it round-trips
   * the same double for the same node, so two ways that meet share a byte-identical endpoint. 29% of
   * Vermont's trail endpoints are shared this way.
   */
  test('two ways sharing an endpoint coordinate become one connected node', () => {
    const first = run(ORIGIN, 0, 200);
    const junction = first[first.length - 1] as LatLng;
    const graph = graphOf(
      { id: 'way/1', coords: first },
      { id: 'way/2', coords: run(junction, 90, 200) },
    );

    expect(graph.stats.ways).toBe(2);
    // Four endpoints, one of them shared: three nodes.
    expect(graph.stats.nodes).toBe(3);
  });

  test('ways that merely pass near each other stay separate', () => {
    const graph = graphOf(
      { id: 'way/1', coords: run(ORIGIN, 0, 200) },
      { id: 'way/2', coords: run(destinationPoint(ORIGIN, 90, 3), 0, 200) },
    );
    // 3 m apart is a culvert or an underpass, not a junction. Fusing them would invent a crossing.
    expect(graph.stats.nodes).toBe(4);
  });

  /** The state extracts overlap at every border, so a way near one is exported twice. */
  test('the same way id is admitted once', () => {
    const coords = run(ORIGIN, 0, 200);
    const graph = graphOf({ id: 'way/1', coords }, { id: 'way/1', coords });
    expect(graph.stats.ways).toBe(1);
    expect(graph.stats.duplicates).toBe(1);
  });

  test.each([
    ['a single vertex', [ORIGIN]],
    ['no vertices', []],
    ['every vertex on the same point', [ORIGIN, ORIGIN, ORIGIN]],
  ])('refuses %s as degenerate rather than admitting a zero-length edge', (_label, coords) => {
    const graph = graphOf({ id: 'way/1', coords });
    expect(graph.stats.ways).toBe(0);
    expect(graph.stats.degenerate).toBe(1);
  });

  /** A loop trail is one node, and linking it twice would give the search two identical self-edges. */
  test('a closed loop links once', () => {
    const loop = [...run(ORIGIN, 0, 200), ...run(destinationPoint(ORIGIN, 0, 200), 180, 200)];
    const graph = graphOf({ id: 'way/1', coords: loop });
    expect(graph.stats.nodes).toBe(1);
    expect(graph.adjacency.get(0)).toHaveLength(1);
  });
});

describe('snapToTrail', () => {
  const graph = graphOf({ id: 'way/1', coords: run(ORIGIN, 0, 400) });

  test('finds a trail within the snap radius and reports the off-trail metres', () => {
    const beside = destinationPoint(destinationPoint(ORIGIN, 0, 200), 90, 20);
    const entry = snapToTrail(graph, beside);
    expect(entry?.wayIndex).toBe(0);
    expect(entry?.snapMeters).toBeLessThan(TRAIL_SNAP_M);
    // Snapped to the vertex nearest 200 m along, so both ends are roughly 200 m away.
    expect((entry?.toStart ?? 0) + (entry?.toEnd ?? 0)).toBeCloseTo(400, 0);
  });

  test('a point beyond the radius is on no trail at all', () => {
    expect(snapToTrail(graph, destinationPoint(ORIGIN, 90, TRAIL_SNAP_M + 25))).toBeUndefined();
  });

  /** The grid is an index, not a filter: a trail in the next cell must still be found. */
  test('finds a trail across a grid-cell boundary', () => {
    const far = graphOf({ id: 'way/1', coords: run({ lat: 44.5049, lng: -72.5 }, 90, 400) });
    const entry = snapToTrail(far, { lat: 44.50492, lng: -72.4995 });
    expect(entry).toBeDefined();
  });
});

describe('trailWalkMeters', () => {
  test('measures along a single way when both ends snapped to it', () => {
    const graph = graphOf({ id: 'way/1', coords: run(ORIGIN, 0, 1_000) });
    const a = snapToTrail(graph, destinationPoint(ORIGIN, 0, 100));
    const b = snapToTrail(graph, destinationPoint(ORIGIN, 0, 700));
    expect(trailWalkMeters(graph, a as never, b as never)).toBeCloseTo(600, -1);
  });

  test('walks across a junction between two ways', () => {
    const first = run(ORIGIN, 0, 300);
    const junction = first[first.length - 1] as LatLng;
    const second = run(junction, 90, 300);
    const graph = graphOf({ id: 'way/1', coords: first }, { id: 'way/2', coords: second });

    const meters = trailWalkMeters(
      graph,
      snapToTrail(graph, ORIGIN) as never,
      snapToTrail(graph, second[second.length - 1] as LatLng) as never,
    );
    expect(meters).toBeCloseTo(600, -1);
  });

  test('two trails that never meet are not connected, however close they run', () => {
    const graph = graphOf(
      { id: 'way/1', coords: run(ORIGIN, 0, 300) },
      { id: 'way/2', coords: run(destinationPoint(ORIGIN, 90, 25), 0, 300) },
    );
    const a = snapToTrail(graph, ORIGIN);
    const b = snapToTrail(graph, destinationPoint(destinationPoint(ORIGIN, 90, 25), 0, 300));
    expect(a?.wayIndex).not.toBe(b?.wayIndex);
    expect(trailWalkMeters(graph, a as never, b as never)).toBeUndefined();
  });

  test('refuses a walk that exceeds the budget', () => {
    const graph = graphOf({ id: 'way/1', coords: run(ORIGIN, 0, 2_000) });
    const a = snapToTrail(graph, ORIGIN) as never;
    const b = snapToTrail(graph, destinationPoint(ORIGIN, 0, 2_000)) as never;
    expect(trailWalkMeters(graph, a, b, 1_000)).toBeUndefined();
    expect(trailWalkMeters(graph, a, b, 2_500)).toBeCloseTo(2_000, -2);
  });

  /**
   * Dijkstra, not a hop-count BFS. Trail ways differ in length by three orders of magnitude, so a
   * BFS would happily prefer one 900 m track over three 100 m footpaths and report the wrong walk.
   */
  test('takes the shortest walk, not the one with fewest ways', () => {
    const a = ORIGIN;
    const b = destinationPoint(a, 0, 100);
    const c = destinationPoint(b, 0, 100);
    const d = destinationPoint(c, 0, 100);
    const graph = graphOf(
      { id: 'way/short-1', coords: run(a, 0, 100) },
      { id: 'way/short-2', coords: [b, ...run(b, 0, 100).slice(1)] },
      { id: 'way/short-3', coords: [c, ...run(c, 0, 100).slice(1)] },
      // One long way from a straight to d, the same two endpoints, five times the distance.
      {
        id: 'way/long',
        coords: [a, ...run(a, 90, 750), ...run(destinationPoint(a, 90, 750), 0, 750).slice(1), d],
      },
    );

    const meters = trailWalkMeters(
      graph,
      snapToTrail(graph, a) as never,
      snapToTrail(graph, d) as never,
    );
    expect(meters).toBeCloseTo(300, -1);
  });

  /**
   * A cycle is the shape that turns a naive search into a hang. Property-ish: a ring of ways, every
   * junction shared, searched from every node to every other — all must terminate with an answer no
   * greater than half the ring.
   */
  test('a ring of trails terminates and never reports more than the short way round', () => {
    const corners = [0, 90, 180, 270].map((b) => destinationPoint(ORIGIN, b, 200));
    const builder = createTrailGraphBuilder();
    for (let i = 0; i < corners.length; i++) {
      // Two-vertex edges, so an edge's weight is exactly the span between its corners — intermediate
      // vertices would inflate the weights and make the perimeter this asserts against a fiction.
      builder.addWay({
        id: `way/${i}`,
        coords: [corners[i] as LatLng, corners[(i + 1) % corners.length] as LatLng],
      });
    }
    const graph = builder.build();
    const perimeter = corners.reduce(
      (sum, corner, i) =>
        sum + haversineMeters(corner, corners[(i + 1) % corners.length] as LatLng),
      0,
    );

    for (const from of corners) {
      for (const to of corners) {
        if (from === to) continue;
        const meters = trailWalkMeters(
          graph,
          snapToTrail(graph, from) as never,
          snapToTrail(graph, to) as never,
          perimeter,
        );
        expect(meters).toBeDefined();
        expect(meters as number).toBeLessThanOrEqual(perimeter / 2 + 1);
      }
    }
  });

  /** Off-trail metres are part of the walk: the car to the path, the path, the path to the water. */
  test('counts both snaps in the total', () => {
    const graph = graphOf({ id: 'way/1', coords: run(ORIGIN, 0, 500) });
    const beside = destinationPoint(ORIGIN, 90, 30);
    const bare = trailWalkMeters(
      graph,
      snapToTrail(graph, ORIGIN) as never,
      snapToTrail(graph, destinationPoint(ORIGIN, 0, 500)) as never,
    ) as number;
    const snapped = trailWalkMeters(
      graph,
      snapToTrail(graph, beside) as never,
      snapToTrail(graph, destinationPoint(ORIGIN, 0, 500)) as never,
    ) as number;
    expect(snapped).toBeGreaterThan(bare);
  });
});

describe('pairByTrailConnectivity', () => {
  /** The case the whole pass exists for: a lot a kilometre up a trail, which no radius can reach. */
  test('pairs a trailhead lot with the launch its trail leads to', () => {
    const trail = run(ORIGIN, 0, 1_000);
    const graph = graphOf({ id: 'way/1', coords: trail });
    const result = pairByTrailConnectivity(
      graph,
      [{ externalId: 'node/launch', point: destinationPoint(ORIGIN, 0, 1_000) }],
      [{ externalId: 'way/lot', point: destinationPoint(ORIGIN, 90, 20) }],
    );

    expect(result.pairings).toHaveLength(1);
    expect(result.pairings[0]?.parkingExternalId).toBe('way/lot');
    expect(result.pairings[0]?.trailMeters).toBeGreaterThan(1_000);
  });

  test('a lot on no trail is never paired, however close it is', () => {
    const graph = graphOf({ id: 'way/1', coords: run(ORIGIN, 0, 1_000) });
    const result = pairByTrailConnectivity(
      graph,
      [{ externalId: 'node/launch', point: destinationPoint(ORIGIN, 0, 1_000) }],
      [{ externalId: 'way/lot', point: destinationPoint(ORIGIN, 90, 400) }],
    );
    expect(result.pairings).toHaveLength(0);
    expect(result.stats.lotsOnTrail).toBe(0);
  });

  test('takes the nearest connected lot when a launch is reachable from two', () => {
    const trail = run(ORIGIN, 0, 1_200);
    const graph = graphOf({ id: 'way/1', coords: trail });
    const result = pairByTrailConnectivity(
      graph,
      [{ externalId: 'node/launch', point: ORIGIN }],
      [
        { externalId: 'way/far', point: destinationPoint(ORIGIN, 0, 1_100) },
        { externalId: 'way/near', point: destinationPoint(ORIGIN, 0, 400) },
      ],
    );
    expect(result.pairings[0]?.parkingExternalId).toBe('way/near');
  });

  /**
   * The pre-filter is exact rather than heuristic — a walk is never shorter than the crow flight —
   * and it is what keeps this from being every launch × every lot.
   */
  test('prunes a pair that is already beyond the budget as the crow flies', () => {
    // The trail reaches both, so the lot *is* on the network — the prune is what stops the search,
    // not a failure to snap.
    const graph = graphOf({ id: 'way/1', coords: run(ORIGIN, 0, TRAIL_PAIR_MAX_M + 800) });
    const result = pairByTrailConnectivity(
      graph,
      [{ externalId: 'node/launch', point: ORIGIN }],
      [{ externalId: 'way/lot', point: destinationPoint(ORIGIN, 0, TRAIL_PAIR_MAX_M + 500) }],
    );
    expect(result.pairings).toHaveLength(0);
    expect(result.stats.prunedByDistance).toBe(1);
    expect(result.stats.searches).toBe(0);
  });

  /**
   * D144 drew this line for the human direction: above 1,600 m an association must be *asserted*
   * rather than derived. An ETL inferring a 3 km approach would be doing exactly what that forbids a
   * person from doing silently — so the inference budget is that constant, not a number of its own.
   */
  test('will not infer at a range where a human would be made to assert', () => {
    expect(TRAIL_PAIR_MAX_M).toBe(HIKE_IN_ASSERT_M);
  });
});
