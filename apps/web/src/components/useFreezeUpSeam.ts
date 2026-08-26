/**
 * Drawing the hairline where two frames of one lake meet (N6e §C4).
 *
 * ## Why the line is drawn at all, when the rasters already abut
 *
 * Two alpha-masked frames meet with no gap, so the join is invisible — which is precisely the
 * problem. **A skater looking at a seamless picture reads it as one observation**, and it is two,
 * taken on two dates. The scrubber names both dates; this says *where* one stops and the other
 * starts, so the two labels have somewhere to point.
 *
 * ## Above the photographs, below everything that means something
 *
 * The seam is a statement about the imagery, so it goes over the imagery. It goes *under* pins,
 * tracks and hazards for the reason contours do: those are the product, and a divider explaining a
 * rendering decision must never occlude a warning.
 *
 * ⚠ **Only drawn for a real seam.** `seamLineFor` returns `null` where a frame covers the lake
 * outright, which is the common case — and a caller that fell back to something would be drawing a
 * line across a lake that has only ever been photographed once.
 */

import { seamFeature } from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import type maplibregl from 'maplibre-gl';
import { useEffect } from 'react';
import { insertBeforeLayerId } from './useImageryReveal';

export const FREEZE_UP_SEAM_SOURCE_ID = 'freeze-up-seam';
export const FREEZE_UP_SEAM_LAYER_ID = 'freeze-up-seam-line';

/**
 * A *hairline*, and the word is doing work.
 *
 * Wide enough to read as deliberate at any zoom a lake is looked at, narrow enough that it never
 * competes with the shoreline it runs beside — which is the outline §A3 says matters more once
 * imagery is on. A heavier line would read as a feature of the lake rather than of the picture.
 */
const SEAM_WIDTH_PX = 1.25;

export function useFreezeUpSeam({
  mapRef,
  loaded,
  footprint,
  body,
}: {
  mapRef: { current: maplibregl.Map | null };
  loaded: boolean;
  /** The *primary* frame's acquisition polygon — the one drawn on top, so its edge is the join. */
  footprint: Polygon | MultiPolygon | null;
  /** The lake, which is what clips the granule edge down to the part anyone can see. */
  body: Polygon | MultiPolygon | null;
}): void {
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !footprint || !body) return;

    const feature = seamFeature(footprint, body);
    if (!feature) return;

    map.addSource(FREEZE_UP_SEAM_SOURCE_ID, { type: 'geojson', data: feature });
    // The same anchor the frames use, so this lands *above* them — layers sharing a `beforeId` stack
    // in insertion order and the frames mounted first — while staying below the roads, labels, pins,
    // tracks and hazards that come after. A divider explaining a rendering decision must never
    // occlude a warning.
    map.addLayer(
      {
        id: FREEZE_UP_SEAM_LAYER_ID,
        type: 'line',
        source: FREEZE_UP_SEAM_SOURCE_ID,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          // White at partial opacity rather than a theme color: every palette in this app means
          // something — favourite gold, hazard red, the icy water ramp — and a divider that borrowed
          // one would be read as that thing. White over a photograph is legible on ice and on open
          // water alike, and says only "here".
          'line-color': '#ffffff',
          'line-opacity': 0.85,
          'line-width': SEAM_WIDTH_PX,
        },
      },
      insertBeforeLayerId(map),
    );

    return () => {
      if (map.getLayer(FREEZE_UP_SEAM_LAYER_ID)) map.removeLayer(FREEZE_UP_SEAM_LAYER_ID);
      if (map.getSource(FREEZE_UP_SEAM_SOURCE_ID)) map.removeSource(FREEZE_UP_SEAM_SOURCE_ID);
    };
  }, [mapRef, loaded, footprint, body]);
}
