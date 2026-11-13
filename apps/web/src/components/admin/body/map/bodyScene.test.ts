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
