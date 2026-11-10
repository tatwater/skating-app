import type { LatLng } from '@skating/core';
import type maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useMemo, useRef } from 'react';
import { mapPalette } from '@/components/skater/map/mapPalette';
import { useTheme } from '@/components/theme-provider';
import { env } from '@/lib/env';
import { MAP_CONTAINER_CLASS, useMapCanvas } from '@/lib/mapCanvas';
import { DEMO_PMTILES_URL, INITIAL_CENTER, INITIAL_ZOOM, MAP_FLAVORS } from '@/lib/waterMap';
import {
  EMPTY,
  type InstrumentInput,
  lakeBounds,
  lakeFeatures,
  trackFeatures,
} from './instrumentFeatures';

export const INSTRUMENT_SOURCES = {
  lake: 'instrument-lake',
  track: 'instrument-track',
} as const;

/** Room around the lake, px: the key runs along the foot (30 px of it). */
const FIT_PADDING = { top: 24, right: 24, bottom: 54, left: 24 };

/**
 * The instrument's map (B03 §1.8): **a second, short-lived MapLibre instance**, created when the
 * report sheet opens and removed when it closes — never the region map, never portaled, so at most
 * two GL contexts are ever alive (the dimmed region map behind the scrim is the other). Built on the
 * shared `useMapCanvas` shell (protocol refcount, basemap style per theme, north up, compact
 * credits), framed on the one lake.
 *
 * A click on the map comes back as a coordinate (`onPick`) — where the sheet's sub-modes (where,
 * put-in, placing a photo) take their answer; their richer drawing is the second half's. The GL
 * draws the lake and the track; the marks are the region map's DOM marks, over it
 * (`InstrumentOverlay`), so the two maps speak one mark language.
 */
export default function InstrumentMapCanvas({
  input,
  onPick,
  onMap,
}: {
  input: InstrumentInput;
  onPick?: (coord: LatLng) => void;
  /** The live map once it has loaded, and `null` when it goes — for what draws over it (K). */
  onMap?: (map: maplibregl.Map | null) => void;
}) {
  const { resolvedTheme } = useTheme();
  const flavor = resolvedTheme === 'light' ? MAP_FLAVORS.light : MAP_FLAVORS.dark;
  const palette = useMemo(() => mapPalette(flavor), [flavor]);
  const bounds = lakeBounds(input.polygon);
  // The latest pick handler, without re-binding the map's click on every render.
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onMapRef = useRef(onMap);
  onMapRef.current = onMap;

  const { containerRef, liveMap } = useMapCanvas({
    pmtilesUrl: env.pmtilesUrl || DEMO_PMTILES_URL,
    worldPmtilesUrl: env.worldPmtilesUrl,
    flavor,
    initialCenter: INITIAL_CENTER,
    initialZoom: INITIAL_ZOOM,
    fitBounds: bounds,
    navigationControl: false,
    onLoad: (map) => {
      map.addSource(INSTRUMENT_SOURCES.lake, { type: 'geojson', data: EMPTY });
      map.addSource(INSTRUMENT_SOURCES.track, { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'instrument-lake-fill',
        type: 'fill',
        source: INSTRUMENT_SOURCES.lake,
        paint: { 'fill-color': palette.water.fill, 'fill-opacity': 1 },
      });
      map.addLayer({
        id: 'instrument-lake-line',
        type: 'line',
        source: INSTRUMENT_SOURCES.lake,
        paint: { 'line-color': palette.selected, 'line-width': 1.4 },
      });
      map.addLayer({
        id: 'instrument-track',
        type: 'line',
        source: INSTRUMENT_SOURCES.track,
        paint: { 'line-color': palette.track, 'line-width': 2, 'line-dasharray': [2, 2] },
      });
      map.on('click', (e: maplibregl.MapMouseEvent) =>
        onPickRef.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }),
      );
    },
  });

  const lake = useMemo(() => lakeFeatures(input.polygon), [input.polygon]);
  const track = useMemo(() => trackFeatures(input.track), [input.track]);
  const boundsKey = JSON.stringify(bounds);

  useEffect(() => {
    const map = liveMap();
    if (map === null) return;
    const set = (id: string, data: unknown) =>
      (map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(data as never);
    set(INSTRUMENT_SOURCES.lake, lake);
    set(INSTRUMENT_SOURCES.track, track);
  }, [liveMap, lake, track]);

  useEffect(() => {
    onMapRef.current?.(liveMap());
    return () => onMapRef.current?.(null);
  }, [liveMap]);

  // A lake picked after the map loaded: frame it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: bounds compare by their serialized key.
  useEffect(() => {
    const map = liveMap();
    if (map === null || bounds === null) return;
    map.fitBounds(bounds, { padding: FIT_PADDING, animate: false });
  }, [liveMap, boundsKey]);

  return <div ref={containerRef} data-slot="instrument-canvas" className={MAP_CONTAINER_CLASS} />;
}
