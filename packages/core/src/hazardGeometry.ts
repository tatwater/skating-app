/**
 * Hazard geometry (D51) — the authoring primitive per type, its default size, and the footprint math
 * that feeds rendering, bbox indexing and proximity alerts.
 *
 * The D51 thesis: **most people cannot hand-draw an accurately shaped blob on a phone from what they
 * see on the ice**, so the drawing primitive matches the hazard's real-world shape — which happens to
 * also be what a human can produce accurately. Blobs get a point + adjustable radius; ridges and cracks
 * are genuinely linear, so they get a polyline with an uncertainty half-width.
 *
 * Every footprint here is deliberately **fuzzy** (D3): a hazard renders as a soft buffered halo with
 * advisory copy ("reported *around here*"), never a crisp surveyed boundary. Imprecision is the honest
 * message, not a bug — and `bufferMeters`/`radiusMeters` are what let us render it honestly rather than
 * drawing a zero-width line that implies survey precision we don't have.
 */

import area from '@turf/area';
import buffer from '@turf/buffer';
import { feature, featureCollection, point } from '@turf/helpers';
import intersect from '@turf/intersect';
import truncate from '@turf/truncate';
import type { Feature, LineString, MultiPolygon, Point, Polygon } from 'geojson';
import {
  type BBox,
  distanceToPolygonMeters,
  haversineMeters,
  type LatLng,
  polygonBBox,
  ringSelfIntersects,
} from './geometry';
import type { HazardType } from './types';

/** The authoring primitive (D51). */
export type HazardGeometryKind = 'point_radius' | 'line' | 'polygon';

/** A hazard's spatial definition, as stored. */
export interface HazardShape {
  geometryKind: HazardGeometryKind;
  geometry: Point | LineString | Polygon | MultiPolygon;
  /** Set when `geometryKind === 'point_radius'`. */
  radiusMeters?: number;
  /** Set for line/polygon — the uncertainty half-width. */
  bufferMeters?: number;
}

/**
 * The primitive each type defaults to (D51).
 *
 * Only three types are linear, and they're linear in reality: a pressure ridge, an ice heave and a
 * working crack are all lines on the ice. Everything else is a blob, a hole or a zone, which a circle
 * describes at least as well as a hand-drawn shape would — and far more accurately in practice.
 */
export const HAZARD_DEFAULT_GEOMETRY_KIND: Record<HazardType, HazardGeometryKind> = {
  pressure_ridge: 'line',
  ice_heave: 'line',
  wet_crack: 'line',

  open_water: 'point_radius',
  thin_ice: 'point_radius',
  overflow_slush: 'point_radius',
  drain_hole: 'point_radius',
  wind_hole: 'point_radius',
  slush_hole: 'point_radius',
  thawed_rotten: 'point_radius',
  ridge_crossing: 'point_radius',
  drilled_hole: 'point_radius',
  shell_area: 'point_radius',
  spring_current: 'point_radius',
  gas_hole: 'point_radius',
  reef_hole: 'point_radius',
};

/**
 * Starting radius for point+radius hazards, in metres — tunable in Phase 7 (D49), adjustable by the
 * skater at capture time with steppers.
 *
 * Sized by what the thing physically is (research §2): an auger hole is a few metres, a thaw-rotten
 * *zone* or a thin-ice area is tens of metres. Starting near the truth matters more on mobile than
 * anywhere else, because on the ice the default is what most people will actually ship — the adjust
 * step is optional by design (two taps to a committable hazard).
 */
export const HAZARD_DEFAULT_RADIUS_M: Record<HazardType, number> = {
  // Small, man-made or point-source holes.
  drilled_hole: 5,
  drain_hole: 10,
  gas_hole: 10,
  wind_hole: 15,
  slush_hole: 15,
  // A crossing is a specific spot you aim for, so it wants to be tight — but not so tight it implies
  // survey precision about where the safe line is (D3).
  ridge_crossing: 15,
  // Natural features tied to a bathymetric feature.
  reef_hole: 25,
  spring_current: 30,
  // Areas and zones.
  open_water: 40,
  overflow_slush: 40,
  shell_area: 40,
  thin_ice: 50,
  // A thaw-rotten area is the largest default: it's a condition of the sheet, not a spot, and it is
  // the #1 fatality cause — under-drawing it is the dangerous direction of error.
  thawed_rotten: 60,

  // Linear types keep a default for the case where a skater opts into point+radius anyway.
  pressure_ridge: 25,
  ice_heave: 20,
  wet_crack: 10,
};

/**
 * Uncertainty half-width for linear hazards, in metres.
 *
 * A folded pressure ridge is loose plates 1–15 ft on *each* side with a deep puddle down the middle
 * (research §2) — several metres of genuine width plus GPS and eyeball error, so its band is wide. A
 * hairline tectonic crack is centimetres wide; its band is mostly just positional uncertainty. Drawing
 * both as the same zero-width polyline would be a lie in opposite directions.
 */
export const HAZARD_DEFAULT_BUFFER_M: Record<HazardType, number> = {
  pressure_ridge: 15,
  ice_heave: 12,
  wet_crack: 4,

  // Non-linear types only reach these if a skater opts into a polyline/polygon for them.
  open_water: 10,
  thin_ice: 10,
  overflow_slush: 10,
  drain_hole: 5,
  wind_hole: 5,
  slush_hole: 5,
  thawed_rotten: 15,
  ridge_crossing: 5,
  drilled_hole: 3,
  shell_area: 10,
  spring_current: 10,
  gas_hole: 5,
  reef_hole: 10,
};

/** The default shape a freshly-picked type starts with — what "two taps to a valid hazard" relies on. */
export function defaultShapeForType(type: HazardType, at: LatLng): HazardShape {
  const geometryKind = HAZARD_DEFAULT_GEOMETRY_KIND[type];
  // A line needs at least two vertices, which a single GPS fix can't supply — so a type that *defaults*
  // to a line still starts as a circle at the skater's position and upgrades once they add vertices.
  // This is what keeps the two-tap guarantee true for ridges too.
  return {
    geometryKind: geometryKind === 'line' ? 'point_radius' : geometryKind,
    geometry: { type: 'Point', coordinates: [at.lng, at.lat] },
    radiusMeters: HAZARD_DEFAULT_RADIUS_M[type],
  };
}

/**
 * The hazard's rendered/queried footprint: the raw geometry grown by its radius or uncertainty buffer.
 *
 * This one polygon is the single source of truth for the halo the map draws, the bbox we index, and the
 * distance the proximity alert measures — so what a skater *sees* and what the app *warns about* can
 * never drift apart.
 */
export function hazardFootprint(shape: HazardShape): Polygon | MultiPolygon {
  const grownBy = footprintBufferMeters(shape);
  // Only an already-areal geometry may pass through ungrown. A Point or a LineString has no area, so
  // returning it here would hand a LineString to callers typed to receive a Polygon — and
  // `distanceToPolygonMeters` throws on one, which in a proximity watcher takes out the alerts for
  // *every* hazard on the lake, not just the bad row. Buffering unconditionally is the safe direction.
  if (
    grownBy <= 0 &&
    (shape.geometry.type === 'Polygon' || shape.geometry.type === 'MultiPolygon')
  ) {
    return shape.geometry;
  }
  const grown = buffer(feature(shape.geometry), Math.max(grownBy, MIN_FOOTPRINT_M), {
    units: 'meters',
  }) as Feature<Polygon | MultiPolygon>;
  return grown.geometry;
}

/**
 * Never render or query a zero-area footprint. A degenerate hazard would be invisible on the map and
 * un-hittable by proximity — it would exist in the database and nowhere else.
 */
const MIN_FOOTPRINT_M = 1;

function footprintBufferMeters(shape: HazardShape): number {
  if (shape.geometryKind === 'point_radius') return shape.radiusMeters ?? 0;
  return shape.bufferMeters ?? 0;
}

/**
 * The footprint of a hazard clipped to the water-body polygon it sits on — or `null` when clipping
 * either does nothing (the footprint is already wholly inside the body) or can't be done safely.
 *
 * Why clip (Phase 9.5): a point+radius hazard dropped near shore buffers into a circle that spills
 * across land or into a neighbouring lake, drawing a danger halo where there is no water to be in
 * danger on. Intersecting the footprint with the body confines the halo to the ice.
 *
 * **Never clips to empty.** A hazard is GPS-anchored on its body, so a truly-empty intersection means
 * bad *body* data (a coarse OSM outline that doesn't reach a real near-shore hazard), not a hazard off
 * the ice — and making a real hazard vanish is the one direction we never fail (D3). A disjoint or
 * failed clip returns `null`, and the caller keeps the honest unclipped footprint.
 *
 * Returns `null` too when nothing meaningful was removed, so the common "hazard well inside the lake"
 * case stores no polygon and keeps `hazardFootprint` as its single source — the clip is stored only
 * when it actually changes the shape.
 */
export function clipFootprintToBody(
  footprint: Polygon | MultiPolygon,
  body: Polygon | MultiPolygon,
): Polygon | MultiPolygon | null {
  try {
    // Truncate first for the same reason `polygonIoU` does: sub-epsilon float noise makes the polygon
    // clipper choke on near-coincident shoreline edges — exactly the near-shore case this exists for.
    const fp = truncate(feature(footprint), { precision: 9 });
    const clipped = intersect(featureCollection([fp, truncate(feature(body), { precision: 9 })]));
    if (!clipped) return null;
    const clippedArea = area(clipped);
    if (clippedArea <= 0) return null;
    // Well inside the body: the intersection is (essentially) the footprint itself. Storing a re-noded
    // copy would only bloat the row and risk drift, so treat it as "no clip needed".
    if (clippedArea >= area(fp) * (1 - CLIP_SIGNIFICANCE)) return null;
    return clipped.geometry;
  } catch {
    // A clipper failure must fail *open* — keep the full footprint rather than risk hiding a hazard.
    return null;
  }
}

/** Fractional area a clip must remove to be worth storing (0.5%) — below this the footprint is "inside". */
const CLIP_SIGNIFICANCE = 0.005;

/**
 * The bbox of a hazard's *footprint* (not its raw geometry) — what gets stored for prefiltering. When a
 * body-clipped footprint is supplied it wins, so the stored bbox matches the halo that's actually drawn.
 */
export function hazardBbox(
  shape: HazardShape,
  clippedFootprint?: Polygon | MultiPolygon | null,
): BBox {
  return polygonBBox(clippedFootprint ?? hazardFootprint(shape));
}

/**
 * Distance in metres from a coordinate to the hazard's footprint edge; **0 when inside it**.
 *
 * When a `clippedFootprint` is supplied (the body-clipped polygon stored at create) it is measured
 * against directly — it *must* be, in lockstep with render and bbox, or "warned about" would drift from
 * "drawn". A clip changes the shape, so the point+radius haversine shortcut no longer describes it and
 * is skipped for clipped hazards.
 *
 * Unclipped, point+radius short-circuits to plain haversine minus the radius — exact, and it avoids
 * buffering a polygon on every GPS fix, which matters when this runs in a watcher loop on a cold phone.
 */
export function distanceToHazard(
  coord: LatLng,
  shape: HazardShape,
  clippedFootprint?: Polygon | MultiPolygon | null,
): number {
  if (clippedFootprint) return distanceToPolygonMeters(coord, clippedFootprint);
  if (shape.geometryKind === 'point_radius' && shape.geometry.type === 'Point') {
    const [lng = 0, lat = 0] = shape.geometry.coordinates;
    const centre = haversineMeters(coord, { lat, lng });
    return Math.max(0, centre - (shape.radiusMeters ?? 0));
  }
  return distanceToPolygonMeters(coord, hazardFootprint(shape));
}

/** Build a `point_radius` shape (the default authoring primitive). */
export function pointRadiusShape(at: LatLng, radiusMeters: number): HazardShape {
  return {
    geometryKind: 'point_radius',
    geometry: point([at.lng, at.lat]).geometry,
    radiusMeters,
  };
}

/**
 * Build a `line` shape from captured vertices (the polyline primitive).
 *
 * Constructs the geometry literally rather than via Turf's `lineString`, which *throws* on fewer than
 * two positions. Vertices arrive one on-ice tap at a time, so a partially-drawn line is a completely
 * normal intermediate state — it must be representable and then rejected by `isValidHazardShape`, not
 * crash the capture screen mid-draw. Validation is the single gate.
 */
export function lineShape(vertices: readonly LatLng[], bufferMeters: number): HazardShape {
  return {
    geometryKind: 'line',
    geometry: { type: 'LineString', coordinates: vertices.map((v) => [v.lng, v.lat]) },
    bufferMeters,
  };
}

/**
 * Build a `polygon` shape from captured vertices (the freeform primitive, N5b).
 *
 * Constructed literally rather than via Turf's `polygon`, for the same reason `lineShape` is: Turf
 * *throws* on a ring with fewer than four positions or one that isn't closed, and a ring is tapped out
 * one vertex at a time — "two corners so far" is a normal intermediate the capture UI has to hold and
 * render. The ring is closed here (the first position repeated last) so that everything downstream
 * receives spec-valid GeoJSON, and `isValidHazardShape` remains the single gate on whether it's
 * *storable*.
 *
 * `vertices` are the distinct corners, **without** the repeated closing position — that is what the
 * draft holds and what an undo pops.
 */
export function polygonShape(vertices: readonly LatLng[], bufferMeters: number): HazardShape {
  const ring = vertices.map((v) => [v.lng, v.lat] as [number, number]);
  const first = ring[0];
  return {
    geometryKind: 'polygon',
    geometry: { type: 'Polygon', coordinates: [first ? [...ring, first] : ring] },
    bufferMeters,
  };
}

/**
 * Hard ceiling on a hazard's radius / uncertainty half-width, in metres.
 *
 * A hazard is a *localized* danger within one water body — the largest default is a 60 m thaw-rotten
 * zone. 5 km is far past anything real (78 km² of footprint) while still bounding the absurd: without
 * a ceiling, one authenticated member could store a 500 km `open_water` circle that renders as a
 * region-sized halo and fires the proximity alert for every skater on every lake inside it, undoable
 * only by a moderator. The generous gap between "biggest real hazard" and this number is deliberate —
 * this is a guard against nonsense, not a second opinion about what a skater saw.
 */
export const HAZARD_MAX_SIZE_M = 5_000;

/**
 * Vertex ceiling for a traced polyline. Tapping this many times on the ice is not a thing anyone does;
 * it exists so a scripted client can't store a document that's expensive to buffer on every GPS fix.
 */
export const HAZARD_MAX_VERTICES = 500;

/** Finite, in-range, and actually a number — cheap guards that keep NaN out of the footprint math. */
function isSaneSize(value: unknown, { min }: { min: number }): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= HAZARD_MAX_SIZE_M
  );
}

function isSaneCoord(position: readonly number[]): boolean {
  const [lng, lat] = position;
  return (
    typeof lng === 'number' &&
    typeof lat === 'number' &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}

/**
 * Is this shape structurally valid to store? Guards the degenerate cases Turf throws on, so an
 * on-ice capture can never produce a row the renderer or the alert evaluator will crash reading.
 *
 * This is the **single** gate — `hazardDraft`'s `draftToShape` delegates here, and the server calls it
 * again on every insert, because a client is not a trustworthy validator. Anything that reaches storage
 * must survive `hazardFootprint`, `hazardBbox` and `distanceToHazard` without throwing.
 */
export function isValidHazardShape(shape: HazardShape): boolean {
  switch (shape.geometryKind) {
    case 'point_radius':
      return (
        shape.geometry.type === 'Point' &&
        isSaneCoord(shape.geometry.coordinates) &&
        // Strictly positive: a zero-radius point has no area to render or measure against.
        isSaneSize(shape.radiusMeters, { min: Number.MIN_VALUE })
      );
    case 'line': {
      if (shape.geometry.type !== 'LineString') return false;
      // A polyline is stored as a *band*, so its half-width is required rather than optional: a
      // zero-width line has no area, and `hazardFootprint` would have to invent a width to render or
      // measure it. Requiring it here keeps the drawn halo and the measured distance the same shape.
      if (!isSaneSize(shape.bufferMeters, { min: Number.MIN_VALUE })) return false;
      const coords = shape.geometry.coordinates;
      const first = coords[0];
      if (coords.length < 2 || coords.length > HAZARD_MAX_VERTICES || !first) return false;
      if (!coords.every(isSaneCoord)) return false;
      // Two vertices minimum, and they must actually differ — Turf's buffer throws on a zero-length
      // line rather than returning empty.
      return coords.some(([lng, lat]) => lng !== first[0] || lat !== first[1]);
    }
    case 'polygon': {
      if (shape.geometry.type !== 'Polygon' && shape.geometry.type !== 'MultiPolygon') return false;
      // Unlike a line, a polygon already encloses area, so its buffer is a genuine optional extra —
      // but if present it still has to be a sane number.
      if (shape.bufferMeters !== undefined && !isSaneSize(shape.bufferMeters, { min: 0 }))
        return false;
      const parts =
        shape.geometry.type === 'Polygon'
          ? [shape.geometry.coordinates]
          : shape.geometry.coordinates;
      if (parts.length === 0) return false;
      // Every ring of every part, not just the first (N5b). This branch was unreachable until N5b
      // gave a client a way to author a polygon; until then a hole or a second part could carry
      // anything — a NaN in ring 2 reaches `hazardFootprint` exactly as readily as one in ring 1, and
      // takes out the buffer for the whole row.
      let positions = 0;
      for (const rings of parts) {
        if (rings.length === 0) return false;
        for (const ring of rings) {
          // A closed ring repeats its first position, so a triangle is 4 positions.
          if (ring.length < 4) return false;
          if (!ring.every(isSaneCoord)) return false;
          const first = ring[0] as [number, number];
          const last = ring[ring.length - 1] as [number, number];
          if (first[0] !== last[0] || first[1] !== last[1]) return false;
          // A bowtie is not a statement about where a hazard is. Checked on the *outer* ring only:
          // an interior ring crossing itself is the same defect, so it is checked too — what is not
          // checked is ring-against-ring containment, which Turf's buffer tolerates and no authoring
          // path can produce.
          if (ringSelfIntersects(ring)) return false;
          positions += ring.length;
        }
      }
      // The cap is on the whole geometry, not per ring: the thing it bounds is how expensive this row
      // is to buffer on every GPS fix in the on-ice watcher, and forty holes of forty vertices each
      // costs exactly what one 1,600-vertex ring does.
      return positions <= HAZARD_MAX_VERTICES;
    }
  }
}
