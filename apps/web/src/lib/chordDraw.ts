/**
 * The chord tool — two clicks on the shore, a click on a side, a drag on the mouth line (D201).
 *
 * The drawing engine for a sub-area by chord, attached to the lake editor's map. Where
 * `polygonDraw.ts` wraps terra-draw for a freeform ring, this needs no engine at all: the shape is
 * never drawn, it is *derived* (`chordSubArea` in core), and the moderator's whole input is three
 * points and a number. So the tool is a small state machine over map events and five GeoJSON
 * sources it owns:
 *
 *  - `chord-cursor`      — the snapped shore point under the pointer, while a point is being placed
 *  - `chord-candidates`  — the two regions a chord bounds, shaded, while a side is being chosen
 *  - `chord-line`        — the mouth line: the chord, or the arc of the current sagitta
 *  - `chord-points`      — `a` and `b`, draggable once placed
 *  - `chord-handle`      — the arc's apex, draggable to set the sagitta
 *
 * Everything the tool computes, it computes in core with the same functions the server runs, so
 * the preview the moderator sees is the polygon the write will store. The tool itself never
 * writes; the card beside the map does, with the mouth this reports.
 *
 * Typed against the slice of `maplibregl.Map` it touches, so a test can drive it with a fake and
 * the module never imports `maplibre-gl` (the editor already has the map; this only borrows it).
 */

import {
  arcApex,
  type ChordRejection,
  chordArc,
  chordCandidates,
  type LatLng,
  pointInPolygon,
  type SubAreaMouth,
  sagittaFromHandle,
  snapToOutline,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';

/** The slice of `maplibregl.Map` the tool drives. */
export interface ChordMap {
  on(type: string, handler: (e: ChordMapEvent) => void): unknown;
  on(type: string, layer: string, handler: (e: ChordMapEvent) => void): unknown;
  off(type: string, handler: (e: ChordMapEvent) => void): unknown;
  off(type: string, layer: string, handler: (e: ChordMapEvent) => void): unknown;
  addSource(id: string, spec: { type: 'geojson'; data: GeoJSON.FeatureCollection }): unknown;
  addLayer(spec: Record<string, unknown>): unknown;
  getSource(id: string): { setData: (data: GeoJSON.FeatureCollection) => void } | undefined;
  getLayer(id: string): unknown;
  removeLayer(id: string): unknown;
  removeSource(id: string): unknown;
  getCanvas(): { style: { cursor: string } };
  dragPan: { enable(): void; disable(): void };
}

export interface ChordMapEvent {
  lngLat: { lng: number; lat: number };
  preventDefault?: () => void;
}

/** Where the moderator is in the gesture. */
export type ChordStep = 'a' | 'b' | 'side' | 'done';

export interface ChordState {
  step: ChordStep;
  a?: LatLng;
  b?: LatLng;
  side?: LatLng;
  sagittaM: number;
  /** Why the last click was refused — the two points on different rings, say. */
  refusal?: ChordRejection;
}

export interface ChordDrawControl {
  /** Arm from nothing: the next click on the shore is `a`. */
  start(): void;
  /** Re-open a stored mouth, ready to adjust. */
  load(mouth: SubAreaMouth): void;
  state(): ChordState;
  /** Drop everything drawn and disarm. */
  clear(): void;
  /** `clear`, then take the layers and handlers off the map. */
  destroy(): void;
}

export interface ChordDrawOptions {
  /** The parent's polygon — what the points snap to and the candidates are cut from. */
  parent: Polygon | MultiPolygon;
  /** Every change of state, with the mouth when the gesture is complete. */
  onChange: (state: ChordState, mouth: SubAreaMouth | null) => void;
}

const SOURCES = ['chord-candidates', 'chord-line', 'chord-points', 'chord-handle', 'chord-cursor'];
const LAYERS = [
  'chord-candidates-fill',
  'chord-candidates-line',
  'chord-line',
  'chord-points',
  'chord-handle',
  'chord-cursor',
];
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** One sentence for the card, per step — the tool's only copy. */
export function chordInstruction(state: ChordState): string {
  switch (state.step) {
    case 'a':
      return 'Click the shore on one side of the mouth.';
    case 'b':
      return 'Click the shore on the other side of the mouth — the same shore, or the same island.';
    case 'side':
      return 'Click the shaded region that is the bay.';
    case 'done':
      return 'Drag the handle to bow the mouth line — out to take in open water, in to leave it. Drag a point to move it.';
  }
}

function point(p: LatLng, properties: Record<string, unknown> = {}): GeoJSON.Feature {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties };
}

export function createChordDraw(map: ChordMap, options: ChordDrawOptions): ChordDrawControl {
  const { parent } = options;
  let state: ChordState = { step: 'a', sagittaM: 0 };
  let armed = false;
  /** The candidate regions for the current `a`/`b`, un-clipped — what a side click is tested against. */
  let candidates: [Polygon, Polygon] | null = null;
  let dragging: 'a' | 'b' | 'handle' | null = null;

  for (const id of SOURCES) map.addSource(id, { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'chord-candidates-fill',
    type: 'fill',
    source: 'chord-candidates',
    paint: {
      'fill-color': ['case', ['boolean', ['get', 'smaller'], false], '#14b8a6', '#64748b'],
      'fill-opacity': ['case', ['boolean', ['get', 'smaller'], false], 0.3, 0.15],
    },
  });
  map.addLayer({
    id: 'chord-candidates-line',
    type: 'line',
    source: 'chord-candidates',
    paint: { 'line-color': '#14b8a6', 'line-width': 1, 'line-dasharray': [2, 2] },
  });
  map.addLayer({
    id: 'chord-line',
    type: 'line',
    source: 'chord-line',
    paint: { 'line-color': '#f97316', 'line-width': 3 },
  });
  map.addLayer({
    id: 'chord-points',
    type: 'circle',
    source: 'chord-points',
    paint: {
      'circle-radius': 7,
      'circle-color': '#ffffff',
      'circle-stroke-color': '#f97316',
      'circle-stroke-width': 3,
    },
  });
  map.addLayer({
    id: 'chord-handle',
    type: 'circle',
    source: 'chord-handle',
    paint: {
      'circle-radius': 8,
      'circle-color': '#f97316',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'chord-cursor',
    type: 'circle',
    source: 'chord-cursor',
    paint: {
      'circle-radius': 6,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#f97316',
      'circle-stroke-width': 2,
    },
  });

  const setData = (id: string, features: GeoJSON.Feature[]) => {
    map.getSource(id)?.setData({ type: 'FeatureCollection', features });
  };

  const mouth = (): SubAreaMouth | null =>
    state.step === 'done' && state.a && state.b && state.side
      ? { a: state.a, b: state.b, side: state.side, sagittaM: state.sagittaM }
      : null;

  const render = () => {
    const { a, b, side } = state;
    setData('chord-points', [
      ...(a ? [point(a, { which: 'a' })] : []),
      ...(b ? [point(b, { which: 'b' })] : []),
    ]);
    if (a && b && state.step === 'done' && side) {
      const line = chordArc(a, b, side, state.sagittaM);
      setData('chord-line', [
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: line.map((p) => [p.lng, p.lat]) },
          properties: {},
        },
      ]);
      setData('chord-handle', [point(arcApex(a, b, side, state.sagittaM))]);
      setData('chord-candidates', []);
    } else {
      setData('chord-line', []);
      setData('chord-handle', []);
    }
    options.onChange(state, mouth());
  };

  /** Cut the candidates for `a`/`b` and shade them, or report why there are none. */
  const cut = (): boolean => {
    const { a, b } = state;
    if (!a || !b) return false;
    const result = chordCandidates(parent, a, b);
    if (!result.ok) {
      candidates = null;
      state = { ...state, refusal: result.reason };
      setData('chord-candidates', []);
      return false;
    }
    candidates = result.sides;
    state = { ...state, refusal: undefined };
    setData(
      'chord-candidates',
      result.water.flatMap((water, index) =>
        water
          ? [
              {
                type: 'Feature' as const,
                geometry: water,
                properties: { side: index, smaller: index === result.smaller },
              },
            ]
          : [],
      ),
    );
    return true;
  };

  /** Which candidate a side click lands in — the smaller one when it is in both (an island). */
  const sideFor = (p: LatLng): boolean => {
    if (!candidates) return false;
    const hits = candidates.filter((c) => pointInPolygon(p, c));
    return hits.length > 0;
  };

  const onMouseMove = (e: ChordMapEvent) => {
    if (!armed) return;
    const at = { lat: e.lngLat.lat, lng: e.lngLat.lng };
    if (dragging) {
      if (dragging === 'handle') {
        if (state.a && state.b && state.side) {
          state = { ...state, sagittaM: sagittaFromHandle(state.a, state.b, state.side, at) };
        }
      } else {
        const hit = snapToOutline(parent, at);
        if (hit) state = { ...state, [dragging]: hit.point };
      }
      render();
      return;
    }
    if (state.step === 'a' || state.step === 'b') {
      const hit = snapToOutline(parent, at);
      setData('chord-cursor', hit ? [point(hit.point)] : []);
      if (state.step === 'b' && state.a && hit) {
        setData('chord-line', [
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [state.a.lng, state.a.lat],
                [hit.point.lng, hit.point.lat],
              ],
            },
            properties: {},
          },
        ]);
      }
    }
  };

  const onClick = (e: ChordMapEvent) => {
    if (!armed || dragging) return;
    const at = { lat: e.lngLat.lat, lng: e.lngLat.lng };
    if (state.step === 'a') {
      const hit = snapToOutline(parent, at);
      if (!hit) return;
      state = { ...state, a: hit.point, step: 'b' };
      render();
      return;
    }
    if (state.step === 'b') {
      const hit = snapToOutline(parent, at);
      if (!hit) return;
      state = { ...state, b: hit.point };
      // A refused pair keeps `a` and waits for another `b`: the message says why.
      if (cut()) {
        state = { ...state, step: 'side' };
        setData('chord-cursor', []);
      } else {
        state = { ...state, b: undefined };
      }
      render();
      return;
    }
    if (state.step === 'side') {
      if (!sideFor(at)) return; // a click on neither region is not a choice
      state = { ...state, side: at, step: 'done' };
      render();
    }
  };

  const startDrag = (which: 'a' | 'b' | 'handle') => (e: ChordMapEvent) => {
    if (!armed || state.step !== 'done') return;
    e.preventDefault?.();
    dragging = which;
    map.dragPan.disable();
    map.getCanvas().style.cursor = 'grabbing';
  };
  const onPointsDown = (e: ChordMapEvent) => {
    // Nearer of the two: MapLibre reports the layer hit, not which feature, and the tool keeps
    // no feature ids — the pointer is on one of two circles and the closer one is it.
    const { a, b } = state;
    if (!a || !b) return;
    const d = (p: LatLng) => Math.hypot(p.lng - e.lngLat.lng, p.lat - e.lngLat.lat);
    startDrag(d(a) <= d(b) ? 'a' : 'b')(e);
  };
  const onHandleDown = startDrag('handle');
  const onMouseUp = () => {
    if (!dragging) return;
    const was = dragging;
    dragging = null;
    map.dragPan.enable();
    map.getCanvas().style.cursor = 'crosshair';
    if (was !== 'handle') {
      // A moved point re-cuts the candidates; the side survives when it is still in one of them,
      // and the gesture steps back to choosing when it is not.
      if (cut() && state.side && sideFor(state.side)) {
        setData('chord-candidates', []);
      } else {
        state = { ...state, side: undefined, step: 'side' };
      }
    }
    render();
  };

  map.on('mousemove', onMouseMove);
  map.on('click', onClick);
  map.on('mousedown', 'chord-points', onPointsDown);
  map.on('mousedown', 'chord-handle', onHandleDown);
  map.on('mouseup', onMouseUp);

  const reset = () => {
    state = { step: 'a', sagittaM: 0 };
    candidates = null;
    dragging = null;
    for (const id of SOURCES) setData(id, []);
  };

  return {
    start: () => {
      reset();
      armed = true;
      map.getCanvas().style.cursor = 'crosshair';
      render();
    },
    load: (stored) => {
      reset();
      armed = true;
      map.getCanvas().style.cursor = 'crosshair';
      // Re-snap: the shoreline may have moved since the mouth was stored.
      const a = snapToOutline(parent, stored.a)?.point ?? stored.a;
      const b = snapToOutline(parent, stored.b)?.point ?? stored.b;
      state = { step: 'done', a, b, side: stored.side, sagittaM: stored.sagittaM };
      cut();
      setData('chord-candidates', []);
      render();
    },
    state: () => state,
    clear: () => {
      reset();
      armed = false;
      map.getCanvas().style.cursor = '';
      options.onChange(state, null);
    },
    destroy: () => {
      reset();
      armed = false;
      map.getCanvas().style.cursor = '';
      map.off('mousemove', onMouseMove);
      map.off('click', onClick);
      map.off('mousedown', 'chord-points', onPointsDown);
      map.off('mousedown', 'chord-handle', onHandleDown);
      map.off('mouseup', onMouseUp);
      for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of SOURCES) map.removeSource(id);
    },
  };
}
