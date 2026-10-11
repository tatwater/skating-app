/**
 * The request queue's map (D202 follow-up): one canvas, following the row the moderator picks.
 * `maplibre-gl` is faked as in `LakeEditorMap.test.tsx` — what this pins is which spot is drawn and
 * where the camera goes, not MapLibre's rendering.
 */

import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sources = new Map<string, { data: unknown }>();

class FakeMap {
  static instances: FakeMap[] = [];
  options: Record<string, unknown>;
  handlers = new Map<string, (e?: unknown) => void>();
  controls: string[] = [];
  layers: string[] = [];

  constructor(options: Record<string, unknown>) {
    this.options = options;
    FakeMap.instances.push(this);
  }
  on(event: string, handler: (e?: unknown) => void) {
    this.handlers.set(event, handler);
  }
  addControl(control: { name: string }) {
    this.controls.push(control.name);
  }
  addSource(id: string, spec: { data: unknown }) {
    sources.set(id, { data: spec.data });
  }
  addLayer(spec: { id: string }) {
    this.layers.push(spec.id);
  }
  getSource(id: string) {
    const source = sources.get(id);
    return source ? { setData: (data: unknown) => sources.set(id, { data }) } : undefined;
  }
  remove() {}
  fitBounds = vi.fn();
  flyTo = vi.fn();
  resize() {}
  /** `useMapCanvas` reaches in to collapse the attribution ⓘ at mount — see its own test. */
  getContainer() {
    return document.createElement('div');
  }
  touchZoomRotate = { disableRotation: () => {} };
  keyboard = { disableRotation: () => {} };
  getCenter() {
    return { lng: -73, lat: 44.5 };
  }
  getZoom() {
    return 11;
  }
  getBounds() {
    return { getSouth: () => 44, getWest: () => -73.5, getNorth: () => 45, getEast: () => -72.5 };
  }
}

vi.mock('maplibre-gl', () => ({
  default: {
    Map: FakeMap,
    addProtocol: vi.fn(),
    removeProtocol: vi.fn(),
    AttributionControl: class {
      name = 'attribution';
    },
    NavigationControl: class {
      name = 'navigation';
    },
  },
}));
vi.mock('pmtiles', () => ({ Protocol: class {} }));
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));

const theme = { resolvedTheme: 'light' };
vi.mock('next-themes', () => ({ useTheme: () => theme }));

const { RequestPreviewMap } = await import('./RequestPreviewMap');

function loadMap() {
  const map = FakeMap.instances[0];
  act(() => {
    map?.handlers.get('load')?.();
  });
  return map;
}

beforeEach(() => {
  FakeMap.instances = [];
  sources.clear();
});

const features = () =>
  ((sources.get('review-points')?.data as GeoJSON.FeatureCollection | undefined)?.features ?? [])
    .length;

describe('RequestPreviewMap', () => {
  it('opens on the row’s spot, unfenced, and names itself for a screen reader', () => {
    render(<RequestPreviewMap review={{ ask: { lat: 44.3, lng: -73.1 } }} />);
    const map = FakeMap.instances[0];
    expect(map?.options.center).toEqual([-73.1, 44.3]);
    expect(map?.options.maxBounds).toBeUndefined();
    expect(screen.getByLabelText('Map of the request’s spot')).toBeInTheDocument();
  });

  it('follows the picked row, and draws a pair when one is shown', () => {
    const { rerender } = render(<RequestPreviewMap review={{ ask: { lat: 44.3, lng: -73.1 } }} />);
    const map = loadMap();
    expect(features()).toBe(1);
    expect(map?.flyTo).toHaveBeenLastCalledWith({
      center: [-73.1, 44.3],
      zoom: 13,
      animate: true,
    });
    rerender(
      <RequestPreviewMap
        review={{
          ask: { lat: 44.5, lng: -73.3 },
          other: { point: { lat: 44.6, lng: -73.3 }, kind: 'proposal', name: 'Long Point' },
        }}
      />,
    );
    expect(features()).toBe(3);
    expect(map?.fitBounds).toHaveBeenCalled();
  });

  it('starts on a wide view with nothing to show', () => {
    render(<RequestPreviewMap review={null} />);
    expect(FakeMap.instances[0]?.options.zoom).toBe(6);
    loadMap();
    expect(features()).toBe(0);
  });
});
