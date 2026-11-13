import { render } from '@testing-library/react';
import { useMemo } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MASCOMA_BOUNDS, MASCOMA_SCENE } from '../frame/bodyFixtures';
import { adminToken } from './bodyMapPalette';
import { DEFAULT_LAYERS, drawScene } from './bodyScene';
import { LINE_SOURCE, OUTLINE_SOURCE } from './glLayers';

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
  addLayer(layer: { id: string; paint?: Record<string, unknown> }) {
    this.check();
    this.layers.set(layer.id, { paint: { ...(layer.paint ?? {}) } });
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
    const liveMap = useMemo(() => () => (live ? map : null), [live, map]);
    return { containerRef: { current: null }, mapRef: { current: map }, loaded: live, liveMap };
  },
}));

const { useBodyMapCanvas } = await import('./useBodyMapCanvas');

function Harness({ mode }: { mode: 'dark' | 'light' }) {
  const drawn = useMemo(() => drawScene(MASCOMA_SCENE, DEFAULT_LAYERS), []);
  const canvas = useBodyMapCanvas({ bbox: MASCOMA_BOUNDS, mode, drawn });
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
    expect([...map.sources.keys()]).toEqual([OUTLINE_SOURCE, LINE_SOURCE]);
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
});
