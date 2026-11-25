/**
 * The point tool (B01-6b, D300), driven through a fake map as the chord tool's test does: a click
 * places, the mark drags, the cursor says which, and a snap moves the ghost and the pick alike.
 */

import type { LatLng } from '@skating/core';
import { describe, expect, it, vi } from 'vitest';
import type { ChordMap, ChordMapEvent } from './chordDraw';
import { createPointDraw, metersPerPixel } from './pointDraw';

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

const P = (lat: number, lng: number): LatLng => ({ lat, lng });
const coords = (map: FakeMap, id: string) =>
  map.features(id).map((f) => (f.geometry as GeoJSON.Point).coordinates);

describe('the map’s scale at a pick', () => {
  it('is MapLibre’s: ~0.2 m a pixel at zoom 18 on the 44th parallel, halving the zoom doubles it', () => {
    expect(metersPerPixel(44, 18)).toBeCloseTo(0.2148, 3);
    expect(metersPerPixel(44, 10) / metersPerPixel(44, 11)).toBeCloseTo(2, 9);
    expect(metersPerPixel(0, 0)).toBeCloseTo(78271.5, 0);
  });

  it('rides with each pick, when the map can say', () => {
    const map = new FakeMap() as FakeMap & { getZoom?: () => number };
    map.getZoom = () => 12;
    const onPick = vi.fn();
    createPointDraw(map, { color: '#0af', onPick });
    map.fire('click', P(44, -73));
    expect(onPick).toHaveBeenCalledWith(P(44, -73), { metersPerPixel: metersPerPixel(44, 12) });
  });
});

describe('the point tool', () => {
  it('places on a click, under a crosshair, and reports it once', () => {
    const map = new FakeMap();
    const onPick = vi.fn();
    createPointDraw(map, { color: '#0af', onPick });
    expect(map.canvas.style.cursor).toBe('crosshair');
    expect(map.features('point-tool-mark')).toEqual([]);
    map.fire('mousemove', P(44.5, -73.1));
    expect(coords(map, 'point-tool-ghost')).toEqual([[-73.1, 44.5]]);
    expect(onPick).not.toHaveBeenCalled();
    map.fire('click', P(44.5, -73.1));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(P(44.5, -73.1), {});
    expect(coords(map, 'point-tool-mark')).toEqual([[-73.1, 44.5]]);
  });

  it('a click elsewhere moves the mark there', () => {
    const map = new FakeMap();
    const onPick = vi.fn();
    createPointDraw(map, { point: P(44, -73), color: '#0af', onPick });
    expect(coords(map, 'point-tool-mark')).toEqual([[-73, 44]]);
    map.fire('click', P(44.2, -73.2));
    expect(onPick).toHaveBeenLastCalledWith(P(44.2, -73.2), {});
    expect(coords(map, 'point-tool-mark')).toEqual([[-73.2, 44.2]]);
  });

  it('drags the mark: grab over it, grabbing while it moves, no pan, picked on release', () => {
    const map = new FakeMap();
    const onPick = vi.fn();
    createPointDraw(map, { point: P(44, -73), color: '#0af', onPick });
    map.fire('mouseenter', P(44, -73), 'point-tool-mark');
    expect(map.canvas.style.cursor).toBe('grab');
    map.fire('mousedown', P(44, -73), 'point-tool-mark');
    expect(map.canvas.style.cursor).toBe('grabbing');
    expect(map.dragPan.disable).toHaveBeenCalled();
    map.fire('mousemove', P(44.1, -73.1));
    map.fire('mousemove', P(44.3, -73.3));
    expect(coords(map, 'point-tool-mark')).toEqual([[-73.3, 44.3]]);
    expect(onPick).not.toHaveBeenCalled();
    map.fire('mouseup', P(44.3, -73.3));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(P(44.3, -73.3), {});
    expect(map.dragPan.enable).toHaveBeenCalled();
    // The pointer is still over the mark: grab, not the crosshair.
    expect(map.canvas.style.cursor).toBe('grab');
    // The click a release makes over the mark is the drag's, not a second place.
    map.fire('click', P(44.3, -73.3));
    expect(onPick).toHaveBeenCalledTimes(1);
    map.fire('mouseleave', P(44.3, -73.3), 'point-tool-mark');
    expect(map.canvas.style.cursor).toBe('crosshair');
  });

  it('a press on the mark released where it began reports nothing: it is a click, not a move', () => {
    const map = new FakeMap();
    const onPick = vi.fn();
    createPointDraw(map, { point: P(44, -73), color: '#0af', onPick });
    map.fire('mouseenter', P(44, -73), 'point-tool-mark');
    map.fire('mousedown', P(44, -73), 'point-tool-mark');
    map.fire('mouseup', P(44, -73));
    map.fire('click', P(44, -73));
    expect(onPick).not.toHaveBeenCalled();
    expect(map.dragPan.enable).toHaveBeenCalled();
    expect(coords(map, 'point-tool-mark')).toEqual([[-73, 44]]);
    // A drag that comes back to where it began moved nothing either.
    map.fire('mousedown', P(44, -73), 'point-tool-mark');
    map.fire('mousemove', P(44.1, -73.1));
    map.fire('mousemove', P(44, -73));
    map.fire('mouseup', P(44, -73));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('snaps the ghost and the pick to where the mark would land', () => {
    const map = new FakeMap();
    const onPick = vi.fn();
    createPointDraw(map, { color: '#0af', snap: (p) => ({ lat: 0, lng: p.lng }), onPick });
    map.fire('mousemove', P(44.5, -73.1));
    expect(coords(map, 'point-tool-ghost')).toEqual([[-73.1, 0]]);
    map.fire('click', P(44.5, -73.1));
    expect(onPick).toHaveBeenCalledWith(P(0, -73.1), {});
  });

  it('set moves the mark without reporting; destroy detaches everything and the cursor', () => {
    const map = new FakeMap();
    const onPick = vi.fn();
    const control = createPointDraw(map, { color: '#0af', onPick });
    control.set(P(1, 2));
    expect(coords(map, 'point-tool-mark')).toEqual([[2, 1]]);
    control.set(null);
    expect(map.features('point-tool-mark')).toEqual([]);
    expect(onPick).not.toHaveBeenCalled();
    control.destroy();
    expect(map.canvas.style.cursor).toBe('');
    expect(map.layers).toEqual([]);
    expect(map.sources.size).toBe(0);
    expect([...map.handlers.values()].every((s) => s.size === 0)).toBe(true);
  });
});
