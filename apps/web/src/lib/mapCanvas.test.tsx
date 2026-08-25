/**
 * The shared MapLibre shell (N2, Decision 12).
 *
 * `MapView` was the most load-bearing untested-by-design file in the web app, and the refactor that
 * split its canvas out for the lake editor made that a two-surface problem: a bug here is a bug on
 * both maps. The pure helpers it leans on (`lib/waterMap`) were already covered, but they aren't
 * where the risk is — the risk is in the imperative lifecycle, which is exactly what these exercise.
 *
 * MapLibre needs WebGL, so the `maplibre-gl` module is faked. That's a real limit and worth stating:
 * these tests pin *how the shell drives the map API*, not that MapLibre renders. Camera lock, layer
 * paint and tile loading are the library's job; when we create and destroy the map, what bounds we
 * hand it, and whether a caller's fresh array literal costs them their canvas are ours.
 */

import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** One fake map, recording what the shell asked of it. */
class FakeMap {
  static instances: FakeMap[] = [];
  options: Record<string, unknown>;
  handlers = new Map<string, () => void>();
  controls: unknown[] = [];
  removed = false;
  fitted: unknown[] = [];
  resizes = 0;
  rotationDisabled: string[] = [];
  container: HTMLElement | null = null;
  touchZoomRotate = { disableRotation: () => this.rotationDisabled.push('touch') };
  keyboard = { disableRotation: () => this.rotationDisabled.push('keyboard') };

  constructor(options: Record<string, unknown>) {
    this.options = options;
    FakeMap.instances.push(this);
  }
  on(event: string, handler: () => void) {
    this.handlers.set(event, handler);
  }
  addControl(control: unknown) {
    this.controls.push(control);
  }
  remove() {
    this.removed = true;
  }
  fitBounds(bounds: unknown) {
    this.fitted.push(bounds);
  }
  resize() {
    this.resizes++;
  }
  /**
   * The map's own element, carrying an attribution control in MapLibre's mounted-expanded state —
   * `maplibregl-compact-show` present — so the collapse in `useMapCanvas` has something real to act
   * on rather than silently no-op'ing through an optional chain.
   */
  getContainer() {
    if (!this.container) {
      this.container = document.createElement('div');
      const attrib = document.createElement('details');
      attrib.className = 'maplibregl-ctrl-attrib maplibregl-compact maplibregl-compact-show';
      this.container.append(attrib);
    }
    return this.container;
  }
  getCenter() {
    return { lng: -73, lat: 44.5 };
  }
  getZoom() {
    return 11;
  }
  getBounds() {
    return {
      getSouth: () => 44,
      getWest: () => -73.5,
      getNorth: () => 45,
      getEast: () => -72.5,
    };
  }
  /** Fire `load` the way MapLibre would once the style is ready. */
  load() {
    act(() => {
      this.handlers.get('load')?.();
    });
  }
}

const addProtocol = vi.fn();
const removeProtocol = vi.fn();

vi.mock('maplibre-gl', () => ({
  default: {
    Map: FakeMap,
    addProtocol: (...args: unknown[]) => addProtocol(...args),
    removeProtocol: (...args: unknown[]) => removeProtocol(...args),
    AttributionControl: class {},
    NavigationControl: class {},
  },
}));
vi.mock('pmtiles', () => ({ Protocol: class {} }));
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));

const { useMapCanvas } = await import('./mapCanvas');

const BOUNDS: [[number, number], [number, number]] = [
  [-73.5, 44],
  [-72.5, 45],
];

/**
 * A host that rebuilds every array-literal option on each render — which is what a real caller does.
 * `LakeEditorMap` derives its centre from the body's bbox inline, so this is not a contrived case.
 */
function Host({ tick, onLoad }: { tick: number; onLoad?: (map: unknown) => void }) {
  const { containerRef } = useMapCanvas({
    pmtilesUrl: 'pmtiles://x',
    flavor: 'white',
    maxBounds: [
      [-73.5, 44],
      [-72.5, 45],
    ],
    initialCenter: [-73, 44.5],
    initialZoom: 11,
    minZoom: 9,
    onLoad: onLoad ?? (() => {}),
  });
  return <div ref={containerRef} data-tick={tick} />;
}

beforeEach(() => {
  FakeMap.instances = [];
  addProtocol.mockClear();
  removeProtocol.mockClear();
});

describe('useMapCanvas', () => {
  it('creates one map and hands MapLibre the caller’s camera lock', () => {
    render(<Host tick={0} />);
    expect(FakeMap.instances).toHaveLength(1);
    const map = FakeMap.instances[0];
    expect(map?.options.maxBounds).toEqual(BOUNDS);
    expect(map?.options.minZoom).toBe(9);
    expect(map?.options.center).toEqual([-73, 44.5]);
  });

  /**
   * The regression this file was written for.
   *
   * `initialCenter` is an array literal, so it is a new object on every render. While it sat in the
   * effect's dependency list, any parent state change — a finished draw, a saved banner, a Convex
   * query resolving — tore the canvas down and built a new one. That is a flicker to look at and
   * fatal to anything holding the map: the lake editor's terra-draw control attaches to the instance
   * it was given, so the editor could draw exactly one shape per page load and then silently swallow
   * every click after it.
   */
  it('does NOT re-create the map when the caller re-renders with fresh array literals', () => {
    const { rerender } = render(<Host tick={0} />);
    rerender(<Host tick={1} />);
    rerender(<Host tick={2} />);

    expect(FakeMap.instances).toHaveLength(1);
    expect(FakeMap.instances[0]?.removed).toBe(false);
  });

  it('runs the caller’s onLoad against the live map, once, inside load', () => {
    const onLoad = vi.fn();
    const { rerender } = render(<Host tick={0} onLoad={onLoad} />);
    expect(onLoad).not.toHaveBeenCalled(); // nothing may touch sources before the style is ready

    FakeMap.instances[0]?.load();
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(onLoad).toHaveBeenCalledWith(FakeMap.instances[0]);

    rerender(<Host tick={1} />);
    expect(onLoad).toHaveBeenCalledTimes(1); // and not again on every render
  });

  /**
   * North stays up. Rotation has four separate entry points in MapLibre — right-drag, two-finger
   * twist, shift+arrows, and pitch-with-rotate — and disabling three of them is the same as
   * disabling none, because the map ends up spun either way and `showCompass: false` leaves nothing
   * on screen to undo it with. Hence one test covering all four rather than a spot check.
   */
  it('locks the camera to north on every rotation path', () => {
    render(<Host tick={0} />);
    const map = FakeMap.instances[0];
    expect(map?.options.dragRotate).toBe(false);
    expect(map?.options.pitchWithRotate).toBe(false);
    expect(map?.options.touchPitch).toBe(false);
    expect(map?.rotationDisabled).toEqual(['touch', 'keyboard']);
  });

  /**
   * ⚠ MapLibre mounts a `compact: true` attribution control **expanded**, and only minimises it on
   * the first `drag` — so a map that is read rather than dragged wears every active source's credit
   * across its bottom edge all session. The credits themselves are untouched (they are a licence
   * obligation, and they stay one click behind the ⓘ); it is the rest state being wrong that this
   * pins, because nothing about it is visible from the control's public API.
   */
  it('opens with the attribution credits collapsed behind the ⓘ', () => {
    render(<Host tick={0} />);
    const attrib = FakeMap.instances[0]?.getContainer().querySelector('.maplibregl-ctrl-attrib');
    expect(attrib?.classList.contains('maplibregl-compact-show')).toBe(false);
    // Still compact, so MapLibre's own `resize` handler cannot re-open it: `_updateCompact` only
    // re-adds the show class to a container that has lost the `maplibregl-compact` one.
    expect(attrib?.classList.contains('maplibregl-compact')).toBe(true);
  });

  /**
   * The map's height now comes from the flex layout rather than a fixed `75vh`, and MapLibre sizes
   * its canvas once in the constructor — falling back to 400×300 if the container measured zero at
   * that instant, with only a `ResizeObserver` (which fires on *changes*) to correct it. The
   * re-measure on load is the guard, and it is invisible from the outside, so it is pinned here.
   */
  it('re-measures the container on load', () => {
    render(<Host tick={0} />);
    expect(FakeMap.instances[0]?.resizes).toBe(0);
    FakeMap.instances[0]?.load();
    expect(FakeMap.instances[0]?.resizes).toBe(1);
  });

  it('tears the map down on unmount and releases the pmtiles protocol', () => {
    const { unmount } = render(<Host tick={0} />);
    expect(addProtocol).toHaveBeenCalledTimes(1);
    unmount();
    expect(FakeMap.instances[0]?.removed).toBe(true);
    expect(removeProtocol).toHaveBeenCalledTimes(1);
  });

  /**
   * `addProtocol`/`removeProtocol` are global to maplibre-gl rather than per-map, so an unmount that
   * unregisters unconditionally would break a map still on screen. Refcounted.
   */
  it('keeps the pmtiles protocol registered while a second map is still up', () => {
    const first = render(<Host tick={0} />);
    const second = render(<Host tick={0} />);
    expect(addProtocol).toHaveBeenCalledTimes(1); // registered once, not per map

    first.unmount();
    expect(removeProtocol).not.toHaveBeenCalled(); // the second map still needs it

    second.unmount();
    expect(removeProtocol).toHaveBeenCalledTimes(1);
  });
});
