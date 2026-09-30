/**
 * Which water body a landmark belongs to, and which candidates are one place (D202) — **every rule
 * the landmark pass applies after parsing**, pure and tested. Runs offline over a one-time export of
 * listed bodies' outlines, so the deployment is read once per body rather than once per landmark
 * (the A06d parking pass's 105 GB lesson).
 *
 * ## One rule per kind, because "near the water" means something different for each
 *
 * - An **island** is inside the lake's *outer* shore — in one of its holes, or, for an islet OSM drew
 *   as a node, on the water itself. The smallest such body wins: an island in a pond on an island in
 *   Champlain belongs to the pond. An island a causeway has joined to the land is no longer a hole,
 *   so failing containment it falls back to the shore within 100 m.
 * - A **bay** or **narrows** reference is water: on the body or within 200 m of it (GNIS points for
 *   bays often sit on the shore at the bay's head).
 * - A **point**, a **beach**, a **marina**, a **lighthouse**, a **dam**, a shore **establishment** or a
 *   named **rock** is shore: within its radius of the body's edge, nearest body wins. A cape's GNIS
 *   point can sit a few hundred meters up the headland; a hotel must be on the water to count.
 * - A **settlement** is every body within 750 m of it — a village on the shore of two ponds is a
 *   reference on both.
 * - A **bridge** is every body it crosses.
 * - A **waterway** is its mouths: each place a named river or stream crosses a body's shore, or ends
 *   at it. The direction comes from OSM's own convention (waterways are drawn downstream), so an inlet
 *   and an outlet of one river are two labels — though a later merge folds two within a kilometer.
 */

import type { BBox, LandmarkKind, LatLng } from '@skating/core';
import {
  bboxIntersects,
  distanceToPolygonMeters,
  expandBBox,
  filledPolygon,
  haversineMeters,
  landmarkNameKey,
  landmarksAreSamePlace,
  pointInPolygon,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import type { LandmarkCandidate } from './landmarkSource';

export interface MatchBody {
  id: string;
  name?: string;
  states?: string[];
  polygon: Polygon | MultiPolygon;
  bbox: BBox;
  surfaceAreaSqM: number;
}

type RuleMode = 'contained' | 'water' | 'shore' | 'every' | 'crossing' | 'mouths';

/** The per-kind rule. Radii are meters from the body's water (0 inside it). */
export const LANDMARK_MATCH_RULES: Readonly<
  Record<LandmarkKind, { mode: RuleMode; radiusM: number }>
> = {
  island: { mode: 'contained', radiusM: 100 },
  bay: { mode: 'water', radiusM: 200 },
  narrows: { mode: 'water', radiusM: 200 },
  point: { mode: 'shore', radiusM: 300 },
  beach: { mode: 'shore', radiusM: 150 },
  marina: { mode: 'shore', radiusM: 150 },
  establishment: { mode: 'shore', radiusM: 150 },
  lighthouse: { mode: 'shore', radiusM: 200 },
  dam: { mode: 'shore', radiusM: 100 },
  other: { mode: 'shore', radiusM: 100 },
  settlement: { mode: 'every', radiusM: 750 },
  bridge: { mode: 'crossing', radiusM: 25 },
  waterway: { mode: 'mouths', radiusM: 30 },
};

function boxOf(points: readonly LatLng[]): BBox {
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  return { minLat, minLng, maxLat, maxLng };
}

/** A grid over body bboxes — the offline stand-in for the deployment's cell index. */
export class BodyIndex {
  private readonly cells = new Map<string, MatchBody[]>();

  constructor(
    readonly bodies: readonly MatchBody[],
    private readonly cellDeg = 0.05,
  ) {
    for (const body of bodies) {
      for (const key of this.keys(body.bbox)) {
        const list = this.cells.get(key);
        if (list) list.push(body);
        else this.cells.set(key, [body]);
      }
    }
  }

  private *keys(box: BBox): Generator<string> {
    const x0 = Math.floor(box.minLng / this.cellDeg);
    const x1 = Math.floor(box.maxLng / this.cellDeg);
    const y0 = Math.floor(box.minLat / this.cellDeg);
    const y1 = Math.floor(box.maxLat / this.cellDeg);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) yield `${x}:${y}`;
  }

  /** Bodies whose bbox comes within `meters` of `box`. */
  near(box: BBox, meters: number): MatchBody[] {
    const wide = expandBBox(box, meters);
    const found = new Set<MatchBody>();
    for (const key of this.keys(wide)) {
      for (const body of this.cells.get(key) ?? []) {
        if (bboxIntersects(body.bbox, wide)) found.add(body);
      }
    }
    return [...found];
  }
}

/** At most this many footprint vertices are probed for a shore distance — a bound on the work. */
const MAX_PROBES = 40;

/** The points a candidate's distance to a body is measured from: its label point and its outline. */
function probes(c: LandmarkCandidate): LatLng[] {
  const outline = c.polygon ? (c.line ?? []) : [];
  if (outline.length <= MAX_PROBES) return [c.point, ...outline];
  const step = outline.length / MAX_PROBES;
  const sampled: LatLng[] = [c.point];
  for (let i = 0; i < MAX_PROBES; i++) sampled.push(outline[Math.floor(i * step)] as LatLng);
  return sampled;
}

function distanceTo(c: LandmarkCandidate, body: MatchBody): number {
  let min = Infinity;
  for (const p of probes(c)) {
    min = Math.min(min, distanceToPolygonMeters(p, body.polygon));
    if (min === 0) break;
  }
  return min;
}

/** One landmark placed on one body — what the loader writes. */
export interface PlacedLandmark {
  waterBodyId: string;
  name: string;
  kind: LandmarkKind;
  point: LatLng;
  areaSqM?: number;
  source: 'osm' | 'gnis';
  externalIds: string[];
  aliases: string[];
  corpusMessages?: number;
}

function placed(
  c: LandmarkCandidate,
  body: MatchBody,
  point: LatLng = c.point,
  suffix = '',
): PlacedLandmark {
  return {
    waterBodyId: body.id,
    name: c.name,
    kind: c.kind,
    point,
    ...(c.areaSqM !== undefined ? { areaSqM: c.areaSqM } : {}),
    source: c.source,
    externalIds: [`${c.sourceId}${suffix}`],
    aliases: [],
  };
}

/** The in-water vertex nearest the middle of a bridge's span — where its label belongs. */
function spanMiddle(inWater: readonly LatLng[]): LatLng {
  const lat = inWater.reduce((s, p) => s + p.lat, 0) / inWater.length;
  const lng = inWater.reduce((s, p) => s + p.lng, 0) / inWater.length;
  const center = { lat, lng };
  let best = inWater[0] as LatLng;
  for (const p of inWater) if (haversineMeters(p, center) < haversineMeters(best, center)) best = p;
  return best;
}

/**
 * Every mouth a line has on a body: `in` where it crosses from land onto the water (or ends at the
 * shore), `out` where it leaves (or starts at the shore). The label goes on the water-side vertex.
 */
export function mouthsOf(
  line: readonly LatLng[],
  body: MatchBody,
  radiusM: number,
): { point: LatLng; direction: 'in' | 'out' }[] {
  const wide = expandBBox(body.bbox, radiusM);
  const inside = line.map(
    (p) =>
      p.lat >= wide.minLat &&
      p.lat <= wide.maxLat &&
      p.lng >= wide.minLng &&
      p.lng <= wide.maxLng &&
      pointInPolygon(p, body.polygon),
  );
  const mouths: { point: LatLng; direction: 'in' | 'out' }[] = [];
  const first = line[0];
  const last = line[line.length - 1];
  if (first && !inside[0] && distanceToPolygonMeters(first, body.polygon) <= radiusM) {
    mouths.push({ point: first, direction: 'out' });
  }
  for (let i = 0; i + 1 < line.length; i++) {
    if (inside[i] === inside[i + 1]) continue;
    mouths.push(
      inside[i + 1]
        ? { point: line[i + 1] as LatLng, direction: 'in' }
        : { point: line[i] as LatLng, direction: 'out' },
    );
  }
  if (
    last &&
    line.length > 1 &&
    !inside[line.length - 1] &&
    distanceToPolygonMeters(last, body.polygon) <= radiusM
  ) {
    mouths.push({ point: last, direction: 'in' });
  }
  return mouths;
}

/** How far off the water an island that is no longer a hole may sit (a causeway, a filled channel). */
export const ISLAND_SHORE_RADIUS_M = 100;

/** The nearest body within `radiusM`, smaller winning a tie — or none. */
function nearest(
  c: LandmarkCandidate,
  bodies: readonly MatchBody[],
  radiusM: number,
): PlacedLandmark[] {
  let best: { body: MatchBody; distance: number } | null = null;
  for (const body of bodies) {
    const distance = distanceTo(c, body);
    if (distance > radiusM) continue;
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && body.surfaceAreaSqM < best.body.surfaceAreaSqM)
    ) {
      best = { body, distance };
    }
  }
  return best ? [placed(c, best.body)] : [];
}

/**
 * Place one candidate on the body or bodies it belongs to — `[]` when it belongs to none, which is
 * the common case (a Maine sea island, a hamlet in the hills) and a scope boundary, not a fault.
 */
export function matchLandmark(c: LandmarkCandidate, index: BodyIndex): PlacedLandmark[] {
  const rule = LANDMARK_MATCH_RULES[c.kind];
  const shape = c.line && c.line.length > 0 ? c.line : [c.point];
  const nearby = index.near(boxOf([c.point, ...shape]), rule.radiusM);
  if (nearby.length === 0) return [];

  switch (rule.mode) {
    case 'contained': {
      let best: MatchBody | null = null;
      for (const body of nearby) {
        if (!pointInPolygon(c.point, filledPolygon(body.polygon))) continue;
        if (!best || body.surfaceAreaSqM < best.surfaceAreaSqM) best = body;
      }
      if (best) return [placed(c, best)];
      // An island a causeway joined to the mainland is land in the body's outline, not a hole: it is
      // still the island skaters name, so it falls back to the shore rule.
      return nearest(c, nearby, ISLAND_SHORE_RADIUS_M);
    }
    case 'water':
    case 'shore':
      return nearest(c, nearby, rule.radiusM);
    case 'every':
      return nearby
        .filter((body) => distanceTo(c, body) <= rule.radiusM)
        .map((body) => placed(c, body));
    case 'crossing': {
      const out: PlacedLandmark[] = [];
      for (const body of nearby) {
        const inWater = shape.filter(
          (p) => distanceToPolygonMeters(p, body.polygon) <= rule.radiusM,
        );
        if (inWater.length > 0) out.push(placed(c, body, spanMiddle(inWater)));
      }
      return out;
    }
    case 'mouths': {
      const out: PlacedLandmark[] = [];
      for (const body of nearby) {
        mouthsOf(shape, body, rule.radiusM).forEach((mouth, i) => {
          out.push(placed(c, body, mouth.point, `#${mouth.direction}${i}`));
        });
      }
      return out;
    }
  }
}

/** Two establishments nearer than this are a street, not two references. */
export const STANDALONE_RADIUS_M = 250;

/**
 * The founder's rule for businesses: a camp, resort or hotel is always a landmark; a restaurant or a
 * store only when no *other* named establishment is within {@link STANDALONE_RADIUS_M}. A row of five
 * drops all five — none of them is what anyone would steer by. Everything else passes through.
 */
export function keepStandaloneEstablishments(
  candidates: readonly LandmarkCandidate[],
): LandmarkCandidate[] {
  const establishments = candidates.filter((c) => c.kind === 'establishment');
  const cell = 0.005; // ~500 m: a neighbor within 250 m is always in this cell or the next
  const grid = new Map<string, LandmarkCandidate[]>();
  const keyOf = (x: number, y: number) => `${x}:${y}`;
  for (const c of establishments) {
    const key = keyOf(Math.floor(c.point.lng / cell), Math.floor(c.point.lat / cell));
    const list = grid.get(key);
    if (list) list.push(c);
    else grid.set(key, [c]);
  }
  const crowded = (c: LandmarkCandidate): boolean => {
    const x = Math.floor(c.point.lng / cell);
    const y = Math.floor(c.point.lat / cell);
    const name = landmarkNameKey(c.name);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const other of grid.get(keyOf(x + dx, y + dy)) ?? []) {
          if (other === c || landmarkNameKey(other.name) === name) continue;
          if (haversineMeters(other.point, c.point) <= STANDALONE_RADIUS_M) return true;
        }
      }
    }
    return false;
  };
  return candidates.filter(
    (c) => c.kind !== 'establishment' || c.establishment === 'lodging' || !crowded(c),
  );
}

const SOURCE_RANK = (l: PlacedLandmark): number =>
  (l.source === 'osm' ? 0 : 2) + (l.areaSqM !== undefined ? 0 : 1);

/**
 * Fold one body's landmarks that are the same place — core's `landmarksAreSamePlace`, the one rule
 * the import and a moderator's duplicate check also use (same name within the kind's radius, kinds
 * that agree). OSM wins the name and point (it drew a footprint
 * or a precise node), GNIS contributes its id and, if spelled differently, an alias.
 *
 * A reference to the body *itself* is dropped: a GNIS bay or narrows named for the lake it is on
 * says nothing a label would.
 */
export function mergeSamePlace(
  landmarks: readonly PlacedLandmark[],
  body: MatchBody,
): PlacedLandmark[] {
  const bodyKey = body.name ? landmarkNameKey(body.name) : null;
  const ordered = [...landmarks].sort((a, b) => SOURCE_RANK(a) - SOURCE_RANK(b));
  const kept: PlacedLandmark[] = [];
  for (const l of ordered) {
    const key = landmarkNameKey(l.name);
    if (key === bodyKey && ['bay', 'narrows', 'other'].includes(l.kind)) continue;
    const twin = kept.find((k) =>
      landmarksAreSamePlace(
        { kind: k.kind, point: k.point, names: [k.name, ...k.aliases] },
        { kind: l.kind, point: l.point, names: [l.name, ...l.aliases] },
      ),
    );
    if (!twin) {
      kept.push({ ...l, externalIds: [...l.externalIds], aliases: [...l.aliases] });
      continue;
    }
    // The specific kind wins: a GNIS "Island" folded into an OSM rock is an island.
    if (twin.kind === 'other') twin.kind = l.kind;
    for (const id of l.externalIds) if (!twin.externalIds.includes(id)) twin.externalIds.push(id);
    if (l.name !== twin.name && !twin.aliases.includes(l.name)) twin.aliases.push(l.name);
  }
  return kept;
}

/** What a pass placed, and the tallies that say how much it placed from what. */
export interface PlacementResult {
  byBody: Map<string, PlacedLandmark[]>;
  counts: {
    candidates: number;
    crowdedEstablishments: number;
    unplaced: number;
    placements: number;
    merged: number;
    landmarks: number;
  };
}

/**
 * The whole placement, in the order it must run: the standalone rule first (it judges a business by
 * its neighbors, placed or not), then each candidate onto its bodies, then one body at a time the
 * same-place merge. Pure, so the order is tested rather than trusted to the CLI.
 */
export function placeLandmarks(
  candidates: readonly LandmarkCandidate[],
  index: BodyIndex,
): PlacementResult {
  const kept = keepStandaloneEstablishments(candidates);
  const raw = new Map<string, PlacedLandmark[]>();
  let unplaced = 0;
  let placements = 0;
  for (const c of kept) {
    const found = matchLandmark(c, index);
    if (found.length === 0) unplaced++;
    for (const l of found) {
      placements++;
      const list = raw.get(l.waterBodyId);
      if (list) list.push(l);
      else raw.set(l.waterBodyId, [l]);
    }
  }
  const bodies = new Map(index.bodies.map((b) => [b.id, b]));
  const byBody = new Map<string, PlacedLandmark[]>();
  let landmarks = 0;
  for (const [id, list] of raw) {
    const body = bodies.get(id) as MatchBody;
    const merged = mergeSamePlace(list, body);
    landmarks += merged.length;
    byBody.set(id, merged);
  }
  return {
    byBody,
    counts: {
      candidates: candidates.length,
      crowdedEstablishments: candidates.length - kept.length,
      unplaced,
      placements,
      merged: placements - landmarks,
      landmarks,
    },
  };
}
