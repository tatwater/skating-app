import { AMENITY_NEAR_PARKING_M, destinationPoint, PARKING_INFER_RADIUS_M } from '@skating/core';
import type { Geometry } from 'geojson';
import { describe, expect, test } from 'vitest';
import {
  type AccessFeature,
  accessFeaturePoint,
  type OsmAccessFeature,
  pairAccessFeatures,
  parseAccessFeature,
} from './accessTransform';

const LAKE = { lat: 44.5, lng: -72.5 };

function feature(props: Record<string, unknown>, geometry: Geometry): OsmAccessFeature {
  return { type: 'Feature', properties: props, geometry } as OsmAccessFeature;
}

function node(point: { lat: number; lng: number }): Geometry {
  return { type: 'Point', coordinates: [point.lng, point.lat] };
}

/** A small square lot around `point`, roughly 60 m on a side. */
function lotPolygon(point: { lat: number; lng: number }): Geometry {
  const d = 0.0003;
  return {
    type: 'Polygon',
    coordinates: [
      [
        [point.lng - d, point.lat - d],
        [point.lng + d, point.lat - d],
        [point.lng + d, point.lat + d],
        [point.lng - d, point.lat + d],
        [point.lng - d, point.lat - d],
      ],
    ],
  };
}

function access(over: Partial<AccessFeature> & Pick<AccessFeature, 'kind' | 'externalId' | 'point'>): AccessFeature {
  return { isSlipway: false, ...over };
}

describe('accessFeaturePoint', () => {
  /**
   * The failure this guards is silent: `osmium export` emits fewer features rather than erroring, so
   * a polygon-only parser reports success over an extract missing most of its slipways — many of
   * which are nodes.
   */
  test('handles nodes and polygons alike, which the water pass never had to', () => {
    expect(accessFeaturePoint(node(LAKE))).toEqual(LAKE);
    const fromPolygon = accessFeaturePoint(lotPolygon(LAKE));
    expect(fromPolygon?.lat).toBeCloseTo(LAKE.lat, 3);
    expect(fromPolygon?.lng).toBeCloseTo(LAKE.lng, 3);
  });

  /**
   * Raw OSM, so a degenerate ring is a thing that arrives rather than a thing that shouldn't. One
   * malformed lot must cost that lot its row, never the pass its run.
   */
  test('a degenerate polygon is refused rather than thrown out of the pass', () => {
    expect(accessFeaturePoint({ type: 'Polygon', coordinates: [] } as Geometry)).toBeNull();
    expect(accessFeaturePoint({ type: 'Polygon', coordinates: [[]] } as Geometry)).toBeNull();
    expect(accessFeaturePoint({ type: 'MultiPolygon', coordinates: [] } as Geometry)).toBeNull();
  });

  test('refuses a line, null geometry, and a node with nonsense coordinates', () => {
    expect(accessFeaturePoint(null)).toBeNull();
    expect(
      accessFeaturePoint({ type: 'LineString', coordinates: [[0, 0], [1, 1]] } as Geometry),
    ).toBeNull();
    expect(
      accessFeaturePoint({ type: 'Point', coordinates: [Number.NaN, 44] } as Geometry),
    ).toBeNull();
  });
});

describe('parseAccessFeature', () => {
  test('a named slipway node becomes a put-in candidate flagged as a ramp', () => {
    const parsed = parseAccessFeature(
      feature(
        { '@type': 'node', '@id': 42, leisure: 'slipway', name: 'Lake Fairlee Boat Ramp' },
        node(LAKE),
      ),
    );
    expect(parsed).toEqual({
      kind: 'put_in',
      externalId: 'node/42',
      point: LAKE,
      name: 'Lake Fairlee Boat Ramp',
      isSlipway: true,
    });
  });

  test.each([
    ['natural', 'beach'],
    ['leisure', 'fishing'],
    ['man_made', 'pier'],
  ])('%s=%s is a put-in candidate but not a ramp', (key, value) => {
    const parsed = parseAccessFeature(
      feature({ '@type': 'way', '@id': 7, [key]: value }, lotPolygon(LAKE)),
    );
    expect(parsed?.kind).toBe('put_in');
    expect(parsed?.isSlipway).toBe(false);
  });

  test('a parking way becomes a lot, carrying capacity and fee', () => {
    const parsed = parseAccessFeature(
      feature(
        { '@type': 'way', '@id': '99', amenity: 'parking', capacity: '12', fee: 'yes' },
        lotPolygon(LAKE),
      ),
    );
    expect(parsed?.kind).toBe('parking');
    expect(parsed?.externalId).toBe('way/99');
    expect(parsed?.capacity).toBe(12);
    expect(parsed?.fee).toBe(true);
  });

  /**
   * A lot you may not use is not a worse access point — it is a driveway, and publishing it sends
   * somebody to one.
   */
  test.each(['private', 'no', 'customers', 'permit'])(
    'refuses a lot tagged access=%s outright',
    (value) => {
      expect(
        parseAccessFeature(
          feature({ '@type': 'way', '@id': 1, amenity: 'parking', access: value }, lotPolygon(LAKE)),
        ),
      ).toBeNull();
    },
  );

  test('access=yes and an untagged lot both survive', () => {
    expect(
      parseAccessFeature(
        feature({ '@type': 'way', '@id': 1, amenity: 'parking', access: 'yes' }, lotPolygon(LAKE)),
      )?.kind,
    ).toBe('parking');
    expect(
      parseAccessFeature(feature({ '@type': 'way', '@id': 2, amenity: 'parking' }, lotPolygon(LAKE)))
        ?.kind,
    ).toBe('parking');
  });

  /**
   * OSM's `fee` key takes values well beyond yes/no. Reading an unrecognised one as `false` would
   * publish "no fee" on a lot that charges.
   */
  test.each(['interval', 'donation', '5 USD', ''])(
    'fee=%s reads as unknown, never as free',
    (value) => {
      const parsed = parseAccessFeature(
        feature({ '@type': 'way', '@id': 3, amenity: 'parking', fee: value }, lotPolygon(LAKE)),
      );
      expect(parsed?.fee).toBeUndefined();
    },
  );

  test.each(['0', '-4', 'lots', ''])('capacity=%s is refused rather than guessed', (value) => {
    const parsed = parseAccessFeature(
      feature({ '@type': 'way', '@id': 4, amenity: 'parking', capacity: value }, lotPolygon(LAKE)),
    );
    expect(parsed?.capacity).toBeUndefined();
  });

  test('a toilet block parses as its own kind', () => {
    expect(
      parseAccessFeature(feature({ '@type': 'node', '@id': 5, amenity: 'toilets' }, node(LAKE)))
        ?.kind,
    ).toBe('toilets');
  });

  test('a blank name is dropped so the compass fallback can take over', () => {
    const parsed = parseAccessFeature(
      feature({ '@type': 'node', '@id': 6, leisure: 'slipway', name: '   ' }, node(LAKE)),
    );
    expect(parsed?.name).toBeUndefined();
  });

  test('refuses anything without a stable OSM identity, and anything that is not access', () => {
    expect(parseAccessFeature(feature({ leisure: 'slipway' }, node(LAKE)))).toBeNull();
    expect(parseAccessFeature(feature({ '@type': 'node', leisure: 'slipway' }, node(LAKE)))).toBeNull();
    expect(
      parseAccessFeature(feature({ '@type': 'node', '@id': 8, amenity: 'cafe' }, node(LAKE))),
    ).toBeNull();
  });
});

describe('pairAccessFeatures', () => {
  const launch = access({ kind: 'put_in', externalId: 'node/1', point: LAKE, isSlipway: true });

  test('a launch pairs with a lot inside the radius and not with one outside it', () => {
    const near = access({
      kind: 'parking',
      externalId: 'way/10',
      point: destinationPoint(LAKE, 0, PARKING_INFER_RADIUS_M - 20),
    });
    const far = access({
      kind: 'parking',
      externalId: 'way/11',
      point: destinationPoint(LAKE, 180, PARKING_INFER_RADIUS_M + 50),
    });

    const paired = pairAccessFeatures([launch, near, far]);
    expect(paired.putIns[0]?.parkingExternalId).toBe('way/10');
    expect(paired.stats.putInsWithParking).toBe(1);
    // The far lot is still emitted — a trailhead with no mapped slipway is the case this phase is for.
    expect(paired.parking.map((p) => p.externalId).sort()).toEqual(['way/10', 'way/11']);
    expect(paired.stats.parkingWithoutPutIn).toBe(1);
  });

  /**
   * Nearest-within, not every-within: a launch has one place you park for it, and three overlapping
   * claims would put three directions targets on one marker.
   */
  test('the nearest lot wins when several are in range', () => {
    const nearer = access({
      kind: 'parking',
      externalId: 'way/near',
      point: destinationPoint(LAKE, 0, 60),
    });
    const further = access({
      kind: 'parking',
      externalId: 'way/further',
      point: destinationPoint(LAKE, 0, 200),
    });
    expect(pairAccessFeatures([launch, further, nearer]).putIns[0]?.parkingExternalId).toBe(
      'way/near',
    );
  });

  test('a slipway promotes its lot to a boat ramp; a beach does not', () => {
    const lot = access({ kind: 'parking', externalId: 'way/20', point: destinationPoint(LAKE, 0, 80) });
    const beach = access({ kind: 'put_in', externalId: 'node/2', point: LAKE, isSlipway: false });

    expect(pairAccessFeatures([launch, lot]).parking[0]?.amenities).toEqual(['boat_ramp']);
    expect(pairAccessFeatures([beach, lot]).parking[0]?.amenities).toEqual([]);
  });

  test('a toilet block at the lot becomes an amenity; one across town does not', () => {
    const lot = access({ kind: 'parking', externalId: 'way/30', point: LAKE });
    const atLot = access({
      kind: 'toilets',
      externalId: 'node/3',
      point: destinationPoint(LAKE, 90, AMENITY_NEAR_PARKING_M - 30),
    });
    const acrossTown = access({
      kind: 'toilets',
      externalId: 'node/4',
      point: destinationPoint(LAKE, 90, AMENITY_NEAR_PARKING_M + 400),
    });

    const paired = pairAccessFeatures([lot, atLot, acrossTown]);
    expect(paired.parking[0]?.amenities).toEqual(['toilets']);
    expect(paired.stats.toiletsMatched).toBe(1);
    expect(paired.stats.toiletsOrphaned).toBe(1);
  });

  /** A diffable artifact is how the eyeballing pass B2 asks for actually gets done. */
  test('amenities are sorted, so the emitted records are byte-stable across runs', () => {
    const lot = access({ kind: 'parking', externalId: 'way/40', point: LAKE });
    const toilet = access({ kind: 'toilets', externalId: 'node/5', point: destinationPoint(LAKE, 0, 20) });
    const ramp = access({ kind: 'put_in', externalId: 'node/6', point: destinationPoint(LAKE, 0, 30), isSlipway: true });

    const forwards = pairAccessFeatures([lot, toilet, ramp]).parking[0]?.amenities;
    const backwards = pairAccessFeatures([ramp, toilet, lot]).parking[0]?.amenities;
    expect(forwards).toEqual(['boat_ramp', 'toilets']);
    expect(forwards).toEqual(backwards);
  });

  test('an unpaired launch is emitted with no parking rather than dropped', () => {
    const paired = pairAccessFeatures([launch]);
    expect(paired.putIns).toHaveLength(1);
    expect(paired.putIns[0]?.parkingExternalId).toBeUndefined();
    expect(paired.stats.putInsWithoutParking).toBe(1);
  });

  test('two launches may share one lot', () => {
    const lot = access({ kind: 'parking', externalId: 'way/50', point: LAKE });
    const a = access({ kind: 'put_in', externalId: 'node/7', point: destinationPoint(LAKE, 0, 50) });
    const b = access({ kind: 'put_in', externalId: 'node/8', point: destinationPoint(LAKE, 180, 60) });

    const paired = pairAccessFeatures([lot, a, b]);
    expect(paired.putIns.every((p) => p.parkingExternalId === 'way/50')).toBe(true);
    expect(paired.stats.parkingWithoutPutIn).toBe(0);
  });

  test('the radius is injectable, so one state can be eyeballed at a different setting', () => {
    const lot = access({ kind: 'parking', externalId: 'way/60', point: destinationPoint(LAKE, 0, 400) });
    expect(pairAccessFeatures([launch, lot]).putIns[0]?.parkingExternalId).toBeUndefined();
    expect(pairAccessFeatures([launch, lot], 500).putIns[0]?.parkingExternalId).toBe('way/60');
  });
});
