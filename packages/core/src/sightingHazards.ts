/**
 * The pin a sighting implies (D210). A skater who saw open water or skim ice on part of the lake
 * they did not skate has reported a hazard there, whichever control they used to say it: the
 * sighting is the reader's line (*Still open, south end*), and the hazard is the map pin that
 * decays, clusters and warns — the safety object (D3). So a located `open` / `skim` sighting
 * derives an `open_water` / `thin_ice` hazard at report create, on the server, for every client.
 *
 * The shape is the place the author named, never a spot they did not: a compass wedge or the
 * middle is that part of the outline (the same wedge the sheet highlights, `sectorPolygons`), a
 * bay is the bay (and a wedge within a bay, the bay's wedge), a tapped point is its circle. Drawn
 * large on purpose — under-drawing a hazard is the dangerous direction of error
 * (`HAZARD_DEFAULT_RADIUS_M`). A sighting that names no shape derives nothing: the whole lake
 * "still open" is the lake's state, not a spot; `near_shore` is a band around every shore; an
 * extent alone has no geometry. A **landmark chosen by name** (D202) is not a spot either: its
 * point is where its label sits — an island's middle, a headland's tip, the town — which is land,
 * and a circle there would pin the open water on the island and miss the water. It pins what the
 * rest of its `where` names (a wedge, a bay), else nothing. A *tap* that took a landmark's name is
 * still the tap, and pins its circle.
 */

import type { MultiPolygon, Polygon, Position } from 'geojson';
import { haversineMeters, type LatLng, simplifyPath } from './geometry';
import { HAZARD_MAX_VERTICES, type HazardShape } from './hazardGeometry';
import { type PartitionSector, sectorFrame, sectorPolygons } from './sectorGeometry';
import type { HazardType, Sighting } from './types';
import type { Where } from './where';

/** What the sheet says under a located open or skim sighting: the author is the claimant (D196). */
export const SIGHTING_PIN_HINT =
  'Open water or skim ice with a place goes on the map as a hazard, under your name.';

/** Does any of these sightings become a pin? The sheet shows `SIGHTING_PIN_HINT` when it does. */
export function sightingsMakePins(
  sightings: readonly { type: Sighting; where?: Where }[],
): boolean {
  return sightings.some((s) => SIGHTING_HAZARD_TYPE[s.type] !== undefined && s.where !== undefined);
}

/** The sightings that are hazards when located, and the hazard each one is. */
export const SIGHTING_HAZARD_TYPE: Partial<Record<Sighting, HazardType>> = {
  open: 'open_water',
  skim: 'thin_ice',
};

export interface SightingGeometryContext {
  /** The body's outline. */
  outline: Polygon | MultiPolygon;
  /** Honored as the sector origin when it is inside the water (`sectorFrame`). */
  interiorPoint?: LatLng;
  /** The body's bays by id, for a `where` that names one. */
  bays?: Readonly<Record<string, Polygon | MultiPolygon>>;
  /**
   * The label points of the landmarks the sightings name (D202), by id — a point *at* one is the
   * landmark chosen by name, not a tap, and has no water geometry of its own.
   */
  landmarkPoints?: Readonly<Record<string, LatLng>>;
}

/** A point this close to a landmark's label point is that label point (a chip, not a tap). */
const LABEL_POINT_M = 1;

const PARTITION = new Set<string>(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'middle']);

/** Tolerances tried in turn until a clipped wedge fits the hazard vertex cap. */
const SIMPLIFY_LADDER_M = [0, 5, 10, 20, 40, 80, 160];

function vertexCount(geom: Polygon | MultiPolygon): number {
  const parts = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return parts.reduce((n, rings) => n + rings.reduce((m, ring) => m + ring.length, 0), 0);
}

function simplifyRing(ring: readonly Position[], toleranceM: number): Position[] | null {
  const points = ring.map(([lng, lat]) => ({ lat: lat as number, lng: lng as number }));
  const out = simplifyPath(points, toleranceM).map((p) => [p.lng, p.lat] as Position);
  const first = out[0];
  const last = out[out.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) out.push(first);
  return out.length >= 4 ? out : null;
}

/** The geometry, simplified until it fits the hazard vertex cap; `null` when it cannot. */
export function fitToVertexCap(geom: Polygon | MultiPolygon): Polygon | MultiPolygon | null {
  for (const tolerance of SIMPLIFY_LADDER_M) {
    const candidate = tolerance === 0 ? geom : simplifyGeometry(geom, tolerance);
    if (candidate && vertexCount(candidate) <= HAZARD_MAX_VERTICES) return candidate;
  }
  return null;
}

function simplifyGeometry(
  geom: Polygon | MultiPolygon,
  toleranceM: number,
): Polygon | MultiPolygon | null {
  const simplifyPart = (rings: Position[][]): Position[][] | null => {
    const outer = rings[0] ? simplifyRing(rings[0], toleranceM) : null;
    if (!outer) return null; // the part simplified away entirely
    const holes = rings.slice(1).flatMap((r) => {
      const s = simplifyRing(r, toleranceM);
      return s ? [s] : []; // a hole too small to survive is dropped, which only grows the pin
    });
    return [outer, ...holes];
  };
  if (geom.type === 'Polygon') {
    const part = simplifyPart(geom.coordinates);
    return part ? { type: 'Polygon', coordinates: part } : null;
  }
  const parts = geom.coordinates.flatMap((p) => {
    const s = simplifyPart(p);
    return s ? [s] : [];
  });
  return parts.length > 0 ? { type: 'MultiPolygon', coordinates: parts } : null;
}

/** The partition wedge of an area (a body or a bay), or `null` when its outline has no usable frame. */
function wedgeOf(
  area: Polygon | MultiPolygon,
  sector: PartitionSector,
  interiorPoint?: LatLng,
): Polygon | MultiPolygon | null {
  const frame = sectorFrame(area, interiorPoint);
  return frame ? sectorPolygons(frame, area)[sector] : null;
}

/**
 * The hazard a located sighting implies, or `null` when the sighting is not a hazard type or its
 * `where` names no shape. Pure; the server supplies the outline and the bays.
 */
export function sightingHazardShape(
  sighting: { type: Sighting; where?: Where },
  ctx: SightingGeometryContext,
): { type: HazardType; shape: HazardShape } | null {
  const type = SIGHTING_HAZARD_TYPE[sighting.type];
  const where = sighting.where;
  if (!type || !where) return null;
  const label =
    where.point?.landmarkId !== undefined
      ? ctx.landmarkPoints?.[where.point.landmarkId]
      : undefined;
  const chosenByName =
    label !== undefined &&
    where.point !== undefined &&
    haversineMeters(label, where.point.coord) < LABEL_POINT_M;
  if (where.point && !chosenByName) {
    return {
      type,
      shape: {
        geometryKind: 'point_radius',
        geometry: { type: 'Point', coordinates: [where.point.coord.lng, where.point.coord.lat] },
        radiusMeters: where.point.radiusMeters,
      },
    };
  }
  const bay = where.subAreaId !== undefined ? ctx.bays?.[where.subAreaId] : undefined;
  if (where.subAreaId !== undefined && !bay) return null; // a bay this body does not know
  let area: Polygon | MultiPolygon | null = null;
  if (where.sector !== undefined && PARTITION.has(where.sector)) {
    area = bay
      ? wedgeOf(bay, where.sector as PartitionSector)
      : wedgeOf(ctx.outline, where.sector as PartitionSector, ctx.interiorPoint);
  } else if (
    bay &&
    (where.sector === undefined || where.sector === 'head' || where.sector === 'mouth')
  ) {
    // The whole bay: `head` and `mouth` wait on the chord editor's mouth line (A09), and a bay is
    // the honest superset of either.
    area = bay;
  }
  const fitted = area ? fitToVertexCap(area) : null;
  return fitted ? { type, shape: { geometryKind: 'polygon', geometry: fitted } } : null;
}
