/**
 * *You skated past these* (A10 §3.4 / D12) — which of a body's active hazards a recorded track went
 * past, through, or across, so the sheet can offer a tick-through of confirmations instead of a
 * blank list.
 *
 * D12's second bullet — a confirmation filed from the report flow, `via: 'report_flow'` — has existed
 * since Phase 09a with no caller; `strava_path` likewise. This is its first build. Two stages, the
 * same shape as the on-ice proximity watcher: the hazard's stored **footprint bbox**, grown by the
 * pass distance, is the cheap prefilter against the track's own bbox, and only the survivors pay for
 * a per-point distance against the footprint (`distanceToHazard`, which measures the body-clipped
 * polygon when one is stored, so "passed" here is the halo the map drew).
 *
 * ## Three ways to have been there
 *
 * - **`entered`** — a track point lies inside the footprint. The strongest evidence, and the honest
 *   caveat is that a footprint is fuzzy by design (D51's uncertainty buffer), so "inside" means
 *   "inside the halo", not "on the hole".
 * - **`crossed`** — a track *segment* intersects the raw line of a linear hazard (a ridge, a heave,
 *   a working crack). Tested on segments, not points, because a phone sampling every few seconds at
 *   skating speed steps clean over a one-meter ridge; the two fixes either side of it are the
 *   evidence. This is what makes a `ridge_crossing` passage marker offerable (§6.3).
 * - **`passed`** — the nearest point came within `passMeters` of the footprint's edge. Close enough
 *   to have seen it; not evidence of anything more.
 *
 * Nothing here files anything. The sheet shows each as a question — *still there? / gone / didn't
 * look* — and silence is never a vote (§6.2). Ordered nearest-first, so the list a skater scans
 * starts with what they were closest to.
 */

import type { LineString, MultiPolygon, Polygon, Position } from 'geojson';
import { type BBox, bboxIntersects, expandBBox, type LatLng, pointInPolygon } from './geometry';
import { distanceToHazard, type HazardShape, hazardFootprint } from './hazardGeometry';
import type { HazardType } from './types';

/** How near the footprint's edge counts as "passed". Generous like the alert buffer: GPS is coarse. */
export const PASSED_HAZARD_METERS = 50;

/** A hazard as the per-body cache holds it — what the tick-through needs and nothing more. */
export interface PassableHazard {
  id: string;
  type: HazardType;
  shape: HazardShape;
  /** The body-clipped footprint stored at create (Phase 09b), when clipping changed the shape. */
  clippedFootprint?: Polygon | MultiPolygon;
  /** The stored footprint bbox — the prefilter, so no footprint is built for a hazard across the lake. */
  bbox: BBox;
}

/** A track point with its time, so the sheet can say *when* the skater passed. */
export interface PassedTrackPoint extends LatLng {
  timestamp: number;
}

export type PassedHazardHow = 'entered' | 'crossed' | 'passed';

export interface PassedHazard {
  hazardId: string;
  type: HazardType;
  how: PassedHazardHow;
  /** Meters from the nearest track point to the footprint's edge; 0 when a point was inside. */
  nearestMeters: number;
  /** The nearest track point's time. */
  nearestAtMs: number;
}

export interface PassedHazardsOptions {
  passMeters?: number;
}

/** The bbox of a track — `null` for an empty one. */
function trackBBox(track: readonly LatLng[]): BBox | null {
  if (track.length === 0) return null;
  let minLat = Number.POSITIVE_INFINITY;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  for (const p of track) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return { minLat, minLng, maxLat, maxLng };
}

/** Do segments a–b and c–d intersect (proper or touching)? Plain 2-D on `[lng, lat]`, fine at a ridge's scale. */
function segmentsIntersect(a: Position, b: Position, c: Position, d: Position): boolean {
  const orient = (p: Position, q: Position, r: Position): number => {
    const v =
      ((q[1] as number) - (p[1] as number)) * ((r[0] as number) - (q[0] as number)) -
      ((q[0] as number) - (p[0] as number)) * ((r[1] as number) - (q[1] as number));
    return v === 0 ? 0 : v > 0 ? 1 : -1;
  };
  const onSegment = (p: Position, q: Position, r: Position): boolean =>
    Math.min(p[0] as number, r[0] as number) <= (q[0] as number) &&
    (q[0] as number) <= Math.max(p[0] as number, r[0] as number) &&
    Math.min(p[1] as number, r[1] as number) <= (q[1] as number) &&
    (q[1] as number) <= Math.max(p[1] as number, r[1] as number);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, c, b)) return true;
  if (o2 === 0 && onSegment(a, d, b)) return true;
  if (o3 === 0 && onSegment(c, a, d)) return true;
  if (o4 === 0 && onSegment(c, b, d)) return true;
  return false;
}

/** Did any track segment cross the hazard's raw line? Linear hazards only; others are never "crossed". */
function trackCrossesLine(track: readonly LatLng[], line: LineString): boolean {
  const verts = line.coordinates;
  for (let i = 0; i + 1 < track.length; i++) {
    const a: Position = [track[i]?.lng as number, track[i]?.lat as number];
    const b: Position = [track[i + 1]?.lng as number, track[i + 1]?.lat as number];
    for (let j = 0; j + 1 < verts.length; j++) {
      if (segmentsIntersect(a, b, verts[j] as Position, verts[j + 1] as Position)) return true;
    }
  }
  return false;
}

/**
 * Which hazards the track went past, through, or across — nearest first. Pure; the caller supplies
 * the body's cached active hazards and the recorded (or imported) track.
 */
export function passedHazards(
  track: readonly PassedTrackPoint[],
  hazards: readonly PassableHazard[],
  options: PassedHazardsOptions = {},
): PassedHazard[] {
  const passMeters = options.passMeters ?? PASSED_HAZARD_METERS;
  const box = trackBBox(track);
  if (!box) return [];

  const out: PassedHazard[] = [];
  for (const hazard of hazards) {
    // Stage one: the stored bbox, grown by the pass distance, against the track's bbox.
    if (!bboxIntersects(expandBBox(hazard.bbox, passMeters), box)) continue;

    // Stage two: the nearest point, measured against the same footprint the map draws.
    let nearestMeters = Number.POSITIVE_INFINITY;
    let nearestAtMs = track[0]?.timestamp as number;
    let entered = false;
    const footprint = hazard.clippedFootprint ?? null;
    for (const point of track) {
      const d = distanceToHazard(point, hazard.shape, footprint);
      if (d < nearestMeters) {
        nearestMeters = d;
        nearestAtMs = point.timestamp;
      }
      if (d === 0) {
        entered = true;
        break;
      }
    }

    const crossed =
      hazard.shape.geometryKind === 'line' &&
      hazard.shape.geometry.type === 'LineString' &&
      trackCrossesLine(track, hazard.shape.geometry);

    if (!entered && !crossed && nearestMeters > passMeters) continue;
    out.push({
      hazardId: hazard.id,
      type: hazard.type,
      // A crossing outranks a fix inside a ridge's buffer: the passage is the fact worth offering.
      how: crossed ? 'crossed' : entered ? 'entered' : 'passed',
      nearestMeters: entered ? 0 : nearestMeters,
      nearestAtMs,
    });
  }
  out.sort((a, b) => a.nearestMeters - b.nearestMeters || a.nearestAtMs - b.nearestAtMs);
  return out;
}

/** Is a point inside a hazard's footprint? Exposed for the photo → hazard pre-location (§6.3). */
export function pointInHazard(point: LatLng, hazard: PassableHazard): boolean {
  return pointInPolygon(point, hazard.clippedFootprint ?? hazardFootprint(hazard.shape));
}
