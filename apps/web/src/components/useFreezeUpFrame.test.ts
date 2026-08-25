import type { IndexedFrame } from '@skating/core';
import { renderHook } from '@testing-library/react';
import type maplibregl from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import { FREEZE_UP_LANE_COUNT, freezeUpLaneIds, useFreezeUpFrame } from './useFreezeUpFrame';

/** Lane 0 is where a first frame always lands; lane 1 is the one it leapfrogs onto. */
const LANE0 = freezeUpLaneIds('primary', 0);
const LANE1 = freezeUpLaneIds('primary', 1);

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
  /** Paint per layer, because two lanes are live at once and the whole design is which is visible. */
  const paint = new Map<string, Record<string, unknown>>();
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
      setPaintProperty: (layer: string, key: string, value: unknown) => {
        paint.set(layer, { ...(paint.get(layer) ?? {}), [key]: value });
        ops.push(`paint:${layer}:${key}=${String(value)}`);
      },
      moveLayer: (id: string) => {
        ops.push(`move:${id}`);
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

/**
 * ⚠ One `mapRef` object for the life of the hook, because that is what `MapView` hands it — a
 * `useRef`. A fresh literal per render made every rerender look like a new map, which is a different
 * code path from the one being tested.
 */
const mount = (harness: ReturnType<typeof fakeMap>, f: IndexedFrame | null) => {
  const mapRef = { current: harness.map };
  return renderHook(
    ({ current }: { current: IndexedFrame | null }) =>
      useFreezeUpFrame({
        mapRef,
        loaded: true,
        frame: current,
        season: 'winter-2025-26',
      }),
    { initialProps: { current: f } },
  );
};

/**
 * What a lane is actually drawn at: the last `setPaintProperty`, falling back to the value the layer
 * was added with. Both matter — a lane mounts at 0 through `addLayer` and only later moves.
 */
const opacityOf = (harness: ReturnType<typeof fakeMap>, layerId: string) => {
  const painted = harness.paint.get(layerId)?.['raster-opacity'];
  if (painted !== undefined) return painted;
  const spec = harness.layers.get(layerId) as { paint?: Record<string, unknown> } | undefined;
  return spec?.paint?.['raster-opacity'];
};

const FRAME_B = frame({ granuleId: 'S2C_B', key: 'frames/winter-2025-26/S2C_B-visual.pmtiles' });
const FRAME_C = frame({ granuleId: 'S2C_C', key: 'frames/winter-2025-26/S2C_C-visual.pmtiles' });

describe('useFreezeUpFrame — mounting a pass', () => {
  it('points a raster source at the frame through the pmtiles protocol', () => {
    const harness = fakeMap();
    mount(harness, frame());

    expect(harness.sources.get(LANE0.sourceId)).toMatchObject({
      type: 'raster',
      url: 'pmtiles://https://cdn.example/imagery/frames/winter-2025-26/S2C_A-visual.pmtiles',
    });
  });

  it('⚠ declares tileSize 512, because the default would draw every frame at half scale', () => {
    const harness = fakeMap();
    mount(harness, frame());
    expect(harness.sources.get(LANE0.sourceId)?.tileSize).toBe(512);
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
    expect(harness.layers.get(LANE0.layerId)).toMatchObject({
      paint: expect.objectContaining({ 'raster-opacity': 0 }),
    });
  });

  it('fades in when its own source reports loaded', () => {
    const harness = fakeMap();
    harness.loadedSources.add(LANE0.sourceId);
    mount(harness, frame());
    harness.emit('sourcedata', { sourceId: LANE0.sourceId });
    expect(opacityOf(harness, LANE0.layerId)).toBe(1);
  });

  it('⚠ ignores sourcedata from any other source', () => {
    // The basemap emits constantly. Revealing on someone else's event would show a frame whose own
    // tiles have not arrived — the flash the zero-opacity mount exists to prevent.
    const harness = fakeMap();
    mount(harness, frame());
    harness.emit('sourcedata', { sourceId: 'basemap' });
    expect(opacityOf(harness, LANE0.layerId)).toBe(0);
  });

  it('does not reveal on a partial load', () => {
    const harness = fakeMap();
    mount(harness, frame());
    harness.emit('sourcedata', { sourceId: LANE0.sourceId });
    expect(opacityOf(harness, LANE0.layerId)).toBe(0);
  });
});

describe('useFreezeUpFrame — ⚠ scrubbing never blanks the map', () => {
  it('keeps the old frame up until the new one has actually loaded', () => {
    // The founder's report, 2026-08-26: every notch crossing blanked for a second or two, because
    // React runs a cleanup BEFORE the effect that replaces it. The old frame has to outlive the swap.
    const harness = fakeMap();
    harness.loadedSources.add(LANE0.sourceId);
    const { rerender } = mount(harness, frame());
    expect(opacityOf(harness, LANE0.layerId)).toBe(1);

    rerender({ current: FRAME_B });

    // B is mounted and invisible; A is still the picture, and still mounted.
    expect(harness.sources.get(LANE1.sourceId)?.url).toContain('S2C_B-visual.pmtiles');
    expect(opacityOf(harness, LANE1.layerId)).toBe(0);
    expect(opacityOf(harness, LANE0.layerId)).toBe(1);
    expect(harness.sources.has(LANE0.sourceId)).toBe(true);
  });

  it('hands over only once the incoming lane reports, and drops the old one after the fade', () => {
    vi.useFakeTimers();
    try {
      const harness = fakeMap();
      harness.loadedSources.add(LANE0.sourceId);
      const { rerender } = mount(harness, frame());
      rerender({ current: FRAME_B });

      harness.loadedSources.add(LANE1.sourceId);
      harness.emit('sourcedata', { sourceId: LANE1.sourceId });
      expect(opacityOf(harness, LANE1.layerId)).toBe(1);
      // ⚠ Still up. Dropping it in the same tick leaves both part-transparent mid-fade and the
      // basemap shows through the middle of the cross-fade.
      expect(opacityOf(harness, LANE0.layerId)).toBe(1);

      vi.advanceTimersByTime(180);
      expect(opacityOf(harness, LANE0.layerId)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('⚠ raises the incoming lane, or the outgoing one would fade in on top of it', () => {
    const harness = fakeMap();
    harness.loadedSources.add(LANE0.sourceId);
    harness.loadedSources.add(LANE1.sourceId);
    const { rerender } = mount(harness, frame());
    rerender({ current: FRAME_B });
    expect(harness.ops).toContain(`move:${LANE1.layerId}`);
  });

  it('⚠ scrubbing back to the previous date is instant, with no refetch', () => {
    // Back and forth between two dates is the whole gesture, not an edge case. The retired lane stays
    // mounted precisely so the return trip is a paint change rather than a cold load.
    const harness = fakeMap();
    harness.loadedSources.add(LANE0.sourceId);
    harness.loadedSources.add(LANE1.sourceId);
    const { rerender } = mount(harness, frame());
    rerender({ current: FRAME_B });
    const adds = harness.ops.filter((op) => op.startsWith('+source:')).length;

    rerender({ current: frame() });

    expect(harness.ops.filter((op) => op.startsWith('+source:')).length).toBe(adds);
    expect(opacityOf(harness, LANE0.layerId)).toBe(1);
  });

  it('⚠ keeps recently-seen dates mounted — the pool IS the cache', () => {
    // The founder's second report: dates visited moments ago still cost a couple of seconds. Two
    // lanes made a *swap* seamless but a *return* a cold load, which is the wrong half — scrubbing is
    // going back and forth over three or four dates, not a walk in one direction.
    const harness = fakeMap();
    const { rerender } = mount(harness, frame());
    rerender({ current: FRAME_B });
    rerender({ current: FRAME_C });

    expect(harness.sources.size).toBe(3);
    const adds = harness.ops.filter((op) => op.startsWith('+source:')).length;

    // Back to the first date: already mounted, so nothing is fetched.
    rerender({ current: frame() });
    expect(harness.ops.filter((op) => op.startsWith('+source:')).length).toBe(adds);
  });

  it('evicts the stalest lane rather than growing, and never the one on screen', () => {
    const harness = fakeMap();
    const dates = Array.from({ length: FREEZE_UP_LANE_COUNT + 3 }, (_, i) =>
      frame({ granuleId: `S2C_${i}`, key: `frames/winter-2025-26/S2C_${i}-visual.pmtiles` }),
    );
    const first = dates[0] as IndexedFrame;
    const { rerender } = mount(harness, first);
    for (const date of dates.slice(1)) rerender({ current: date });

    expect(harness.sources.size).toBe(FREEZE_UP_LANE_COUNT);
    // The last date asked for is the one on screen, and it is still mounted.
    const last = dates.at(-1) as IndexedFrame;
    expect([...harness.sources.values()].some((s) => s.url.includes(last.granuleId))).toBe(true);
    // The very first is long gone.
    expect([...harness.sources.values()].some((s) => s.url.includes(first.granuleId))).toBe(false);
  });

  it('⚠ a lane that loads after being scrubbed past does not haul itself to the front', () => {
    // A slow frame finishing late is a stale date painting over the current one.
    const harness = fakeMap();
    harness.loadedSources.add(LANE0.sourceId);
    const { rerender } = mount(harness, frame());
    rerender({ current: FRAME_B });
    rerender({ current: frame() }); // back to A before B ever loaded

    harness.loadedSources.add(LANE1.sourceId);
    harness.emit('sourcedata', { sourceId: LANE1.sourceId });
    expect(opacityOf(harness, LANE0.layerId)).toBe(1);
  });
});

describe('useFreezeUpFrame — teardown', () => {
  it('⚠ removes the layer before the source, which is the order MapLibre requires', () => {
    const harness = fakeMap();
    const { unmount } = mount(harness, frame());
    unmount();

    const removeLayer = harness.ops.indexOf(`-layer:${LANE0.layerId}`);
    const removeSource = harness.ops.indexOf(`-source:${LANE0.sourceId}`);
    expect(removeLayer).toBeGreaterThanOrEqual(0);
    expect(removeSource).toBeGreaterThan(removeLayer);
  });

  it('tears down BOTH lanes when the scrubber closes', () => {
    const harness = fakeMap();
    harness.loadedSources.add(LANE0.sourceId);
    harness.loadedSources.add(LANE1.sourceId);
    const { rerender } = mount(harness, frame());
    rerender({ current: FRAME_B });
    rerender({ current: null });

    expect(harness.sources.size).toBe(0);
    expect(harness.layers.size).toBe(0);
  });

  it('stops listening on teardown, so a late event cannot paint a removed layer', () => {
    const harness = fakeMap();
    const { unmount } = mount(harness, frame());
    unmount();
    harness.loadedSources.add(LANE0.sourceId);
    harness.emit('sourcedata', { sourceId: LANE0.sourceId });
    expect(opacityOf(harness, LANE0.layerId)).toBeUndefined();
  });
});

describe('useFreezeUpFrame — attribution', () => {
  it('⚠ declares Copernicus on the source, because that credit is required', () => {
    // AttributionControl unions the `attribution` of every active source, so declaring it here is
    // what makes the credit appear with the frame and vanish with it. A frame mounted without this
    // renders a required credit nowhere at all.
    const harness = fakeMap();
    mount(harness, frame());
    expect((harness.sources.get(LANE0.sourceId) as { attribution?: string }).attribution).toBe(
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
    harness.loadedSources.add(LANE0.sourceId);
    mount(harness, frame());

    // No event emitted at all. The synchronous check is what has to carry this.
    expect(opacityOf(harness, LANE0.layerId)).toBe(1);
  });

  it('listens before it adds, so an event during addSource is not missed', () => {
    const harness = fakeMap();
    mount(harness, frame());
    const listenIndex = harness.ops.indexOf('+listen:sourcedata');
    const addIndex = harness.ops.indexOf(`+source:${LANE0.sourceId}`);
    expect(listenIndex).toBeGreaterThanOrEqual(0);
    expect(listenIndex).toBeLessThan(addIndex);
  });

  it('still reveals on a later event when the source was not ready at mount', () => {
    const harness = fakeMap();
    mount(harness, frame());
    expect(opacityOf(harness, LANE0.layerId)).toBe(0);

    harness.loadedSources.add(LANE0.sourceId);
    harness.emit('sourcedata', { sourceId: LANE0.sourceId });
    expect(opacityOf(harness, LANE0.layerId)).toBe(1);
  });
});

describe('useFreezeUpFrame — the reveal floor', () => {
  it('⚠ shows a frame anyway when "loaded" never arrives', () => {
    // `isSourceLoaded` is about the tiles the current viewport needs, so a 404 tile, a stalled range
    // read, or a viewport MapLibre has not asked about all leave a downloaded frame at zero opacity
    // with no way for a user to tell. A partly-drawn frame beats an invisible one.
    vi.useFakeTimers();
    try {
      const harness = fakeMap();
      mount(harness, frame());
      expect(opacityOf(harness, LANE0.layerId)).toBe(0);

      vi.advanceTimersByTime(2000);
      expect(opacityOf(harness, LANE0.layerId)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a torn-down frame paint over its successor', () => {
    vi.useFakeTimers();
    try {
      const harness = fakeMap();
      const { unmount } = mount(harness, frame());
      unmount();
      vi.advanceTimersByTime(5000);
      expect(opacityOf(harness, LANE0.layerId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
