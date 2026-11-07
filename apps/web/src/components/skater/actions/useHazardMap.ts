import type { HazardDraft as HazardShapeDraft, HazardType, LatLng } from '@skating/core';
import type maplibregl from 'maplibre-gl';
import { useEffect, useMemo, useRef } from 'react';

import { hazardDraftToFeatureCollection } from '@/lib/hazardMap';
import { createPolygonDraw, type PolygonDrawControl } from '@/lib/polygonDraw';
import type { HazardDraft } from '@/stores/hazardDraftStore';

import { defineMapSpec, type MapMode, type MapOverlay, type MapSpec } from '../map/mapSpec';
import { useLatest, useMapInstance, useMapSpec } from '../map/useMapSpec';
import { mapModeFor } from './hazardFlowModel';

/**
 * Where the hazard flow draws (boards 3.2–3.6, and the stacked 5.10.1).
 *
 * The flow states what it wants of a map — the mode bar, the draft overlay, whether a click is its
 * own — as one {@link HazardFlowMapState}. On Explore that state becomes a **`flow`-slot spec** over
 * the lake's view (`useMapSpec`), and the lake's spec comes back the moment the flow ends. Stacked
 * inside the report sheet, the host (agent K) owns the instrument map and receives the same state
 * through `instrument.onMapState`, rendering it its own way.
 *
 * The one imperative piece is the area tool: terra-draw has to own GL sources, so it attaches to
 * the live map (`useMapInstance()` on Explore, `instrument.map` stacked) — the exception the map
 * contract carves out for exactly this — and removes itself when the area is done.
 */

export interface HazardFlowMapState {
  /** The mode bar while the map is the input; `null` when it isn't listening. */
  mode: MapMode | null;
  /** The draft hazard (`hazardDraftToFeatureCollection`'s shape), keyed for a cheap diff. */
  draft: MapOverlay | null;
  /** True while a left-click belongs to the flow (a spot, a line, the shore's two ends). */
  capturing: boolean;
  /** A left-click while `capturing`. */
  onCapture: (coord: LatLng) => void;
  /** The mode bar's exit (its Esc cap). Closes the flow — one Esc per screen. */
  onExitMode: () => void;
}

/** What a host that owns its own map hands a stacked flow (board 5.10.1). */
export interface HazardInstrument {
  map: maplibregl.Map | null;
  loaded: boolean;
  /** Called whenever the flow's map state changes, and with `null` when the flow ends. */
  onMapState: (state: HazardFlowMapState | null) => void;
}

/** The draft as a keyed overlay; `null` when nothing is drawn. */
export function draftOverlay(
  shape: HazardShapeDraft | null,
  type: HazardType | null,
): MapOverlay | null {
  if (shape === null) return null;
  const data = hazardDraftToFeatureCollection(shape, type);
  if (data.features.length === 0) return null;
  return { key: `${type ?? ''}|${JSON.stringify(shape)}`, data };
}

/** Is a map click the flow's right now? The area belongs to terra-draw, so it isn't. */
export function capturesClicks(draft: HazardDraft): boolean {
  return draft.placing && draft.hazardType !== null && draft.drawKind !== 'area';
}

/**
 * The flow's spec over a lake: the lake's own layers and framing, the draft drawn, and the click
 * the flow's while it's placing — never a navigation, so a click on another hazard or lake can't
 * yank the skater out of a half-drawn report.
 */
export function hazardFlowSpec(
  bodyId: string,
  subAreaId: string | undefined,
  state: Pick<HazardFlowMapState, 'mode' | 'draft' | 'capturing'>,
): MapSpec {
  return defineMapSpec({
    id: 'hazard-flow',
    focus: subAreaId === undefined ? { bodyId } : { bodyId, subAreaId },
    layers: { depth: true, places: true, putIns: true, labels: true, favorites: true },
    interactions: {
      select: false,
      requestLake: false,
      click: state.capturing ? 'capture' : 'none',
    },
    fit: { kind: 'body', bodyId },
    overlays: { draft: state.draft },
    mode: state.mode,
    dock: { zoom: true, layers: true, legend: true },
  });
}

/** Distinct corners from a closed GeoJSON ring (a draft holds them unclosed). */
export function ringCorners(polygon: GeoJSON.Polygon | null): LatLng[] | null {
  const ring = polygon?.coordinates[0];
  if (!ring || ring.length < 2) return null;
  const [first, last] = [ring[0], ring[ring.length - 1]];
  const closed = first?.[0] === last?.[0] && first?.[1] === last?.[1];
  return (closed ? ring.slice(0, -1) : ring).map(([lng = 0, lat = 0]) => ({ lat, lng }));
}

export function useHazardMap({
  bodyId,
  subAreaId,
  draft,
  instrument,
  onCapture,
  onAreaRing,
  onExit,
}: {
  bodyId: string;
  subAreaId?: string;
  draft: HazardDraft | null;
  instrument?: HazardInstrument;
  onCapture: (coord: LatLng) => void;
  onAreaRing: (ring: LatLng[] | null) => void;
  onExit: () => void;
}): {
  spec: MapSpec;
  handlers: { onCapture: (coord: LatLng) => void; onExitMode: () => void };
} {
  const mode = draft ? mapModeFor(draft) : null;
  const overlay = useMemo(
    () => (draft ? draftOverlay(draft.shape, draft.hazardType) : null),
    [draft],
  );
  const capturing = draft ? capturesClicks(draft) : false;
  const latest = useLatest({ onCapture, onAreaRing, onExit });

  // Explore: the flow slot over the lake's view. Stacked with an instrument: the host's map, so the
  // region map behind the report's scrim is left exactly as its view declared it.
  const spec = useMemo(
    () => hazardFlowSpec(bodyId, subAreaId, { mode, draft: overlay, capturing }),
    [bodyId, subAreaId, mode, overlay, capturing],
  );
  const handlers = useMemo(
    () => ({
      onCapture: (coord: LatLng) => latest.current.onCapture(coord),
      onExitMode: () => latest.current.onExit(),
    }),
    [latest],
  );

  const onMapState = instrument?.onMapState;
  useEffect(() => {
    if (!onMapState) return;
    onMapState({ mode, draft: overlay, capturing, ...handlers });
  }, [onMapState, mode, overlay, capturing, handlers]);
  useEffect(() => (onMapState ? () => onMapState(null) : undefined), [onMapState]);

  // The area tool, on whichever map the flow draws on.
  const region = useMapInstance();
  const map = instrument ? instrument.map : region.map;
  const loaded = instrument ? instrument.loaded : region.loaded;
  const drawing = draft?.placing === true && draft.drawKind === 'area' && draft.hazardType !== null;
  const shapeRef = useRef(draft?.shape ?? null);
  shapeRef.current = draft?.shape ?? null;
  useEffect(() => {
    if (!drawing || !map || !loaded) return;
    let control: PolygonDrawControl | null = null;
    let canceled = false;
    void createPolygonDraw(map, {
      onChange: (polygon) => latest.current.onAreaRing(ringCorners(polygon)),
    })
      .then((made) => {
        if (canceled) {
          made.destroy();
          return;
        }
        control = made;
        // Corners already drawn are handed back for dragging; otherwise draw from scratch.
        const shape = shapeRef.current;
        if (shape?.geometryKind === 'polygon' && shape.vertices.length >= 3) {
          const ring = shape.vertices.map((v) => [v.lng, v.lat]);
          made.setPolygon({ type: 'Polygon', coordinates: [[...ring, ring[0] as number[]]] });
          made.startEditing();
        } else {
          made.startDrawing();
        }
      })
      .catch(() => {
        // The chunk failed to load: the other three ways to draw still work, and Done leaves.
      });
    return () => {
      canceled = true;
      control?.destroy();
    };
  }, [drawing, map, loaded, latest]);

  return { spec, handlers };
}

/**
 * The flow slot on the region map. A component, not a branch in the hook: `useMapSpec` declares for
 * as long as it's mounted, and a stacked flow must leave the region map exactly as its view said.
 */
export function RegionFlowSpec({
  spec,
  handlers,
}: {
  spec: MapSpec;
  handlers: { onCapture: (coord: LatLng) => void; onExitMode: () => void };
}): null {
  useMapSpec(spec, { slot: 'flow', ...handlers });
  return null;
}
