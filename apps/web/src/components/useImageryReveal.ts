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
  IMAGERY_LAYER_ID,
  IMAGERY_SOURCE_ID,
  type ImageryMaskInput,
  revealShape,
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

export interface ImageryRevealOptions {
  map: maplibregl.Map | null;
  loaded: boolean;
  /** `null` ⇒ nothing to reveal. Both "no lake open" and "reveal off" arrive as `null`. */
  mask: ImageryMaskInput | null;
}

/**
 * Add the reveal while `mask` is non-null, refresh it when the map settles somewhere new, and tear it
 * down the moment it isn't.
 *
 * Refreshing on **`moveend`** and not on every frame is deliberate: one fetch per settled view is
 * fewer requests than the tile path made (every tile there was a dynamic render too), and it means a
 * drag costs nothing until the hand comes off.
 */
export function useImageryReveal({ map, loaded, mask }: ImageryRevealOptions): void {
  // The canvas outlives individual fetches, so a pan reuses it rather than churning a DOM node and a
  // GPU texture per view.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!map || !loaded || !mask) return;

    const shape = revealShape(mask, AERIAL_MASK_METERS.solid);
    // Fails closed (see `revealShape`): no shape ⇒ no photograph. An unclipped raster would show five
    // states of imagery with no way to tell which lake was selected.
    if (!shape) return;
    // Grown by the feather: the fade runs outward from the solid shape, so a box cropped to that
    // shape slices the gradient off with a straight line wherever the lake touches its own bbox.
    const revealBounds = aerialBoundsFor(shape, AERIAL_MASK_METERS.feather);

    const canvas = canvasRef.current ?? document.createElement('canvas');
    canvasRef.current = canvas;

    let disposed = false;
    let inFlight: HTMLImageElement | null = null;

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

      const image = new Image();
      // Required to read the pixels back off a canvas. USGS sends `access-control-allow-origin: *`;
      // without this the canvas is tainted and the `destination-in` composite throws a security error.
      image.crossOrigin = 'anonymous';
      inFlight = image;
      image.onload = () => {
        // A superseded fetch must not paint: a slow render for a view the skater has already left
        // would otherwise land after the fast one and put stale ground back on screen.
        if (disposed || inFlight !== image) return;
        canvas.width = size.width;
        canvas.height = size.height;
        drawClippedImagery({
          canvas,
          image,
          box,
          shape,
          featherMeters: AERIAL_MASK_METERS.feather,
        });

        const existing = map.getSource(IMAGERY_SOURCE_ID) as maplibregl.CanvasSource | undefined;
        if (existing) {
          existing.setCoordinates(imageryCorners(box));
          // The pair that actually re-uploads the texture — see the module note.
          existing.play();
          existing.pause();
          return;
        }
        map.addSource(IMAGERY_SOURCE_ID, {
          type: 'canvas',
          canvas,
          coordinates: imageryCorners(box),
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
          insertBeforeLayerId(map),
        );
      };
      image.onerror = () => {
        // A failed render leaves the previous image in place, which is more useful than a blank.
      };
      image.src = aerialExportUrl(box, size.width, size.height);
    };

    refresh();
    map.on('moveend', refresh);

    return () => {
      disposed = true;
      map.off('moveend', refresh);
      if (inFlight) inFlight.onload = null;
      // Layer before source, always: MapLibre throws when removing a source still in use, and a throw
      // inside a cleanup runs during React's commit — so it would take the next render with it.
      if (map.getLayer(IMAGERY_LAYER_ID)) map.removeLayer(IMAGERY_LAYER_ID);
      if (map.getSource(IMAGERY_SOURCE_ID)) map.removeSource(IMAGERY_SOURCE_ID);
    };
  }, [map, loaded, mask]);
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
