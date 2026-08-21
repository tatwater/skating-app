/**
 * The aerial reveal, added and removed with the open lake (N6e / D146).
 *
 * Its own module rather than a fourteenth effect in `MapView`, because it owns a source, a raster
 * layer, a variable number of mask layers and their teardown — and because the layer *order* it
 * establishes is the whole feature. Read `imageryMask.ts` first; the geometry decisions are there and
 * this file is the MapLibre half.
 *
 * ## The stack, bottom to top, and why it is this way round
 *
 *   1. **the raster** — inserted *beneath the water fill*, so it sits under everything we draw
 *   2. **the mask layers** — outermost buffer first, hugging the shape last, alpha accumulating inward
 *   3. everything already on the map — pins, tracks, hazards, labels
 *
 * The masks go **above the raster and below the app's own layers**, which is the only arrangement
 * that works: above the app layers they would grey out the put-in pins the reveal exists to show;
 * below the raster they would do nothing at all.
 *
 * ## What it deliberately does not do
 *
 * **It never touches the base map.** D146's whole point is that the vector style is untouched — so
 * there is no style branch here, no label filtering, and no attribution swap. The photograph is a
 * patch laid over the map, and closing the drawer removes the patch.
 */

import {
  aerialBoundsFor,
  aerialSourceSpec,
  buildImageryMask,
  FEATHER_STEPS,
  IMAGERY_LAYER_ID,
  IMAGERY_MASK_SOURCE_ID,
  IMAGERY_SOURCE_ID,
  type ImageryMaskInput,
  imageryMaskLayerId,
} from '@skating/core';
import type maplibregl from 'maplibre-gl';
import { useEffect } from 'react';

/**
 * The layer the raster is inserted beneath.
 *
 * `water-fill` is added at map init and is the lowest of our own layers, so anchoring here puts the
 * photograph under every single thing the app draws — which is what makes "the reveal cannot hide
 * content" structural rather than a rule someone has to remember when adding the next layer.
 */
const IMAGERY_BEFORE_LAYER_ID = 'water-fill';

/**
 * How long the photograph takes to arrive.
 *
 * Same reasoning the contours settled on: *fading in reads as a detail revealing itself; popping in
 * reads as a bug*. Shorter than the contour fade because a raster covers the lake rather than
 * decorating it — a slow fade on something this large reads as the map struggling.
 */
const IMAGERY_FADE_MS = 320;

export interface ImageryRevealOptions {
  map: maplibregl.Map | null;
  loaded: boolean;
  /** `null` ⇒ nothing to reveal. Both "no lake open" and "reveal off" arrive as `null`. */
  mask: ImageryMaskInput | null;
  /**
   * What the mask paints with — the basemap flavour's own land colour, never a hard-coded white.
   * See `basemapEarthColor`; a white mask on the dark map reads as a hole punched in it.
   */
  maskColor: string;
}

/**
 * Add the reveal while `mask` is non-null; tear it down the moment it isn't.
 *
 * The teardown is the part worth reading. A raster source left behind on drawer-close keeps its tiles
 * warm and keeps requesting them on pan — against a **dynamic renderer we do not own** (see
 * `aerialImagery.ts`), so a leak here is not a memory cost, it is a stream of compute requests to
 * USGS for a lake nobody is looking at. Hence removing layers before the source, unconditionally,
 * and on every dependency change rather than only on unmount.
 */
export function useImageryReveal({ map, loaded, mask, maskColor }: ImageryRevealOptions): void {
  useEffect(() => {
    if (!map || !loaded || !mask) return;

    const built = buildImageryMask(mask);
    // Fails closed (see `buildImageryMask`): no shape ⇒ no photograph. Revealing an unmasked raster
    // would show five states of imagery with no way to tell which lake was selected.
    if (!built) return;

    const bounds = aerialBoundsFor(built.shape);
    map.addSource(IMAGERY_SOURCE_ID, aerialSourceSpec(bounds));
    map.addLayer(
      {
        id: IMAGERY_LAYER_ID,
        type: 'raster',
        source: IMAGERY_SOURCE_ID,
        paint: {
          'raster-opacity': 0,
          'raster-opacity-transition': { duration: IMAGERY_FADE_MS, delay: 0 },
          // The photograph is the subject; nothing about it should be sharpened or dimmed for us.
          'raster-fade-duration': 0,
        },
      },
      map.getLayer(IMAGERY_BEFORE_LAYER_ID) ? IMAGERY_BEFORE_LAYER_ID : undefined,
    );

    // One GeoJSON source holding every ring, discriminated by a `step` property, rather than N
    // sources. N sources would mean N tile pipelines for geometry that is already in memory.
    map.addSource(IMAGERY_MASK_SOURCE_ID, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: built.rings.map((ring, index) => ({
          type: 'Feature' as const,
          geometry: ring.geometry,
          properties: { step: index },
        })),
      },
    });

    const maskLayerIds = built.rings.map((ring, index) => {
      const id = imageryMaskLayerId(index);
      map.addLayer(
        {
          id,
          type: 'fill',
          source: IMAGERY_MASK_SOURCE_ID,
          filter: ['==', ['get', 'step'], index],
          paint: {
            // The basemap's own paint, not a scrim: the mask is not a dimming effect over a
            // photograph, it is the map resuming where the photograph stops.
            'fill-color': maskColor,
            'fill-opacity': 0,
            'fill-opacity-transition': { duration: IMAGERY_FADE_MS, delay: 0 },
            'fill-antialias': true,
          },
        },
        map.getLayer(IMAGERY_BEFORE_LAYER_ID) ? IMAGERY_BEFORE_LAYER_ID : undefined,
      );
      return { id, opacity: ring.opacity };
    });

    // Reveal on the next frame so the transition has a starting value to animate *from*. Setting the
    // target opacity in the same tick as `addLayer` skips the transition entirely and pops.
    const raf = requestAnimationFrame(() => {
      if (!map.getLayer(IMAGERY_LAYER_ID)) return;
      map.setPaintProperty(IMAGERY_LAYER_ID, 'raster-opacity', 1);
      for (const layer of maskLayerIds) {
        map.setPaintProperty(layer.id, 'fill-opacity', layer.opacity);
      }
    });

    return () => {
      cancelAnimationFrame(raf);
      // Layers before sources, always: MapLibre throws on removing a source still in use, and a throw
      // in a cleanup runs during React's commit — so the leak would take the next render with it.
      for (const layer of maskLayerIds) {
        if (map.getLayer(layer.id)) map.removeLayer(layer.id);
      }
      if (map.getLayer(IMAGERY_LAYER_ID)) map.removeLayer(IMAGERY_LAYER_ID);
      if (map.getSource(IMAGERY_MASK_SOURCE_ID)) map.removeSource(IMAGERY_MASK_SOURCE_ID);
      if (map.getSource(IMAGERY_SOURCE_ID)) map.removeSource(IMAGERY_SOURCE_ID);
    };
    // `mask` is rebuilt by the caller only when the lake or its access changes; `FEATHER_STEPS` is a
    // constant and named here so a change to it cannot leave a stale ring count on screen in dev.
  }, [map, loaded, mask, maskColor]);
}

export { FEATHER_STEPS, IMAGERY_BEFORE_LAYER_ID, IMAGERY_FADE_MS };

/**
 * The layers the photograph replaces, and the ones the skater decides about.
 *
 * `REPLACED` is the A3 table in one array: the fill is redundant over a photograph of the water, and
 * the founder's call took sub-area outlines and skate paths with it. **`water-outline` is
 * deliberately absent** — the bright ring is what makes a masked patch read as *this lake* rather
 * than a hole in the map, and it is the one piece of cartography that gets *more* useful under
 * imagery, not less.
 *
 * `HAZARD_LAYERS` is separate because it is not ours to decide (see `hazardsOverImagery`). Keeping
 * the two lists apart is the "one constant" promise from the phase doc: flipping the hazard default,
 * or moving to dimmed-rather-than-hidden, touches this array and nothing else.
 */
export const IMAGERY_REPLACED_LAYERS = [
  'water-fill',
  'sub-area-outline',
  'sub-area-label',
  'track-line',
  // **The one this list was missing, and the first render found it.** D81 has said since N6b that
  // contours go with the base map — they are cartographic furniture and they fight a photograph for
  // legibility. Omitting the id here did not disable the rule, it just stopped implementing it: the
  // isobaths kept drawing over the imagery and read as nested rings in every shallow bay.
  //
  // It is the same id `contourLayer.ts` exports, spelled out rather than imported, because this
  // array is the A3 table and a reader checking the table against the code should not have to
  // resolve a constant to do it.
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
