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
  NORTHEAST_MAX_BOUNDS,
  OSM_ATTRIBUTION,
  putInsToFeatureCollection,
  subAreasToFeatureCollection,
  waterBodiesToFeatureCollection,
  zoomForViewport,
} from './waterMap';

describe('buildMapStyle', () => {
  const style = buildMapStyle('https://example.com/vt.pmtiles');

  it('is a v8 style with the Protomaps pmtiles source', () => {
    expect(style.version).toBe(8);
    const source = style.sources.protomaps;
    expect(source).toMatchObject({
      type: 'vector',
      url: 'pmtiles://https://example.com/vt.pmtiles',
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
    expect(buildMapStyle('https://example.com/vt.pmtiles', 'dark').sprite).toContain('/dark');
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
    const [[minLng, minLat]] = NORTHEAST_MAX_BOUNDS;
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
