import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSkaterMapStore } from '@/stores/skaterMapStore';

const maps = vi.hoisted(() => ({ mounts: 0 }));
vi.mock('./SkaterMap', () => ({
  SkaterMap: function FakeMap() {
    useEffect(() => {
      maps.mounts++;
    }, []);
    return <div data-testid="skater-map" />;
  },
}));

import { MapFloat } from './MapFloat';
import { MapFrame } from './MapFrame';
import { exploreMapSpec, lakeMapSpec } from './mapSpec';

beforeEach(() => {
  maps.mounts = 0;
  useSkaterMapStore.setState({ specs: { view: null, flow: null } });
});

const frame = () => document.querySelector('[data-slot="map-frame"]') as HTMLElement;
const view = () => document.querySelector('[data-slot="map-frame-view"]') as HTMLElement;
const mapColumn = () => document.querySelector('[data-slot="map-frame-map"]') as HTMLElement;

describe('MapFrame', () => {
  it('sets a map view in the sidebar column, beside the one map', () => {
    act(() => useSkaterMapStore.getState().declareMapSpec('view', exploreMapSpec()));
    render(<MapFrame>sidebar</MapFrame>);
    expect(frame()).toHaveAttribute('data-map-shown');
    expect(view()).toHaveTextContent('sidebar');
    expect(view().className).not.toContain('col-span-2');
    expect(mapColumn().className.split(' ')).not.toContain('absolute');
    expect(screen.getAllByTestId('skater-map')).toHaveLength(1);
  });

  it('gives a view with no map the whole width, the hidden map still mounted out of the grid', () => {
    render(<MapFrame>settings</MapFrame>);
    expect(frame()).not.toHaveAttribute('data-map-shown');
    expect(view().className).toContain('md:col-span-2');
    expect(mapColumn().className).toContain('absolute');
    expect(mapColumn().className).toContain('pointer-events-none');
    expect(screen.getByTestId('skater-map')).toBeInTheDocument();
  });

  it('keeps the one map mounted as the view changes underneath it', () => {
    act(() => useSkaterMapStore.getState().declareMapSpec('view', exploreMapSpec()));
    const { rerender } = render(<MapFrame>explore</MapFrame>);
    act(() => useSkaterMapStore.getState().declareMapSpec('view', lakeMapSpec('mascoma')));
    rerender(<MapFrame>lake</MapFrame>);
    act(() => useSkaterMapStore.getState().declareMapSpec('view', null));
    rerender(<MapFrame>no map</MapFrame>);
    act(() => useSkaterMapStore.getState().declareMapSpec('view', exploreMapSpec()));
    rerender(<MapFrame>explore again</MapFrame>);
    expect(maps.mounts).toBe(1);
  });

  it('floats a view’s plate over the map, in a layer that passes presses through', () => {
    act(() => useSkaterMapStore.getState().declareMapSpec('view', lakeMapSpec('mascoma')));
    render(
      <MapFrame>
        <MapFloat>
          <p>timeline</p>
        </MapFloat>
      </MapFrame>,
    );
    const slot = document.querySelector('[data-slot="map-float-slot"]') as HTMLElement;
    expect(mapColumn()).toContainElement(slot);
    expect(slot.className).toContain('pointer-events-none');
    const float = slot.querySelector('[data-slot="map-float"]') as HTMLElement;
    expect(float).toHaveTextContent('timeline');
    expect(float.className).toContain('pointer-events-auto');
    // On a phone the plate stops short of the dock's column (zoom, layers) at the top right.
    expect(float.className).toContain(
      'max-md:max-w-[calc(100%-3*var(--space-4)-var(--spacing-btn))]',
    );
  });
});
