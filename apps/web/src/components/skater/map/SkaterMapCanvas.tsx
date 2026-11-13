import { isRegionOffscreen } from '@skating/core';
import { useNavigate } from '@tanstack/react-router';
import type maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapModeBar } from '@/components/kit/map-controls';
import { MapKey } from '@/components/kit/map-key';
import { toast } from '@/components/kit/toast';
import { useTheme } from '@/components/theme-provider';
import {
  CONTOUR_LAYER_ID,
  CONTOUR_OPACITY,
  CONTOUR_SOURCE_ID,
  CONTOUR_SOURCE_LAYER,
  type ContourFeatureProperties,
  contourAttribution,
  contourBodyKey,
  contourCredit,
  contourFilter,
  formatContourCredit,
} from '@/lib/contourMap';
import {
  BANDS_LAYER_ID,
  BANDS_OPACITY,
  BANDS_SOURCE_LAYER,
  type BandFeatureProperties,
  type LegendBand,
  lakeBands,
  sameBands,
} from '@/lib/depthBands';
import { env } from '@/lib/env';
import type { Rect } from '@/lib/lakeLabelLayout';
import { MAP_CONTAINER_CLASS, useMapCanvas } from '@/lib/mapCanvas';
import {
  boundsForBody,
  DEMO_PMTILES_URL,
  frameForCoord,
  INITIAL_CENTER,
  INITIAL_ZOOM,
  MAP_FLAVORS,
} from '@/lib/waterMap';
import { effectiveMapSpec, useSkaterMapStore } from '@/stores/skaterMapStore';
import { panelLinkState } from '../panels/panelNavigation';
import { MapDockControls } from './MapDockControls';
import { MapMarksLayer } from './MapMarksLayer';
import { hitProperty, isUnlistedWater, type RenderedHit, skaterMapKeyKinds } from './mapDerive';
import {
  addSkaterLayers,
  HAZARD_FILL_LAYER,
  LAYER_GROUPS,
  matchId,
  OVERLAY_SOURCES,
  SOURCES,
  SUB_AREA_SCRIM_LAYER,
  SUB_AREA_SELECTED_LAYER,
  WATER_FILL_LAYER,
  WATER_HOVER_LAYER,
  WATER_SELECTED_LAYER,
  waterFillColor,
  waterFillOpacity,
} from './mapLayers';
import { mapPalette } from './mapPalette';
import {
  diffMapSpec,
  fitKey,
  type MapFit,
  type MapInteractions,
  type MapSpec,
  type MapSpecOp,
  mapClickAction,
  resolveMapSpec,
} from './mapSpec';
import { activeMapHandlers, publishMapInstance, useLatest } from './useMapSpec';
import { useSkaterMapData, type ViewportQuery } from './useSkaterMapData';

/**
 * The persistent region map's canvas: one MapLibre instance for the life of the skater layout.
 * Loaded lazily by `SkaterMap` the first time a view shows the map, and never unmounted after.
 *
 * It applies the spec in force by diffing it against the last one applied (`diffMapSpec`); the data
 * effects below push what the reads return into the sources. A theme switch re-creates the instance
 * (the basemap style is per flavor, inherited from `useMapCanvas`), and then the whole spec is applied
 * again from nothing — except the fit, which already ran once for its key.
 */

/** How long the camera must rest before it's written to the store (and so to sessionStorage). */
export const CAMERA_WRITE_DELAY_MS = 300;
/** How often the labels' "today" is re-read against the clock. */
export const LABEL_CLOCK_MS = 60_000;
/**
 * The two depth layers the canvas scopes to the open lake and fades in, bottom to top: two layers of
 * the one contour archive. A lake can have lines and no bands (an older archive, a lake the band
 * pipeline dropped), and its lines still draw.
 */
const DEPTH_LAYERS = [
  {
    layer: BANDS_LAYER_ID,
    sourceLayer: BANDS_SOURCE_LAYER,
    opacityProperty: 'fill-opacity',
    opacity: BANDS_OPACITY,
  },
  {
    layer: CONTOUR_LAYER_ID,
    sourceLayer: CONTOUR_SOURCE_LAYER,
    opacityProperty: 'line-opacity',
    opacity: CONTOUR_OPACITY,
  },
] as const;

/** Room around a framed lake, px: clear of the dock on the right and the legend on the left. */
export const FIT_PADDING = { top: 72, bottom: 72, left: 72, right: 88 };

function setVisibility(map: maplibregl.Map, ids: readonly string[], on: boolean) {
  for (const id of ids) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
}

function setInteractions(map: maplibregl.Map, interactions: MapInteractions) {
  const toggle = (handler: { enable(): void; disable(): void }, on: boolean) =>
    on ? handler.enable() : handler.disable();
  toggle(map.dragPan, interactions.pan);
  toggle(map.keyboard, interactions.pan || interactions.zoom);
  toggle(map.scrollZoom, interactions.zoom);
  toggle(map.doubleClickZoom, interactions.zoom);
  toggle(map.boxZoom, interactions.zoom);
  toggle(map.touchZoomRotate, interactions.zoom);
  map.getCanvas().style.cursor = interactions.click === 'capture' ? 'crosshair' : '';
}

export default function SkaterMapCanvas() {
  const navigate = useNavigate();
  const specs = useSkaterMapStore((s) => s.specs);
  const toggles = useSkaterMapStore((s) => s.layers);
  const hoveredBodyId = useSkaterMapStore((s) => s.hoveredBodyId);
  const spec = useMemo(() => resolveMapSpec(effectiveMapSpec(specs), toggles), [specs, toggles]);
  const specRef = useLatest(spec);

  const { resolvedTheme } = useTheme();
  const flavor = resolvedTheme === 'light' ? MAP_FLAVORS.light : MAP_FLAVORS.dark;
  const palette = useMemo(() => mapPalette(flavor), [flavor]);
  const contourArchive = env.bathymetryPmtilesUrl;

  const [query, setQuery] = useState<ViewportQuery | null>(null);
  // The labels' clock. This canvas lives for the whole session, so a `now` taken once at mount would
  // keep calling yesterday's report "today" past midnight (D3: never fresher than it is).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), LABEL_CLOCK_MS);
    return () => clearInterval(id);
  }, []);
  const data = useSkaterMapData({ query, spec, now });
  const contourCreditLine = useSkaterMapStore((s) => s.contourCredit);

  const initialCamera = useSkaterMapStore.getState().camera;
  const cameraTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [zoomBounds, setZoomBounds] = useState({ atMax: false, atMin: false });

  const { containerRef, mapRef, loaded, liveMap } = useMapCanvas({
    pmtilesUrl: env.pmtilesUrl || DEMO_PMTILES_URL,
    worldPmtilesUrl: env.worldPmtilesUrl,
    flavor,
    initialCenter: initialCamera?.center ?? INITIAL_CENTER,
    initialZoom: initialCamera?.zoom ?? INITIAL_ZOOM,
    navigationControl: false,
    // The contours' credit rides in the map's own ⓘ beside the basemap's, while they're drawn.
    extraAttribution: contourAttribution(contourCreditLine),
    onViewport: (view) => {
      setQuery(view);
      const store = useSkaterMapStore.getState();
      const away = isRegionOffscreen(view.viewport);
      if (store.awayFromRegion !== away) store.setAwayFromRegion(away);
    },
    onLoad: (map) => {
      addSkaterLayers(map, palette, contourArchive);
      bindHandlers(map);
    },
  });

  // ── Handlers, bound once per instance; they read the spec at event time ───────────────────
  function bindHandlers(map: maplibregl.Map) {
    // A click's canvas point, in the viewport: where a dialog about it can open.
    const screenOf = (point: { x: number; y: number }) => {
      const box = map.getContainer().getBoundingClientRect();
      return { x: box.left + point.x, y: box.top + point.y };
    };
    const hitsAt = (point: maplibregl.PointLike): RenderedHit[] =>
      map.queryRenderedFeatures(point).map((f) => ({
        source: f.source,
        sourceLayer: f.sourceLayer,
        layerId: f.layer?.id,
        properties: f.properties,
      }));
    map.on('click', (e) => {
      const current = specRef.current;
      const hits = hitsAt(e.point);
      const ours = (layer: string) => hits.filter((h) => h.layerId === layer);
      const action = mapClickAction(current.interactions, {
        hazardId: hitProperty(ours(HAZARD_FILL_LAYER), 'hazardId'),
        bodyId: hitProperty(ours(WATER_FILL_LAYER), '_id'),
        onUnlistedWater: isUnlistedWater(hits),
      });
      const coord = { lng: e.lngLat.lng, lat: e.lngLat.lat };
      switch (action.kind) {
        case 'capture':
          activeMapHandlers().onCapture?.(coord);
          break;
        case 'hazard':
          navigate({
            to: '/hazard/$id',
            params: { id: action.hazardId },
            state: panelLinkState('map'),
          });
          break;
        case 'body':
          navigate({ to: '/water/$id', params: { id: action.bodyId } });
          break;
        case 'request':
          useSkaterMapStore.getState().setPendingMapClick({ ...coord, screen: screenOf(e.point) });
          break;
        case 'none':
          break;
      }
    });
    // Right-click works too (Review 2): anywhere the view takes requests, the request flow resolves
    // the coordinate itself, a dormant body under it included.
    map.on('contextmenu', (e) => {
      const current = specRef.current.interactions;
      if (!current.requestLake || current.click !== 'navigate') return;
      e.preventDefault();
      useSkaterMapStore.getState().setPendingMapClick({
        lng: e.lngLat.lng,
        lat: e.lngLat.lat,
        screen: screenOf(e.point),
      });
    });
    map.on('mousemove', WATER_FILL_LAYER, (e) => {
      const id = e.features?.[0]?.properties?._id;
      const store = useSkaterMapStore.getState();
      const next = typeof id === 'string' ? id : null;
      if (store.hoveredBodyId !== next) store.setHoveredBodyId(next);
      if (specRef.current.interactions.click === 'navigate')
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', WATER_FILL_LAYER, () => {
      useSkaterMapStore.getState().setHoveredBodyId(null);
      if (specRef.current.interactions.click === 'navigate') map.getCanvas().style.cursor = '';
    });
    // Camera → store, once it rests: this session's view, never the URL (D242).
    map.on('moveend', () => {
      if (cameraTimer.current) clearTimeout(cameraTimer.current);
      cameraTimer.current = setTimeout(() => {
        const c = map.getCenter();
        useSkaterMapStore.getState().setCamera({ center: [c.lng, c.lat], zoom: map.getZoom() });
      }, CAMERA_WRITE_DELAY_MS);
      setZoomBounds({
        atMax: map.getZoom() >= map.getMaxZoom(),
        atMin: map.getZoom() <= map.getMinZoom(),
      });
    });
  }

  useEffect(
    () => () => {
      if (cameraTimer.current) clearTimeout(cameraTimer.current);
    },
    [],
  );

  // The instance, for the two imperative tools allowed to hold it (see `useMapInstance`). They add
  // their own sources, so they get the map only while its style can take one.
  useEffect(() => {
    const live = liveMap();
    publishMapInstance(live, live !== null);
    return () => publishMapInstance(null, false);
  }, [liveMap]);

  // ── The spec, applied as a diff ──────────────────────────────────────────────────────────────
  const appliedRef = useRef<MapSpec | null>(null);
  const lastFitKey = useRef<string | null>(null);
  const [pendingFit, setPendingFit] = useState<MapFit | null>(null);

  useEffect(() => {
    const map = liveMap();
    if (!map) {
      appliedRef.current = null;
      return;
    }
    const ops: MapSpecOp[] = diffMapSpec(appliedRef.current, spec);
    for (const op of ops) {
      switch (op.kind) {
        case 'visible':
          // A pane that was hidden may have been resized while it was.
          if (op.visible) map.resize();
          break;
        case 'focus':
          map.setFilter(WATER_SELECTED_LAYER, matchId(op.focus?.bodyId) as never);
          map.setFilter(SUB_AREA_SELECTED_LAYER, [
            'all',
            ['!=', ['get', 'label'], true],
            matchId(op.focus?.subAreaId),
          ] as never);
          map.setFilter(
            SUB_AREA_SCRIM_LAYER,
            (op.focus?.subAreaId
              ? [
                  'all',
                  ['!=', ['get', 'label'], true],
                  ['==', ['get', 'waterBodyId'], op.focus.bodyId],
                  ['!=', ['get', '_id'], op.focus.subAreaId],
                ]
              : matchId(null)) as never,
          );
          break;
        case 'layer':
          setVisibility(map, LAYER_GROUPS[op.layer], op.on);
          break;
        case 'interaction':
          setInteractions(map, op.interactions);
          break;
        case 'fit': {
          const key = fitKey(op.fit);
          if (key === null) lastFitKey.current = null;
          else if (key !== lastFitKey.current) setPendingFit(op.fit);
          break;
        }
        case 'overlay': {
          const source = map.getSource(OVERLAY_SOURCES[op.name]) as
            | maplibregl.GeoJSONSource
            | undefined;
          source?.setData(op.overlay?.data ?? { type: 'FeatureCollection', features: [] });
          break;
        }
        case 'id':
        case 'mode':
        case 'dock':
          // Read straight off the spec by the React tree below.
          break;
      }
    }
    appliedRef.current = spec;
  }, [spec, liveMap]);

  // A fit runs once its target is known: a body fit waits for the focus read.
  const focusBody = data.focusBody;
  useEffect(() => {
    const map = liveMap();
    if (!map || !pendingFit) return;
    const key = fitKey(pendingFit);
    const first = lastFitKey.current === null && !useSkaterMapStore.getState().camera;
    const animate = !first;
    switch (pendingFit.kind) {
      case 'body': {
        if (!focusBody || specRef.current.focus?.bodyId !== pendingFit.bodyId) return;
        map.fitBounds(boundsForBody(focusBody.bbox), { padding: FIT_PADDING, animate });
        break;
      }
      case 'bounds':
        map.fitBounds(pendingFit.bounds, { padding: FIT_PADDING, animate });
        break;
      case 'point':
        map.flyTo({
          center: [pendingFit.lng, pendingFit.lat],
          zoom: pendingFit.zoom ?? map.getZoom(),
          animate,
        });
        break;
      case 'region':
        map.flyTo({ center: INITIAL_CENTER, zoom: INITIAL_ZOOM, animate });
        break;
    }
    lastFitKey.current = key;
    setPendingFit(null);
  }, [pendingFit, focusBody, liveMap, specRef]);

  // On first open of a view with no framing of its own and no camera this session, frame on the
  // skater's own water when the device says they're in the region (D12/D20). Never stored.
  //
  // The answer can take up to eight seconds. If the camera moved meanwhile — a pan, a zoom, a lake
  // opened and framed — or the view in force now frames itself, the answer is stale and is dropped:
  // it must never pull the skater back from where they've since gone.
  const geolocated = useRef(false);
  useEffect(() => {
    const map = liveMap();
    if (!map || geolocated.current) return;
    geolocated.current = true;
    if (useSkaterMapStore.getState().camera || spec.fit !== null || !spec.visible) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    let moved = false;
    const onMove = () => {
      moved = true;
    };
    map.on('movestart', onMove);
    const stillWanted = () => {
      map.off('movestart', onMove);
      const now = specRef.current;
      return (
        !moved &&
        now.fit === null &&
        now.visible &&
        !useSkaterMapStore.getState().camera &&
        liveMap() === map
      );
    };
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!stillWanted()) return;
        const frame = frameForCoord({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        if (frame) map.jumpTo(frame);
      },
      () => {
        map.off('movestart', onMove);
      },
      { timeout: 8000, maximumAge: 60_000 },
    );
  }, [spec.fit, spec.visible, liveMap, specRef]);

  // ── Data → sources ───────────────────────────────────────────────────────────────────────────
  // Memoized on `liveMap`, so its identity carries readiness: every effect below lists `setSource`
  // alone and re-runs — re-filling its source — once a map that can take the write exists.
  const setSource = useCallback(
    (id: string, fc: GeoJSON.FeatureCollection) => {
      (liveMap()?.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(fc);
    },
    [liveMap],
  );
  useEffect(() => {
    setSource(SOURCES.water, data.water);
  }, [data.water, setSource]);
  useEffect(() => {
    setSource(SOURCES.subAreas, data.subAreaFeatures);
  }, [data.subAreaFeatures, setSource]);
  useEffect(() => {
    setSource(SOURCES.hazards, data.hazardFeatures);
    setSource(SOURCES.bodyFeatures, data.bodyFeatureFeatures);
  }, [data.hazardFeatures, data.bodyFeatureFeatures, setSource]);
  useEffect(() => {
    setSource(SOURCES.approach, data.approachFeatures);
    setSource(SOURCES.landmarks, data.landmarkFeatures);
    setSource(SOURCES.tracks, data.trackFeatures);
  }, [data.approachFeatures, data.landmarkFeatures, data.trackFeatures, setSource]);

  // The sidebar's In view list reads the rows the map is drawing (no second subscription).
  useEffect(() => {
    const store = useSkaterMapStore.getState();
    if (!spec.visible || query === null || data.offscreen) store.setViewportLakes(null);
    else if (data.bodies !== undefined) store.setViewportLakes(data.bodies);
  }, [data.bodies, data.offscreen, query, spec.visible]);

  // Hover, both ways: the sidebar's row and the map's water share `hoveredBodyId`.
  useEffect(() => {
    liveMap()?.setFilter(WATER_HOVER_LAYER, matchId(hoveredBodyId) as never);
  }, [hoveredBodyId, liveMap]);

  // ── Depth: the focused lake's band fills and contours, and the credit the tiles carry ─────
  const [contoursDrawn, setContoursDrawn] = useState(false);
  // The open lake's bands as the tiles bound them — the legend reads their real depths.
  const [bands, setBands] = useState<readonly LegendBand[]>([]);
  const contourKey =
    focusBody && spec.focus ? contourBodyKey(focusBody.externalId, focusBody._id) : null;
  const depthOn = spec.layers.depth && contourKey !== null && contourArchive !== '';
  useEffect(() => {
    const map = liveMap();
    if (!map) return;
    const layers = DEPTH_LAYERS.filter((l) => map.getLayer(l.layer));
    if (layers.length === 0) return;
    // One filter for both: the bands are stamped with the contours' own key.
    const filter = contourFilter(depthOn ? contourKey : null) as maplibregl.FilterSpecification;
    for (const l of layers) {
      map.setFilter(l.layer, filter);
      map.setPaintProperty(l.layer, l.opacityProperty, 0);
    }
    setContoursDrawn(false);
    setBands([]);
    useSkaterMapStore.getState().setContourCredit(null);
    if (!depthOn) return;
    const read = () => {
      const found = layers.map((l) => ({
        l,
        props: map
          .querySourceFeatures(CONTOUR_SOURCE_ID, { sourceLayer: l.sourceLayer, filter })
          .map((f) => f.properties),
      }));
      for (const { l, props } of found) {
        if (props.length === 0) continue;
        // Fade in once any of this lake's features are readable (A06b: popping in reads as a bug).
        map.setPaintProperty(l.layer, l.opacityProperty, l.opacity);
        if (l.layer === BANDS_LAYER_ID) {
          const next = lakeBands(props as Partial<BandFeatureProperties>[]);
          setBands((prev) => (sameBands(prev, next) ? prev : next));
        } else {
          setContoursDrawn(true);
        }
      }
      // The credit is the lines', as before: bands carry provenance (`lane`), not an agency.
      const lines = (found.find((f) => f.l.layer === CONTOUR_LAYER_ID)?.props ??
        []) as Partial<ContourFeatureProperties>[];
      if (lines.length === 0) return;
      const credit = formatContourCredit(contourCredit(lines)) || null;
      if (useSkaterMapStore.getState().contourCredit !== credit) {
        useSkaterMapStore.getState().setContourCredit(credit);
      }
    };
    // `sourcedata` for this source, not `idle`, which never fires after a late source (A06b).
    const onData = (e: maplibregl.MapSourceDataEvent) => {
      if (e.sourceId === CONTOUR_SOURCE_ID) read();
    };
    map.on('sourcedata', onData);
    read();
    return () => {
      map.off('sourcedata', onData);
    };
  }, [depthOn, contourKey, liveMap]);

  // Under drawn depth the lake takes the shallowest band's fill: the ground the band polygons lie
  // on, or — for a lake with contour lines and no polygons — what makes the rings read as depth.
  // While a satellite picture is up, the lake it's painted over drops its fill altogether — the same
  // stand-down depth makes under imagery (D81) — so the water color never covers the picture.
  const depthDrawn = (contoursDrawn || bands.length > 0) && spec.layers.depth;
  const imageryOn = toggles.imagery;
  useEffect(() => {
    const map = liveMap();
    if (!map) return;
    const lakeId = focusBody?._id ?? null;
    const ground = depthDrawn ? lakeId : null;
    map.setPaintProperty(WATER_FILL_LAYER, 'fill-color', waterFillColor(palette, ground) as never);
    map.setPaintProperty(
      WATER_FILL_LAYER,
      'fill-opacity',
      waterFillOpacity(imageryOn ? lakeId : null) as never,
    );
  }, [depthDrawn, focusBody, imageryOn, palette, liveMap]);

  // ── The dock's camera actions ─────────────────────────────────────────────────────────────────
  const [locating, setLocating] = useState(false);
  const locate = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      toast({ title: 'Your location isn’t available in this browser.' });
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const frame = frameForCoord({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        if (frame) mapRef.current?.flyTo(frame);
        else toast({ title: 'You’re outside the area Gli covers, so the map stayed put.' });
      },
      () => {
        setLocating(false);
        toast({ title: 'Couldn’t get your location.' });
      },
      { timeout: 8000, maximumAge: 60_000 },
    );
  };

  // The mode bar's Esc: one Esc per screen, and while a mode is up it's the mode's.
  useEffect(() => {
    if (!spec.mode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') activeMapHandlers().onExitMode?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [spec.mode]);

  const dockRef = useRef<HTMLDivElement | null>(null);
  const reserved = useMemo(
    () => (): Rect[] => {
      const host = containerRef.current?.getBoundingClientRect();
      const dock = dockRef.current
        ?.querySelector('[data-slot="map-dock"]')
        ?.getBoundingClientRect();
      if (!host || !dock || dock.width === 0) return [];
      return [
        {
          left: dock.left - host.left,
          top: dock.top - host.top,
          right: dock.right - host.left,
          bottom: dock.bottom - host.top,
        },
      ];
    },
    [containerRef],
  );

  // The key names what is drawn: the put-ins under their switch, the hazards by tone, a track.
  const putInsShown = spec.layers.putIns && data.putInMarks.length > 0;
  const tracksShown =
    (spec.layers.tracks && data.trackFeatures.features.length > 0) ||
    (spec.overlays.track?.data.features.length ?? 0) > 0;
  const keyKinds = useMemo(
    () =>
      skaterMapKeyKinds({ putIns: putInsShown, hazards: data.hazardMarks, tracks: tracksShown }),
    [putInsShown, data.hazardMarks, tracksShown],
  );

  const map = mapRef.current;
  const handlers = activeMapHandlers();
  return (
    <>
      <div ref={containerRef} className={MAP_CONTAINER_CLASS} data-slot="map-canvas" />
      {map && loaded && spec.visible && (
        <MapMarksLayer
          map={map}
          labels={data.labels}
          putIns={spec.layers.putIns ? data.putInMarks : []}
          hazards={data.hazardMarks}
          selectedHazardId={spec.focus?.hazardId ?? null}
          onOpenHazard={(id) =>
            navigate({ to: '/hazard/$id', params: { id }, state: panelLinkState('map') })
          }
          reserved={reserved}
          imagery={imageryOn}
        />
      )}
      {map && loaded && spec.visible && <MapKey kinds={keyKinds} />}
      {spec.mode && (
        <MapModeBar
          mode={spec.mode.mode}
          step={spec.mode.step}
          {...(spec.mode.exitLabel !== undefined ? { exitLabel: spec.mode.exitLabel } : {})}
          onExit={() => activeMapHandlers().onExitMode?.()}
        >
          {spec.mode.line}
        </MapModeBar>
      )}
      <div ref={dockRef}>
        <MapDockControls
          controls={spec.dock}
          onZoomIn={() => mapRef.current?.zoomIn()}
          onZoomOut={() => mapRef.current?.zoomOut()}
          atMaxZoom={zoomBounds.atMax}
          atMinZoom={zoomBounds.atMin}
          onLocate={locate}
          locating={locating}
          onOpenImagery={handlers.onOpenImagery}
          depthShown={depthDrawn}
          depthBands={bands}
          onReturnToRegion={() =>
            mapRef.current?.flyTo({ center: INITIAL_CENTER, zoom: INITIAL_ZOOM, duration: 900 })
          }
          lakeName={focusBody?.name ?? null}
          contourCredit={contourCreditLine}
        />
      </div>
    </>
  );
}
