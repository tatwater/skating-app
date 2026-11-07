import { create } from 'zustand';
import { localStore, readJson, sessionStore, writeJson } from './storage';

/**
 * The region map's client state (§2.1) — owned by agent B (`SkaterMap`) from T1; this skeleton
 * fixes the shape the rest of the app reads.
 *
 * - **The camera is never in the URL** (D242): coordinates in a URL would leak into history,
 *   referrers, Sentry and PostHog. It persists to `sessionStorage` only — this session's view,
 *   not a durable preference.
 * - **Layer toggles are a per-viewer convenience**, so `localStorage`.
 * - The pending map click (request-a-lake) and hover are ephemeral by nature.
 *
 * Map and hotkey handlers may read the store without a hook (`useSkaterMapStore.getState()`).
 */

export interface MapCamera {
  center: [lng: number, lat: number];
  zoom: number;
}

/** Which optional layers are drawn. Agent B owns the final set and defaults. */
export interface MapLayerToggles {
  depth: boolean;
  hazards: boolean;
  putIns: boolean;
  imagery: boolean;
  labels: boolean;
}

export const DEFAULT_MAP_LAYERS: MapLayerToggles = {
  depth: true,
  hazards: true,
  putIns: true,
  imagery: false,
  labels: true,
};

const LAYERS_KEY = 'gli-map-layers';
const CAMERA_KEY = 'gli-map-camera';

interface SkaterMapState {
  camera: MapCamera | null;
  layers: MapLayerToggles;
  hoveredBodyId: string | null;
  /** A left-click on unlisted water, pending the request-a-lake flow. Never in the URL. */
  pendingMapClick: { lng: number; lat: number } | null;
  /** True when the viewport has left the region — the dock shows "return to the region". */
  awayFromRegion: boolean;
  setCamera: (camera: MapCamera) => void;
  toggleLayer: (layer: keyof MapLayerToggles) => void;
  setHoveredBodyId: (id: string | null) => void;
  setPendingMapClick: (click: { lng: number; lat: number } | null) => void;
  setAwayFromRegion: (away: boolean) => void;
}

/** Exported for tests; merged over defaults so a stale shape can't drop a newer toggle. */
export function readPersistedLayers(storage: Storage | undefined): MapLayerToggles {
  const stored = readJson<Partial<MapLayerToggles>>(storage, LAYERS_KEY);
  return { ...DEFAULT_MAP_LAYERS, ...stored };
}

/** Exported for tests. */
export function readPersistedCamera(storage: Storage | undefined): MapCamera | null {
  const stored = readJson<MapCamera>(storage, CAMERA_KEY);
  if (!stored || !Array.isArray(stored.center) || typeof stored.zoom !== 'number') return null;
  return stored;
}

export const useSkaterMapStore = create<SkaterMapState>()((set, get) => ({
  camera: readPersistedCamera(sessionStore()),
  layers: readPersistedLayers(localStore()),
  hoveredBodyId: null,
  pendingMapClick: null,
  awayFromRegion: false,
  setCamera: (camera) => {
    set({ camera });
    writeJson(sessionStore(), CAMERA_KEY, camera);
  },
  toggleLayer: (layer) => {
    const layers = { ...get().layers, [layer]: !get().layers[layer] };
    set({ layers });
    writeJson(localStore(), LAYERS_KEY, layers);
  },
  setHoveredBodyId: (hoveredBodyId) => set({ hoveredBodyId }),
  setPendingMapClick: (pendingMapClick) => set({ pendingMapClick }),
  setAwayFromRegion: (awayFromRegion) => set({ awayFromRegion }),
}));
