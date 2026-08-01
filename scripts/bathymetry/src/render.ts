/**
 * Framing a lake for the sample cards (N6b) — the projection, and nothing that draws.
 *
 * Two bugs live in this arithmetic and both were shipped by the first version of the sample renderer,
 * which is why it is a tested module rather than a helper inside the CLI:
 *
 * 1. **It framed to the soundings, not to the lake.** The bbox came from the data, so on any lake
 *    whose survey stopped short of the bank — most of them — the shoreline ran off the card and the
 *    contours appeared to float. The frame has to be the union of the polygon and the data, and the
 *    polygon is almost always the larger of the two.
 * 2. **It ignored latitude.** A degree of longitude at 44°N is about 0.72 of a degree of latitude, so
 *    scaling both axes by the same factor squashes every lake horizontally by ~28%. On a phase whose
 *    entire output is the *shape* of a basin, drawing every basin 28% too wide is not a cosmetic
 *    problem — a round pond renders as an east–west oval and reads as a morphology finding.
 *
 * Everything here is pure: bounds in, a projection out. Nothing touches a file or a subprocess.
 */

import type { MultiPolygon, Polygon, Position } from 'geojson';
import { metresPerLngDegree } from './grid';
import { ringsOf } from './shoreline';

export interface Bounds {
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
}

const EMPTY: Bounds = {
  minLng: Number.POSITIVE_INFINITY,
  maxLng: Number.NEGATIVE_INFINITY,
  minLat: Number.POSITIVE_INFINITY,
  maxLat: Number.NEGATIVE_INFINITY,
};

export function isEmptyBounds(b: Bounds): boolean {
  return !Number.isFinite(b.minLng) || !Number.isFinite(b.minLat);
}

/** Grow bounds to include a coordinate. */
export function extend(bounds: Bounds, lng: number, lat: number): Bounds {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return bounds;
  return {
    minLng: Math.min(bounds.minLng, lng),
    maxLng: Math.max(bounds.maxLng, lng),
    minLat: Math.min(bounds.minLat, lat),
    maxLat: Math.max(bounds.maxLat, lat),
  };
}

export function boundsOfPoints(points: readonly { lng: number; lat: number }[]): Bounds {
  let bounds = EMPTY;
  for (const p of points) bounds = extend(bounds, p.lng, p.lat);
  return bounds;
}

export function boundsOfPolygon(geometry: Polygon | MultiPolygon): Bounds {
  let bounds = EMPTY;
  for (const ring of ringsOf(geometry)) {
    for (const c of ring) bounds = extend(bounds, c[0] as number, c[1] as number);
  }
  return bounds;
}

export function boundsOfLines(lines: readonly Position[][]): Bounds {
  let bounds = EMPTY;
  for (const line of lines) {
    for (const c of line) bounds = extend(bounds, c[0] as number, c[1] as number);
  }
  return bounds;
}

export function unionBounds(...all: readonly Bounds[]): Bounds {
  let bounds = EMPTY;
  for (const b of all) {
    if (isEmptyBounds(b)) continue;
    bounds = extend(extend(bounds, b.minLng, b.minLat), b.maxLng, b.maxLat);
  }
  return bounds;
}

export interface Projection {
  /** Card size in px, aspect-matched to the lake rather than forced square. */
  width: number;
  height: number;
  x(lng: number): number;
  y(lat: number): number;
}

/**
 * Fit bounds into a card no larger than `maxSize` on either side, preserving true ground aspect.
 *
 * The card is sized to the *lake*, not the other way round: a long thin lake gets a long thin card
 * rather than being letterboxed into a square with most of the pixels empty. `maxSize` bounds the long
 * side, and `pad` is inset on all four so a shoreline stroke isn't clipped by the viewBox edge.
 *
 * **`minAspect` is a floor, not a preference.** Champlain is 174 km long and a few km wide; at true
 * aspect its card would be a 6-pixel-tall sliver. Clamping the short side keeps a degenerate lake
 * legible, at the cost of stretching it — so callers are told when it happened rather than left to
 * infer a false shape from the picture.
 */
export function fitProjection(
  bounds: Bounds,
  maxSize: number,
  pad: number,
  minAspect = 0.25,
): Projection & { stretched: boolean } {
  if (isEmptyBounds(bounds)) {
    const flat = { width: maxSize, height: maxSize, x: () => pad, y: () => pad, stretched: false };
    return flat;
  }

  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const mPerLng = metresPerLngDegree(midLat);
  // Ground metres, so the aspect is the lake's real one rather than the coordinate grid's.
  const spanX = Math.max((bounds.maxLng - bounds.minLng) * mPerLng, 1e-6);
  const spanY = Math.max((bounds.maxLat - bounds.minLat) * 111_320, 1e-6);

  const long = Math.max(spanX, spanY);
  const inner = maxSize - pad * 2;
  const scale = inner / long;

  let width = spanX * scale;
  let height = spanY * scale;
  const stretched = Math.min(width, height) < inner * minAspect;
  if (stretched) {
    // Clamp the short side. The long side keeps its scale, so the distortion is confined to one axis
    // and is reported in the caption rather than silently absorbed.
    if (width < height) width = inner * minAspect;
    else height = inner * minAspect;
  }

  const sx = width / spanX;
  const sy = height / spanY;
  return {
    width: width + pad * 2,
    height: height + pad * 2,
    x: (lng: number) => pad + (lng - bounds.minLng) * mPerLng * sx,
    // Screen y grows downward; latitude grows upward.
    y: (lat: number) => pad + (bounds.maxLat - lat) * 111_320 * sy,
    stretched,
  };
}
