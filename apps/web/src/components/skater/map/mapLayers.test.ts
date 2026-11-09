import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { DEPTH_BAND_EDGES_FT, withAccessDim } from '@skating/core';
import { describe, expect, it } from 'vitest';
import { CONTOUR_LAYER_ID, CONTOUR_SOURCE_ID } from '@/lib/contourMap';
import { BANDS_LAYER_ID, BANDS_SOURCE_LAYER } from '@/lib/depthBands';
import {
  addSkaterLayers,
  LAYER_GROUPS,
  MATCH_NONE,
  matchId,
  PHOTO_PIN_COUNT_LAYER,
  skaterLayers,
  skaterSources,
  waterFillColor,
  waterFillOpacity,
} from './mapLayers';
import {
  bandFillColor,
  contourColorByBand,
  contourWidthByBand,
  mapMarkVars,
  mapPalette,
  shoreOpacityByZoom,
} from './mapPalette';
import { SPEC_LAYERS } from './mapSpec';

const ARCHIVE = 'https://example.test/bathymetry.pmtiles';

describe('the skater style', () => {
  for (const flavor of ['dark', 'white'] as const) {
    it(`validates in the ${flavor} flavor — an invalid layer never draws, and never says so`, () => {
      const palette = mapPalette(flavor);
      const errors = validateStyleMin({
        version: 8,
        glyphs: 'https://example.test/{fontstack}/{range}.pbf',
        sources: skaterSources(ARCHIVE),
        layers: skaterLayers(palette, true),
      } as never);
      expect(errors).toEqual([]);
    });
  }

  it('leaves the contours out when the deployment has no archive', () => {
    expect(skaterSources('')).not.toHaveProperty(CONTOUR_SOURCE_ID);
    expect(skaterLayers(mapPalette('dark'), false).map((l) => l.id)).not.toContain(
      CONTOUR_LAYER_ID,
    );
  });

  it('draws the band fills from the contour archive, on its second layer, or not at all', () => {
    // One archive, two layers (BANDS.md): no extra source, and no archive means neither layer.
    expect(Object.keys(skaterSources(ARCHIVE)).filter((id) => id.startsWith('bathymetry'))).toEqual(
      [CONTOUR_SOURCE_ID],
    );
    expect(skaterLayers(mapPalette('white'), false).map((l) => l.id)).not.toContain(BANDS_LAYER_ID);
  });

  it('lays the band fills on the water, under the imagery wash and the contour lines', () => {
    const ids = skaterLayers(mapPalette('dark'), true).map((l) => l.id);
    expect(ids.slice(0, 4)).toEqual([
      'water-fill',
      BANDS_LAYER_ID,
      'imagery-loading',
      CONTOUR_LAYER_ID,
    ]);
  });

  it('starts the band fills hidden, scoped to no lake, and sorted deeper-over-shallower', () => {
    const layer = skaterLayers(mapPalette('dark'), true).find((l) => l.id === BANDS_LAYER_ID) as {
      source: string;
      'source-layer': string;
      minzoom: number;
      filter: unknown;
      layout: Record<string, unknown>;
      paint: Record<string, unknown>;
    };
    expect(layer.source).toBe(CONTOUR_SOURCE_ID);
    expect(layer['source-layer']).toBe(BANDS_SOURCE_LAYER);
    expect(layer.minzoom).toBe(11);
    expect(layer.filter).toEqual(['==', ['literal', true], ['literal', false]]);
    expect(layer.layout).toMatchObject({
      visibility: 'none',
      'fill-sort-key': ['to-number', ['get', 'bandIndex'], 0],
    });
    expect(layer.paint['fill-opacity']).toBe(0);
  });

  it('draws the hazard footprints over the depth, the names and the tracks (D82)', () => {
    const ids = skaterLayers(mapPalette('dark'), true).map((l) => l.id);
    const at = (id: string) => ids.indexOf(id);
    for (const under of [
      BANDS_LAYER_ID,
      CONTOUR_LAYER_ID,
      'sub-area-label',
      'landmark-label',
      'track-line',
    ]) {
      expect(at(under)).toBeLessThan(at('hazard-fill'));
    }
    expect(at('water-fill')).toBe(0);
  });

  it('numbers each photo pin over its circle, from the overlay’s own count', () => {
    const layers = skaterLayers(mapPalette('dark'), true);
    const ids = layers.map((l) => l.id);
    expect(ids.indexOf(PHOTO_PIN_COUNT_LAYER)).toBe(ids.indexOf('photo-pins') + 1);
    const count = layers.find((l) => l.id === PHOTO_PIN_COUNT_LAYER) as {
      source: string;
      layout: Record<string, unknown>;
    };
    expect(count.source).toBe('photo-pins');
    expect(count.layout['text-field']).toEqual(['to-string', ['get', 'n']]);
  });

  it('keeps the ids the imagery reveal and the contour helpers name', () => {
    const ids = skaterLayers(mapPalette('dark'), true).map((l) => l.id);
    for (const id of [
      'water-fill',
      'sub-area-outline',
      'sub-area-label',
      'track-line',
      'hazard-fill',
      'hazard-outline-provisional',
      'hazard-outline-confirmed',
      'imagery-loading',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('maps every spec layer to layers that exist, and nothing to the hazards', () => {
    const ids = new Set(skaterLayers(mapPalette('dark'), true).map((l) => l.id));
    for (const layer of SPEC_LAYERS)
      for (const id of LAYER_GROUPS[layer]) expect(ids.has(id)).toBe(true);
    const grouped = Object.values(LAYER_GROUPS).flat();
    expect(grouped.some((id) => id.startsWith('hazard'))).toBe(false);
  });

  it('adds every source, then every layer', () => {
    const calls: string[] = [];
    addSkaterLayers(
      {
        addSource: (id) => calls.push(`source:${id}`),
        addLayer: (layer) => calls.push(`layer:${layer.id}`),
      },
      mapPalette('dark'),
      '',
    );
    const firstLayer = calls.findIndex((c) => c.startsWith('layer:'));
    expect(calls.slice(firstLayer).every((c) => c.startsWith('layer:'))).toBe(true);
    expect(calls).toContain('source:water');
    expect(calls).not.toContain(`layer:${BANDS_LAYER_ID}`);
  });

  it('adds the band layer with the contours when the deployment has an archive', () => {
    const calls: string[] = [];
    addSkaterLayers(
      {
        addSource: (id) => calls.push(`source:${id}`),
        addLayer: (layer) => calls.push(`layer:${layer.id}`),
      },
      mapPalette('dark'),
      ARCHIVE,
    );
    expect(calls.filter((c) => c.startsWith('source:bathymetry'))).toEqual([
      `source:${CONTOUR_SOURCE_ID}`,
    ]);
    expect(calls.indexOf(`layer:${BANDS_LAYER_ID}`)).toBeLessThan(
      calls.indexOf(`layer:${CONTOUR_LAYER_ID}`),
    );
  });
});

describe('filters and paint', () => {
  it('matches one id, or none', () => {
    expect(matchId('a')).toEqual(['==', ['get', '_id'], 'a']);
    expect(matchId('s', 'waterBodyId')).toEqual(['==', ['get', 'waterBodyId'], 's']);
    expect(matchId(null)).toBe(MATCH_NONE);
  });

  it('fills an inactive body gray and the focused lake with the shallow band under its contours', () => {
    const p = mapPalette('dark');
    expect(waterFillColor(p, 'm')).toEqual([
      'case',
      ['==', ['get', 'inactive'], true],
      p.inactive.fill,
      ['==', ['get', '_id'], 'm'],
      p.depth.fills[0],
      p.water.fill,
    ]);
    // The water is the depth ramp's own value, opaque; only the inactive gray is a wash, and it
    // carries its own alpha — so the layer's opacity stays 1 either way.
    expect(JSON.stringify(waterFillOpacity())).toContain('""');
    expect(p.water.fill).toBe(p.depth.fills[0]);
    expect(p.water.fill).toMatch(/^#[0-9a-f]{6}$/);
    expect(p.inactive.fill).toMatch(/^rgba\(/);
  });

  it('stands the fill down for the lake under a satellite picture, and only that lake (D81)', () => {
    const [, base] = waterFillOpacity('m') as [string, unknown[]];
    expect(base).toEqual(['case', ['==', ['get', '_id'], 'm'], 0, 1]);
    const [, none] = waterFillOpacity() as [string, unknown[]];
    expect(none).toEqual(['case', ['==', ['get', '_id'], ''], 0, 1]);
  });

  it('softens the shore by zoom, under the access dim', () => {
    const outline = skaterLayers(mapPalette('dark'), true).find(
      (l) => l.id === 'water-outline',
    ) as {
      paint: Record<string, unknown>;
    };
    expect(outline.paint['line-opacity']).toEqual(shoreOpacityByZoom(withAccessDim));
    expect(JSON.stringify(outline.paint['line-opacity'])).toContain('"zoom"');
  });
});

describe('mapPalette, as the layers read it', () => {
  it('sets the label shadow from the field, stronger on light', () => {
    expect(mapMarkVars('dark')).toMatchObject({ '--map-ground': '#1d2022' });
    expect(String((mapMarkVars('white') as Record<string, string>)['--lab-sh'])).toContain('95%');
  });

  it('resolves seven bands of fill, line and index from the tokens', () => {
    for (const flavor of ['dark', 'white'] as const) {
      const { depth } = mapPalette(flavor);
      for (const ramp of [depth.fills, depth.lines, depth.indexes]) {
        expect(ramp).toHaveLength(7);
        for (const color of ramp) expect(color).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
    expect(mapPalette('dark').depth.fills[0]).toBe('#294157');
  });
});

describe('depth bands', () => {
  it('steps the contour color by band, with index lines on multiples of 25 ft', () => {
    const p = mapPalette('dark');
    const expr = contourColorByBand(p.depth) as unknown[];
    expect(expr[0]).toBe('case');
    expect(JSON.stringify(expr)).toContain(p.depth.indexes[6] as string);
    expect(JSON.stringify(contourWidthByBand())).toContain('25');
  });

  it('fills each band polygon with its own band’s token fill, keyed on the tile’s index', () => {
    for (const flavor of ['dark', 'white'] as const) {
      const p = mapPalette(flavor);
      const expr = bandFillColor(p.depth);
      expect(expr.slice(0, 3)).toEqual([
        'step',
        ['to-number', ['get', 'bandIndex'], 0],
        p.depth.fills[0],
      ]);
      // One stop per band past the first, on the same ramp the legend's swatches show.
      expect(expr.slice(3)).toEqual(p.depth.fills.slice(1).flatMap((c, i) => [i + 1, c]));
      expect(expr).toHaveLength(3 + 2 * (DEPTH_BAND_EDGES_FT.length - 1));
    }
  });
});
