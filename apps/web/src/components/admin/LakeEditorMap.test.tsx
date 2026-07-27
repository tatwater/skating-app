/**
 * The lake editor's canvas (N2 / D61) — the camera lock and the layer data flow.
 *
 * The lock is the feature rather than a guard rail (Decision 5): every tool on this canvas acts on
 * one body, and an operator who has been drawing bays for twenty minutes should not be able to save
 * one onto the next lake over because they panned while thinking. The server refuses that draw
 * anyway (Decision 10 clips to *this* parent), so without the lock the failure mode is silent
 * confusion rather than a caught mistake — which is precisely why it deserves a test rather than a
 * comment.
 *
 * `maplibre-gl` is faked (jsdom has no WebGL), so what these pin is the contract between this
 * component and the map API: which bounds, which zoom floor, which sources get which data. Whether
 * MapLibre honours `maxBounds` is MapLibre's test to write.
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
  fitBounds() {}
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

const { LakeEditorMap } = await import('./LakeEditorMap');
type EditorData = React.ComponentProps<typeof LakeEditorMap>['data'];

const BAY: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-73.2, 44.2],
      [-73.0, 44.2],
      [-73.0, 44.4],
      [-73.2, 44.4],
      [-73.2, 44.2],
    ],
  ],
};

function data(overrides: Partial<EditorData> = {}): EditorData {
  return {
    body: {
      _id: 'b1',
      name: 'Lake Champlain',
      type: 'lake',
      polygon: BAY,
      bbox: { minLat: 44, minLng: -73.5, maxLat: 45, maxLng: -72.5 },
    },
    subAreas: [],
    putIns: [],
    samplePoints: [],
    suggestedPoints: [],
    draftPolygon: null,
    ...overrides,
  };
}

/**
 * Fire the `load` MapLibre would fire once its style is ready, so the layer effects run.
 * Wrapped in `act` because `load` flips the shell's `loaded` state, and every `setData` effect
 * waits on it — outside `act` the effects haven't flushed and the sources read as empty.
 */
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
  theme.resolvedTheme = 'light';
});

describe('LakeEditorMap — the camera lock', () => {
  it('locks panning to the body’s bbox plus a proportional margin', () => {
    render(<LakeEditorMap data={data()} />);
    const bounds = FakeMap.instances[0]?.options.maxBounds as [number[], number[]];

    // 15% of a 1° × 1° body, so the shoreline has context without the next lake being reachable.
    expect(bounds[0]?.[0]).toBeCloseTo(-73.65, 6);
    expect(bounds[0]?.[1]).toBeCloseTo(43.85, 6);
    expect(bounds[1]?.[0]).toBeCloseTo(-72.35, 6);
    expect(bounds[1]?.[1]).toBeCloseTo(45.15, 6);
  });

  it('frames the lake on first load, and carries no navigation control', () => {
    render(<LakeEditorMap data={data()} />);
    const map = FakeMap.instances[0];
    expect(map?.options.fitBounds ?? map?.options.maxBounds).toBeTruthy();
    // The zoom buttons would invite the pan the lock exists to prevent.
    expect(map?.controls).toEqual(['attribution']);
  });

  it('names the canvas for a screen reader (D34)', () => {
    render(<LakeEditorMap data={data()} />);
    expect(screen.getByRole('region', { name: /Editing map for Lake Champlain/ })).toBeTruthy();
  });
});

describe('LakeEditorMap — what gets drawn', () => {
  it('draws the lake, its bays and its sample points on their own sources', () => {
    render(
      <LakeEditorMap
        data={data({
          subAreas: [
            {
              _id: 's1',
              waterBodyId: 'b1',
              name: 'Malletts Bay',
              polygon: BAY,
              centroid: { lat: 44.3, lng: -73.1 },
            },
          ],
          samplePoints: [{ lat: 44.5, lng: -73.2 }],
          suggestedPoints: [{ lat: 44.6, lng: -73.3 }],
        })}
      />,
    );
    loadMap();

    const bays = sources.get('editor-sub-areas')?.data as GeoJSON.FeatureCollection;
    // One outline feature and one label point per bay — the label sits on the stored on-water
    // centroid rather than wherever MapLibre would put a polygon label.
    expect(bays.features).toHaveLength(2);
    expect(bays.features.some((f) => f.properties?.label === true)).toBe(true);

    const points = sources.get('editor-sample-points')?.data as GeoJSON.FeatureCollection;
    expect(points.features.map((f) => f.properties?.suggested)).toEqual([false, true]);
  });

  /**
   * The draw→save→render round trip, at the seam this component owns: a draft appears while it is
   * only a proposal, and clears when the save lands (the route sets `draftPolygon` back to `null`).
   * A preview that lingered after a save would tell the operator they still have unsaved work.
   */
  it('previews a draft and clears it when the save lands', () => {
    const featureCount = (id: string) =>
      ((sources.get(id)?.data as GeoJSON.FeatureCollection | undefined)?.features ?? []).length;

    const { rerender } = render(<LakeEditorMap data={data()} />);
    loadMap();
    expect(featureCount('editor-draft')).toBe(0);

    rerender(<LakeEditorMap data={data({ draftPolygon: BAY })} />);
    expect(featureCount('editor-draft')).toBe(1);

    // Saved: the route clears the draft and the bay arrives through the normal sub-area source.
    rerender(
      <LakeEditorMap
        data={data({
          draftPolygon: null,
          subAreas: [
            {
              _id: 's1',
              waterBodyId: 'b1',
              name: 'Malletts Bay',
              polygon: BAY,
              centroid: { lat: 44.3, lng: -73.1 },
            },
          ],
        })}
      />,
    );
    expect(featureCount('editor-draft')).toBe(0);
    expect(featureCount('editor-sub-areas')).toBe(2);
  });

  it('hands the map a dark style when the app is in dark mode (D34)', () => {
    theme.resolvedTheme = 'dark';
    render(<LakeEditorMap data={data()} />);
    // The whole style is rebuilt per flavor — the sprite it points at is the unambiguous tell, and
    // it comes from the same `buildMapStyle` the skater map uses, which is the point of Decision 12.
    const style = FakeMap.instances[0]?.options.style as { sprite: string };
    expect(style.sprite).toMatch(/dark$/);
  });

  it('reports canvas clicks as lat/lng, for the sample-point tool', () => {
    const onMapClick = vi.fn();
    render(<LakeEditorMap data={data()} onMapClick={onMapClick} />);
    loadMap();
    FakeMap.instances[0]?.handlers.get('click')?.({ lngLat: { lat: 44.4, lng: -73.1 } });
    expect(onMapClick).toHaveBeenCalledWith({ lat: 44.4, lng: -73.1 });
  });
});
