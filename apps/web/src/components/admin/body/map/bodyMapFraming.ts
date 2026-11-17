import { type BBoxLike, fitCamera, type Padding } from '@/lib/mapSurface';

/**
 * **The console map frames its body only in a real box** (B01-3o, Greptile's P1 on #144). On a
 * narrow page the map's pane can be hidden while the map loads, or while it is re-created for
 * another body or a theme: its container measures zero, and a fit made then frames the body into
 * one pixel — the camera far out, the floor with it — and nothing ever framed it again.
 *
 * The rule, one function, called on load and on every resize of the live map:
 * - **Only a box with width and height is measured.** Called in a zero box, it does nothing: the
 *   fit stays owed.
 * - **The floor and the ceiling follow the box**, on every call in a real one: the floor is "one
 *   step and a half out from the body's framing at this size", so a pane that grew or shrank while
 *   hidden has the right floor when shown. MapLibre clamps the camera to a moved floor; nothing else
 *   moves it.
 * - **The camera is framed once per body** — the first time the body is drawn in a real box. Once
 *   framed, a hide and a show, a resize, a pan or a zoom never frame it again: the operator's camera
 *   is theirs. A new body (new bounds) is owed a frame afresh; a re-created map for the same body
 *   (a theme switch) keeps the view the shell restored.
 *
 * `framed` holds the bounds last framed; the caller keeps it across re-created maps.
 */

/** What framing needs of a map: its container's box, and the camera's writes. */
export interface FramableMap {
  getContainer(): Pick<HTMLElement, 'clientWidth' | 'clientHeight'>;
  setMinZoom(zoom: number): unknown;
  setMaxZoom(zoom: number): unknown;
  jumpTo(options: { center: [number, number]; zoom: number }): unknown;
}

/** A body's bounds as a key: another body is other bounds. */
export const boundsKeyOf = (b: BBoxLike): string =>
  `${b.minLng},${b.minLat},${b.maxLng},${b.maxLat}`;

/** How far out past the framing zoom the operator may go, and how close in. */
export const ZOOM_OUT_ROOM = 1.5;
export const MAX_ZOOM = 17;

/**
 * Frames `bbox` on `map` if its box is real (see above). Returns what it did: `'owed'` in a zero
 * box, `'framed'` the first time for these bounds, `'floor'` once framed already.
 */
export function frameInRealBox(
  map: FramableMap,
  bbox: BBoxLike,
  padding: Padding,
  framed: { current: string | null },
): 'owed' | 'framed' | 'floor' {
  const key = boundsKeyOf(bbox);
  const box = map.getContainer();
  if (!(box.clientWidth > 0 && box.clientHeight > 0)) {
    // A map for other bounds than the ones last framed now holds the camera (the shell re-creates
    // each map at the view the last one left, clamped to its own reach): coming back to those
    // bounds later is owed a frame afresh, not "framed already" on a camera that is the other's.
    if (framed.current !== key) framed.current = null;
    return 'owed';
  }
  const camera = fitCamera(bbox, box.clientWidth, box.clientHeight, padding);
  // The ceiling first, then a floor never above it: MapLibre throws on a floor over the ceiling,
  // and a pond small enough to frame past it would take the whole load down with it.
  map.setMaxZoom(MAX_ZOOM);
  map.setMinZoom(Math.min(MAX_ZOOM, Math.max(0, camera.zoom - ZOOM_OUT_ROOM)));
  if (framed.current === key) return 'floor';
  map.jumpTo({
    center: [camera.center.lng, camera.center.lat],
    zoom: Math.min(MAX_ZOOM, camera.zoom),
  });
  framed.current = key;
  return 'framed';
}
