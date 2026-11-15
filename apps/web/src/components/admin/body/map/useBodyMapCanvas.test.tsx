import { render } from '@testing-library/react';
import { useMemo } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { freezeUpLaneIds } from '@/components/useFreezeUpFrame';
import { MASCOMA_BOUNDS, MASCOMA_SCENE } from '../frame/bodyFixtures';
import { adminToken } from './bodyMapPalette';
import { DEFAULT_LAYERS, type DrawnScene, drawScene } from './bodyScene';
import { DOT_SOURCE, LINE_SOURCE, OUTLINE_SOURCE } from './glLayers';

/**
 * The console map's MapLibre half, against a fake map that behaves as MapLibre does where it bit the
 * skater map (B03 §8.5): **every style write before `load` or after `remove` throws**. The shell
 * (`useMapCanvas`) is replaced by one that hands out `liveMap` as the real one does — `null` until
 * the style loads, a fresh identity when it does.
 */

class FakeMap {
  loaded = false;
  removed = false;
  sources = new Map<string, { setData: (d: unknown) => void; data: unknown }>();
  layers = new Map<string, { paint: Record<string, unknown> }>();
  /** The layers' order, bottom to top, as MapLibre keeps it: `before` inserts under that layer. */
  order: string[] = [];
  handlers = new Map<string, Set<() => void>>();
  minZoom = 0;
  maxZoom = 22;
  zoom = 12;
  private check() {
    if (!this.loaded || this.removed) throw new Error('Style is not done loading.');
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
  addLayer(layer: { id: string; paint?: Record<string, unknown> }, before?: string) {
    this.check();
    this.layers.set(layer.id, { paint: { ...(layer.paint ?? {}) } });
    this.place(layer.id, before);
  }
  moveLayer(id: string, before?: string) {
    this.check();
    this.order = this.order.filter((l) => l !== id);
    this.place(id, before);
  }
  removeLayer(id: string) {
    this.layers.delete(id);
    this.order = this.order.filter((l) => l !== id);
  }
  removeSource(id: string) {
    this.sources.delete(id);
  }
  private place(id: string, before?: string) {
    const at = before === undefined ? -1 : this.order.indexOf(before);
    if (at < 0) this.order.push(id);
    else this.order.splice(at, 0, id);
  }
  getLayersOrder() {
    return [...this.order];
  }
  /** Every source's tiles are in, so a pass reveals (and is raised) as soon as it is added. */
  isSourceLoaded() {
    return true;
  }
  getLayer(id: string) {
    return this.layers.get(id);
  }
  setPaintProperty(id: string, prop: string, value: unknown) {
    this.check();
    const l = this.layers.get(id);
    if (l) l.paint[prop] = value;
  }
  getContainer() {
    return { clientWidth: 656, clientHeight: 830 } as HTMLElement;
  }
  jumpTo({ zoom }: { zoom: number }) {
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
  }
  // MapLibre's own rules: a floor over the ceiling, or a ceiling under the floor, throws.
  setMinZoom(z: number) {
    if (z < 0 || z > this.maxZoom) throw new Error('minZoom must be between 0 and the maxZoom');
    this.minZoom = z;
  }
  setMaxZoom(z: number) {
    if (z < this.minZoom) throw new Error('maxZoom must be greater than the current minZoom');
    this.maxZoom = z;
  }
  getMinZoom() {
    return this.minZoom;
  }
  getMaxZoom() {
    return this.maxZoom;
  }
  getZoom() {
    return this.zoom;
  }
  getCenter() {
    return { lng: -72.15, lat: 43.63 };
  }
  project([lng, lat]: [number, number]) {
    return { x: lng, y: lat };
  }
  unproject([x, y]: [number, number]) {
    return { lng: x, lat: y };
  }
  zoomIn = vi.fn();
  zoomOut = vi.fn();
  on(ev: string, fn: () => void) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)?.add(fn);
  }
  off(ev: string, fn: () => void) {
    this.handlers.get(ev)?.delete(fn);
  }
}

const shell = vi.hoisted(() => ({
  map: null as FakeMap | null,
  live: false,
  onLoad: null as ((m: FakeMap) => void) | null,
}));

vi.mock('@/lib/mapCanvas', () => ({
  MAP_CONTAINER_CLASS: 'size-full',
  useMapCanvas: (opts: { onLoad: (m: FakeMap) => void }) => {
    shell.onLoad = opts.onLoad;
    const live = shell.live;
    const map = shell.map;
    // A fresh identity per readiness, as the real accessor has.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the fake shell's readiness is read per render, as the real hook's state is.
    const liveMap = useMemo(() => () => (live ? map : null), [live, map]);
    return { containerRef: { current: null }, mapRef: { current: map }, loaded: live, liveMap };
  },
}));

// The archive is configured, so a scene's pass is painted (the reveal draws nothing without it).
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'imageryArchiveUrl' ? 'https://archive.example' : Reflect.get(target, key),
    }),
  };
});

const { useBodyMapCanvas } = await import('./useBodyMapCanvas');

/** Imagery's lit pass, as its scene hands it to the frame. */
const PASS: NonNullable<DrawnScene['raster']> = {
  kind: 'raster',
  id: 'pass:visual.S2C_A',
  layer: 'aerial',
  granuleId: 'S2C_A',
  band: 'visual',
  capturedAt: '2026-12-22T15:51:05Z',
  key: 'frames/winter-2026-27/S2C_A-visual.pmtiles',
  season: 'winter-2026-27',
};

function Harness({
  mode,
  bbox = MASCOMA_BOUNDS,
  raster = null,
}: {
  mode: 'dark' | 'light';
  bbox?: typeof MASCOMA_BOUNDS;
  raster?: DrawnScene['raster'];
}) {
  const drawn = useMemo(() => ({ ...drawScene(MASCOMA_SCENE, DEFAULT_LAYERS), raster }), [raster]);
  const canvas = useBodyMapCanvas({ bbox, mode, drawn });
  return <div data-testid="zoom">{canvas.surface ? 'live' : 'waiting'}</div>;
}

beforeEach(() => {
  shell.map = new FakeMap();
  shell.live = false;
  shell.onLoad = null;
});

describe('useBodyMapCanvas', () => {
  it('writes nothing to a map whose style has not loaded', () => {
    // The fake throws on any early write; rendering without one proves nothing was attempted.
    const { getByTestId } = render(<Harness mode="dark" />);
    expect(getByTestId('zoom').textContent).toBe('waiting');
    expect(shell.map?.sources.size).toBe(0);
  });

  it('adds its sources and layers on load, framed and fenced to the body', () => {
    const map = shell.map as FakeMap;
    const { rerender, getByTestId } = render(<Harness mode="dark" />);
    map.loaded = true;
    shell.onLoad?.(map);
    shell.live = true;
    rerender(<Harness mode="dark" />);
    expect([...map.sources.keys()]).toEqual([OUTLINE_SOURCE, LINE_SOURCE, DOT_SOURCE]);
    expect(map.layers.has('body-console-outline-body')).toBe(true);
    expect(map.minZoom).toBeCloseTo(map.zoom - 1.5, 6);
    expect(map.maxZoom).toBe(17);
    expect(getByTestId('zoom').textContent).toBe('live');
  });

  it('repaints for the mode once the map can take it — and never on a dead map', () => {
    const map = shell.map as FakeMap;
    const { rerender } = render(<Harness mode="dark" />);
    map.loaded = true;
    shell.onLoad?.(map);
    shell.live = true;
    rerender(<Harness mode="dark" />);
    expect(map.layers.get('body-console-outline-body')?.paint['line-color']).toBe(
      adminToken('dark', 'fg1'),
    );

    // A theme switch: the shell re-creates the map, so the old one is gone and the new one is not
    // ready — `liveMap` is null in that commit, and the palette effect must not touch either.
    map.removed = true;
    const next = new FakeMap();
    shell.map = next;
    shell.live = false;
    expect(() => rerender(<Harness mode="light" />)).not.toThrow();

    next.loaded = true;
    shell.onLoad?.(next);
    shell.live = true;
    rerender(<Harness mode="light" />);
    expect(next.layers.get('body-console-outline-body')?.paint['line-color']).toBe(
      adminToken('light', 'fg1'),
    );
  });

  it('lays a pass over the body’s fill and under the fields, the shore and every line', () => {
    const map = shell.map as FakeMap;
    const { rerender } = render(<Harness mode="dark" raster={PASS} />);
    map.loaded = true;
    shell.onLoad?.(map);
    shell.live = true;
    rerender(<Harness mode="dark" raster={PASS} />);
    // Added under the contract's next band, then raised there as its tiles report: both placements
    // read the console's order, never the reveal's own anchor (under the roads, so under the fill).
    const order = map.getLayersOrder();
    const pass = order.indexOf(freezeUpLaneIds('primary', 0).layerId);
    expect(pass).toBeGreaterThan(order.indexOf('body-console-fill-body'));
    expect(pass).toBeGreaterThan(order.indexOf('body-console-fill-footprint'));
    expect(order[pass + 1]).toBe('body-console-field-dots');
    expect(pass).toBeLessThan(order.indexOf('body-console-outline-body'));
    expect(pass).toBeLessThan(order.indexOf('body-console-line-approach'));
  });

  it('frames a pond too small for the ceiling without throwing, and goes live', () => {
    // About 30 m across: the fit lands past zoom 19, so a floor of fit − 1.5 is over the ceiling.
    const pond = { minLng: -72.1502, minLat: 43.63, maxLng: -72.1498, maxLat: 43.6302 };
    const map = shell.map as FakeMap;
    const { rerender, getByTestId } = render(<Harness mode="dark" bbox={pond} />);
    map.loaded = true;
    expect(() => shell.onLoad?.(map)).not.toThrow();
    expect(map.maxZoom).toBe(17);
    expect(map.minZoom).toBeLessThanOrEqual(17);
    expect(map.zoom).toBe(17);
    shell.live = true;
    rerender(<Harness mode="dark" bbox={pond} />);
    expect(getByTestId('zoom').textContent).toBe('live');
  });

  it('keeps the operator’s own view across a theme switch, and frames a new body afresh', () => {
    const map = shell.map as FakeMap;
    const { rerender } = render(<Harness mode="dark" />);
    map.loaded = true;
    shell.onLoad?.(map);
    const framed = map.zoom;

    // The shell re-creates the map at the view the operator left (here, zoom 13): not re-framed.
    const next = new FakeMap();
    next.zoom = 13;
    shell.map = next;
    rerender(<Harness mode="light" />);
    next.loaded = true;
    shell.onLoad?.(next);
    expect(next.zoom).toBe(13);
    expect(next.minZoom).toBeCloseTo(framed - 1.5, 6);

    // Another body's bounds are framed again.
    const other = new FakeMap();
    shell.map = other;
    const moved = {
      minLng: MASCOMA_BOUNDS.minLng + 0.5,
      minLat: MASCOMA_BOUNDS.minLat,
      maxLng: MASCOMA_BOUNDS.maxLng + 0.5,
      maxLat: MASCOMA_BOUNDS.maxLat,
    };
    rerender(<Harness mode="light" bbox={moved} />);
    other.loaded = true;
    shell.onLoad?.(other);
    expect(other.zoom).toBeCloseTo(framed, 6);
  });
});
