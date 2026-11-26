import { act, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type MapToolClaim,
  MapToolProvider,
  useClaimMapTool,
  useHasMapTool,
  useMapToolClaim,
} from '../frame/mapTool';
import { bodyMapPalette } from './bodyMapPalette';
import { DRAFT_SOURCE, useMapToolEngine } from './useMapToolEngine';

/**
 * The map's tools (B01-6a): the frame's claim slot (`frame/mapTool`) and the map's half that
 * attaches the claimed engine (`useMapToolEngine`), against a fake map and fake engines — the
 * engines themselves are the old editor's, tested where they live.
 */

const engines = vi.hoisted(() => ({
  chord: [] as {
    load?: unknown;
    started: boolean;
    destroyed: boolean;
    fire: (...a: unknown[]) => void;
  }[],
  ring: [] as {
    polygon?: unknown;
    editing: boolean;
    editCalls: number;
    drawing: boolean;
    destroyed: boolean;
    singleShape?: boolean | undefined;
    fire: (p: unknown) => void;
    finish: (p: unknown) => void;
  }[],
  ringFails: false,
  ringGate: null as null | Promise<void>,
  point: [] as {
    options: {
      point?: unknown;
      snap?: (p: unknown) => unknown;
      color: string;
      onPick: (p: unknown) => void;
    };
    colors: string[];
    destroyed: boolean;
  }[],
  line: [] as {
    line?: unknown;
    editing: boolean;
    drawing: boolean;
    destroyed: boolean;
    finish: (l: unknown) => void;
  }[],
}));

vi.mock('@/lib/pointDraw', () => ({
  createPointDraw: (_map: unknown, options: (typeof engines.point)[number]['options']) => {
    const e = { options, colors: [] as string[], destroyed: false };
    engines.point.push(e);
    return {
      set: () => {},
      setColor: (c: string) => void e.colors.push(c),
      destroy: () => {
        e.destroyed = true;
      },
    };
  },
}));

vi.mock('@/lib/chordDraw', () => ({
  createChordDraw: (_map: unknown, options: { onChange: (...a: unknown[]) => void }) => {
    const e = {
      started: false,
      destroyed: false,
      load: undefined as unknown,
      fire: (...a: unknown[]) => options.onChange(...a),
    };
    engines.chord.push(e);
    return {
      start: () => {
        e.started = true;
      },
      load: (m: unknown) => {
        e.load = m;
      },
      destroy: () => {
        e.destroyed = true;
      },
    };
  },
}));
vi.mock('@/lib/polygonDraw', () => ({
  createLineDraw: async (
    _map: unknown,
    options: { onChange: (l: unknown) => void; onFinish?: (l: unknown) => void },
  ) => {
    const e = {
      editing: false,
      drawing: false,
      destroyed: false,
      line: undefined as unknown,
      finish: (l: unknown) => {
        options.onFinish?.(l);
        options.onChange(l);
      },
    };
    engines.line.push(e);
    return {
      startDrawing: () => {
        e.drawing = true;
      },
      startEditing: () => {
        e.editing = true;
      },
      setLine: (l: unknown) => {
        e.line = l;
      },
      clear: () => {},
      destroy: () => {
        e.destroyed = true;
      },
    };
  },
  createPolygonDraw: async (
    _map: unknown,
    options: {
      onChange: (p: unknown) => void;
      onFinish?: (p: unknown) => void;
      singleShape?: boolean;
    },
  ) => {
    if (engines.ringGate) await engines.ringGate;
    if (engines.ringFails) throw new Error('chunk failed');
    const e = {
      editing: false,
      drawing: false,
      destroyed: false,
      polygon: undefined as unknown,
      editCalls: 0,
      singleShape: options.singleShape,
      fire: (p: unknown) => options.onChange(p),
      // As the engine does on a ring's close and after each vertex drag: finish, then the change.
      finish: (p: unknown) => {
        options.onFinish?.(p);
        options.onChange(p);
      },
    };
    engines.ring.push(e);
    return {
      startDrawing: () => {
        e.drawing = true;
      },
      startEditing: () => {
        e.editing = true;
        e.editCalls += 1;
      },
      setPolygon: (p: unknown) => {
        e.polygon = p;
      },
      clear: () => {},
      destroy: () => {
        e.destroyed = true;
      },
    };
  },
}));

function fakeMap() {
  const sources = new Map<string, { data: unknown }>();
  const layers: string[] = [];
  const paints = new Map<string, Record<string, unknown>>();
  const moves: unknown[] = [];
  const canvas = { style: { cursor: '' } };
  return {
    sources,
    layers,
    paints,
    moves,
    canvas,
    getCanvas: () => canvas,
    getSource: (id: string) => {
      const s = sources.get(id);
      return s
        ? {
            setData: (d: unknown) => {
              s.data = d;
            },
          }
        : undefined;
    },
    addSource: (id: string, spec: { data: unknown }) => void sources.set(id, { data: spec.data }),
    addLayer: (spec: { id: string; paint?: Record<string, unknown> }) => {
      layers.push(spec.id);
      paints.set(spec.id, { ...spec.paint });
    },
    getLayer: (id: string) => (layers.includes(id) ? { id } : undefined),
    setPaintProperty: (id: string, prop: string, value: unknown) => {
      const paint = paints.get(id);
      if (paint) paint[prop] = value;
    },
    getZoom: () => 11,
    flyTo: (o: unknown) => void moves.push({ fly: o }),
    fitBounds: (b: unknown) => void moves.push({ fit: b }),
  };
}

const PALETTE = bodyMapPalette('dark');
const draftFeatures = (map: ReturnType<typeof fakeMap>) =>
  (map.sources.get(DRAFT_SOURCE)?.data as GeoJSON.FeatureCollection | undefined)?.features ?? [];
const PARENT: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ],
  ],
};
const RING: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [0.5, 0],
      [0.5, 0.5],
      [0, 0],
    ],
  ],
};

/** The map half, over a fake map the test can swap (a theme switch re-creates the map). */
function MapHalf({
  map,
  palette = PALETTE,
}: {
  map: ReturnType<typeof fakeMap> | null;
  palette?: ReturnType<typeof bodyMapPalette>;
}) {
  const claim = useMapToolClaim();
  // A new map is a new getter, as `useMapCanvas` hands out.
  const getter = useState(() => new Map<unknown, () => unknown>())[0];
  if (!getter.has(map)) getter.set(map, () => map);
  useMapToolEngine(getter.get(map) as never, claim, palette);
  return (
    <div data-testid="bar">{claim === null ? 'none' : `${claim.mode}: ${claim.line ?? ''}`}</div>
  );
}

function Tab({ claim }: { claim: MapToolClaim | null }) {
  useClaimMapTool(claim);
  return null;
}

const base = (over: Partial<MapToolClaim> = {}): MapToolClaim => ({
  session: 's1',
  engine: { kind: 'chord', parent: PARENT, onChange: () => {} },
  mode: 'Bay mode',
  line: 'Click the shore',
  onExit: () => {},
  ...over,
});

beforeEach(() => {
  engines.chord.length = 0;
  engines.ring.length = 0;
  engines.ringFails = false;
  engines.ringGate = null;
  engines.point.length = 0;
  engines.line.length = 0;
});

describe('the map tool claim', () => {
  it('reaches the map while a tab holds it, and goes with the tab', () => {
    const map = fakeMap();
    const { getByTestId, rerender } = render(
      <MapToolProvider>
        <Tab claim={base()} />
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    expect(getByTestId('bar').textContent).toBe('Bay mode: Click the shore');
    rerender(
      <MapToolProvider>
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    expect(getByTestId('bar').textContent).toBe('none');
    expect(engines.chord[0]?.destroyed).toBe(true);
  });

  it('leaves on Esc — unless something else took the key', () => {
    const onExit = vi.fn();
    render(
      <MapToolProvider>
        <Tab claim={base({ onExit })} />
      </MapToolProvider>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
    // A dialog's own Escape got there first.
    const dialog = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener('keydown', dialog, { capture: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    window.removeEventListener('keydown', dialog, { capture: true });
    expect(onExit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'x' });
    expect(onExit).toHaveBeenCalledTimes(1);
    // Esc in a field is the field's: the drawing and what was typed with it stay.
    const field = document.createElement('input');
    document.body.append(field);
    fireEvent.keyDown(field, { key: 'Escape' });
    field.remove();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('is nothing outside a console: a story’s tab claims no map', () => {
    let had = true;
    function Probe() {
      had = useHasMapTool();
      useClaimMapTool(base());
      return null;
    }
    render(<Probe />);
    expect(had).toBe(false);
  });
});

describe('the engine on the map', () => {
  it('attaches once per session — never for a new callback or new words — and hands back what it draws', () => {
    const map = fakeMap();
    const heard: unknown[] = [];
    const claim = (line: string, session = 's1') =>
      base({
        session,
        line,
        engine: { kind: 'chord', parent: PARENT, onChange: (...a) => heard.push(a) },
      });
    const { rerender } = render(
      <MapToolProvider>
        <Tab claim={claim('one')} />
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    expect(engines.chord).toHaveLength(1);
    expect(engines.chord[0]?.started).toBe(true);
    rerender(
      <MapToolProvider>
        <Tab claim={claim('two')} />
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    expect(engines.chord).toHaveLength(1);
    // The newest claim's callback hears the engine.
    act(() => engines.chord[0]?.fire('state', 'mouth', 'preview'));
    expect(heard).toEqual([['state', 'mouth', 'preview']]);
    rerender(
      <MapToolProvider>
        <Tab claim={claim('three', 's2')} />
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    expect(engines.chord).toHaveLength(2);
    expect(engines.chord[0]?.destroyed).toBe(true);
  });

  it('re-opens a stored mouth rather than starting from nothing', () => {
    const mouth = {
      a: { lat: 0, lng: 0 },
      b: { lat: 1, lng: 1 },
      side: { lat: 0.5, lng: 0.2 },
      sagittaM: 0,
    };
    render(
      <MapToolProvider>
        <Tab
          claim={base({ engine: { kind: 'chord', parent: PARENT, mouth, onChange: () => {} } })}
        />
        <MapHalf map={fakeMap()} />
      </MapToolProvider>,
    );
    expect(engines.chord[0]).toMatchObject({ load: mouth, started: false });
  });

  it('attaches again to a re-created map, and lets go of the old one', () => {
    const first = fakeMap();
    const second = fakeMap();
    const { rerender } = render(
      <MapToolProvider>
        <Tab claim={base()} />
        <MapHalf map={first} />
      </MapToolProvider>,
    );
    rerender(
      <MapToolProvider>
        <Tab claim={base()} />
        <MapHalf map={second} />
      </MapToolProvider>,
    );
    expect(engines.chord).toHaveLength(2);
    expect(engines.chord[0]?.destroyed).toBe(true);
    expect(second.sources.has(DRAFT_SOURCE)).toBe(true);
  });

  it('draws the draft under the engine, and empties it when the shape goes', () => {
    const map = fakeMap();
    const { rerender } = render(
      <MapToolProvider>
        <Tab claim={base({ draft: RING })} />
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    expect(map.layers.slice(0, 2)).toEqual([
      'body-console-tool-draft-fill',
      'body-console-tool-draft-line',
    ]);
    expect(draftFeatures(map)).toHaveLength(1);
    rerender(
      <MapToolProvider>
        <Tab claim={base({ draft: null })} />
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    expect(draftFeatures(map)).toHaveLength(0);
  });

  it('repaints the draft and a point’s mark in place when the inks change under a held tool', () => {
    // The summer aerial switched on in the light theme: the map's inks go dark without the map
    // being re-created, so nothing may stay in the old ink — dark lines on the dark ground.
    const light = bodyMapPalette('light');
    const map = fakeMap();
    const claim = base({
      session: 'p1',
      draft: RING,
      engine: { kind: 'point', point: { lat: 0.2, lng: 0.2 }, onPick: () => {} },
    });
    const { rerender } = render(
      <MapToolProvider>
        <Tab claim={claim} />
        <MapHalf map={map} palette={light} />
      </MapToolProvider>,
    );
    const line = () => map.paints.get('body-console-tool-draft-line')?.['line-color'];
    const fill = () => map.paints.get('body-console-tool-draft-fill')?.['fill-color'];
    const ring = () => map.paints.get('body-console-tool-draft-points')?.['circle-stroke-color'];
    expect([line(), fill(), ring()]).toEqual([light.lit.line, light.lit.fill, light.lit.line]);
    expect(engines.point[0]?.options.color).toBe(light.lit.line);
    rerender(
      <MapToolProvider>
        <Tab claim={claim} />
        <MapHalf map={map} palette={PALETTE} />
      </MapToolProvider>,
    );
    expect([line(), fill(), ring()]).toEqual([
      PALETTE.lit.line,
      PALETTE.lit.fill,
      PALETTE.lit.line,
    ]);
    // The same engine, repainted rather than re-attached.
    expect(engines.point).toHaveLength(1);
    expect(engines.point[0]?.colors).toEqual([PALETTE.lit.line]);
    // A map re-created with new inks (a theme switch) gets a fresh engine in them; the old one is
    // never written to.
    const next = fakeMap();
    rerender(
      <MapToolProvider>
        <Tab claim={claim} />
        <MapHalf map={next} palette={light} />
      </MapToolProvider>,
    );
    expect(engines.point).toHaveLength(2);
    expect(engines.point[0]?.colors).toEqual([PALETTE.lit.line]);
    expect(engines.point[1]?.options.color).toBe(light.lit.line);
    expect(next.paints.get('body-console-tool-draft-line')?.['line-color']).toBe(light.lit.line);
  });

  it('takes the camera to the session’s focus once, as it starts', () => {
    const map = fakeMap();
    const { rerender } = render(
      <MapToolProvider>
        <Tab claim={base({ focus: { point: { lat: 1, lng: 2 } } })} />
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    expect(map.moves).toEqual([{ fly: { center: [2, 1], zoom: 13 } }]);
    rerender(
      <MapToolProvider>
        <Tab claim={base({ line: 'moved on', focus: { point: { lat: 1, lng: 2 } } })} />
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    expect(map.moves).toHaveLength(1);
    rerender(
      <MapToolProvider>
        <Tab
          claim={base({
            session: 's2',
            focus: { bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 } },
          })}
        />
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    expect(map.moves[1]).toEqual({
      fit: [
        [0, 0],
        [1, 1],
      ],
    });
  });

  it('keeps the operator’s view on a map re-created mid-session, and frames a session the map was down for', () => {
    const first = fakeMap();
    const second = fakeMap();
    const claim = base({ focus: { point: { lat: 1, lng: 2 } } });
    const { rerender } = render(
      <MapToolProvider>
        <Tab claim={claim} />
        <MapHalf map={null} />
      </MapToolProvider>,
    );
    rerender(
      <MapToolProvider>
        <Tab claim={claim} />
        <MapHalf map={first} />
      </MapToolProvider>,
    );
    expect(first.moves).toEqual([{ fly: { center: [2, 1], zoom: 13 } }]);
    rerender(
      <MapToolProvider>
        <Tab claim={claim} />
        <MapHalf map={second} />
      </MapToolProvider>,
    );
    expect(second.moves).toEqual([]);
  });

  it('hands a ring to edit to the vertex editor, or starts a new one', async () => {
    const ring = (polygon?: GeoJSON.Polygon, session = 'r1') =>
      base({
        session,
        engine: {
          kind: 'ring',
          ...(polygon ? { polygon } : {}),
          onChange: () => {},
          onUnavailable: () => {},
        },
      });
    const map = fakeMap();
    const { rerender } = render(
      <MapToolProvider>
        <Tab claim={ring(RING)} />
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    await act(async () => {});
    expect(engines.ring[0]).toMatchObject({ polygon: RING, editing: true, drawing: false });
    rerender(
      <MapToolProvider>
        <Tab claim={ring(undefined, 'r2')} />
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    await act(async () => {});
    expect(engines.ring[0]?.destroyed).toBe(true);
    expect(engines.ring[1]).toMatchObject({ drawing: true, editing: false });
  });

  it('hands a traced ring to the vertex editor as it closes, and keeps it there through every drag', async () => {
    const heard: unknown[] = [];
    render(
      <MapToolProvider>
        <Tab
          claim={base({
            session: 'r1',
            engine: { kind: 'ring', onChange: (p) => heard.push(p), onUnavailable: () => {} },
          })}
        />
        <MapHalf map={fakeMap()} />
      </MapToolProvider>,
    );
    await act(async () => {});
    const e = engines.ring[0];
    // Never the single-shape default, which goes static on every finish.
    expect(e).toMatchObject({ drawing: true, editing: false, singleShape: false });
    act(() => e?.finish(RING));
    expect(e).toMatchObject({ editing: true, editCalls: 1 });
    // A vertex drag finishes too: the editor stays as it is, and the new ring is heard.
    act(() => e?.finish(RING));
    expect(e?.editCalls).toBe(1);
    expect(heard).toEqual([RING, RING]);
  });

  it('never attaches a ring engine that loads after its session ended', async () => {
    let open = () => {};
    engines.ringGate = new Promise<void>((r) => {
      open = r;
    });
    const claim = base({
      session: 'r1',
      engine: { kind: 'ring', onChange: () => {}, onUnavailable: () => {} },
    });
    const map = fakeMap();
    const { rerender } = render(
      <MapToolProvider>
        <Tab claim={claim} />
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    rerender(
      <MapToolProvider>
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    await act(async () => open());
    expect(engines.ring[0]).toMatchObject({ destroyed: true, drawing: false });
  });

  it('says so when the draw engine can’t load', async () => {
    engines.ringFails = true;
    const onUnavailable = vi.fn();
    render(
      <MapToolProvider>
        <Tab
          claim={base({
            session: 'r1',
            engine: { kind: 'ring', onChange: () => {}, onUnavailable },
          })}
        />
        <MapHalf map={fakeMap()} />
      </MapToolProvider>,
    );
    await act(async () => {});
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('a point: placed or moved through the claim, snapped to the outline it names', () => {
    const picks: unknown[] = [];
    const { rerender } = render(
      <MapToolProvider>
        <Tab
          claim={base({
            session: 'p1',
            engine: {
              kind: 'point',
              point: { lat: 0.2, lng: 0.2 },
              snapTo: PARENT,
              onPick: (p) => picks.push(p),
            },
          })}
        />
        <MapHalf map={fakeMap()} />
      </MapToolProvider>,
    );
    const e = engines.point[0];
    expect(e?.options.point).toEqual({ lat: 0.2, lng: 0.2 });
    // The shore snap is core's edge snap against the claimed outline: a point inside lands on it.
    const snapped = e?.options.snap?.({ lat: 0.5, lng: 0.9 }) as { lat: number; lng: number };
    expect(snapped.lng).toBeCloseTo(1, 6);
    act(() => e?.options.onPick({ lat: 0.3, lng: 0.4 }));
    expect(picks).toEqual([{ lat: 0.3, lng: 0.4 }]);
    rerender(
      <MapToolProvider>
        <Tab claim={null} />
        <MapHalf map={fakeMap()} />
      </MapToolProvider>,
    );
    expect(e?.destroyed).toBe(true);
    // A reach: a pointer past it stays where it is, so the server's refusal answers.
    render(
      <MapToolProvider>
        <Tab
          claim={base({
            session: 'p3',
            engine: { kind: 'point', snapTo: PARENT, snapWithinM: 500, onPick: () => {} },
          })}
        />
        <MapHalf map={fakeMap()} />
      </MapToolProvider>,
    );
    const reach = engines.point.at(-1)?.options.snap ?? ((p: unknown) => p);
    expect(reach({ lat: 0.5, lng: 1.5 })).toEqual({ lat: 0.5, lng: 1.5 }); // ~55 km out
    expect((reach({ lat: 0.5, lng: 1.001 }) as { lng: number }).lng).toBeCloseTo(1, 6);
    // No outline named: no snap, the click is the spot.
    render(
      <MapToolProvider>
        <Tab claim={base({ session: 'p2', engine: { kind: 'point', onPick: () => {} } })} />
        <MapHalf map={fakeMap()} />
      </MapToolProvider>,
    );
    expect(engines.point.at(-1)?.options.snap).toBeUndefined();
    expect(engines.point.at(-1)?.options.point).toBeUndefined();
  });

  it('a line: traced under a crosshair, then edited; a stored line opens to edit', async () => {
    const heard: unknown[] = [];
    const LINE: GeoJSON.LineString = {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    };
    const map = fakeMap();
    const { rerender } = render(
      <MapToolProvider>
        <Tab
          claim={base({
            session: 'l1',
            engine: { kind: 'line', onChange: (l) => heard.push(l), onUnavailable: () => {} },
          })}
        />
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    await act(async () => {});
    const e = engines.line[0];
    expect(e).toMatchObject({ drawing: true, editing: false });
    expect(map.canvas.style.cursor).toBe('crosshair');
    act(() => e?.finish(LINE));
    expect(e?.editing).toBe(true);
    expect(heard).toEqual([LINE]);
    rerender(
      <MapToolProvider>
        <Tab
          claim={base({
            session: 'l2',
            engine: { kind: 'line', line: LINE, onChange: () => {}, onUnavailable: () => {} },
          })}
        />
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    await act(async () => {});
    expect(e?.destroyed).toBe(true);
    expect(engines.line[1]).toMatchObject({ line: LINE, editing: true, drawing: false });
  });

  it('a ring traces under a crosshair, and gives the cursor back when it goes', async () => {
    const map = fakeMap();
    const ring = base({
      session: 'r1',
      engine: { kind: 'ring', onChange: () => {}, onUnavailable: () => {} },
    });
    const { rerender } = render(
      <MapToolProvider>
        <Tab claim={ring} />
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    await act(async () => {});
    expect(map.canvas.style.cursor).toBe('crosshair');
    rerender(
      <MapToolProvider>
        <Tab claim={null} />
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    expect(map.canvas.style.cursor).toBe('');
  });

  it('draws points in the draft as hollow rings, beside the area and line layers', () => {
    const map = fakeMap();
    const grid: GeoJSON.MultiPoint = {
      type: 'MultiPoint',
      coordinates: [
        [0.1, 0.1],
        [0.2, 0.2],
      ],
    };
    render(
      <MapToolProvider>
        <Tab claim={base({ engine: { kind: 'none' }, draft: grid })} />
        <MapHalf map={map} />
      </MapToolProvider>,
    );
    expect(map.layers).toContain('body-console-tool-draft-points');
    expect(draftFeatures(map)[0]?.geometry).toEqual(grid);
  });

  it('attaches nothing for a paste, and nothing to a map that is down', () => {
    render(
      <MapToolProvider>
        <Tab claim={base({ engine: { kind: 'none' }, draft: RING })} />
        <MapHalf map={fakeMap()} />
      </MapToolProvider>,
    );
    render(
      <MapToolProvider>
        <Tab claim={base()} />
        <MapHalf map={null} />
      </MapToolProvider>,
    );
    expect(engines.chord).toHaveLength(0);
    expect(engines.ring).toHaveLength(0);
  });
});
