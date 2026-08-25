import type { IndexedFrame } from '@skating/core';
import { renderHook } from '@testing-library/react';
import type maplibregl from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import { FREEZE_UP_LAYER_ID, FREEZE_UP_SOURCE_ID, useFreezeUpFrame } from './useFreezeUpFrame';

vi.mock('../lib/env', () => ({
  env: { imageryArchiveUrl: 'https://cdn.example/imagery' },
}));

const frame = (over: Partial<IndexedFrame> = {}): IndexedFrame => ({
  granuleId: 'S2C_A',
  capturedAt: '2025-12-22T15:51:05Z',
  cloudCoverPct: 7.6,
  bodies: 9,
  band: 'visual',
  key: 'frames/winter-2025-26/S2C_A-visual.pmtiles',
  ...over,
});

/** Enough of a MapLibre map to observe source/layer lifecycle and paint changes. */
function fakeMap() {
  const sources = new Map<string, { type: string; url: string; tileSize?: number }>();
  const layers = new Map<string, unknown>();
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  const paint: Record<string, unknown> = {};
  /** Which sources MapLibre would report as loaded. */
  const loadedSources = new Set<string>();
  /** Every add/remove in order, so "layer before source" is assertable rather than assumed. */
  const ops: string[] = [];

  return {
    sources,
    layers,
    paint,
    ops,
    loadedSources,
    emit(type: string, event: unknown) {
      for (const fn of handlers.get(type) ?? []) fn(event);
    },
    map: {
      getStyle: () => ({ layers: [{ id: 'water' }, { id: 'roads_minor' }] }),
      getLayer: (id: string) => (layers.has(id) ? {} : undefined),
      getSource: (id: string) => (sources.has(id) ? {} : undefined),
      isSourceLoaded: (id: string) => loadedSources.has(id),
      addSource: (id: string, spec: { type: string; url: string; tileSize?: number }) => {
        sources.set(id, spec);
        ops.push(`+source:${id}`);
      },
      addLayer: (spec: { id: string }) => {
        layers.set(spec.id, spec);
        ops.push(`+layer:${spec.id}`);
      },
      removeLayer: (id: string) => {
        layers.delete(id);
        ops.push(`-layer:${id}`);
      },
      removeSource: (id: string) => {
        sources.delete(id);
        ops.push(`-source:${id}`);
      },
      setPaintProperty: (_layer: string, key: string, value: unknown) => {
        paint[key] = value;
      },
      on: (type: string, fn: (event: unknown) => void) => {
        handlers.set(type, [...(handlers.get(type) ?? []), fn]);
        ops.push(`+listen:${type}`);
      },
      off: (type: string, fn: (event: unknown) => void) => {
        handlers.set(
          type,
          (handlers.get(type) ?? []).filter((f) => f !== fn),
        );
      },
    } as unknown as maplibregl.Map,
  };
}

const mount = (harness: ReturnType<typeof fakeMap>, f: IndexedFrame | null) =>
  renderHook(
    ({ current }: { current: IndexedFrame | null }) =>
      useFreezeUpFrame({
        mapRef: { current: harness.map },
        loaded: true,
        frame: current,
        season: 'winter-2025-26',
      }),
    { initialProps: { current: f } },
  );

describe('useFreezeUpFrame — mounting a pass', () => {
  it('points a raster source at the frame through the pmtiles protocol', () => {
    const harness = fakeMap();
    mount(harness, frame());

    expect(harness.sources.get(FREEZE_UP_SOURCE_ID)).toMatchObject({
      type: 'raster',
      url: 'pmtiles://https://cdn.example/imagery/frames/winter-2025-26/S2C_A-visual.pmtiles',
    });
  });

  it('⚠ declares tileSize 512, because the default would draw every frame at half scale', () => {
    const harness = fakeMap();
    mount(harness, frame());
    expect(harness.sources.get(FREEZE_UP_SOURCE_ID)?.tileSize).toBe(512);
  });

  it('does nothing at all when there is no frame to show', () => {
    const harness = fakeMap();
    mount(harness, null);
    expect(harness.ops).toEqual([]);
  });
});

describe('useFreezeUpFrame — the reveal', () => {
  it('mounts invisible, so a scrub does not flash the basemap', () => {
    const harness = fakeMap();
    mount(harness, frame());
    expect(harness.layers.get(FREEZE_UP_LAYER_ID)).toMatchObject({
      paint: expect.objectContaining({ 'raster-opacity': 0 }),
    });
  });

  it('fades in when its own source reports loaded', () => {
    const harness = fakeMap();
    harness.loadedSources.add(FREEZE_UP_SOURCE_ID);
    mount(harness, frame());
    harness.emit('sourcedata', { sourceId: FREEZE_UP_SOURCE_ID });
    expect(harness.paint['raster-opacity']).toBe(1);
  });

  it('⚠ ignores sourcedata from any other source', () => {
    // The basemap emits constantly. Revealing on someone else's event would show a frame whose own
    // tiles have not arrived — the flash the zero-opacity mount exists to prevent.
    const harness = fakeMap();
    mount(harness, frame());
    harness.emit('sourcedata', { sourceId: 'basemap' });
    expect(harness.paint['raster-opacity']).toBeUndefined();
  });

  it('does not reveal on a partial load', () => {
    const harness = fakeMap();
    mount(harness, frame());
    harness.emit('sourcedata', { sourceId: FREEZE_UP_SOURCE_ID });
    expect(harness.paint['raster-opacity']).toBeUndefined();
  });

  it('reveals once, not on every subsequent tile', () => {
    const harness = fakeMap();
    harness.loadedSources.add(FREEZE_UP_SOURCE_ID);
    mount(harness, frame());
    harness.emit('sourcedata', { sourceId: FREEZE_UP_SOURCE_ID });
    harness.paint['raster-opacity'] = 'untouched';
    harness.emit('sourcedata', { sourceId: FREEZE_UP_SOURCE_ID });
    expect(harness.paint['raster-opacity']).toBe('untouched');
  });
});

describe('useFreezeUpFrame — scrubbing and teardown', () => {
  it('⚠ removes the layer before the source, which is the order MapLibre requires', () => {
    const harness = fakeMap();
    const { unmount } = mount(harness, frame());
    unmount();

    const removeLayer = harness.ops.indexOf(`-layer:${FREEZE_UP_LAYER_ID}`);
    const removeSource = harness.ops.indexOf(`-source:${FREEZE_UP_SOURCE_ID}`);
    expect(removeLayer).toBeGreaterThanOrEqual(0);
    expect(removeSource).toBeGreaterThan(removeLayer);
  });

  it('swaps by tearing down and rebuilding, since a source URL is immutable', () => {
    const harness = fakeMap();
    const { rerender } = mount(harness, frame());
    rerender({
      current: frame({ granuleId: 'S2C_B', key: 'frames/winter-2025-26/S2C_B-visual.pmtiles' }),
    });

    expect(harness.sources.get(FREEZE_UP_SOURCE_ID)?.url).toContain('S2C_B-visual.pmtiles');
    expect(harness.ops.filter((op) => op === `+source:${FREEZE_UP_SOURCE_ID}`)).toHaveLength(2);
  });

  it('tears down when the scrubber closes', () => {
    const harness = fakeMap();
    const { rerender } = mount(harness, frame());
    rerender({ current: null });

    expect(harness.sources.has(FREEZE_UP_SOURCE_ID)).toBe(false);
    expect(harness.layers.has(FREEZE_UP_LAYER_ID)).toBe(false);
  });

  it('stops listening on teardown, so a late event cannot paint a removed layer', () => {
    const harness = fakeMap();
    const { unmount } = mount(harness, frame());
    unmount();
    harness.loadedSources.add(FREEZE_UP_SOURCE_ID);
    harness.emit('sourcedata', { sourceId: FREEZE_UP_SOURCE_ID });
    expect(harness.paint['raster-opacity']).toBeUndefined();
  });
});

describe('useFreezeUpFrame — attribution', () => {
  it('⚠ declares Copernicus on the source, because that credit is required', () => {
    // AttributionControl unions the `attribution` of every active source, so declaring it here is
    // what makes the credit appear with the frame and vanish with it. A frame mounted without this
    // renders a required credit nowhere at all.
    const harness = fakeMap();
    mount(harness, frame());
    expect((harness.sources.get(FREEZE_UP_SOURCE_ID) as { attribution?: string }).attribution).toBe(
      'Copernicus Sentinel data 2025–2026',
    );
  });
});

describe('useFreezeUpFrame — the load race', () => {
  it('⚠ reveals a source that was already loaded when the layer mounted', () => {
    // Observed live 2026-08-25: registering the listener *after* `addSource` lost the race whenever
    // the source resolved quickly, so the frame sat at zero opacity until a camera move produced a
    // second `sourcedata`. The symptom is the cruellest available — it looks like the archive is
    // broken, and the fix is a zoom nobody thinks to try.
    const harness = fakeMap();
    harness.loadedSources.add(FREEZE_UP_SOURCE_ID);
    mount(harness, frame());

    // No event emitted at all. The synchronous check is what has to carry this.
    expect(harness.paint['raster-opacity']).toBe(1);
  });

  it('listens before it adds, so an event during addSource is not missed', () => {
    const harness = fakeMap();
    mount(harness, frame());
    const listenIndex = harness.ops.indexOf('+listen:sourcedata');
    const addIndex = harness.ops.indexOf(`+source:${FREEZE_UP_SOURCE_ID}`);
    expect(listenIndex).toBeGreaterThanOrEqual(0);
    expect(listenIndex).toBeLessThan(addIndex);
  });

  it('still reveals on a later event when the source was not ready at mount', () => {
    const harness = fakeMap();
    mount(harness, frame());
    expect(harness.paint['raster-opacity']).toBeUndefined();

    harness.loadedSources.add(FREEZE_UP_SOURCE_ID);
    harness.emit('sourcedata', { sourceId: FREEZE_UP_SOURCE_ID });
    expect(harness.paint['raster-opacity']).toBe(1);
  });
});
