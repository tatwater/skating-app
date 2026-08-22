import { expression } from '@maplibre/maplibre-gl-style-spec';
import type maplibregl from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { waterOutlineColor } from '../lib/waterMap';
import {
  IMAGERY_MIN_ZOOM,
  IMAGERY_REPLACED_LAYERS,
  IMAGERY_REPLACED_WHOLE_LAYERS,
  setLayersHiddenForBodies,
} from './useImageryReveal';

/** Compile an expression the way MapLibre will, so a malformed one fails here and not on screen. */
function compileColor(value: unknown) {
  return expression.createExpression(value, {
    type: 'color',
    'property-type': 'data-driven',
    expression: { interpolated: true, parameters: ['zoom', 'feature'] },
  } as never);
}

/** Evaluate a compiled colour expression against one feature. */
function colorFor(value: unknown, properties: Record<string, unknown>, favorite = false) {
  const compiled = compileColor(value);
  expect(compiled.result).toBe('success');
  if (compiled.result !== 'success') throw new Error('expression did not compile');
  return compiled.value
    .evaluate(
      { zoom: 14 },
      { type: 'Feature', properties, geometry: { type: 'Point', coordinates: [0, 0] } } as never,
      { favorite },
    )
    .toString()
    .toLowerCase();
}

/** MapLibre serialises an opaque colour back as hex, so this is the whole of "white". */
const WHITE = '#ffffff';

describe('waterOutlineColor', () => {
  it('compiles for MapLibre in both shapes', () => {
    expect(compileColor(waterOutlineColor('dark')).result).toBe('success');
    expect(compileColor(waterOutlineColor('dark', ['a', 'b'])).result).toBe('success');
  });

  it('is the theme outline with nothing revealed', () => {
    expect(colorFor(waterOutlineColor('dark'), { _id: 'a' })).not.toBe(WHITE);
  });

  it('goes white for a revealed body — it is the edge of the photograph, not a status', () => {
    expect(colorFor(waterOutlineColor('dark', ['a']), { _id: 'a' })).toBe(WHITE);
  });

  it('leaves an unrevealed lake alone, favourite gold included', () => {
    // The v2 bug in one assertion: revealing lake `a` used to paint `b`'s shoreline white too, so a
    // favourited lake elsewhere in the viewport silently lost its D#1 gold to someone else's reveal.
    const gold = colorFor(waterOutlineColor('dark', ['a']), { _id: 'b' }, true);
    expect(gold).not.toBe(WHITE);
    expect(colorFor(waterOutlineColor('dark', []), { _id: 'b' }, true)).toBe(gold);
  });
});

/** A map stub recording filters, with a style that already filters one of the layers. */
function fakeMap(existing: Record<string, unknown> = {}) {
  const filters = new Map<string, unknown>(Object.entries(existing));
  const known = new Set([
    ...IMAGERY_REPLACED_LAYERS.map((layer) => layer.id),
    ...Object.keys(existing),
  ]);
  return {
    filters,
    map: {
      getLayer: (id: string) => (known.has(id) ? ({ id } as never) : undefined),
      getFilter: (id: string) => filters.get(id),
      setFilter: (id: string, filter: unknown) => filters.set(id, filter),
    } as unknown as maplibregl.Map,
  };
}

const WATER_FILL = [{ id: 'water-fill', idProperty: '_id' }];
const SUB_AREA_LABEL = [{ id: 'sub-area-label', idProperty: 'waterBodyId' }];

describe('setLayersHiddenForBodies', () => {
  it('hides only the revealed bodies, leaving every other feature drawn', () => {
    const { map, filters } = fakeMap();
    setLayersHiddenForBodies(map, WATER_FILL, ['a', 'b'], new Map());
    const compiled = expression.createExpression(filters.get('water-fill'), {
      type: 'boolean',
      'property-type': 'data-driven',
      expression: { interpolated: false, parameters: ['zoom', 'feature'] },
    } as never);
    expect(compiled.result).toBe('success');
  });

  it('asks each layer for the property that layer actually carries', () => {
    // The bug this replaced: every layer was filtered on `_id`, but a sub-area's `_id` is its own
    // row and never a revealed body — so `in` answered false, `!` answered true, and the bay label
    // kept drawing over the photograph. MapLibre does not throw on a missing property, so the
    // failure was silent and open.
    const { map, filters } = fakeMap();
    setLayersHiddenForBodies(map, SUB_AREA_LABEL, ['a'], new Map());
    expect(JSON.stringify(filters.get('sub-area-label'))).toContain('waterBodyId');
    setLayersHiddenForBodies(map, WATER_FILL, ['a'], new Map());
    expect(JSON.stringify(filters.get('water-fill'))).toContain('_id');
  });

  it('every layer in the list names a property, since a missing one fails silently open', () => {
    for (const layer of IMAGERY_REPLACED_LAYERS) expect(layer.idProperty).toBeTruthy();
  });

  it('composes with the style own filter rather than replacing it', () => {
    // `sub-area-label` filters on `label`; dropping that draws every outline as a label.
    const base = ['==', ['get', 'label'], true];
    const { map, filters } = fakeMap({ 'sub-area-label': base });
    setLayersHiddenForBodies(map, SUB_AREA_LABEL, ['a'], new Map());
    expect(JSON.stringify(filters.get('sub-area-label'))).toContain('label');
  });

  it('restores exactly the style filter when nothing is revealed', () => {
    const base = ['==', ['get', 'label'], true];
    const { map, filters } = fakeMap({ 'sub-area-label': base });
    const captured = new Map<string, unknown>();
    setLayersHiddenForBodies(map, SUB_AREA_LABEL, ['a'], captured);
    setLayersHiddenForBodies(map, SUB_AREA_LABEL, [], captured);
    expect(filters.get('sub-area-label')).toEqual(base);
  });

  it('captures the base filter once, so a second call does not nest the reveal clause', () => {
    // Without the captured map, each call would wrap the previous output and the expression would
    // grow without bound across a session of panning.
    const { map, filters } = fakeMap({ 'water-fill': null });
    const captured = new Map<string, unknown>();
    setLayersHiddenForBodies(map, WATER_FILL, ['a'], captured);
    const once = JSON.stringify(filters.get('water-fill'));
    setLayersHiddenForBodies(map, WATER_FILL, ['a'], captured);
    expect(JSON.stringify(filters.get('water-fill'))).toBe(once);
  });

  it('skips a layer the style has not added yet rather than throwing', () => {
    const { map } = fakeMap();
    expect(() =>
      setLayersHiddenForBodies(map, [{ id: 'not-a-layer', idProperty: '_id' }], ['a'], new Map()),
    ).not.toThrow();
  });

  it('keeps the per-lake contour filter out of the captured set entirely', () => {
    // `bathymetry-contours` is re-added with a filter naming the open lake, so capturing it once and
    // replaying it would restore the *previous* lake's filter over the current one and draw nothing.
    // It belongs to the wholesale list instead.
    expect(IMAGERY_REPLACED_LAYERS.map((layer) => layer.id)).not.toContain('bathymetry-contours');
    expect(IMAGERY_REPLACED_WHOLE_LAYERS).toContain('bathymetry-contours');
  });
});

describe('IMAGERY_MIN_ZOOM', () => {
  it('is a usefulness floor, above the zoom where a lake is a handful of pixels', () => {
    expect(IMAGERY_MIN_ZOOM).toBeGreaterThanOrEqual(11);
    expect(IMAGERY_MIN_ZOOM).toBeLessThanOrEqual(14);
  });
});
