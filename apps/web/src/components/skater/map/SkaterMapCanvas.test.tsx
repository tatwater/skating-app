/**
 * The persistent map's canvas against a fake MapLibre (jsdom has no WebGL): what these pin is the
 * contract between the spec and the map API — which layers turn on, which filters move, which
 * handlers bind, where a click goes, what the dock does to the camera. Whether MapLibre draws a
 * filter correctly is MapLibre's test to write; whether the style is valid is `mapLayers.test.ts`.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── The fake map ──────────────────────────────────────────────────────────────────────────────

type Handler = (e?: unknown) => void;

class FakeHandler {
  enabled = true;
  enable() {
    this.enabled = true;
  }
  disable() {
    this.enabled = false;
  }
  disableRotation() {}
}

class FakeMap {
  static instances: FakeMap[] = [];
  options: Record<string, unknown>;
  handlers = new Map<string, Handler[]>();
  layerHandlers = new Map<string, Handler>();
  sources = new Map<string, unknown>();
  layers = new Map<
    string,
    { layout: Record<string, unknown>; paint: Record<string, unknown>; filter?: unknown }
  >();
  canvas = document.createElement('canvas');
  container = document.createElement('div');
  rendered: unknown[] = [];
  /** The contour source's line features; `bandFeatures` are its band layer's. */
  sourceFeatures: unknown[] = [];
  bandFeatures: unknown[] = [];
  zoom = 8;
  dragPan = new FakeHandler();
  scrollZoom = new FakeHandler();
  doubleClickZoom = new FakeHandler();
  boxZoom = new FakeHandler();
  touchZoomRotate = new FakeHandler();
  keyboard = new FakeHandler();
  fitBounds = vi.fn();
  flyTo = vi.fn();
  jumpTo = vi.fn();
  zoomIn = vi.fn();
  zoomOut = vi.fn();
  resize = vi.fn();
  removed = false;

  constructor(options: Record<string, unknown>) {
    this.options = options;
    Object.defineProperty(this.container, 'clientWidth', { value: 1000 });
    Object.defineProperty(this.container, 'clientHeight', { value: 800 });
    FakeMap.instances.push(this);
  }
  on(event: string, a: string | Handler, b?: Handler) {
    if (typeof a === 'string') this.layerHandlers.set(`${event}:${a}`, b as Handler);
    else this.handlers.set(event, [...(this.handlers.get(event) ?? []), a]);
  }
  off(event: string, handler: Handler) {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((h) => h !== handler),
    );
  }
  fire(event: string, e?: unknown) {
    for (const h of this.handlers.get(event) ?? []) h(e);
  }
  addControl() {}
  addSource(id: string, spec: { data?: unknown }) {
    this.sources.set(id, spec.data);
  }
  addLayer(spec: {
    id: string;
    layout?: Record<string, unknown>;
    paint?: Record<string, unknown>;
    filter?: unknown;
  }) {
    this.layers.set(spec.id, {
      layout: { ...spec.layout },
      paint: { ...spec.paint },
      filter: spec.filter,
    });
  }
  getLayer(id: string) {
    return this.layers.get(id);
  }
  getSource(id: string) {
    return this.sources.has(id) ? { setData: (d: unknown) => this.sources.set(id, d) } : undefined;
  }
  setLayoutProperty(id: string, key: string, value: unknown) {
    const layer = this.layers.get(id);
    if (layer) layer.layout[key] = value;
  }
  setPaintProperty(id: string, key: string, value: unknown) {
    const layer = this.layers.get(id);
    if (layer) layer.paint[key] = value;
  }
  setFilter(id: string, filter: unknown) {
    const layer = this.layers.get(id);
    if (layer) layer.filter = filter;
  }
  queryRenderedFeatures() {
    return this.rendered;
  }
  querySourceFeatures(id: string, options?: { sourceLayer?: string }) {
    if (id !== 'bathymetry') return [];
    return options?.sourceLayer === 'bathymetry_bands' ? this.bandFeatures : this.sourceFeatures;
  }
  getCanvas() {
    return this.canvas;
  }
  getContainer() {
    return this.container;
  }
  getCenter() {
    return { lng: -72.1, lat: 43.6 };
  }
  getZoom() {
    return this.zoom;
  }
  getMaxZoom() {
    return 22;
  }
  getMinZoom() {
    return 0;
  }
  getBounds() {
    return {
      getWest: () => -72.3,
      getSouth: () => 43.5,
      getEast: () => -71.9,
      getNorth: () => 43.7,
    };
  }
  project([lng, lat]: [number, number]) {
    return { x: (lng + 73) * 500, y: (44 - lat) * 500 };
  }
  remove() {
    this.removed = true;
  }
}

vi.mock('maplibre-gl', () => ({
  default: {
    Map: FakeMap,
    addProtocol: vi.fn(),
    removeProtocol: vi.fn(),
    AttributionControl: class {},
    NavigationControl: class {},
  },
}));
vi.mock('pmtiles', () => ({ Protocol: class {} }));
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));

// ── The app around it ─────────────────────────────────────────────────────────────────────────

const theme = { resolvedTheme: 'dark' as 'dark' | 'light' };
vi.mock('@/components/theme-provider', () => ({ useTheme: () => theme }));

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

const toast = vi.fn();
vi.mock('@/components/kit/toast', () => ({ toast: (o: unknown) => toast(o) }));

const capture = vi.fn();
vi.mock('@/lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture }),
}));

const feedFilters: { value: Record<string, unknown> } = { value: {} };
vi.mock('@/lib/feedFiltersStore', () => ({ useFeedFilters: () => feedFilters }));

vi.mock('@/lib/env', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...real,
    env: {
      ...real.env,
      pmtilesUrl: 'https://t/region.pmtiles',
      worldPmtilesUrl: '',
      bathymetryPmtilesUrl: 'https://t/bathy.pmtiles',
    },
  };
});

/** Query results by function name; `undefined` is "still loading". */
const results = new Map<string, unknown>();
const queryArgs = new Map<string, unknown>();
vi.mock('convex/react', () => ({
  useQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    queryArgs.set(name, args);
    return args === 'skip' ? undefined : results.get(name);
  },
}));

const { useSkaterMapStore, DEFAULT_MAP_LAYERS } = await import('@/stores/skaterMapStore');
const { exploreMapSpec, lakeMapSpec, panelMapSpec, defineMapSpec } = await import('./mapSpec');
const { useMapSpec } = await import('./useMapSpec');
const {
  default: SkaterMapCanvas,
  CAMERA_WRITE_DELAY_MS,
  LABEL_CLOCK_MS,
} = await import('./SkaterMapCanvas');
const { CONTOUR_LAYER_ID } = await import('@/lib/contourMap');
const { BANDS_LAYER_ID } = await import('@/lib/depthBands');

// ── Data ──────────────────────────────────────────────────────────────────────────────────────

const ring = (lng: number, lat: number, d = 0.02): GeoJSON.Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [lng, lat],
      [lng + d, lat],
      [lng + d, lat + d],
      [lng, lat + d],
      [lng, lat],
    ],
  ],
});

const MASCOMA = {
  _id: 'mascoma',
  name: 'Mascoma Lake',
  type: 'lake',
  externalId: 'way/123',
  polygon: ring(-72.15, 43.6),
  bbox: { minLat: 43.6, minLng: -72.15, maxLat: 43.62, maxLng: -72.13 },
  centroid: { lat: 43.61, lng: -72.14 },
  interiorPoint: { lat: 43.61, lng: -72.14 },
  surfaceAreaSqM: 4.6e6,
};
const CRYSTAL = {
  ...MASCOMA,
  _id: 'crystal',
  name: 'Crystal Lake',
  externalId: undefined,
  polygon: ring(-72.1, 43.58),
  interiorPoint: { lat: 43.59, lng: -72.09 },
};

function seed() {
  results.set('waterBodies:listInViewport', [MASCOMA, CRYSTAL]);
  results.set('contentFlags:myAccessFlags', []);
  results.set('waterBodyFavorites:listForUser', [{ waterBodyId: 'mascoma' }]);
  results.set('subAreas:listInViewport', []);
  results.set('waterBodies:get', { available: true, body: MASCOMA });
  results.set('putIns:listForBody', [
    { coord: { lat: 43.605, lng: -72.145 }, source: 'osm', name: 'Boat launch' },
  ]);
  results.set('landmarks:listForBody', []);
  results.set('hazards:listForBody', [
    {
      _id: 'h1',
      type: 'open_water',
      geometryKind: 'polygon',
      geometry: ring(-72.14, 43.61, 0.002),
      freshness: 'fresh',
      provisional: false,
    },
  ]);
  results.set('bodyFeatures:listForBody', []);
  results.set('gpsActivities:listTracksForBody', { tracks: [] });
  results.set('bounties:listOpen', [{ waterBodyId: 'crystal' }, { waterBodyId: 'crystal' }]);
  results.set('reports:recentCountsForBodies', {
    crystal: { count: 1, capped: false, newestSkateEndTime: Date.now() - 1000 },
  });
}

function Harness({
  spec,
  onCapture,
  onExitMode,
  onOpenImagery,
}: {
  spec: ReturnType<typeof lakeMapSpec>;
  onCapture?: () => void;
  onExitMode?: () => void;
  onOpenImagery?: () => void;
}) {
  useMapSpec(spec, { onCapture, onExitMode, onOpenImagery });
  return <SkaterMapCanvas />;
}

const map = () => FakeMap.instances.at(-1) as FakeMap;
const visibility = (id: string) => map().layers.get(id)?.layout.visibility;

async function mount(spec = lakeMapSpec('mascoma'), handlers = {}) {
  const view = render(<Harness spec={spec} {...handlers} />);
  await act(async () => {
    map().fire('load');
  });
  return view;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  FakeMap.instances = [];
  results.clear();
  queryArgs.clear();
  navigate.mockReset();
  toast.mockReset();
  capture.mockReset();
  feedFilters.value = {};
  theme.resolvedTheme = 'dark';
  sessionStorage.clear();
  localStorage.clear();
  useSkaterMapStore.setState({
    camera: null,
    layers: { ...DEFAULT_MAP_LAYERS },
    specs: { view: null, flow: null },
    hoveredBodyId: null,
    pendingMapClick: null,
    awayFromRegion: false,
    viewportLakes: null,
    contourCredit: null,
  });
  seed();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the spec, applied', () => {
  it('turns on the lake’s layers and selects it', async () => {
    await mount();
    expect(visibility('sub-area-label')).toBe('visible');
    // Tracks are the one lake layer that starts off (board 3.16).
    expect(visibility('track-line')).toBe('none');
    expect(map().layers.get('water-selected')?.filter).toEqual(['==', ['get', '_id'], 'mascoma']);
    expect(map().dragPan.enabled).toBe(true);
  });

  it('takes the last view’s layers away with it', async () => {
    const view = await mount();
    view.rerender(<Harness spec={exploreMapSpec()} />);
    expect(visibility('sub-area-label')).toBe('none');
    expect(visibility('landmark-label')).toBe('none');
    expect(map().layers.get('water-selected')?.filter).toEqual(['==', ['get', '_id'], '']);
  });

  it('keeps a viewer’s switch off even where the view asks for the layer', async () => {
    useSkaterMapStore.setState({ layers: { ...DEFAULT_MAP_LAYERS, places: false } });
    await mount();
    expect(visibility('sub-area-label')).toBe('none');
  });

  it('frames the lake once its bounds arrive, and doesn’t again for the same key', async () => {
    results.delete('waterBodies:get');
    const view = await mount();
    expect(map().fitBounds).not.toHaveBeenCalled();
    results.set('waterBodies:get', { available: true, body: MASCOMA });
    view.rerender(<Harness spec={lakeMapSpec('mascoma')} />);
    expect(map().fitBounds).toHaveBeenCalledOnce();
    // The first frame of the session jumps; there's nothing to animate from.
    expect(map().fitBounds.mock.calls[0]?.[1]).toMatchObject({ animate: false });
    view.rerender(<Harness spec={panelMapSpec('mascoma', { hazardId: 'h1' })} />);
    expect(map().fitBounds).toHaveBeenCalledOnce();
  });

  it('frames bounds, a point and the region', async () => {
    const view = await mount(
      defineMapSpec({
        id: 'a',
        fit: {
          kind: 'bounds',
          key: 'k',
          bounds: [
            [-73, 43],
            [-72, 44],
          ],
        },
      }),
    );
    expect(map().fitBounds).toHaveBeenCalledWith(
      [
        [-73, 43],
        [-72, 44],
      ],
      expect.anything(),
    );
    view.rerender(
      <Harness
        spec={defineMapSpec({
          id: 'b',
          fit: { kind: 'point', key: 'p', lng: -72, lat: 43, zoom: 12 },
        })}
      />,
    );
    expect(map().flyTo).toHaveBeenCalledWith(
      expect.objectContaining({ center: [-72, 43], zoom: 12 }),
    );
    view.rerender(
      <Harness
        spec={defineMapSpec({ id: 'c', fit: { kind: 'point', key: 'q', lng: -71, lat: 42 } })}
      />,
    );
    expect(map().flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: 8 }));
    view.rerender(<Harness spec={defineMapSpec({ id: 'd', fit: { kind: 'region' } })} />);
    expect(map().flyTo).toHaveBeenCalledTimes(3);
  });

  it('frames a bay: the rest of its lake under the scrim, the bay’s edge solid', async () => {
    await mount(lakeMapSpec('mascoma', 'north'));
    expect(JSON.stringify(map().layers.get('sub-area-scrim')?.filter)).toContain('"north"');
    expect(JSON.stringify(map().layers.get('sub-area-selected')?.filter)).toContain('"north"');
  });

  it('turns interactions off, and puts a crosshair up for a capture', async () => {
    await mount(
      defineMapSpec({ id: 'x', interactions: { pan: false, zoom: false, click: 'capture' } }),
    );
    expect(map().dragPan.enabled).toBe(false);
    expect(map().scrollZoom.enabled).toBe(false);
    expect(map().keyboard.enabled).toBe(false);
    expect(map().canvas.style.cursor).toBe('crosshair');
  });

  it('feeds a view’s overlay into its source, and clears it when the view drops it', async () => {
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
      ],
    };
    const view = await mount(panelMapSpec('mascoma', { photos: { key: 'r1', data } }));
    expect(map().sources.get('photo-pins')).toBe(data);
    view.rerender(<Harness spec={panelMapSpec('mascoma')} />);
    expect((map().sources.get('photo-pins') as GeoJSON.FeatureCollection).features).toHaveLength(0);
  });

  it('re-applies everything on a theme switch, without framing the lake again', async () => {
    const view = await mount();
    expect(map().fitBounds).toHaveBeenCalledOnce();
    theme.resolvedTheme = 'light';
    view.rerender(<Harness spec={lakeMapSpec('mascoma')} />);
    expect(FakeMap.instances).toHaveLength(2);
    await act(async () => {
      map().fire('load');
    });
    expect(visibility('sub-area-label')).toBe('visible');
    expect(map().fitBounds).not.toHaveBeenCalled();
  });

  it('resizes a pane that comes back from hidden', async () => {
    const view = await mount(defineMapSpec({ id: 'hidden', visible: false }));
    view.rerender(<Harness spec={exploreMapSpec()} />);
    expect(map().resize).toHaveBeenCalled();
  });
});

describe('data into the map', () => {
  it('fills the water, the hazards and the walk, and hands the rows to the sidebar', async () => {
    await mount();
    expect((map().sources.get('water') as GeoJSON.FeatureCollection).features).toHaveLength(2);
    expect((map().sources.get('hazards') as GeoJSON.FeatureCollection).features).toHaveLength(1);
    expect(useSkaterMapStore.getState().viewportLakes).toHaveLength(2);
  });

  it('draws every lake’s hazards in view, the open lake’s from its own read, and never twice', async () => {
    const viewportHazard = (id: string, waterBodyId: string, lng: number, lat: number) => ({
      _id: id,
      waterBodyId,
      type: 'thin_ice',
      geometryKind: 'polygon',
      geometry: ring(lng, lat, 0.002),
      freshness: 'fresh',
      provisional: false,
    });
    // At the cap: every row it has still draws.
    results.set('hazards:listInViewport', {
      hazards: [
        viewportHazard('h1', 'mascoma', -72.14, 43.61),
        viewportHazard('h9', 'crystal', -72.09, 43.59),
      ],
      truncated: true,
    });
    await mount();
    expect(queryArgs.get('hazards:listInViewport')).toEqual({ viewport: expect.any(Object) });
    // Mascoma's from its own read (h1), Crystal's from the viewport (h9): two, not three.
    expect((map().sources.get('hazards') as GeoJSON.FeatureCollection).features).toHaveLength(2);
    // The region with no lake open: the viewport read alone.
    await mount(exploreMapSpec());
    expect((map().sources.get('hazards') as GeoJSON.FeatureCollection).features).toHaveLength(2);
  });

  it('skips every read while the pane is hidden', async () => {
    await mount(defineMapSpec({ id: 'hidden', visible: false }));
    expect(queryArgs.get('waterBodies:listInViewport')).toBe('skip');
    expect(queryArgs.get('waterBodyFavorites:listForUser')).toBe('skip');
    expect(queryArgs.get('hazards:listInViewport')).toBe('skip');
    expect(useSkaterMapStore.getState().viewportLakes).toBeNull();
  });

  it('reads report counts for the labeled bodies only, and draws their labels', async () => {
    await mount();
    expect(queryArgs.get('reports:recentCountsForBodies')).toEqual({ waterBodyIds: ['crystal'] });
    expect(screen.getByText('Crystal Lake')).toBeInTheDocument();
    expect(screen.getByText('1 report · today')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '2 open bounties' })).toBeInTheDocument();
    // The focused lake carries no label: it is the view.
    expect(
      screen.queryByText('Mascoma Lake', { selector: '[data-slot="lake-label-name"]' }),
    ).toBeNull();
  });

  it('re-reads "today" against the clock, so a report from before midnight stops claiming it', async () => {
    const lateEvening = new Date(2026, 1, 16, 23, 30).getTime();
    vi.setSystemTime(lateEvening);
    results.set('reports:recentCountsForBodies', {
      crystal: { count: 1, capped: false, newestSkateEndTime: lateEvening - 30 * 60_000 },
    });
    await mount();
    expect(screen.getByText('1 report · today')).toBeInTheDocument();
    // The canvas outlives the day it mounted on: an hour later it is tomorrow.
    await act(async () => {
      vi.advanceTimersByTime(LABEL_CLOCK_MS * 61);
    });
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(lateEvening);
    expect(screen.getByText(`1 report · ${weekday}`)).toBeInTheDocument();
  });

  it('dims bodies the weather filter didn’t match', async () => {
    feedFilters.value = { weather: { kind: 'freeze' } };
    results.set('weatherDiscovery:matchedCells', { cellKeys: [], bayBodyIds: [] });
    results.set('profiles:current', { timezone: 'America/New_York' });
    await mount(exploreMapSpec());
    const props = (map().sources.get('water') as GeoJSON.FeatureCollection).features.map(
      (f) => f.properties?.weatherDimmed,
    );
    expect(props).toEqual([true, true]);
  });

  it('draws the put-in and hazard marks, and opens a hazard from its mark', async () => {
    await mount();
    expect(screen.getByRole('img', { name: 'Put-in: Boat launch' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Hazard: Open water/ }));
    expect(navigate).toHaveBeenCalledWith({
      to: '/hazard/$id',
      params: { id: 'h1' },
      state: { panelSource: 'map' },
    });
  });

  it('draws the lake’s tracks once the viewer turns them on, faded by the server’s freshness', async () => {
    useSkaterMapStore.setState({ layers: { ...DEFAULT_MAP_LAYERS, tracks: true } });
    results.set('gpsActivities:listTracksForBody', {
      tracks: [
        {
          path: {
            type: 'LineString',
            coordinates: [
              [-72.14, 43.61],
              [-72.13, 43.61],
            ],
          },
          opacity: 0.4,
        },
      ],
    });
    await mount();
    expect(visibility('track-line')).toBe('visible');
    const tracks = map().sources.get('tracks') as GeoJSON.FeatureCollection;
    expect(tracks.features[0]?.properties).toEqual({ opacity: 0.4 });
  });

  it('keeps labels out from under the dock', async () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        // The dock measures as covering the whole pane; everything else is jsdom's zero box.
        const width = this.getAttribute('data-slot') === 'map-dock' ? 1000 : 0;
        return {
          left: 0,
          top: 0,
          right: 1000,
          bottom: 800,
          width,
          height: 800,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });
    await mount(exploreMapSpec());
    const label = screen
      .getByText('Crystal Lake')
      .closest('[data-slot="lake-label"]') as HTMLElement;
    expect(label.style.visibility).toBe('hidden');
    rect.mockRestore();
  });

  it('hides the put-ins with their switch, and their key with them', async () => {
    useSkaterMapStore.setState({ layers: { ...DEFAULT_MAP_LAYERS, putIns: false } });
    await mount();
    expect(screen.queryByRole('img', { name: /Put-in/ })).toBeNull();
    expect(screen.getByRole('list', { name: 'Map key' })).not.toHaveTextContent('Put-in');
  });

  it('keys the marks it draws along its foot', async () => {
    await mount();
    const key = screen.getByRole('list', { name: 'Map key' });
    expect(key).toHaveTextContent('Put-in');
    expect(key).toHaveTextContent('Hazard');
    expect(key).not.toHaveTextContent('Track');
  });

  it('keys a track a view draws over the lake', async () => {
    const spec = lakeMapSpec('mascoma');
    await mount({
      ...spec,
      overlays: {
        ...spec.overlays,
        track: {
          key: 't1',
          data: {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'LineString',
                  coordinates: [
                    [-72.14, 43.61],
                    [-72.13, 43.61],
                  ],
                },
              },
            ],
          },
        },
      },
    });
    expect(screen.getByRole('list', { name: 'Map key' })).toHaveTextContent('Track');
  });

  it('shows the hover both ways', async () => {
    await mount();
    act(() => useSkaterMapStore.getState().setHoveredBodyId('crystal'));
    expect(map().layers.get('water-hover')?.filter).toEqual(['==', ['get', '_id'], 'crystal']);
    act(() =>
      map().layerHandlers.get('mousemove:water-fill')?.({
        features: [{ properties: { _id: 'mascoma' } }],
      }),
    );
    expect(useSkaterMapStore.getState().hoveredBodyId).toBe('mascoma');
    expect(map().canvas.style.cursor).toBe('pointer');
    act(() => map().layerHandlers.get('mousemove:water-fill')?.({ features: [] }));
    expect(useSkaterMapStore.getState().hoveredBodyId).toBeNull();
    act(() => map().layerHandlers.get('mouseleave:water-fill')?.());
    expect(map().canvas.style.cursor).toBe('');
  });
});

describe('depth', () => {
  it('filters the contours to the lake, fades them in once readable, and passes the credit on', async () => {
    await mount();
    expect(map().layers.get(CONTOUR_LAYER_ID)?.filter).toEqual([
      '==',
      ['get', 'bodyId'],
      'way/123',
    ]);
    expect(map().layers.get(CONTOUR_LAYER_ID)?.paint['line-opacity']).toBe(0);
    map().sourceFeatures = [
      {
        properties: {
          bodyId: 'way/123',
          depthFt: 30,
          agency: 'NH GRANIT',
          state: 'NH',
          lane: 'surveyed',
          intervalFt: 10,
        },
      },
    ];
    act(() => map().fire('sourcedata', { sourceId: 'roads' }));
    expect(map().layers.get(CONTOUR_LAYER_ID)?.paint['line-opacity']).toBe(0);
    act(() => map().fire('sourcedata', { sourceId: 'bathymetry' }));
    expect(map().layers.get(CONTOUR_LAYER_ID)?.paint['line-opacity']).toBe(0.75);
    expect(useSkaterMapStore.getState().contourCredit).toBeTruthy();
    // The lake takes the shallow band's fill under its rings, and the legend shows.
    expect(JSON.stringify(map().layers.get('water-fill')?.paint['fill-color'])).toContain(
      'mascoma',
    );
    expect(screen.getByRole('img', { name: /Depth bands/ })).toBeInTheDocument();
  });

  it('stands the contours and the band fills down with the imagery on (D81)', async () => {
    useSkaterMapStore.setState({ layers: { ...DEFAULT_MAP_LAYERS, imagery: true } });
    await mount();
    map().bandFeatures = [band(0), band(2)];
    act(() => map().fire('sourcedata', { sourceId: 'bathymetry' }));
    for (const id of [CONTOUR_LAYER_ID, BANDS_LAYER_ID]) {
      expect(visibility(id)).toBe('none');
      expect(map().layers.get(id)?.filter).toEqual(NO_LAKE);
    }
    expect(map().layers.get(BANDS_LAYER_ID)?.paint['fill-opacity']).toBe(0);
  });

  it('stands the lake’s water fill down under the picture, and brings it back after', async () => {
    const fillUnder = () => {
      const opacity = map().layers.get('water-fill')?.paint['fill-opacity'] as unknown[];
      return opacity[1] as unknown[];
    };
    useSkaterMapStore.setState({ layers: { ...DEFAULT_MAP_LAYERS, imagery: true } });
    await mount();
    expect(fillUnder().slice(0, 3)).toEqual(['case', ['==', ['get', '_id'], 'mascoma'], 0]);
    act(() => useSkaterMapStore.setState({ layers: { ...DEFAULT_MAP_LAYERS, imagery: false } }));
    expect(fillUnder().slice(0, 3)).toEqual(['case', ['==', ['get', '_id'], ''], 0]);
  });

  it('keeps the hazard marks on over the picture, and fades only the one under the mouse', async () => {
    useSkaterMapStore.setState({ layers: { ...DEFAULT_MAP_LAYERS, imagery: true } });
    await mount();
    const mark = screen.getByRole('button', { name: /Hazard: Open water/ });
    expect(mark).not.toHaveAttribute('data-peek');
    fireEvent.pointerEnter(mark, { pointerType: 'mouse' });
    expect(mark).toHaveAttribute('data-peek');
    act(() => useSkaterMapStore.setState({ layers: { ...DEFAULT_MAP_LAYERS, imagery: false } }));
    expect(mark).not.toHaveAttribute('data-peek');
  });
});

const NO_LAKE = ['==', ['literal', true], ['literal', false]];
// Mascoma's shape (BANDS.md): contoured every 10 ft, so no band 1, and the deepest open-ended.
const MASCOMA_BANDS: Record<number, { minDepthFt: number; maxDepthFt?: number }> = {
  0: { minDepthFt: 0, maxDepthFt: 10 },
  2: { minDepthFt: 10, maxDepthFt: 20 },
  3: { minDepthFt: 20, maxDepthFt: 30 },
  6: { minDepthFt: 70 },
};
const band = (bandIndex: number) => ({
  properties: { bodyId: 'way/123', bandIndex, lane: 'surveyed', ...MASCOMA_BANDS[bandIndex] },
});

describe('depth bands (B03 §2)', () => {
  const opacity = () => map().layers.get(BANDS_LAYER_ID)?.paint['fill-opacity'];

  it('adds the band fills on the water, under the contour lines', async () => {
    await mount();
    const ids = [...map().layers.keys()];
    expect(ids.indexOf(BANDS_LAYER_ID)).toBeGreaterThan(ids.indexOf('water-fill'));
    expect(ids.indexOf(BANDS_LAYER_ID)).toBeLessThan(ids.indexOf(CONTOUR_LAYER_ID));
    // The lines' archive, not a second one.
    expect([...map().sources.keys()].filter((id) => id.startsWith('bathymetry'))).toEqual([
      'bathymetry',
    ]);
  });

  it('filters the bands to the lake on the contours’ key and fades them in once readable', async () => {
    await mount();
    expect(visibility(BANDS_LAYER_ID)).toBe('visible');
    expect(map().layers.get(BANDS_LAYER_ID)?.filter).toEqual(['==', ['get', 'bodyId'], 'way/123']);
    expect(opacity()).toBe(0);
    expect(screen.queryByRole('img', { name: /Depth bands/ })).not.toBeInTheDocument();
    map().bandFeatures = [band(0), band(2), band(6), band(0)];
    act(() => map().fire('sourcedata', { sourceId: 'bathymetry' }));
    expect(opacity()).toBe(1);
    // Bands alone are depth on screen: the shallow ground under them, and the legend.
    expect(JSON.stringify(map().layers.get('water-fill')?.paint['fill-color'])).toContain(
      'mascoma',
    );
    // The legend reads the lake's real band depths, once per band however many tiles it spans.
    expect(
      screen.getByRole('img', { name: 'Depth bands: 0–10 ft, 10–20 ft, 70+ ft' }),
    ).toBeInTheDocument();
    // Polygons carry no agency, so they credit nobody rather than inventing one.
    expect(useSkaterMapStore.getState().contourCredit).toBeNull();
  });

  it('ignores other sources’ data', async () => {
    await mount();
    map().bandFeatures = [band(0)];
    act(() => map().fire('sourcedata', { sourceId: 'water' }));
    expect(opacity()).toBe(0);
  });

  it('credits the lines’ agency, never the bands’', async () => {
    await mount();
    map().bandFeatures = [band(2)];
    map().sourceFeatures = [
      { properties: { bodyId: 'way/123', depthFt: 10, agency: 'NH GRANIT', lane: 'surveyed' } },
    ];
    act(() => map().fire('sourcedata', { sourceId: 'bathymetry' }));
    expect(useSkaterMapStore.getState().contourCredit).toContain('NH GRANIT');
    expect(opacity()).toBe(1);
  });

  it('keeps today’s look for a lake without band polygons: the shallow fill under its lines', async () => {
    await mount();
    map().sourceFeatures = [{ properties: { bodyId: 'way/123', depthFt: 5 } }];
    act(() => map().fire('sourcedata', { sourceId: 'bathymetry' }));
    expect(opacity()).toBe(0);
    expect(map().layers.get(CONTOUR_LAYER_ID)?.paint['line-opacity']).toBe(0.75);
    expect(JSON.stringify(map().layers.get('water-fill')?.paint['fill-color'])).toContain(
      'mascoma',
    );
  });

  it('takes the bands away with the Depth switch, and brings them back', async () => {
    await mount();
    map().bandFeatures = [band(0), band(2)];
    act(() => map().fire('sourcedata', { sourceId: 'bathymetry' }));
    expect(opacity()).toBe(1);
    act(() => useSkaterMapStore.getState().toggleLayer('depth'));
    expect(visibility(BANDS_LAYER_ID)).toBe('none');
    expect(map().layers.get(BANDS_LAYER_ID)?.filter).toEqual(NO_LAKE);
    expect(opacity()).toBe(0);
    expect(JSON.stringify(map().layers.get('water-fill')?.paint['fill-color'])).not.toContain(
      'mascoma',
    );
    expect(screen.queryByRole('img', { name: /Depth bands/ })).not.toBeInTheDocument();
    act(() => useSkaterMapStore.getState().toggleLayer('depth'));
    expect(visibility(BANDS_LAYER_ID)).toBe('visible');
    expect(opacity()).toBe(1);
  });

  it('draws no bands off a lake: the region map has none', async () => {
    await mount(exploreMapSpec());
    expect(map().layers.get(BANDS_LAYER_ID)?.filter).toEqual(NO_LAKE);
    expect(opacity()).toBe(0);
  });
});

describe('clicks', () => {
  const click = (hits: unknown[]) => {
    map().rendered = hits;
    act(() => map().fire('click', { point: { x: 1, y: 1 }, lngLat: { lng: -72.2, lat: 43.7 } }));
  };

  it('opens a hazard over the lake it lies in, then a lake', async () => {
    await mount();
    click([
      { layer: { id: 'hazard-fill' }, properties: { hazardId: 'h1' } },
      { layer: { id: 'water-fill' }, source: 'water', properties: { _id: 'mascoma' } },
    ]);
    expect(navigate).toHaveBeenLastCalledWith({
      to: '/hazard/$id',
      params: { id: 'h1' },
      state: { panelSource: 'map' },
    });
    click([{ layer: { id: 'water-fill' }, source: 'water', properties: { _id: 'crystal' } }]);
    expect(navigate).toHaveBeenLastCalledWith({ to: '/water/$id', params: { id: 'crystal' } });
  });

  it('asks for a lake on unlisted water, never in the URL', async () => {
    await mount(exploreMapSpec());
    click([{ source: 'protomaps', sourceLayer: 'water', layer: { id: 'water' } }]);
    // With where it landed on screen (the canvas point, in the viewport), for the dialog to open by.
    expect(useSkaterMapStore.getState().pendingMapClick).toEqual({
      lng: -72.2,
      lat: 43.7,
      screen: { x: 1, y: 1 },
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('asks on a right-click too, where the view takes requests', async () => {
    const view = await mount(exploreMapSpec());
    const preventDefault = vi.fn();
    const at = { preventDefault, point: { x: 5, y: 7 }, lngLat: { lng: -72, lat: 43 } };
    act(() => map().fire('contextmenu', at));
    expect(preventDefault).toHaveBeenCalled();
    expect(useSkaterMapStore.getState().pendingMapClick).toEqual({
      lng: -72,
      lat: 43,
      screen: { x: 5, y: 7 },
    });
    useSkaterMapStore.getState().setPendingMapClick(null);
    view.rerender(<Harness spec={defineMapSpec({ id: 'latest' })} />);
    act(() => map().fire('contextmenu', at));
    expect(useSkaterMapStore.getState().pendingMapClick).toBeNull();
  });

  it('hands the coordinate to the view in a capture mode', async () => {
    const onCapture = vi.fn();
    await mount(defineMapSpec({ id: 'place', interactions: { click: 'capture' } }), { onCapture });
    click([{ layer: { id: 'water-fill' }, source: 'water', properties: { _id: 'mascoma' } }]);
    expect(onCapture).toHaveBeenCalledWith({ lng: -72.2, lat: 43.7 });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does nothing on land', async () => {
    await mount(exploreMapSpec());
    click([{ source: 'protomaps', sourceLayer: 'roads' }]);
    expect(navigate).not.toHaveBeenCalled();
    expect(useSkaterMapStore.getState().pendingMapClick).toBeNull();
  });
});

describe('the camera', () => {
  it('writes the camera to the store once it rests, and reports the zoom’s ends', async () => {
    await mount();
    act(() => map().fire('moveend'));
    act(() => map().fire('moveend'));
    expect(useSkaterMapStore.getState().camera).toBeNull();
    act(() => {
      vi.advanceTimersByTime(CAMERA_WRITE_DELAY_MS);
    });
    expect(useSkaterMapStore.getState().camera).toEqual({ center: [-72.1, 43.6], zoom: 8 });
    expect(sessionStorage.getItem('gli-map-camera')).not.toBeNull();
    map().zoom = 22;
    act(() => map().fire('moveend'));
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
  });

  it('starts from this session’s camera', () => {
    useSkaterMapStore.setState({ camera: { center: [-71, 42], zoom: 10 } });
    render(<Harness spec={exploreMapSpec()} />);
    expect(map().options).toMatchObject({ center: [-71, 42], zoom: 10 });
  });

  it('knows when the region has left the screen, and flies home from the dock', async () => {
    await mount(exploreMapSpec());
    expect(useSkaterMapStore.getState().awayFromRegion).toBe(false);
    map().getBounds = () => ({
      getWest: () => -100,
      getSouth: () => 30,
      getEast: () => -99,
      getNorth: () => 31,
    });
    act(() => map().fire('moveend'));
    expect(useSkaterMapStore.getState().awayFromRegion).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: /Back to the Northeast/ }));
    expect(map().flyTo).toHaveBeenCalledWith(expect.objectContaining({ duration: 900 }));
    expect(capture).toHaveBeenCalledWith('return_to_region_used');
  });

  it('zooms from the dock', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(map().zoomIn).toHaveBeenCalledOnce();
    expect(map().zoomOut).toHaveBeenCalledOnce();
  });
});

describe('location', () => {
  const geo = (impl: (ok: PositionCallback, err: PositionErrorCallback) => void) => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: impl },
    });
  };
  const at = (lat: number, lng: number) =>
    ({ coords: { latitude: lat, longitude: lng } }) as GeolocationPosition;

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'geolocation');
  });

  it('frames on the skater’s own water on first open, when they’re in the region', async () => {
    geo((ok) => ok(at(43.6, -72.1)));
    await mount(exploreMapSpec());
    expect(map().jumpTo).toHaveBeenCalledWith(expect.objectContaining({ center: [-72.1, 43.6] }));
  });

  /** A device that answers when the test says so — eight seconds late, at worst. */
  const lateGeo = () => {
    let answer: (pos: GeolocationPosition) => void = () => undefined;
    geo((ok) => {
      answer = ok;
    });
    return (pos: GeolocationPosition) => act(() => answer(pos));
  };

  it('frames on a late answer when nothing moved meanwhile', async () => {
    const answer = lateGeo();
    await mount(exploreMapSpec());
    answer(at(43.6, -72.1));
    expect(map().jumpTo).toHaveBeenCalledWith(expect.objectContaining({ center: [-72.1, 43.6] }));
  });

  it('drops a late answer once the skater has moved the map', async () => {
    const answer = lateGeo();
    await mount(exploreMapSpec());
    act(() => map().fire('movestart'));
    answer(at(43.6, -72.1));
    expect(map().jumpTo).not.toHaveBeenCalled();
    // And it stops listening: the listener goes with the answer.
    expect(map().handlers.get('movestart') ?? []).toHaveLength(0);
  });

  it('drops a late answer once a view that frames itself has opened', async () => {
    const answer = lateGeo();
    const view = await mount(exploreMapSpec());
    view.rerender(<Harness spec={lakeMapSpec('mascoma')} />);
    answer(at(43.6, -72.1));
    expect(map().jumpTo).not.toHaveBeenCalled();
  });

  it('drops a late answer once a camera has been kept this session', async () => {
    const answer = lateGeo();
    await mount(exploreMapSpec());
    act(() => useSkaterMapStore.setState({ camera: { center: [-72, 43], zoom: 9 } }));
    answer(at(43.6, -72.1));
    expect(map().jumpTo).not.toHaveBeenCalled();
  });

  it('stops listening when the device can’t say', async () => {
    geo((_ok, err) => err({} as GeolocationPositionError));
    await mount(exploreMapSpec());
    expect(map().handlers.get('movestart') ?? []).toHaveLength(0);
    expect(map().jumpTo).not.toHaveBeenCalled();
  });

  it('doesn’t ask on a view that frames itself', async () => {
    const ask = vi.fn();
    geo(ask);
    await mount();
    expect(ask).not.toHaveBeenCalled();
  });

  it('flies to the skater from the dock, or says why it can’t', async () => {
    geo((ok) => ok(at(43.6, -72.1)));
    useSkaterMapStore.setState({ camera: { center: [-72, 43], zoom: 9 } });
    await mount(exploreMapSpec());
    fireEvent.click(screen.getByRole('button', { name: 'Your location' }));
    expect(map().flyTo).toHaveBeenCalledWith(expect.objectContaining({ center: [-72.1, 43.6] }));

    geo((ok) => ok(at(37.7, -122.4)));
    fireEvent.click(screen.getByRole('button', { name: 'Your location' }));
    expect(toast).toHaveBeenLastCalledWith({ title: expect.stringMatching(/outside the area/) });

    geo((_ok, err) => err({} as GeolocationPositionError));
    fireEvent.click(screen.getByRole('button', { name: 'Your location' }));
    expect(toast).toHaveBeenLastCalledWith({ title: 'Couldn’t get your location.' });

    Reflect.deleteProperty(navigator, 'geolocation');
    fireEvent.click(screen.getByRole('button', { name: 'Your location' }));
    expect(toast).toHaveBeenLastCalledWith({ title: expect.stringMatching(/isn’t available/) });
  });
});

describe('modes and handlers', () => {
  it('shows the mode bar and leaves the mode by its button or Esc', async () => {
    const onExitMode = vi.fn();
    await mount(
      defineMapSpec({
        id: 'place',
        mode: { mode: 'Place a spot', line: 'Click the ice', step: 'Step 1 of 3' },
      }),
      {
        onExitMode,
      },
    );
    expect(screen.getByText('Place a spot')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Leave the mode' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onExitMode).toHaveBeenCalledTimes(2);
  });

  it('names the mode bar’s exit as the mode says', async () => {
    await mount(
      defineMapSpec({ id: 'place', mode: { mode: 'Placing a spot', exitLabel: 'Close' } }),
    );
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Leave the mode' })).toBeNull();
  });

  it('shows the imagery entry when the view has a flow for it', async () => {
    const onOpenImagery = vi.fn();
    await mount(lakeMapSpec('mascoma'), { onOpenImagery });
    fireEvent.click(screen.getByRole('button', { name: /Latest imagery/ }));
    expect(onOpenImagery).toHaveBeenCalledOnce();
  });
});
