/**
 * Compass sectors on a water body (A10 / D193, amended 2026-09-21) — the geometry behind a `where`
 * that says "north end", and the soft highlight the sheet draws for it.
 *
 * ## The shape
 *
 * Eight 45° wedges cast from the body's **interior point** partition the outline together with a
 * `middle` disk around that point; `near_shore` is a band inside the shoreline that **overlaps**
 * them (a chip at the north end near the bank is honestly both `N` and `near_shore`), so it is not
 * in the partition and carries no partition property. `head` / `mouth` are bay-relative and come
 * from a bay's mouth line, which the chord editor stores — not here.
 *
 * ## Why the origin is not `waterBodies.centroid`
 *
 * The stored `centroid` is Turf's `pointOnFeature`, which sits *on the shoreline* for any lake
 * whose bbox center is on land — Willoughby's is ring vertex 199 (`fetchOrigin` in
 * `lakeGeometry.ts` has the full story). Wedges cast from a shoreline point put "north" on the
 * far bank and "south" on dry land. So the frame is built from `waterBodies.interiorPoint` when
 * the row has one and from `fetchOrigin` otherwise, and a caller-supplied origin that is not
 * strictly inside the water is ignored rather than trusted.
 *
 * ## Why the sizes are relative
 *
 * A fixed 150 m "near shore" band is the whole of a pond and a rounding error on Champlain, so both
 * the middle radius and the band scale with the **shortest ray** from the origin to the shore
 * (`fetchProfileMeters`), capped so a big lake's band stays a skater's "near the bank". Scaling by
 * the shortest ray is also what makes every wedge non-empty by construction: each wedge contains
 * one of the sixteen rays, and that ray is longer than the middle radius.
 *
 * `compassPointFor` (the 16-point label lookup) is reused for nothing here — a sector is one of
 * eight, and the bucket boundaries differ (`N` is ±22.5° here, ±11.25° there).
 */

import { feature, featureCollection } from '@turf/helpers';
import intersect from '@turf/intersect';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import {
  bearingDegrees,
  destinationPoint,
  distanceToShorelineMeters,
  haversineMeters,
  type LatLng,
  pointInPolygon,
} from './geometry';
import {
  FETCH_BEARING_COUNT,
  FETCH_BEARING_STEP_DEG,
  fetchOrigin,
  fetchProfileMeters,
  isStrictlyInside,
} from './lakeGeometry';
import { COMPASS_SECTORS, type CompassSector } from './types';

/** The nine sectors that partition the outline: the eight wedges and the middle. */
export type PartitionSector = CompassSector | 'middle';
export const PARTITION_SECTORS = [
  ...COMPASS_SECTORS,
  'middle',
] as const satisfies readonly PartitionSector[];

/** Degrees of arc per compass wedge. */
export const SECTOR_WEDGE_DEG = 360 / COMPASS_SECTORS.length;

/**
 * The middle disk's radius as a fraction of the shortest ray to shore. Under a half, so the disk
 * never reaches the bank along any of the sixteen rays and every wedge keeps water outside it.
 */
export const MIDDLE_RADIUS_FRACTION = 0.4;

/** The near-shore band: this fraction of the shortest ray, and never wider than the cap. */
export const NEAR_SHORE_FRACTION = 0.3;
export const NEAR_SHORE_MAX_METERS = 150;

/** Everything the per-point and per-polygon functions need, computed once per body. */
export interface SectorFrame {
  origin: LatLng;
  middleRadiusM: number;
  nearShoreM: number;
  /** The sixteen rays from `origin` to the first shore, in meters (`fetchProfileMeters`). */
  raysM: number[];
}

/**
 * Build the frame for a body. `interiorPoint` is honored only when it is strictly inside the water;
 * otherwise (and when absent) the origin is derived. Returns `null` for geometry with no usable
 * interior — the sheet then offers no sectors, which is the honest answer for a broken outline.
 */
export function sectorFrame(
  geom: Polygon | MultiPolygon,
  interiorPoint?: LatLng,
): SectorFrame | null {
  const origin =
    interiorPoint && isStrictlyInside(geom, interiorPoint) ? interiorPoint : fetchOrigin(geom);
  if (!origin) return null;
  const raysM = fetchProfileMeters(geom, origin);
  if (!raysM) return null;
  const shortest = Math.min(...raysM.filter((r) => r > 0));
  if (!Number.isFinite(shortest) || shortest <= 0) return null;
  return {
    origin,
    middleRadiusM: shortest * MIDDLE_RADIUS_FRACTION,
    nearShoreM: Math.min(NEAR_SHORE_MAX_METERS, shortest * NEAR_SHORE_FRACTION),
    raysM,
  };
}

/** The wedge a bearing (degrees clockwise from north) falls in — `N` is `[-22.5°, 22.5°)`. */
export function compassSectorFor(bearingDeg: number): CompassSector {
  const normalized = ((bearingDeg % 360) + 360) % 360;
  const index = Math.floor(((normalized + SECTOR_WEDGE_DEG / 2) % 360) / SECTOR_WEDGE_DEG);
  return COMPASS_SECTORS[index] as CompassSector;
}

/** The partition sector a point falls in. Pure bearing and distance from the origin; no clipping. */
export function sectorAt(frame: SectorFrame, point: LatLng): PartitionSector {
  if (haversineMeters(frame.origin, point) < frame.middleRadiusM) return 'middle';
  return compassSectorFor(bearingDegrees(frame.origin, point));
}

/** Is this point within the near-shore band of the outline? Overlaps `sectorAt`'s answer by design. */
export function isNearShore(
  frame: SectorFrame,
  geom: Polygon | MultiPolygon,
  point: LatLng,
): boolean {
  return distanceToShorelineMeters(point, geom) <= frame.nearShoreM;
}

// ── Polygons for the soft highlight ─────────────────────────────────────────────────────────────

/** Points along an arc around `origin`, from `fromDeg` to `toDeg` clockwise, `steps` segments. */
function arc(
  origin: LatLng,
  radiusM: number,
  fromDeg: number,
  toDeg: number,
  steps: number,
): Position[] {
  const out: Position[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = destinationPoint(origin, fromDeg + ((toDeg - fromDeg) * i) / steps, radiusM);
    out.push([p.lng, p.lat]);
  }
  return out;
}

/**
 * Far enough that the outer arc is outside the outline in every direction: past the farthest
 * vertex of the outline. **Not** a multiple of the longest ray — a ray stops at the *first* shore,
 * and a dendritic reservoir's arm runs on for kilometers past the bend where every ray ends.
 */
function outerRadius(frame: SectorFrame, geom: Polygon | MultiPolygon): number {
  const rings = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flat(1);
  let farthest = 0;
  for (const ring of rings) {
    for (const [lng, lat] of ring as [number, number][]) {
      const d = haversineMeters(frame.origin, { lat, lng });
      if (d > farthest) farthest = d;
    }
  }
  return farthest * 1.1 + frame.middleRadiusM;
}

/** The annular wedge for one compass sector — outer arc out, inner arc back — before clipping. */
function wedgePolygon(frame: SectorFrame, outerRadiusM: number, sector: CompassSector): Polygon {
  const center = COMPASS_SECTORS.indexOf(sector) * SECTOR_WEDGE_DEG;
  const from = center - SECTOR_WEDGE_DEG / 2;
  const to = center + SECTOR_WEDGE_DEG / 2;
  const outer = arc(frame.origin, outerRadiusM, from, to, 12);
  const inner = arc(frame.origin, frame.middleRadiusM, to, from, 6);
  const ring = [...outer, ...inner];
  ring.push(ring[0] as Position);
  return { type: 'Polygon', coordinates: [ring] };
}

/** The middle disk before clipping. */
function middlePolygon(frame: SectorFrame): Polygon {
  const ring = arc(frame.origin, frame.middleRadiusM, 0, 360, 48);
  ring[ring.length - 1] = ring[0] as Position;
  return { type: 'Polygon', coordinates: [ring] };
}

/** Clip a shape to the outline. `null` when nothing survives (degenerate input only). */
function clipToOutline(
  shape: Polygon,
  geom: Polygon | MultiPolygon,
): Polygon | MultiPolygon | null {
  const clipped = intersect(featureCollection([feature(shape), feature(geom)])) as Feature<
    Polygon | MultiPolygon
  > | null;
  return clipped?.geometry ?? null;
}

/**
 * The nine partition polygons, each clipped to the outline — what the sheet fills for a soft
 * highlight. A sector whose clip is empty maps to `null`; the frame's construction makes that a
 * sign of broken geometry, not a shape this can produce on a real lake (`sectorGeometry.test.ts`
 * holds the property).
 */
export function sectorPolygons(
  frame: SectorFrame,
  geom: Polygon | MultiPolygon,
): Record<PartitionSector, Polygon | MultiPolygon | null> {
  const out = {} as Record<PartitionSector, Polygon | MultiPolygon | null>;
  const outerM = outerRadius(frame, geom); // one walk of the vertices, shared by the eight wedges
  for (const sector of COMPASS_SECTORS) {
    out[sector] = clipToOutline(wedgePolygon(frame, outerM, sector), geom);
  }
  out.middle = clipToOutline(middlePolygon(frame), geom);
  return out;
}

/** Is `point` inside the rendered polygon of `sector`? The consistency check between `sectorAt` and the highlight. */
export function pointInSectorPolygon(
  polygons: Record<PartitionSector, Polygon | MultiPolygon | null>,
  sector: PartitionSector,
  point: LatLng,
): boolean {
  const polygon = polygons[sector];
  return polygon !== null && pointInPolygon(point, polygon);
}

/**
 * A point guaranteed to lie in `sector` and inside the water — the analytic witness that every
 * wedge is non-empty: the point along the wedge's central ray, halfway between the middle disk and
 * the shore. For `middle`, the origin itself.
 */
export function sectorWitness(frame: SectorFrame, sector: PartitionSector): LatLng {
  if (sector === 'middle') return frame.origin;
  const bearing = COMPASS_SECTORS.indexOf(sector) * SECTOR_WEDGE_DEG;
  const rayIndex = Math.round(bearing / FETCH_BEARING_STEP_DEG) % FETCH_BEARING_COUNT;
  const ray = frame.raysM[rayIndex] as number;
  return destinationPoint(frame.origin, bearing, (frame.middleRadiusM + ray) / 2);
}
