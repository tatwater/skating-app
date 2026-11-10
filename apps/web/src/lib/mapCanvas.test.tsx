/**
 * The shared MapLibre shell (A02, Decision 12).
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
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** One fake map, recording what the shell asked of it. */
class FakeMap {
  static instances: FakeMap[] = [];
  options: Record<string, unknown>;
  handlers = new Map<string, () => void>();
  controls: unknown[] = [];
  removed = false;
  /** MapLibre takes a style write only between `load` and `remove`; `liveMap` is what enforces it. */
  styleLoaded = false;
  paint = new Map<string, unknown>();
  fitted: unknown[] = [];
  resizes = 0;
  rotationDisabled: string[] = [];
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
    this.styleLoaded = false;
  }
  fitBounds(bounds: unknown) {
    this.fitted.push(bounds);
  }
  resize() {
    this.resizes++;
  }
  /**
   * A style write. MapLibre's `_checkLoaded` **throws** before `load` and on a removed map rather
   * than no-opping, which is what turned the theme switch into the crash screen.
   */
  setPaintProperty(key: string, value: unknown) {
    if (!this.styleLoaded) throw new Error('Style is not done loading.');
    this.paint.set(key, value);
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
    this.styleLoaded = true;
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
    // `options` is the one part of MapLibre's control the shell's extra credit is written to.
    AttributionControl: class {
      options: Record<string, unknown> = {};
    },
    NavigationControl: class {},
  },
}));
vi.mock('pmtiles', () => ({ Protocol: class {} }));
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));

const { useMapCanvas } = await import('./mapCanvas');
const { FoldedAttributionControl } = await import('./mapAttribution');

const BOUNDS: [[number, number], [number, number]] = [
  [-73.5, 44],
  [-72.5, 45],
];

/**
 * A host that rebuilds every array-literal option on each render — which is what a real caller does.
 * `LakeEditorMap` derives its center from the body's bbox inline, so this is not a contrived case.
 */
function Host({
  tick,
  onLoad,
  flavor = 'white',
  extraAttribution,
}: {
  tick: number;
  onLoad?: (map: unknown) => void;
  flavor?: 'white' | 'dark';
  extraAttribution?: string | null;
}) {
  const { containerRef } = useMapCanvas({
    pmtilesUrl: 'pmtiles://x',
    flavor,
    extraAttribution,
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

/**
 * A caller shaped like the real ones at the moment of a theme switch: `flavor` and the palette
 * derived from it change in the *same* render, so the effect that writes paint for that palette
 * re-runs in the very commit where the shell destroys one map and builds the next. Every map the
 * effect was handed is recorded.
 */
function PaintHost({ flavor, seen }: { flavor: 'white' | 'dark'; seen: (FakeMap | null)[] }) {
  const { containerRef, liveMap } = useMapCanvas({
    pmtilesUrl: 'pmtiles://x',
    flavor,
    initialCenter: [-73, 44.5],
    initialZoom: 11,
    onLoad: () => {},
  });
  const palette = `palette:${flavor}`;
  useEffect(() => {
    const map = liveMap() as FakeMap | null;
    seen.push(map);
    map?.setPaintProperty('fill-color', palette);
  }, [palette, liveMap, seen]);
  return <div ref={containerRef} />;
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
   * The credits are the folded control, never MapLibre's default one: `attributionControl: false`
   * keeps the default (uncompacted, expanded) one off, and `FoldedAttributionControl` is what goes
   * on instead. How it folds is pinned against the real MapLibre control in `mapAttribution.test`.
   */
  it('credits the map with the folded attribution control, not the default one', () => {
    render(<Host tick={0} />);
    const map = FakeMap.instances[0];
    expect(map?.options.attributionControl).toBe(false);
    expect(map?.controls.filter((c) => c instanceof FoldedAttributionControl)).toHaveLength(1);
  });

  /**
   * A credit no source declares (the skater map's contours') goes into the folded control's own
   * slot, follows the caller in place — a changed credit is not a reason to rebuild the map — and a
   * map re-created for a theme switch starts from the current one. How the control shows it is
   * pinned against the real MapLibre control in `mapAttribution.test`.
   */
  it('hands the folded control the caller’s extra credit and keeps it current, in place', () => {
    const credit = () => {
      const control = FakeMap.instances
        .at(-1)
        ?.controls.find((c) => c instanceof FoldedAttributionControl) as InstanceType<
        typeof FoldedAttributionControl
      >;
      return control.options.customAttribution;
    };
    const { rerender } = render(<Host tick={0} />);
    expect(credit()).toBeUndefined();
    rerender(<Host tick={0} extraAttribution="5 ft contours, surveyed by NH GRANIT." />);
    expect(credit()).toBe('5 ft contours, surveyed by NH GRANIT.');
    expect(FakeMap.instances).toHaveLength(1);
    rerender(
      <Host tick={0} flavor="dark" extraAttribution="5 ft contours, surveyed by NH GRANIT." />,
    );
    expect(FakeMap.instances).toHaveLength(2);
    expect(credit()).toBe('5 ft contours, surveyed by NH GRANIT.');
    rerender(<Host tick={0} flavor="dark" extraAttribution={null} />);
    expect(credit()).toBeUndefined();
    expect(FakeMap.instances).toHaveLength(2);
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

  /**
   * The theme-switch crash (B03 §8.3).
   *
   * `loaded` is React state, so an effect body reads the value from the render that scheduled it —
   * while `mapRef` is mutated during the commit. A theme switch changes `flavor` and the caller's
   * palette in one render, so the cleanup that removed the old map and the body that built the new
   * one both ran in a commit where `loaded` still said `true`: the caller's paint effect, whose
   * deps had changed in that same render, wrote to a map whose style had not loaded. MapLibre
   * throws `Style is not done loading.` there, and the error boundary turned that into the crash
   * screen — the whole app, for picking Dark from the account menu.
   *
   * So the contract is `liveMap()`, not the pair: it is never a map that cannot be written to.
   */
  it('hands a caller no map at all while one is being swapped for the theme', () => {
    const seen: (FakeMap | null)[] = [];
    const { rerender } = render(<PaintHost flavor="white" seen={seen} />);
    FakeMap.instances[0]?.load();
    expect(seen.at(-1)).toBe(FakeMap.instances[0]);

    rerender(<PaintHost flavor="dark" seen={seen} />);
    expect(FakeMap.instances).toHaveLength(2); // the switch re-created it, as it always has
    expect(seen.at(-1)).toBeNull(); // and not the new, unloaded map

    FakeMap.instances[1]?.load();
    expect(seen.at(-1)).toBe(FakeMap.instances[1]); // re-applied once it can take a write
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
