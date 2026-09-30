/**
 * Named landmarks — the points skaters steer by (D202).
 *
 * A landmark is a **labeled point on one water body**: an island, a point of land, a beach, a bay
 * named as a reference rather than skated as a destination, a narrows, a river's mouth, a bridge, a
 * marina, a lighthouse, a dam, the town on the shore, the camp or resort that owns a stretch of it.
 * It has no page, no favorite, no reports and no feed — that is what a sub-area is, and the founder's
 * rule draws the line (a place skaters *skate* is a sub-area; a place they *steer by* is a landmark).
 * What a landmark does have is a name a report can use: "a wind hole off Apple Island" becomes a
 * `where` that points at Apple Island rather than at a tap near the word "lake" on a screenshot.
 *
 * Everything here is vocabulary and arithmetic shared by the ETL, the server and both maps. Nothing
 * here is a safety claim (D3): a label says what a place is called, never what the ice there is like.
 */

import type { MultiPolygon, Polygon } from 'geojson';
import { requestNameKey } from './corpusRequests';
import { distanceToPolygonMeters, type LatLng, pointInPolygon } from './geometry';
import type { SubAreaCandidate } from './subArea';

/**
 * What kind of place a landmark is. The kind decides the label's weight and, in the ETL, how close
 * to the water a candidate must be to belong to a body.
 *
 * - `point` covers capes, peninsulas, heads and necks — the land that sticks out.
 * - `bay` is a bay **named as a reference**, never a sub-area: a bay node with no polygon, or a bay
 *   the corpus mentions but does not skate (D202's skated test).
 * - `narrows` is a channel, a gut or a strait — water between two shores.
 * - `waterway` is where a named river or stream meets the body: an inlet, an outlet, or a river
 *   passing through.
 * - `settlement` is a town, village or hamlet on the shore.
 * - `establishment` is a named camp, campground, resort, hotel, or a restaurant that stands alone.
 */
export const LANDMARK_KINDS = [
  'island',
  'point',
  'beach',
  'bay',
  'narrows',
  'waterway',
  'bridge',
  'marina',
  'lighthouse',
  'dam',
  'settlement',
  'establishment',
  'other',
] as const;
export type LandmarkKind = (typeof LANDMARK_KINDS)[number];

/** Display labels, for the moderator's kind picker and the sheet's grouping. */
export const LANDMARK_KIND_LABELS: Record<LandmarkKind, string> = {
  island: 'Island',
  point: 'Point',
  beach: 'Beach',
  bay: 'Bay',
  narrows: 'Narrows',
  waterway: 'River or stream',
  bridge: 'Bridge',
  marina: 'Marina',
  lighthouse: 'Lighthouse',
  dam: 'Dam',
  settlement: 'Town',
  establishment: 'Camp, resort or business',
  other: 'Other',
};

/**
 * Where a landmark row came from. `osm` and `gnis` are the ETL; `corpus` is a name the community's
 * emails supplied that no catalog had; `moderator` is a point a moderator dropped on the lake editor;
 * `proposal` is a skater's ask a moderator approved.
 */
export const LANDMARK_SOURCES = ['osm', 'gnis', 'corpus', 'moderator', 'proposal'] as const;
export type LandmarkSource = (typeof LANDMARK_SOURCES)[number];

/** A landmark's name — a place name, not a sentence. The same bound a bay request's name carries. */
export const MAX_LANDMARK_NAME_LENGTH = 80;

/** How many aliases one landmark keeps. The corpus's worst case is five spellings of one bay. */
export const MAX_LANDMARK_ALIASES = 12;

/**
 * The most landmarks one body holds, **bounded at the write** (the A07b lens): the ETL refuses a row
 * past it and a moderator is told, so `listForBody` can `take` this many and know it has them all.
 * Champlain's GNIS box alone holds ~400 island, cape and bay points; this leaves room for the OSM
 * streams, bridges and shore establishments on top of them.
 */
export const MAX_LANDMARKS_PER_BODY = 1_500;

/**
 * The key two spellings of one landmark share: `requestNameKey`'s fold (case, apostrophes, saint →
 * st, punctuation) plus a leading "the" dropped, because "the Gut" and "Gut" are one place and the
 * corpus writes both.
 */
export function landmarkNameKey(name: string): string {
  return requestNameKey(name).replace(/^the /, '');
}

/**
 * How much a kind weighs when labels compete for the same spot on the map, before the community has
 * said anything. Islands, points, reference bays, narrows and lighthouses are what skaters steer by;
 * a restaurant is a weaker reference even when it stands alone.
 */
const KIND_WEIGHT: Record<LandmarkKind, number> = {
  island: 2,
  point: 2,
  bay: 2,
  narrows: 2,
  lighthouse: 2,
  waterway: 1.5,
  bridge: 1.5,
  marina: 1.5,
  dam: 1.5,
  beach: 1,
  settlement: 1,
  other: 1,
  establishment: 0.5,
};

export interface LandmarkProminenceInput {
  kind: LandmarkKind;
  /** The landmark's own area, for the features OSM draws as polygons (islands, points, beaches). */
  areaSqM?: number;
  /** Messages in the community corpus that name it — the prior. */
  corpusMessages?: number;
  /** Reports whose `where` names it — the evidence that accrues. */
  reportCount?: number;
}

/**
 * A landmark's prominence: a non-negative score where higher wins a crowded spot on the map and a
 * higher place in the sheet's list. The kind is the floor; what the community says and how big the
 * place is raise it. Each term is logarithmic so the fortieth mention is worth less than the second —
 * one very chatty island should not bury every other name on the lake.
 */
export function landmarkProminence(input: LandmarkProminenceInput): number {
  const messages = Math.max(0, input.corpusMessages ?? 0);
  const reports = Math.max(0, input.reportCount ?? 0);
  const area = input.areaSqM ?? 0;
  // Area counts from a hectare up, and stops counting at a square kilometer: past that the label's
  // zoom already comes from the area itself (`landmarkLabelMinZoom`), so the sort need not.
  const areaTerm = area > 10_000 ? Math.min(2, Math.log10(area / 10_000)) : 0;
  return (
    KIND_WEIGHT[input.kind] + 2 * Math.log2(1 + messages) + 2 * Math.log2(1 + reports) + areaTerm
  );
}

/** The zoom band labels live in: never a whole-lake label, never past street detail. */
export const LANDMARK_LABEL_MIN_ZOOM = 11;
export const LANDMARK_LABEL_MAX_ZOOM = 16;

/**
 * How wide, in screen pixels, a place's own footprint must draw before its name earns a label on
 * size alone — about the width of a short word at the label's font size.
 */
const LABEL_FIT_PX = 60;

/** Meters per screen pixel at zoom 0 at the equator, for MapLibre's 512-pixel tiles. */
const METERS_PER_PX_Z0 = 78_271.517;

/**
 * The zoom a landmark's label first appears at: the founder's rule, as arithmetic. A place with a
 * footprint earns its label when it draws big enough to carry one; any place earns it by prominence,
 * one zoom sooner per two points of score. Whichever comes first wins, clamped to the label band.
 *
 * Crowding is the renderer's job, not this function's: labels are symbols with collision on, sorted
 * by prominence, so a lonely name shows at its zoom and a crowded one waits until there is room.
 */
export function landmarkLabelMinZoom(input: LandmarkProminenceInput & { lat: number }): number {
  const byProminence = 15 - landmarkProminence(input) / 2;
  let zoom = byProminence;
  if (input.areaSqM !== undefined && input.areaSqM > 0) {
    const cosLat = Math.max(0.1, Math.cos((input.lat * Math.PI) / 180));
    const bySize = Math.log2((METERS_PER_PX_Z0 * cosLat * LABEL_FIT_PX) / Math.sqrt(input.areaSqM));
    zoom = Math.min(zoom, bySize);
  }
  return Math.min(LANDMARK_LABEL_MAX_ZOOM, Math.max(LANDMARK_LABEL_MIN_ZOOM, zoom));
}

/**
 * A landmark's name and aliases, cleaned for storage: trimmed, bounded, and the aliases de-duplicated
 * by `landmarkNameKey` with any that only re-spell the name dropped. Returns `null` for a name that
 * is empty or too long — the caller says why, in its own voice.
 */
export function normalizeLandmarkNames(
  name: string,
  aliases: readonly string[] = [],
): { name: string; aliases: string[] } | null {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length > MAX_LANDMARK_NAME_LENGTH) return null;
  const seen = new Set([landmarkNameKey(trimmed)]);
  const kept: string[] = [];
  for (const alias of aliases) {
    const clean = alias.trim().replace(/\s+/g, ' ');
    const key = landmarkNameKey(clean);
    if (!clean || clean.length > MAX_LANDMARK_NAME_LENGTH || !key || seen.has(key)) continue;
    seen.add(key);
    kept.push(clean);
    if (kept.length === MAX_LANDMARK_ALIASES) break;
  }
  return { name: trimmed, aliases: kept };
}

/**
 * How far off a bay a shore landmark may sit and still be *that bay's* — a cape's GNIS point is often
 * a hundred meters up the headland, and a beach's is on the sand, not the water.
 */
export const LANDMARK_SUB_AREA_TOLERANCE_M = 150;

/** A polygon with its holes filled: the water *and* the islands in it. */
function outerRings(polygon: Polygon | MultiPolygon): MultiPolygon {
  const parts = polygon.type === 'Polygon' ? [polygon.coordinates] : polygon.coordinates;
  return {
    type: 'MultiPolygon',
    coordinates: parts.flatMap((rings) => (rings[0] ? [[rings[0]]] : [])),
  };
}

/**
 * The bay a landmark belongs to (A09's stamp, for a label). Two rules, in order:
 *
 * 1. **Inside a bay's outer ring, smallest wins** — the report rule (Decision 9), except that holes
 *    are filled. An island in a bay is a *hole* in the bay's polygon, so plain containment would put
 *    every island in open water; an island is in the bay whose water surrounds it.
 * 2. Otherwise **the nearest bay within {@link LANDMARK_SUB_AREA_TOLERANCE_M}**, smaller winning a tie
 *    — a point of land, a beach, a marina on the bay's shore.
 *
 * `null` for a landmark on the open lake, and on the bodies with no bays at all.
 */
export function subAreaForLandmark<T>(
  point: LatLng,
  candidates: readonly SubAreaCandidate<T>[],
): T | null {
  let inside: { ref: T; area: number } | null = null;
  let near: { ref: T; distance: number; area: number } | null = null;
  for (const c of candidates) {
    if (pointInPolygon(point, outerRings(c.polygon))) {
      if (inside === null || c.surfaceAreaSqM < inside.area) {
        inside = { ref: c.ref, area: c.surfaceAreaSqM };
      }
      continue;
    }
    const distance = distanceToPolygonMeters(point, c.polygon);
    if (distance > LANDMARK_SUB_AREA_TOLERANCE_M) continue;
    if (
      near === null ||
      distance < near.distance ||
      (distance === near.distance && c.surfaceAreaSqM < near.area)
    ) {
      near = { ref: c.ref, distance, area: c.surfaceAreaSqM };
    }
  }
  return inside?.ref ?? near?.ref ?? null;
}
