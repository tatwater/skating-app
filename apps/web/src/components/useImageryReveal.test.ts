import { renderHook, waitFor } from '@testing-library/react';
import type maplibregl from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadTile = vi.fn();
const isTileResident = vi.fn();
vi.mock('../lib/imageryCache', () => ({
  loadTile: (tile: unknown, key: string, signal?: AbortSignal) => loadTile(tile, key, signal),
  isTileResident: (key: string) => isTileResident(key),
}));

import { type KeyedMask, useImageryReveal } from './useImageryReveal';

const POND: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-73.2, 44.45],
      [-73.19, 44.45],
      [-73.19, 44.46],
      [-73.2, 44.46],
      [-73.2, 44.45],
    ],
  ],
};

const MASKS: KeyedMask[] = [
  { id: 'body_a', key: 'body_a|sig', mask: { polygon: POND } },
  { id: 'body_b', key: 'body_b|sig', mask: { polygon: POND } },
];

/** Enough of a MapLibre map for the reveal to run against. */
function fakeMap(zoom = 14) {
  const sources = new Map<string, unknown>();
  const layers = new Map<string, unknown>();
  const handlers = new Map<string, () => void>();
  return {
    handlers,
    map: {
      getZoom: () => zoom,
      getBounds: () => ({
        getSouth: () => 44.44,
        getNorth: () => 44.47,
        getWest: () => -73.21,
        getEast: () => -73.18,
      }),
      getContainer: () => ({ clientWidth: 1200, clientHeight: 800 }) as HTMLElement,
      getStyle: () => ({ layers: [{ id: 'water' }, { id: 'roads_minor' }] }),
      getSource: (id: string) => sources.get(id),
      getLayer: (id: string) => layers.get(id),
      addSource: (id: string, source: unknown) =>
        sources.set(id, {
          ...(source as object),
          setCoordinates: () => {},
          play: () => {},
          pause: () => {},
        }),
      addLayer: (layer: { id: string }) => layers.set(layer.id, layer),
      removeSource: (id: string) => sources.delete(id),
      removeLayer: (id: string) => layers.delete(id),
      on: (event: string, handler: () => void) => handlers.set(event, handler),
      off: (event: string) => handlers.delete(event),
    } as unknown as maplibregl.Map,
  };
}

/**
 * jsdom has no 2D context, and without one `composeImagery` bails before it paints — which would
 * quietly stop these tests exercising the path they are about to assert about. A no-op context is
 * enough: nothing here inspects pixels, only the order in which things are reported.
 */
function stubCanvas() {
  const noop = () => {};
  const ctx = new Proxy({ filter: 'none' } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : noop),
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
    has: () => true,
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
}

beforeEach(() => {
  loadTile.mockReset();
  isTileResident.mockReset();
  isTileResident.mockReturnValue(false);
  stubCanvas();
});

afterEach(() => vi.restoreAllMocks());

describe('onPaintedChange — the cartography waits for the pixels', () => {
  it('does not report a body as painted while its cells are still in flight', async () => {
    // The founder's bug, in one assertion. Suppression used to key off the reveal *set*, so panning
    // hid `water-fill` for every body the instant it entered the viewport answer and left blank
    // ground until the fetch returned — "all drawn body polygons disappear for a second".
    let release: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    loadTile.mockReturnValue(pending);

    const onPaintedChange = vi.fn();
    const { map } = fakeMap();
    renderHook(() => useImageryReveal({ map, loaded: true, masks: MASKS, onPaintedChange }));

    // Give the async refresh a turn to reach its await.
    await Promise.resolve();
    expect(onPaintedChange).not.toHaveBeenCalled();

    release({});
    await waitFor(() => expect(onPaintedChange).toHaveBeenCalled());
    expect(onPaintedChange.mock.calls[0]?.[0]).toEqual(['body_a', 'body_b']);
  });

  it('reports nothing when every cell fails — a stale photograph is still the painted one', async () => {
    loadTile.mockResolvedValue(null);
    const onPaintedChange = vi.fn();
    const { map } = fakeMap();
    renderHook(() => useImageryReveal({ map, loaded: true, masks: MASKS, onPaintedChange }));

    await waitFor(() => expect(loadTile).toHaveBeenCalled());
    await Promise.resolve();
    expect(onPaintedChange).not.toHaveBeenCalled();
  });

  it('clears the painted set on teardown, so fills are not left suppressed', async () => {
    loadTile.mockResolvedValue({} as ImageBitmap);
    const onPaintedChange = vi.fn();
    const { map } = fakeMap();
    const { unmount } = renderHook(() =>
      useImageryReveal({ map, loaded: true, masks: MASKS, onPaintedChange }),
    );
    await waitFor(() => expect(onPaintedChange).toHaveBeenCalled());

    onPaintedChange.mockClear();
    unmount();
    expect(onPaintedChange).toHaveBeenCalledWith([]);
  });

  it('reports nothing in unmasked mode — the editor replaces no fill', async () => {
    loadTile.mockResolvedValue({} as ImageBitmap);
    const onPaintedChange = vi.fn();
    const { map } = fakeMap();
    renderHook(() =>
      useImageryReveal({ map, loaded: true, masks: MASKS, unmasked: true, onPaintedChange }),
    );
    await waitFor(() => expect(loadTile).toHaveBeenCalled());
    await Promise.resolve();
    // Either not called, or called with nothing — never with the body ids.
    for (const call of onPaintedChange.mock.calls) expect(call[0]).toEqual([]);
  });

  it('stays silent below the zoom floor rather than suppressing an absent photograph', async () => {
    loadTile.mockResolvedValue({} as ImageBitmap);
    const onPaintedChange = vi.fn();
    const { map } = fakeMap(9);
    renderHook(() => useImageryReveal({ map, loaded: true, masks: MASKS, onPaintedChange }));
    await Promise.resolve();
    expect(loadTile).not.toHaveBeenCalled();
    expect(onPaintedChange).not.toHaveBeenCalled();
  });
});

describe('the loading signal', () => {
  it('is not raised when every cell is already resident', async () => {
    // A small pan that lands on the cells it started on costs no network — announcing it teaches
    // the skater to ignore the wash that means something.
    isTileResident.mockReturnValue(true);
    loadTile.mockResolvedValue({} as ImageBitmap);
    const onLoadingChange = vi.fn();
    const { map } = fakeMap();
    renderHook(() => useImageryReveal({ map, loaded: true, masks: MASKS, onLoadingChange }));

    await waitFor(() => expect(loadTile).toHaveBeenCalled());
    expect(onLoadingChange.mock.calls.filter((c) => c[0] === true)).toHaveLength(0);
  });

  it('is raised when a cell has to be fetched', async () => {
    loadTile.mockResolvedValue({} as ImageBitmap);
    const onLoadingChange = vi.fn();
    const { map } = fakeMap();
    renderHook(() => useImageryReveal({ map, loaded: true, masks: MASKS, onLoadingChange }));

    await waitFor(() => expect(onLoadingChange).toHaveBeenCalledWith(true));
    await waitFor(() => expect(onLoadingChange).toHaveBeenCalledWith(false));
  });
});

describe('the redraw skip', () => {
  it('a moveend onto the same cells does not refetch', async () => {
    loadTile.mockResolvedValue({} as ImageBitmap);
    const { map, handlers } = fakeMap();
    renderHook(() => useImageryReveal({ map, loaded: true, masks: MASKS }));
    await waitFor(() => expect(loadTile).toHaveBeenCalled());
    const first = loadTile.mock.calls.length;

    handlers.get('moveend')?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(loadTile.mock.calls.length).toBe(first);
  });
});
