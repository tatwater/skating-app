import type maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useFreezeUpFrame } from '@/components/useFreezeUpFrame';
import { env } from '@/lib/env';
import { MAP_CONTAINER_CLASS, useMapCanvas } from '@/lib/mapCanvas';
import { type BBoxLike, fitCamera, type MapSurface, type Padding } from '@/lib/mapSurface';
import { DEMO_PMTILES_URL, MAP_FLAVORS } from '@/lib/waterMap';
import { type BodyMapMode, bodyMapPalette } from './bodyMapPalette';
import type { DrawnScene } from './bodyScene';
import { DOT_SOURCE, glLayers, LINE_SOURCE, OUTLINE_SOURCE } from './glLayers';

/**
 * The console map's own MapLibre instance (B03's recorded call: the skater map and the console map
 * are **two instances**, never one portaled between surfaces). Built on the shared shell
 * (`useMapCanvas`), so the basemap, the theme re-create and the teardown are the skater map's code.
 *
 * What bit the skater map, held here by construction:
 * - **The container is sized, never positioned** (`MAP_CONTAINER_CLASS`): MapLibre's stylesheet
 *   forces it `relative`, and an `absolute inset-0` box measures zero tall.
 * - **Every style write gates on `liveMap()`**, never on a state flag: a theme switch re-creates the
 *   map in the same commit that changes the palette, and a write to a map whose style hasn't loaded
 *   throws (B03 §8.5). `liveMap` is each effect's whole dependency, so a new map gets everything
 *   re-applied once it can take it.
 * - **No `idle` wait after a late source**: the sources are added inside `load`, and data is set on
 *   them directly; nothing here waits for `idle`.
 * - **The camera is held to the body**: it opens framed on the body inside the chrome's room, may
 *   zoom out one step past that and in to the street, and pans only within the body's reach.
 */

/** The room the chrome takes from the map when it frames the body: the rack, the dock, the key. */
export const FIT_PADDING: Padding = { top: 30, right: 70, bottom: 90, left: 175 };

/** How far out past the framing zoom the operator may go, and how close in. */
const ZOOM_OUT_ROOM = 1.5;
const MAX_ZOOM = 17;

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export interface BodyMapCanvas {
  /** The element MapLibre draws into: put it first in the pane. */
  ground: ReactNode;
  /** The camera and projections for the chrome; `null` until the map has loaded. */
  surface: MapSurface | null;
  zoomIn: () => void;
  zoomOut: () => void;
  atMinZoom: boolean;
  atMaxZoom: boolean;
}

/** A box `factor` of its own size larger on each side: how far the camera may wander. */
function reach(b: BBoxLike, factor = 1): [[number, number], [number, number]] {
  const dx = (b.maxLng - b.minLng) * factor;
  const dy = (b.maxLat - b.minLat) * factor;
  return [
    [b.minLng - dx, b.minLat - dy],
    [b.maxLng + dx, b.maxLat + dy],
  ];
}

export function useBodyMapCanvas({
  bbox,
  mode,
  drawn,
}: {
  bbox: BBoxLike;
  mode: BodyMapMode;
  drawn: DrawnScene;
}): BodyMapCanvas {
  const flavor = mode === 'light' ? MAP_FLAVORS.light : MAP_FLAVORS.dark;
  const palette = useMemo(() => bodyMapPalette(mode), [mode]);
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  const drawnRef = useRef(drawn);
  drawnRef.current = drawn;

  const center: [number, number] = [
    (bbox.minLng + bbox.maxLng) / 2,
    (bbox.minLat + bbox.maxLat) / 2,
  ];
  const { containerRef, liveMap } = useMapCanvas({
    pmtilesUrl: env.pmtilesUrl || DEMO_PMTILES_URL,
    worldPmtilesUrl: env.worldPmtilesUrl,
    flavor,
    maxBounds: reach(bbox),
    initialCenter: center,
    initialZoom: 11,
    navigationControl: false,
    onLoad: (map) => {
      map.addSource(OUTLINE_SOURCE, { type: 'geojson', data: drawnRef.current.outlines });
      map.addSource(LINE_SOURCE, { type: 'geojson', data: drawnRef.current.lines });
      map.addSource(DOT_SOURCE, { type: 'geojson', data: drawnRef.current.dots });
      for (const layer of glLayers(paletteRef.current)) map.addLayer(layer);
      // Framed inside the chrome's room, then held there: one step and a half out, no further.
      const canvas = map.getContainer();
      const camera = fitCamera(bbox, canvas.clientWidth, canvas.clientHeight, FIT_PADDING);
      map.jumpTo({ center: [camera.center.lng, camera.center.lat], zoom: camera.zoom });
      map.setMinZoom(Math.max(0, camera.zoom - ZOOM_OUT_ROOM));
      map.setMaxZoom(MAX_ZOOM);
    },
  });

  // The scene's data, on the live map only.
  useEffect(() => {
    const map = liveMap();
    if (!map) return;
    (map.getSource(OUTLINE_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
      drawn.outlines ?? EMPTY,
    );
    (map.getSource(LINE_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
      drawn.lines ?? EMPTY,
    );
    (map.getSource(DOT_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
      drawn.dots ?? EMPTY,
    );
  }, [drawn, liveMap]);

  // The paint, on the live map only — a mode change re-creates the map, and this re-applies.
  useEffect(() => {
    const map = liveMap();
    if (!map) return;
    for (const layer of glLayers(palette)) {
      if (!map.getLayer(layer.id) || !('paint' in layer) || !layer.paint) continue;
      for (const [prop, value] of Object.entries(layer.paint)) {
        map.setPaintProperty(layer.id, prop, value);
      }
    }
  }, [palette, liveMap]);

  useRaster(liveMap, drawn.raster);

  const surface = useLiveSurface(liveMap);

  const zoomIn = useCallback(() => liveMap()?.zoomIn(), [liveMap]);
  const zoomOut = useCallback(() => liveMap()?.zoomOut(), [liveMap]);
  const map = liveMap();
  const zoom = surface?.zoom ?? 0;
  return {
    ground: <div ref={containerRef} data-slot="body-map-canvas" className={MAP_CONTAINER_CLASS} />,
    surface,
    zoomIn,
    zoomOut,
    atMinZoom: map !== null && zoom <= map.getMinZoom() + 1e-6,
    atMaxZoom: map !== null && zoom >= map.getMaxZoom() - 1e-6,
  };
}

/**
 * The imagery pass (Imagery's lit pass) on the live map: the skater app's own reveal
 * (`useFreezeUpFrame` — two-lane leapfrog, no blank between dates, gated on its source's own
 * tiles), anchored under the basemap's roads and so under every line the console draws. The ref
 * it reads is the live map or nothing, re-read every render, so a re-created map is never written
 * to before it can take a write; while the map is down the hook forgets its lanes.
 */
function useRaster(liveMap: () => maplibregl.Map | null, raster: DrawnScene['raster']): void {
  const live = liveMap();
  const ref = useRef<maplibregl.Map | null>(live);
  ref.current = live;
  useFreezeUpFrame({
    mapRef: ref,
    loaded: live !== null,
    frame: raster === null ? null : { key: raster.key },
    season: raster?.season ?? null,
  });
}

/**
 * The live map as a {@link MapSurface}, re-read on every camera move and resize (at most once a
 * frame). Readiness comes from `liveMap`, so a re-created map is never read before it loads.
 */
function useLiveSurface(liveMap: () => maplibregl.Map | null): MapSurface | null {
  const [surface, setSurface] = useState<MapSurface | null>(null);
  useEffect(() => {
    const map = liveMap();
    if (!map) {
      setSurface(null);
      return;
    }
    let frame = 0;
    const read = () => {
      frame = 0;
      const canvas = map.getContainer();
      const c = map.getCenter();
      setSurface({
        width: canvas.clientWidth,
        height: canvas.clientHeight,
        zoom: map.getZoom(),
        center: { lng: c.lng, lat: c.lat },
        project: ([lng, lat]) => {
          const p = map.project([lng, lat]);
          return { x: p.x, y: p.y };
        },
        unproject: ({ x, y }) => {
          const ll = map.unproject([x, y]);
          return { lng: ll.lng, lat: ll.lat };
        },
      });
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    read();
    map.on('move', schedule);
    map.on('resize', schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      map.off('move', schedule);
      map.off('resize', schedule);
    };
  }, [liveMap]);
  return surface;
}
