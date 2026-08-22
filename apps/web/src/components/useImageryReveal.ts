/**
 * The aerial reveal, added and removed with the open lake (N6e / D146).
 *
 * ## The second architecture, and why the first one had to go
 *
 * v1 clipped by **covering**: a tiled raster drawn edge-to-edge, then the basemap's own colour
 * painted over everything outside the lake. It worked and it cost the map — a mask hides whatever is
 * beneath it, so the roads, the landuse and the labels went too. MapLibre has no way to clip a raster
 * to a polygon (no `clip` layer in 5.24; `raster-opacity` cannot vary within a layer), so covering is
 * the only option *as long as someone else owns the pixels*.
 *
 * v2 owns the pixels. One `exportImage` per view, drawn to a canvas, alpha punched in against the
 * lake's shape (`imageryCanvas`), handed to MapLibre as a **canvas source**. Nothing is painted over:
 * the entire vector basemap survives outside the reveal, the feather is a real gradient rather than
 * six stacked fills, and roads and labels draw *over* the photograph — which for reading an access
 * road is the point rather than a compromise.
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
  aerialBoundsFor,
  aerialExportUrl,
  type BBox,
  groundMetersPerPixel,
  IMAGERY_LAYER_ID,
  IMAGERY_SOURCE_ID,
  type ImageryMaskInput,
  revealShape,
  toMercatorBox,
} from '@skating/core';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import {
  drawClippedImagery,
  imageryCanvasSize,
  imageryCorners,
  imageryViewBox,
} from '../lib/imageryCanvas';

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
 * So: find `water`, then the first road layer *after* it. That puts the stack at
 *
 *   basemap fills incl. water → **photograph** → roads + labels → our pins, tracks, hazards
 *
 * and leaves buildings under the photograph, where a vector footprint drawn on a picture of that
 * building belongs.
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

/** The whole-lake image beneath the detail one. Its own source so either can update alone. */
const IMAGERY_OVERVIEW_SOURCE_ID = 'imagery-overview';
const IMAGERY_OVERVIEW_LAYER_ID = 'imagery-overview-raster';

/**
 * How large the overview may be.
 *
 * Half the service's cap, on purpose: the overview's job is **coverage**, and it is fetched for every
 * reveal including the many where the detail pass then supersedes it. 2,048 px is sharp enough to be
 * the only image a normal lake ever needs and cheap enough to be wasted on a big one.
 */
const OVERVIEW_MAX_PX = 2048;

/**
 * How much sharper a detail fetch must be before it is worth making.
 *
 * Below this the request buys a barely-visible improvement at the cost of a full render on a service
 * we do not own. 1.5× is roughly where a difference in sharpness becomes something a person notices
 * rather than something a measurement finds.
 */
const DETAIL_GAIN = 1.5;

/** How far the detail image fades into the overview at its box edge. See `edgeFadePx`. */
const DETAIL_EDGE_FADE_PX = 24;

/**
 * Clamp a size to `OVERVIEW_MAX_PX` on its **longer** side, aspect intact.
 *
 * `imageryCanvasSize` derives height from the box's Mercator span and clamps only at the service's
 * own 4,000 px ceiling, so the viewport it is handed bounds the *width* alone. On a lake as tall as
 * Champlain — whose box is nearly seven times higher than it is wide — that lets the overview reach
 * the full service cap: twice the pixel budget this pass is supposed to spend, on the one image that
 * exists to be coarse.
 */
function cappedOverviewSize(size: { width: number; height: number }): {
  width: number;
  height: number;
} {
  const longest = Math.max(size.width, size.height);
  if (longest <= OVERVIEW_MAX_PX) return size;
  const scale = OVERVIEW_MAX_PX / longest;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

export interface ImageryRevealOptions {
  map: maplibregl.Map | null;
  loaded: boolean;
  /** `null` ⇒ nothing to reveal. Both "no lake open" and "reveal off" arrive as `null`. */
  mask: ImageryMaskInput | null;
  /**
   * Called when a fetch starts and when it settles.
   *
   * A photograph over a big lake is a multi-megabyte render on somebody else's machine, and it
   * arrives *seconds* after the toggle. Without a signal the map simply sits there — and the second,
   * subtler case is a **fidelity** refresh: zooming in fires a sharper fetch while a usable but
   * coarser image is already on screen, so nothing appears broken and nothing appears to be
   * happening either.
   */
  onLoadingChange?: (loading: boolean) => void;
  /**
   * Skip the clip and show the photograph across the whole view (Workstream E).
   *
   * **The admin lake editor's mode, and the reason is the opposite of the skater's.** A skater is
   * looking *at* a lake, so the reveal stops where the lake does. An operator is correcting the
   * polygon that says where the lake is — so clipping the imagery to that polygon would hide the
   * evidence they need, which is the ground just past the line they are about to move.
   *
   * The shape still sets the *extent* fetched, so the editor does not ask USGS to render the region.
   */
  unmasked?: boolean;
}

/**
 * Add the reveal while `mask` is non-null, refresh it when the map settles somewhere new, and tear it
 * down the moment it isn't.
 *
 * Refreshing on **`moveend`** and not on every frame is deliberate: one fetch per settled view is
 * fewer requests than the tile path made (every tile there was a dynamic render too), and it means a
 * drag costs nothing until the hand comes off.
 */
export function useImageryReveal({
  map,
  loaded,
  mask,
  unmasked = false,
  onLoadingChange,
}: ImageryRevealOptions): void {
  // Canvases outlive individual fetches, so a pan reuses them rather than churning a DOM node and a
  // GPU texture per view.
  const detailCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overviewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!map || !loaded || !mask) return;

    const shape = revealShape(mask, AERIAL_MASK_METERS.solid);
    // Fails closed (see `revealShape`): no shape ⇒ no photograph. An unclipped raster would show five
    // states of imagery with no way to tell which lake was selected.
    if (!shape) return;
    // Grown by the feather: the fade runs outward from the solid shape, so a box cropped to that
    // shape slices the gradient off with a straight line wherever the lake touches its own bbox.
    const revealBounds = aerialBoundsFor(shape, AERIAL_MASK_METERS.feather);

    const detailCanvas = detailCanvasRef.current ?? document.createElement('canvas');
    detailCanvasRef.current = detailCanvas;
    const overviewCanvas = overviewCanvasRef.current ?? document.createElement('canvas');
    overviewCanvasRef.current = overviewCanvas;

    let disposed = false;
    let inFlight: HTMLImageElement | null = null;

    /**
     * Fetches still outstanding, so the signal clears when the **last** one settles.
     *
     * A boolean per load was the first shape and it was wrong in the ordinary case: the overview and
     * the detail image are in flight together, and the overview usually lands first, so whichever
     * settled first turned the spinner off over a lake still waiting for the sharp pass. That reads
     * as "finished" on a half-drawn photograph, which is the exact confusion `onLoadingChange` exists
     * to prevent.
     */
    let pending = 0;
    const settle = () => {
      pending = Math.max(0, pending - 1);
      if (pending === 0) onLoadingChange?.(false);
    };

    /** Fetch one box into one canvas, then add or update its source and layer. */
    const load = (options: {
      canvas: HTMLCanvasElement;
      box: BBox;
      size: { width: number; height: number };
      sourceId: string;
      layerId: string;
      edgeFadePx: number;
      /** Count this fetch in the loading signal — see `pending`. */
      announce: boolean;
      track: boolean;
    }) => {
      const { canvas, box, size, sourceId, layerId, edgeFadePx, announce, track } = options;
      if (announce) {
        pending++;
        onLoadingChange?.(true);
      }
      const image = new Image();
      // Required to read the pixels back off a canvas. USGS sends `access-control-allow-origin: *`;
      // without this the canvas is tainted and the `destination-in` composite throws a security error.
      image.crossOrigin = 'anonymous';
      if (track) inFlight = image;
      image.onload = () => {
        // Settled before anything else, superseded or not: a fetch that finished is a fetch that is
        // no longer pending, and leaving it counted would pin the signal on until the reveal closed.
        if (announce) settle();
        // A superseded fetch must not paint: a slow render for a view the skater has already left
        // would otherwise land after the fast one and put stale ground back on screen.
        if (disposed || (track && inFlight !== image)) return;
        canvas.width = size.width;
        canvas.height = size.height;
        drawClippedImagery({
          canvas,
          image,
          box,
          shape,
          // A zero feather with no clip is a plain photograph of the box — see `unmasked`.
          featherMeters: AERIAL_MASK_METERS.feather,
          clip: !unmasked,
          edgeFadePx,
        });

        const existing = map.getSource(sourceId) as maplibregl.CanvasSource | undefined;
        if (existing) {
          existing.setCoordinates(imageryCorners(box));
          // The pair that actually re-uploads the texture — see the module note.
          existing.play();
          existing.pause();
          return;
        }
        map.addSource(sourceId, {
          type: 'canvas',
          canvas,
          coordinates: imageryCorners(box),
          // Static between fetches; `play()`/`pause()` handles the updates.
          animate: false,
          attribution: AERIAL_ATTRIBUTION,
        } as never);
        map.addLayer(
          {
            id: layerId,
            type: 'raster',
            source: sourceId,
            paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 },
          },
          // The detail image goes above the overview and below the roads; the overview goes below
          // both — **and the anchor is always a layer id**, because the two fetches race and
          // `undefined` does not mean "wherever the other one is". It means the top of the style:
          // above the roads, above the pins, above the hazard layers the D81 toggle exists to keep
          // visible. So the detail always anchors on the basemap, and the overview anchors on the
          // detail whenever the detail landed first.
          layerId === IMAGERY_OVERVIEW_LAYER_ID && map.getLayer(IMAGERY_LAYER_ID)
            ? IMAGERY_LAYER_ID
            : insertBeforeLayerId(map),
        );
      };
      image.onerror = () => {
        // A failed render leaves the previous image in place, which is more useful than a blank —
        // but the spinner has to stop regardless, or a dead service reads as a permanent load.
        if (announce) settle();
      };
      image.src = aerialExportUrl(box, size.width, size.height);
    };

    // ── The overview: the whole lake, once, at whatever resolution fits the cap.
    //
    // **This is what stops the photograph ending in mid-lake.** The detail image is clipped to the
    // viewport, so zooming out on a big lake used to reveal its box edge as a hard rectangle across
    // the water until the next fetch landed — founder: *"the satellite tile just ends harshly without
    // covering the lake."* An overview underneath always covers the whole reveal, so a zoom-out
    // degrades in *sharpness* rather than in coverage, which is the failure a person forgives.
    //
    // For Champlain, 2,048 px across ~200 km is ~100 m/px — coarse, and exactly right for the job it
    // has, which is being there. For the great majority of lakes it is sharp enough to be the only
    // image needed, which is why the detail pass skips itself when it would not improve on it.
    const overviewSize = cappedOverviewSize(
      imageryCanvasSize(
        revealBounds,
        revealBounds,
        { width: OVERVIEW_MAX_PX, height: OVERVIEW_MAX_PX },
        1,
      ),
    );
    load({
      canvas: overviewCanvas,
      box: revealBounds,
      size: overviewSize,
      sourceId: IMAGERY_OVERVIEW_SOURCE_ID,
      layerId: IMAGERY_OVERVIEW_LAYER_ID,
      edgeFadePx: 0,
      announce: true,
      track: false,
    });

    const refresh = () => {
      if (disposed) return;
      const bounds = map.getBounds();
      const view: BBox = {
        minLat: bounds.getSouth(),
        maxLat: bounds.getNorth(),
        minLng: bounds.getWest(),
        maxLng: bounds.getEast(),
      };
      const box = imageryViewBox(view, revealBounds);
      // Reveal off screen: keep the last image rather than clearing, so panning back does not blink.
      if (!box) return;

      const container = map.getContainer();
      const size = imageryCanvasSize(
        box,
        view,
        { width: container.clientWidth, height: container.clientHeight },
        window.devicePixelRatio || 1,
      );

      // **Skip the detail pass when it would not beat the overview.** Zoomed out, the view box is
      // most of the reveal at a similar density, so fetching it is a second render of the same ground
      // — on a service where every request is compute. Comparing metres-per-pixel rather than box
      // size is what makes this hold for a small lake (where the overview is already sharp) and a
      // huge one (where it never is) with one rule.
      const detailMpp = groundMetersPerPixel(toMercatorBox(box), size.width);
      const overviewMpp = groundMetersPerPixel(toMercatorBox(revealBounds), overviewSize.width);
      if (detailMpp >= overviewMpp * DETAIL_GAIN) return;

      load({
        canvas: detailCanvas,
        box,
        size,
        sourceId: IMAGERY_SOURCE_ID,
        layerId: IMAGERY_LAYER_ID,
        // Its box stops mid-lake by design, so it has to blend into the overview beneath it.
        edgeFadePx: DETAIL_EDGE_FADE_PX,
        announce: true,
        track: true,
      });
    };

    refresh();
    map.on('moveend', refresh);

    return () => {
      disposed = true;
      onLoadingChange?.(false);
      map.off('moveend', refresh);
      if (inFlight) inFlight.onload = null;
      // Layers before sources, always: MapLibre throws when removing a source still in use, and a
      // throw inside a cleanup runs during React's commit — so it would take the next render with it.
      for (const layerId of [IMAGERY_LAYER_ID, IMAGERY_OVERVIEW_LAYER_ID]) {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
      }
      for (const sourceId of [IMAGERY_SOURCE_ID, IMAGERY_OVERVIEW_SOURCE_ID]) {
        if (map.getSource(sourceId)) map.removeSource(sourceId);
      }
    };
  }, [map, loaded, mask, unmasked, onLoadingChange]);
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
 * `HAZARD_LAYERS` is separate because it is not ours to decide (see `hazardsOverImagery`). Keeping
 * the two lists apart is the "one constant" promise from the phase doc.
 */
export const IMAGERY_REPLACED_LAYERS = [
  'water-fill',
  'sub-area-outline',
  'sub-area-label',
  'track-line',
  // D81 has said since N6b that contours go with the base map. Omitting this id in the first build
  // did not disable the rule, it just stopped implementing it — the isobaths kept drawing over the
  // photograph and read as nested rings in every shallow bay.
  'bathymetry-contours',
] as const;

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
