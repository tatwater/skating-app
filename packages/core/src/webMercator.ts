/**
 * Web Mercator, and turning a lat/lng into a pixel inside an image (N6e).
 *
 * ## Why this exists at all
 *
 * The imagery reveal clips a photograph to a lake's shape by drawing that shape onto the photograph
 * as an alpha mask. The photograph comes back from `USGSNAIPPlus` in **EPSG:3857**, so the shape has
 * to be projected the same way before it is drawn — and the failure of getting that wrong is subtle
 * rather than loud: a linear lat/lng mapping puts the mask a few tens of metres off, north-south
 * only, growing with latitude. At 44°N over a 2 km lake that is roughly a **20 m** offset, which
 * reads as "the imagery is slightly misaligned with the shoreline" and would be blamed on the source.
 *
 * Kept in core rather than the web app because PR 2 needs the identical projection to bake alpha into
 * the Sentinel archive, and a second implementation is a second chance to be 20 m wrong.
 */

import type { LatLng } from './geometry';

/** Web Mercator's equatorial half-circumference, in metres — the edge of the projected world. */
export const MERCATOR_WORLD_M = 20037508.342789244;

/**
 * The latitude Web Mercator stops at. The projection sends ±90° to infinity, so every implementation
 * picks a cut-off; 85.051129° is the one that makes the projected world exactly square, and it is
 * what tile schemes assume.
 */
export const MERCATOR_MAX_LAT = 85.051128779806604;

/** A rectangle in projected metres. Distinct from `BBox`, which is degrees, on purpose. */
export interface MercatorBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Longitude → projected x, in metres. Linear, which is the half nobody gets wrong. */
export function lngToMercatorX(lng: number): number {
  return (lng / 180) * MERCATOR_WORLD_M;
}

/** Latitude → projected y, in metres. The half that matters. */
export function latToMercatorY(lat: number): number {
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const radians = (clamped * Math.PI) / 180;
  return (Math.log(Math.tan(Math.PI / 4 + radians / 2)) / Math.PI) * MERCATOR_WORLD_M;
}

/** Projected x → longitude. */
export function mercatorXToLng(x: number): number {
  return (x / MERCATOR_WORLD_M) * 180;
}

/** Projected y → latitude. */
export function mercatorYToLat(y: number): number {
  const radians = 2 * Math.atan(Math.exp((y / MERCATOR_WORLD_M) * Math.PI)) - Math.PI / 2;
  return (radians * 180) / Math.PI;
}

/** A degrees box → a projected-metres box. */
export function toMercatorBox(box: {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}): MercatorBox {
  return {
    minX: lngToMercatorX(box.minLng),
    minY: latToMercatorY(box.minLat),
    maxX: lngToMercatorX(box.maxLng),
    maxY: latToMercatorY(box.maxLat),
  };
}

/**
 * A coordinate → its pixel inside an image covering `box` at `width` × `height`.
 *
 * **Y is flipped**, because projected y grows north and canvas y grows down. That inversion is the
 * single most likely thing to get backwards here, and getting it backwards renders a mask that is a
 * perfect mirror of the lake — which looks like a plausible shape and is completely wrong.
 */
export function projectToPixel(
  point: LatLng,
  box: MercatorBox,
  width: number,
  height: number,
): { x: number; y: number } {
  const spanX = box.maxX - box.minX || 1;
  const spanY = box.maxY - box.minY || 1;
  return {
    x: ((lngToMercatorX(point.lng) - box.minX) / spanX) * width,
    y: ((box.maxY - latToMercatorY(point.lat)) / spanY) * height,
  };
}

/**
 * Metres on the ground per pixel, at the box's centre latitude.
 *
 * Used to convert a feather distance in metres into a blur radius in pixels. Projected metres are
 * *not* ground metres — Mercator stretches by `1/cos(latitude)`, ~1.40× at 44°N — so a feather
 * computed from the projected span alone would come out 40% too wide here and worse further north.
 */
export function groundMetersPerPixel(box: MercatorBox, width: number): number {
  const projectedPerPixel = (box.maxX - box.minX) / Math.max(1, width);
  const centreLat = mercatorYToLat((box.minY + box.maxY) / 2);
  return projectedPerPixel * Math.cos((centreLat * Math.PI) / 180);
}
