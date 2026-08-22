/**
 * Clipping a photograph to a lake, on a canvas (N6e / D146, second attempt).
 *
 * ## Why this replaced the mask layers
 *
 * The first build clipped by **covering**: draw the raster edge-to-edge, then paint over everything
 * outside the lake with the basemap's own colour. It worked, and it cost the map — a mask hides
 * whatever is beneath it, so the roads, the landuse and the labels all went with it. Founder, on
 * seeing it: *"All of the roads disappeared, I'd like to see the dark-mode flat map everywhere
 * outside of the satellite image."*
 *
 * **MapLibre cannot clip a raster to a polygon.** There is no `clip` layer in 5.24 (that is a Mapbox
 * GL feature), and `raster-opacity` cannot vary across a layer. So covering is the only option *if
 * the pixels come from a tile source we do not control the bytes of*.
 *
 * The way out is to control the bytes: fetch the photograph ourselves, punch the alpha in on a
 * canvas, and hand MapLibre something already lake-shaped. Then nothing is painted over, the whole
 * vector basemap stays visible outside the reveal, and — because we own the alpha channel — the
 * feather becomes a **real gradient** instead of six stacked fills.
 *
 * ## What it costs, stated plainly
 *
 * One image covers one view at one resolution, so this re-fetches when the map settles somewhere new
 * (`imageryViewBox`). That is a fetch per pan instead of a tile pyramid — which against `exportImage`
 * is *fewer* requests than the tile path made, since every tile was already a dynamic render.
 *
 * PR 2's Sentinel archive bakes its alpha server-side for exactly the same reasons, so the shape of
 * this file is the shape of that pipeline's output stage.
 */

import {
  AERIAL_MAX_EXPORT_PX,
  type BBox,
  groundMetersPerPixel,
  type LatLng,
  outerRingsOnly,
  projectToPixel,
  toMercatorBox,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';

/**
 * How much beyond the visible view to fetch.
 *
 * A small overshoot means a short drag reuses the image already on screen rather than firing a
 * render for two hundred metres of new ground. Too much overshoot and every fetch is mostly wasted
 * pixels; 15% is roughly the point where a nudge is free and a real pan still refetches.
 */
const VIEW_PAD_FRACTION = 0.15;

/**
 * The box to fetch: the visible view, padded, and clipped to the reveal.
 *
 * **Clipped to the reveal, which is the whole efficiency story.** Zoomed out to the region with a
 * pond selected, the view is 200 km across and the pond is 400 m of it — fetching the view would ask
 * USGS to render half of Vermont so we could keep 0.004% of it. Intersecting first means the request
 * is always proportional to *the lake*, never to the screen.
 *
 * `null` when the reveal is off screen entirely: there is nothing to draw, and asking for a
 * zero-width image is how you get an error instead of a blank.
 */
export function imageryViewBox(view: BBox, reveal: BBox): BBox | null {
  const padLat = (view.maxLat - view.minLat) * VIEW_PAD_FRACTION;
  const padLng = (view.maxLng - view.minLng) * VIEW_PAD_FRACTION;
  const box = {
    minLat: Math.max(view.minLat - padLat, reveal.minLat),
    maxLat: Math.min(view.maxLat + padLat, reveal.maxLat),
    minLng: Math.max(view.minLng - padLng, reveal.minLng),
    maxLng: Math.min(view.maxLng + padLng, reveal.maxLng),
  };
  if (box.maxLat <= box.minLat || box.maxLng <= box.minLng) return null;
  return box;
}

/**
 * Pixel dimensions for that box: enough to be sharp on this screen, never more than the service will
 * render.
 *
 * Sized off **the box's share of the viewport**, at device pixel ratio, so the image is drawn at
 * roughly one image pixel per screen pixel. Asking for more is bytes nobody sees; asking for less is
 * a blurry photograph, which on a 0.3 m source is the one thing that would make the whole tier
 * pointless.
 */
export function imageryCanvasSize(
  box: BBox,
  view: BBox,
  viewportPx: { width: number; height: number },
  pixelRatio = 1,
): { width: number; height: number } {
  const fracLng = (box.maxLng - box.minLng) / Math.max(1e-12, view.maxLng - view.minLng);
  const fracLat = (box.maxLat - box.minLat) / Math.max(1e-12, view.maxLat - view.minLat);
  const clamp = (value: number) =>
    Math.max(1, Math.min(AERIAL_MAX_EXPORT_PX, Math.round(value * pixelRatio)));
  return {
    width: clamp(Math.min(1, fracLng) * viewportPx.width),
    height: clamp(Math.min(1, fracLat) * viewportPx.height),
  };
}

/** The four corners MapLibre wants for an image/canvas source: TL, TR, BR, BL. */
export function imageryCorners(
  box: BBox,
): [[number, number], [number, number], [number, number], [number, number]] {
  return [
    [box.minLng, box.maxLat],
    [box.maxLng, box.maxLat],
    [box.maxLng, box.minLat],
    [box.minLng, box.minLat],
  ];
}

/**
 * Trace a shape onto a canvas context in the box's pixel space.
 *
 * Outer rings only (`outerRingsOnly`) — islands are part of what the photograph shows, which the
 * first render settled. Every ring is projected through **Web Mercator**, because that is the
 * projection the bytes came back in; a linear lat/lng trace would sit ~20 m north or south of the
 * shoreline at our latitude and read as the imagery being misregistered.
 */
export function traceShape(
  ctx: CanvasRenderingContext2D,
  shape: Polygon | MultiPolygon,
  box: BBox,
  width: number,
  height: number,
): void {
  const merc = toMercatorBox(box);
  ctx.beginPath();
  for (const ring of outerRingsOnly(shape)) {
    ring.forEach((position, index) => {
      const point: LatLng = { lng: position[0] ?? 0, lat: position[1] ?? 0 };
      const { x, y } = projectToPixel(point, merc, width, height);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }
}

export interface ClipOptions {
  canvas: HTMLCanvasElement;
  image: CanvasImageSource;
  box: BBox;
  shape: Polygon | MultiPolygon;
  /** Metres over which the edge fades to nothing. `0` ⇒ a hard edge. */
  featherMeters: number;
}

/**
 * Draw the photograph, then keep only the part inside the lake, fading out over `featherMeters`.
 *
 * `destination-in` is the operator that makes this work: it multiplies what is already on the canvas
 * by the alpha of what is drawn next, so filling the lake's shape *keeps* the photograph there and
 * erases it everywhere else. The blur on that fill is what turns a hard edge into a gradient — one
 * `filter` instead of the six stacked fills the mask version needed, and a true ramp rather than six
 * steps of one.
 *
 * **Blur is measured in ground metres, converted here.** A radius in pixels would mean the feather
 * changed width every time the zoom did, which is the sort of thing that looks like a rendering bug
 * and is really a units bug.
 *
 * Returns `false` when the browser has no 2D context or no canvas `filter` support and the edge came
 * out hard; the caller can still use the canvas, it just will not have faded.
 */
export function drawClippedImagery({
  canvas,
  image,
  box,
  shape,
  featherMeters,
}: ClipOptions): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);

  const metersPerPixel = groundMetersPerPixel(toMercatorBox(box), width);
  // Half the feather, because a blur spreads in both directions from the edge it is applied to — so a
  // radius of `feather / 2` produces a ramp `feather` wide overall.
  const blurPx = metersPerPixel > 0 ? featherMeters / 2 / metersPerPixel : 0;

  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  let feathered = false;
  if (featherMeters > 0 && blurPx >= 0.5 && 'filter' in ctx) {
    ctx.filter = `blur(${blurPx.toFixed(2)}px)`;
    feathered = ctx.filter !== 'none';
  }
  ctx.fillStyle = '#ffffff';
  traceShape(ctx, shape, box, width, height);
  ctx.fill();
  ctx.restore();
  return feathered;
}
