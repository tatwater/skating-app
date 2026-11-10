import { render, waitFor } from '@testing-library/react';
import type { Polygon } from 'geojson';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InstrumentMapCanvas, { INSTRUMENT_SOURCES } from './InstrumentMapCanvas';

const h = vi.hoisted(() => ({
  options: null as null | { fitBounds: unknown; onLoad: (map: unknown) => void },
  map: null as null | FakeMap,
  loaded: false,
}));

class FakeMap {
  sources = new Map<string, unknown>();
  layers: string[] = [];
  handlers = new Map<string, (e: unknown) => void>();
  fitBounds = vi.fn();
  addSource(id: string, spec: { data: unknown }) {
    this.sources.set(id, spec.data);
  }
  addLayer(spec: { id: string }) {
    this.layers.push(spec.id);
  }
  getSource(id: string) {
    return { setData: (d: unknown) => this.sources.set(id, d) };
  }
  on(event: string, handler: (e: unknown) => void) {
    this.handlers.set(event, handler);
  }
}

vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('@/lib/mapCanvas', () => ({
  // The real one: the container's class is the module's rule, not the hook's (`MapContainer.stories`).
  MAP_CONTAINER_CLASS: 'size-full',
  useMapCanvas: (options: { fitBounds: unknown; onLoad: (map: unknown) => void }) => {
    h.options = options;
    if (h.map === null) {
      h.map = new FakeMap();
      options.onLoad(h.map);
    }
    return {
      containerRef: { current: null },
      mapRef: { current: h.map },
      loaded: h.loaded,
      liveMap: () => (h.loaded ? h.map : null),
    };
  },
}));

const LAKE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72.2, 43.6],
      [-72.1, 43.6],
      [-72.1, 43.7],
      [-72.2, 43.6],
    ],
  ],
};
const input = { polygon: LAKE, pins: [], hazards: [], photos: [] };

beforeEach(() => {
  h.options = null;
  h.map = null;
  h.loaded = true;
});

describe('the instrument’s map', () => {
  it('frames the one lake and draws it and its track (the marks are DOM, over it)', async () => {
    render(<InstrumentMapCanvas input={input} />);
    expect(h.options?.fitBounds).toEqual([
      [-72.2, 43.6],
      [-72.1, 43.7],
    ]);
    expect(h.map?.layers).toEqual([
      'instrument-lake-fill',
      'instrument-lake-line',
      'instrument-track',
    ]);
    await waitFor(() =>
      expect(
        (h.map as FakeMap).sources.get(INSTRUMENT_SOURCES.lake) as { features: unknown[] },
      ).toMatchObject({ features: [expect.anything()] }),
    );
    expect(h.map?.fitBounds).toHaveBeenCalled();
  });

  it('hands a click back as a coordinate', () => {
    const onPick = vi.fn();
    render(<InstrumentMapCanvas input={input} onPick={onPick} />);
    h.map?.handlers.get('click')?.({ lngLat: { lat: 43.65, lng: -72.15 } });
    expect(onPick).toHaveBeenCalledWith({ lat: 43.65, lng: -72.15 });
  });

  it('waits for the map before drawing', () => {
    h.loaded = false;
    render(<InstrumentMapCanvas input={{ ...input, polygon: null }} />);
    expect(h.map?.fitBounds).not.toHaveBeenCalled();
    expect(h.options?.fitBounds).toBeNull();
  });
});
