/**
 * Every archived lake, from every source, in one shape — plus how a sample set is chosen (N6b).
 *
 * The sample renderer began as a Maine-only tool because Maine was where the density gate needed
 * looking at. Widening it to all five sources is what turns it from *"does the gate keep the right
 * lakes"* into *"does the chain draw a basin"*, and those are different questions with different
 * answers per lane:
 *
 * - **Sounding lanes (VT ANR, VT/NY Champlain, ME)** exercise the whole interpolation — this is our
 *   surface, and every artifact in it is ours.
 * - **Contour lanes (NH, MA)** exercise only the clip and the framing, because the agency already drew
 *   the isobaths. They belong in the same grid anyway, and precisely *because* they are not ours: a
 *   surveyed lake next to an interpolated one is the only honest calibration we have for how good the
 *   interpolated ones look.
 *
 * Reading lives in `lakeSources.ts`; **everything here is pure and tested**,
 * because "twenty lakes spanning shapes and sizes" is a claim that is easy to make and easy to get
 * silently wrong — take the first N of anything in this corpus and you get farm ponds, every time.
 */

import type { Position } from 'geojson';
import { assessDensity, type DensityAssessment } from './density';
import type { NormalizedContour, NormalizedSounding } from './normalize';
import { elongation, principalFrame } from './thalweg';

export type Lane = 'contours' | 'soundings';

/** One lake from one source, ready to render. Exactly one of the two record arrays is populated. */
export interface ArchivedLake {
  sourceKey: string;
  /** The state we file it under. Champlain is **VT**, where its source lives, though it covers NY too. */
  state: string;
  agency: string;
  lane: Lane;
  lakeKey: string;
  lakeName: string;
  soundings?: NormalizedSounding[];
  contours?: NormalizedContour[];
}

/** Vertices of a contour, whichever geometry type it arrived as. */
export function contourVertices(contour: NormalizedContour): Position[] {
  return contour.geometry.type === 'LineString'
    ? contour.geometry.coordinates
    : contour.geometry.coordinates.flat();
}

/**
 * A point guaranteed to be **on the water**, for the spatial join.
 *
 * The deepest sounding, or a mid-ring vertex of the deepest contour. Both rest on the same fact: the
 * deepest thing in a lake is the furthest from any shore, so it is the least likely to fall outside a
 * shoreline that a different survey drew at a different date. A centroid is not guaranteed to be on
 * water at all — on a crescent or horseshoe lake it lands on the headland in the middle — which was
 * found by watching a hand-rolled centroid join miss 4 of 6 real Maine lakes.
 */
export function representativePoint(lake: ArchivedLake): { lat: number; lng: number } | undefined {
  if (lake.soundings?.length) {
    let deepest = lake.soundings[0] as NormalizedSounding;
    for (const p of lake.soundings) if (p.depthFt > deepest.depthFt) deepest = p;
    return { lat: deepest.lat, lng: deepest.lng };
  }
  if (lake.contours?.length) {
    let deepest = lake.contours[0] as NormalizedContour;
    for (const l of lake.contours) if (l.depthFt > deepest.depthFt) deepest = l;
    const coords = contourVertices(deepest);
    // The midpoint rather than an endpoint: an open contour's ends sit against the mask or the shore,
    // which is exactly where two surveys' shorelines disagree.
    const mid = coords[Math.floor(coords.length / 2)];
    const lng = mid?.[0];
    const lat = mid?.[1];
    if (typeof lng === 'number' && typeof lat === 'number') return { lat, lng };
  }
  return undefined;
}

/** Deepest measurement in the lake, whichever lane it came from. */
export function maxDepthFt(lake: ArchivedLake): number {
  const records = lake.soundings ?? lake.contours ?? [];
  let max = 0;
  for (const r of records) if (r.depthFt > max) max = r.depthFt;
  return max;
}

/** Points to judge a lake's size and shape by — soundings directly, contour vertices otherwise. */
export function shapePoints(lake: ArchivedLake): { lng: number; lat: number }[] {
  if (lake.soundings) return lake.soundings;
  const out: { lng: number; lat: number }[] = [];
  for (const contour of lake.contours ?? []) {
    for (const c of contourVertices(contour)) {
      out.push({ lng: c[0] as number, lat: c[1] as number });
    }
  }
  return out;
}

/**
 * A gap this large, as a fraction of the lake's own extent, is not a lake — it is two of them.
 *
 * Scale-free on purpose, because the alternative traps are both live: an absolute threshold that
 * clears Lake Champlain (174 km, and genuinely one lake) would also clear a Maine key whose points are
 * scattered across 379 km of the state, while one tight enough to catch that would split Champlain.
 * A lake is *continuous at its own scale*; a key holding two ponds is not, at any scale.
 */
const DISJOINT_GAP_RATIO = 0.08;
/** …but never below this, so a small pond's ordinary transect spacing isn't read as a gap. */
const DISJOINT_GAP_FLOOR_M = 600;

/**
 * How many spatially separate water bodies a set of points actually covers.
 *
 * **Grid-based connected components, not pairwise distances.** The honest test is single-link
 * clustering, which is O(n²) and would be 400 million haversines across the corpus; binning to cells
 * of the gap size and unioning occupied neighbours answers the same question in one pass. The cost is
 * that the effective threshold is the cell diagonal rather than the radius, which errs toward
 * *merging* — the safe direction, since a false split would drop a real lake.
 */
export function spatialClusters(
  points: readonly { lng: number; lat: number }[],
  gapM: number,
): number {
  if (points.length === 0) return 0;
  if (!(gapM > 0)) return 1;

  let minLat = Number.POSITIVE_INFINITY;
  for (const p of points) if (p.lat < minLat) minLat = p.lat;
  const degLat = gapM / 111_320;
  const degLng = gapM / Math.max(1, 111_320 * Math.cos((minLat * Math.PI) / 180));

  const cells = new Map<string, number>();
  const keys: string[] = [];
  for (const p of points) {
    const key = `${Math.floor(p.lng / degLng)},${Math.floor(p.lat / degLat)}`;
    if (!cells.has(key)) {
      cells.set(key, keys.length);
      keys.push(key);
    }
  }

  const parent = keys.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    let walk = i;
    while (parent[walk] !== root) {
      const next = parent[walk] as number;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };

  for (const [key, index] of cells) {
    const [cx, cy] = key.split(',').map(Number) as [number, number];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        if (dx === 0 && dy === 0) continue;
        const neighbour = cells.get(`${cx + dx},${cy + dy}`);
        if (neighbour === undefined) continue;
        const a = find(index);
        const b = find(neighbour);
        if (a !== b) parent[a] = b;
      }
    }
  }

  const roots = new Set<number>();
  for (let i = 0; i < parent.length; i += 1) roots.add(find(i));
  return roots.size;
}

export interface LakeMetrics {
  extentM: number;
  elongation: number;
  maxDepthFt: number;
  recordCount: number;
  density?: DensityAssessment;
  /**
   * Separate water bodies sharing this one source key. **More than one is a bug in the source's own
   * keying**, not in ours, and it is fatal to the join: one key resolves to one polygon, so contours
   * from the other pond get clipped away against a shoreline miles from them. Found by rendering NH's
   * "Horseshoe Pond" as a blank card.
   */
  bodyCount: number;
}

export function measure(lake: ArchivedLake): LakeMetrics {
  const points = shapePoints(lake);
  const frame = principalFrame(points);
  const density = lake.soundings
    ? assessDensity({ lakeKey: lake.lakeKey, points: lake.soundings })
    : undefined;
  // Contour lanes get their extent from the assessor too — it is only measuring a bbox diagonal, and
  // reusing it keeps one definition of "how big is this lake" rather than two that drift.
  const extent = density ?? assessDensity({ lakeKey: lake.lakeKey, points }, { minPoints: 2 });
  const gapM = Math.max(DISJOINT_GAP_FLOOR_M, extent.extentM * DISJOINT_GAP_RATIO);
  return {
    extentM: extent.extentM,
    elongation: elongation(points, frame),
    maxDepthFt: maxDepthFt(lake),
    recordCount: (lake.soundings ?? lake.contours ?? []).length,
    density,
    bodyCount: spatialClusters(points, gapM),
  };
}

/**
 * Pick `count` items spanning a size range, breaking ties toward shape variety.
 *
 * **Sorting by size and taking the top N is the wrong answer, and so is taking the first N.** The
 * corpus is dominated by small waters — Maine's median lake carries 48 soundings — so an unweighted
 * pick returns farm ponds and a top-N pick returns nothing but the four largest lakes in the state.
 * Neither shows whether the chain works across the range it will actually meet.
 *
 * So: rank by size, cut into `count` equal buckets, and take one from each. Within a bucket, prefer
 * the candidate whose shape is least like anything already picked, which is what keeps a set of five
 * from being five long straight lakes that merely differ in length.
 */
export function spanSelect<T>(
  items: readonly T[],
  count: number,
  size: (item: T) => number,
  shape: (item: T) => number,
): T[] {
  if (count <= 0 || items.length === 0) return [];
  const sorted = [...items].sort((a, b) => size(a) - size(b));
  if (sorted.length <= count) return sorted;

  const picked: T[] = [];
  for (let bucket = 0; bucket < count; bucket += 1) {
    const start = Math.floor((bucket * sorted.length) / count);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * sorted.length) / count));
    const candidates = sorted.slice(start, end);

    let best = candidates[0] as T;
    let bestDistance = -1;
    for (const candidate of candidates) {
      // Distance to the NEAREST already-picked shape, maximised: a candidate is interesting when it
      // resembles nothing we already have, not when it differs from the average.
      let nearest = Number.POSITIVE_INFINITY;
      for (const already of picked) {
        nearest = Math.min(nearest, Math.abs(shape(candidate) - shape(already)));
      }
      const distance = picked.length === 0 ? 0 : nearest;
      if (distance > bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    picked.push(best);
  }
  return picked;
}
