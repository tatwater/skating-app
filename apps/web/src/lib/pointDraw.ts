import type { LatLng } from '@skating/core';

import type { ChordMap, ChordMapEvent } from './chordDraw';

/**
 * The point tool (B01-6b, D300): one mark placed by a click, or moved by a click elsewhere or by
 * dragging it. A landmark dropped or moved, a put-in or a lot placed, a known feature's center.
 *
 * - **A click places**, anywhere on the map; the cursor is a crosshair the whole time the tool is
 *   armed, so a click reads as an action and never as the start of a pan (the founder's call: the
 *   grab hand looked like panning).
 * - **The mark drags**: the grab cursor shows only over it, `grabbing` while it moves, and the map
 *   doesn't pan under the drag. The drop is the pick.
 * - **`snap`** moves where the pointer is to where the mark would land (a put-in to the shore), and
 *   the cursor's ghost shows that spot while hovering, as the chord's shore cursor does.
 * - Each pick is reported once, on the click or on the drag's release — never on every move.
 *
 * Typed against the same slice of the map the chord tool is (`ChordMap`), so a fake map drives it in
 * a test. No outside library; nothing to lazy-load.
 */

export interface PointDrawOptions {
  /** The mark already there (a landmark to move, a placed point); absent starts with none. */
  point?: LatLng;
  /** Where a pointer at `p` would put the mark; absent places it where the pointer is. */
  snap?: (p: LatLng) => LatLng;
  /** The mark's ink (the console's lit ink). */
  color: string;
  /**
   * A click, or a drag's release: the mark is here now, with the map's scale there (meters per
   * screen pixel) when the map can say — what a pick that means "the thing under the pointer" (a lot)
   * measures its reach in.
   */
  onPick: (point: LatLng, scale: PickScale) => void;
}

/** The map's scale at a pick: meters per screen pixel, absent when the map can't say. */
export interface PickScale {
  metersPerPixel?: number;
}

/** MapLibre's 512 px tiles: the equator's length over the world's width in pixels at a zoom. */
const EQUATOR_M = 40_075_016.686;
export function metersPerPixel(lat: number, zoom: number): number {
  return (EQUATOR_M * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
}

export interface PointDrawControl {
  /** Move the mark without reporting it (the caller's own state changed). */
  set: (point: LatLng | null) => void;
  destroy: () => void;
}

const MARK = 'point-tool-mark';
const GHOST = 'point-tool-ghost';
const SOURCES = [GHOST, MARK] as const;
const LAYERS = [GHOST, MARK] as const;

const feature = (p: LatLng): GeoJSON.Feature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
  properties: {},
});
const collection = (points: readonly LatLng[]): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: points.map(feature),
});

export function createPointDraw(
  map: ChordMap & { getZoom?: () => number },
  options: PointDrawOptions,
): PointDrawControl {
  const scaleAt = (p: LatLng): PickScale =>
    map.getZoom ? { metersPerPixel: metersPerPixel(p.lat, map.getZoom()) } : {};
  const snap = options.snap ?? ((p: LatLng) => p);
  let mark: LatLng | null = options.point ?? null;
  let dragging = false;
  let overMark = false;
  /** Where the mark was when the press on it began: a release that never moved it is no pick. */
  let pressedAt: LatLng | null = null;

  for (const id of SOURCES) map.addSource(id, { type: 'geojson', data: collection([]) });
  map.addLayer({
    id: GHOST,
    type: 'circle',
    source: GHOST,
    paint: {
      'circle-radius': 6,
      'circle-color': options.color,
      'circle-opacity': 0.35,
      'circle-stroke-color': options.color,
      'circle-stroke-width': 1.5,
    },
  });
  map.addLayer({
    id: MARK,
    type: 'circle',
    source: MARK,
    paint: {
      'circle-radius': 7,
      'circle-color': options.color,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
  });

  const setData = (id: string, points: readonly LatLng[]) =>
    map.getSource(id)?.setData(collection(points));
  const render = () => setData(MARK, mark ? [mark] : []);
  const cursor = (value: string) => {
    map.getCanvas().style.cursor = value;
  };
  const at = (e: ChordMapEvent): LatLng => ({ lat: e.lngLat.lat, lng: e.lngLat.lng });

  const onMove = (e: ChordMapEvent) => {
    const spot = snap(at(e));
    if (dragging) {
      mark = spot;
      render();
      return;
    }
    // The ghost shows where a click would land; over the mark itself, the mark is the target.
    setData(GHOST, overMark ? [] : [spot]);
  };
  const onClick = (e: ChordMapEvent) => {
    if (overMark) return; // a press on the mark is a drag, not a place
    mark = snap(at(e));
    render();
    options.onPick(mark, scaleAt(mark));
  };
  const onMarkDown = (e: ChordMapEvent) => {
    e.preventDefault?.();
    dragging = true;
    pressedAt = mark;
    map.dragPan.disable();
    setData(GHOST, []);
    cursor('grabbing');
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    map.dragPan.enable();
    cursor(overMark ? 'grab' : 'crosshair');
    // A press on the mark released where it began is a click on it, not a move: reporting it would
    // save the point it already has (a landmark's move writes an edit for every pick).
    const moved =
      mark !== null &&
      (pressedAt === null || mark.lat !== pressedAt.lat || mark.lng !== pressedAt.lng);
    pressedAt = null;
    if (mark && moved) options.onPick(mark, scaleAt(mark));
  };
  const onEnterMark = () => {
    overMark = true;
    setData(GHOST, []);
    if (!dragging) cursor('grab');
  };
  const onLeaveMark = () => {
    overMark = false;
    if (!dragging) cursor('crosshair');
  };

  map.on('mousemove', onMove);
  map.on('click', onClick);
  map.on('mousedown', MARK, onMarkDown);
  map.on('mouseup', onUp);
  map.on('mouseenter', MARK, onEnterMark);
  map.on('mouseleave', MARK, onLeaveMark);
  cursor('crosshair');
  render();

  return {
    set: (point) => {
      mark = point;
      render();
    },
    destroy: () => {
      if (dragging) map.dragPan.enable();
      cursor('');
      map.off('mousemove', onMove);
      map.off('click', onClick);
      map.off('mousedown', MARK, onMarkDown);
      map.off('mouseup', onUp);
      map.off('mouseenter', MARK, onEnterMark);
      map.off('mouseleave', MARK, onLeaveMark);
      for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of SOURCES) map.removeSource(id);
    },
  };
}
