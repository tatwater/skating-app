/**
 * The shape imagery is allowed to show through — N6e's reveal, clipped to one lake **and the way in**.
 *
 * ## D146 — imagery is content scoped to a body, not a base-map swap
 *
 * > *"Toggling satellite imagery on might somehow bound the image to the confines of a single lake
 * > body somehow… except we also mark other things on the map now, like parking, put-ins, bathrooms,
 * > an access trail, so we probably want our satellite imagery to cover those markings as well."*
 *
 * So the reveal is a **shape**, not a screen. This module computes that shape and nothing about
 * rendering — where the alpha gets punched in is the client's business (the web app's
 * `imageryCanvas`, and PR 2's archive for the Sentinel tier).
 *
 * ## What used to live here, and why it doesn't
 *
 * The first build clipped by **covering**: draw the raster edge-to-edge, then paint over everything
 * outside the lake with an inverted polygon — the region mask's trick, retargeted from five states to
 * one buffered lake. A stack of those at increasing buffers faked a feather.
 *
 * It shipped, and the render killed it: a mask hides whatever is beneath it, so the roads and labels
 * went with the map. Owning the pixels instead — fetching the photograph and punching its alpha
 * channel ourselves — leaves the whole basemap intact and turns the feather into a real gradient. So
 * `inverseMask`, `featherRings` and the stacked-opacity arithmetic are gone, and what remains is the
 * geometry that was always the useful part.
 */

import buffer from '@turf/buffer';
import { feature } from '@turf/helpers';
import type { LineString, MultiPolygon, Point, Polygon, Position } from 'geojson';
import { type LatLng, polygonUnion } from './geometry';

/** Source and layer ids, so the two clients cannot name the same thing differently. */
export const IMAGERY_SOURCE_ID = 'imagery';
export const IMAGERY_LAYER_ID = 'imagery-raster';

/**
 * How far the reveal extends past what it is revealing, per tier — **and the units are pixels
 * whether we write them in metres or not.**
 *
 * At Sentinel's 10 m ground sample, a 10 m buffer is **one pixel**: invisible, and a feather built
 * from it is a hard edge with extra steps. So the aerial tier's numbers cannot simply be reused, and
 * the ratio between the two pairs is roughly the ratio of their resolutions.
 *
 * **Set by looking at a render, which is the only way these were ever going to be right.** The first
 * pass guessed 10 m solid + 30 m fade; against a 0.3 m photograph that read as no fade at all.
 * Founder, on seeing it: *"the feathering is too minimal — I think we could go to 20 m solid and a
 * fade over the next 50-100 m."* 80 m splits that range.
 */
export const AERIAL_MASK_METERS = { solid: 20, feather: 80 } as const;
export const SENTINEL_MASK_METERS = { solid: 60, feather: 240 } as const;

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
 * A cheap structural fingerprint of a shape, for **caching a mask's object identity**.
 *
 * ## The bug this exists to stop, which is a fetch storm and not a re-render
 *
 * The reveal is keyed on its `mask` object, and re-running its effect tears the canvas layers down
 * and re-requests the photograph. A Convex subscription re-emits on its own schedule with
 * structurally identical but newly-allocated geometry, so a memo that depends on `body.polygon`
 * *identity* hands back a new mask roughly once a second — and on screen that is a steady flicker of
 * basemap through the photograph, with a full dynamic render behind each one.
 *
 * So callers key on what the mask is **made of**. This is that key for the geometry half.
 *
 * **Deliberately not a hash of every coordinate.** A lake polygon runs to thousands of vertices and
 * this is computed on every render; ring count, vertex count and the first and last positions change
 * for any real redraw, at O(rings) rather than O(vertices). The failure it can theoretically miss —
 * an edit that preserves all four and moves only interior vertices — is not a thing the editor's
 * draw tools produce, and the cost of missing it is a stale photograph until the next pan, not a
 * wrong one.
 */
export function shapeSignature(shape: Polygon | MultiPolygon): string {
  const polygons = shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates;
  let rings = 0;
  let vertices = 0;
  for (const polygon of polygons) {
    rings += polygon.length;
    for (const ring of polygon) vertices += ring.length;
  }
  const first = polygons[0]?.[0]?.[0];
  const lastRing = polygons.at(-1)?.at(-1);
  const last = lastRing?.at(-1);
  const at = (position: Position | undefined) =>
    position ? `${position[0]?.toFixed(6)},${position[1]?.toFixed(6)}` : '-';
  return `${shape.type}:${polygons.length}:${rings}:${vertices}:${at(first)}:${at(last)}`;
}

/**
 * Every polygon's **outer ring only**, holes discarded.
 *
 * ## Why islands are not punched out — the first render answered this
 *
 * v1 treated a lake's islands as part of the mask, on the reasoning that *an island is not the lake,
 * so the photograph should stop at the water*. Rendering it falsified that twice over:
 *
 * 1. **It looked wrong.** An island is exactly the thing a skater orients by, and a lake full of
 *    white holes reads as damage rather than cartography. The founder's call on seeing it: *"maybe for
 *    imagery we can use only the outermost perimeter of the polygon for masking, and allow islands to
 *    show in full."*
 * 2. **It rendered wrong**, which is the part worth keeping. Inverting put the world in ring 0 and
 *    everything else after it, so an island became **a hole inside a hole** — and triangulation
 *    resolves nested rings by nesting depth, not by which ring belonged to which shape. The output
 *    was white wedges radiating from the shoreline.
 *
 * The covering approach is gone, but this rule outlived it, because it also removes the harder half
 * of the *buffer*: growing a polygon outward shrinks its holes, so an island narrower than twice the
 * feather would collapse or self-intersect on the way out. Islands never enter the geometry, so they
 * cannot break it.
 */
export function outerRingsOnly(shape: Polygon | MultiPolygon): Position[][] {
  const polygons = shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates;
  return polygons.flatMap((rings) => (rings[0] ? [rings[0]] : []));
}

/**
 * The solid core of the reveal: everything we are showing, buffered by `solidMeters` and unioned.
 *
 * Returns `null` only if the union fails outright, which the caller must treat as *"do not reveal"*
 * rather than *"reveal everything"* — a reveal that fails open is a photograph of the whole Northeast
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

  // Holes dropped before buffering, not just before drawing — see `outerRingsOnly`.
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
 * and each of those is one *part* of a reveal rather than the whole thing — so a failure here drops
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
