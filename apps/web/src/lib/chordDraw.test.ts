/**
 * The chord tool's gesture, driven through a fake map (D201).
 *
 * jsdom has no WebGL, so the map is a recorder: which handlers the tool attaches, what it writes
 * to which source, and how the state moves as clicks and drags arrive. The geometry underneath is
 * core's and tested there; what this pins is the *gesture* — a, b, side, handle — and that every
 * step leaves the map showing what the moderator needs next.
 */

import type { ChordResult, LatLng, SubAreaMouth } from '@skating/core';
import type { Polygon, Position } from 'geojson';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChordMap,
  type ChordMapEvent,
  type ChordState,
  chordInstruction,
  createChordDraw,
} from './chordDraw';

class FakeMap implements ChordMap {
  handlers = new Map<string, Set<(e: ChordMapEvent) => void>>();
  sources = new Map<string, GeoJSON.FeatureCollection>();
  layers: string[] = [];
  canvas = { style: { cursor: '' } };
  dragPan = { enable: vi.fn(), disable: vi.fn() };

  private key(type: string, layer?: string) {
    return layer ? `${type}@${layer}` : type;
  }
  on(type: string, a: unknown, b?: unknown) {
    const layer = typeof a === 'string' ? a : undefined;
    const handler = (typeof a === 'string' ? b : a) as (e: ChordMapEvent) => void;
    const k = this.key(type, layer);
    if (!this.handlers.has(k)) this.handlers.set(k, new Set());
    this.handlers.get(k)?.add(handler);
  }
  off(type: string, a: unknown, b?: unknown) {
    const layer = typeof a === 'string' ? a : undefined;
    const handler = (typeof a === 'string' ? b : a) as (e: ChordMapEvent) => void;
    this.handlers.get(this.key(type, layer))?.delete(handler);
  }
  fire(type: string, at: LatLng, layer?: string) {
    for (const h of this.handlers.get(this.key(type, layer)) ?? []) {
      h({ lngLat: { lng: at.lng, lat: at.lat }, preventDefault: () => {} });
    }
  }
  addSource(id: string, spec: { data: GeoJSON.FeatureCollection }) {
    this.sources.set(id, spec.data);
  }
  addLayer(spec: { id: string }) {
    this.layers.push(spec.id);
  }
  getSource(id: string) {
    return this.sources.has(id)
      ? { setData: (data: GeoJSON.FeatureCollection) => this.sources.set(id, data) }
      : undefined;
  }
  getLayer(id: string) {
    return this.layers.includes(id) ? { id } : undefined;
  }
  removeLayer(id: string) {
    this.layers = this.layers.filter((l) => l !== id);
  }
  removeSource(id: string) {
    this.sources.delete(id);
  }
  getCanvas() {
    return this.canvas;
  }
  features(id: string) {
    return this.sources.get(id)?.features ?? [];
  }
}

// The same synthetic lake core tests on: a keyhole bay on the north shore, a notched island.
const ORIGIN: LatLng = { lat: 44.5, lng: -73.0 };
const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;
function at(x: number, y: number): LatLng {
  return {
    lat: ORIGIN.lat + y / (DEG * EARTH_RADIUS_M),
    lng: ORIGIN.lng + x / (DEG * EARTH_RADIUS_M * Math.cos(ORIGIN.lat * DEG)),
  };
}
function pos(x: number, y: number): Position {
  const p = at(x, y);
  return [p.lng, p.lat];
}
const LAKE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      pos(0, 0),
      pos(4000, 0),
      pos(4000, 3000),
      pos(2200, 3000),
      pos(2200, 3200),
      pos(2600, 3200),
      pos(2600, 3800),
      pos(1400, 3800),
      pos(1400, 3200),
      pos(1800, 3200),
      pos(1800, 3000),
      pos(0, 3000),
      pos(0, 0),
    ],
    [
      pos(600, 600),
      pos(1200, 600),
      pos(1200, 800),
      pos(1000, 800),
      pos(1000, 1000),
      pos(1200, 1000),
      pos(1200, 1200),
      pos(600, 1200),
      pos(600, 600),
    ],
  ],
};

let map: FakeMap;
let changes: { state: ChordState; mouth: SubAreaMouth | null; preview: ChordResult | null }[];

beforeEach(() => {
  map = new FakeMap();
  changes = [];
});

function tool() {
  return createChordDraw(map, {
    parent: LAKE,
    onChange: (state, mouth, preview) => changes.push({ state, mouth, preview }),
  });
}

const last = () =>
  changes[changes.length - 1] as {
    state: ChordState;
    mouth: SubAreaMouth | null;
    preview: ChordResult | null;
  };
const coords = (f: GeoJSON.Feature) => (f.geometry as GeoJSON.Point).coordinates;

describe('the gesture', () => {
  it('attaches its layers and handlers, and takes them off again', () => {
    const control = tool();
    expect(map.layers).toEqual([
      'chord-candidates-fill',
      'chord-candidates-line',
      'chord-line',
      'chord-points',
      'chord-handle',
      'chord-cursor',
    ]);
    expect(map.handlers.get('mousedown@chord-handle')?.size).toBe(1);
    control.destroy();
    expect(map.layers).toEqual([]);
    expect(map.sources.size).toBe(0);
    expect([...map.handlers.values()].every((set) => set.size === 0)).toBe(true);
  });

  it('does nothing until armed, then snaps the cursor to the shore', () => {
    const control = tool();
    map.fire('mousemove', at(1450, 3500));
    expect(map.features('chord-cursor')).toEqual([]);
    control.start();
    expect(map.canvas.style.cursor).toBe('crosshair');
    map.fire('mousemove', at(1450, 3500));
    // 50 m off the basin's west wall: the cursor sits on the wall, not under the pointer.
    const [lng, lat] = coords(map.features('chord-cursor')[0] as GeoJSON.Feature);
    expect(lng).toBeCloseTo(at(1400, 3500).lng, 7);
    expect(lat).toBeCloseTo(at(1400, 3500).lat, 7);
  });

  it('a, then b, shades the two sides; the side click completes the mouth', () => {
    const control = tool();
    control.start();
    expect(last().state.step).toBe('a');

    map.fire('click', at(1790, 2990)); // snaps to the mouth's west corner
    expect(last().state.step).toBe('b');
    expect(map.features('chord-points')).toHaveLength(1);

    // While placing b the line previews from a to the cursor.
    map.fire('mousemove', at(2000, 2990));
    expect(map.features('chord-line')).toHaveLength(1);

    map.fire('click', at(2210, 2990)); // the east corner
    expect(last().state.step).toBe('side');
    expect(last().mouth).toBeNull();
    // Only the smaller side — the bay — is shaded; the rest of the lake is never clipped.
    const shaded = map.features('chord-candidates');
    expect(shaded).toHaveLength(1);
    expect(shaded[0]?.properties?.smaller).toBe(true);
    expect(map.features('chord-cursor')).toEqual([]);

    // A click on open water outside both regions is not a choice.
    map.fire('click', at(-500, -500));
    expect(last().state.step).toBe('side');

    map.fire('click', at(2000, 3500));
    expect(last().state.step).toBe('done');
    expect(last().mouth).toMatchObject({ sagittaM: 0 });
    expect(last().mouth?.side).toEqual(at(2000, 3500));
    // The derivation rides along, so the card previews without deriving again.
    expect(last().preview?.ok).toBe(true);
    // The shading is gone; the mouth line and its handle are up.
    expect(map.features('chord-candidates')).toEqual([]);
    expect(map.features('chord-line')).toHaveLength(1);
    expect(map.features('chord-handle')).toHaveLength(1);
    expect(chordInstruction(last().state)).toMatch(/Drag the handle/);
  });

  it('the other side is a choice too, by a click on its water, though it is not shaded', () => {
    const control = tool();
    control.start();
    map.fire('click', at(1800, 3000));
    map.fire('click', at(2200, 3000));
    map.fire('click', at(2000, 1500)); // the main lake: "everything but the bay"
    expect(last().state.step).toBe('done');
    expect(last().preview?.ok).toBe(true);
  });

  it('a side click on island land nobody sees shaded is not a choice — only the shaded water is', () => {
    const control = tool();
    control.start();
    map.fire('click', at(1200, 800));
    map.fire('click', at(1200, 1000));
    expect(last().state.step).toBe('side');
    // The island's interior: inside the larger un-clipped candidate, but land, and unshaded.
    map.fire('click', at(800, 900));
    expect(last().state.step).toBe('side');
    map.fire('click', at(1100, 900)); // the notch water
    expect(last().state.step).toBe('done');
  });

  it('refuses a b on a different ring and waits for another', () => {
    const control = tool();
    control.start();
    map.fire('click', at(1790, 2990));
    map.fire('click', at(1190, 900)); // the island's notch
    expect(last().state).toMatchObject({ step: 'b', refusal: 'different_rings' });
    expect(last().state.b).toBeUndefined();
    map.fire('click', at(2210, 2990));
    expect(last().state).toMatchObject({ step: 'side', refusal: undefined });
  });

  it('dragging the handle sets the sagitta; dragging a point re-snaps it and keeps the side', () => {
    const control = tool();
    control.start();
    map.fire('click', at(1800, 3000));
    map.fire('click', at(2200, 3000));
    map.fire('click', at(2000, 3500));

    map.fire('mousedown', at(2000, 3000), 'chord-handle');
    expect(map.dragPan.disable).toHaveBeenCalled();
    const reported = changes.length;
    map.fire('mousemove', at(2000, 2850)); // 150 m out, away from the bay
    // The line follows live; the card hears nothing until the pointer lifts.
    expect(changes.length).toBe(reported);
    expect(control.state().sagittaM).toBeCloseTo(150, 0);
    map.fire('mouseup', at(2000, 2850));
    expect(changes.length).toBe(reported + 1);
    expect(map.dragPan.enable).toHaveBeenCalled();
    expect(last().mouth?.sagittaM).toBeCloseTo(150, 0);
    // The line is now an arc, with its apex where the handle was dropped.
    const line = map.features('chord-line')[0]?.geometry as GeoJSON.LineString;
    expect(line.coordinates.length).toBeGreaterThan(3);
    const [hx, hy] = coords(map.features('chord-handle')[0] as GeoJSON.Feature);
    expect(hx).toBeCloseTo(at(2000, 2850).lng, 6);
    expect(hy).toBeCloseTo(at(2000, 2850).lat, 6);

    // Drag `b` east along the shore: it re-snaps, the side is still in the bay, the step holds.
    map.fire('mousedown', at(2200, 3000), 'chord-points');
    map.fire('mousemove', at(2300, 2950));
    map.fire('mouseup', at(2300, 2950));
    expect(last().state.step).toBe('done');
    expect(last().mouth?.b.lat).toBeCloseTo(at(2300, 3000).lat, 7);
    expect(last().mouth?.side).toEqual(at(2000, 3500));
  });

  it('a point dragged somewhere the chord refuses goes back where it was, with the reason', () => {
    const control = tool();
    control.start();
    map.fire('click', at(1800, 3000));
    map.fire('click', at(2200, 3000));
    map.fire('click', at(2000, 3500));
    // Move `a` onto the island: the pair is refused; `a` returns and the gesture stays complete.
    map.fire('mousedown', at(1800, 3000), 'chord-points');
    map.fire('mousemove', at(1190, 900));
    map.fire('mouseup', at(1190, 900));
    expect(last().state).toMatchObject({ step: 'done', refusal: 'different_rings' });
    expect(last().mouth?.a.lat).toBeCloseTo(at(1800, 3000).lat, 7);
    expect(last().preview?.ok).toBe(true);
    // Still adjustable — the next drag works and clears the message.
    map.fire('mousedown', at(2000, 3000), 'chord-handle');
    map.fire('mousemove', at(2000, 2900));
    map.fire('mouseup', at(2000, 2900));
    expect(last().state.refusal).toBeUndefined();
    expect(last().mouth?.sagittaM).toBeCloseTo(100, 0);
  });

  it('a point dragged so the side no longer fits steps back to choosing', () => {
    const control = tool();
    control.start();
    // The island's notch: both points on the island ring, the side in the notch water.
    map.fire('click', at(1200, 800));
    map.fire('click', at(1200, 1000));
    map.fire('click', at(1100, 900));
    expect(last().state.step).toBe('done');
    // Drag `b` round to the island's west side: the chord no longer spans the notch, and the
    // old side point is in neither candidate.
    map.fire('mousedown', at(1200, 1000), 'chord-points');
    map.fire('mousemove', at(600, 900));
    map.fire('mouseup', at(600, 900));
    expect(last().state.step).toBe('side');
    expect(last().mouth).toBeNull();
    expect(map.features('chord-candidates')).toHaveLength(1);
  });

  it('loads a stored mouth ready to adjust, re-snapping its points', () => {
    const control = tool();
    control.load({ a: at(1800, 2990), b: at(2200, 3010), side: at(2000, 3500), sagittaM: 120 });
    expect(last().state.step).toBe('done');
    expect(last().mouth?.a.lat).toBeCloseTo(at(1800, 3000).lat, 7);
    expect(last().mouth?.sagittaM).toBe(120);
    expect(map.features('chord-handle')).toHaveLength(1);
    expect(map.features('chord-candidates')).toEqual([]);
  });

  it('clear drops everything and disarms; a click after it does nothing', () => {
    const control = tool();
    control.start();
    map.fire('click', at(1800, 3000));
    control.clear();
    expect(map.canvas.style.cursor).toBe('');
    expect(map.features('chord-points')).toEqual([]);
    expect(last().mouth).toBeNull();
    const before = changes.length;
    map.fire('click', at(2200, 3000));
    expect(changes.length).toBe(before);
  });

  it('has an instruction for every step', () => {
    for (const step of ['a', 'b', 'side', 'done'] as const) {
      expect(chordInstruction({ step, sagittaM: 0 }).length).toBeGreaterThan(10);
    }
  });
});
