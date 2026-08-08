import type { BBox, LatLng } from '@skating/core';
import type maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useTheme } from 'next-themes';
import { useEffect, useRef } from 'react';
import { env } from '../../lib/env';
import { useMapCanvas } from '../../lib/mapCanvas';
import {
  boundsForBody,
  buildMapStyle,
  DEMO_PMTILES_URL,
  MAP_FLAVORS,
  SUB_AREA_PALETTE,
  subAreasToFeatureCollection,
  WATER_PALETTE,
  waterBodiesToFeatureCollection,
} from '../../lib/waterMap';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** What the editor draws: the lake, its bays, its put-ins, and its weather sample points. */
export interface LakeEditorData {
  body: { _id: string; name: string; type: string; polygon: GeoJSON.Geometry; bbox: BBox };
  subAreas: readonly {
    _id: string;
    waterBodyId: string;
    name: string;
    polygon: GeoJSON.Geometry;
    centroid: LatLng;
  }[];
  putIns: readonly { coord: LatLng; source: string }[];
  samplePoints: readonly LatLng[];
  /** A grid the operator is previewing but hasn't saved — drawn hollow, so it reads as a proposal. */
  suggestedPoints: readonly LatLng[];
  /** A shape being drawn or pasted, previewed before save. */
  draftPolygon: GeoJSON.Geometry | null;
}

/**
 * The lake editor's canvas (N2 / D61) — **one lake, and you cannot wander off it**.
 *
 * The camera lock is the feature, not a guard rail (Decision 5): `maxBounds` is the body's bbox plus
 * a margin and `minZoom` is the zoom that fits it, so every tool on the canvas has an unambiguous
 * subject. An operator who has been drawing bays for twenty minutes should not be able to save one
 * onto the next lake over because they panned while thinking — and the server would refuse that draw
 * anyway (Decision 10 clips to *this* parent), so without the lock the failure mode is silent
 * confusion rather than a caught mistake.
 *
 * Built on the shared shell (Decision 12), so the basemap, theming and teardown are the same code the
 * skater map runs. Everything below is what's different: no navigation control (the camera is
 * locked), no drawer routing, and layers for the things only an operator sees.
 */
export function LakeEditorMap({
  data,
  onMapClick,
  onReady,
}: {
  data: LakeEditorData;
  /** A click on the canvas — the sample-point placement tool consumes these. */
  onMapClick?: (coord: LatLng) => void;
  /** Hand the raw map up, so the lazy-loaded draw control can attach to it. */
  onReady?: (map: maplibregl.Map) => void;
}) {
  const { resolvedTheme } = useTheme();
  const flavor = resolvedTheme === 'dark' ? MAP_FLAVORS.dark : MAP_FLAVORS.light;
  const water = WATER_PALETTE[flavor];
  const bays = SUB_AREA_PALETTE[flavor];
  const pmtilesUrl = env.pmtilesUrl || DEMO_PMTILES_URL;

  const bounds = boundsForBody(data.body.bbox);
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const { containerRef, mapRef, loaded } = useMapCanvas({
    pmtilesUrl,
    worldPmtilesUrl: env.worldPmtilesUrl,
    flavor,
    // The editor keeps its fence: it is a tool for one lake, and Decision 5 says so.
    maxBounds: bounds,
    fitBounds: bounds,
    initialCenter: [
      (data.body.bbox.minLng + data.body.bbox.maxLng) / 2,
      (data.body.bbox.minLat + data.body.bbox.maxLat) / 2,
    ],
    initialZoom: 11,
    // No navigation control: the zoom buttons would invite the pan the lock exists to prevent, and
    // scroll-zoom inside the bounds is the only camera move this surface wants.
    navigationControl: false,
    onLoad: (map) => {
      map.addSource('editor-body', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'editor-body-fill',
        type: 'fill',
        source: 'editor-body',
        paint: { 'fill-color': water.fill, 'fill-opacity': 0.3 },
      });
      map.addLayer({
        id: 'editor-body-outline',
        type: 'line',
        source: 'editor-body',
        paint: { 'line-color': water.outline, 'line-width': 1.5 },
      });

      map.addSource('editor-sub-areas', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'editor-sub-area-fill',
        type: 'fill',
        source: 'editor-sub-areas',
        filter: ['!=', ['get', 'label'], true],
        paint: { 'fill-color': bays.outline, 'fill-opacity': 0.12 },
      });
      map.addLayer({
        id: 'editor-sub-area-outline',
        type: 'line',
        source: 'editor-sub-areas',
        filter: ['!=', ['get', 'label'], true],
        paint: { 'line-color': bays.outline, 'line-width': 1.5, 'line-dasharray': [3, 2] },
      });
      map.addLayer({
        id: 'editor-sub-area-label',
        type: 'symbol',
        source: 'editor-sub-areas',
        filter: ['==', ['get', 'label'], true],
        layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-allow-overlap': true },
        paint: {
          'text-color': bays.label,
          'text-halo-color': bays.halo,
          'text-halo-width': 1.2,
        },
      });

      // The draft: whatever is being drawn or pasted, before it's saved. Deliberately the loudest
      // thing on the canvas — an operator has to be able to see at a glance that this shape is *not*
      // yet stored, since the difference between a preview and a save is the whole risk here.
      map.addSource('editor-draft', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'editor-draft-fill',
        type: 'fill',
        source: 'editor-draft',
        paint: { 'fill-color': '#eab308', 'fill-opacity': 0.25 },
      });
      map.addLayer({
        id: 'editor-draft-outline',
        type: 'line',
        source: 'editor-draft',
        paint: { 'line-color': '#eab308', 'line-width': 2 },
      });

      map.addSource('editor-put-ins', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'editor-put-ins',
        type: 'circle',
        source: 'editor-put-ins',
        paint: {
          'circle-radius': 6,
          'circle-color': [
            'case',
            ['==', ['get', 'source'], 'official'],
            '#06b6d4',
            ['==', ['get', 'source'], 'hidden'],
            '#94a3b8',
            '#64748b',
          ],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });

      // Saved sample points read solid; a suggested grid reads hollow. Same layer, one paint
      // expression, so a half-accepted suggestion can't look identical to a saved one.
      map.addSource('editor-sample-points', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'editor-sample-points',
        type: 'circle',
        source: 'editor-sample-points',
        paint: {
          'circle-radius': 5,
          'circle-color': [
            'case',
            ['boolean', ['get', 'suggested'], false],
            'rgba(0,0,0,0)',
            '#a855f7',
          ],
          'circle-stroke-color': '#a855f7',
          'circle-stroke-width': 2,
        },
      });

      map.on('click', (e) => {
        onMapClickRef.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      });
      onReadyRef.current?.(map);
    },
  });

  const setData = (id: string, fc: GeoJSON.FeatureCollection) => {
    const source = mapRef.current?.getSource(id) as maplibregl.GeoJSONSource | undefined;
    source?.setData(fc);
  };

  useEffect(() => {
    if (!loaded) return;
    setData(
      'editor-body',
      waterBodiesToFeatureCollection([
        {
          _id: data.body._id,
          name: data.body.name,
          type: data.body.type,
          polygon: data.body.polygon,
        },
      ]),
    );
    // biome-ignore lint/correctness/useExhaustiveDependencies: setData reads mapRef.
  }, [loaded, data.body, setData]);

  useEffect(() => {
    if (!loaded) return;
    setData(
      'editor-sub-areas',
      subAreasToFeatureCollection(
        data.subAreas.map((s) => ({
          _id: s._id,
          waterBodyId: s.waterBodyId,
          name: s.name,
          polygon: s.polygon,
          centroid: s.centroid,
        })),
      ),
    );
    // biome-ignore lint/correctness/useExhaustiveDependencies: setData reads mapRef.
  }, [loaded, data.subAreas, setData]);

  useEffect(() => {
    if (!loaded) return;
    setData('editor-put-ins', {
      type: 'FeatureCollection',
      features: data.putIns.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.coord.lng, p.coord.lat] },
        properties: { source: p.source },
      })),
    });
    // biome-ignore lint/correctness/useExhaustiveDependencies: setData reads mapRef.
  }, [loaded, data.putIns, setData]);

  useEffect(() => {
    if (!loaded) return;
    setData('editor-sample-points', {
      type: 'FeatureCollection',
      features: [
        ...data.samplePoints.map((p) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
          properties: { suggested: false },
        })),
        ...data.suggestedPoints.map((p) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
          properties: { suggested: true },
        })),
      ],
    });
    // biome-ignore lint/correctness/useExhaustiveDependencies: setData reads mapRef.
  }, [loaded, data.samplePoints, data.suggestedPoints, setData]);

  useEffect(() => {
    if (!loaded) return;
    setData(
      'editor-draft',
      data.draftPolygon
        ? {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', geometry: data.draftPolygon, properties: {} }],
          }
        : EMPTY,
    );
    // biome-ignore lint/correctness/useExhaustiveDependencies: setData reads mapRef.
  }, [loaded, data.draftPolygon, setData]);

  // Labelled as a region rather than left as an anonymous div (D34): this canvas is the primary
  // content of the route, and a screen reader landing on an unlabelled full-page div has nothing to
  // announce. The tools beside it are the operable surface; this is the subject they act on.
  // A labelled `section` rather than an anonymous div (D34): this canvas is the primary content of
  // the route, and a screen reader landing on an unlabelled full-page div has nothing to announce.
  // The tools beside it are the operable surface; this is the subject they act on. MapLibre takes any
  // `HTMLElement` as its container, so the semantic element costs nothing.
  return (
    <section
      ref={containerRef}
      className="h-full w-full"
      data-testid="lake-editor-map"
      aria-label={`Editing map for ${data.body.name}`}
    />
  );
}

/** Re-exported so the route can build a style preview without importing the map lib itself. */
export { buildMapStyle };
