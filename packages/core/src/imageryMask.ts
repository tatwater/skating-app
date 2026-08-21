/**
 * The shape imagery is allowed to show through — N6e's reveal, clipped to one lake **and the way in**.
 *
 * ## D146 — imagery is content scoped to a body, not a base-map swap
 *
 * > *"Toggling satellite imagery on might somehow bound the image to the confines of a single lake
 * > body somehow… except we also mark other things on the map now, like parking, put-ins, bathrooms,
 * > an access trail, so we probably want our satellite imagery to cover those markings as well."*
 *
 * So the reveal is a **shape**, not a screen. This module computes that shape and the rings that
 * feather its edge, and it computes nothing about rendering — the apps turn these geometries into
 * fill layers, because the ids and the alpha ramp are the only parts that differ between them.
 *
 * ## The mask is drawn inside-out, and that is the whole trick
 *
 * MapLibre cannot clip a raster to a polygon. What it *can* do is draw the raster edge-to-edge and
 * then paint over everything that isn't the shape — a polygon whose **outer ring is the viewport and
 * whose holes are the shape**. We already ship this exact inversion: the region mask that stops
 * Connecticut rendering in full (`composeBasemapLayers`, and `maskLayers` in either app). This is that
 * pattern retargeted from five states to one buffered lake, and it inherits the same gotcha —
 * see `MASK_FILL_OPACITY`.
 *
 * ## The feather is stacked masks, not a gradient
 *
 * MapLibre cannot blur a fill or vary `fill-opacity` across one. So a soft edge is built by stacking
 * several inverse masks at increasing buffer distances: near the shape only the outermost few cover a
 * pixel, far from it they all do, and the cumulative alpha ramps on its own. `featherRings` returns
 * them ordered outermost-first with the alpha each should carry.
 *
 * **This is the tunable, client-side half of A2.** The Sentinel timeline bakes a true alpha ramp into
 * its own archive instead (we own those pixels); this is for the live NAIP tier, where we do not.
 */

import buffer from '@turf/buffer';
import { feature } from '@turf/helpers';
import type { LineString, MultiPolygon, Point, Polygon, Position } from 'geojson';
import { type LatLng, polygonUnion } from './geometry';

/** Source and layer ids, so the two clients cannot name the same thing differently. */
export const IMAGERY_SOURCE_ID = 'imagery';
export const IMAGERY_LAYER_ID = 'imagery-raster';
export const IMAGERY_MASK_SOURCE_ID = 'imagery-mask';
/** Layer id for feather ring `i`, outermost first. */
export function imageryMaskLayerId(index: number): string {
  return `imagery-mask-${index}`;
}

/**
 * A thousandth short of opaque, and it is not a rounding artefact — the same constant, for the same
 * reason, as the region mask's.
 *
 * MapLibre sends a fill to the *opaque* render pass only at exactly opacity 1, and that pass runs
 * before the translucent one with depth testing off. An opaque mask would therefore be drawn *before*
 * the symbols it is meant to sit under, and place labels would punch straight through it. A
 * thousandth of transparency moves the mask into the same pass as the labels, where being later in
 * the layer list finally means being on top.
 *
 * If this ever goes back to `1`, the symptom is labels floating over a masked-out photograph.
 */
export const MASK_FILL_OPACITY = 0.999;

/**
 * How far the reveal extends past what it is revealing, per tier — **and the units are pixels
 * whether we write them in metres or not.**
 *
 * At Sentinel's 10 m ground sample, a 10 m buffer is **one pixel**: invisible, and a feather built
 * from it would be a hard edge with extra layers. So the aerial tier's numbers cannot simply be
 * reused, and the ratio between the two is roughly the ratio of their resolutions.
 *
 * Starting values, chosen to be legible rather than measured. Tuning these by looking at them is an
 * explicit open question in the phase doc.
 */
export const AERIAL_MASK_METERS = { solid: 10, feather: 30 } as const;
export const SENTINEL_MASK_METERS = { solid: 30, feather: 100 } as const;

/** How many stacked masks build the fade. Six reads as smooth; more is layers for nothing. */
export const FEATHER_STEPS = 6;

/**
 * The world-covering outer ring every inverse mask is cut from.
 *
 * Deliberately the whole sphere rather than the current viewport: a viewport-sized ring has to be
 * recomputed on every pan and is wrong for exactly one frame each time, which reads as the mask
 * flickering off at the edges. A static ring is computed once and is never wrong.
 *
 * Latitude stops short of the poles because Web Mercator has no ±90.
 */
const WORLD_RING: Position[] = [
  [-180, -85],
  [180, -85],
  [180, 85],
  [-180, 85],
  [-180, -85],
];

/** The pieces of a body's access that the reveal has to cover, alongside the water itself. */
export interface ImageryMaskInput {
  /** The body's stored geometry — what the reveal is *for*. */
  polygon: Polygon | MultiPolygon;
  /**
   * Routed hike-in approaches, parking → put-in (`putIns.approachPath`, N6e Workstream 0).
   *
   * Only routed hike-in legs have one, which is the correct set: a drive-up ramp's "walk" is a few
   * metres already inside the water's own buffer, so it would add vertices and no shape.
   */
  approachPaths?: readonly (readonly LatLng[])[];
  /** Parking coordinates. Points, not lots — `parkingAreas` stores a `coord`, so these buffer to circles. */
  parkingCoords?: readonly LatLng[];
  /** Put-ins, toilets, and anything else pinned that must not sit on blank map. */
  markerCoords?: readonly LatLng[];
}

/**
 * The solid core of the reveal: everything we are showing, buffered by `solidMeters` and unioned.
 *
 * Returns `null` only if the union fails outright, which the caller must treat as *"do not reveal"*
 * rather than *"reveal everything"* — a mask that fails open is a photograph of the whole Northeast
 * with no way to tell which lake you were looking at.
 *
 * The founder's description is the spec, weird outline and all: *"the same standard buffer distance
 * from the polygon's edges AND on both sides of the hiking trail for its whole length AND around the
 * parking lot."* A lake with a mile-long approach produces a blob with a tentacle, which is correct.
 */
export function revealShape(
  input: ImageryMaskInput,
  solidMeters: number,
): Polygon | MultiPolygon | null {
  const parts: (Polygon | MultiPolygon)[] = [];

  // Holes are dropped *before* buffering, not just before inverting (see `outerRingsOnly`). Growing
  // a polygon outward shrinks its holes, so an island narrower than twice the buffer collapses to a
  // sliver or self-intersects — and a broken ring here would propagate into every feather step.
  const water = bufferGeometry(
    { type: 'MultiPolygon', coordinates: outerRingsOnly(input.polygon).map((ring) => [ring]) },
    solidMeters,
  );
  if (water) parts.push(water);

  for (const path of input.approachPaths ?? []) {
    // Two points is the minimum for a line; a one-point "path" is a marker that lost its other end.
    if (path.length < 2) continue;
    const line: LineString = {
      type: 'LineString',
      coordinates: path.map((p) => [p.lng, p.lat]),
    };
    const walked = bufferGeometry(line, solidMeters);
    if (walked) parts.push(walked);
  }

  for (const coord of [...(input.parkingCoords ?? []), ...(input.markerCoords ?? [])]) {
    const point: Point = { type: 'Point', coordinates: [coord.lng, coord.lat] };
    const around = bufferGeometry(point, solidMeters);
    if (around) parts.push(around);
  }

  return polygonUnion(parts);
}

/**
 * `turf.buffer` with its failure modes handled, because it has several and they are all quiet.
 *
 * A degenerate ring, a self-intersection, or a zero-extent input can throw or come back `undefined`,
 * and each of those is one *part* of a mask rather than the whole thing — so a failure here drops
 * that part and lets the union carry the rest.
 */
function bufferGeometry(
  geom: Polygon | MultiPolygon | LineString | Point,
  meters: number,
): Polygon | MultiPolygon | null {
  if (meters <= 0) return geom.type === 'LineString' || geom.type === 'Point' ? null : geom;
  try {
    const grown = buffer(feature(geom), meters, { units: 'meters' });
    const out = grown?.geometry;
    if (!out) return null;
    return out.type === 'Polygon' || out.type === 'MultiPolygon' ? out : null;
  } catch {
    return null;
  }
}

/**
 * Every polygon's **outer ring only**, holes discarded.
 *
 * ## Why islands are not punched out — the first render answered this
 *
 * The first version treated a lake's islands as part of the mask, on the reasoning that *an island is
 * not the lake, so the photograph should stop at the water*. Rendering it falsified that twice over:
 *
 * 1. **It looked wrong.** An island in a lake is exactly the thing a skater is orienting by, and a
 *    lake full of white holes reads as damage, not as cartography. The founder's call on seeing it:
 *    *"maybe for imagery we can use only the outermost perimeter of the polygon for masking, and
 *    allow islands to show in full."*
 * 2. **It rendered wrong**, which is the part worth keeping in the comment. `inverseMask` puts the
 *    world in ring 0 and everything else after it, so a lake's island became **a hole inside a
 *    hole** — and MapLibre's triangulation resolves nested rings by nesting depth, not by which ring
 *    belonged to which shape. The output was white wedges radiating from the shoreline, which is the
 *    signature of an earcut failure and not the shape anyone asked for.
 *
 * Stripping holes fixes both at once, and it also removes the harder half of the *buffer*: growing a
 * polygon outward shrinks its holes, so an island narrower than the feather distance would collapse
 * or self-intersect on the way out. Islands never enter the geometry now, so they cannot.
 */
export function outerRingsOnly(shape: Polygon | MultiPolygon): Position[][] {
  const polygons = shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates;
  return polygons.flatMap((rings) => (rings[0] ? [rings[0]] : []));
}

/**
 * Invert a shape into a mask: a polygon covering the world with the shape punched out of it.
 *
 * **One hole per polygon, never per ring** — see `outerRingsOnly`. Ring winding is not normalised
 * because MapLibre's fill rule treats any subsequent ring as a hole regardless of direction, which
 * is the one place the renderer is more forgiving than the GeoJSON standard.
 */
export function inverseMask(shape: Polygon | MultiPolygon): Polygon {
  const rings: Position[][] = [WORLD_RING, ...outerRingsOnly(shape)];
  return { type: 'Polygon', coordinates: rings };
}

/** One stacked mask: the geometry to paint, and the alpha it carries. */
export interface FeatherRing {
  geometry: Polygon;
  opacity: number;
}

/**
 * The stacked inverse masks that fade the reveal's edge, **outermost first**.
 *
 * Ring `i` is the reveal grown by `feather · i/steps` and inverted, so the first entry covers the most
 * and the last hugs the shape. Painted in that order, a pixel just outside the shape is covered by
 * one mask and a pixel far outside is covered by all of them — the alpha accumulates into a ramp
 * without anything having to interpolate.
 *
 * Each layer carries the alpha that makes **the layers actually built** compose to
 * ~`MASK_FILL_OPACITY`: `1 − (1 − a)ⁿ = MASK_FILL_OPACITY`, solved for the final `n`.
 *
 * **Solved after the geometries exist, not before, and the first test written here caught why.** The
 * count is `steps + 1` (the buffers, plus the un-grown shape), and any buffer may drop out — so an
 * alpha derived from the *requested* step count is wrong twice over. Both errors land in the far
 * field: over-compose and the mask is effectively opaque, under-compose and the basemap *never quite*
 * covers the photograph. The second is a faint ghost of imagery across the whole map, which is easy to
 * see and very annoying to attribute to a constant.
 *
 * A zero-length result means the shape could not be built, and the caller must not draw the raster.
 */
export function featherRings(
  shape: Polygon | MultiPolygon,
  featherMeters: number,
  steps: number = FEATHER_STEPS,
): FeatherRing[] {
  if (steps < 1) return [];

  const shapes: Polygon[] = [];
  // A hard edge is the degenerate case of a feather, not a separate code path — it simply has no
  // grown rings, leaving the shape itself as the only mask.
  if (featherMeters > 0) {
    for (let i = steps; i >= 1; i--) {
      const grown = bufferGeometry(shape, (featherMeters * i) / steps);
      // A dropped buffer costs a step of smoothness, never the mask — the alpha below re-solves.
      if (grown) shapes.push(inverseMask(grown));
    }
  }
  // The shape itself, un-grown, is the innermost mask — without it the reveal bleeds by one step.
  shapes.push(inverseMask(shape));

  const perLayer = 1 - (1 - MASK_FILL_OPACITY) ** (1 / shapes.length);
  return shapes.map((geometry) => ({ geometry, opacity: perLayer }));
}

/**
 * The whole client-side mask in one call: solid core, then the rings that fade it.
 *
 * `null` is the "do not reveal" signal (see `revealShape`), and it is deliberately not an empty array
 * — an empty array is a shape that covers nothing, which paints no mask at all, which is the failure
 * that shows a skater a photograph of five states.
 */
export function buildImageryMask(
  input: ImageryMaskInput,
  meters: { solid: number; feather: number } = AERIAL_MASK_METERS,
  steps: number = FEATHER_STEPS,
): { shape: Polygon | MultiPolygon; rings: FeatherRing[] } | null {
  const shape = revealShape(input, meters.solid);
  if (!shape) return null;
  const rings = featherRings(shape, meters.feather, steps);
  if (rings.length === 0) return null;
  return { shape, rings };
}
