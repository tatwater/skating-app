/**
 * **GPS path → water-body polygon** (D14/D36, Phase 8) — the only way a new body's shape is ever
 * derived.
 *
 * There is **no freehand drawing anywhere in this app, ever.** A skate that resolves to no known
 * water can create one, but only from a recorded track, because without a path there is no proof of
 * presence and no frame of reference for scale, shape or position — a hand-drawn blob on a phone is a
 * guess, and a guess that then attracts other people's reports is worse than no body at all. A real
 * skated track is far better evidence than anything a finger can draw.
 *
 * **The shape deliberately under-claims.** We buffer the track and use that; we do **not** hull it out
 * to a convex boundary. A hull would swallow land, islands and the neighbouring bay on any track that
 * doesn't circumnavigate — asserting water where nobody went. The buffered corridor claims exactly
 * "this is where somebody skated, plus a margin", which is the strongest honest statement the data
 * supports. The costs are real and accepted: an out-and-back on a big lake produces a sausage rather
 * than the lake, so (a) a later report from the far shore may not resolve into it and creates a
 * near-certain duplicate — which is precisely what the D36 dedup queue exists to catch — and (b) the
 * body is auto-visible then moderator-reviewed (D37), and widening a shape is a far safer manual edit
 * than shrinking an over-claimed one.
 */

import area from '@turf/area';
import buffer from '@turf/buffer';
import { feature } from '@turf/helpers';
import pointOnFeature from '@turf/point-on-feature';
import truncate from '@turf/truncate';
import type { Feature, LineString, MultiPolygon, Polygon } from 'geojson';
import { type BBox, haversineMeters, type LatLng, polygonBBox } from './geometry';

/**
 * Half-width of the corridor drawn around the track, in metres.
 *
 * Wide enough that a lap around a small pond closes into a plausible pond rather than a ring, and that
 * two passes down the same channel merge into one shape; narrow enough that a straight-line crossing
 * of Champlain doesn't claim a kilometre of open water nobody visited. Tunable — this is the single
 * number that decides how generous a user-created body is.
 */
export const PATH_BUFFER_M = 120;

/**
 * A track must span at least this far end-to-end to imply a body at all.
 *
 * Below it there is no *shape* evidence — buffering a path that never really moved just draws a
 * circle of radius `PATH_BUFFER_M` around a point, which would let someone standing in a parking lot
 * mint a plausible-looking pond. A body needs a skate, not a fix.
 */
export const MIN_PATH_EXTENT_M = 50;

/** Coordinate precision for the stored polygon — ~1 cm, matching the ETL's simplification budget. */
const COORD_PRECISION = 7;

/**
 * Fill the interior rings of a buffered shape.
 *
 * Buffering a *closed* track — a lap around a pond — yields a donut: a corridor with the middle
 * punched out wherever the pond is wider than twice the buffer. Storing that donut would leave a hole
 * in the middle of the lake where later reports and hazards fail to resolve, which is worse than a
 * slightly generous outline. Skating all the way around something is good evidence that the middle is
 * water too, so we keep only the exterior rings. (An island inside the loop gets absorbed; that's a
 * small over-claim a moderator can correct under D37 review-after, and far less harmful than a body
 * with a void at its centre.)
 */
function fillHoles(geometry: Polygon | MultiPolygon): Polygon | MultiPolygon {
  if (geometry.type === 'Polygon') {
    const [exterior] = geometry.coordinates;
    return exterior ? { type: 'Polygon', coordinates: [exterior] } : geometry;
  }
  return {
    type: 'MultiPolygon',
    coordinates: geometry.coordinates.map((rings) => (rings[0] ? [rings[0]] : rings)),
  };
}

/** What a trusted path implies about the water it was skated on. */
export interface DerivedBody {
  polygon: Polygon | MultiPolygon;
  /** A point guaranteed to be *inside* the polygon (D48) — never a centroid that could land on land. */
  centroid: LatLng;
  bbox: BBox;
  surfaceAreaSqM: number;
}

/**
 * Derive a water-body shape from a recorded track. Returns `null` for a path too short or degenerate
 * to buffer, so a caller never creates a body from two jittery fixes.
 *
 * The centroid comes from `pointOnFeature` rather than a mean of the coordinates: a mean can easily
 * land outside a curved or multi-part shape (on an island, or on land inside a bay's hook), and every
 * downstream consumer — the map's framing, the geospatial index, "you're at Lake X" resolution —
 * assumes the stored point is *on the water* (D48).
 */
export function pathToBody(
  path: LineString,
  opts: { bufferMeters?: number } = {},
): DerivedBody | null {
  if (path.coordinates.length < 2) return null;
  const bufferMeters = opts.bufferMeters ?? PATH_BUFFER_M;

  // Reject a track with no real extent before buffering — otherwise a phone sitting on a dashboard
  // becomes a perfectly round "pond".
  const box = polygonBBox(path);
  const extentM = haversineMeters(
    { lat: box.minLat, lng: box.minLng },
    { lat: box.maxLat, lng: box.maxLng },
  );
  if (!(extentM >= MIN_PATH_EXTENT_M)) return null;

  let buffered: Feature<Polygon | MultiPolygon> | undefined;
  try {
    buffered = buffer(feature(path), bufferMeters, { units: 'meters' }) as
      | Feature<Polygon | MultiPolygon>
      | undefined;
  } catch {
    // Turf throws rather than returning empty on a degenerate line (all points identical, say).
    // A recording that never moved isn't new water.
    return null;
  }
  if (!buffered?.geometry) return null;

  const polygon = fillHoles(
    truncate(buffered, { precision: COORD_PRECISION }).geometry as Polygon | MultiPolygon,
  );
  const surfaceAreaSqM = area(polygon);
  if (!(surfaceAreaSqM > 0)) return null;

  const inside = pointOnFeature(feature(polygon));
  const [lng, lat] = inside.geometry.coordinates as [number, number];

  return {
    polygon,
    centroid: { lat, lng },
    bbox: polygonBBox(polygon),
    surfaceAreaSqM,
  };
}
