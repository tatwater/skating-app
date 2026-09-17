/**
 * **A depth per bay, clipped out of its parent's survey** (A09 / D175, PR 2).
 *
 * ## Why this exists
 *
 * A bay's max depth is the one derived value the app cannot compute for itself: the soundings and
 * isobaths live here, in `.raw/`, not in Convex. `waterBodySubAreas.maxDepthM` therefore has exactly
 * one producer — this — and `subAreas.rederiveSubArea` *clears* the field on a redraw rather than
 * recomputing it, so the admin card asks for a re-run. **Inheriting the parent's would be a
 * safety-relevant lie** (D3): Malletts Bay is not as deep as Champlain's broad lake, and a bay page
 * reading the lake's 122 m is worse than one reading nothing.
 *
 * ## Same lanes, same claims as `lakeDepths.ts`
 *
 * - **Soundings** — the deepest sounding *inside the bay's outline* is a measurement of the bay.
 * - **Contours** — the deepest isobath with a vertex inside the outline is a **lower bound**: an
 *   isobath is where the depth equals its label, so a vertex of the 60 ft line inside the bay is
 *   water at least 60 ft deep inside the bay, and the basin the line encloses is deeper by an unknown
 *   amount. `understatesMax` says so, and the bay header reads it as *"max at least"*.
 *
 * `SUPERSEDED_DEPTH_SOURCES` does not apply here. It exists because NH's depth-band *polygons* give
 * the lake a real maximum that its contour *lines* only floor — but the bands are not clipped per
 * bay anywhere, so for a bay the lines are the only per-outline evidence the archive holds, and a
 * floor is honest where nothing is not.
 *
 * ## No mean, as before
 *
 * Founder call 2026-08-09: a sounding cloud is a survey track, not a sample of the basin. Max only.
 */

import { pointInPolygon } from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import { MAX_PLAUSIBLE_AGENCY_DEPTH_M } from './lakeDepths';
import type { ArchivedLake, Lane } from './lakes';
import { contourVertices } from './lakes';

/** Feet per meter — the archives are normalized to feet. */
const FEET_PER_METRE = 3.28084;

/** A live bay as `subAreas.exportForDepths` hands it over. */
export interface ExportedBay {
  subAreaId: string;
  subAreaKey: string;
  waterBodyId: string;
  name: string;
  polygon: Polygon | MultiPolygon;
  /**
   * When the outline last moved, as exported. Echoed back on the row so the loader can demand the
   * bay still carries exactly this stamp — a version check, immune to the CLI host's clock.
   */
  geometryUpdatedAt?: number;
}

/** What one archived lake says about one bay inside it. */
export interface BayDepth {
  subAreaId: string;
  subAreaKey: string;
  /** The stamp the depth was derived against — see `ExportedBay.geometryUpdatedAt`. */
  geometryUpdatedAt?: number;
  maxDepthM: number;
  lane: Lane;
  understatesMax: boolean;
  /** Soundings or isobath vertices that fell inside the outline. */
  sampleCount: number;
  sourceKey: string;
}

/** Why a bay got no depth from a lake that covers its parent. Named, never a silent filter. */
export type BayDepthSkip =
  /** No sounding, and no isobath vertex, fell inside the bay's outline. */
  | 'nothing-inside'
  /** Every reading inside was the shoreline zero. */
  | 'no-positive-depth'
  /** Past the backstop — a units error, not a bay. */
  | 'implausible';

/**
 * Clip one archived lake to one bay's outline and take the deepest thing left.
 *
 * Point-in-polygon per sounding / per vertex: Champlain's 105k rows against an 1,100-vertex bay is a
 * few hundred million ray-casts across its ten bays, which is seconds, not minutes, and runs once.
 */
export function bayDepthFor(
  lake: ArchivedLake,
  bay: ExportedBay,
): { ok: true; depth: BayDepth } | { ok: false; reason: BayDepthSkip } {
  let deepestFt = 0;
  let inside = 0;
  if (lake.soundings) {
    for (const s of lake.soundings) {
      if (!pointInPolygon({ lat: s.lat, lng: s.lng }, bay.polygon)) continue;
      inside++;
      if (s.depthFt > deepestFt) deepestFt = s.depthFt;
    }
  } else {
    for (const contour of lake.contours ?? []) {
      let hit = false;
      for (const [lng, lat] of contourVertices(contour)) {
        if (pointInPolygon({ lat: lat as number, lng: lng as number }, bay.polygon)) {
          hit = true;
          inside++;
        }
      }
      if (hit && contour.depthFt > deepestFt) deepestFt = contour.depthFt;
    }
  }
  if (inside === 0) return { ok: false, reason: 'nothing-inside' };
  if (!(deepestFt > 0)) return { ok: false, reason: 'no-positive-depth' };
  const maxDepthM = deepestFt / FEET_PER_METRE;
  if (maxDepthM > MAX_PLAUSIBLE_AGENCY_DEPTH_M) return { ok: false, reason: 'implausible' };
  return {
    ok: true,
    depth: {
      subAreaId: bay.subAreaId,
      subAreaKey: bay.subAreaKey,
      ...(bay.geometryUpdatedAt !== undefined ? { geometryUpdatedAt: bay.geometryUpdatedAt } : {}),
      maxDepthM,
      lane: lake.lane,
      understatesMax: lake.lane === 'contours',
      sampleCount: inside,
      sourceKey: lake.sourceKey,
    },
  };
}

export interface BayDepthResult {
  depths: BayDepth[];
  /**
   * **One final reason per bay that got no depth** — not one per (bay, archive) pair. A parent
   * covered by two archives can give a bay a depth from one and a skip from the other, and counting
   * the pair would put that bay in both the covered and the omitted columns, so the run row's
   * "unexplained" remainder would go negative (Greptile, PR #59). These add up with `depths` and
   * `uncovered` to exactly the bays in.
   */
  skipped: Record<BayDepthSkip, number>;
  /** Every refused (bay, archive) pair, for the log — the detail behind `skipped`, not its sum. */
  skippedPairs: { bay: string; lake: string; reason: BayDepthSkip }[];
  /** Live bays whose parent no archived lake covers — the correct D3 answer, counted so it is seen. */
  uncovered: number;
}

/**
 * The reason to report for a bay every archive refused: the most *informative* one. An implausible
 * reading says the archive has something inside the bay and it is wrong; a shoreline zero says the
 * survey reached the bay's edge and no further; nothing-inside says it never got there at all.
 */
const SKIP_PRIORITY: readonly BayDepthSkip[] = [
  'implausible',
  'no-positive-depth',
  'nothing-inside',
];

/**
 * Every bay against every archived lake that joined to its parent. A parent covered by two archives
 * (Champlain is only one; NH lakes can be) takes the deeper of the two answers — both are the
 * agency's own measurement of that water, and a floor is only ever raised by a measurement.
 */
export function bayDepths(
  bays: readonly ExportedBay[],
  lakesByParent: ReadonlyMap<string, readonly ArchivedLake[]>,
): BayDepthResult {
  const skipped: Record<BayDepthSkip, number> = {
    'nothing-inside': 0,
    'no-positive-depth': 0,
    implausible: 0,
  };
  const skippedPairs: BayDepthResult['skippedPairs'] = [];
  const depths: BayDepth[] = [];
  let uncovered = 0;
  for (const bay of bays) {
    const lakes = lakesByParent.get(bay.waterBodyId) ?? [];
    if (lakes.length === 0) {
      uncovered++;
      continue;
    }
    let best: BayDepth | null = null;
    const reasons: BayDepthSkip[] = [];
    for (const lake of lakes) {
      const outcome = bayDepthFor(lake, bay);
      if (!outcome.ok) {
        reasons.push(outcome.reason);
        skippedPairs.push({
          bay: bay.name,
          lake: `${lake.sourceKey}/${lake.lakeKey}`,
          reason: outcome.reason,
        });
        continue;
      }
      if (best === null || outcome.depth.maxDepthM > best.maxDepthM) best = outcome.depth;
    }
    if (best) {
      depths.push(best);
      continue;
    }
    const reason = SKIP_PRIORITY.find((r) => reasons.includes(r));
    if (reason !== undefined) skipped[reason]++;
  }
  return { depths, skipped, skippedPairs, uncovered };
}
