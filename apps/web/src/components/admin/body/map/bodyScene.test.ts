import { describe, expect, it } from 'vitest';

import { MASCOMA_SCENE } from '../frame/bodyFixtures';
import {
  DEFAULT_LAYERS,
  drawScene,
  layerSwitches,
  layersInUse,
  mergeScenes,
  rackRows,
} from './bodyScene';
import type { BodyMapScene, MapItem } from './mapDescriptors';

const square: GeoJSON.Polygon = {
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
const base: BodyMapScene = {
  items: [
    { kind: 'outline', id: 'body:b', layer: 'outline', geometry: square, style: 'body' },
    { kind: 'outline', id: 'bay:x', layer: 'bays', geometry: square, style: 'bay' },
    { kind: 'point', id: 'putIn:p', layer: 'putIns', at: [0.5, 0.5], mark: 'putIn' },
    { kind: 'point', id: 'sample:0', layer: 'samples', at: [0.2, 0.2], mark: 'sample' },
  ],
};

describe('mergeScenes', () => {
  it('lays the tab’s items over the frame’s, the tab’s winning an id they share', () => {
    const tab: BodyMapScene = {
      items: [
        { kind: 'outline', id: 'bay:x', layer: 'bays', geometry: square, style: 'footprint' },
        { kind: 'point', id: 'hazard:h', layer: 'hazards', at: [0.1, 0.1], mark: 'hazard' },
      ],
      lit: 'hazard:h',
      layers: { hazards: true },
    };
    const merged = mergeScenes(base, tab);
    expect(merged.items.map((i) => i.id)).toEqual([
      'body:b',
      'putIn:p',
      'sample:0',
      'bay:x',
      'hazard:h',
    ]);
    expect(merged.items.find((i) => i.id === 'bay:x')).toMatchObject({ style: 'footprint' });
    expect(merged.lit).toBe('hazard:h');
    expect(merged.layers).toEqual({ hazards: true });
  });

  it('keeps the frame’s lit item when the tab names none', () => {
    expect(mergeScenes({ ...base, lit: 'bay:x' }, { items: [] }).lit).toBe('bay:x');
    expect(mergeScenes(base, null)).toBe(base);
  });
});

describe('the rack', () => {
  it('starts as 5.4.1 draws it: outline, bays, marks, put-ins on', () => {
    expect(
      Object.entries(DEFAULT_LAYERS)
        .filter(([, on]) => on)
        .map(([k]) => k),
    ).toEqual(['outline', 'bays', 'marks', 'putIns']);
  });

  it('takes the tab’s layers, then the operator’s', () => {
    expect(layerSwitches({ hazards: true }, { bays: false })).toMatchObject({
      hazards: true,
      bays: false,
      outline: true,
    });
  });

  it('disables a layer nothing belongs to, and never draws it on', () => {
    const rows = rackRows(base.items, layerSwitches({ hazards: true }));
    expect(rows.find((r) => r.layer === 'hazards')).toEqual({
      layer: 'hazards',
      on: false,
      available: false,
    });
    expect(rows.find((r) => r.layer === 'samples')).toEqual({
      layer: 'samples',
      on: false,
      available: true,
    });
    expect(rows.map((r) => r.layer)).toHaveLength(10);
    expect([...layersInUse(base.items)].sort()).toEqual(['bays', 'outline', 'putIns', 'samples']);
  });
});

describe('drawScene', () => {
  it('draws only what the rack has on', () => {
    const drawn = drawScene(base, DEFAULT_LAYERS);
    expect(drawn.points.map((p) => p.id)).toEqual(['putIn:p']);
    const off = drawScene(base, { ...DEFAULT_LAYERS, bays: false });
    expect(off.outlines.features.map((f) => f.properties.id)).toEqual(['body:b']);
  });

  it('orders outlines bays first so the shore is drawn over them', () => {
    const drawn = drawScene(base, DEFAULT_LAYERS);
    expect(drawn.outlines.features.map((f) => f.properties.style)).toEqual(['bay', 'body']);
  });

  it('lights the lit item only while it is drawn, and draws a lit point last', () => {
    const items: MapItem[] = [
      { kind: 'point', id: 'a', layer: 'marks', at: [0, 0], mark: 'island' },
      { kind: 'point', id: 'b', layer: 'marks', at: [0, 0], mark: 'beach' },
    ];
    const lit = drawScene({ items, lit: 'a' }, DEFAULT_LAYERS);
    expect(lit.lit).toBe('a');
    expect(lit.points.map((p) => p.id)).toEqual(['b', 'a']);
    expect(drawScene({ items, lit: 'a' }, { ...DEFAULT_LAYERS, marks: false }).lit).toBeNull();
    expect(drawScene({ items, lit: 'nope' }, DEFAULT_LAYERS).lit).toBeNull();
    const outline = drawScene({ ...base, lit: 'bay:x' }, DEFAULT_LAYERS);
    expect(outline.outlines.features.find((f) => f.properties.id === 'bay:x')?.properties.lit).toBe(
      true,
    );
  });

  it('keys each kind once, in the order first seen, and drops a line too short to draw', () => {
    const drawn = drawScene(
      {
        items: [
          ...MASCOMA_SCENE.items,
          { kind: 'line', id: 'l', layer: 'bays', path: [[0, 0]], style: 'divider' },
        ],
      },
      DEFAULT_LAYERS,
    );
    expect(new Set(drawn.keyKinds).size).toBe(drawn.keyKinds.length);
    expect(drawn.lines.features).toHaveLength(0);
    expect(drawn.labels.map((l) => l.text)).toEqual(['Mascoma North', 'Mascoma South']);
  });
});

describe('the contract’s later members', () => {
  const footprint = (id: string, field?: MapItem extends infer _ ? object : never) => ({
    kind: 'outline' as const,
    id,
    layer: 'hazards' as const,
    geometry: square,
    style: 'footprint' as const,
    ...(field ?? {}),
  });

  it('draws a footprint with a field as dots, never a plate, a stale one faded but there', () => {
    const scene: BodyMapScene = {
      items: [
        footprint('hazard:h', {
          field: { freshness: 'stale', tone: 'hazard', provisional: false },
        }),
        footprint('footprint:f'),
      ],
    };
    const drawn = drawScene(scene, layerSwitches({ hazards: true }));
    const styles = drawn.outlines.features.map((f) => [f.properties.id, f.properties.style]);
    expect(styles).toContainEqual(['hazard:h', 'field']);
    expect(styles).toContainEqual(['footprint:f', 'footprint']);
    expect(drawn.dots.features.length).toBeGreaterThan(0);
    for (const dot of drawn.dots.features) {
      expect(dot.properties).toMatchObject({ id: 'hazard:h', tone: 'hazard' });
      expect(dot.properties.opacity).toBeGreaterThan(0);
    }
  });

  it('hides a field with its layer, as any item', () => {
    const scene: BodyMapScene = {
      items: [
        footprint('hazard:h', {
          field: { freshness: 'fresh', tone: 'healing', provisional: true },
        }),
      ],
    };
    expect(drawScene(scene, layerSwitches({ hazards: false })).dots.features).toHaveLength(0);
  });

  it('takes dimension lines off the map’s own layers, to be drawn in pixels', () => {
    const scene: BodyMapScene = {
      items: [
        {
          kind: 'line',
          id: 'dim:ew',
          layer: 'samples',
          path: [
            [0, 0],
            [1, 0],
          ],
          style: 'dimension',
        },
        {
          kind: 'line',
          id: 'walk:a',
          layer: 'putIns',
          path: [
            [0, 0],
            [1, 1],
          ],
          style: 'approach',
        },
        {
          kind: 'label',
          id: 'dim:ew:len',
          layer: 'samples',
          at: [0.5, 0],
          text: '4.9 KM',
          style: 'measure',
        },
      ],
    };
    const drawn = drawScene(scene, layerSwitches({ samples: true }));
    expect(drawn.dimensions.map((d) => d.id)).toEqual(['dim:ew']);
    expect(drawn.lines.features.map((f) => f.properties.style)).toEqual(['approach']);
    expect(drawn.labels.map((l) => l.style)).toEqual(['measure']);
  });

  it('hands the map the first imagery pass while the Aerial layer is on, and none while it’s off', () => {
    const scene: BodyMapScene = {
      items: [
        {
          kind: 'raster',
          id: 'pass:tc.g1',
          layer: 'aerial',
          key: 'winter-2026-27/g1-visual.pmtiles',
          granuleId: 'g1',
          band: 'tc',
          capturedAt: '2026-12-01T15:00:00Z',
          season: 'winter-2026-27',
        },
      ],
      layers: { aerial: true },
    };
    expect(drawScene(scene, layerSwitches(scene.layers)).raster?.granuleId).toBe('g1');
    expect(drawScene(scene, layerSwitches({ aerial: false })).raster).toBeNull();
    // A pass puts the Aerial layer in use, so its switch is live in the rack.
    expect(
      rackRows(scene.items, layerSwitches(scene.layers)).find((r) => r.layer === 'aerial'),
    ).toMatchObject({ on: true, available: true });
  });

  it('draws a proposal as a mark the key names', () => {
    const scene: BodyMapScene = {
      items: [
        { kind: 'point', id: 'proposal:p', layer: 'marks', at: [0.5, 0.5], mark: 'proposal' },
      ],
    };
    expect(drawScene(scene, DEFAULT_LAYERS).keyKinds).toEqual(['proposal']);
  });
});
