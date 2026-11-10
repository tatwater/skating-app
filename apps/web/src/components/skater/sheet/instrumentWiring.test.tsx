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
  // The real one: the container's class is the module's rule, not the hook's (`MapContainer.stories`).
  MAP_CONTAINER_CLASS: 'size-full',
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
    return {
      containerRef: { current: null },
      mapRef: { current: h.map },
      loaded: h.loaded,
      liveMap: () => (h.loaded ? h.map : null),
    };
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

const NO_MARKS = { pins: [], hazards: [], photos: [] };

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
        marks={NO_MARKS}
      />,
    );
    expect(container.querySelector('svg')).toBeNull();
    rerender(
      <InstrumentOverlay map={overlayMap()} mode={null} silhouette={null} marks={NO_MARKS} />,
    );
    expect(container.querySelector('svg')).toBeNull();
  });

  it('where: the ring around the lake, the chip’s sector lit and washed, an arc takes a click', () => {
    const onChange = vi.fn();
    const { container } = render(
      <InstrumentOverlay
        map={overlayMap()}
        mode={whereMode({ sector: 'N' }, onChange)}
        silhouette={SILHOUETTE}
        marks={NO_MARKS}
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
        marks={NO_MARKS}
      />,
    );
    expect(container.querySelector('[data-slot="instrument-point"]')).toHaveTextContent(
      'Wood Island',
    );
    expect(container.querySelector('[data-slot="instrument-wash"]')).toBeNull();
  });

  const PINS = [
    { id: 'a', coord: { lat: 43.8, lng: -72.7 }, name: 'Boat launch', kind: 'putIn' as const },
    { id: 'b', coord: { lat: 43.81, lng: -72.7 }, name: 'Town lot', kind: 'parking' as const },
  ];
  const MARKS = {
    pins: PINS,
    chosenPinId: 'b',
    hazards: [
      {
        id: 'h1',
        bbox: { minLat: 43.79, maxLat: 43.79, minLng: -72.71, maxLng: -72.71 },
        passage: false,
        healing: true,
      },
    ],
    photos: [{ id: 'ph', coord: { lat: 43.78, lng: -72.69 } }],
  };
  const mark = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-pin="${id}"] svg`) as SVGElement;

  it('draws the region map’s square marks, the chosen lot larger and the other launch receded', () => {
    const map = overlayMap();
    const { container } = render(
      <InstrumentOverlay map={map} mode={null} silhouette={null} marks={MARKS} />,
    );
    const layer = container.querySelector('[data-slot="instrument-marks"]') as HTMLElement;
    expect(layer).toHaveClass('pointer-events-none');
    expect(layer).not.toHaveAttribute('data-lit');
    expect(mark(container, 'a')).toHaveAttribute('data-kind', 'put-in');
    expect(mark(container, 'a')).toHaveAttribute('data-dim');
    expect(mark(container, 'b')).toHaveAttribute('data-kind', 'lot');
    expect(mark(container, 'b')).not.toHaveAttribute('data-dim');
    // The chosen lot is the 16 px face; nothing is bracketed outside the put-in mode.
    expect(mark(container, 'b').querySelectorAll('rect')[1]).toHaveAttribute('width', '16');
    expect(mark(container, 'b')).not.toHaveAttribute('data-highlight');
    expect(mark(container, 'h1')).toHaveAttribute('data-tone', 'healing');
    expect(mark(container, 'ph')).toHaveAttribute('data-kind', 'photo');
    // Centered on the point: (-72.7 + 73) * 1000 = 300, less half the 34 px box.
    const a = container.querySelector('[data-pin="a"]') as HTMLElement;
    const at = () => (a.style.transform.match(/-?[\d.]+/g) ?? []).map((n) => Math.round(Number(n)));
    expect(at()).toEqual([283, 183]);
    act(() => map.move(10));
    expect(at()).toEqual([293, 183]);
    // No overlay drawing without a mode or a draft.
    expect(container.querySelector('[data-slot="instrument-overlay"]')).toBeNull();
  });

  it('draws a hand-set point as the chosen put-in when no launch is chosen', () => {
    const { container } = render(
      <InstrumentOverlay
        map={overlayMap()}
        mode={null}
        silhouette={null}
        marks={{ ...NO_MARKS, point: { lat: 43.8, lng: -72.7 } }}
      />,
    );
    expect(mark(container, 'point')).toHaveAttribute('data-kind', 'put-in');
    expect(container.querySelector('[data-pin="point"]')).toHaveAttribute('data-chosen');
  });

  it('put-in: every launch at full strength, the chosen one bracketed and named', () => {
    const mode: ConsoleMode = { kind: 'putIn', onPickPin: vi.fn(), onPickShore: vi.fn() };
    const { container } = render(
      <InstrumentOverlay map={overlayMap()} mode={mode} silhouette={SILHOUETTE} marks={MARKS} />,
    );
    const lit = container.querySelector('[data-slot="instrument-marks"][data-lit]');
    expect(lit?.querySelectorAll('[data-pin]')).toHaveLength(4);
    expect(mark(container, 'a')).not.toHaveAttribute('data-dim');
    expect(mark(container, 'b')).toHaveAttribute('data-highlight');
    expect(container.querySelector('[data-slot="lot-mark-brackets"]')).not.toBeNull();
    // What isn't a launch steps back.
    expect(mark(container, 'h1')).toHaveAttribute('data-dim');
    expect(mark(container, 'ph')).toHaveAttribute('data-dim');
    // Only the chosen one is named, as a lockup.
    const lockup = container.querySelector('[data-slot="instrument-lockup"]');
    expect(lockup).toHaveTextContent('PARKED · YOURSTown lot');
    expect(container).not.toHaveTextContent('Boat launch');
    expect(container.querySelector('[data-pin="b"]')).toHaveAttribute('data-chosen');
  });

  it('put-in: a launch named in the lockup, and none until one is chosen', () => {
    const mode: ConsoleMode = { kind: 'putIn', onPickPin: vi.fn(), onPickShore: vi.fn() };
    const { container, rerender } = render(
      <InstrumentOverlay
        map={overlayMap()}
        mode={mode}
        silhouette={SILHOUETTE}
        marks={{ ...MARKS, chosenPinId: 'a' }}
      />,
    );
    expect(container.querySelector('[data-slot="instrument-lockup"]')).toHaveTextContent(
      'PUT-IN · YOURSBoat launch',
    );
    rerender(
      <InstrumentOverlay
        map={overlayMap()}
        mode={mode}
        silhouette={SILHOUETTE}
        marks={{ ...NO_MARKS, pins: PINS }}
      />,
    );
    expect(container.querySelector('[data-slot="instrument-lockup"]')).toBeNull();
  });

  describe('a pin a chip points at', () => {
    const putInMode: ConsoleMode = { kind: 'putIn', onPickPin: vi.fn(), onPickShore: vi.fn() };

    it('alone is bracketed and full strength, the rest step back; it lets go to the normal state', () => {
      const { container, rerender } = render(
        <InstrumentOverlay
          map={overlayMap()}
          mode={null}
          silhouette={null}
          marks={MARKS}
          highlightPinId="a"
        />,
      );
      expect(mark(container, 'a')).toHaveAttribute('data-highlight');
      expect(mark(container, 'a')).not.toHaveAttribute('data-dim');
      expect(container.querySelector('[data-pin="a"]')).toHaveAttribute('data-pointed');
      expect(container.querySelector('[data-pin="a"]')).toHaveStyle({ zIndex: '1' });
      // The chosen lot too: one pin bracketed at a time. A dimmed hazard still draws (D3).
      for (const id of ['b', 'h1', 'ph']) {
        expect(mark(container, id)).toHaveAttribute('data-dim');
        expect(mark(container, id)).not.toHaveAttribute('data-highlight');
      }
      expect(mark(container, 'h1')).toHaveClass('opacity-55');
      // Named, with no mode open: the lots' chips sit outside any question.
      expect(container.querySelector('[data-slot="instrument-lockup"]')).toHaveTextContent(
        'PUT-INBoat launch',
      );
      rerender(
        <InstrumentOverlay
          map={overlayMap()}
          mode={null}
          silhouette={null}
          marks={MARKS}
          highlightPinId={null}
        />,
      );
      expect(mark(container, 'a')).not.toHaveAttribute('data-highlight');
      expect(mark(container, 'a')).toHaveAttribute('data-dim');
      expect(mark(container, 'b')).not.toHaveAttribute('data-dim');
      expect(mark(container, 'h1')).not.toHaveAttribute('data-dim');
      expect(container.querySelector('[data-pointed]')).toBeNull();
      expect(container.querySelector('[data-slot="instrument-overlay"]')).toBeNull();
    });

    it('takes the put-in mode’s lockup from the chosen pin, and gives it back', () => {
      const { container, rerender } = render(
        <InstrumentOverlay
          map={overlayMap()}
          mode={putInMode}
          silhouette={SILHOUETTE}
          marks={MARKS}
          highlightPinId="a"
        />,
      );
      const lockups = () => container.querySelectorAll('[data-slot="instrument-lockup"]');
      expect(lockups()).toHaveLength(1);
      expect(lockups()[0]).toHaveTextContent('PUT-INBoat launch');
      expect(mark(container, 'a')).toHaveAttribute('data-highlight');
      expect(mark(container, 'b')).not.toHaveAttribute('data-highlight');
      expect(mark(container, 'b')).toHaveAttribute('data-dim');
      rerender(
        <InstrumentOverlay
          map={overlayMap()}
          mode={putInMode}
          silhouette={SILHOUETTE}
          marks={MARKS}
          highlightPinId="b"
        />,
      );
      // Pointing at your own lot keeps its claim.
      expect(lockups()[0]).toHaveTextContent('PARKED · YOURSTown lot');
      rerender(
        <InstrumentOverlay
          map={overlayMap()}
          mode={putInMode}
          silhouette={SILHOUETTE}
          marks={MARKS}
        />,
      );
      expect(lockups()[0]).toHaveTextContent('PARKED · YOURSTown lot');
      expect(mark(container, 'b')).toHaveAttribute('data-highlight');
      expect(mark(container, 'a')).not.toHaveAttribute('data-dim');
    });

    it('lights over the where mode’s quiet lake too', () => {
      const { container } = render(
        <InstrumentOverlay
          map={overlayMap()}
          mode={whereMode(undefined)}
          silhouette={SILHOUETTE}
          marks={MARKS}
          highlightPinId="b"
        />,
      );
      expect(mark(container, 'b')).toHaveAttribute('data-highlight');
      expect(mark(container, 'b')).not.toHaveAttribute('data-dim');
      expect(mark(container, 'a')).toHaveAttribute('data-dim');
      expect(container.querySelector('[data-slot="instrument-lockup"]')).toHaveTextContent(
        'PARKED · YOURSTown lot',
      );
    });

    it('names another lot plainly, and flips the name left at the frame’s right edge', () => {
      const edge = {
        id: 'e',
        // (-72.42 + 73) * 1000 = 580 px of a 600 px frame.
        coord: { lat: 43.8, lng: -72.42 },
        name: 'Parking',
        kind: 'parking' as const,
      };
      const { container } = render(
        <InstrumentOverlay
          map={overlayMap()}
          mode={null}
          silhouette={null}
          marks={{ ...MARKS, pins: [...PINS, edge] }}
          highlightPinId="e"
        />,
      );
      const lockup = container.querySelector('[data-slot="instrument-lockup"]') as Element;
      expect(lockup).toHaveTextContent('PARKINGParking');
      expect(lockup).toHaveAttribute('data-flip');
      expect(lockup).toHaveAttribute('text-anchor', 'end');
      expect(Number(lockup.getAttribute('x'))).toBeLessThan(580);
    });

    it('a chip naming nothing on this map — or a hazard’s id — dims nothing', () => {
      const { container, rerender } = render(
        <InstrumentOverlay
          map={overlayMap()}
          mode={null}
          silhouette={null}
          marks={MARKS}
          highlightPinId="gone"
        />,
      );
      expect(mark(container, 'b')).not.toHaveAttribute('data-dim');
      expect(container.querySelector('[data-pointed]')).toBeNull();
      rerender(
        <InstrumentOverlay
          map={overlayMap()}
          mode={null}
          silhouette={null}
          marks={MARKS}
          highlightPinId="h1"
        />,
      );
      expect(mark(container, 'h1')).not.toHaveAttribute('data-highlight');
      expect(mark(container, 'b')).not.toHaveAttribute('data-dim');
    });

    it('the shore point, set by hand, is bracketed with no name to draw', () => {
      const { container } = render(
        <InstrumentOverlay
          map={overlayMap()}
          mode={null}
          silhouette={null}
          marks={{ pins: PINS, hazards: [], photos: [], point: { lat: 43.8, lng: -72.69 } }}
          highlightPinId="point"
        />,
      );
      expect(mark(container, 'point')).toHaveAttribute('data-highlight');
      expect(mark(container, 'a')).toHaveAttribute('data-dim');
      expect(container.querySelector('[data-slot="instrument-lockup"]')).toBeNull();
    });
  });

  it('where: every mark steps back for the ring', () => {
    const { container } = render(
      <InstrumentOverlay
        map={overlayMap()}
        mode={whereMode(undefined)}
        silhouette={SILHOUETTE}
        marks={MARKS}
      />,
    );
    for (const id of ['a', 'b', 'h1', 'ph'])
      expect(mark(container, id)).toHaveAttribute('data-dim');
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
      <InstrumentOverlay map={map} mode={null} silhouette={null} marks={NO_MARKS} draft={draft} />,
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
        marks={NO_MARKS}
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
        marks={NO_MARKS}
      />,
    );
    expect(() => unmount()).not.toThrow();
    const projection = mapProjection(overlayMap());
    expect(ringCamera(projection, { ...SILHOUETTE, rings: [] }, 12)).toBeNull();
  });
});
