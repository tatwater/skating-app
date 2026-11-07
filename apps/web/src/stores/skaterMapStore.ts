import { create } from 'zustand';
import { HIDDEN_MAP_SPEC, type MapSpec, sameMapSpec } from '../components/skater/map/mapSpec';
import type { ViewportLake } from '../lib/viewportLakes';
import { localStore, readJson, sessionStore, writeJson } from './storage';

/**
 * The region map's client state (§2.1), owned by `SkaterMap`.
 *
 * - **The camera is never in the URL** (D242): coordinates in a URL would leak into history,
 *   referrers, Sentry and PostHog. It persists to `sessionStorage` only — this session's view,
 *   not a durable preference.
 * - **Layer toggles are a per-viewer convenience**, so `localStorage`. Hazards aren't one: the row
 *   is locked on in the layers menu, and there's no switch here for a stale `localStorage` or a
 *   stray call to turn off (D3).
 * - The pending map click (request-a-lake), hover and the viewport's rows are ephemeral by nature.
 *
 * Map and hotkey handlers may read the store without a hook (`useSkaterMapStore.getState()`).
 */

export interface MapCamera {
  center: [lng: number, lat: number];
  zoom: number;
}

/** The layers menu's switches (board 3.16). Hazards are deliberately absent: see above. */
export interface MapLayerToggles {
  depth: boolean;
  places: boolean;
  putIns: boolean;
  tracks: boolean;
  labels: boolean;
  favorites: boolean;
  /**
   * The imagery overlay: its own control, not a row in the menu. Agent J's flow drives it. A session
   * mood, not a preference — never persisted, so every visit starts on the plain map.
   */
  imagery: boolean;
}

export const DEFAULT_MAP_LAYERS: MapLayerToggles = {
  depth: true,
  places: true,
  putIns: true,
  tracks: false,
  labels: true,
  favorites: true,
  imagery: false,
};

const LAYERS_KEY = 'gli-map-layers';

/** Layers that live for the session only: never written, ignored if an old write is found. */
const SESSION_ONLY_LAYERS: ReadonlySet<keyof MapLayerToggles> = new Set(['imagery']);

/** The layers as stored: every switch but the session-only ones. */
function persistedLayers(layers: MapLayerToggles): Partial<MapLayerToggles> {
  const out: Partial<MapLayerToggles> = {};
  for (const key of Object.keys(layers) as (keyof MapLayerToggles)[]) {
    if (!SESSION_ONLY_LAYERS.has(key)) out[key] = layers[key];
  }
  return out;
}
const CAMERA_KEY = 'gli-map-camera';

/** Which of the two slots a spec fills: a flow (a hazard being placed) sits over its view. */
export type MapSpecSlot = 'view' | 'flow';

interface SkaterMapState {
  camera: MapCamera | null;
  layers: MapLayerToggles;
  hoveredBodyId: string | null;
  /** A left-click on unlisted water, pending the request-a-lake flow. Never in the URL. */
  pendingMapClick: { lng: number; lat: number } | null;
  /** True when the viewport has left the region — the dock shows "return to the region". */
  awayFromRegion: boolean;
  /**
   * The rows the map is drawing, handed to the sidebar's In view list so it needs no second
   * subscription. `null` until the map answers, and while it's away from the region.
   */
  viewportLakes: readonly ViewportLake[] | null;
  /** The drawn contours' credit line (the tile is the authority), for the sidebar's foot. */
  contourCredit: string | null;
  /** The specs the views have declared. Read through `effectiveMapSpec`. */
  specs: Readonly<Record<MapSpecSlot, MapSpec | null>>;
  setCamera: (camera: MapCamera) => void;
  toggleLayer: (layer: keyof MapLayerToggles) => void;
  setHoveredBodyId: (id: string | null) => void;
  setPendingMapClick: (click: { lng: number; lat: number } | null) => void;
  setAwayFromRegion: (away: boolean) => void;
  setViewportLakes: (lakes: readonly ViewportLake[] | null) => void;
  setContourCredit: (credit: string | null) => void;
  /** Keeps the old object when the two specs would draw the same map, so nothing re-renders. */
  declareMapSpec: (slot: MapSpecSlot, spec: MapSpec | null) => void;
}

/**
 * Exported for tests. Keeps booleans only: a stale or hand-edited value can't reach the map. A
 * session-only layer (imagery) always restores to its default, whatever an older build wrote.
 */
export function readPersistedLayers(storage: Storage | undefined): MapLayerToggles {
  const stored = readJson<Record<string, unknown>>(storage, LAYERS_KEY) ?? {};
  const layers = { ...DEFAULT_MAP_LAYERS };
  for (const key of Object.keys(DEFAULT_MAP_LAYERS) as (keyof MapLayerToggles)[]) {
    if (SESSION_ONLY_LAYERS.has(key)) continue;
    const value = stored[key];
    if (typeof value === 'boolean') layers[key] = value;
  }
  return layers;
}

/** Exported for tests. A camera that isn't one (a stale shape, NaN) reads as none at all. */
export function readPersistedCamera(storage: Storage | undefined): MapCamera | null {
  const stored = readJson<Partial<MapCamera>>(storage, CAMERA_KEY);
  const center = stored?.center;
  const zoom = stored?.zoom;
  if (!Array.isArray(center) || center.length !== 2 || typeof zoom !== 'number') return null;
  const [lng, lat] = center;
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !Number.isFinite(zoom)) return null;
  if (Math.abs(lat as number) > 90) return null;
  return { center: [lng as number, lat as number], zoom };
}

export const useSkaterMapStore = create<SkaterMapState>()((set, get) => ({
  camera: readPersistedCamera(sessionStore()),
  layers: readPersistedLayers(localStore()),
  hoveredBodyId: null,
  pendingMapClick: null,
  awayFromRegion: false,
  viewportLakes: null,
  contourCredit: null,
  specs: { view: null, flow: null },
  setCamera: (camera) => {
    set({ camera });
    writeJson(sessionStore(), CAMERA_KEY, camera);
  },
  toggleLayer: (layer) => {
    const layers = { ...get().layers, [layer]: !get().layers[layer] };
    set({ layers });
    writeJson(localStore(), LAYERS_KEY, persistedLayers(layers));
  },
  setHoveredBodyId: (hoveredBodyId) => set({ hoveredBodyId }),
  setPendingMapClick: (pendingMapClick) => set({ pendingMapClick }),
  setAwayFromRegion: (awayFromRegion) => set({ awayFromRegion }),
  setViewportLakes: (viewportLakes) => set({ viewportLakes }),
  setContourCredit: (contourCredit) => set({ contourCredit }),
  declareMapSpec: (slot, spec) => {
    const current = get().specs[slot];
    if (current === spec) return;
    if (current && spec && sameMapSpec(current, spec)) return;
    set({ specs: { ...get().specs, [slot]: spec } });
  },
}));

/**
 * The spec in force: a flow's over its view's, and no map at all when neither has declared one —
 * so leaving a view can't leave its layers behind.
 */
export function effectiveMapSpec(specs: SkaterMapState['specs']): MapSpec {
  return specs.flow ?? specs.view ?? HIDDEN_MAP_SPEC;
}
