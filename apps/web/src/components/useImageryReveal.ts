/**
 * The aerial reveal — **every body in the viewport, from one fetch** (N6e / D146).
 *
 * ## What changed, and the measurement that forced it
 *
 * v2 revealed the *selected* lake: two fetches (a whole-lake overview plus a viewport-clipped detail
 * pass), sized and positioned from the live camera. Two things were wrong with that.
 *
 * **The cartography did not match the photograph.** `IMAGERY_REPLACED_LAYERS` was hidden across the
 * whole style and every shoreline went white, but only one lake had a picture under it — so five
 * other lakes on screen lost their fill, their labels and their favourite gold for nothing. Founder:
 * *"turning on satellite imagery should show it for all bodies in the viewport."*
 *
 * **Every request was a cold render.** The bbox came from `map.getBounds()` and the size from
 * `clientWidth × devicePixelRatio`, so no two requests were ever the same URL. Measured against the
 * live service, that is the difference between 29.3 s and 0.08 s — see `imageryTiles`.
 *
 * v3 answers both with the same move: fetch **fixed grid cells covering the view**, composite them,
 * and punch the alpha against every revealed body at once. Cells repeat, so the CDN and our own store
 * can answer them; and clipping N shapes out of one canvas costs no more fetching than clipping one.
 *
 * ## Where it sits in the stack
 *
 *   basemap fills incl. water → **photograph** → basemap roads + labels → our pins, tracks, hazards
 *
 * The anchor is `water`, not "the first road layer" — see `insertBeforeLayerId` for why that
 * distinction cost a render.
 *
 * ## Updating the texture
 *
 * MapLibre's `CanvasSource.prepare()` only re-uploads when the canvas resized or the source is
 * "playing". Redrawing the canvas alone changes nothing on screen. `play()` then `pause()` is the
 * pair that works — `pause()` calls `prepare()` synchronously — so one redraw is one upload with no
 * animation loop left running.
 */

import {
  AERIAL_ATTRIBUTION,
  AERIAL_MASK_METERS,
  CONTOUR_LAYER_ID,
  fitGridLevel,
  gridResolution,
  IMAGERY_LAYER_ID,
  IMAGERY_SOURCE_ID,
  type ImageryMaskInput,
  type ImageryTile,
  mercatorXToLng,
  mercatorYToLat,
  revealShape,
  tileKey,
  tilesBounds,
  toMercatorBox,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { loadTile } from '../lib/imageryCache';
import { composeImagery, compositeCanvasSize, imageryCorners } from '../lib/imageryCanvas';

/**
 * The basemap layer the photograph is inserted beneath.
 *
 * **Anchored on `water`, and the first version's anchor was subtly wrong.** It took the first layer
 * whose id started with `roads`, on the reasonable assumption that roads come after water. In the
 * Protomaps order they do not — **`roads_runway` is index 11 and `water` is index 14** — so the
 * photograph was inserted below the basemap's own water fill, and the lake's polygon painted over the
 * imagery exactly inside the shoreline. The symptom was a photograph visible only as a fringe in the
 * buffer ring, which reads as the clip being wrong rather than the z-order.
 *
 * So: find `water`, then the first road layer *after* it. That leaves buildings under the photograph,
 * where a vector footprint drawn on a picture of that building belongs.
 *
 * Every step degrades rather than throws: no road layer after water ⇒ sit directly on top of water;
 * no `water` at all ⇒ the old behaviour; no style yet ⇒ append, which is v1's look and not a crash.
 */
function insertBeforeLayerId(map: maplibregl.Map): string | undefined {
  const layers = map.getStyle()?.layers ?? [];
  const waterIndex = layers.findIndex((layer) => layer.id === 'water');
  if (waterIndex >= 0) {
    const road = layers.slice(waterIndex + 1).find((layer) => layer.id.startsWith('roads'));
    if (road) return road.id;
    return layers[waterIndex + 1]?.id;
  }
  const anyRoad = layers.find((layer) => layer.id.startsWith('roads'));
  if (anyRoad) return anyRoad.id;
  return map.getLayer('water-fill') ? 'water-fill' : undefined;
}

/**
 * The map zoom below which no photograph is fetched.
 *
 * **A usefulness floor, not a cost one** — the grid's level-stepping already keeps a wide view to a
 * handful of cells, so a region-wide reveal is cheap. It is just not *worth* anything: at z11 a
 * viewport is ~40 km across, a cell resolves to tens of metres per pixel, and every lake on screen
 * would be a few pixels of green-grey. A skater reading that would reasonably conclude the imagery
 * is broken rather than that the zoom is wrong.
 *
 * z12 puts roughly 10–20 km across the viewport, which is where a shoreline starts having a shape
 * and a field starts being distinguishable from a wood.
 */
export const IMAGERY_MIN_ZOOM = 12;

/**
 * How many buffered reveal shapes to hold.
 *
 * A buffered lake is a polygon with as many vertices as the lake it came from, so this is a real
 * budget rather than a nicety once the reveal covers a viewport rather than a body. A few viewports'
 * worth, which is what a pan away and back needs.
 */
const MAX_CACHED_SHAPES = 200;

/** A body to reveal, with a stable key so its buffered shape can be cached across pans. */
export interface KeyedMask {
  /** The body's Convex `_id` — what the cartography filters on. Carried, never re-parsed from `key`. */
  id: string;
  key: string;
  mask: ImageryMaskInput;
}

export interface ImageryRevealOptions {
  map: maplibregl.Map | null;
  loaded: boolean;
  /** Every body to reveal. `null` or empty ⇒ nothing; both "reveal off" and "no bodies" arrive so. */
  masks: readonly KeyedMask[] | null;
  /**
   * Called when a fetch starts and when it settles.
   *
   * A photograph over new ground is a multi-second render on somebody else's machine. Without a
   * signal the map simply sits there — and the subtler case is a **fidelity** refresh, where zooming
   * in fires a sharper fetch while a usable coarser image is already on screen, so nothing appears
   * broken and nothing appears to be happening either.
   */
  onLoadingChange?: (loading: boolean) => void;
  /**
   * Skip the clip and show the photograph across the whole view (Workstream E).
   *
   * **The admin lake editor's mode, and the reason is the opposite of the skater's.** A skater is
   * looking *at* a lake, so the reveal stops where the lake does. An operator is correcting the
   * polygon that says where the lake is — so clipping the imagery to that polygon would hide the
   * evidence they need, which is the ground just past the line they are about to move.
   */
  unmasked?: boolean;
}

/**
 * Reveal every body in `masks` while the map sits above `IMAGERY_MIN_ZOOM`, refresh when it settles
 * somewhere new, and tear the whole thing down when there is nothing to show.
 *
 * Refreshing on **`moveend`** rather than per frame is deliberate: a drag costs nothing until the
 * hand comes off, and the grid means a short drag usually costs nothing at all because the cells it
 * lands on are the cells it started on.
 */
export function useImageryReveal({
  map,
  loaded,
  masks,
  unmasked = false,
  onLoadingChange,
}: ImageryRevealOptions): void {
  // The canvas outlives individual fetches, so a pan reuses it rather than churning a DOM node and a
  // GPU texture per view.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Buffered shapes are Turf work over thousands of vertices, and a viewport can hold fifty bodies —
  // but a body's geometry does not change while you look at it, so each is computed once per session
  // and keyed by the same string that decides whether the mask itself changed.
  //
  // **Bounded**, because "once per session" over a viewport-wide reveal is not a fixed set: every pan
  // brings new keys, and a session browsing the corpus would otherwise retain a buffered polygon per
  // body it ever passed over.
  const shapeCacheRef = useRef(new Map<string, Polygon | MultiPolygon | null>());
  /** The reveal set `refresh` reads, so a change of set redraws rather than re-mounting the layer. */
  const masksRef = useRef(masks);
  masksRef.current = masks;
  const refreshRef = useRef<(() => void) | null>(null);
  /** The set the last mount already drew, so the redraw effect below doesn't double up on it. */
  const drawnMasksRef = useRef<readonly KeyedMask[] | null>(null);

  const enabled = Boolean(map && loaded && masks && masks.length > 0);

  // ── The layer's lifetime. **Deliberately not keyed on `masks`.**
  //
  // A body entering the viewport must not take the photograph off screen. `masks` changes on
  // essentially every pan — a lake appearing in the answer is a new joined key — and with it in the
  // deps the cleanup ran each time, removing the source and the layer and leaving blank ground for as
  // long as the next cells took, which on a cold cell is half a minute. What the layer *shows* is the
  // effect below; this one owns only whether it exists at all.
  useEffect(() => {
    if (!map || !loaded || !enabled) return;

    const canvas = canvasRef.current ?? document.createElement('canvas');
    canvasRef.current = canvas;
    const shapeCache = shapeCacheRef.current;

    let disposed = false;
    /** The view this hook is currently fetching for; a later one supersedes it. */
    let generation = 0;
    /** The superseded view's fetches, so a pan stops paying for ground nobody is looking at. */
    let inFlight: AbortController | null = null;

    /** Every revealed body, buffered — cached, because this is the expensive half. */
    const shapesFor = (list: readonly KeyedMask[]): (Polygon | MultiPolygon)[] => {
      const shapes: (Polygon | MultiPolygon)[] = [];
      for (const { key, mask } of list) {
        if (!shapeCache.has(key)) {
          shapeCache.set(key, revealShape(mask, AERIAL_MASK_METERS.solid));
          // Insertion-ordered, so the first key is the oldest. A cap rather than a clear, because the
          // bodies about to be asked for again are the ones just added.
          while (shapeCache.size > MAX_CACHED_SHAPES) {
            const oldest = shapeCache.keys().next().value;
            if (oldest === undefined) break;
            shapeCache.delete(oldest);
          }
        }
        const shape = shapeCache.get(key);
        // `revealShape` fails closed and so does this: a body whose buffer failed is simply not
        // revealed, rather than revealing everything.
        if (shape) shapes.push(shape);
      }
      return shapes;
    };

    const refresh = async () => {
      if (disposed) return;
      const revealing = masksRef.current;
      if (!revealing || revealing.length === 0) return;

      // The usefulness floor. Leaving the last image up rather than clearing means a zoom out and
      // back does not blink — and the layers come down with the effect anyway when the reveal ends.
      //
      // ⚠ **Checked before the generation is claimed.** Bumping `generation` and then bailing orphans
      // whatever is in flight: it comes back, fails its own `mine !== generation` check, and never
      // reaches `onLoadingChange?.(false)` — so the pulse runs for ever over a lake nothing is being
      // fetched for. Every early exit above the claim, every exit below it settles the signal.
      if (map.getZoom() < IMAGERY_MIN_ZOOM) return;

      const bounds = map.getBounds();
      const view = toMercatorBox({
        minLat: bounds.getSouth(),
        maxLat: bounds.getNorth(),
        minLng: bounds.getWest(),
        maxLng: bounds.getEast(),
      });

      const container = map.getContainer();
      const devicePx = Math.max(1, container.clientWidth) * (window.devicePixelRatio || 1);
      // What the screen could actually resolve, in projected metres — the sharpness we ask the grid
      // for. It answers with the coarsest level that meets it, or a coarser one if that would cost
      // more cells than the service tolerates in parallel.
      const target = (view.maxX - view.minX) / devicePx;
      const { level, tiles } = fitGridLevel(view, target);
      const canvasBounds = tilesBounds(tiles);
      if (!canvasBounds) return;

      const mine = ++generation;
      // The concurrency cap is per *view*, and without this it was only ever per view: a drag fires a
      // `moveend` a second, and ten unabandoned views is forty parallel cold renders against a service
      // that starts answering 200-with-a-1-KB-body past about four. Superseding a view has to stop
      // paying for it.
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;

      onLoadingChange?.(true);
      // Every cell, concurrently — bounded by `AERIAL_MAX_TILES_PER_VIEW`, which is set from what the
      // renderer tolerates rather than from what the network would allow.
      const fetched = await Promise.all(
        tiles.map(async (tile: ImageryTile) => {
          const image = await loadTile(tile, tileKey(tile), controller.signal);
          return image ? { tile, image } : null;
        }),
      );

      // Superseded, or torn down, while the fetches were in flight. Drawing now would put ground the
      // skater has already left back on screen.
      if (disposed || mine !== generation) return;
      onLoadingChange?.(false);

      const present = fetched.filter((entry) => entry !== null);
      // Nothing arrived at all: keep whatever is on screen. A blank reveal is strictly worse than a
      // stale one, and this is also the shape a dead service takes.
      if (present.length === 0) return;

      const size = compositeCanvasSize(canvasBounds, gridResolution(level));
      canvas.width = size.width;
      canvas.height = size.height;
      composeImagery({
        canvas,
        tiles: present,
        bounds: canvasBounds,
        shapes: shapesFor(revealing),
        featherMeters: AERIAL_MASK_METERS.feather,
        clip: !unmasked,
      });

      const corners = imageryCorners({
        minLat: mercatorYToLat(canvasBounds.minY),
        maxLat: mercatorYToLat(canvasBounds.maxY),
        minLng: mercatorXToLng(canvasBounds.minX),
        maxLng: mercatorXToLng(canvasBounds.maxX),
      });
      const existing = map.getSource(IMAGERY_SOURCE_ID) as maplibregl.CanvasSource | undefined;
      if (existing) {
        existing.setCoordinates(corners);
        // The pair that actually re-uploads the texture — see the module note.
        existing.play();
        existing.pause();
        return;
      }
      map.addSource(IMAGERY_SOURCE_ID, {
        type: 'canvas',
        canvas,
        coordinates: corners,
        // Static between fetches; `play()`/`pause()` handles the updates.
        animate: false,
        attribution: AERIAL_ATTRIBUTION,
      } as never);
      map.addLayer(
        {
          id: IMAGERY_LAYER_ID,
          type: 'raster',
          source: IMAGERY_SOURCE_ID,
          paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 },
        },
        // **Always a layer id, never `undefined`.** `undefined` does not mean "wherever is sensible";
        // it means the top of the style — above the roads, above the pins, above the hazard layers
        // the D81 toggle exists to keep visible.
        insertBeforeLayerId(map),
      );
    };

    refreshRef.current = () => void refresh();
    drawnMasksRef.current = masksRef.current;
    void refresh();
    const onMoveEnd = () => void refresh();
    map.on('moveend', onMoveEnd);

    return () => {
      disposed = true;
      inFlight?.abort();
      refreshRef.current = null;
      onLoadingChange?.(false);
      map.off('moveend', onMoveEnd);
      // Layers before sources, always: MapLibre throws when removing a source still in use, and a
      // throw inside a cleanup runs during React's commit — so it would take the next render with it.
      if (map.getLayer(IMAGERY_LAYER_ID)) map.removeLayer(IMAGERY_LAYER_ID);
      if (map.getSource(IMAGERY_SOURCE_ID)) map.removeSource(IMAGERY_SOURCE_ID);
    };
  }, [map, loaded, enabled, unmasked, onLoadingChange]);

  // ── What is revealed, redrawn in place.
  //
  // The other half of keeping `masks` out of the effect above: a change of reveal set has to reach
  // the canvas, and this is the path that does it without the source and the layer going away first.
  useEffect(() => {
    if (drawnMasksRef.current === masks) return;
    drawnMasksRef.current = masks;
    refreshRef.current?.();
  }, [masks]);
}

/**
 * The layers the photograph replaces, and the ones the skater decides about.
 *
 * Much shorter than it was, and that is v2's doing: with the basemap intact underneath, **roads,
 * labels and landuse no longer need suppressing** — they draw over the photograph, which for finding
 * an access road is the feature. What remains is our own cartography, which a photograph of the water
 * genuinely does replace.
 *
 * **`water-outline` is deliberately absent** — the bright ring is what makes the revealed patch read
 * as *this lake* rather than a hole in the map, and it is the one piece of our cartography that gets
 * more useful under imagery, not less.
 *
 * ⚠ **A layer can only be hidden per body if its own features carry the body's `_id`, and most of
 * them do not.** `water-fill` carries `_id`; a sub-area carries its *own* `_id` and the parent's
 * `waterBodyId`; a track carries neither; a contour tile carries `bodyId`, which is the OSM
 * `externalId` rather than a Convex id. MapLibre's `in` answers `false` for a null needle rather than
 * throwing, so filtering all of them on `_id` fails **silently open** — the bay outlines, the labels,
 * the tracks and the isobaths all keep drawing over the photograph, which is the D81/A3 rule
 * unimplemented again. So the list is split by what the layer can actually be asked.
 *
 * `HAZARD_LAYERS` is separate because it is not ours to decide (see `hazardsOverImagery`). Keeping
 * the lists apart is the "one constant" promise from the phase doc.
 */
export interface ReplacedLayer {
  id: string;
  /** The feature property carrying the revealed body's Convex `_id`. */
  idProperty: string;
}

export const IMAGERY_REPLACED_LAYERS: readonly ReplacedLayer[] = [
  { id: 'water-fill', idProperty: '_id' },
  // A bay's own `_id` is a `subAreas` row and never matches a revealed body. `waterBodyId` is the
  // parent it is drawn inside, which is exactly the question being asked.
  { id: 'sub-area-outline', idProperty: 'waterBodyId' },
  { id: 'sub-area-label', idProperty: 'waterBodyId' },
];

/**
 * The replaced layers that are **already scoped to the open lake**, so they flip wholesale.
 *
 * Neither can be filtered per body — a track feature carries only its `opacity`, and a contour tile
 * carries the OSM `externalId` the archive was stamped with. Neither needs to be: both are only ever
 * drawn for the lake whose drawer is open, and that lake is in the reveal set by construction, so
 * "any body revealed ⇒ hide" is the same answer a per-feature filter would give.
 *
 * D81 has said since N6b that contours go with the base map. Omitting this id in the first build did
 * not disable the rule, it just stopped implementing it — the isobaths kept drawing over the
 * photograph and read as nested rings in every shallow bay.
 */
export const IMAGERY_REPLACED_WHOLE_LAYERS = ['track-line', CONTOUR_LAYER_ID] as const;

/**
 * The loading skeleton's layer and its rhythm.
 *
 * A **wash, not a spinner-on-the-lake**: it never fully hides the water and it moves slowly enough to
 * read as breathing rather than flashing. 900 ms with the paint transition doing the easing lands
 * near a resting breath, which is the pace that says *working* without saying *stuck*.
 *
 * The floor is deliberately above zero — a pulse that reaches nothing reads as a flicker, which is
 * the exact thing the once-a-second teardown bug looked like.
 */
export const IMAGERY_LOADING_LAYER_ID = 'imagery-loading';
export const IMAGERY_PULSE_MS = 900;
export const IMAGERY_PULSE_MIN = 0.08;
export const IMAGERY_PULSE_MAX = 0.26;

export const IMAGERY_HAZARD_LAYERS = [
  'hazard-fill',
  'hazard-outline-provisional',
  'hazard-outline-confirmed',
] as const;

/** Flip a set of layers' visibility, skipping any the style has not added yet. */
export function setLayersVisible(
  map: maplibregl.Map,
  layerIds: readonly string[],
  visible: boolean,
): void {
  for (const id of layerIds) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

/**
 * Hide a set of layers **for the revealed bodies only**, leaving every other feature drawn.
 *
 * The fix for v2's worst cosmetic bug: suppression was a `visibility` flip, which is per *layer*, so
 * revealing one pond stripped the fill, the sub-area labels and the tracks from every lake on screen
 * — and a favourited lake elsewhere in the viewport silently lost its gold. A filter is per
 * *feature*, so the photograph replaces exactly the cartography it covers.
 *
 * `ids` empty ⇒ the filter is removed rather than set to a never-matching expression, so a layer
 * returns to precisely the filter the style gave it.
 *
 * ⚠ **Only for layers whose style filter is static.** The base filter is captured once and re-applied
 * on every call, so a layer whose *own* filter changes over time would have the stale one written
 * back over it — which is precisely why the contour layer, whose filter names the open lake, is in
 * `IMAGERY_REPLACED_WHOLE_LAYERS` and not here.
 */
export function setLayersHiddenForBodies(
  map: maplibregl.Map,
  layers: readonly ReplacedLayer[],
  ids: readonly string[],
  baseFilters: Map<string, unknown>,
): void {
  for (const { id, idProperty } of layers) {
    if (!map.getLayer(id)) continue;
    // The style's own filter is captured once and re-composed, never replaced: `sub-area-label`
    // filters on `label`, and dropping that would draw every sub-area's outline as a label.
    if (!baseFilters.has(id)) baseFilters.set(id, map.getFilter(id) ?? null);
    const base = baseFilters.get(id) ?? null;
    if (ids.length === 0) {
      map.setFilter(id, (base ?? null) as never);
      continue;
    }
    const notRevealed = ['!', ['in', ['get', idProperty], ['literal', [...ids]]]];
    map.setFilter(id, (base ? ['all', base, notRevealed] : notRevealed) as never);
  }
}
