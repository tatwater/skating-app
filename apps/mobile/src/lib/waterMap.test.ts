import { describe, expect, it } from 'vitest';
import {
  boundsToViewport,
  buildMapStyle,
  DEMO_PMTILES_URL,
  frameForCoord,
  MAP_FLAVORS,
  type MappableSubArea,
  OSM_ATTRIBUTION,
  putInsToFeatureCollection,
  subAreasToFeatureCollection,
  waterBodiesToFeatureCollection,
  zoomForViewport,
} from './waterMap';

describe('putInsToFeatureCollection', () => {
  it('maps markers to points carrying their source', () => {
    const fc = putInsToFeatureCollection([
      { coord: { lat: 44, lng: -72 }, source: 'official' },
      { coord: { lat: 45, lng: -73 }, source: 'derived' },
    ]);
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]?.geometry).toEqual({ type: 'Point', coordinates: [-72, 44] });
    expect(fc.features[0]?.properties?.source).toBe('official');
  });

  it('is empty for no markers', () => {
    expect(putInsToFeatureCollection([]).features).toHaveLength(0);
  });
});

describe('buildMapStyle', () => {
  it('wires the Protomaps pmtiles source with the ODbL attribution and themed layers', () => {
    const style = buildMapStyle(DEMO_PMTILES_URL, MAP_FLAVORS.light);
    expect(style.version).toBe(8);
    // Native MapLibre reads pmtiles directly via the pmtiles:// scheme (no JS protocol).
    const source = style.sources.protomaps as { url: string; attribution: string };
    expect(source.url).toBe(`pmtiles://${DEMO_PMTILES_URL}`);
    expect(source.attribution).toBe(OSM_ATTRIBUTION);
    expect(style.layers.length).toBeGreaterThan(0);
  });

  it('selects the dark sprite for the dark flavor', () => {
    expect(buildMapStyle(DEMO_PMTILES_URL, MAP_FLAVORS.dark).sprite).toMatch(/\/dark$/);
    expect(buildMapStyle(DEMO_PMTILES_URL, MAP_FLAVORS.light).sprite).toMatch(/\/light$/);
  });
});

describe('waterBodiesToFeatureCollection', () => {
  it('carries _id/name/type as properties for tap + highlight-filter lookup', () => {
    const fc = waterBodiesToFeatureCollection([
      {
        _id: 'wb1',
        name: 'Lake Morey',
        type: 'lake',
        polygon: { type: 'Point', coordinates: [-72.1, 43.9] },
      },
    ]);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0]?.properties).toEqual({ _id: 'wb1', name: 'Lake Morey', type: 'lake' });
  });

  it('is empty for no bodies', () => {
    expect(waterBodiesToFeatureCollection([]).features).toEqual([]);
  });
});

describe('boundsToViewport', () => {
  it('maps [west, south, east, north] to the bbox query arg', () => {
    expect(boundsToViewport([-73.3, 44.4, -73.0, 44.6])).toEqual({
      minLng: -73.3,
      minLat: 44.4,
      maxLng: -73.0,
      maxLat: 44.6,
    });
  });
});

describe('zoomForViewport', () => {
  it('floors fractional zoom so a body surfaces the moment its bucket is reached', () => {
    expect(zoomForViewport(8.9)).toBe(8);
    expect(zoomForViewport(12)).toBe(12);
  });
});

describe('frameForCoord', () => {
  it('frames a fix inside the pilot region', () => {
    const frame = frameForCoord({ lat: 44.46, lng: -73.15 });
    expect(frame).not.toBeNull();
    expect(frame?.center).toEqual([-73.15, 44.46]);
  });

  it('returns null for a fix outside the region (keep the default framing)', () => {
    expect(frameForCoord({ lat: 37.77, lng: -122.42 })).toBeNull();
  });

  it('includes the wider Northeast region (Phase 2.5) that the old VT-only bounds excluded', () => {
    expect(frameForCoord({ lat: 43.66, lng: -70.25 })).not.toBeNull(); // Portland, ME
    expect(frameForCoord({ lat: 42.89, lng: -78.88 })).not.toBeNull(); // Buffalo, NY
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
