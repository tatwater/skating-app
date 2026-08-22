/**
 * Compositing aerial cells onto one canvas and clipping them to water (N6e / D146, third attempt).
 *
 * ## Three architectures, and what each render falsified
 *
 * **v1 clipped by covering**: a tiled raster drawn edge-to-edge, then the basemap's colour painted
 * over everything outside the lake. It worked and it cost the map — a mask hides whatever is beneath
 * it, so the roads, the landuse and the labels went too. Founder: *"All of the roads disappeared, I'd
 * like to see the dark-mode flat map everywhere outside of the satellite image."*
 *
 * **v2 owned the pixels**: one `exportImage` per settled view, drawn to a canvas, alpha punched in
 * against the lake's shape, handed to MapLibre as a canvas source. That fixed the map and introduced
 * two problems of its own — the photograph covered only the selected lake while the *cartography*
 * changes applied to the whole viewport, and every request was a unique URL.
 *
 * **v3 (here) splits fetch resolution from display resolution.** Pixels come from a fixed grid
 * (`@skating/core`'s `imageryTiles`) so their URLs repeat and the service's CDN can answer them —
 * measured, that is 29.3 s → 0.08 s. Those cells are composited into one canvas sized for the screen
 * rather than for the grid, and the alpha is punched against **every** revealed body at once, which
 * is what lets one fetch serve a viewport full of lakes instead of one lake.
 *
 * ## Why one canvas rather than a raster source per cell
 *
 * MapLibre cannot clip a raster to a polygon — there is no `clip` layer in 5.24 and `raster-opacity`
 * cannot vary within a layer — so the alpha has to be ours. Compositing first and clipping once also
 * means the feather is a **real gradient** across the whole reveal instead of a seam wherever two
 * cells meet.
 */

import {
  groundMetersPerPixel,
  type ImageryTile,
  type LatLng,
  type MercatorBox,
  outerRingsOnly,
  projectToPixel,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';

/**
 * The largest composite we will build, per side.
 *
 * A GPU texture is four bytes a pixel, so a 4,096-square canvas is 67 MB resident — on a phone that
 * is the difference between a working map and a reloaded tab. The cells behind it stay at their grid
 * resolution regardless; this bounds only what we upload.
 */
export const MAX_COMPOSITE_PX = 4096;

/** The four corners MapLibre wants for a canvas source: TL, TR, BR, BL. */
export function imageryCorners(box: {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}): [[number, number], [number, number], [number, number], [number, number]] {
  return [
    [box.minLng, box.maxLat],
    [box.maxLng, box.maxLat],
    [box.maxLng, box.minLat],
    [box.minLng, box.minLat],
  ];
}

/**
 * Canvas dimensions for a projected box at a target sharpness.
 *
 * **The aspect ratio comes from the Mercator span and nothing else**, which v2 learned the hard way
 * against the export service and stays true here for a different reason: the canvas is painted onto
 * the corners of `bounds`, so a canvas whose aspect disagrees with `bounds` stretches every feature
 * in it. Deriving height from *degrees* would be wrong too, and subtly — Mercator stretches latitude
 * by 1/cos(φ), ~1.4× at 44°N, which is a 40% error dressed as arithmetic.
 */
export function compositeCanvasSize(
  bounds: MercatorBox,
  metersPerPixel: number,
  maxPx: number = MAX_COMPOSITE_PX,
): { width: number; height: number } {
  const spanX = Math.max(1e-9, bounds.maxX - bounds.minX);
  const spanY = Math.max(1e-9, bounds.maxY - bounds.minY);
  const safeMpp = Number.isFinite(metersPerPixel) && metersPerPixel > 0 ? metersPerPixel : spanX;

  let width = Math.max(1, Math.round(spanX / safeMpp));
  let height = Math.max(1, Math.round((width * spanY) / spanX));
  // Clamp on the longer side and let the other follow, so the cap cannot itself introduce the
  // aspect mismatch it exists alongside.
  if (width > maxPx || height > maxPx) {
    const scale = maxPx / Math.max(width, height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  return { width, height };
}

/** Where a projected box lands in the pixel space of `bounds`. */
function pixelRect(
  box: MercatorBox,
  bounds: MercatorBox,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  const spanX = Math.max(1e-9, bounds.maxX - bounds.minX);
  const spanY = Math.max(1e-9, bounds.maxY - bounds.minY);
  const x = ((box.minX - bounds.minX) / spanX) * width;
  // y is flipped: Mercator grows north, canvas rows grow south.
  const y = ((bounds.maxY - box.maxY) / spanY) * height;
  return {
    x,
    y,
    w: ((box.maxX - box.minX) / spanX) * width,
    h: ((box.maxY - box.minY) / spanY) * height,
  };
}

/**
 * Trace a shape onto a context in the pixel space of `bounds`.
 *
 * Outer rings only (`outerRingsOnly`) — islands are part of what the photograph shows, which the
 * first render settled. Every ring is projected through Web Mercator, because that is the projection
 * the bytes came back in; a linear lat/lng trace would sit ~20 m off the shoreline at our latitude
 * and read as the imagery being misregistered.
 *
 * Does **not** begin or close the path, so a caller can trace many shapes into one path and fill
 * them together — which is how a viewport full of lakes becomes a single composite operation.
 */
export function traceShape(
  ctx: CanvasRenderingContext2D,
  shape: Polygon | MultiPolygon,
  bounds: MercatorBox,
  width: number,
  height: number,
): void {
  for (const ring of outerRingsOnly(shape)) {
    ring.forEach((position, index) => {
      const point: LatLng = { lng: position[0] ?? 0, lat: position[1] ?? 0 };
      const { x, y } = projectToPixel(point, bounds, width, height);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }
}

/** One fetched cell, ready to draw. */
export interface DrawableTile {
  tile: ImageryTile;
  image: CanvasImageSource;
}

export interface ComposeOptions {
  canvas: HTMLCanvasElement;
  /** The cells that resolved. Any that did not are simply absent — see `composeImagery`. */
  tiles: readonly DrawableTile[];
  /** The projected box the canvas covers — the union of the requested cells. */
  bounds: MercatorBox;
  /** Every body being revealed. Empty ⇒ nothing is kept, which is the fail-closed direction. */
  shapes: readonly (Polygon | MultiPolygon)[];
  /** Metres over which the edge fades to nothing. `0` ⇒ a hard edge. */
  featherMeters: number;
  /** `false` ⇒ keep the whole composite, shapes untouched (the admin editor's unmasked mode). */
  clip?: boolean;
}

/**
 * Draw the cells, then keep only the parts inside the revealed bodies, fading out over
 * `featherMeters`.
 *
 * `destination-in` is the operator that makes this work: it multiplies what is already on the canvas
 * by the alpha of what is drawn next, so filling the shapes *keeps* the photograph there and erases
 * it everywhere else. The blur on that fill is what turns a hard edge into a gradient — one `filter`
 * rather than stacked fills, and a true ramp rather than steps of one.
 *
 * **Blur is measured in ground metres and converted here.** A radius in pixels would mean the feather
 * changed width every time the zoom did — the sort of thing that looks like a rendering bug and is
 * really a units bug.
 *
 * **A missing cell leaves its ground empty rather than stretching a neighbour over it.** The caller
 * only swaps a composite in once its cells have settled, so a hole here means a cell genuinely failed
 * — and blank ground the basemap shows through is honest, where a smeared neighbour is a photograph
 * of somewhere else.
 *
 * Returns `false` when there is no 2D context, or when the edge came out hard because the browser has
 * no canvas `filter`. The canvas is still usable in that case; it just will not have faded.
 */
export function composeImagery({
  canvas,
  tiles,
  bounds,
  shapes,
  featherMeters,
  clip,
}: ComposeOptions): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  for (const { tile, image } of tiles) {
    const rect = pixelRect(tile.box, bounds, width, height);
    // Rounded outward by a hair: adjacent cells share an edge, and sub-pixel rounding between two
    // of them leaves a one-pixel transparent seam that reads as a grid drawn over the water.
    ctx.drawImage(
      image,
      Math.floor(rect.x),
      Math.floor(rect.y),
      Math.ceil(rect.w) + 1,
      Math.ceil(rect.h) + 1,
    );
  }

  if (clip === false) return true;

  // Mercator metres are not ground metres — they are inflated by 1/cos(φ), ~1.4× at our latitude.
  // `groundMetersPerPixel` already carries that conversion, and having one copy of it is the point.
  const groundPerPixel = groundMetersPerPixel(bounds, width);
  // Half the feather, because a blur spreads both ways from the edge it is applied to — so a radius
  // of `feather / 2` produces a ramp `feather` wide overall.
  const blurPx = groundPerPixel > 0 ? featherMeters / 2 / groundPerPixel : 0;

  let feathered = false;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  if (featherMeters > 0 && blurPx >= 0.5 && 'filter' in ctx) {
    ctx.filter = `blur(${blurPx.toFixed(2)}px)`;
    feathered = ctx.filter !== 'none';
  }
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  // Every body in one path, filled once. Nonzero winding unions them for free, which is why a
  // viewport of overlapping reveals needs no geometric union at all.
  for (const shape of shapes) traceShape(ctx, shape, bounds, width, height);
  ctx.fill();
  ctx.restore();
  return feathered;
}
