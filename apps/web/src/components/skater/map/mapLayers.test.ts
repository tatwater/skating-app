import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CONTOUR_LAYER_ID, CONTOUR_SOURCE_ID } from '@/lib/contourMap';
import { BANDS_LAYER_ID, BANDS_SOURCE_ID, BANDS_SOURCE_LAYER } from '@/lib/depthBands';
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
  DEPTH_BAND_EDGES_FT,
  depthBandIndex,
  mapGround,
  mapMarkVars,
  mapPalette,
} from './mapPalette';
import { SPEC_LAYERS } from './mapSpec';

const ARCHIVE = 'https://example.test/bathymetry.pmtiles';
const BANDS = 'https://example.test/bathymetry-bands.pmtiles';

describe('the skater style', () => {
  for (const flavor of ['dark', 'white'] as const) {
    it(`validates in the ${flavor} flavor — an invalid layer never draws, and never says so`, () => {
      const palette = mapPalette(flavor);
      const errors = validateStyleMin({
        version: 8,
        glyphs: 'https://example.test/{fontstack}/{range}.pbf',
        sources: skaterSources(ARCHIVE, BANDS),
        layers: skaterLayers(palette, true, true),
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

  it('leaves the band fills out without a band archive, and each archive stands alone', () => {
    expect(skaterSources(ARCHIVE)).not.toHaveProperty(BANDS_SOURCE_ID);
    expect(skaterLayers(mapPalette('dark'), true).map((l) => l.id)).not.toContain(BANDS_LAYER_ID);
    expect(skaterSources('', BANDS)).toEqual(
      expect.objectContaining({
        [BANDS_SOURCE_ID]: { type: 'vector', url: `pmtiles://${BANDS}` },
      }),
    );
    expect(skaterSources('', BANDS)).not.toHaveProperty(CONTOUR_SOURCE_ID);
    const bandsOnly = skaterLayers(mapPalette('white'), false, true).map((l) => l.id);
    expect(bandsOnly).toContain(BANDS_LAYER_ID);
    expect(bandsOnly).not.toContain(CONTOUR_LAYER_ID);
  });

  it('lays the band fills on the water, under the imagery wash and the contour lines', () => {
    const ids = skaterLayers(mapPalette('dark'), true, true).map((l) => l.id);
    expect(ids.slice(0, 4)).toEqual([
      'water-fill',
      BANDS_LAYER_ID,
      'imagery-loading',
      CONTOUR_LAYER_ID,
    ]);
  });

  it('starts the band fills hidden, scoped to no lake, and sorted deeper-over-shallower', () => {
    const layer = skaterLayers(mapPalette('dark'), true, true).find(
      (l) => l.id === BANDS_LAYER_ID,
    ) as {
      source: string;
      'source-layer': string;
      minzoom: number;
      filter: unknown;
      layout: Record<string, unknown>;
      paint: Record<string, unknown>;
    };
    expect(layer.source).toBe(BANDS_SOURCE_ID);
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
    const ids = skaterLayers(mapPalette('dark'), true, true).map((l) => l.id);
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
    const ids = new Set(skaterLayers(mapPalette('dark'), true, true).map((l) => l.id));
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
    expect(calls).not.toContain(`source:${BANDS_SOURCE_ID}`);
  });

  it('adds the band source and layer when the deployment has a band archive', () => {
    const calls: string[] = [];
    addSkaterLayers(
      {
        addSource: (id) => calls.push(`source:${id}`),
        addLayer: (layer) => calls.push(`layer:${layer.id}`),
      },
      mapPalette('dark'),
      '',
      BANDS,
    );
    expect(calls).toContain(`source:${BANDS_SOURCE_ID}`);
    expect(calls).toContain(`layer:${BANDS_LAYER_ID}`);
    expect(calls).not.toContain(`layer:${CONTOUR_LAYER_ID}`);
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
    expect(JSON.stringify(waterFillOpacity(p, null))).toContain('""');
  });

  it('stands the fill down for the lake under a satellite picture, and only that lake (D81)', () => {
    const p = mapPalette('dark');
    const [, base] = waterFillOpacity(p, null, 'm') as [string, unknown[]];
    expect(base.slice(0, 3)).toEqual(['case', ['==', ['get', '_id'], 'm'], 0]);
    const [, none] = waterFillOpacity(p, null) as [string, unknown[]];
    expect(none.slice(0, 3)).toEqual(['case', ['==', ['get', '_id'], ''], 0]);
  });
});

describe('mapPalette', () => {
  it('takes the ground from the basemap itself', () => {
    expect(mapGround('dark')).toBe('#1f1f1f');
    expect(mapPalette('dark').ground).toBe('#1f1f1f');
    expect(mapPalette('white').ground).toBe(mapGround('white'));
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

  it('draws the suggested crossing in ice, never green (D3)', () => {
    const p = mapPalette('dark');
    expect(p.hazard.passage).toBe(p.track);
    expect(p.hazard.danger).not.toBe(p.hazard.passage);
  });

  it('sets the label shadow from the field, stronger on light', () => {
    expect(mapMarkVars('dark')).toMatchObject({ '--map-ground': '#1f1f1f' });
    expect(String((mapMarkVars('white') as Record<string, string>)['--lab-sh'])).toContain('95%');
  });
});

describe('depth bands', () => {
  it('puts a depth in the band of the last edge at or under it', () => {
    expect(DEPTH_BAND_EDGES_FT).toEqual([0, 5, 10, 20, 30, 45, 70]);
    expect(depthBandIndex(-3)).toBe(0);
    expect(depthBandIndex(4.9)).toBe(0);
    expect(depthBandIndex(5)).toBe(1);
    expect(depthBandIndex(79)).toBe(6);
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 500, noNaN: true }),
        fc.double({ min: 0, max: 500, noNaN: true }),
        (a, b) => {
          // Deeper never reads as a shallower band.
          if (a <= b) expect(depthBandIndex(a)).toBeLessThanOrEqual(depthBandIndex(b));
        },
      ),
    );
  });

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
