/**
 * The theme switched from the viewer's menu while the Body console's map is mounted (the B03 §8.5
 * crash: a state flag read in the scheduling render guarded a ref rewritten in the commit).
 *
 * Real from the menu down to MapLibre's door: the menu, the app's theme provider, the Body map's
 * canvas (`useBodyMapCanvas`) on the shared shell (`useMapCanvas`). Only `maplibre-gl` is faked —
 * as MapLibre does where it bit, **every style write before `load` or after `remove` throws**.
 *
 * What holds: nothing throws; the page holding the map is never remounted (its state survives);
 * the shell rebuilds the basemap for the new mode by design (its style is built per flavor) at the
 * operator's own view, and the console's layers are painted for the new mode only once that map
 * can take a write.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Component, type ReactNode, useEffect, useMemo } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = () => void;

class FakeMap {
  static instances: FakeMap[] = [];
  options: { center: [number, number]; zoom: number; style: unknown };
  styleLoaded = false;
  removed = false;
  writesBeforeLoad = 0;
  handlers = new Map<string, Set<Handler>>();
  sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>();
  layers = new Map<string, { paint: Record<string, unknown> }>();
  order: string[] = [];
  center: { lng: number; lat: number };
  zoom: number;
  minZoom = 0;
  maxZoom = 22;
  touchZoomRotate = { disableRotation() {} };
  keyboard = { disableRotation() {} };

  constructor(options: FakeMap['options']) {
    this.options = options;
    this.center = { lng: options.center[0], lat: options.center[1] };
    this.zoom = options.zoom;
    FakeMap.instances.push(this);
  }
  private check() {
    if (!this.styleLoaded || this.removed) {
      this.writesBeforeLoad++;
      throw new Error('Style is not done loading.');
    }
  }
  on(event: string, fn: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)?.add(fn);
  }
  off(event: string, fn: Handler) {
    this.handlers.get(event)?.delete(fn);
  }
  addControl() {}
  remove() {
    this.removed = true;
    this.styleLoaded = false;
  }
  resize() {}
  fitBounds() {}
  getCenter() {
    return this.center;
  }
  getZoom() {
    return this.zoom;
  }
  getBounds() {
    return {
      getSouth: () => 43.6,
      getWest: () => -72.2,
      getNorth: () => 43.7,
      getEast: () => -72.1,
    };
  }
  getContainer() {
    return { clientWidth: 656, clientHeight: 830 } as HTMLElement;
  }
  jumpTo({ center, zoom }: { center: [number, number]; zoom: number }) {
    this.center = { lng: center[0], lat: center[1] };
    this.zoom = zoom;
  }
  setMinZoom(z: number) {
    this.minZoom = z;
  }
  setMaxZoom(z: number) {
    this.maxZoom = z;
  }
  getMinZoom() {
    return this.minZoom;
  }
  getMaxZoom() {
    return this.maxZoom;
  }
  project([x, y]: [number, number]) {
    return { x, y };
  }
  unproject([lng, lat]: [number, number]) {
    return { lng, lat };
  }
  zoomIn() {}
  zoomOut() {}
  isSourceLoaded() {
    return true;
  }
  addSource(id: string, spec: { data: unknown }) {
    this.check();
    const src = {
      data: spec.data,
      setData: (d: unknown) => {
        this.check();
        src.data = d;
      },
    };
    this.sources.set(id, src);
  }
  getSource(id: string) {
    return this.sources.get(id);
  }
  addLayer(layer: { id: string; paint?: Record<string, unknown> }) {
    this.check();
    this.layers.set(layer.id, { paint: { ...(layer.paint ?? {}) } });
    this.order.push(layer.id);
  }
  getLayer(id: string) {
    return this.layers.get(id);
  }
  moveLayer() {
    this.check();
  }
  getLayersOrder() {
    return [...this.order];
  }
  setPaintProperty(id: string, prop: string, value: unknown) {
    this.check();
    const layer = this.layers.get(id);
    if (layer) layer.paint[prop] = value;
  }
  /** Fire `load` the way MapLibre does once the style is ready. */
  load() {
    this.styleLoaded = true;
    act(() => {
      for (const fn of this.handlers.get('load') ?? []) fn();
    });
  }
}

vi.mock('maplibre-gl', () => ({
  default: {
    Map: FakeMap,
    addProtocol: () => {},
    removeProtocol: () => {},
    AttributionControl: class {
      options: Record<string, unknown> = {};
    },
    NavigationControl: class {},
  },
}));
vi.mock('pmtiles', () => ({ Protocol: class {} }));
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: () => {} }),
}));
vi.mock('@/lib/sheetOwner', () => ({ useSignOut: () => async () => {} }));
vi.mock('@/lib/sheetStore', () => ({
  useSheet: () => null,
  useSheetAttempt: () => null,
  readStoredSheet: () => null,
}));

const { ThemeProvider, useTheme } = await import('@/components/theme-provider');
const { ConsoleUserMenu } = await import('./ConsoleUserMenu');
const { useBodyMapCanvas } = await import('../body/map/useBodyMapCanvas');
const { DEFAULT_LAYERS, drawScene } = await import('../body/map/bodyScene');
const { adminToken } = await import('../body/map/bodyMapPalette');
const { MASCOMA_BOUNDS, MASCOMA_SCENE } = await import('../body/frame/bodyFixtures');
const { THEME_COOKIE } = await import('@/lib/theme');

const OUTLINE = 'body-console-outline-body';
let mounts = 0;
const errors: unknown[] = [];

/** Holds what a render or an effect threw, so the test can say "nothing" rather than crash. */
class Catch extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    errors.push(error);
  }
  override render() {
    return this.state.failed ? <p>crashed</p> : this.props.children;
  }
}

/** The Body console's map as its route draws it: the mode from the provider's resolved theme. */
function BodyMap() {
  const { resolvedTheme } = useTheme();
  const mode = resolvedTheme === 'light' ? 'light' : 'dark';
  const drawn = useMemo(() => drawScene(MASCOMA_SCENE, DEFAULT_LAYERS), []);
  const canvas = useBodyMapCanvas({ bbox: MASCOMA_BOUNDS, mode, drawn });
  useEffect(() => {
    mounts++;
  }, []);
  return (
    <div>
      {canvas.ground}
      <span data-testid="surface">{canvas.surface ? 'live' : 'waiting'}</span>
    </div>
  );
}

function clearTheme() {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API
  document.cookie = `${THEME_COOKIE}=; path=/; max-age=0`;
  document.documentElement.removeAttribute('data-mode');
  document.documentElement.classList.remove('dark');
}

beforeAll(() => {
  Element.prototype.animate ??= (() => ({ cancel() {}, startTime: 0 })) as never;
});
beforeEach(() => {
  FakeMap.instances = [];
  mounts = 0;
  errors.length = 0;
  clearTheme();
});
afterEach(clearTheme);

const live = () => FakeMap.instances.at(-1) as FakeMap;

describe('a theme switch from the menu with the Body map mounted', () => {
  it('neither crashes nor remounts the page, and repaints the new map once it can take it', async () => {
    render(
      <ThemeProvider>
        <ConsoleUserMenu
          viewer={{ state: 'ready', id: 'p1', name: 'Robin Ashford' }}
          canOpenOwnPage
        />
        <Catch>
          <BodyMap />
        </Catch>
      </ThemeProvider>,
    );
    // The OS says light (the test setup's media query). The provider learns it in its first effect,
    // so the route's map is built once more for it on mount — before the viewer touches anything.
    await act(async () => {});
    const before = FakeMap.instances.length;
    const first = live();
    first.load();
    expect(first.layers.get(OUTLINE)?.paint['line-color']).toBe(adminToken('light', 'fg1'));
    await waitFor(() => expect(screen.getByTestId('surface')).toHaveTextContent('live'));
    // The operator pans and zooms; MapLibre reports it on `moveend`.
    first.jumpTo({ center: [-72.16, 43.64], zoom: 13.5 });
    act(() => {
      for (const fn of first.handlers.get('moveend') ?? []) fn();
    });

    await userEvent.click(screen.getByRole('button', { name: /^Your account/ }));
    const picker = (await screen.findByRole('menu')).querySelector<HTMLElement>(
      '[data-slot="theme-picker"]',
    );
    if (picker === null) throw new Error('no theme picker');
    await userEvent.click(within(picker).getByRole('button', { name: 'Dark' }));

    await waitFor(() => expect(FakeMap.instances.length).toBe(before + 1));
    const second = live();
    // Nothing threw, nothing was written to the old map after it went or the new one before load.
    expect(errors).toEqual([]);
    expect(screen.queryByText('crashed')).toBeNull();
    expect(first.removed).toBe(true);
    expect(first.writesBeforeLoad + second.writesBeforeLoad).toBe(0);
    expect(screen.getByTestId('surface')).toHaveTextContent('waiting');
    // The page holding the map was never remounted; the new basemap opens at the operator's view.
    expect(mounts).toBe(1);
    expect(second.options.center).toEqual([-72.16, 43.64]);
    expect(second.options.zoom).toBe(13.5);

    second.load();
    expect(second.layers.get(OUTLINE)?.paint['line-color']).toBe(adminToken('dark', 'fg1'));
    await waitFor(() => expect(screen.getByTestId('surface')).toHaveTextContent('live'));
    // Not re-framed on the body: the operator's own zoom stands.
    expect(second.zoom).toBe(13.5);
    expect(errors).toEqual([]);
    expect(second.writesBeforeLoad).toBe(0);
    expect(mounts).toBe(1);
  });
});
