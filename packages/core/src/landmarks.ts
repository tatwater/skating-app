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

import type { FeatureCollection, MultiPolygon, Point, Polygon } from 'geojson';
import { landmarkNameKey } from './corpusRequests';
import {
  type BBox,
  distanceToShorelineMeters,
  expandBBox,
  haversineMeters,
  type LatLng,
  pointInPolygon,
} from './geometry';
import { outerRingsOnly } from './imageryMask';
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
 * How far apart two sightings of one place, by name, may be — per kind, because a place's size is.
 * An island's GNIS point and its OSM interior sit within a kilometer; a passage's GNIS point and its
 * OSM line's middle can be five apart, a bay's head and its node two, a delta's mouths two. One table
 * for every path that asks "is this the same place?" — the ETL's merge, the import's upsert and a
 * moderator's duplicate check — so the three cannot answer it three ways.
 */
export const LANDMARK_SAME_PLACE_RADIUS_M: Readonly<Record<LandmarkKind, number>> = {
  island: 1_000,
  point: 1_000,
  beach: 1_000,
  bay: 2_000,
  narrows: 5_000,
  waterway: 2_000,
  bridge: 1_000,
  marina: 1_000,
  lighthouse: 1_000,
  dam: 1_000,
  settlement: 1_000,
  establishment: 500,
  other: 1_000,
};

/** A landmark as the same-place rule sees it: what it is, where, and every name it answers to. */
export interface LandmarkIdentity {
  kind: LandmarkKind;
  point: LatLng;
  names: readonly string[];
}

/**
 * Are these two the same place? Kinds that agree (`other` agrees with anything — a GNIS "Bar" and
 * an OSM rock are often one shoal), any name of one folding to any name of the other, and within the
 * larger of their kinds' {@link LANDMARK_SAME_PLACE_RADIUS_M}. Two Cedar Islands at opposite ends of
 * Champlain are two places; a village and a point both called Long Point are two kinds of place.
 */
export function landmarksAreSamePlace(a: LandmarkIdentity, b: LandmarkIdentity): boolean {
  if (a.kind !== b.kind && a.kind !== 'other' && b.kind !== 'other') return false;
  const keys = new Set(a.names.map(landmarkNameKey));
  if (!b.names.some((n) => keys.has(landmarkNameKey(n)))) return false;
  const radius = Math.max(
    LANDMARK_SAME_PLACE_RADIUS_M[a.kind],
    LANDMARK_SAME_PLACE_RADIUS_M[b.kind],
  );
  return haversineMeters(a.point, b.point) <= radius;
}

/** The key two spellings of one landmark share — defined beside `requestNameKey` (`corpusRequests.ts`). */
export { landmarkNameKey } from './corpusRequests';

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

/**
 * A polygon with its holes filled: the water *and* the islands in it. An island in a lake is a hole
 * in the lake's polygon, so "is this island in that lake (or bay)" is containment in *this*, never in
 * the polygon itself. Shared by the bay stamp and the ETL's island rule.
 */
export function filledPolygon(polygon: Polygon | MultiPolygon): MultiPolygon {
  return { type: 'MultiPolygon', coordinates: outerRingsOnly(polygon).map((ring) => [ring]) };
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
  candidates: readonly (SubAreaCandidate<T> & { bbox?: BBox })[],
): T | null {
  let inside: { ref: T; area: number } | null = null;
  let near: { ref: T; distance: number; area: number } | null = null;
  const probe = { minLat: point.lat, maxLat: point.lat, minLng: point.lng, maxLng: point.lng };
  for (const c of candidates) {
    // A bay whose stored box, grown by the tolerance, misses the point cannot claim it: four
    // comparisons instead of a walk of the bay's outline, for most landmarks × most bays.
    if (c.bbox) {
      const grown = expandBBox(c.bbox, LANDMARK_SUB_AREA_TOLERANCE_M);
      if (
        probe.minLat > grown.maxLat ||
        probe.maxLat < grown.minLat ||
        probe.minLng > grown.maxLng ||
        probe.maxLng < grown.minLng
      ) {
        continue;
      }
    }
    if (pointInPolygon(point, filledPolygon(c.polygon))) {
      if (inside === null || c.surfaceAreaSqM < inside.area) {
        inside = { ref: c.ref, area: c.surfaceAreaSqM };
      }
      continue;
    }
    // Outside the filled outline, the distance to the polygon is the distance to its shore.
    const distance = distanceToShorelineMeters(point, c.polygon);
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

/** What a map needs of a landmark to label it — `listForBody`'s view. */
export interface LabelableLandmark {
  name: string;
  kind: LandmarkKind;
  point: LatLng;
  prominence: number;
  minZoom: number;
}

/** How near a put-in that carries a landmark's name must be for the put-in's own label to say it. */
export const LANDMARK_PUT_IN_SAME_PLACE_M = 150;

/**
 * The label layer's features, shared by both maps. A landmark whose name a put-in within
 * {@link LANDMARK_PUT_IN_SAME_PLACE_M} already carries is left out — a town beach that is also the
 * launch is one place on screen, drawn as the launch (A06d owns it), not a marker and a label
 * saying the same words. `sortKey` is the negated prominence, because MapLibre places the lowest
 * key first and the most prominent name should win a crowded spot.
 */
export function landmarkLabelFeatures(
  landmarks: readonly LabelableLandmark[],
  putIns: readonly { coord: LatLng; name?: string }[] = [],
): FeatureCollection<
  Point,
  { name: string; kind: LandmarkKind; minZoom: number; sortKey: number }
> {
  const named = putIns
    .filter((p) => p.name)
    .map((p) => ({ ...p, key: landmarkNameKey(p.name ?? '') }));
  return {
    type: 'FeatureCollection',
    features: landmarks
      .filter((l) => {
        const key = landmarkNameKey(l.name);
        return !named.some(
          (p) => p.key === key && haversineMeters(p.coord, l.point) <= LANDMARK_PUT_IN_SAME_PLACE_M,
        );
      })
      .map((l) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [l.point.lng, l.point.lat] },
        properties: { name: l.name, kind: l.kind, minZoom: l.minZoom, sortKey: -l.prominence },
      })),
  };
}

// ── The corpus's unplaced names (D202) ─────────────────────────────────────────────────────────

/**
 * A name the community's emails use for a place that no landmark answers to — "Apple Island",
 * "Hero's Welcome", "the sea caves" — waiting for a moderator: `open` until it is placed on the map
 * (or filed as another spelling of a landmark that is there), or dismissed with a reason.
 */
export const CORPUS_NAME_STATUSES = ['open', 'placed', 'dismissed'] as const;
export type CorpusNameStatus = (typeof CORPUS_NAME_STATUSES)[number];

/** Why a corpus name is not a landmark — the reasons the triage page offers, most common first. */
export const CORPUS_NAME_DISMISS_REASONS = [
  'not_a_place',
  'a_water_body',
  'outside_region',
  'too_vague',
  'other',
] as const;
export type CorpusNameDismissReason = (typeof CORPUS_NAME_DISMISS_REASONS)[number];

export const CORPUS_NAME_DISMISS_LABELS: Record<CorpusNameDismissReason, string> = {
  not_a_place: 'Not a place (a phrase, an event, a person)',
  a_water_body: 'A lake, pond or river — not a landmark',
  outside_region: 'Outside the five states',
  too_vague: 'Too vague to place',
  other: 'Other',
};
