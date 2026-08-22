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
  type ImageryMaskInput,
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

/**
 * How much of the composite's resolution the mask is painted at.
 *
 * The mask is a solid shape with a soft edge — it carries far less detail than the photograph it
 * clips, so half resolution costs nothing visible and quarters a second full-size canvas. At the
 * 4,096 px ceiling that is 17 MB rather than 67 MB, which on a phone is the difference between a
 * working map and a reloaded tab.
 */
export const MASK_SCALE = 0.5;

export interface ComposeOptions {
  canvas: HTMLCanvasElement;
  /** Scratch canvas for the alpha mask — supplied by the caller so it is allocated once, not per view. */
  maskCanvas: HTMLCanvasElement;
  /** The cells that resolved. Any that did not are simply absent — see `composeImagery`. */
  tiles: readonly DrawableTile[];
  /** The projected box the canvas covers — the union of the requested cells. */
  bounds: MercatorBox;
  /** Every body being revealed. Empty ⇒ nothing is kept, which is the fail-closed direction. */
  masks: readonly ImageryMaskInput[];
  /** How far the reveal extends past what it reveals, at full opacity. */
  solidMeters: number;
  /** Metres over which the edge then fades to nothing. `0` ⇒ a hard edge. */
  featherMeters: number;
  /** `false` ⇒ keep the whole composite, masks untouched (the admin editor's unmasked mode). */
  clip?: boolean;
}

/**
 * Paint the reveal's alpha — **rasterised, where it used to be geometry**.
 *
 * ## Why the buffer stopped being a Turf buffer
 *
 * The solid ring around a lake used to come from `revealShape`: a real geodesic buffer, unioned
 * across the water, the walk and the parking. That is the right shape and the wrong place to compute
 * it. Viewport-wide reveal means up to fifty bodies, each a polygon of thousands of vertices, and
 * `buffer` + `union` over that set ran **synchronously on the main thread** on the first refresh of
 * every new view.
 *
 * A worker was the obvious fix and the wrong one: PR 2 puts this on React Native, which has no Web
 * Workers, so it would have bought a smooth web build and left mobile with the same stall.
 *
 * Dilating in *pixel space* removes the work instead of moving it. A stroke is centred on its path,
 * so filling a ring and stroking it at `2 × solid` yields exactly the ring dilated outward by
 * `solid` — with round joins, which is what Turf's default buffer produces too. The rasteriser does
 * it, so fifty bodies cost fifty fills rather than fifty buffers, and there is no union to compute:
 * overlapping alpha *is* the union.
 *
 * The same trick covers the rest of the reveal. An approach path is a stroked line at the same width;
 * a put-in or a parking coordinate is a disc of radius `solid`. D146's *"the same standard buffer
 * distance from the polygon's edges AND on both sides of the hiking trail AND around the parking
 * lot"* is three canvas operations.
 *
 * ⚠ **Painted opaque on its own canvas, never straight onto the photograph.** `destination-in`
 * *intersects*, so a fill followed by a stroke would keep only their overlap — the interior — and
 * throw the ring away. The mask has to be fully assembled before it meets the composite, which is
 * what `maskCanvas` is for.
 *
 * `revealShape` stays in `@skating/core`: PR 2's Sentinel archive bakes its alpha server-side, where
 * there is no rasteriser and the real geometry is the answer.
 */
function paintRevealMask(
  maskCanvas: HTMLCanvasElement,
  masks: readonly ImageryMaskInput[],
  bounds: MercatorBox,
  width: number,
  height: number,
  solidPx: number,
): boolean {
  const ctx = maskCanvas.getContext('2d');
  if (!ctx) return false;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  // Round everywhere, so the dilation is a true buffer rather than a mitred one — a sharp spit of
  // shoreline would otherwise grow a spike several times the buffer distance.
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Centred on the path ⇒ `solidPx` outward and `solidPx` inward, and the inward half lands inside
  // the fill. Net: dilated outward by exactly `solidPx`.
  ctx.lineWidth = Math.max(0.01, solidPx * 2);

  const toPixel = (point: LatLng) => projectToPixel(point, bounds, width, height);

  for (const mask of masks) {
    ctx.beginPath();
    traceShape(ctx, mask.polygon, bounds, width, height);
    ctx.fill();
    // Only worth stroking when it would show — below half a pixel the fill already is the answer.
    if (solidPx >= 0.25) ctx.stroke();

    for (const path of mask.approachPaths ?? []) {
      // A single point is a marker that lost its other end (`revealShape` refuses these too), and
      // stroking it would draw nothing anyway.
      if (path.length < 2) continue;
      ctx.beginPath();
      path.forEach((point, index) => {
        const { x, y } = toPixel(point);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    const points = [...(mask.parkingCoords ?? []), ...(mask.markerCoords ?? [])];
    for (const point of points) {
      const { x, y } = toPixel(point);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, solidPx), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return true;
}

/**
 * Draw the cells, then keep only the parts inside the revealed bodies, fading out over
 * `featherMeters`.
 *
 * `destination-in` is the operator that makes this work: it multiplies what is already on the canvas
 * by the alpha of what is drawn next, so drawing the mask *keeps* the photograph where the mask is
 * opaque and erases it everywhere else. The blur on that draw is what turns a hard edge into a
 * gradient — one `filter` rather than stacked fills, and a true ramp rather than steps of one.
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
  maskCanvas,
  tiles,
  bounds,
  masks,
  solidMeters,
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

  // No clip ⇒ the composite *is* the output, and its edge is hard by construction. `false` is the
  // honest answer to "did this feather?", which is the only question the return value asks.
  if (clip === false) return false;

  // Mercator metres are not ground metres — they are inflated by 1/cos(φ), ~1.4× at our latitude.
  // `groundMetersPerPixel` already carries that conversion, and having one copy of it is the point.
  const groundPerPixel = groundMetersPerPixel(bounds, width);
  // Half the feather, because a blur spreads both ways from the edge it is applied to — so a radius
  // of `feather / 2` produces a ramp `feather` wide overall.
  const blurPx = groundPerPixel > 0 ? featherMeters / 2 / groundPerPixel : 0;
  const solidPx = groundPerPixel > 0 ? solidMeters / groundPerPixel : 0;

  const maskWidth = Math.max(1, Math.round(width * MASK_SCALE));
  const maskHeight = Math.max(1, Math.round(height * MASK_SCALE));
  maskCanvas.width = maskWidth;
  maskCanvas.height = maskHeight;
  // The mask's pixels are its own, so the buffer converts into *its* scale rather than the composite's.
  if (!paintRevealMask(maskCanvas, masks, bounds, maskWidth, maskHeight, solidPx * MASK_SCALE)) {
    // **Fails closed, like an empty mask does.** No second context means no alpha to punch, and
    // returning here with the composite untouched would publish the whole *rectangle* — a photograph
    // over the land, the roads and every lake we were not asked to reveal, which is exactly what
    // clipping exists to prevent. Nothing kept is the honest answer to a mask we could not build.
    ctx.clearRect(0, 0, width, height);
    return false;
  }

  let feathered = false;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  if (featherMeters > 0 && blurPx >= 0.5 && 'filter' in ctx) {
    ctx.filter = `blur(${blurPx.toFixed(2)}px)`;
    feathered = ctx.filter !== 'none';
  }
  // Scaled back up to the composite. The upsample softens the mask very slightly, which for an edge
  // that is about to be blurred by tens of pixels is beneath notice.
  ctx.drawImage(maskCanvas, 0, 0, width, height);
  ctx.restore();
  return feathered;
}
