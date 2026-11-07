import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyMapSpecOps,
  DOCK_CONTROLS,
  defineMapSpec,
  diffMapSpec,
  exploreMapSpec,
  fitKey,
  HIDDEN_MAP_SPEC,
  lakeMapSpec,
  latestMapSpec,
  type MapFit,
  type MapInteractions,
  type MapSpec,
  mapClickAction,
  panelMapSpec,
  resolveMapSpec,
  SPEC_LAYERS,
  STRAY_HAZARD_ZOOM,
  sameMapSpec,
  strayHazardFit,
} from './mapSpec';

// ── Arbitraries ───────────────────────────────────────────────────────────────────────────────

const id = fc.constantFrom('a', 'b', 'c');
const bool = fc.boolean();
const record = <K extends string>(keys: readonly K[]): fc.Arbitrary<Record<K, boolean>> =>
  fc.record(Object.fromEntries(keys.map((k) => [k, bool]))) as unknown as fc.Arbitrary<
    Record<K, boolean>
  >;

const fitArb: fc.Arbitrary<MapFit | null> = fc.oneof(
  fc.constant(null),
  fc.record({ kind: fc.constant('body' as const), bodyId: id }),
  fc.record({
    kind: fc.constant('bounds' as const),
    key: id,
    bounds: fc.constant<[[number, number], [number, number]]>([
      [-73, 43],
      [-72, 44],
    ]),
  }),
  fc.record({
    kind: fc.constant('point' as const),
    key: id,
    lng: fc.constant(-72),
    lat: fc.constant(43),
  }),
  fc.constant({ kind: 'region' as const }),
);

const overlayArb = fc.option(
  fc.record({
    key: id,
    data: fc.constant<GeoJSON.FeatureCollection>({ type: 'FeatureCollection', features: [] }),
  }),
  { nil: null },
);

const interactionsArb: fc.Arbitrary<MapInteractions> = fc.record({
  pan: bool,
  zoom: bool,
  select: bool,
  requestLake: bool,
  click: fc.constantFrom('navigate' as const, 'capture' as const, 'none' as const),
});

const specArb: fc.Arbitrary<MapSpec> = fc.record({
  id: fc.constantFrom('explore', 'lake', 'panel'),
  visible: bool,
  focus: fc.option(
    fc.record({ bodyId: id, subAreaId: id, hazardId: id }, { requiredKeys: ['bodyId'] }),
    { nil: null },
  ),
  layers: record(SPEC_LAYERS),
  interactions: interactionsArb,
  fit: fitArb,
  overlays: fc.record({
    track: overlayArb,
    photos: overlayArb,
    draft: overlayArb,
    samples: overlayArb,
  }),
  mode: fc.option(fc.record({ mode: id, line: id, step: id }, { requiredKeys: ['mode'] }), {
    nil: null,
  }),
  dock: record(DOCK_CONTROLS),
});

/** Two specs equal in everything the map draws: overlays by key, fits by key. */
function drawn(spec: MapSpec) {
  return {
    ...spec,
    fit: fitKey(spec.fit),
    overlays: Object.fromEntries(
      Object.entries(spec.overlays).map(([k, o]) => [k, o?.key ?? null]),
    ),
  };
}

// ── The differ ────────────────────────────────────────────────────────────────────────────────

describe('diffMapSpec / applyMapSpecOps', () => {
  it('yields nothing for a spec against itself — applying on every render is free', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        expect(diffMapSpec(spec, spec)).toEqual([]);
      }),
    );
  });

  it('takes any spec to any other: no view inherits the last view’s map', () => {
    fc.assert(
      fc.property(specArb, specArb, (prev, next) => {
        const reached = applyMapSpecOps(prev, diffMapSpec(prev, next));
        expect(drawn(reached)).toEqual(drawn(next));
      }),
    );
  });

  it('from nothing (a new instance) states every field, and so reaches the spec from any base', () => {
    fc.assert(
      fc.property(specArb, specArb, (base, next) => {
        const reached = applyMapSpecOps(base, diffMapSpec(null, next));
        expect(drawn(reached)).toEqual(drawn(next));
      }),
    );
  });

  it('emits one op per changed field and none for an unchanged one', () => {
    fc.assert(
      fc.property(specArb, fc.constantFrom(...SPEC_LAYERS), (spec, layer) => {
        const flipped = { ...spec, layers: { ...spec.layers, [layer]: !spec.layers[layer] } };
        expect(diffMapSpec(spec, flipped)).toEqual([
          { kind: 'layer', layer, on: !spec.layers[layer] },
        ]);
      }),
    );
  });

  it('runs a fit once per key: the same fit in the next spec never moves the camera', () => {
    const lake = lakeMapSpec('m');
    const panel = panelMapSpec('m', { hazardId: 'h' });
    expect(diffMapSpec(lake, panel).some((op) => op.kind === 'fit')).toBe(false);
    expect(diffMapSpec(lake, lakeMapSpec('n'))).toContainEqual({
      kind: 'fit',
      fit: { kind: 'body', bodyId: 'n' },
    });
  });

  it('frames a bay inside its lake under the lake’s own fit key', () => {
    const bay = panelMapSpec('m', { subAreaId: 's' });
    expect(bay.focus).toEqual({ bodyId: 'm', subAreaId: 's' });
    expect(panelMapSpec('m').focus).toEqual({ bodyId: 'm' });
    expect(panelMapSpec('m', { hazardId: 'h' }).focus).toEqual({ bodyId: 'm', hazardId: 'h' });
    // From the bay's own lake page the card changes nothing; from the bare lake, only the focus.
    expect(diffMapSpec(lakeMapSpec('m', 's'), bay).some((op) => op.kind === 'focus')).toBe(false);
    expect(diffMapSpec(lakeMapSpec('m'), bay)).toContainEqual({
      kind: 'focus',
      focus: { bodyId: 'm', subAreaId: 's' },
    });
    expect(diffMapSpec(lakeMapSpec('m'), bay).some((op) => op.kind === 'fit')).toBe(false);
  });

  it('compares overlays by key, not by identity', () => {
    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
    const a = panelMapSpec('m', { track: { key: 'r1', data } });
    const b = panelMapSpec('m', { track: { key: 'r1', data: { ...data } } });
    expect(diffMapSpec(a, b)).toEqual([]);
    expect(sameMapSpec(a, b)).toBe(true);
    expect(sameMapSpec(a, panelMapSpec('m'))).toBe(false);
  });
});

describe('fitKey', () => {
  it('names every fit by what it frames', () => {
    expect(fitKey(null)).toBeNull();
    expect(fitKey({ kind: 'body', bodyId: 'x' })).toBe('body:x');
    expect(fitKey({ kind: 'region' })).toBe('region');
    expect(fitKey({ kind: 'point', key: 'k', lng: 0, lat: 0 })).toBe('point:k');
    expect(
      fitKey({
        kind: 'bounds',
        key: 'k',
        bounds: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toBe('bounds:k');
  });
});

// ── Defaults and the views' specs ─────────────────────────────────────────────────────────────

describe('defineMapSpec', () => {
  it('fills every unstated field with the default, never a previous value', () => {
    const spec = defineMapSpec({ id: 'x', layers: { depth: true } });
    expect(spec).toEqual({
      id: 'x',
      visible: true,
      focus: null,
      layers: {
        depth: true,
        places: false,
        putIns: false,
        tracks: false,
        labels: false,
        favorites: false,
      },
      interactions: { pan: true, zoom: true, select: true, requestLake: false, click: 'navigate' },
      fit: null,
      overlays: { track: null, photos: null, draft: null, samples: null },
      mode: null,
      dock: { zoom: false, layers: false, locate: false, imagery: false, legend: false },
    });
  });

  it('hides the map when nobody declares one', () => {
    expect(HIDDEN_MAP_SPEC.visible).toBe(false);
    expect(HIDDEN_MAP_SPEC.interactions.click).toBe('none');
  });

  it('has no hazards field to turn off (D3)', () => {
    expect(SPEC_LAYERS).not.toContain('hazards' as never);
    expect(Object.keys(lakeMapSpec('m').layers)).not.toContain('hazards');
  });
});

describe('the views’ specs', () => {
  it('explore: labels and favorites, request-a-lake on, no lake', () => {
    const spec = exploreMapSpec();
    expect(spec.focus).toBeNull();
    expect(spec.layers).toMatchObject({ labels: true, favorites: true, depth: false });
    expect(spec.interactions.requestLake).toBe(true);
    expect(spec.dock).toMatchObject({ zoom: true, layers: true, locate: true, imagery: false });
  });

  it('lake: framed, every layer, a bay when given', () => {
    expect(lakeMapSpec('m').focus).toEqual({ bodyId: 'm' });
    expect(lakeMapSpec('m', 's').focus).toEqual({ bodyId: 'm', subAreaId: 's' });
    expect(lakeMapSpec('m').fit).toEqual({ kind: 'body', bodyId: 'm' });
    expect(Object.values(lakeMapSpec('m').layers).every(Boolean)).toBe(true);
  });

  it('panel: the lake’s own fit, with its hazard and overlays', () => {
    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
    const spec = panelMapSpec('m', { hazardId: 'h', photos: { key: 'p', data } });
    expect(spec.focus).toEqual({ bodyId: 'm', hazardId: 'h' });
    expect(spec.overlays.photos?.key).toBe('p');
    expect(panelMapSpec('m').focus).toEqual({ bodyId: 'm' });
  });

  it('latest: labels, no request-a-lake', () => {
    expect(latestMapSpec().interactions.requestLake).toBe(false);
    expect(latestMapSpec().layers.labels).toBe(true);
  });
});

/**
 * The guard for a hazard whose row disagrees with itself. Dev has one: a pin drawn on Mascoma
 * (43.61, −72.13) filed under an unnamed body near Albany (42.61, −73.87), so opening it from the
 * lake flew the map across two states and left the pin the skater clicked behind.
 */
describe('strayHazardFit', () => {
  const MASCOMA = { minLat: 43.595, minLng: -72.15, maxLat: 43.63, maxLng: -72.1 };
  const ON_MASCOMA = { minLat: 43.608, minLng: -72.131, maxLat: 43.612, maxLng: -72.126 };
  const NEAR_ALBANY = { minLat: 42.609, minLng: -73.871, maxLat: 42.611, maxLng: -73.869 };

  it('is undefined when the pin sits on the lake it is filed under — the camera does not move', () => {
    expect(strayHazardFit('h', ON_MASCOMA, MASCOMA)).toBeUndefined();
  });

  it('frames the pin when its box does not touch the lake’s', () => {
    const fit = strayHazardFit('h', ON_MASCOMA, NEAR_ALBANY);
    expect(fit).toEqual({
      kind: 'point',
      key: 'hazard:h',
      lng: (ON_MASCOMA.minLng + ON_MASCOMA.maxLng) / 2,
      lat: (ON_MASCOMA.minLat + ON_MASCOMA.maxLat) / 2,
      zoom: STRAY_HAZARD_ZOOM,
    });
  });

  it('is keyed on the hazard, so it runs once rather than on every render', () => {
    const a = strayHazardFit('h1', ON_MASCOMA, NEAR_ALBANY);
    const b = strayHazardFit('h2', ON_MASCOMA, NEAR_ALBANY);
    expect(fitKey(a as MapFit)).toBe('point:hazard:h1');
    expect(fitKey(b as MapFit)).not.toBe(fitKey(a as MapFit));
  });

  it('decides nothing while either box is still loading', () => {
    expect(strayHazardFit('h', undefined, MASCOMA)).toBeUndefined();
    expect(strayHazardFit('h', ON_MASCOMA, undefined)).toBeUndefined();
    expect(strayHazardFit('h', null, null)).toBeUndefined();
  });

  it('a touching box counts as on the lake: only a real disagreement frames the pin', () => {
    const edge = { minLat: 43.63, minLng: -72.1, maxLat: 43.64, maxLng: -72.09 };
    expect(strayHazardFit('h', edge, MASCOMA)).toBeUndefined();
  });

  it('the panel takes the fit when given one, and the lake’s when not', () => {
    const fit = strayHazardFit('h', ON_MASCOMA, NEAR_ALBANY) as MapFit;
    expect(panelMapSpec('b', { hazardId: 'h', fit }).fit).toEqual(fit);
    expect(panelMapSpec('b', { hazardId: 'h' }).fit).toEqual({ kind: 'body', bodyId: 'b' });
    // The focus still names the lake it is filed under: the card says which lake, even a wrong one.
    expect(panelMapSpec('b', { hazardId: 'h', fit }).focus).toEqual({ bodyId: 'b', hazardId: 'h' });
  });

  it('frames nothing on `fit: null`, and keeps the lake drawn while it waits', () => {
    // The gap between the hazard's box and the lake's: no camera move, but the focus and every
    // layer stay declared, so the pin the skater clicked is still on the map while its card loads.
    const waiting = panelMapSpec('b', { hazardId: 'h', fit: null });
    expect(waiting.fit).toBeNull();
    expect(waiting.focus).toEqual({ bodyId: 'b', hazardId: 'h' });
    expect(waiting.layers.putIns).toBe(true);
    expect(waiting.layers.labels).toBe(true);
  });
});

describe('resolveMapSpec', () => {
  const allOn = {
    depth: true,
    places: true,
    putIns: true,
    tracks: true,
    labels: true,
    favorites: true,
    imagery: false,
  };

  it('draws a layer only when the view asks and the viewer allows', () => {
    fc.assert(
      fc.property(specArb, record([...SPEC_LAYERS, 'imagery'] as const), (spec, toggles) => {
        const resolved = resolveMapSpec(spec, toggles);
        for (const layer of SPEC_LAYERS) {
          if (resolved.layers[layer]) {
            expect(spec.layers[layer]).toBe(true);
            expect(toggles[layer]).toBe(true);
          }
        }
        if (toggles.imagery) expect(resolved.layers.depth).toBe(false);
      }),
    );
  });

  it('keeps a spec’s layers as they are with every switch on', () => {
    expect(resolveMapSpec(lakeMapSpec('m'), allOn).layers).toEqual(lakeMapSpec('m').layers);
  });
});

// ── Clicks ────────────────────────────────────────────────────────────────────────────────────

describe('mapClickAction', () => {
  const nav = lakeMapSpec('m').interactions;

  it('lets a hazard win over the lake it lies in', () => {
    expect(mapClickAction(nav, { hazardId: 'h', bodyId: 'b', onUnlistedWater: false })).toEqual({
      kind: 'hazard',
      hazardId: 'h',
    });
  });

  it('opens a listed body', () => {
    expect(mapClickAction(nav, { bodyId: 'b', onUnlistedWater: true })).toEqual({
      kind: 'body',
      bodyId: 'b',
    });
  });

  it('asks for a lake only on water we don’t list, and only where the view takes requests', () => {
    expect(mapClickAction(nav, { onUnlistedWater: true })).toEqual({ kind: 'request' });
    expect(mapClickAction(nav, { onUnlistedWater: false })).toEqual({ kind: 'none' });
    expect(mapClickAction(latestMapSpec().interactions, { onUnlistedWater: true })).toEqual({
      kind: 'none',
    });
  });

  it('captures everything in a capture mode, and nothing in none', () => {
    const hit = { hazardId: 'h', bodyId: 'b', onUnlistedWater: true };
    expect(mapClickAction({ ...nav, click: 'capture' }, hit)).toEqual({ kind: 'capture' });
    expect(mapClickAction({ ...nav, click: 'none' }, hit)).toEqual({ kind: 'none' });
  });

  it('opens nothing when selection is off', () => {
    expect(
      mapClickAction(
        { ...nav, select: false, requestLake: false },
        { hazardId: 'h', bodyId: 'b', onUnlistedWater: false },
      ),
    ).toEqual({ kind: 'none' });
  });
});
