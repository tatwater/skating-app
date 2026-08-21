/**
 * The trail network as a graph, and the pairing it makes possible (N6e Workstream 0).
 *
 * ## What this exists to find
 *
 * N6d pairs a lot with a launch when they are within `PARKING_INFER_RADIUS_M` of each other. That is
 * proximity, and proximity cannot see the case the phase was written for: *"a couple of lakes that are
 * hike-in only where you park at least a mile from the ice."* Turning the radius up does not find it
 * either — measured over 3,000 unpaired lots, the distance curve to the nearest launch rises
 * monotonically out to 3–8 km, which is the signature of parking spread over a landscape where lakes
 * are everywhere, not of a distinct trailhead population sitting at a characteristic distance. A
 * one-mile radius would admit ~34,000 lots, overwhelmingly in dense MA and NY, to catch a handful of
 * genuine trailheads.
 *
 * **A trail is a different kind of evidence.** A lot at the end of a footpath that leads to a launch
 * *is* a trailhead — that is a fact somebody mapped, not a distance we guessed. So this module asks
 * "can you walk from that lot to that launch" instead of "are they close", and the answer is
 * qualitative even though the search is metric.
 *
 * ## Why the graph can be built from exported GeoJSON at all
 *
 * The blocker this work was sized against was node identity: `osmium export` writes coordinates and
 * throws away the node refs that tell you two ways meet. Measured on Vermont's 40,840 trail ways,
 * **29% of endpoints are shared by two or more ways as byte-identical coordinates** — the export
 * round-trips the same double for the same node. So the graph is built by hashing endpoint
 * coordinates, and needs no pyosmium, no node-ref extraction and no custom libosmium binding.
 *
 * `COORD_KEY_DP` is where that guarantee is cashed in, and it is the one number here that could
 * silently degrade the whole pass — see its note.
 *
 * ## What it deliberately does not do
 *
 * It does not store trails. The lines build the graph in memory and are discarded; what survives a
 * run is a lot↔launch pairing, which is then routed by ORS exactly like a proximity pairing and
 * carries the same `approachMeters`, ascent and line. A trail network in Convex would be a corpus of
 * its own — 600–900k geometries across five states — to answer a question that is settled here.
 */

import { HIKE_IN_ASSERT_M, haversineMeters, type LatLng } from '@skating/core';

/**
 * Decimal places a coordinate is rounded to before it becomes a node key.
 *
 * Seven, which is ~11 mm at this latitude — tight enough that two *different* nodes can never
 * collide, and loose enough to absorb the last-bit formatting differences the same node picks up
 * passing through different exports of overlapping state extracts.
 *
 * ⚠ **Loosening this does not make the graph better connected, it makes it wrong.** At 5 dp (~1.1 m)
 * two trails that cross without meeting — a footpath over a culvert, a path passing under a boardwalk
 * — would fuse into one node, and the walk this module reports would cross between them. The
 * connectivity is supposed to be OSM's assertion that two ways share a node, not our inference that
 * they nearly touch.
 */
const COORD_KEY_DP = 7;

/**
 * How far off a trail an access point may sit and still be considered *on* it.
 *
 * A launch is at the water and a lot is at a road, so neither is normally a trail vertex; 50 m is the
 * distance at which "the path ends at this lot" is still the obvious reading. It is also the figure
 * the sizing pass measured against — 6% of Vermont's unpaired launches and 31% of its unpaired lots
 * have a trail within it, and the launch side is the ceiling on everything this module can find.
 */
export const TRAIL_SNAP_M = 50;

/**
 * The longest walk this pass will **infer**.
 *
 * Deliberately `HIKE_IN_ASSERT_M` rather than a number of its own, because D144 already drew this
 * line for the other direction: above 1,600 m a human must *assert* an association rather than have
 * it derived, since a far-flung association costs its author nothing and costs a stranger a night.
 * An ETL inferring a 3 km approach would be doing precisely what that rule forbids a person from
 * doing silently.
 *
 * So the boundary is not a tuning value: **the pass will not guess at a range where it would demand a
 * human say the words.** Beyond it the answer is `setOfficialParking`, which has no distance limit
 * (D72 amendment) and attributes the claim to somebody.
 */
export const TRAIL_PAIR_MAX_M = HIKE_IN_ASSERT_M;

/**
 * Nodes one search may settle before it gives up.
 *
 * The distance budget bounds the *walk*; this bounds the *work*. In a dense trail network — an urban
 * park, a ski area — a 1,600 m budget can still reach thousands of nodes, and this pass runs one
 * search per candidate pair. A search that hits the cap returns "not connected", which is the right
 * failure: an unproven pairing is the status quo, and the status quo is safe.
 */
const MAX_NODES_SETTLED = 20_000;

/** Grid cell for the vertex index, in degrees — ~550 m of latitude, comfortably over `TRAIL_SNAP_M`. */
const CELL_DEG = 0.005;

/** One trail way, as the exporter hands it over. */
export interface TrailWay {
  id: string;
  coords: readonly LatLng[];
}

/** Where an access point enters the network, and what it costs to reach either end of its way. */
export interface TrailEntry {
  wayIndex: number;
  /** Off-trail metres from the point to the vertex it snapped to. Counted in the total. */
  snapMeters: number;
  /** Along-way metres from that vertex to the way's first and last vertex. */
  toStart: number;
  toEnd: number;
}

interface Way {
  id: string;
  /** Flat `[lat, lng, lat, lng, …]`. A Float64Array rather than objects: five states is millions of
   * vertices, and an object per vertex is the difference between 80 MB and half a gigabyte. */
  coords: Float64Array;
  /** Cumulative distance along the way, one entry per vertex. `cumulative[n-1]` is its length. */
  cumulative: Float64Array;
  startNode: number;
  endNode: number;
}

export interface TrailGraph {
  ways: Way[];
  /** node → the ways touching it, as `(wayIndex, otherNode, wayLength)` triples. */
  adjacency: Map<number, { wayIndex: number; other: number; meters: number }[]>;
  /** grid cell key → way indices with a vertex in that cell. */
  cells: Map<string, number[]>;
  /** Ways admitted, and ways refused as duplicates of one already seen (state extracts overlap). */
  stats: { ways: number; duplicates: number; degenerate: number; nodes: number };
}

const coordKey = (lat: number, lng: number): string =>
  `${lat.toFixed(COORD_KEY_DP)},${lng.toFixed(COORD_KEY_DP)}`;

const cellKey = (lat: number, lng: number): string =>
  `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / CELL_DEG)}`;

/**
 * Build the graph one way at a time.
 *
 * A builder rather than a function over an array, because the caller streams: holding five states of
 * trail geometry as GeoJSON objects before converting it is the shape that runs a laptop out of
 * memory, and the whole point of the compact representation is defeated if the loose one has to exist
 * first.
 */
export function createTrailGraphBuilder(): {
  addWay: (way: TrailWay) => void;
  build: () => TrailGraph;
} {
  const ways: Way[] = [];
  const adjacency: TrailGraph['adjacency'] = new Map();
  const cells: TrailGraph['cells'] = new Map();
  const nodeIds = new Map<string, number>();
  const seenWays = new Set<string>();
  let duplicates = 0;
  let degenerate = 0;

  const nodeFor = (lat: number, lng: number): number => {
    const key = coordKey(lat, lng);
    const existing = nodeIds.get(key);
    if (existing !== undefined) return existing;
    const id = nodeIds.size;
    nodeIds.set(key, id);
    return id;
  };

  const addWay = (way: TrailWay): void => {
    // The five state extracts overlap at every border, so a way near one is exported twice. Two
    // parallel edges would not break a search, but they would double-count in the stats and make the
    // "did the graph get bigger" question unanswerable between runs.
    if (seenWays.has(way.id)) {
      duplicates++;
      return;
    }
    seenWays.add(way.id);

    const n = way.coords.length;
    if (n < 2) {
      degenerate++;
      return;
    }

    const coords = new Float64Array(n * 2);
    const cumulative = new Float64Array(n);
    let running = 0;
    for (let i = 0; i < n; i++) {
      const point = way.coords[i] as LatLng;
      coords[i * 2] = point.lat;
      coords[i * 2 + 1] = point.lng;
      if (i > 0) running += haversineMeters(way.coords[i - 1] as LatLng, point);
      cumulative[i] = running;
    }
    // A way whose vertices are all the same point is a mapping artefact, not a trail. It would enter
    // the graph as a self-loop of zero length and settle in every search that reached it.
    if (running === 0) {
      degenerate++;
      return;
    }

    const first = way.coords[0] as LatLng;
    const last = way.coords[n - 1] as LatLng;
    const startNode = nodeFor(first.lat, first.lng);
    const endNode = nodeFor(last.lat, last.lng);
    const wayIndex = ways.length;
    ways.push({ id: way.id, coords, cumulative, startNode, endNode });

    const link = (from: number, other: number) => {
      const edges = adjacency.get(from);
      const edge = { wayIndex, other, meters: running };
      if (edges) edges.push(edge);
      else adjacency.set(from, [edge]);
    };
    link(startNode, endNode);
    // A closed loop has one node, and linking it twice would give the search two identical edges
    // between a node and itself.
    if (endNode !== startNode) link(endNode, startNode);

    const touched = new Set<string>();
    for (let i = 0; i < n; i++) {
      const key = cellKey(coords[i * 2] as number, coords[i * 2 + 1] as number);
      if (touched.has(key)) continue;
      touched.add(key);
      const bucket = cells.get(key);
      if (bucket) bucket.push(wayIndex);
      else cells.set(key, [wayIndex]);
    }
  };

  return {
    addWay,
    build: () => ({
      ways,
      adjacency,
      cells,
      stats: { ways: ways.length, duplicates, degenerate, nodes: nodeIds.size },
    }),
  };
}

/**
 * Where a point enters the network, or nothing if no trail comes within `maxMeters`.
 *
 * Snaps to the nearest **vertex** rather than the nearest point on a segment. OSM trail geometry is
 * densely vertexed — Vermont averages ~16 vertices per way — so the difference is metres, and a
 * vertex gives the along-way distance for free out of the cumulative array, where a projected point
 * would need it interpolated. The error is absorbed by `TRAIL_SNAP_M` being a threshold rather than a
 * measurement we report.
 */
export function snapToTrail(
  graph: TrailGraph,
  point: LatLng,
  maxMeters = TRAIL_SNAP_M,
): TrailEntry | undefined {
  const reach = Math.ceil(maxMeters / (CELL_DEG * 111_320)) + 1;
  const baseLat = Math.floor(point.lat / CELL_DEG);
  const baseLng = Math.floor(point.lng / CELL_DEG);
  const candidates = new Set<number>();
  for (let dLat = -reach; dLat <= reach; dLat++) {
    for (let dLng = -reach; dLng <= reach; dLng++) {
      for (const wayIndex of graph.cells.get(`${baseLat + dLat}:${baseLng + dLng}`) ?? []) {
        candidates.add(wayIndex);
      }
    }
  }

  let best: TrailEntry | undefined;
  let bestDistance = maxMeters;
  for (const wayIndex of candidates) {
    const way = graph.ways[wayIndex] as Way;
    const vertices = way.cumulative.length;
    for (let i = 0; i < vertices; i++) {
      const distance = haversineMeters(point, {
        lat: way.coords[i * 2] as number,
        lng: way.coords[i * 2 + 1] as number,
      });
      if (distance > bestDistance) continue;
      bestDistance = distance;
      const along = way.cumulative[i] as number;
      best = {
        wayIndex,
        snapMeters: distance,
        toStart: along,
        toEnd: (way.cumulative[vertices - 1] as number) - along,
      };
    }
  }
  return best;
}

/**
 * The shortest walk between two entries, or `undefined` if there is none inside the budget.
 *
 * Dijkstra rather than a plain BFS, because edges are trail ways and their lengths differ by three
 * orders of magnitude — a hop count would happily prefer one 4 km logging track over six 50 m
 * footpaths. The budget prunes the frontier, so the search stays local even in a network of millions
 * of nodes; `MAX_NODES_SETTLED` bounds the pathological case where "local" still means an entire
 * ski area's trail map.
 *
 * The two off-trail snaps are part of the answer: a walk is the metres from the car to the path, plus
 * the path, plus the metres from the path to the water.
 */
export function trailWalkMeters(
  graph: TrailGraph,
  from: TrailEntry,
  to: TrailEntry,
  budgetMeters = TRAIL_PAIR_MAX_M,
): number | undefined {
  const offTrail = from.snapMeters + to.snapMeters;
  if (offTrail > budgetMeters) return undefined;

  /**
   * Both ends on one way: walking that way is *a* route, and the common one for a trail that runs
   * from the lot straight to the launch.
   *
   * ⚠ **It is not necessarily the shortest, and treating it as an early return was wrong.** A point
   * beside a junction snaps to whichever of the meeting ways holds the nearest vertex, and that can
   * be a long way round the two ends of a shortcut — so a launch and a lot 300 m apart along a chain
   * of footpaths both snapped to the 2 km track they also touch, and the walk came back as 2 km or
   * as nothing at all. The along-way distance is therefore a **candidate and a budget**, not an
   * answer: search anyway, and take whichever is shorter.
   */
  const along =
    from.wayIndex === to.wayIndex ? Math.abs(from.toStart - to.toStart) : Number.POSITIVE_INFINITY;
  const budget = Math.min(budgetMeters - offTrail, along);
  if (budget < 0) return undefined;
  const finish = (walk: number | undefined): number | undefined => {
    const best = Math.min(walk ?? Number.POSITIVE_INFINITY, along);
    return Number.isFinite(best) && best <= budgetMeters - offTrail ? offTrail + best : undefined;
  };

  const fromWay = graph.ways[from.wayIndex] as Way;
  const toWay = graph.ways[to.wayIndex] as Way;
  const targets = new Map<number, number>();
  const noteTarget = (node: number, cost: number) => {
    const existing = targets.get(node);
    if (existing === undefined || cost < existing) targets.set(node, cost);
  };
  noteTarget(toWay.startNode, to.toStart);
  noteTarget(toWay.endNode, to.toEnd);

  const best = new Map<number, number>();
  // A small binary heap. The frontier is bounded by the budget, so an array-scan queue would be
  // acceptable most of the time and quadratic exactly in the dense networks that need the cap.
  const heap: { node: number; cost: number }[] = [];
  const push = (node: number, cost: number) => {
    const seen = best.get(node);
    if (seen !== undefined && seen <= cost) return;
    best.set(node, cost);
    heap.push({ node, cost });
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((heap[parent] as { cost: number }).cost <= (heap[i] as { cost: number }).cost) break;
      [heap[parent], heap[i]] = [heap[i] as (typeof heap)[0], heap[parent] as (typeof heap)[0]];
      i = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (
          left < heap.length &&
          (heap[left] as { cost: number }).cost < (heap[smallest] as { cost: number }).cost
        ) {
          smallest = left;
        }
        if (
          right < heap.length &&
          (heap[right] as { cost: number }).cost < (heap[smallest] as { cost: number }).cost
        ) {
          smallest = right;
        }
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [
          heap[i] as (typeof heap)[0],
          heap[smallest] as (typeof heap)[0],
        ];
        i = smallest;
      }
    }
    return top;
  };

  push(fromWay.startNode, from.toStart);
  push(fromWay.endNode, from.toEnd);

  let settled = 0;
  const done = new Set<number>();
  while (heap.length > 0) {
    const next = pop();
    if (!next) break;
    if (done.has(next.node)) continue;
    done.add(next.node);
    if (next.cost > budget) break; // The cheapest thing left is already too far.
    if (++settled > MAX_NODES_SETTLED) break;

    const arrival = targets.get(next.node);
    if (arrival !== undefined && next.cost + arrival <= budget) {
      return finish(next.cost + arrival);
    }

    for (const edge of graph.adjacency.get(next.node) ?? []) {
      const cost = next.cost + edge.meters;
      if (cost <= budget) push(edge.other, cost);
    }
  }
  // No graph route inside the budget — but an along-way walk may still be one, which is why every
  // exit from this search goes through `finish` rather than returning `undefined` directly.
  return finish(undefined);
}

/** One lot↔launch pairing the trail network found and proximity could not. */
export interface TrailPairing {
  putInExternalId: string;
  parkingExternalId: string;
  /** The walk along the trail, snaps included. Advisory: ORS re-measures it properly at routing. */
  trailMeters: number;
}

export interface TrailPairingInput {
  externalId: string;
  point: LatLng;
}

export interface TrailPairingResult {
  pairings: TrailPairing[];
  stats: {
    putInsConsidered: number;
    putInsOnTrail: number;
    lotsOnTrail: number;
    /** Pairs whose straight-line distance already exceeded the budget — never searched. */
    prunedByDistance: number;
    searches: number;
  };
}

/**
 * Pair unpaired launches with unpaired lots through the trail network.
 *
 * Takes only the rows proximity **failed** on, deliberately. A launch that already has a lot within
 * `PARKING_INFER_RADIUS_M` has a human-mapped answer, and second-guessing it with a graph walk would
 * be the pass overriding better evidence with worse.
 *
 * The straight-line pre-filter is not a heuristic: a walk is never shorter than the crow flight, so a
 * pair beyond the budget as the crow flies cannot come inside it on foot. It is exact, and it is what
 * keeps this from being every-launch × every-lot.
 */
export function pairByTrailConnectivity(
  graph: TrailGraph,
  putIns: readonly TrailPairingInput[],
  lots: readonly TrailPairingInput[],
  budgetMeters = TRAIL_PAIR_MAX_M,
): TrailPairingResult {
  const lotEntries: { input: TrailPairingInput; entry: TrailEntry }[] = [];
  for (const lot of lots) {
    const entry = snapToTrail(graph, lot.point);
    if (entry) lotEntries.push({ input: lot, entry });
  }

  const pairings: TrailPairing[] = [];
  let putInsOnTrail = 0;
  let prunedByDistance = 0;
  let searches = 0;

  for (const putIn of putIns) {
    const entry = snapToTrail(graph, putIn.point);
    if (!entry) continue;
    putInsOnTrail++;

    let best: { lot: TrailPairingInput; meters: number } | undefined;
    for (const lot of lotEntries) {
      if (haversineMeters(putIn.point, lot.input.point) > budgetMeters) {
        prunedByDistance++;
        continue;
      }
      searches++;
      const meters = trailWalkMeters(graph, entry, lot.entry, budgetMeters);
      if (meters === undefined) continue;
      if (!best || meters < best.meters) best = { lot: lot.input, meters };
    }

    // **The nearest connected lot, not every connected lot.** A launch has one `parkingAreaId`, and
    // a launch reachable from three lots is a launch you park at the closest of.
    if (best) {
      pairings.push({
        putInExternalId: putIn.externalId,
        parkingExternalId: best.lot.externalId,
        trailMeters: Math.round(best.meters),
      });
    }
  }

  return {
    pairings,
    stats: {
      putInsConsidered: putIns.length,
      putInsOnTrail,
      lotsOnTrail: lotEntries.length,
      prunedByDistance,
      searches,
    },
  };
}
