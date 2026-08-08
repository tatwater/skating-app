import { describe, expect, it } from 'vitest';
import {
  ADMIN_MAX_ZOOM,
  composeBasemapLayers,
  REGION_MIN_ZOOM,
  WORLD_LAYER_PREFIX,
  type ZoomableLayer,
} from './basemapLayers';

/** A stand-in for what `layers()` returns — this module only ever reads id and zoom bounds. */
const layer = (id: string, bounds: Partial<Omit<ZoomableLayer, 'id'>> = {}): ZoomableLayer => ({
  id,
  ...bounds,
});

/** The handful of flavour layers the policy actually names, plus detail it should leave alone. */
const flavour = (): ZoomableLayer[] => [
  layer('background'),
  layer('earth'),
  layer('water'),
  layer('roads_highway'),
  layer('water_stream', { minzoom: 14 }),
  layer('roads_major_casing_early', { maxzoom: 12 }),
  layer('boundaries_country'),
  layer('boundaries'),
  layer('places_locality', { type: 'symbol', 'source-layer': 'places' }),
  layer('roads_labels_major', {
    type: 'symbol',
    'source-layer': 'roads',
    filter: ['==', 'kind', 'highway'],
  }),
  // Polygon-sourced, and therefore never liftable — see `REGION_LABEL_SOURCE_LAYERS`.
  layer('water_label_lakes', { type: 'symbol', 'source-layer': 'water' }),
  layer('places_country'),
  layer('places_region'),
  layer('water_label_ocean'),
];

const compose = (mask: ZoomableLayer[] = [layer('region-mask-land')]) =>
  composeBasemapLayers({ world: flavour(), region: flavour(), mask });

const ids = (ls: ZoomableLayer[]) => ls.map((l) => l.id);
const find = (ls: ZoomableLayer[], id: string) => ls.find((l) => l.id === id);

const OUTLINE = { type: 'Polygon', coordinates: [] };

/**
 * A stand-in for the style spec's `convertFilter`, which turns legacy filter syntax into expression
 * syntax. Marking rather than converting: the assertion worth making here is that every filter goes
 * *through* it, because the one that didn't rejected the whole style and blanked the map.
 */
const convertFilter = (filter: unknown) => ['converted', filter];
const REGION = { outline: OUTLINE, convertFilter };

describe('composeBasemapLayers', () => {
  describe('region labels', () => {
    const withFilter = () =>
      composeBasemapLayers({
        world: flavour(),
        region: flavour(),
        mask: [layer('region-mask-land')],
        regionFilter: REGION,
      });

    it('lifts labels above the mask, so ours stay legible where they overhang', () => {
      // "New York" is anchored in Manhattan with half the word over New Jersey. Under the mask, the
      // half over New Jersey vanished; over it, the whole name reads.
      const ids = withFilter().map((l) => l.id);
      expect(ids.indexOf('region-mask-land')).toBeLessThan(ids.indexOf('places_locality'));
    });

    it('leaves fills and lines under the mask, where covering is the right answer', () => {
      const ids = withFilter().map((l) => l.id);
      expect(ids.indexOf('roads_highway')).toBeLessThan(ids.indexOf('region-mask-land'));
    });

    it('filters lifted labels to the region, or they would simply be visible again', () => {
      const label = withFilter().find((l) => l.id === 'places_locality');
      expect(label?.filter).toEqual(['within', OUTLINE]);
    });

    it("ands with the flavour's own filter rather than replacing it", () => {
      const roads = withFilter().find((l) => l.id === 'roads_labels_major');
      // Converted first — `['all', <legacy>, ['within', …]]` is read as a legacy filter, and
      // `within` is not a legacy operator, so MapLibre rejects the entire style and the map goes
      // blank. That shipped once.
      expect(roads?.filter).toEqual([
        'all',
        ['converted', ['==', 'kind', 'highway']],
        ['within', OUTLINE],
      ]);
    });

    it('leaves polygon-sourced labels under the mask, because `within` would delete them', () => {
      // `within` supports Point and LineString only. Handed a polygon it evaluates false, so
      // filtering the lake-name layer does not filter it — it removes every lake name on the map,
      // inside our own region included. It stays below the mask, where nothing covers it in-region
      // and the mask covers it outside.
      const composed = withFilter();
      const ids = composed.map((l) => l.id);
      expect(ids.indexOf('water_label_lakes')).toBeLessThan(ids.indexOf('region-mask-land'));
      expect(composed.find((l) => l.id === 'water_label_lakes')?.filter).toBeUndefined();
    });

    it('keeps every label beneath the mask when no outline is supplied', () => {
      const ids = compose().map((l) => l.id);
      expect(ids.indexOf('places_locality')).toBeLessThan(ids.indexOf('region-mask-land'));
      expect(compose().find((l) => l.id === 'places_locality')?.filter).toBeUndefined();
    });
  });

  it('puts the world floor first, then region detail, then the mask, then admin on top', () => {
    const composed = ids(compose());
    const at = (id: string) => composed.indexOf(id);

    expect(at(`${WORLD_LAYER_PREFIX}earth`)).toBeLessThan(at('roads_highway'));
    expect(at('roads_highway')).toBeLessThan(at('region-mask-land'));
    expect(at('region-mask-land')).toBeLessThan(at(`${WORLD_LAYER_PREFIX}boundaries`));
  });

  it('namespaces every world layer so the two archives cannot collide', () => {
    const composed = compose();
    const fromWorld = composed.filter((l) => l.id.startsWith(WORLD_LAYER_PREFIX));
    expect(fromWorld.length).toBeGreaterThan(0);
    // The regional set keeps its bare ids, so nothing is renamed twice.
    expect(ids(composed)).toContain('roads_highway');
    expect(ids(composed)).not.toContain(`${WORLD_LAYER_PREFIX}roads_highway`);
  });

  it('draws exactly one background — a second would repaint over everything beneath it', () => {
    const backgrounds = ids(compose()).filter((id) => id.endsWith('background'));
    expect(backgrounds).toEqual([`${WORLD_LAYER_PREFIX}background`]);
  });

  it('takes the world overview for nothing but the floor, the border and the name', () => {
    const fromWorld = ids(compose())
      .filter((id) => id.startsWith(WORLD_LAYER_PREFIX))
      .map((id) => id.slice(WORLD_LAYER_PREFIX.length));
    expect(fromWorld).not.toContain('roads_highway');
    expect(fromWorld).not.toContain('places_locality');
    expect(fromWorld).toContain('boundaries');
    expect(fromWorld).toContain('places_region');
  });

  it('holds regional detail back to the zoom the overview hands over at', () => {
    expect(find(compose(), 'roads_highway')?.minzoom).toBe(REGION_MIN_ZOOM);
  });

  it('never widens a zoom range the flavour already narrowed', () => {
    const composed = compose();
    // Streams start at z14 in the flavour and must not be pulled down to the regional floor.
    expect(find(composed, 'water_stream')?.minzoom).toBe(14);
    // A layer that already ends before the admin cap keeps its own ceiling.
    expect(find(composed, 'roads_major_casing_early')?.maxzoom).toBe(12);
  });

  it('fades admin lines and labels out where the overview stops being accurate enough', () => {
    const composed = compose();
    for (const id of ['boundaries', 'boundaries_country', 'places_country', 'places_region']) {
      expect(find(composed, `${WORLD_LAYER_PREFIX}${id}`)?.maxzoom).toBe(ADMIN_MAX_ZOOM);
    }
    // Ocean names are not admin labels and are not capped.
    expect(find(composed, `${WORLD_LAYER_PREFIX}water_label_ocean`)?.maxzoom).toBeUndefined();
  });

  it('drops from the region whatever the overview already draws', () => {
    const composed = ids(compose());
    for (const id of ['boundaries', 'places_region', 'water_label_ocean']) {
      expect(composed).not.toContain(id);
      expect(composed).toContain(`${WORLD_LAYER_PREFIX}${id}`);
    }
  });

  it('survives an overview archive that is missing a layer the policy names', () => {
    const composed = composeBasemapLayers({
      world: [layer('earth')],
      region: flavour(),
      mask: [],
    });
    expect(ids(composed)).toContain(`${WORLD_LAYER_PREFIX}earth`);
    expect(ids(composed)).not.toContain(`${WORLD_LAYER_PREFIX}background`);
  });

  it('keeps the mask above every regional layer, including the late-drawn ones', () => {
    const composed = ids(compose());
    const maskAt = composed.indexOf('region-mask-land');
    const regional = composed.filter(
      (id) => !id.startsWith(WORLD_LAYER_PREFIX) && id !== 'region-mask-land',
    );
    for (const id of regional) expect(composed.indexOf(id)).toBeLessThan(maskAt);
  });
});
