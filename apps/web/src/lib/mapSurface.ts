/**
 * What the console map's chrome needs of a map: its size, its camera, and its two projections. The
 * frame's marks, labels, graticule and scale are drawn from this alone, so the same pane draws over
 * a live MapLibre canvas (`useMapLibreSurface`) or over a still (`stillSurface`, for stories and
 * tests) — and the still is the same Web Mercator MapLibre draws in, so a story and the app place
 * every mark at the same pixel.
 */

export interface Point {
  x: number;
  y: number;
}

export interface MapSurface {
  width: number;
  height: number;
  /** MapLibre's zoom (512 px tiles). */
  zoom: number;
  center: { lng: number; lat: number };
  project: (lngLat: readonly [number, number]) => Point;
  unproject: (point: Point) => { lng: number; lat: number };
}

/** Padding inside a pane, px. */
export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface BBoxLike {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

const TILE = 512;

/** Web Mercator at zoom 0, in px of a 512 px world. */
function worldX(lng: number): number {
  return ((lng + 180) / 360) * TILE;
}
function worldY(lat: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE;
}
function lngOf(x: number): number {
  return (x / TILE) * 360 - 180;
}
function latOf(y: number): number {
  const n = Math.PI - (2 * Math.PI * y) / TILE;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** A camera that frames `bbox` inside the padded pane, as MapLibre's `fitBounds` would. */
export function fitCamera(
  bbox: BBoxLike,
  width: number,
  height: number,
  pad: Padding,
): { center: { lng: number; lat: number }; zoom: number } {
  const x0 = worldX(bbox.minLng);
  const x1 = worldX(bbox.maxLng);
  const y0 = worldY(bbox.maxLat);
  const y1 = worldY(bbox.minLat);
  const availW = Math.max(1, width - pad.left - pad.right);
  const availH = Math.max(1, height - pad.top - pad.bottom);
  const scale = Math.min(availW / Math.max(x1 - x0, 1e-9), availH / Math.max(y1 - y0, 1e-9));
  const zoom = Math.log2(scale);
  // The bbox's center sits at the padded area's center; the pane's center is offset from it.
  const cx = (x0 + x1) / 2 - (pad.left - pad.right) / 2 / scale;
  const cy = (y0 + y1) / 2 - (pad.top - pad.bottom) / 2 / scale;
  return { center: { lng: lngOf(cx), lat: latOf(cy) }, zoom };
}

/** A still map: a fixed camera over a pane, projected as MapLibre projects. */
export function stillSurface(
  width: number,
  height: number,
  camera: { center: { lng: number; lat: number }; zoom: number },
): MapSurface {
  const scale = 2 ** camera.zoom;
  const cx = worldX(camera.center.lng) * scale;
  const cy = worldY(camera.center.lat) * scale;
  return {
    width,
    height,
    zoom: camera.zoom,
    center: camera.center,
    project: ([lng, lat]) => ({
      x: worldX(lng) * scale - cx + width / 2,
      y: worldY(lat) * scale - cy + height / 2,
    }),
    unproject: ({ x, y }) => ({
      lng: lngOf((x - width / 2 + cx) / scale),
      lat: latOf((y - height / 2 + cy) / scale),
    }),
  };
}
