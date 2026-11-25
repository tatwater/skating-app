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
    drawing: boolean;
    destroyed: boolean;
    fire: (p: unknown) => void;
  }[],
  ringFails: false,
  ringGate: null as null | Promise<void>,
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
  createPolygonDraw: async (_map: unknown, options: { onChange: (p: unknown) => void }) => {
    if (engines.ringGate) await engines.ringGate;
    if (engines.ringFails) throw new Error('chunk failed');
    const e = {
      editing: false,
      drawing: false,
      destroyed: false,
      polygon: undefined as unknown,
      fire: (p: unknown) => options.onChange(p),
    };
    engines.ring.push(e);
    return {
      startDrawing: () => {
        e.drawing = true;
      },
      startEditing: () => {
        e.editing = true;
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
  const moves: unknown[] = [];
  return {
    sources,
    layers,
    moves,
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
    addLayer: (spec: { id: string }) => void layers.push(spec.id),
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
function MapHalf({ map }: { map: ReturnType<typeof fakeMap> | null }) {
  const claim = useMapToolClaim();
  // A new map is a new getter, as `useMapCanvas` hands out.
  const getter = useState(() => new Map<unknown, () => unknown>())[0];
  if (!getter.has(map)) getter.set(map, () => map);
  useMapToolEngine(getter.get(map) as never, claim, PALETTE);
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
