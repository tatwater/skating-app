import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exploreMapSpec, HIDDEN_MAP_SPEC, lakeMapSpec } from '../components/skater/map/mapSpec';
import {
  DEFAULT_MAP_LAYERS,
  effectiveMapSpec,
  readPersistedCamera,
  readPersistedLayers,
  useSkaterMapStore,
} from './skaterMapStore';

const initial = useSkaterMapStore.getState();

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useSkaterMapStore.setState(
    {
      ...initial,
      camera: null,
      layers: { ...DEFAULT_MAP_LAYERS },
      hoveredBodyId: null,
      viewportLakes: null,
      contourCredit: null,
      specs: { view: null, flow: null },
    },
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

  it('never persists the imagery layer — a session mood, not a preference', () => {
    useSkaterMapStore.getState().toggleLayer('imagery');
    expect(useSkaterMapStore.getState().layers.imagery).toBe(true);
    useSkaterMapStore.getState().toggleLayer('depth');
    const stored = JSON.parse(localStorage.getItem('gli-map-layers') ?? '{}');
    expect(stored).not.toHaveProperty('imagery');
    expect(stored.depth).toBe(!DEFAULT_MAP_LAYERS.depth);
    expect(readPersistedLayers(localStorage).imagery).toBe(false);
  });

  it('has no hazards switch at all (D3: the row is locked on)', () => {
    expect(DEFAULT_MAP_LAYERS).not.toHaveProperty('hazards');
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

  it('holds hover, pending click, away-from-region, the rows and the credit as plain state', () => {
    const s = useSkaterMapStore.getState();
    s.setHoveredBodyId('body1');
    s.setPendingMapClick({ lng: -72, lat: 43 });
    s.setAwayFromRegion(true);
    s.setViewportLakes([{ _id: 'a', name: 'A', type: 'lake' }]);
    s.setContourCredit('NH GRANIT');
    const after = useSkaterMapStore.getState();
    expect(after.hoveredBodyId).toBe('body1');
    expect(after.pendingMapClick).toEqual({ lng: -72, lat: 43 });
    expect(after.awayFromRegion).toBe(true);
    expect(after.viewportLakes).toHaveLength(1);
    expect(after.contourCredit).toBe('NH GRANIT');
  });
});

describe('declareMapSpec / effectiveMapSpec', () => {
  it('shows no map until a view declares one, and none after it leaves', () => {
    const store = useSkaterMapStore.getState();
    expect(effectiveMapSpec(useSkaterMapStore.getState().specs)).toBe(HIDDEN_MAP_SPEC);
    store.declareMapSpec('view', exploreMapSpec());
    expect(effectiveMapSpec(useSkaterMapStore.getState().specs).id).toBe('explore');
    store.declareMapSpec('view', null);
    expect(effectiveMapSpec(useSkaterMapStore.getState().specs)).toBe(HIDDEN_MAP_SPEC);
  });

  it('puts a flow’s spec over its view’s, and gives the view back when the flow ends', () => {
    const store = useSkaterMapStore.getState();
    store.declareMapSpec('view', lakeMapSpec('m'));
    store.declareMapSpec('flow', { ...lakeMapSpec('m'), id: 'hazard-flow' });
    expect(effectiveMapSpec(useSkaterMapStore.getState().specs).id).toBe('hazard-flow');
    store.declareMapSpec('flow', null);
    expect(effectiveMapSpec(useSkaterMapStore.getState().specs).id).toBe('lake');
  });

  it('keeps the old object for a spec that draws the same map, so nothing re-renders', () => {
    const store = useSkaterMapStore.getState();
    store.declareMapSpec('view', lakeMapSpec('m'));
    const before = useSkaterMapStore.getState().specs;
    store.declareMapSpec('view', lakeMapSpec('m'));
    expect(useSkaterMapStore.getState().specs).toBe(before);
    store.declareMapSpec('view', lakeMapSpec('n'));
    expect(useSkaterMapStore.getState().specs).not.toBe(before);
    const same = useSkaterMapStore.getState().specs.view;
    store.declareMapSpec('view', same);
    expect(useSkaterMapStore.getState().specs.view).toBe(same);
  });
});

describe('readPersistedLayers', () => {
  it('merges a stored partial over the defaults, so a new toggle gets its default', () => {
    localStorage.setItem('gli-map-layers', JSON.stringify({ depth: false }));
    expect(readPersistedLayers(localStorage)).toEqual({ ...DEFAULT_MAP_LAYERS, depth: false });
  });

  it('keeps booleans only, and ignores a stale hazards key', () => {
    localStorage.setItem(
      'gli-map-layers',
      JSON.stringify({ depth: 'no', labels: 0, tracks: true, hazards: false }),
    );
    const layers = readPersistedLayers(localStorage);
    expect(layers).toEqual({ ...DEFAULT_MAP_LAYERS, tracks: true });
    expect(layers).not.toHaveProperty('hazards');
  });

  it('ignores an imagery key an older build stored: restore starts on the plain map', () => {
    localStorage.setItem('gli-map-layers', JSON.stringify({ imagery: true, tracks: true }));
    expect(readPersistedLayers(localStorage)).toEqual({ ...DEFAULT_MAP_LAYERS, tracks: true });
  });

  it('is the defaults with nothing stored, or junk', () => {
    expect(readPersistedLayers(localStorage)).toEqual(DEFAULT_MAP_LAYERS);
    expect(readPersistedLayers(undefined)).toEqual(DEFAULT_MAP_LAYERS);
    localStorage.setItem('gli-map-layers', '7');
    expect(readPersistedLayers(localStorage)).toEqual(DEFAULT_MAP_LAYERS);
  });
});

describe('readPersistedCamera', () => {
  it('rejects junk shapes and impossible numbers', () => {
    for (const junk of [
      { zoom: 'high' },
      { center: 'x', zoom: 3 },
      { center: [1], zoom: 3 },
      { center: [Number.NaN, 1], zoom: 3 },
      { center: [1, 91], zoom: 3 },
      { center: [1, 2], zoom: null },
    ]) {
      sessionStorage.setItem('gli-map-camera', JSON.stringify(junk));
      expect(readPersistedCamera(sessionStorage)).toBeNull();
    }
  });

  it('reads a good camera back', () => {
    sessionStorage.setItem('gli-map-camera', JSON.stringify({ center: [-72, 43.6], zoom: 11 }));
    expect(readPersistedCamera(sessionStorage)).toEqual({ center: [-72, 43.6], zoom: 11 });
  });
});
