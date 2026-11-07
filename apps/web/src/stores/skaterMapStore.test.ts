import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAP_LAYERS,
  readPersistedCamera,
  readPersistedLayers,
  useSkaterMapStore,
} from './skaterMapStore';

const initial = useSkaterMapStore.getState();

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useSkaterMapStore.setState(
    { ...initial, camera: null, layers: { ...DEFAULT_MAP_LAYERS }, hoveredBodyId: null },
    true,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useSkaterMapStore', () => {
  it('toggles a layer and persists the set to localStorage', () => {
    useSkaterMapStore.getState().toggleLayer('depth');
    expect(useSkaterMapStore.getState().layers.depth).toBe(!DEFAULT_MAP_LAYERS.depth);
    expect(readPersistedLayers(localStorage).depth).toBe(!DEFAULT_MAP_LAYERS.depth);
  });

  it('persists the camera to sessionStorage only — this session, not a preference', () => {
    const camera = { center: [-72.3, 43.6] as [number, number], zoom: 12 };
    useSkaterMapStore.getState().setCamera(camera);
    expect(readPersistedCamera(sessionStorage)).toEqual(camera);
    expect(localStorage.getItem('gli-map-camera')).toBeNull();
  });

  it('keeps working when storage writes fail', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    useSkaterMapStore.getState().toggleLayer('imagery');
    expect(useSkaterMapStore.getState().layers.imagery).toBe(true);
  });

  it('holds hover, pending click, and away-from-region as plain state', () => {
    const s = useSkaterMapStore.getState();
    s.setHoveredBodyId('body1');
    s.setPendingMapClick({ lng: -72, lat: 43 });
    s.setAwayFromRegion(true);
    const after = useSkaterMapStore.getState();
    expect(after.hoveredBodyId).toBe('body1');
    expect(after.pendingMapClick).toEqual({ lng: -72, lat: 43 });
    expect(after.awayFromRegion).toBe(true);
  });
});

describe('readPersistedLayers', () => {
  it('merges a stored partial over the defaults, so a new toggle gets its default', () => {
    localStorage.setItem('gli-map-layers', JSON.stringify({ depth: false }));
    expect(readPersistedLayers(localStorage)).toEqual({ ...DEFAULT_MAP_LAYERS, depth: false });
  });

  it('is the defaults with nothing stored', () => {
    expect(readPersistedLayers(localStorage)).toEqual(DEFAULT_MAP_LAYERS);
    expect(readPersistedLayers(undefined)).toEqual(DEFAULT_MAP_LAYERS);
  });
});

describe('readPersistedCamera', () => {
  it('rejects junk shapes', () => {
    sessionStorage.setItem('gli-map-camera', JSON.stringify({ zoom: 'high' }));
    expect(readPersistedCamera(sessionStorage)).toBeNull();
    sessionStorage.setItem('gli-map-camera', JSON.stringify({ center: 'x', zoom: 3 }));
    expect(readPersistedCamera(sessionStorage)).toBeNull();
  });
});
