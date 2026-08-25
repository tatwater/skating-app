/**
 * Painting one archived pass onto the map (N6e §C2, D148).
 *
 * ## The client does almost nothing here, and that was the point of the archive
 *
 * A frame is a `.pmtiles` raster whose **alpha was baked server-side** — clipped to the lake, its
 * approach and its parking, with a 240 m feather already ramped in. So showing a date is adding a
 * raster source and removing the previous one. No canvas, no mask arithmetic, no per-body fetch, and
 * nothing to keep in step with the projection.
 *
 * That is the whole argument D148 made for owning an archive rather than metering an API, and it is
 * also why mobile can have this: `useImageryReveal` needs a `CanvasRenderingContext2D` that React
 * Native does not have, and this needs a URL.
 *
 * ## Swapping is remove-then-add, because a source's URL is immutable
 *
 * MapLibre offers no way to repoint a raster source, so scrubbing a date tears the source down and
 * builds another. The layer mounts at zero opacity and fades in once its *own* tiles report, so a
 * scrub does not flash the basemap between two photographs.
 *
 * ⚠ **The reveal is gated on `sourcedata` for this source id, never on `idle`.** A source added
 * after the map's `load` event can leave `idle` permanently un-fired — a gotcha this repo has already
 * paid for once on the bathymetry layer. Waiting for `idle` here would mean a frame that fetched
 * perfectly well and never became visible.
 */

import type { IndexedFrame } from '@skating/core';
import { archiveUrl, copernicusCredit } from '@skating/core';
import type maplibregl from 'maplibre-gl';
import { useEffect } from 'react';
import { env } from '../lib/env';
import { insertBeforeLayerId } from './useImageryReveal';

export const FREEZE_UP_SOURCE_ID = 'freeze-up-frame';
export const FREEZE_UP_LAYER_ID = 'freeze-up-frame-raster';

/** Long enough to read as a cross-fade, short enough not to feel like latency. */
const FADE_MS = 180;

/**
 * Mount the selected frame, and tear it down when the scrubber closes.
 *
 * `frame` is `null` whenever there is nothing to show — the reveal is off, the archive is not
 * configured, or no stop is landable — and each of those is an ordinary state rather than an error.
 */
export function useFreezeUpFrame({
  mapRef,
  loaded,
  frame,
  season,
}: {
  mapRef: { current: maplibregl.Map | null };
  loaded: boolean;
  frame: IndexedFrame | null;
  season: string | null;
}): void {
  const baseUrl = env.imageryArchiveUrl;
  const key = frame?.key ?? null;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !baseUrl || !key || !season) return;

    const url = `pmtiles://${archiveUrl(baseUrl, key)}`;
    map.addSource(FREEZE_UP_SOURCE_ID, {
      type: 'raster',
      url,
      // The cutter tiles at 512 and the frames are WEBP; saying so saves MapLibre a probe request and
      // stops it assuming the 256 default, which would draw every frame at half scale.
      tileSize: 512,
      // ⚠ **Copernicus' credit is required, and this is how it gets rendered.** `AttributionControl`
      // unions the `attribution` of every *active source*, so declaring it here makes the credit
      // appear the moment a frame mounts and disappear when it unmounts, with nothing to remember —
      // the same mechanism the basemap and the aerial reveal already use. A hand-composed credit
      // string elsewhere is the version that goes stale the first time someone adds a layer.
      attribution: copernicusCredit(season),
    });
    map.addLayer(
      {
        id: FREEZE_UP_LAYER_ID,
        type: 'raster',
        source: FREEZE_UP_SOURCE_ID,
        paint: {
          'raster-opacity': 0,
          'raster-opacity-transition': { duration: FADE_MS, delay: 0 },
          // ⚠ Off, and load-bearing. MapLibre's default resampling blends neighbouring tiles at
          // zoom boundaries, which on an alpha-masked frame smears the feather the cutter spent a
          // `gdal_proximity` pass computing — a soft edge turning into a soft *smudge*.
          'raster-fade-duration': 0,
        },
      },
      insertBeforeLayerId(map),
    );

    // Gate the fade on this source reporting, never on `idle` — see the module note.
    let revealed = false;
    const reveal = (event: maplibregl.MapSourceDataEvent) => {
      if (revealed || event.sourceId !== FREEZE_UP_SOURCE_ID || !event.isSourceLoaded) return;
      if (!map.getLayer(FREEZE_UP_LAYER_ID)) return;
      revealed = true;
      map.setPaintProperty(FREEZE_UP_LAYER_ID, 'raster-opacity', 1);
    };
    map.on('sourcedata', reveal);

    return () => {
      map.off('sourcedata', reveal);
      // Order matters: a source with a layer still attached throws on removal.
      if (map.getLayer(FREEZE_UP_LAYER_ID)) map.removeLayer(FREEZE_UP_LAYER_ID);
      if (map.getSource(FREEZE_UP_SOURCE_ID)) map.removeSource(FREEZE_UP_SOURCE_ID);
    };
    // `baseUrl` is inlined by Vite at build and cannot change within a session.
  }, [mapRef, loaded, key, season]);
}
