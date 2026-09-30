import type { Feature, Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  dedupeOsmById,
  GNIS_LANDMARK_CLASSES,
  isNumberedSite,
  osmLandmarkKind,
  parseGnisLandmark,
  parseOsmLandmark,
} from './landmarkSource';

function feature(
  tags: Record<string, unknown>,
  geometry: Geometry,
  id = 1,
  type = 'node',
): Feature {
  return { type: 'Feature', properties: { '@type': type, '@id': id, ...tags }, geometry };
}

const POINT: Geometry = { type: 'Point', coordinates: [-73.25, 44.5] };
const SQUARE: Geometry = {
  type: 'Polygon',
  coordinates: [
    [
      [-73.26, 44.49],
      [-73.24, 44.49],
      [-73.24, 44.51],
      [-73.26, 44.51],
      [-73.26, 44.49],
    ],
  ],
};
const LINE: Geometry = {
  type: 'LineString',
  coordinates: [
    [-73.3, 44.5],
    [-73.25, 44.5],
    [-73.2, 44.5],
  ],
};

describe('osmLandmarkKind', () => {
  it.each([
    [{ place: 'island' }, 'Point', 'island'],
    [{ place: 'islet' }, 'Polygon', 'island'],
    [{ natural: 'cape' }, 'Point', 'point'],
    [{ natural: 'peninsula' }, 'Polygon', 'point'],
    [{ natural: 'bay' }, 'Point', 'bay'],
    [{ natural: 'strait' }, 'LineString', 'narrows'],
    [{ waterway: 'dam' }, 'LineString', 'dam'],
    [{ waterway: 'river' }, 'LineString', 'waterway'],
    [{ waterway: 'stream' }, 'MultiLineString', 'waterway'],
    [{ man_made: 'lighthouse' }, 'Point', 'lighthouse'],
    [{ man_made: 'bridge' }, 'Polygon', 'bridge'],
    [
      { highway: 'primary', bridge: 'yes', 'bridge:name': 'Sand Bar Bridge' },
      'LineString',
      'bridge',
    ],
    [{ leisure: 'marina' }, 'Polygon', 'marina'],
    [{ natural: 'beach' }, 'Polygon', 'beach'],
    [{ place: 'village' }, 'Point', 'settlement'],
    [{ natural: 'rock' }, 'Point', 'other'],
  ] as const)('%o as a %s is a %s', (tags, geometry, kind) => {
    expect(osmLandmarkKind(tags, geometry)?.kind).toBe(kind);
  });

  it('keeps a bay polygon, a town boundary and a river point out — those are other things', () => {
    expect(osmLandmarkKind({ natural: 'bay' }, 'Polygon')).toBeNull();
    expect(osmLandmarkKind({ place: 'town' }, 'MultiPolygon')).toBeNull();
    expect(osmLandmarkKind({ waterway: 'river' }, 'Point')).toBeNull();
    expect(osmLandmarkKind({ highway: 'primary' }, 'LineString')).toBeNull();
  });

  it('sorts establishments into the two classes the standalone rule treats differently', () => {
    expect(osmLandmarkKind({ tourism: 'hotel' }, 'Point')).toEqual({
      kind: 'establishment',
      establishment: 'lodging',
    });
    expect(osmLandmarkKind({ leisure: 'summer_camp' }, 'Polygon')?.establishment).toBe('lodging');
    expect(osmLandmarkKind({ amenity: 'restaurant' }, 'Point')?.establishment).toBe('food');
    expect(osmLandmarkKind({ shop: 'general' }, 'Point')?.establishment).toBe('food');
  });

  it('takes the first kind when a feature carries two', () => {
    expect(osmLandmarkKind({ place: 'island', tourism: 'hotel' }, 'Polygon')?.kind).toBe('island');
    expect(osmLandmarkKind({ leisure: 'marina', amenity: 'restaurant' }, 'Point')?.kind).toBe(
      'marina',
    );
  });
});

describe('parseOsmLandmark', () => {
  it('reads a node', () => {
    expect(
      parseOsmLandmark(feature({ natural: 'cape', name: ' Shelburne Point ' }, POINT, 7)),
    ).toEqual({
      sourceId: 'osm:node/7',
      source: 'osm',
      name: 'Shelburne Point',
      kind: 'point',
      point: { lat: 44.5, lng: -73.25 },
    });
  });

  it('reads a polygon with an interior label point, an area and an outline', () => {
    const c = parseOsmLandmark(
      feature({ place: 'island', name: 'Apple Island' }, SQUARE, 3, 'way'),
    );
    expect(c?.sourceId).toBe('osm:way/3');
    expect(c?.areaSqM).toBeGreaterThan(1_000_000);
    expect(c?.line).toHaveLength(5);
    expect(c?.point.lat).toBeGreaterThan(44.49);
  });

  it('reads a line with its vertices in order and a midpoint label', () => {
    const c = parseOsmLandmark(
      feature({ waterway: 'river', name: 'Lamoille River' }, LINE, 9, 'way'),
    );
    expect(c?.line?.map((p) => p.lng)).toEqual([-73.3, -73.25, -73.2]);
    expect(c?.point).toEqual({ lat: 44.5, lng: -73.25 });
    const multi = parseOsmLandmark(
      feature(
        { waterway: 'stream', name: 'Mill Brook' },
        {
          type: 'MultiLineString',
          coordinates: [
            [
              [-73.3, 44.5],
              [-73.2, 44.5],
            ],
          ],
        },
      ),
    );
    expect(multi?.line).toHaveLength(2);
  });

  it('names a bridge by its own name before the road’s', () => {
    const c = parseOsmLandmark(
      feature(
        { highway: 'primary', bridge: 'yes', name: 'US 2', 'bridge:name': 'Sand Bar Bridge' },
        LINE,
      ),
    );
    expect(c?.name).toBe('Sand Bar Bridge');
    expect(
      parseOsmLandmark(feature({ man_made: 'bridge', name: 'Rouses Point Bridge' }, SQUARE))?.name,
    ).toBe('Rouses Point Bridge');
  });

  it('refuses what is not a named landmark, or cannot be placed', () => {
    expect(parseOsmLandmark(feature({ place: 'island' }, POINT))).toBeNull();
    expect(parseOsmLandmark(feature({ place: 'island', name: '   ' }, POINT))).toBeNull();
    expect(parseOsmLandmark(feature({ place: 'island', name: 7 }, POINT))).toBeNull();
    expect(
      parseOsmLandmark(feature({ tourism: 'camp_site', name: 'Campsite #12' }, POINT)),
    ).toBeNull();
    expect(parseOsmLandmark(feature({ highway: 'primary', name: 'Main St' }, LINE))).toBeNull();
    expect(
      parseOsmLandmark({ type: 'Feature', properties: { name: 'x' }, geometry: POINT }),
    ).toBeNull();
    expect(
      parseOsmLandmark({
        type: 'Feature',
        properties: { '@type': 'node', '@id': 1, place: 'island', name: 'x' },
        geometry: null as unknown as Geometry,
      }),
    ).toBeNull();
    expect(
      parseOsmLandmark(
        feature({ place: 'island', name: 'Far' }, { type: 'Point', coordinates: [0, 95] }),
      ),
    ).toBeNull();
    expect(
      parseOsmLandmark(
        feature({ place: 'island', name: 'Many' }, {
          type: 'GeometryCollection',
          geometries: [],
        } as unknown as Geometry),
      ),
    ).toBeNull();
    expect(
      parseOsmLandmark(
        feature({ waterway: 'river', name: 'Empty' }, { type: 'LineString', coordinates: [] }),
      ),
    ).toBeNull();
    // A collapsed ring `representativePoint` cannot place a point on — skipped, not thrown.
    expect(
      parseOsmLandmark(
        feature({ place: 'island', name: 'Flat' }, { type: 'Polygon', coordinates: [[]] }),
      ),
    ).toBeNull();
  });

  it('reads a multipolygon’s outer rings as its outline', () => {
    const c = parseOsmLandmark(
      feature(
        { place: 'island', name: 'Twin Islands' },
        {
          type: 'MultiPolygon',
          coordinates: [(SQUARE as { coordinates: number[][][] }).coordinates],
        },
        4,
        'relation',
      ),
    );
    expect(c?.sourceId).toBe('osm:relation/4');
    expect(c?.line).toHaveLength(5);
  });
});

describe('isNumberedSite', () => {
  it.each([
    'Campsite #12',
    'Campsite 1',
    'camp site 4',
    'Site 9',
    '#7',
    '12',
    'Lean-to 3',
    'Site 4b',
  ])('%s is a number, not a name', (name) => expect(isNumberedSite(name)).toBe(true));
  it.each(['Camp Abnaki', 'Brown Ledge Camp', 'Site of the Old Mill', 'Route 7 Diner'])(
    '%s is a name',
    (name) => expect(isNumberedSite(name)).toBe(false),
  );
});

describe('dedupeOsmById', () => {
  it('keeps the area when osmium wrote a closed way twice, whichever came first', () => {
    const line = parseOsmLandmark(
      feature({ natural: 'beach', name: 'North Beach' }, LINE, 5, 'way'),
    );
    const area = parseOsmLandmark(
      feature({ natural: 'beach', name: 'North Beach' }, SQUARE, 5, 'way'),
    );
    expect(line && area).toBeTruthy();
    for (const order of [
      [line, area],
      [area, line],
    ]) {
      const kept = dedupeOsmById(order as NonNullable<typeof line>[]);
      expect(kept).toHaveLength(1);
      expect(kept[0]?.polygon).toBeDefined();
    }
  });
});

describe('parseGnisLandmark', () => {
  const columns = { id: 0, name: 1, class: 2, lat: 3, lng: 4 };

  it('reads the landmark classes and maps each to a kind', () => {
    expect(
      parseGnisLandmark(['1459987', 'Apple Island', 'Island', '44.47', '-73.26'], columns),
    ).toEqual({
      sourceId: 'gnis:1459987',
      source: 'gnis',
      name: 'Apple Island',
      kind: 'island',
      point: { lat: 44.47, lng: -73.26 },
    });
    expect(GNIS_LANDMARK_CLASSES.Harbor).toBe('bay');
    expect(GNIS_LANDMARK_CLASSES.Gut).toBe('narrows');
    expect(GNIS_LANDMARK_CLASSES['Populated Place']).toBe('settlement');
  });

  it('refuses other classes, blanks, null island and bad coordinates', () => {
    expect(
      parseGnisLandmark(['1', 'Mount Mansfield', 'Summit', '44.5', '-72.8'], columns),
    ).toBeNull();
    expect(parseGnisLandmark(['1', '', 'Island', '44.5', '-72.8'], columns)).toBeNull();
    expect(parseGnisLandmark(['', 'Apple Island', 'Island', '44.5', '-72.8'], columns)).toBeNull();
    expect(parseGnisLandmark(['1', 'Apple Island', 'Island', '0', '0'], columns)).toBeNull();
    expect(parseGnisLandmark(['1', 'Apple Island', 'Island', 'x', '-72.8'], columns)).toBeNull();
    expect(parseGnisLandmark(['1', 'Apple Island', 'Island', '95', '-72.8'], columns)).toBeNull();
    expect(parseGnisLandmark(['1', 'Apple Island'], { ...columns, id: undefined })).toBeNull();
    expect(parseGnisLandmark([], columns)).toBeNull();
  });
});
