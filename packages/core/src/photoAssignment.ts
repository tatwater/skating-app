/**
 * Photos that assign themselves (A10-7 / §8.1, founder call 2026-09-23). A photo added to a Post
 * lands on a Report by **when** it was taken — inside that Report's skate window, with a margin —
 * else by **where**, its EXIF coordinate on or near that Report's lake; a photo the day cannot
 * explain stays in the Post's pool wearing a `?`, and the author says (a lake, the put-in, the lot,
 * a hazard, or leave it out). A coordinate on the water also **places** the photo (D42's opt-in,
 * pre-answered by the location being on the lake — never a coordinate off it, which is where a
 * home would be; the author can un-place it with one tap).
 *
 * The two questions use two shapes on purpose. *Which Report* reads the lake's box plus a margin:
 * a wrong answer there only moves a photo between the author's own tabs. *Placed* reads the lake's
 * outline, clear of every shore: a wrong answer there publishes a coordinate, and a box also
 * holds the islands, the coves and the houses around them.
 *
 * Pure, so the two surfaces agree on which lake a lunch photo is *not* on. Nothing here is a
 * safety claim (D3).
 */

import type { MultiPolygon, Polygon } from 'geojson';
import {
  type BBox,
  distanceToShorelineMeters,
  expandBBox,
  haversineMeters,
  type LatLng,
  pointInPolygon,
} from './geometry';
import { PHOTO_WINDOW_PAD_MS } from './photoWindow';

/** Before a Report's start (or its end, without one) and after its end — the library query's own pad. */
export const PHOTO_WINDOW_MARGIN_MS = PHOTO_WINDOW_PAD_MS;
/** Without a start, how far before the end a Report's photos are looked for. */
export const PHOTO_WINDOW_NO_START_MS = 2 * 60 * 60_000;
/** How far off the lake's bounding box a coordinate still counts as on it — for assignment only. */
export const PHOTO_LOCATION_MARGIN_M = 250;
/**
 * How far inside the outline, from every shore (an island's included), a coordinate must be for the
 * app to place a photo by itself. A phone's fix in a photo is often off by tens of meters and a
 * mapped shoreline by a few more; a dock, a beach or a house on the bank must not read as the lake.
 */
export const PHOTO_PLACE_SHORE_SETBACK_M = 50;
/** How near a hazard's pin a photo has to be to be suggested for it. */
export const PHOTO_NEAR_HAZARD_M = 150;

export interface AssignCandidate {
  reportId: string;
  startMs?: number;
  endMs?: number;
  /** The lake's bounding box, when its geometry is known — which Report a photo is about. */
  bbox?: BBox;
  /** The lake's outline, when known — whether a photo on this Report is placed by itself. */
  polygon?: Polygon | MultiPolygon;
}

export interface AssignablePhoto {
  takenAtMs?: number;
  coord?: LatLng;
}

export type AssignmentBasis = 'time' | 'location';

/** The window a Report's photos fall in: [start − margin, end + margin], or two hours back without a start. */
export function assignmentWindow(startMs: number | undefined, endMs: number): [number, number] {
  const from = (startMs ?? endMs - PHOTO_WINDOW_NO_START_MS) - PHOTO_WINDOW_MARGIN_MS;
  return [from, endMs + PHOTO_WINDOW_MARGIN_MS];
}

function inBBox(coord: LatLng, bbox: BBox, marginM: number): boolean {
  const box = expandBBox(bbox, marginM);
  return (
    coord.lat >= box.minLat &&
    coord.lat <= box.maxLat &&
    coord.lng >= box.minLng &&
    coord.lng <= box.maxLng
  );
}

/** Is this coordinate on (or within the margin of) the lake's box? Assignment's test, never placement's. */
export function onLake(coord: LatLng | undefined, bbox: BBox | undefined): boolean {
  if (!coord || !bbox) return false;
  return inBBox(coord, bbox, PHOTO_LOCATION_MARGIN_M);
}

/**
 * Is this coordinate on the water — inside the lake's outline and at least
 * `PHOTO_PLACE_SHORE_SETBACK_M` from every shore? The test for placing a photo by itself (D42
 * amendment). No outline, no placement: the author places by hand.
 */
export function onWater(
  coord: LatLng | undefined,
  polygon: Polygon | MultiPolygon | null | undefined,
): boolean {
  if (!coord || !polygon) return false;
  return (
    pointInPolygon(coord, polygon) &&
    distanceToShorelineMeters(coord, polygon) >= PHOTO_PLACE_SHORE_SETBACK_M
  );
}

/**
 * Which Report a photo belongs to, if the day can say. Time first: the Report whose window holds
 * the photo, the nearest end winning a tie (two visits to one lake). Then location: the Report
 * whose lake the coordinate is on. `null` is the pool.
 */
export function assignPhoto(
  photo: AssignablePhoto,
  candidates: readonly AssignCandidate[],
): { reportId: string; by: AssignmentBasis } | null {
  if (photo.takenAtMs !== undefined) {
    let best: { reportId: string; gap: number } | null = null;
    for (const c of candidates) {
      if (c.endMs === undefined) continue;
      const [from, to] = assignmentWindow(c.startMs, c.endMs);
      if (photo.takenAtMs < from || photo.takenAtMs > to) continue;
      const gap = Math.abs(c.endMs - photo.takenAtMs);
      if (best === null || gap < best.gap) best = { reportId: c.reportId, gap };
    }
    if (best) return { reportId: best.reportId, by: 'time' };
  }
  if (photo.coord !== undefined) {
    for (const c of candidates) {
      if (onLake(photo.coord, c.bbox)) return { reportId: c.reportId, by: 'location' };
    }
  }
  return null;
}

/** The photos within reach of a pin, nearest first — the hazard form's suggestions. */
export function photosNearPoint<P extends { coord?: LatLng }>(
  photos: readonly P[],
  point: LatLng,
  withinM = PHOTO_NEAR_HAZARD_M,
): P[] {
  return photos
    .flatMap((p) => (p.coord ? [{ p, d: haversineMeters(p.coord, point) }] : []))
    .filter((x) => x.d <= withinM)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.p);
}
