import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { describe, expect, it } from 'vitest';
import {
  boundsToViewport,
  buildMapStyle,
  favoriteFeatureIds,
  featureIdForBody,
  frameForCoord,
  GEOLOCATION_FRAME_ZOOM,
  type MappableBody,
  type MappableSubArea,
  NORTHEAST_REGION_BOUNDS,
  OSM_ATTRIBUTION,
  putInsToFeatureCollection,
  subAreasToFeatureCollection,
  waterBodiesToFeatureCollection,
  zoomForViewport,
} from './waterMap';

describe('buildMapStyle', () => {
  const REGION = 'https://example.com/vt.pmtiles';
  const WORLD = 'https://example.com/world.pmtiles';
  const style = buildMapStyle({ regionUrl: REGION, worldUrl: WORLD });
  const ids = () => style.layers.map((l) => l.id);

  it('is a v8 style with the Protomaps pmtiles source', () => {
    expect(style.version).toBe(8);
    expect(style.sources.protomaps).toMatchObject({
      type: 'vector',
      url: `pmtiles://${REGION}`,
    });
  });

  it('carries OSM attribution on the basemap source (ODbL launch gate)', () => {
    expect((style.sources.protomaps as { attribution?: string }).attribution).toBe(OSM_ATTRIBUTION);
  });

  it('includes basemap layers and font/sprite assets', () => {
    expect(Array.isArray(style.layers)).toBe(true);
    expect(style.layers.length).toBeGreaterThan(0);
    expect(style.glyphs).toContain('{fontstack}');
    expect(style.sprite).toBeTruthy();
  });

  it('defaults to the wintery white flavor and its light sprite (D6/D34)', () => {
    expect(style.sprite).toContain('/light');
  });

  it('uses the dark sprite for the dark flavor', () => {
    expect(buildMapStyle({ regionUrl: REGION, flavor: 'dark' }).sprite).toContain('/dark');
  });

  it('adds the whole-planet overview as a second source', () => {
    expect(style.sources.world).toMatchObject({ type: 'vector', url: `pmtiles://${WORLD}` });
  });

  it('carries the region mask as a local geojson source, needing no network', () => {
    const mask = style.sources['region-mask'] as { type: string; data: GeoJSON.FeatureCollection };
    expect(mask.type).toBe('geojson');
    expect(mask.data.features.length).toBeGreaterThan(0);
    // Sea underneath, land over it, lakes on top — together they tile the neighbourhood, so a
    // label overhanging Long Island Sound has something over it too.
    const kinds = new Set(mask.data.features.map((f) => f.properties?.kind));
    expect(kinds).toEqual(new Set(['sea', 'land', 'water']));
  });

  it('draws the mask over regional detail but under the borders and names', () => {
    const at = (id: string) => ids().indexOf(id);
    expect(at('world_earth')).toBeLessThan(at('roads_highway'));
    expect(at('roads_highway')).toBeLessThan(at('region-mask-land'));
    expect(at('region-mask-land')).toBeLessThan(at('world_boundaries'));
  });

  it("paints the mask in the flavour's own land and water colours, not a grey of its own", () => {
    const light = buildMapStyle({ regionUrl: REGION, worldUrl: WORLD, flavor: 'white' });
    const fill = (style: ReturnType<typeof buildMapStyle>) =>
      (
        style.layers.find((l) => l.id === 'region-mask-land') as unknown as {
          paint: Record<string, string>;
        }
      ).paint['fill-color'];
    expect(fill(light)).toBe('#ffffff');
    expect(fill(buildMapStyle({ regionUrl: REGION, worldUrl: WORLD, flavor: 'dark' }))).not.toBe(
      '#ffffff',
    );
  });

  it('keeps the mask a thousandth short of opaque, or it cannot hide a label', () => {
    // MapLibre sends a fill to the opaque render pass only at exactly opacity 1, and symbols render
    // in the translucent pass afterwards with depth testing off — so an opaque mask draws *under*
    // the labels it exists to cover, however late it sits in the layer order. Every town in Québec
    // rendered straight through the first version of this.
    const masks = style.layers.filter((l) => l.id.startsWith('region-mask-'));
    expect(masks).toHaveLength(3);
    for (const layer of masks) {
      const opacity = (layer as unknown as { paint: Record<string, number> }).paint['fill-opacity'];
      expect(opacity).toBeLessThan(1);
      expect(opacity).toBeGreaterThan(0.99);
    }
  });

  it('draws the sea beneath the land, so land reads as land and not as water', () => {
    const at = (id: string) => ids().indexOf(id);
    expect(at('region-mask-sea')).toBeLessThan(at('region-mask-land'));
    expect(at('region-mask-land')).toBeLessThan(at('region-mask-water'));
  });

  it('admits our own border towns to the label filter and refuses the neighbours', () => {
    // The one assertion that catches a filter outline generated inside-out or too tight: it is a
    // real point-in-polygon test against the shipped geometry, not a shape check.
    // The flavour gives this layer its own filter, so ours is ANDed on the end rather than alone.
    const filter = (
      style.layers.find((l) => l.id === 'places_locality') as unknown as { filter: unknown[] }
    ).filter;
    const within = (filter[0] === 'all' ? filter.slice(1) : [filter]).find(
      (clause): clause is [string, GeoJSON.Polygon] =>
        Array.isArray(clause) && clause[0] === 'within',
    );
    expect(within, 'the town-label layer carries a within filter').toBeDefined();
    const outline = (within as [string, GeoJSON.Polygon])[1];
    const inside = (lng: number, lat: number) =>
      booleanPointInPolygon([lng, lat], outline as never);

    // Ours, including the ones close enough to the line to be lost by a filter that shrank.
    for (const [name, lng, lat] of [
      ['Manhattan', -73.97, 40.78],
      ['Burlington VT', -73.21, 44.48],
      ['Pittsfield MA', -73.25, 42.45],
      ['Port Jervis NY', -74.69, 41.37],
      ['Calais ME', -67.28, 45.19],
    ] as const) {
      expect(inside(lng, lat), name).toBe(true);
    }
    // Theirs — the labels in the screenshots that started all this.
    for (const [name, lng, lat] of [
      ['Jersey City NJ', -74.08, 40.73],
      ['Providence RI', -71.41, 41.82],
      ['Hartford CT', -72.68, 41.76],
      ['Trois-Rivieres QC', -72.55, 46.34],
      ['Scranton PA', -75.66, 41.41],
    ] as const) {
      expect(inside(lng, lat), name).toBe(false);
    }
  });

  it('never puts a `within` filter on a polygon-sourced label layer', () => {
    // `within` supports Point and LineString only; given a polygon it warns and evaluates false, so
    // the filter deletes the layer instead of filtering it. This shipped, and it took every lake
    // name off the map inside our own region — the one label class this app can least afford to
    // lose, since the basemap is the only thing that draws it (we label bays, not lakes).
    //
    // Asserted against the real flavour rather than a fixture, so a Protomaps change that moves a
    // label onto a polygon source fails here rather than on a device.
    const POLYGON_SOURCES = new Set(['water', 'earth', 'buildings', 'landuse']);
    const filtered = style.layers.filter((l) =>
      JSON.stringify((l as { filter?: unknown }).filter ?? null).includes('"within"'),
    );
    expect(filtered.length).toBeGreaterThan(0);
    for (const layer of filtered) {
      const source = (layer as { 'source-layer'?: string })['source-layer'];
      expect(POLYGON_SOURCES.has(source ?? ''), `${layer.id} reads ${source}`).toBe(false);
    }
    // And the lake names specifically are still drawn, unfiltered, below the mask.
    const lakes = style.layers.find((l) => l.id === 'water_label_lakes');
    expect(lakes, 'the basemap still labels lakes').toBeDefined();
    expect(JSON.stringify((lakes as { filter?: unknown }).filter ?? null)).not.toContain('within');
    expect(ids().indexOf('water_label_lakes')).toBeLessThan(ids().indexOf('region-mask-land'));
  });

  it('validates against the style spec — a bad filter blanks the whole map, not one layer', () => {
    // This test exists because a `["all", <legacy>, ["within", …]]` filter shipped once and MapLibre
    // rejected the entire style: no basemap, no water, nothing. A layer-level mistake is a layer
    // that looks wrong; a filter-level one is a black screen, so the composed style gets validated
    // rather than eyeballed.
    const errors = validateStyleMin(
      buildMapStyle({ regionUrl: REGION, worldUrl: WORLD, flavor: 'dark' }) as never,
    );
    expect(errors.map((e) => `${e.message}`)).toEqual([]);
  });

  it('renders without an overview archive rather than failing', () => {
    const alone = buildMapStyle({ regionUrl: REGION });
    expect(alone.sources.world).toBeUndefined();
    expect(alone.layers.length).toBeGreaterThan(0);
    // The mask still ships — it is local data, and hiding the bleed does not need the overview.
    expect(alone.layers.some((l) => l.id === 'region-mask-land')).toBe(true);
  });
});

describe('waterBodiesToFeatureCollection', () => {
  const bodies: MappableBody[] = [
    {
      _id: 'body_1',
      name: 'Lake Champlain',
      type: 'lake',
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [-73.3, 44.4],
            [-73.3, 44.5],
            [-73.2, 44.5],
            [-73.2, 44.4],
            [-73.3, 44.4],
          ],
        ],
      },
    },
  ];

  it('wraps each body as a Feature with a numeric id and metadata as properties', () => {
    const fc = waterBodiesToFeatureCollection(bodies);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(1);
    const feature = fc.features[0];
    expect(feature?.id).toBe(0);
    expect(feature?.geometry).toEqual(bodies[0]?.polygon);
    expect(feature?.properties).toEqual({ _id: 'body_1', name: 'Lake Champlain', type: 'lake' });
  });

  it('produces an empty collection for no bodies', () => {
    expect(waterBodiesToFeatureCollection([]).features).toHaveLength(0);
  });
});

describe('featureIdForBody', () => {
  const fc = waterBodiesToFeatureCollection([
    { _id: 'a', name: 'A', type: 'lake', polygon: { type: 'Point', coordinates: [0, 0] } },
    { _id: 'b', name: 'B', type: 'pond', polygon: { type: 'Point', coordinates: [1, 1] } },
  ]);

  it('maps a water-body _id back to its numeric feature id', () => {
    expect(featureIdForBody(fc, 'a')).toBe(0);
    expect(featureIdForBody(fc, 'b')).toBe(1);
  });

  it('returns undefined for a body not in the collection', () => {
    expect(featureIdForBody(fc, 'missing')).toBeUndefined();
  });
});

describe('favoriteFeatureIds', () => {
  const fc = waterBodiesToFeatureCollection([
    { _id: 'a', name: 'A', type: 'lake', polygon: { type: 'Point', coordinates: [0, 0] } },
    { _id: 'b', name: 'B', type: 'pond', polygon: { type: 'Point', coordinates: [1, 1] } },
    { _id: 'c', name: 'C', type: 'lake', polygon: { type: 'Point', coordinates: [2, 2] } },
  ]);

  it('returns the numeric feature ids of in-view favorited bodies', () => {
    expect(favoriteFeatureIds(fc, new Set(['a', 'c']))).toEqual([0, 2]);
  });

  it('ignores favorites not in the current collection', () => {
    expect(favoriteFeatureIds(fc, new Set(['z']))).toEqual([]);
  });

  it('is empty for no favorites', () => {
    expect(favoriteFeatureIds(fc, new Set())).toEqual([]);
  });
});

describe('putInsToFeatureCollection', () => {
  it('maps markers to points carrying their source', () => {
    const fc = putInsToFeatureCollection([
      { coord: { lat: 44, lng: -72 }, source: 'official' },
      { coord: { lat: 45, lng: -73 }, source: 'derived' },
    ]);
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]?.geometry).toEqual({ type: 'Point', coordinates: [-72, 44] });
    expect(fc.features[0]?.properties?.source).toBe('official');
    expect(fc.features[1]?.properties?.source).toBe('derived');
  });

  it('is empty for no markers', () => {
    expect(putInsToFeatureCollection([]).features).toHaveLength(0);
  });
});

describe('zoomForViewport', () => {
  it('floors the fractional map zoom to the integer bucket', () => {
    expect(zoomForViewport(8.9)).toBe(8);
    expect(zoomForViewport(12)).toBe(12);
  });
});

describe('frameForCoord', () => {
  it('frames on a fix inside the pilot region', () => {
    const inVermont = { lat: 44.46, lng: -73.15 };
    expect(frameForCoord(inVermont)).toEqual({
      center: [-73.15, 44.46],
      zoom: GEOLOCATION_FRAME_ZOOM,
    });
  });

  it('returns null for a fix outside the region so the default framing stands', () => {
    expect(frameForCoord({ lat: 34.05, lng: -118.24 })).toBeNull(); // Los Angeles
  });

  it('includes the wider Northeast region (Phase 2.5) — fixes the old VT-only bounds excluded', () => {
    expect(frameForCoord({ lat: 43.66, lng: -70.25 })).not.toBeNull(); // Portland, ME (E of old bounds)
    expect(frameForCoord({ lat: 42.89, lng: -78.88 })).not.toBeNull(); // Buffalo, NY (W of old bounds)
  });

  it('honors custom bounds and zoom', () => {
    const bounds: [[number, number], [number, number]] = [
      [0, 0],
      [10, 10],
    ];
    expect(frameForCoord({ lat: 5, lng: 5 }, bounds, 9)).toEqual({ center: [5, 5], zoom: 9 });
    expect(frameForCoord({ lat: 5, lng: 5 }, bounds, 9)?.zoom).toBe(9);
  });

  it('treats the region edge as inside', () => {
    const [[minLng, minLat]] = NORTHEAST_REGION_BOUNDS;
    expect(frameForCoord({ lat: minLat, lng: minLng })).not.toBeNull();
  });
});

describe('boundsToViewport', () => {
  it('maps MapLibre bounds accessors to a { minLat, … } bbox', () => {
    const bounds = {
      getWest: () => -73.3,
      getSouth: () => 44.4,
      getEast: () => -73.1,
      getNorth: () => 44.6,
    };
    expect(boundsToViewport(bounds)).toEqual({
      minLng: -73.3,
      minLat: 44.4,
      maxLng: -73.1,
      maxLat: 44.6,
    });
  });
});

describe('subAreasToFeatureCollection', () => {
  const subAreas: MappableSubArea[] = [
    {
      _id: 'sa_1',
      waterBodyId: 'body_1',
      name: 'Malletts Bay',
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [-73.2, 44.2],
            [-73.0, 44.2],
            [-73.0, 44.4],
            [-73.2, 44.4],
            [-73.2, 44.2],
          ],
        ],
      },
      centroid: { lat: 44.3, lng: -73.1 },
    },
  ];

  it('emits an outline feature and a separate label point per bay', () => {
    const fc = subAreasToFeatureCollection(subAreas);
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]?.geometry.type).toBe('Polygon');
    expect(fc.features[0]?.properties?.label).toBeUndefined();
    // The label rides its own point rather than the polygon, because MapLibre would otherwise place
    // it at the pole of inaccessibility — which for a crescent bay can land past a headland. The
    // stored centroid is a guaranteed-on-water representative point (D48).
    expect(fc.features[1]?.geometry).toEqual({ type: 'Point', coordinates: [-73.1, 44.3] });
    expect(fc.features[1]?.properties?.label).toBe(true);
  });

  it('carries the parent id, so a tap resolves to the lake rather than the bay', () => {
    const fc = subAreasToFeatureCollection(subAreas);
    for (const feature of fc.features) {
      expect(feature.properties?.waterBodyId).toBe('body_1');
      expect(feature.properties?.name).toBe('Malletts Bay');
    }
  });

  it('is empty for no sub-areas — the case for all but a handful of lakes', () => {
    expect(subAreasToFeatureCollection([]).features).toEqual([]);
  });
});
