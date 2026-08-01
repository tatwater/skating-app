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

import type { MultiPolygon, Polygon, Position } from 'geojson';
import { assessDensity, type DensityAssessment } from './density';
import type { NormalizedContour, NormalizedSounding } from './normalize';
import { characteristicLengthM } from './shoreline';
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
export function clusterLabels(
  points: readonly { lng: number; lat: number }[],
  gapM: number,
): number[] {
  if (points.length === 0) return [];
  if (!(gapM > 0)) return points.map(() => 0);

  let minLat = Number.POSITIVE_INFINITY;
  for (const p of points) if (p.lat < minLat) minLat = p.lat;
  const degLat = gapM / 111_320;
  const degLng = gapM / Math.max(1, 111_320 * Math.cos((minLat * Math.PI) / 180));

  const cells = new Map<string, number>();
  const keys: string[] = [];
  const cellOf: number[] = [];
  for (const p of points) {
    const key = `${Math.floor(p.lng / degLng)},${Math.floor(p.lat / degLat)}`;
    let index = cells.get(key);
    if (index === undefined) {
      index = keys.length;
      cells.set(key, index);
      keys.push(key);
    }
    cellOf.push(index);
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

  // Relabel roots to dense 0..n-1 in first-appearance order, so the labels are stable and a split
  // lake's sub-keys don't move between runs.
  const dense = new Map<number, number>();
  return cellOf.map((cell) => {
    const root = find(cell);
    let label = dense.get(root);
    if (label === undefined) {
      label = dense.size;
      dense.set(root, label);
    }
    return label;
  });
}

/** How many spatially separate water bodies a set of points covers. */
export function spatialClusters(
  points: readonly { lng: number; lat: number }[],
  gapM: number,
): number {
  return new Set(clusterLabels(points, gapM)).size;
}

/** The gap that separates two water bodies, for a lake of this extent. */
export function disjointGapFor(extentM: number): number {
  return Math.max(DISJOINT_GAP_FLOOR_M, extentM * DISJOINT_GAP_RATIO);
}

/**
 * Split a source key that holds more than one water body into one lake per body.
 *
 * **The fix for the defect §*What the wide render found* §1 recorded**, and it has to happen before
 * the join rather than after: one key resolves to one polygon, so an unsplit key sends the second
 * pond's geometry to be clipped against a shoreline miles away, and it vanishes without an error.
 * NH's `au_id` puts two ponds 51 km apart under *"Horseshoe Pond"*; Maine's MIDAS `870` scatters over
 * 379 km of the state.
 *
 * Sub-keys are suffixed `#1`, `#2`… **ordered by size, largest first**, so the principal body of a
 * collided key keeps a stable name across runs even if a satellite pond gains or loses readings.
 * A key holding one body is returned untouched and keeps its original key — the common case must not
 * pay a rename for the rare one.
 */
export function splitByBody(lake: ArchivedLake): ArchivedLake[] {
  const points = shapePoints(lake);
  if (points.length < 2) return [lake];

  const extent = assessDensity({ lakeKey: lake.lakeKey, points }, { minPoints: 2 }).extentM;
  const labels = clusterLabels(points, disjointGapFor(extent));
  const distinct = new Set(labels);
  if (distinct.size <= 1) return [lake];

  // Contour lanes have one label per VERTEX, not per feature, so a line is assigned by its first
  // vertex. A contour that straddles two clusters cannot exist — that is what "separate bodies" means.
  const buckets = new Map<
    number,
    { soundings: NormalizedSounding[]; contours: NormalizedContour[] }
  >();
  const bucket = (label: number) => {
    let b = buckets.get(label);
    if (!b) {
      b = { soundings: [], contours: [] };
      buckets.set(label, b);
    }
    return b;
  };

  if (lake.soundings) {
    lake.soundings.forEach((sounding, i) => {
      bucket(labels[i] ?? 0).soundings.push(sounding);
    });
  } else {
    let cursor = 0;
    for (const contour of lake.contours ?? []) {
      const label = labels[cursor] ?? 0;
      cursor += contourVertices(contour).length;
      bucket(label).contours.push(contour);
    }
  }

  const parts = [...buckets.entries()]
    .map(([label, records]) => ({
      label,
      count: records.soundings.length + records.contours.length,
      records,
    }))
    .filter((p) => p.count > 0)
    .sort((a, b) => b.count - a.count);

  return parts.map((part, index) => ({
    ...lake,
    lakeKey: `${lake.lakeKey}#${index + 1}`,
    ...(lake.soundings
      ? { soundings: part.records.soundings, contours: undefined }
      : { contours: part.records.contours, soundings: undefined }),
  }));
}

/** A lake set aside because another source already covers the same water body, and why. */
export interface Superseded {
  lake: ArchivedLake;
  reason: string;
}

/**
 * Where two sources cover the same water body, keep the survey and set our own fit aside.
 *
 * `splitByBody` is the *"one key, two lakes"* direction; this is the other one — **two source keys,
 * one lake**. A border lake is filed by both states, so it joins twice, and nothing downstream
 * noticed: every surviving lake writes its features under the same `bodyId`, and the client draws
 * whatever it finds there. In the first shipped archive that was Lower Kimball Pond and Province
 * Lake, each carrying NH GRANIT's published isobaths *and* our surface fitted through Maine's
 * soundings, drawn on top of each other.
 *
 * Two things break when that happens, and the second is the one that matters:
 *
 * - **The ramp spans two surveys.** `maxContourDepthFt` takes the deepest ring drawn, whichever
 *   source drew it, which is the union D83's vertical-datum rule exists to forbid.
 * - **The credit calls the agency's own survey ours.** `contourCredit` carries one `interpolated`
 *   flag for the whole body, so a lake with any fitted line renders *"interpolated by us"* over a
 *   list that includes the agency that surveyed it — precisely the claim §Maine step 5 and gate 3 of
 *   §6 say must never be blurred, inverted.
 *
 * **Only a lane disagreement is resolved**, and that restraint is the whole design. An agency filing
 * one lake under two keys — NH GRANIT files Great East Lake as both `NHLAK…` and `MELAK…`, and the
 * two halves together *are* the lake — is not a collision and must be left alone. What we refuse is
 * mixing a survey with a fit.
 *
 * Nothing is dropped silently: every superseded lake comes back with a reason, for `dropped.json`.
 */
export function preferSurveyedLane(
  lakes: readonly ArchivedLake[],
  bodyKeyFor: (lake: ArchivedLake) => string | undefined,
): { kept: ArchivedLake[]; superseded: Superseded[] } {
  const byBody = new Map<string, ArchivedLake[]>();
  for (const lake of lakes) {
    const key = bodyKeyFor(lake);
    // A lake that resolves to no body is the join's problem, not ours; it passes through and is
    // dropped downstream with the reason the join gives it.
    if (!key) continue;
    const group = byBody.get(key);
    if (group) group.push(lake);
    else byBody.set(key, [lake]);
  }

  const superseded: Superseded[] = [];
  const set = new Set<ArchivedLake>();
  for (const group of byBody.values()) {
    if (group.length < 2) continue;
    const surveyed = group.filter((l) => l.lane === 'contours');
    if (surveyed.length === 0 || surveyed.length === group.length) continue;
    const agencies = [...new Set(surveyed.map((l) => l.agency))].join(' · ');
    for (const lake of group) {
      if (lake.lane === 'contours') continue;
      superseded.push({
        lake,
        reason: `same water body as a surveyed lane (${agencies}); our fit would draw over the agency's own isobaths`,
      });
      set.add(lake);
    }
  }

  return { kept: lakes.filter((lake) => !set.has(lake)), superseded };
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

/**
 * Measure a lake.
 *
 * `polygon` is optional and changes one thing: the density gate's denominator. Given it, the coverage
 * gap is judged against **sqrt(lake area)** rather than the sounding bounding box's diagonal, which is
 * a fairness fix rather than a refinement — the diagonal rewards elongation, by up to 4x at the
 * extreme. Callers that are still choosing which lakes to look at (the sample renderer's selection
 * pass) do not have a polygon yet and fall back to the diagonal.
 */
export function measure(lake: ArchivedLake, polygon?: Polygon | MultiPolygon): LakeMetrics {
  const points = shapePoints(lake);
  const frame = principalFrame(points);
  const scaleM = polygon ? characteristicLengthM(polygon) : undefined;
  const density = lake.soundings
    ? assessDensity(
        { lakeKey: lake.lakeKey, points: lake.soundings },
        scaleM && scaleM > 0 ? { characteristicLengthM: scaleM } : {},
      )
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
