/**
 * Hazard identity — one clustering primitive, read through two time windows (N5c / D77).
 *
 * *"Are these the same ridge you already marked?"* within a winter and *"is this the ridge that forms
 * here every winter?"* across winters are the **same geometric judgement** with a different time bound
 * and a different tolerance. So there is one function here and two constant sets, rather than two
 * implementations that would drift — this repo already carries that scar, in the hazard verdict
 * vocabulary that was written down in four places and updated in three (D65).
 *
 * Three properties are load-bearing, and each is a test:
 *
 * 1. **Matching is footprint-to-footprint, never centroid-to-centroid.** A `pressure_ridge` is a
 *    buffered LineString that often spans a bay; two ridges overlapping along different segments can
 *    have centroids 400 m apart while sharing 300 m of geometry. The tolerance is therefore a **gap**
 *    between edges, which makes 80 m a far tighter claim on a 600 m ridge than a radius would be.
 * 2. **Single-link, with a spread guard.** Transitive overlap along a ridge genuinely is one feature,
 *    which is what single-link is for — but its failure mode is *chaining*: A near B, B near C, C near
 *    D, and the cluster crosses the lake. A link is refused when it would push the cluster further
 *    beyond its largest member than the guard allows. Written down because a chained cluster produces
 *    the most confidently wrong output in the system and looks fine in every tidy fixture — and
 *    because both of the guard's obvious formulations are wrong on the shapes that matter here (see
 *    `DUPLICATE_MAX_CLUSTER_SPREAD_M` for the absolute-cap trap and `bboxExtentMeters` for the
 *    diagonal one).
 * 3. **Deterministic.** Greedy agglomeration depends on visit order, so members are sorted by
 *    `firstReportedAt` then id before anything else happens, and a property test asserts that a
 *    shuffled input yields identical clusters.
 *
 * **What this module does not do.** It has no opinion about *time* — a caller filters to one season or
 * to a window of them and hands over what is left. That is the whole reason one function can serve both
 * windows. It also has no opinion about what a cluster *suggests*: mapping a family to a `bodyFeatures`
 * type is a cross-season concern and lives with the recurrence job.
 */

import {
  type BBox,
  bboxIntersects,
  expandBBox,
  haversineMeters,
  polygonBBox,
  polygonDistanceMeters,
} from './geometry';
import { type HazardShape, hazardFootprint } from './hazardGeometry';
import type { HazardType } from './types';

/**
 * The groups within which hazards may be the same thing. Matching is **per family, never across** — a
 * spring and a ridge in the same bay are two facts about the lake, not one.
 */
export type HazardFamily = 'ridge' | 'spring' | 'gas' | 'reef' | 'volatile' | 'crack';

/**
 * A hazard type's family, or `null` when it never clusters.
 *
 * The first four mirror `promotionTargetFor` exactly, because those are the types whose cause is a
 * fixed property of the lake. Two more exist only here:
 *
 * - **`crack` clusters but never promotes.** Two people marking the same working crack today is a
 *   duplicate worth collapsing, even though a recurring crack is not a permanent feature of the lake.
 *   This is the first place the two windows diverge, and it is deliberate: *dedup is about identity,
 *   promotion is about permanence.*
 * - **`volatile`** is the family a single season could never justify promoting — a wind hole recurring
 *   is a coincidence of one January gale. Across seasons it is the strongest case in the phase, and it
 *   is the recurrence job's business, not this module's.
 *
 * **`ridge_crossing` never clusters, in either window.** It is a passage marker, not a danger
 * (D51/D64), and merging two crossings would claim a wider crossable span than anyone reported — the
 * anti-conservative direction, which is the one direction safety content never errs in.
 */
export function hazardFamilyFor(type: HazardType): HazardFamily | null {
  switch (type) {
    case 'pressure_ridge':
    case 'ice_heave':
      return 'ridge';
    case 'spring_current':
      return 'spring';
    case 'gas_hole':
      return 'gas';
    case 'reef_hole':
      return 'reef';
    case 'open_water':
    case 'thin_ice':
    case 'overflow_slush':
    case 'drain_hole':
    case 'wind_hole':
    case 'slush_hole':
    case 'thawed_rotten':
      return 'volatile';
    case 'wet_crack':
    case 'drilled_hole':
    case 'shell_area':
      return 'crack';
    case 'ridge_crossing':
      return null;
  }
}

/** Every family, which is the within-season set: a duplicate is a duplicate whatever its type family. */
export const DUPLICATE_FAMILIES = [
  'ridge',
  'spring',
  'gas',
  'reef',
  'volatile',
  'crack',
] as const satisfies readonly HazardFamily[];

/**
 * The cross-season set — everything except `crack`. A recurring working crack is not a permanent
 * feature of a lake, so there is nothing for a recurrence record to be *about*; collapsing two of
 * today's crack pins into one is still worth doing, which is why the two lists differ.
 */
export const RECURRENCE_FAMILIES = [
  'ridge',
  'spring',
  'gas',
  'reef',
  'volatile',
  // `as const`, not a widened annotation: the Convex validator needs the literal tuple to build the
  // `hazardRecurrence.family` union, so a `readonly HazardFamily[]` here would force the schema to
  // hand-write the same five strings — the second copy this whole phase exists to avoid.
] as const satisfies readonly HazardFamily[];

/** The families a cross-season record can be about — the stored `hazardRecurrence.family` union. */
export type RecurrenceFamily = (typeof RECURRENCE_FAMILIES)[number];

/**
 * Within a season, how close two footprints must come to be the same hazard (D77).
 *
 * **Tight for identity.** Two pins 25 m apart on the same afternoon are one lead seen twice; two pins
 * 80 m apart may well be two different leads on the same day, and collapsing those would under-warn.
 */
export const DUPLICATE_MATCH_METERS = 25;

/**
 * The chaining guard within a season: how far a cluster may extend **beyond its largest single
 * member**, in metres.
 *
 * **Relative, not absolute, and that correction matters.** The obvious guard is a cap on the cluster's
 * total span — but a `pressure_ridge` is routinely 600 m of buffered LineString, so any absolute cap
 * small enough to stop chaining would refuse to merge two pins of *one ridge*, which is the case this
 * whole mechanism exists for. Anchoring on the largest member instead says the honest thing: a cluster
 * may be about as big as the biggest thing anyone actually drew, plus a tolerance for the fact that
 * duplicates never sit exactly on top of each other.
 *
 * The anchor is the largest member's own span, never the running cluster's, so repeated merges cannot
 * ratchet the allowance upward one link at a time — which is chaining wearing a different hat.
 */
export const DUPLICATE_MAX_CLUSTER_SPREAD_M = 150;

/**
 * Across seasons, how close two footprints must come to be the same feature (D77).
 *
 * **Loose for recurrence**, and in that direction on purpose: a ridge re-forming within 80 m *is* the
 * same feature, because the ice does not reassemble to the metre.
 */
export const RECURRENCE_MATCH_METERS = 80;

/**
 * The chaining guard across seasons — wider, because the tolerance that feeds it is wider and because
 * a feature re-forming over four winters wanders further than one winter's duplicates of it do.
 */
export const RECURRENCE_MAX_CLUSTER_SPREAD_M = 400;

/** The minimum a hazard must expose to be clustered — a row or a cache entry, not a full document. */
export interface ClusterableHazard {
  id: string;
  type: HazardType;
  geometryKind: HazardShape['geometryKind'];
  geometry: HazardShape['geometry'];
  radiusMeters?: number;
  bufferMeters?: number;
  /** The body-clipped footprint when create stored one — measured directly, as render and proximity do. */
  clippedFootprint?: HazardShape['geometry'];
  /** The stored footprint bbox, used as the prefilter. Recomputed when absent. */
  bbox?: BBox;
  /** The season clock (D63) and the deterministic sort's primary key. */
  firstReportedAt: number;
}

/** One group of hazards judged to be the same thing. A singleton is the overwhelmingly common case. */
export interface HazardCluster<T> {
  family: HazardFamily;
  /** Canonically ordered: `firstReportedAt` ascending, then id. The first is the earliest sighting. */
  members: T[];
}

export interface ClusterHazardsOptions {
  /** The edge-to-edge gap at which two footprints are the same thing. */
  matchMeters: number;
  /** The chaining guard: how far a cluster may extend beyond its largest single member. */
  maxSpreadMeters: number;
  /** Which families participate — `DUPLICATE_FAMILIES` or `RECURRENCE_FAMILIES`. Defaults to all. */
  families?: readonly HazardFamily[];
}

/**
 * Group hazards into clusters of "the same thing", per type family.
 *
 * Everything that never clusters — passage markers, and any family the caller excluded — is simply
 * absent from the result rather than returned as a singleton. That keeps "this hazard has no cluster"
 * distinguishable from "this hazard is alone in its cluster", which the pooling gates care about: the
 * first must read the row, the second may read the cluster and get the same answer.
 *
 * A hazard whose footprint can't be computed (a malformed stored geometry) becomes a **singleton that
 * matches nothing**. Losing one pin's consensus is bad; letting one bad row throw and take out the
 * clustering for every other hazard on the lake is a safety failure — the same reasoning
 * `hazardLayer`'s `safeFootprint` and the proximity evaluator's try/catch already run on.
 */
export function clusterHazards<T extends ClusterableHazard>(
  members: readonly T[],
  { matchMeters, maxSpreadMeters, families = DUPLICATE_FAMILIES }: ClusterHazardsOptions,
): HazardCluster<T>[] {
  const allowed = new Set(families);
  const byFamily = new Map<HazardFamily, T[]>();
  for (const member of members) {
    const family = hazardFamilyFor(member.type);
    if (family === null || !allowed.has(family)) continue;
    const bucket = byFamily.get(family);
    if (bucket) bucket.push(member);
    else byFamily.set(family, [member]);
  }

  const clusters: HazardCluster<T>[] = [];
  // Families in a fixed order so the output is stable end to end, not merely stable within a family.
  for (const family of families) {
    const bucket = byFamily.get(family);
    if (!bucket) continue;
    for (const group of clusterOneFamily(bucket, matchMeters, maxSpreadMeters)) {
      clusters.push({ family, members: group });
    }
  }
  return clusters;
}

/**
 * Single-link agglomeration over one family, via union-find.
 *
 * The guard is checked against the **merged** bbox rather than against either input, so it bounds the
 * cluster that would result rather than the one that exists — which is what "a link is refused when it
 * *would* push the cluster past its allowance" means. Refusing a link leaves both sides intact and lets
 * a later pair link them if it can, which is the conservative outcome: a hazard that fails to join a
 * cluster keeps its own footprint and its own confirm loop, and nothing is under-warned.
 */
function clusterOneFamily<T extends ClusterableHazard>(
  bucket: readonly T[],
  matchMeters: number,
  maxSpreadMeters: number,
): T[][] {
  const sorted = [...bucket].sort(canonicalOrder);
  const n = sorted.length;
  const footprints = sorted.map(hazardFootprintOf);
  const boxes = footprints.map((fp, i) => fp && (sorted[i]?.bbox ?? polygonBBox(fp)));

  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    // Path compression, so a long chain of merges stays cheap on the next lookup.
    let walk = i;
    while (parent[walk] !== root) {
      const next = parent[walk] as number;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  /** The merged footprint bbox per root — what the guard is measured on. */
  const clusterBox = boxes.map((box) => box ?? null);
  /**
   * The largest *single member's* own extent per root, per axis — the guard's anchor. Tracked
   * separately from the cluster box so the allowance can never ratchet: it is the biggest thing anyone
   * drew, not the biggest thing merging has produced so far.
   */
  const anchor = boxes.map((box) => (box ? bboxExtentMeters(box) : { northSouth: 0, eastWest: 0 }));

  for (let i = 0; i < n; i++) {
    const boxI = boxes[i];
    const footI = footprints[i];
    if (!boxI || !footI) continue;
    for (let j = i + 1; j < n; j++) {
      const boxJ = boxes[j];
      const footJ = footprints[j];
      if (!boxJ || !footJ) continue;
      const rootI = find(i);
      const rootJ = find(j);
      if (rootI === rootJ) continue;
      // The prefilter: two footprints can only be within the tolerance if their boxes are, and this is
      // four comparisons on numbers already stored on the row where the exact test is an `O(n·m)` scan.
      if (!bboxIntersects(expandBBox(boxI, matchMeters), boxJ)) continue;
      if (polygonDistanceMeters(footI, footJ) > matchMeters) continue;
      const merged = unionBBox(clusterBox[rootI] as BBox, clusterBox[rootJ] as BBox);
      const anchorI = anchor[rootI] as BBoxExtent;
      const anchorJ = anchor[rootJ] as BBoxExtent;
      const widest: BBoxExtent = {
        northSouth: Math.max(anchorI.northSouth, anchorJ.northSouth),
        eastWest: Math.max(anchorI.eastWest, anchorJ.eastWest),
      };
      const mergedExtent = bboxExtentMeters(merged);
      if (
        mergedExtent.northSouth > widest.northSouth + maxSpreadMeters ||
        mergedExtent.eastWest > widest.eastWest + maxSpreadMeters
      ) {
        continue;
      }
      parent[rootJ] = rootI;
      clusterBox[rootI] = merged;
      anchor[rootI] = widest;
    }
  }

  // Grouped by root, and emitted in the order their earliest member appears — so the cluster list is
  // itself canonically ordered, not merely its contents.
  const groups = new Map<number, T[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const group = groups.get(root);
    const member = sorted[i] as T;
    if (group) group.push(member);
    else groups.set(root, [member]);
  }
  return [...groups.values()];
}

/**
 * `firstReportedAt` ascending, id ascending. A total order, which is what makes shuffle-invariance
 * provable rather than incidental — two hazards flagged in the same millisecond are common on the
 * offline flush path, where a batch of drafts lands with one clamped timestamp.
 */
function canonicalOrder(a: ClusterableHazard, b: ClusterableHazard): number {
  if (a.firstReportedAt !== b.firstReportedAt) return a.firstReportedAt - b.firstReportedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The footprint a hazard is matched on: the stored body-clipped polygon when present, else the
 * geometry grown by its radius or buffer — the same fallback ladder render, bbox and proximity use, so
 * "the same ridge" is judged on the shape a skater actually sees. `null` when it can't be built.
 */
export function hazardFootprintOf(hazard: ClusterableHazard) {
  try {
    if (
      hazard.clippedFootprint &&
      (hazard.clippedFootprint.type === 'Polygon' ||
        hazard.clippedFootprint.type === 'MultiPolygon')
    ) {
      return hazard.clippedFootprint;
    }
    return hazardFootprint({
      geometryKind: hazard.geometryKind,
      geometry: hazard.geometry,
      ...(hazard.radiusMeters !== undefined ? { radiusMeters: hazard.radiusMeters } : {}),
      ...(hazard.bufferMeters !== undefined ? { bufferMeters: hazard.bufferMeters } : {}),
    });
  } catch {
    return null;
  }
}

function unionBBox(a: BBox, b: BBox): BBox {
  return {
    minLat: Math.min(a.minLat, b.minLat),
    minLng: Math.min(a.minLng, b.minLng),
    maxLat: Math.max(a.maxLat, b.maxLat),
    maxLng: Math.max(a.maxLng, b.maxLng),
  };
}

/** A box's north–south and east–west extents in metres. */
export interface BBoxExtent {
  northSouth: number;
  eastWest: number;
}

/**
 * A box's extent along each axis — what the chaining guard compares, **per axis rather than as one
 * diagonal**.
 *
 * The diagonal is the obvious measure and it is wrong here, in a way that only shows up on the shapes
 * this phase is mostly about. Two 400 m ridges crossing at right angles genuinely overlap and are
 * plainly one cluster, but their merged box is 400 m square — a 566 m diagonal against a 400 m member,
 * so a diagonal guard refuses the merge purely because the two ridges point in different directions.
 * Comparing north–south against north–south and east–west against east–west compares like with like,
 * and the crossing pair passes while a chain of small pins walking one direction still doesn't.
 *
 * A bbox union is commutative, so the extent of a cluster never depends on the order its members
 * joined it — which is what the guard needs to mean anything.
 */
export function bboxExtentMeters(box: BBox): BBoxExtent {
  return {
    northSouth: haversineMeters(
      { lat: box.minLat, lng: box.minLng },
      { lat: box.maxLat, lng: box.minLng },
    ),
    eastWest: haversineMeters(
      { lat: box.minLat, lng: box.minLng },
      { lat: box.minLat, lng: box.maxLng },
    ),
  };
}
