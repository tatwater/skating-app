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

import type { LineString, MultiPolygon, Polygon } from 'geojson';
import {
  type BBox,
  bboxIntersects,
  expandBBox,
  type LatLng,
  pointInPolygon,
  segmentsIntersect,
} from './geometry';
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

/** Did any track segment cross the hazard's raw line? Linear hazards only; others are never "crossed". */
function trackCrossesLine(track: readonly LatLng[], line: LineString): boolean {
  const verts = line.coordinates as [number, number][];
  for (let i = 0; i + 1 < track.length; i++) {
    const a: [number, number] = [track[i]?.lng as number, track[i]?.lat as number];
    const b: [number, number] = [track[i + 1]?.lng as number, track[i + 1]?.lat as number];
    for (let j = 0; j + 1 < verts.length; j++) {
      if (segmentsIntersect(a, b, verts[j] as [number, number], verts[j + 1] as [number, number]))
        return true;
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

    // Stage two: the nearest point, measured against the same footprint the map draws. The
    // footprint is built once per hazard, not once per fix: `distanceToHazard` buffers a line or
    // polygon shape on every call when no clipped footprint is stored, and a track has thousands
    // of fixes. A circle keeps its exact haversine path (no footprint), as on the watcher.
    let nearestMeters = Number.POSITIVE_INFINITY;
    let nearestAtMs = track[0]?.timestamp as number;
    let entered = false;
    const footprint =
      hazard.clippedFootprint ??
      (hazard.shape.geometryKind === 'point_radius' ? null : hazardFootprint(hazard.shape));
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
