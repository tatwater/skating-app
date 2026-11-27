import { act, render, waitFor } from '@testing-library/react';
import fc from 'fast-check';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { freezeUpLaneIds } from '@/components/useFreezeUpFrame';
import { type BBoxLike, fitCamera, type Padding } from '@/lib/mapSurface';
import { MASCOMA_BOUNDS, MASCOMA_SCENE } from '../frame/bodyFixtures';
import { floorZoom, ZOOM_OUT_ROOM } from './bodyMapFraming';
import { adminToken } from './bodyMapPalette';
import { DEFAULT_LAYERS, type DrawnScene, drawScene } from './bodyScene';
import { AERIAL_PAINT } from './consoleAerial';
import { DOT_SOURCE, LINE_SOURCE, OUTLINE_SOURCE } from './glLayers';

/**
 * The console map's MapLibre half, against a fake map that behaves as MapLibre does where it bit the
 * skater map (B03 §8.5): **every style write before `load` or after `remove` throws**. The shell
 * (`useMapCanvas`) is replaced by one that hands out `liveMap` as the real one does — `null` until
 * the style loads, a fresh identity when it does.
 */

class FakeMap {
  loaded = false;
  removed = false;
  sources = new Map<string, { setData: (d: unknown) => void; data: unknown }>();
  layers = new Map<string, { paint: Record<string, unknown> }>();
  /** The layers' order, bottom to top, as MapLibre keeps it: `before` inserts under that layer. */
  order: string[] = [];
  handlers = new Map<string, Set<() => void>>();
  minZoom = 0;
  maxZoom = 22;
  zoom = 12;
  private check() {
    if (!this.loaded || this.removed) throw new Error('Style is not done loading.');
  }
  addSource(id: string, spec: { data: unknown }) {
    this.check();
    const src = {
      data: spec.data,
      setData: (d: unknown) => {
        this.check();
        src.data = d;
      },
      // A canvas source's (the summer aerial's) re-upload pair.
      setCoordinates: () => {},
      play: () => {},
      pause: () => {},
    };
    this.sources.set(id, src);
  }
  getSource(id: string) {
    return this.sources.get(id);
  }
  addLayer(layer: { id: string; paint?: Record<string, unknown> }, before?: string) {
    this.check();
    this.layers.set(layer.id, { paint: { ...(layer.paint ?? {}) } });
    this.place(layer.id, before);
  }
  moveLayer(id: string, before?: string) {
    this.check();
    this.order = this.order.filter((l) => l !== id);
    this.place(id, before);
  }
  removeLayer(id: string) {
    this.layers.delete(id);
    this.order = this.order.filter((l) => l !== id);
  }
  removeSource(id: string) {
    this.sources.delete(id);
  }
  private place(id: string, before?: string) {
    const at = before === undefined ? -1 : this.order.indexOf(before);
    if (at < 0) this.order.push(id);
    else this.order.splice(at, 0, id);
  }
  getLayersOrder() {
    return [...this.order];
  }
  /** Every source's tiles are in, so a pass reveals (and is raised) as soon as it is added. */
  isSourceLoaded() {
    return true;
  }
  getLayer(id: string) {
    return this.layers.get(id);
  }
  setPaintProperty(id: string, prop: string, value: unknown) {
    this.check();
    const l = this.layers.get(id);
    if (l) l.paint[prop] = value;
  }
  /** The container's box: zero while its pane is hidden. */
  box = { clientWidth: 656, clientHeight: 830 };
  getContainer() {
    return this.box as HTMLElement;
  }
  jumps = 0;
  jumpTo({ zoom }: { zoom: number }) {
    this.jumps++;
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
  }
  /** The pane shown or hidden, or resized: MapLibre resizes and says so. */
  resizeTo(clientWidth: number, clientHeight: number) {
    this.box = { clientWidth, clientHeight };
    for (const fn of this.handlers.get('resize') ?? []) fn();
  }
  // MapLibre's own rules: a floor over the ceiling, or a ceiling under the floor, throws.
  setMinZoom(z: number) {
    if (z < 0 || z > this.maxZoom) throw new Error('minZoom must be between 0 and the maxZoom');
    this.minZoom = z;
  }
  setMaxZoom(z: number) {
    if (z < this.minZoom) throw new Error('maxZoom must be greater than the current minZoom');
    this.maxZoom = z;
  }
  getMinZoom() {
    return this.minZoom;
  }
  getMaxZoom() {
    return this.maxZoom;
  }
  getZoom() {
    return this.zoom;
  }
  getCenter() {
    return { lng: -72.15, lat: 43.63 };
  }
  getBounds() {
    const b = MASCOMA_BOUNDS;
    return {
      getSouth: () => b.minLat,
      getNorth: () => b.maxLat,
      getWest: () => b.minLng,
      getEast: () => b.maxLng,
    };
  }
  project([lng, lat]: [number, number]) {
    return { x: lng, y: lat };
  }
  unproject([x, y]: [number, number]) {
    return { lng: x, lat: y };
  }
  zoomIn = vi.fn();
  zoomOut = vi.fn();
  on(ev: string, fn: () => void) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)?.add(fn);
  }
  off(ev: string, fn: () => void) {
    this.handlers.get(ev)?.delete(fn);
  }
}

const shell = vi.hoisted(() => ({
  map: null as FakeMap | null,
  live: false,
  onLoad: null as ((m: FakeMap) => void) | null,
  maxBounds: null as unknown,
  flavor: null as string | null,
}));

vi.mock('@/lib/mapCanvas', () => ({
  MAP_CONTAINER_CLASS: 'size-full',
  useMapCanvas: (opts: { onLoad: (m: FakeMap) => void; maxBounds?: unknown; flavor: string }) => {
    shell.onLoad = opts.onLoad;
    shell.maxBounds = opts.maxBounds;
    shell.flavor = opts.flavor;
    const live = shell.live;
    const map = shell.map;
    // A fresh identity per readiness, as the real accessor has.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the fake shell's readiness is read per render, as the real hook's state is.
    const liveMap = useMemo(() => () => (live ? map : null), [live, map]);
    return { containerRef: { current: null }, mapRef: { current: map }, loaded: live, liveMap };
  },
}));

// The archive is configured, so a scene's pass is painted (the reveal draws nothing without it).
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'imageryArchiveUrl' ? 'https://archive.example' : Reflect.get(target, key),
    }),
  };
});

// The summer aerial's cells: decoded at once, never fetched (the reveal's own tests cover the cache).
const tiles = vi.hoisted(() => ({ load: vi.fn(async () => ({}) as ImageBitmap) }));
vi.mock('@/lib/imageryCache', () => ({
  loadTile: () => tiles.load(),
  isTileResident: () => true,
}));
// …and its credit's date: never asked of the network here.
vi.mock('./consoleAerial', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./consoleAerial')>()),
  useAerialCredit: (on: boolean) => (on ? 'Aerial · NAIP' : null),
}));

const {
  AERIAL_GROUND_LAYER,
  FIT_PADDING: FIT_PADDING_FOR_TEST,
  useBodyMapCanvas,
} = await import('./useBodyMapCanvas');

/** Imagery's lit pass, as its scene hands it to the frame. */
const PASS: NonNullable<DrawnScene['raster']> = {
  kind: 'raster',
  id: 'pass:visual.S2C_A',
  layer: 'aerial',
  granuleId: 'S2C_A',
  band: 'visual',
  capturedAt: '2026-12-22T15:51:05Z',
  key: 'frames/winter-2026-27/S2C_A-visual.pmtiles',
  season: 'winter-2026-27',
};

function Harness({
  mode,
  bbox = MASCOMA_BOUNDS,
  raster = null,
  padding,
  reach,
  aerial,
  maxZoom,
}: {
  mode: 'dark' | 'light';
  bbox?: typeof MASCOMA_BOUNDS;
  raster?: DrawnScene['raster'];
  padding?: Padding;
  reach?: BBoxLike | null;
  aerial?: boolean;
  maxZoom?: number;
}) {
  const drawn = useMemo(() => ({ ...drawScene(MASCOMA_SCENE, DEFAULT_LAYERS), raster }), [raster]);
  const canvas = useBodyMapCanvas({ bbox, mode, drawn, padding, reach, aerial, maxZoom });
  return (
    <div
      data-testid="zoom"
      data-credit={canvas.aerialCredit ?? undefined}
      data-aerial-load={canvas.aerialLoad?.load}
      data-aerial-pending={canvas.aerialLoad?.pending ? '' : undefined}
      data-inks={canvas.inks}
    >
      {canvas.surface ? 'live' : 'waiting'}
      {canvas.aerialLoad?.onRetry && (
        <button type="button" onClick={canvas.aerialLoad.onRetry}>
          retry
        </button>
      )}
    </div>
  );
}

beforeEach(() => {
  shell.map = new FakeMap();
  shell.live = false;
  shell.onLoad = null;
  // Reset, not cleared: a test that makes the cells fail must not leave the next one failing with
  // it, however it ends (a reset puts back the implementation the mock was made with).
  tiles.load.mockReset();
});

describe('useBodyMapCanvas', () => {
  it('writes nothing to a map whose style has not loaded', () => {
    // The fake throws on any early write; rendering without one proves nothing was attempted.
    const { getByTestId } = render(<Harness mode="dark" />);
    expect(getByTestId('zoom').textContent).toBe('waiting');
    expect(shell.map?.sources.size).toBe(0);
  });

  it('adds its sources and layers on load, framed and fenced to the body', () => {
    const map = shell.map as FakeMap;
    const { rerender, getByTestId } = render(<Harness mode="dark" />);
    map.loaded = true;
    shell.onLoad?.(map);
    shell.live = true;
    rerender(<Harness mode="dark" />);
    expect([...map.sources.keys()]).toEqual([OUTLINE_SOURCE, LINE_SOURCE, DOT_SOURCE]);
    expect(map.layers.has('body-console-outline-body')).toBe(true);
    expect(map.minZoom).toBeCloseTo(map.zoom - 1.5, 6);
    expect(map.maxZoom).toBe(17);
    expect(getByTestId('zoom').textContent).toBe('live');
  });

  it('repaints for the mode once the map can take it — and never on a dead map', () => {
    const map = shell.map as FakeMap;
    const { rerender } = render(<Harness mode="dark" />);
    map.loaded = true;
    shell.onLoad?.(map);
    shell.live = true;
    rerender(<Harness mode="dark" />);
    expect(map.layers.get('body-console-outline-body')?.paint['line-color']).toBe(
      adminToken('dark', 'fg1'),
    );

    // A theme switch: the shell re-creates the map, so the old one is gone and the new one is not
    // ready — `liveMap` is null in that commit, and the palette effect must not touch either.
    map.removed = true;
    const next = new FakeMap();
    shell.map = next;
    shell.live = false;
    expect(() => rerender(<Harness mode="light" />)).not.toThrow();

    next.loaded = true;
    shell.onLoad?.(next);
    shell.live = true;
    rerender(<Harness mode="light" />);
    expect(next.layers.get('body-console-outline-body')?.paint['line-color']).toBe(
      adminToken('light', 'fg1'),
    );
  });

  it('lays a pass over the body’s fill and under the fields, the shore and every line', () => {
    const map = shell.map as FakeMap;
    const { rerender } = render(<Harness mode="dark" raster={PASS} />);
    map.loaded = true;
    shell.onLoad?.(map);
    shell.live = true;
    rerender(<Harness mode="dark" raster={PASS} />);
    // Added under the contract's next band, then raised there as its tiles report: both placements
    // read the console's order, never the reveal's own anchor (under the roads, so under the fill).
    const order = map.getLayersOrder();
    const pass = order.indexOf(freezeUpLaneIds('primary', 0).layerId);
    expect(pass).toBeGreaterThan(order.indexOf('body-console-fill-body'));
    expect(pass).toBeGreaterThan(order.indexOf('body-console-fill-footprint'));
    expect(order[pass + 1]).toBe('body-console-field-dots');
    expect(pass).toBeLessThan(order.indexOf('body-console-outline-body'));
    expect(pass).toBeLessThan(order.indexOf('body-console-line-approach'));
  });

  it('frames a pond too small for the ceiling without throwing, and goes live', () => {
    // About 30 m across: the fit lands past zoom 19, so a floor of fit − 1.5 is over the ceiling.
    const pond = { minLng: -72.1502, minLat: 43.63, maxLng: -72.1498, maxLat: 43.6302 };
    const map = shell.map as FakeMap;
    const { rerender, getByTestId } = render(<Harness mode="dark" bbox={pond} />);
    map.loaded = true;
    expect(() => shell.onLoad?.(map)).not.toThrow();
    expect(map.maxZoom).toBe(17);
    expect(map.minZoom).toBeLessThanOrEqual(17);
    expect(map.zoom).toBe(17);
    shell.live = true;
    rerender(<Harness mode="dark" bbox={pond} />);
    expect(getByTestId('zoom').textContent).toBe('live');
  });

  it('keeps the operator’s own view across a theme switch, and frames a new body afresh', () => {
    const map = shell.map as FakeMap;
    const { rerender } = render(<Harness mode="dark" />);
    map.loaded = true;
    shell.onLoad?.(map);
    const framed = map.zoom;

    // The shell re-creates the map at the view the operator left (here, zoom 13): not re-framed.
    const next = new FakeMap();
    next.zoom = 13;
    shell.map = next;
    rerender(<Harness mode="light" />);
    next.loaded = true;
    shell.onLoad?.(next);
    expect(next.zoom).toBe(13);
    expect(next.minZoom).toBeCloseTo(framed - 1.5, 6);

    // Another body's bounds are framed again.
    const other = new FakeMap();
    shell.map = other;
    const moved = {
      minLng: MASCOMA_BOUNDS.minLng + 0.5,
      minLat: MASCOMA_BOUNDS.minLat,
      maxLng: MASCOMA_BOUNDS.maxLng + 0.5,
      maxLat: MASCOMA_BOUNDS.maxLat,
    };
    rerender(<Harness mode="light" bbox={moved} />);
    other.loaded = true;
    shell.onLoad?.(other);
    expect(other.zoom).toBeCloseTo(framed, 6);
  });

  describe('framing only in a real box (a hidden pane measures zero)', () => {
    /** Loaded (and gone live) while its container measures `w × h`. */
    const loadAt = (w: number, h: number, bbox = MASCOMA_BOUNDS) => {
      const map = shell.map as FakeMap;
      map.box = { clientWidth: w, clientHeight: h };
      const view = render(<Harness mode="dark" bbox={bbox} />);
      map.loaded = true;
      shell.onLoad?.(map);
      shell.live = true;
      view.rerender(<Harness mode="dark" bbox={bbox} />);
      return { map, view };
    };
    /** The zoom the body frames at in a real box of this size, read off a map loaded visible. */
    const framedAt = (w: number, h: number, bbox = MASCOMA_BOUNDS) => {
      // The shell as it was, put back whole: a probe never leaves the harness under test unready.
      const saved = { map: shell.map, live: shell.live, onLoad: shell.onLoad };
      shell.map = new FakeMap();
      const { map, view } = loadAt(w, h, bbox);
      view.unmount();
      Object.assign(shell, saved);
      return map.zoom;
    };

    it('a load in a hidden pane frames nothing, and the body is framed when it is shown', () => {
      const expected = framedAt(360, 600);
      const { map } = loadAt(0, 0);
      expect(map.jumps).toBe(0);
      expect(map.minZoom).toBe(0);
      map.resizeTo(360, 600);
      expect(map.zoom).toBeCloseTo(expected, 6);
      expect(map.minZoom).toBeCloseTo(expected - 1.5, 6);
    });

    it('another body loaded while hidden is framed on show — the new body, not the old', () => {
      const moved = {
        minLng: MASCOMA_BOUNDS.minLng + 0.5,
        minLat: MASCOMA_BOUNDS.minLat,
        maxLng: MASCOMA_BOUNDS.maxLng + 0.02,
        maxLat: MASCOMA_BOUNDS.maxLat + 0.01,
      };
      const expected = framedAt(360, 600, moved);
      const { map, view } = loadAt(360, 600);
      // Hidden, then another body: the shell re-creates the map in the hidden pane.
      map.resizeTo(0, 0);
      const next = new FakeMap();
      next.box = { clientWidth: 0, clientHeight: 0 };
      shell.map = next;
      shell.live = false;
      view.rerender(<Harness mode="dark" bbox={moved} />);
      next.loaded = true;
      shell.onLoad?.(next);
      shell.live = true;
      view.rerender(<Harness mode="dark" bbox={moved} />);
      expect(next.jumps).toBe(0);
      next.resizeTo(360, 600);
      expect(next.zoom).toBeCloseTo(expected, 6);
    });

    it('a body left for another loaded hidden is framed afresh on its return', () => {
      const moved = {
        minLng: MASCOMA_BOUNDS.minLng + 0.5,
        minLat: MASCOMA_BOUNDS.minLat,
        maxLng: MASCOMA_BOUNDS.maxLng + 0.02,
        maxLat: MASCOMA_BOUNDS.maxLat + 0.01,
      };
      const expected = framedAt(360, 600);
      const { map, view } = loadAt(360, 600);
      expect(map.jumps).toBe(1);
      // Hidden, then another body: its map takes the camera in the hidden pane, never framed.
      map.resizeTo(0, 0);
      const other = new FakeMap();
      other.box = { clientWidth: 0, clientHeight: 0 };
      shell.map = other;
      shell.live = false;
      view.rerender(<Harness mode="dark" bbox={moved} />);
      other.loaded = true;
      shell.onLoad?.(other);
      shell.live = true;
      view.rerender(<Harness mode="dark" bbox={moved} />);
      // Back to the first body, still hidden: the shell re-creates its map at the other's camera.
      const back = new FakeMap();
      back.box = { clientWidth: 0, clientHeight: 0 };
      back.zoom = 16;
      shell.map = back;
      shell.live = false;
      view.rerender(<Harness mode="dark" />);
      back.loaded = true;
      shell.onLoad?.(back);
      shell.live = true;
      view.rerender(<Harness mode="dark" />);
      expect(back.jumps).toBe(0);
      back.resizeTo(360, 600);
      expect(back.jumps).toBe(1);
      expect(back.zoom).toBeCloseTo(expected, 6);
    });

    it('a camera the operator moved is theirs: leaving and coming back never frames it again', () => {
      const { map } = loadAt(360, 600);
      expect(map.jumps).toBe(1);
      map.zoom = 14.25;
      map.resizeTo(0, 0);
      map.resizeTo(360, 600);
      expect(map.jumps).toBe(1);
      expect(map.zoom).toBe(14.25);
    });

    it('a resize while hidden gives the shown map the floor of its new size', () => {
      const { map } = loadAt(0, 0);
      map.resizeTo(0, 0);
      const expected = framedAt(390, 700);
      map.resizeTo(390, 700);
      expect(map.zoom).toBeCloseTo(expected, 6);
      expect(map.minZoom).toBeCloseTo(expected - 1.5, 6);
      // Framed once, at the size it was shown at.
      expect(map.jumps).toBe(1);
    });
  });
});

/** Loads the harness's map and makes it live; returns the map. */
function loadLive(props: Parameters<typeof Harness>[0]) {
  const map = shell.map as FakeMap;
  const { rerender } = render(<Harness {...props} />);
  map.loaded = true;
  shell.onLoad?.(map);
  shell.live = true;
  rerender(<Harness {...props} />);
  return map;
}

describe('an embed’s own room and reach (the Inbox)', () => {
  it('frames inside the padding it is given, the console’s by default', () => {
    const consoleZoom = loadLive({ mode: 'dark' }).zoom;
    shell.map = new FakeMap();
    const none = { top: 0, right: 0, bottom: 0, left: 0 };
    const bare = loadLive({ mode: 'dark', padding: none });
    // No chrome to leave room for: the same body frames closer.
    expect(bare.zoom).toBeGreaterThan(consoleZoom);
    expect(bare.zoom).toBeCloseTo(fitCamera(MASCOMA_BOUNDS, 656, 830, none).zoom, 6);
  });

  it('fences to the reach and lets the floor see it whole, when the reach is wider', () => {
    const w = MASCOMA_BOUNDS.maxLng - MASCOMA_BOUNDS.minLng;
    const h = MASCOMA_BOUNDS.maxLat - MASCOMA_BOUNDS.minLat;
    const reach = {
      minLng: MASCOMA_BOUNDS.minLng - 4 * w,
      maxLng: MASCOMA_BOUNDS.maxLng + 4 * w,
      minLat: MASCOMA_BOUNDS.minLat - 4 * h,
      maxLat: MASCOMA_BOUNDS.maxLat + 4 * h,
    };
    const map = loadLive({ mode: 'dark', reach });
    const reachZoom = fitCamera(reach, 656, 830, FIT_PADDING_FOR_TEST).zoom;
    expect(map.minZoom).toBeCloseTo(reachZoom, 6);
    expect(map.minZoom).toBeLessThan(map.zoom - ZOOM_OUT_ROOM);
    expect(shell.maxBounds).toEqual([
      [reach.minLng - (reach.maxLng - reach.minLng), reach.minLat - (reach.maxLat - reach.minLat)],
      [reach.maxLng + (reach.maxLng - reach.minLng), reach.maxLat + (reach.maxLat - reach.minLat)],
    ]);
  });

  it('keeps the frame’s own fence and floor with no reach', () => {
    const map = loadLive({ mode: 'dark', reach: null });
    expect(map.minZoom).toBeCloseTo(map.zoom - ZOOM_OUT_ROOM, 6);
    const b = MASCOMA_BOUNDS;
    const dx = b.maxLng - b.minLng;
    const dy = b.maxLat - b.minLat;
    expect(shell.maxBounds).toEqual([
      [b.minLng - dx, b.minLat - dy],
      [b.maxLng + dx, b.maxLat + dy],
    ]);
  });
});

describe('a caller’s ceiling (the Corpus head map’s)', () => {
  const pond = { minLng: -72.1502, minLat: 43.63, maxLng: -72.1498, maxLat: 43.6302 };

  it('frames a pond closer than the console’s 17 when the caller says, and holds the floor under it', () => {
    const map = loadLive({ mode: 'dark', bbox: pond, maxZoom: 19 });
    expect(map.maxZoom).toBe(19);
    expect(map.zoom).toBe(19);
    expect(map.minZoom).toBeLessThanOrEqual(19);
  });

  it('is the console’s 17 unless said', () => {
    expect(loadLive({ mode: 'dark', bbox: pond }).maxZoom).toBe(17);
  });
});

describe('the summer aerial', () => {
  /** A 2D context that draws nothing: jsdom has none, and the reveal bails without one. */
  beforeEach(() => {
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
  });
  // …and jsdom's own back after each: the stand-in never reaches the suites below.
  afterEach(() => vi.restoreAllMocks());

  const aerialLayer = (map: FakeMap) => map.layers.get('imagery-raster');

  it('draws nothing of it while off', async () => {
    const map = loadLive({ mode: 'dark' });
    await Promise.resolve();
    expect(aerialLayer(map)).toBeUndefined();
    expect(tiles.load).not.toHaveBeenCalled();
  });

  it('lays the photograph over the fills and under the fields and every line, dimmed for the mode', async () => {
    const map = loadLive({ mode: 'dark', aerial: true });
    await waitFor(() => expect(aerialLayer(map)).toBeDefined());
    const order = map.getLayersOrder();
    const at = order.indexOf('imagery-raster');
    expect(at).toBeGreaterThan(order.indexOf('body-console-fill-body'));
    expect(order[at + 1]).toBe('body-console-field-dots');
    expect(at).toBeLessThan(order.indexOf('body-console-outline-body'));
    expect(aerialLayer(map)?.paint).toMatchObject(AERIAL_PAINT);
  });

  it('in the light, the same paint: the inks over it are light in both themes', async () => {
    const map = loadLive({ mode: 'light', aerial: true });
    await waitFor(() => expect(aerialLayer(map)).toBeDefined());
    expect(aerialLayer(map)?.paint).toMatchObject(AERIAL_PAINT);
  });

  it('in the light theme, the map draws in the dark map’s inks while it is on, the page’s off', async () => {
    const map = shell.map as FakeMap;
    const view = render(<Harness mode="light" aerial />);
    map.loaded = true;
    shell.onLoad?.(map);
    shell.live = true;
    view.rerender(<Harness mode="light" aerial />);
    const shore = () => map.layers.get('body-console-outline-body')?.paint['line-color'];
    const ground = () => map.layers.get(AERIAL_GROUND_LAYER);
    expect(shore()).toBe(adminToken('dark', 'fg1'));
    expect(view.getByTestId('zoom').dataset.inks).toBe('dark');
    // A dark ground under the console's layers, so a cell still loading (or one that didn't come)
    // leaves dark ground under the light inks; the basemap stays the page's, so nothing re-creates.
    expect(ground()?.paint['background-color']).toBe(adminToken('dark', 'map-earth'));
    const order = map.getLayersOrder();
    expect(order.indexOf(AERIAL_GROUND_LAYER)).toBeLessThan(
      order.indexOf('body-console-fill-body'),
    );
    expect(shell.flavor).toBe('white');
    // Off: the page's own inks come straight back, and the ground comes up.
    view.rerender(<Harness mode="light" aerial={false} />);
    expect(shell.flavor).toBe('white');
    expect(shore()).toBe(adminToken('light', 'fg1'));
    expect(ground()).toBeUndefined();
    expect(view.getByTestId('zoom').dataset.inks).toBe('light');
  });

  it('keeps the dark map’s inks and ground while it loads and when it didn’t load — never light on light', async () => {
    tiles.load.mockResolvedValue(null as unknown as ImageBitmap);
    const map = shell.map as FakeMap;
    const view = render(<Harness mode="light" aerial />);
    // Loading: the map is coming up, nothing is in.
    expect(view.getByTestId('zoom').dataset.aerialLoad).toBe('loading');
    expect(view.getByTestId('zoom').dataset.inks).toBe('dark');
    map.loaded = true;
    shell.onLoad?.(map);
    shell.live = true;
    view.rerender(<Harness mode="light" aerial />);
    await waitFor(() => expect(view.getByTestId('zoom').dataset.aerialLoad).toBe('failed'));
    expect(view.getByTestId('zoom').dataset.inks).toBe('dark');
    expect(map.layers.has(AERIAL_GROUND_LAYER)).toBe(true);
    expect(map.layers.get('body-console-outline-body')?.paint['line-color']).toBe(
      adminToken('dark', 'fg1'),
    );
  });

  it('leaves a winter pass where it was in the light theme too: over the photograph', async () => {
    const map = loadLive({ mode: 'light', raster: PASS, aerial: true });
    await waitFor(() => expect(aerialLayer(map)).toBeDefined());
    const order = map.getLayersOrder();
    expect(order.indexOf('imagery-raster')).toBeLessThan(
      order.indexOf(freezeUpLaneIds('primary', 0).layerId),
    );
  });

  it('in the dark theme, nothing changes but the photograph and its ground', () => {
    const map = loadLive({ mode: 'dark', aerial: true });
    expect(shell.flavor).toBe('dark');
    expect(map.layers.has(AERIAL_GROUND_LAYER)).toBe(true);
    expect(map.layers.get('body-console-outline-body')?.paint['line-color']).toBe(
      adminToken('dark', 'fg1'),
    );
  });

  it('goes under a winter pass already up, never over it', async () => {
    const map = loadLive({ mode: 'dark', raster: PASS, aerial: true });
    await waitFor(() => expect(aerialLayer(map)).toBeDefined());
    const order = map.getLayersOrder();
    expect(order.indexOf('imagery-raster')).toBeLessThan(
      order.indexOf(freezeUpLaneIds('primary', 0).layerId),
    );
  });

  it('comes off with the switch, and says its credit only while on', async () => {
    const map = shell.map as FakeMap;
    const view = render(<Harness mode="dark" aerial />);
    map.loaded = true;
    shell.onLoad?.(map);
    shell.live = true;
    view.rerender(<Harness mode="dark" aerial />);
    await waitFor(() => expect(aerialLayer(map)).toBeDefined());
    expect(view.getByTestId('zoom').dataset.credit).toBe('Aerial · NAIP');
    view.rerender(<Harness mode="dark" aerial={false} />);
    expect(aerialLayer(map)).toBeUndefined();
    expect(map.sources.has('imagery')).toBe(false);
    expect(view.getByTestId('zoom').dataset.credit).toBeUndefined();
  });

  /** The map loaded with the aerial on, as the harness's live view. */
  function aerialLive() {
    const map = shell.map as FakeMap;
    const view = render(<Harness mode="dark" aerial />);
    map.loaded = true;
    shell.onLoad?.(map);
    shell.live = true;
    view.rerender(<Harness mode="dark" aerial />);
    return { map, view, zoom: () => view.getByTestId('zoom') };
  }

  it('its credit is loading until the cells are in, then loaded; off, it says nothing', async () => {
    const { view, zoom } = aerialLive();
    await waitFor(() => expect(zoom().dataset.aerialLoad).toBe('loaded'));
    view.rerender(<Harness mode="dark" aerial={false} />);
    expect(zoom().dataset.aerialLoad).toBeUndefined();
  });

  it('says failed when no cell came, and Try again asks again until the photograph is in', async () => {
    tiles.load.mockResolvedValue(null as unknown as ImageBitmap);
    const { view, map, zoom } = aerialLive();
    await waitFor(() => expect(zoom().dataset.aerialLoad).toBe('failed'));
    expect(map.sources.has('imagery')).toBe(false);
    tiles.load.mockResolvedValue({} as ImageBitmap);
    act(() => view.getByRole('button', { name: 'retry' }).click());
    await waitFor(() => expect(zoom().dataset.aerialLoad).toBe('loaded'));
    expect(zoom().dataset.aerialPending).toBeUndefined();
    expect(view.queryByRole('button', { name: 'retry' })).toBeNull();
    expect(map.sources.has('imagery')).toBe(true);
  });

  it('a retry that fails again offers Try again again — never stuck on Trying again…', async () => {
    tiles.load.mockResolvedValue(null as unknown as ImageBitmap);
    const { view, zoom } = aerialLive();
    await waitFor(() => expect(zoom().dataset.aerialLoad).toBe('failed'));
    const asked = tiles.load.mock.calls.length;
    act(() => view.getByRole('button', { name: 'retry' }).click());
    await waitFor(() => expect(tiles.load.mock.calls.length).toBeGreaterThan(asked));
    await waitFor(() => expect(zoom().dataset.aerialPending).toBeUndefined());
    expect(zoom().dataset.aerialLoad).toBe('failed');
  });
});

describe('floorZoom', () => {
  it('is a step and a half out, or the reach’s own zoom when that is further out', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 20, noNaN: true }),
        fc.option(fc.double({ min: 0, max: 20, noNaN: true })),
        (framing, reachZoom) => {
          const floor = floorZoom(framing, reachZoom);
          expect(floor).toBeLessThanOrEqual(framing - ZOOM_OUT_ROOM);
          if (reachZoom !== null) expect(floor).toBeLessThanOrEqual(reachZoom);
          expect([framing - ZOOM_OUT_ROOM, reachZoom]).toContain(floor);
        },
      ),
    );
    expect(floorZoom(12)).toBe(12 - ZOOM_OUT_ROOM);
  });
});
