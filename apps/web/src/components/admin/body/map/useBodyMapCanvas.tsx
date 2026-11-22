import type * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useFreezeUpFrame } from '@/components/useFreezeUpFrame';
import { env } from '@/lib/env';
import { MAP_CONTAINER_CLASS, useMapCanvas } from '@/lib/mapCanvas';
import type { BBoxLike, MapSurface, Padding } from '@/lib/mapSurface';
import { DEMO_PMTILES_URL, MAP_FLAVORS } from '@/lib/waterMap';
import { frameInRealBox } from './bodyMapFraming';
import { type BodyMapMode, bodyMapPalette } from './bodyMapPalette';
import type { DrawnScene } from './bodyScene';
import { DOT_SOURCE, glLayers, LINE_SOURCE, OUTLINE_SOURCE, rasterAnchor } from './glLayers';

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
 *   zoom out one step past that and in to the street, and pans only within the body's reach. A
 *   theme switch keeps the operator's own view; only a new body frames it again.
 * - **Framed only in a real box** (`frameInRealBox`): on a narrow page the map's pane can be hidden
 *   while it loads or is re-created, its container zero. The fit then waits — owed — and is paid on
 *   the first resize into a real box (MapLibre's own observer fires it as the pane is shown), once
 *   per body; the floor follows every real size. Run on load and on the live map's `resize`.
 */

/** The room the chrome takes from the map when it frames the body: the rack, the dock, the key. */
export const FIT_PADDING: Padding = { top: 30, right: 70, bottom: 90, left: 175 };

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
  padding = FIT_PADDING,
  reach: reachBox = null,
}: {
  bbox: BBoxLike;
  mode: BodyMapMode;
  drawn: DrawnScene;
  /** The room the chrome takes when the camera frames `bbox`: the console's rack, dock and key. */
  padding?: Padding;
  /**
   * Where the operator may pan, if wider than `bbox` (an Inbox embed framed tight on two points on
   * a big body): fenced to this box's reach, and free to zoom out far enough to see it whole.
   * Without one, the fence is the frame's.
   */
  reach?: BBoxLike | null;
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
  // The bounds the camera was last framed on. A theme switch re-creates the map with the operator's
  // own pan and zoom restored (`useMapCanvas`); only new bounds frame it again.
  const framedRef = useRef<string | null>(null);
  // The body framing reads, from a resize long after the render that set it.
  const bboxRef = useRef(bbox);
  bboxRef.current = bbox;
  const paddingRef = useRef(padding);
  paddingRef.current = padding;
  const reachRef = useRef(reachBox);
  reachRef.current = reachBox;
  const { containerRef, liveMap } = useMapCanvas({
    pmtilesUrl: env.pmtilesUrl || DEMO_PMTILES_URL,
    worldPmtilesUrl: env.worldPmtilesUrl,
    flavor,
    maxBounds: reach(reachBox ?? bbox),
    initialCenter: center,
    initialZoom: 11,
    navigationControl: false,
    onLoad: (map) => {
      map.addSource(OUTLINE_SOURCE, { type: 'geojson', data: drawnRef.current.outlines });
      map.addSource(LINE_SOURCE, { type: 'geojson', data: drawnRef.current.lines });
      map.addSource(DOT_SOURCE, { type: 'geojson', data: drawnRef.current.dots });
      for (const layer of glLayers(paletteRef.current)) map.addLayer(layer);
      // Framed inside the chrome's room, then held there: one step and a half out, no further —
      // if its box is real; a hidden pane's fit waits for the resize below.
      frameInRealBox(map, bboxRef.current, paddingRef.current, framedRef, reachRef.current);
    },
  });

  // A fit owed by a load in a zero box is paid on the first resize into a real one, and the floor
  // follows each real size. On the live map only; asked once at once, in case the box became real
  // between the load and this effect.
  useEffect(() => {
    const map = liveMap();
    if (!map) return;
    const reframe = () =>
      frameInRealBox(map, bboxRef.current, paddingRef.current, framedRef, reachRef.current);
    reframe();
    map.on('resize', reframe);
    return () => {
      map.off('resize', reframe);
    };
  }, [liveMap]);

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
        // Object.entries widens the keys of the typed paint spec to string.
        map.setPaintProperty(layer.id, prop as Parameters<typeof map.setPaintProperty>[1], value);
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
 * tiles), placed by the console's layer order (`MAP_BANDS`): over the body's fill, under the hazard
 * fields and every line — the photograph inside the shore, the shore drawn over it. The ref
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
    anchor: consoleRasterAnchor,
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

/**
 * Where a pass goes on the console's map: the layer contract's raster band. Read from the layers'
 * ids alone (`getLayersOrder`), never `getStyle()`, which serializes every layer and source on each
 * placement — and a scrub places a pass at every notch.
 */
function consoleRasterAnchor(map: maplibregl.Map): string | undefined {
  return rasterAnchor(map.getLayersOrder());
}
