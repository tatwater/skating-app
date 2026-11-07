import type { SilhouetteData, Where } from '@skating/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleMode } from './ConsoleMode';
import { InstrumentMap } from './InstrumentMap';
import InstrumentMapCanvas from './InstrumentMapCanvas';
import { geometryPath, InstrumentOverlay, type OverlayMap, ringCamera } from './InstrumentOverlay';
import { mapProjection } from './instrumentProjection';

const h = vi.hoisted(() => ({ map: null as unknown, loaded: true }));
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('@/lib/mapCanvas', () => ({
  useMapCanvas: (options: { onLoad: (map: unknown) => void }) => {
    if (h.map === null) {
      h.map = {
        addSource: () => {},
        addLayer: () => {},
        getSource: () => ({ setData: () => {} }),
        on: () => {},
        fitBounds: () => {},
      };
      options.onLoad(h.map);
    }
    return { containerRef: { current: null }, mapRef: { current: h.map }, loaded: h.loaded };
  },
}));

beforeEach(() => {
  h.map = null;
  h.loaded = true;
});

/** A flat fake map that also tells the overlay when it moves. */
function overlayMap(): OverlayMap & { move: (dx: number) => void } {
  const container = { clientWidth: 600, clientHeight: 400 } as HTMLElement;
  let offset = 0;
  const listeners = new Set<() => void>();
  return {
    project: ([lng, lat]) => ({ x: (lng + 73) * 1000 + offset, y: (44 - lat) * 1000 }),
    unproject: ([x, y]) => ({ lng: (x - offset) / 1000 - 73, lat: 44 - y / 1000 }),
    getContainer: () => container,
    getCenter: () => ({ lng: -72.7, lat: 43.8 }),
    on: (_t, l) => listeners.add(l),
    off: (_t, l) => listeners.delete(l),
    move: (dx) => {
      offset += dx;
      for (const l of listeners) l();
    },
  };
}

// A square lake around the frame's middle (300, 200 px).
const SILHOUETTE: SilhouetteData = {
  rings: [
    [
      [-72.75, 43.75],
      [-72.65, 43.75],
      [-72.65, 43.85],
      [-72.75, 43.85],
      [-72.75, 43.75],
    ],
  ],
  bbox: { minLat: 43.75, maxLat: 43.85, minLng: -72.75, maxLng: -72.65 },
  origin: { lat: 43.8, lng: -72.7 },
};

describe('the instrument canvas hands its map out', () => {
  it('gives the map once loaded, and takes it back when it goes', () => {
    const onMap = vi.fn();
    const { unmount } = render(
      <InstrumentMapCanvas
        input={{ polygon: null, pins: [], hazards: [], photos: [] }}
        onMap={onMap}
      />,
    );
    expect(onMap).toHaveBeenLastCalledWith(h.map);
    unmount();
    expect(onMap).toHaveBeenLastCalledWith(null);
  });

  it('gives nothing before the map has loaded', () => {
    h.loaded = false;
    const onMap = vi.fn();
    render(
      <InstrumentMapCanvas
        input={{ polygon: null, pins: [], hazards: [], photos: [] }}
        onMap={onMap}
      />,
    );
    expect(onMap).toHaveBeenLastCalledWith(null);
  });
});

describe('the instrument map, suspended', () => {
  it('draws no canvas while a stacked sheet holds the slot, but keeps its overlay', () => {
    render(
      <InstrumentMap
        input={{ polygon: null, pins: [], hazards: [], photos: [] }}
        label="Mascoma Lake"
        suspended
      >
        <p>overlay</p>
      </InstrumentMap>,
    );
    expect(screen.getByRole('region', { name: 'Mascoma Lake' })).toHaveTextContent('overlay');
    expect(document.querySelector('[data-slot="instrument-canvas"]')).toBeNull();
  });
});

describe('InstrumentOverlay', () => {
  const whereMode = (where: Where | undefined, onChange = vi.fn()): ConsoleMode => ({
    kind: 'where',
    label: 'Snow covered',
    where,
    onChange,
  });

  it('draws nothing without a map, or with no mode and no draft', () => {
    const { container, rerender } = render(
      <InstrumentOverlay
        map={null}
        mode={whereMode(undefined)}
        silhouette={SILHOUETTE}
        pins={[]}
      />,
    );
    expect(container.querySelector('svg')).toBeNull();
    rerender(<InstrumentOverlay map={overlayMap()} mode={null} silhouette={null} pins={[]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('where: the ring around the lake, the chip’s sector lit and washed, an arc takes a click', () => {
    const onChange = vi.fn();
    const { container } = render(
      <InstrumentOverlay
        map={overlayMap()}
        mode={whereMode({ sector: 'N' }, onChange)}
        silhouette={SILHOUETTE}
        pins={[]}
      />,
    );
    const ring = container.querySelector('[data-slot="instrument-ring"]');
    expect(ring?.querySelectorAll('[data-sector]')).toHaveLength(8);
    expect(container.querySelector('[data-slot="instrument-wash"]')).not.toBeNull();
    const north = container.querySelector('[data-sector="N"]') as Element;
    fireEvent.click(north);
    // N again takes it back.
    expect(onChange).toHaveBeenCalledWith(undefined);
    fireEvent.click(container.querySelector('[data-sector="E"]') as Element);
    expect(onChange).toHaveBeenLastCalledWith({ sector: 'E' });
  });

  it('where: the point the author placed, with its name', () => {
    const { container } = render(
      <InstrumentOverlay
        map={overlayMap()}
        mode={whereMode({
          point: { coord: { lat: 43.8, lng: -72.7 }, radiusMeters: 75, name: 'Wood Island' },
        })}
        silhouette={SILHOUETTE}
        pins={[]}
      />,
    );
    expect(container.querySelector('[data-slot="instrument-point"]')).toHaveTextContent(
      'Wood Island',
    );
    expect(container.querySelector('[data-slot="instrument-wash"]')).toBeNull();
  });

  it('put-in: every launch lit and named, the chosen one marked', () => {
    const mode: ConsoleMode = { kind: 'putIn', onPickPin: vi.fn(), onPickShore: vi.fn() };
    const { container } = render(
      <InstrumentOverlay
        map={overlayMap()}
        mode={mode}
        silhouette={SILHOUETTE}
        chosenPinId="b"
        pins={[
          { id: 'a', coord: { lat: 43.8, lng: -72.7 }, name: 'Boat launch', kind: 'putIn' },
          { id: 'b', coord: { lat: 43.81, lng: -72.7 }, name: 'Town lot', kind: 'parking' },
        ]}
      />,
    );
    const lit = container.querySelector('[data-slot="instrument-lit"]');
    expect(lit?.querySelectorAll('[data-pin]')).toHaveLength(2);
    // Only the chosen one is named, as a lockup.
    expect(lit).not.toHaveTextContent('Boat launch');
    expect(lit).toHaveTextContent('PARKED · YOURSTown lot');
    expect(container.querySelector('[data-pin="b"]')).toHaveAttribute('data-chosen');
    expect(container.querySelector('[data-pin="b"] rect')).not.toBeNull();
  });

  it('draft: a footprint, a line and its corners, and it follows the camera', () => {
    const map = overlayMap();
    const draft: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'MultiPolygon',
            coordinates: [
              [
                [
                  [-72.7, 43.8],
                  [-72.69, 43.8],
                  [-72.69, 43.81],
                  [-72.7, 43.8],
                ],
              ],
            ],
          },
          properties: { role: 'footprint', passage: true },
        },
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [-72.7, 43.8],
              [-72.68, 43.79],
            ],
          },
          properties: {},
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-72.7, 43.8] },
          properties: { role: 'vertex' },
        },
        {
          type: 'Feature',
          geometry: { type: 'MultiPoint', coordinates: [[-72.7, 43.8]] },
          properties: {},
        },
      ],
    };
    const { container } = render(
      <InstrumentOverlay map={map} mode={null} silhouette={null} pins={[]} draft={draft} />,
    );
    const g = container.querySelector('[data-slot="instrument-draft"]') as Element;
    expect(g.querySelectorAll('path')).toHaveLength(2);
    expect(g.querySelector('path')).toHaveAttribute('stroke', 'var(--acc)');
    const dot = g.querySelector('circle') as Element;
    const before = Number(dot.getAttribute('cx'));
    act(() => map.move(40));
    expect(Number((g.querySelector('circle') as Element).getAttribute('cx'))).toBeCloseTo(
      before + 40,
    );
  });

  it('geometryPath draws polygons as closed rings, lines open, and nothing for points', () => {
    const projection = mapProjection(overlayMap());
    expect(
      geometryPath(
        {
          type: 'Polygon',
          coordinates: [
            [
              [-72.7, 43.8],
              [-72.69, 43.8],
              [-72.7, 43.8],
            ],
          ],
        },
        projection,
      ),
    ).toMatch(/^M300\.0 200\.0 L310\.0 200\.0 L300\.0 200\.0 Z$/);
    expect(geometryPath({ type: 'Point', coordinates: [0, 0] }, projection)).toBeNull();
  });
});

describe('the where mode frames the lake inside the ring', () => {
  it('centers on the origin and zooms the farthest shore inside the ring, then puts the camera back', () => {
    const jumpTo = vi.fn();
    const map = { ...overlayMap(), getZoom: () => 12, jumpTo };
    const { unmount } = render(
      <InstrumentOverlay
        map={map}
        mode={{ kind: 'where', label: 'Glass', where: undefined, onChange: vi.fn() }}
        silhouette={SILHOUETTE}
        pins={[]}
      />,
    );
    const camera = jumpTo.mock.calls[0]?.[0] as { center: unknown; zoom: number };
    expect(camera.center).toEqual(SILHOUETTE.origin);
    // The farthest corner sits ~70 px out; the ring's room is 200 − 48 px: zoom in a little.
    expect(camera.zoom).toBeGreaterThan(12);
    unmount();
    expect(jumpTo).toHaveBeenLastCalledWith({ center: { lng: -72.7, lat: 43.8 }, zoom: 12 });
  });

  it('leaves a removed map alone, and frames nothing it can’t measure', () => {
    const jumpTo = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error('removed');
      });
    const map = { ...overlayMap(), getZoom: () => 12, jumpTo };
    const { unmount } = render(
      <InstrumentOverlay
        map={map}
        mode={{ kind: 'where', label: 'Glass', where: undefined, onChange: vi.fn() }}
        silhouette={SILHOUETTE}
        pins={[]}
      />,
    );
    expect(() => unmount()).not.toThrow();
    const projection = mapProjection(overlayMap());
    expect(ringCamera(projection, { ...SILHOUETTE, rings: [] }, 12)).toBeNull();
  });
});
