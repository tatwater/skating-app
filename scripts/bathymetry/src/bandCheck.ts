/**
 * The checked assertions every lake's bands must pass before they reach a tile (B03 §2).
 *
 * A band set that is wrong looks exactly like one that is right — a filled lake — so each one is
 * measured against the three things that make it bands at all:
 *
 * - **They tile the lake.** Sampled on a lattice over the lake's bounding box, every point on the
 *   water is in exactly one band (*coverage*, *overlap*), no point off the water is in any (*spill*),
 *   and the bands' summed area matches the lake's (*area ratio*).
 * - **They are ordered.** Ascending `minDepthFt` is ascending `bandIndex`, each band's `bandIndex` is
 *   the ramp band of its lower edge, and a band's floor is never below the next band's ceiling.
 * - **They agree with the lines drawn over them.** A vertex of the 40 ft isobath must sit in the band
 *   whose range holds 40 ft (on a boundary level, either band beside it). This is the check that
 *   catches a band set with its depths inverted, which the first two cannot see.
 *
 * Pure, so it is tested against hand-built lakes — an island lake among them — and run on every lake
 * the build emits. A lake that fails is dropped and named, never published half-right.
 */

import { depthBandIndex } from '@skating/core';
import type { MultiPolygon, Polygon, Position } from 'geojson';
import type { BandSpec } from './bands';
import { areaSquareMeters } from './shoreline';

/** A ring with its edges bucketed by latitude, so a point test reads only the edges near it. */
class IndexedRing {
  private readonly bins: number[][];
  private readonly step: number;
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;

  constructor(private readonly ring: readonly Position[]) {
    let xmin = Number.POSITIVE_INFINITY;
    let xmax = Number.NEGATIVE_INFINITY;
    let ymin = Number.POSITIVE_INFINITY;
    let ymax = Number.NEGATIVE_INFINITY;
    for (const p of ring) {
      const x = p[0] as number;
      const y = p[1] as number;
      if (x < xmin) xmin = x;
      if (x > xmax) xmax = x;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
    this.xmin = xmin;
    this.xmax = xmax;
    this.ymin = ymin;
    this.ymax = ymax;
    const count = Math.max(1, Math.min(256, Math.ceil(ring.length / 8)));
    this.step = (ymax - ymin) / count || 1;
    this.bins = Array.from({ length: count }, () => []);
    for (let i = 0; i < ring.length - 1; i += 1) {
      const a = (ring[i] as Position)[1] as number;
      const b = (ring[i + 1] as Position)[1] as number;
      const lo = this.bin(Math.min(a, b));
      const hi = this.bin(Math.max(a, b));
      for (let k = lo; k <= hi; k += 1) this.bins[k]?.push(i);
    }
  }

  private bin(y: number): number {
    return Math.max(0, Math.min(this.bins.length - 1, Math.floor((y - this.ymin) / this.step)));
  }

  /** Even-odd: does a ray from `p` cross this ring an odd number of times? */
  crosses(x: number, y: number): boolean {
    if (x < this.xmin || x > this.xmax || y < this.ymin || y > this.ymax) return false;
    let inside = false;
    for (const i of this.bins[this.bin(y)] ?? []) {
      const a = this.ring[i] as Position;
      const b = this.ring[i + 1] as Position;
      const ay = a[1] as number;
      const by = b[1] as number;
      if (ay > y !== by > y) {
        const ax = a[0] as number;
        const bx = b[0] as number;
        if (x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
      }
    }
    return inside;
  }
}

/** A polygon or multipolygon, indexed for repeated point tests. Holes subtract (even-odd per part). */
export class IndexedArea {
  private readonly parts: IndexedRing[][];

  constructor(geometry: Polygon | MultiPolygon) {
    const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    this.parts = polys.map((rings) => rings.map((r) => new IndexedRing(r)));
  }

  contains(p: Position): boolean {
    const x = p[0] as number;
    const y = p[1] as number;
    for (const rings of this.parts) {
      let inside = false;
      for (const ring of rings) if (ring.crosses(x, y)) inside = !inside;
      if (inside) return true;
    }
    return false;
  }

  bounds(): { xmin: number; xmax: number; ymin: number; ymax: number } {
    let xmin = Number.POSITIVE_INFINITY;
    let xmax = Number.NEGATIVE_INFINITY;
    let ymin = Number.POSITIVE_INFINITY;
    let ymax = Number.NEGATIVE_INFINITY;
    for (const rings of this.parts) {
      const outer = rings[0];
      if (!outer) continue;
      xmin = Math.min(xmin, outer.xmin);
      xmax = Math.max(xmax, outer.xmax);
      ymin = Math.min(ymin, outer.ymin);
      ymax = Math.max(ymax, outer.ymax);
    }
    return { xmin, xmax, ymin, ymax };
  }
}

export interface CheckedBand {
  spec: BandSpec;
  geometry: MultiPolygon;
}

export interface BandCheck {
  /** Lattice points that fell on the lake. */
  inside: number;
  /** …of those, in exactly one band. */
  coveredOnce: number;
  /** …in no band. */
  uncovered: number;
  /** …in more than one band. */
  overlapped: number;
  /** Lattice points off the lake. */
  outside: number;
  /** …of those, inside some band anyway. */
  spilled: number;
  /** Summed band area over lake area. */
  areaRatio: number;
  /** Line vertices tested (those on the lake). */
  lineVertices: number;
  /** …of those, in a band whose range holds the line's depth. */
  lineAgree: number;
  /** Ordering violations, named. Empty when the bands are in depth order. */
  ordering: string[];
}

/** The bands' ordering, checked against each other and against the ramp. */
export function orderingErrors(bands: readonly CheckedBand[]): string[] {
  const errors: string[] = [];
  const seen = new Set<number>();
  for (const [i, band] of bands.entries()) {
    const { spec } = band;
    if (seen.has(spec.minDepthFt)) errors.push(`two features for the ${spec.minDepthFt} ft band`);
    seen.add(spec.minDepthFt);
    if (spec.bandIndex !== depthBandIndex(spec.minDepthFt)) {
      errors.push(`band from ${spec.minDepthFt} ft stamped index ${spec.bandIndex}`);
    }
    if (spec.maxDepthFt !== undefined && spec.maxDepthFt <= spec.minDepthFt) {
      errors.push(`band ${spec.minDepthFt}–${spec.maxDepthFt} ft is empty or inverted`);
    }
    const next = bands[i + 1]?.spec;
    if (!next) continue;
    if (next.minDepthFt <= spec.minDepthFt) errors.push('bands are not in ascending depth order');
    if (next.bandIndex < spec.bandIndex) errors.push('band index falls as depth rises');
    if (spec.maxDepthFt === undefined)
      errors.push(`open-ended band ${spec.minDepthFt} ft is not last`);
    else if (spec.maxDepthFt > next.minDepthFt) {
      errors.push(`band ${spec.minDepthFt}–${spec.maxDepthFt} ft overlaps the next in depth`);
    }
  }
  return errors;
}

/** Every `stride`-th vertex of a line set, at most `cap` per depth, so a dense lake is not O(vertices). */
export function sampleVertices(
  lines: readonly { depthFt: number; coordinates: Position[] }[],
  cap = 400,
): { depthFt: number; p: Position }[] {
  const byDepth = new Map<number, Position[]>();
  for (const l of lines) {
    const list = byDepth.get(l.depthFt) ?? [];
    list.push(...l.coordinates);
    byDepth.set(l.depthFt, list);
  }
  const out: { depthFt: number; p: Position }[] = [];
  for (const [depthFt, points] of byDepth) {
    const stride = Math.max(1, Math.floor(points.length / cap));
    for (let i = 0; i < points.length; i += stride) out.push({ depthFt, p: points[i] as Position });
  }
  return out;
}

/** Whether a band's depth range holds a line's depth, its edges included. */
export function rangeHolds(spec: BandSpec, depthFt: number): boolean {
  return (
    spec.minDepthFt <= depthFt && (spec.maxDepthFt === undefined || depthFt <= spec.maxDepthFt)
  );
}

export function checkBands(input: {
  lake: Polygon | MultiPolygon;
  bands: readonly CheckedBand[];
  lines: readonly { depthFt: number; coordinates: Position[] }[];
  lattice?: number;
}): BandCheck {
  const n = input.lattice ?? 64;
  const lake = new IndexedArea(input.lake);
  const bands = input.bands.map((b) => ({ spec: b.spec, area: new IndexedArea(b.geometry) }));
  const box = lake.bounds();

  let inside = 0;
  let coveredOnce = 0;
  let uncovered = 0;
  let overlapped = 0;
  let outside = 0;
  let spilled = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const p: Position = [
        box.xmin + ((i + 0.5) / n) * (box.xmax - box.xmin),
        box.ymin + ((j + 0.5) / n) * (box.ymax - box.ymin),
      ];
      const hits = bands.reduce((k, b) => k + (b.area.contains(p) ? 1 : 0), 0);
      if (lake.contains(p)) {
        inside += 1;
        if (hits === 1) coveredOnce += 1;
        else if (hits === 0) uncovered += 1;
        else overlapped += 1;
      } else {
        outside += 1;
        if (hits > 0) spilled += 1;
      }
    }
  }

  let lineVertices = 0;
  let lineAgree = 0;
  for (const { depthFt, p } of sampleVertices(input.lines)) {
    if (!lake.contains(p)) continue;
    lineVertices += 1;
    if (bands.some((b) => rangeHolds(b.spec, depthFt) && b.area.contains(p))) lineAgree += 1;
  }

  const lakeArea = areaSquareMeters(input.lake);
  const bandArea = input.bands.reduce((sum, b) => sum + areaSquareMeters(b.geometry), 0);
  return {
    inside,
    coveredOnce,
    uncovered,
    overlapped,
    outside,
    spilled,
    areaRatio: lakeArea > 0 ? bandArea / lakeArea : 0,
    lineVertices,
    lineAgree,
    ordering: orderingErrors(input.bands),
  };
}

/**
 * The thresholds. Not zero, because the lake polygon the check reads is OSM's raw one while the clip
 * ran against its `-makevalid` repair, and because a lattice point within a cell of a boundary can
 * land either side of it.
 */
export const BAND_LIMITS = {
  minCoverage: 0.97,
  maxOverlap: 0.005,
  maxSpill: 0.005,
  minAreaRatio: 0.97,
  maxAreaRatio: 1.01,
  minLineAgreement: 0.9,
  /** Below this many testable vertices the agreement figure is noise, and is not judged. */
  minLineVertices: 20,
} as const;

/** What a check failed on, named; empty means publish. */
export function bandVerdict(check: BandCheck, limits = BAND_LIMITS): string[] {
  const failures = [...check.ordering];
  const share = (k: number, of: number) => (of > 0 ? k / of : 0);
  const coverage = share(check.coveredOnce, check.inside);
  if (check.inside > 0 && coverage < limits.minCoverage) {
    failures.push(`covers ${(coverage * 100).toFixed(1)}% of the lake exactly once`);
  }
  const overlap = share(check.overlapped, check.inside);
  if (overlap > limits.maxOverlap)
    failures.push(`${(overlap * 100).toFixed(1)}% of the lake in two bands`);
  const spill = share(check.spilled, check.outside);
  if (spill > limits.maxSpill)
    failures.push(`${(spill * 100).toFixed(1)}% of the dry lattice in a band`);
  if (check.areaRatio < limits.minAreaRatio || check.areaRatio > limits.maxAreaRatio) {
    failures.push(`band area is ${(check.areaRatio * 100).toFixed(1)}% of the lake`);
  }
  if (check.lineVertices >= limits.minLineVertices) {
    const agree = share(check.lineAgree, check.lineVertices);
    if (agree < limits.minLineAgreement) {
      failures.push(`${(agree * 100).toFixed(1)}% of line vertices sit in their own depth's band`);
    }
  }
  return failures;
}
