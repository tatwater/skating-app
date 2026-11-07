import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bayLabelAngle,
  bountyCountsByBody,
  buildLakeLabels,
  hazardMarksFrom,
  hitProperty,
  isUnlistedWater,
  type LabelableBody,
  labelAnchor,
  labelCountIds,
  markObstacle,
  reportTimesByBody,
  withBayAngles,
} from './mapDerive';

const square = (lng: number, lat: number, d = 0.01): GeoJSON.Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [lng, lat],
      [lng + d, lat],
      [lng + d, lat + d],
      [lng, lat + d],
      [lng, lat],
    ],
  ],
});

const body = (over: Partial<LabelableBody> & { _id: string }): LabelableBody => ({
  name: over._id,
  centroid: { lat: 43, lng: -72 },
  ...over,
});

const now = Date.UTC(2027, 0, 16, 16);
const baseInputs = {
  favoriteIds: new Set<string>(),
  bountyCounts: new Map<string, number>(),
  reportTimes: new Map<string, number[]>(),
  dimmedIds: new Set<string>(),
  focusId: null,
  showFavorites: true,
  now,
};

describe('labelAnchor', () => {
  it('prefers the interior point, never the shoreline centroid', () => {
    const interior = { lat: 1, lng: 1 };
    const rep = { lat: 2, lng: 2 };
    expect(labelAnchor(body({ _id: 'a', interiorPoint: interior, representativePoint: rep }))).toBe(
      interior,
    );
    expect(labelAnchor(body({ _id: 'a', representativePoint: rep }))).toBe(rep);
    expect(labelAnchor(body({ _id: 'a' }))).toEqual({ lat: 43, lng: -72 });
  });
});

describe('bountyCountsByBody / reportTimesByBody', () => {
  it('counts each person’s ask as its own bounty', () => {
    const counts = bountyCountsByBody([
      { waterBodyId: 'a' },
      { waterBodyId: 'a' },
      { waterBodyId: 'b' },
    ]);
    expect([...counts]).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    expect(bountyCountsByBody(undefined).size).toBe(0);
  });

  it('groups report times by asked body, leaving out authors the viewer blocked', () => {
    const times = reportTimesByBody(
      [
        { waterBodyId: 'a', skateEndTime: 1 },
        { waterBodyId: 'a', skateEndTime: 2, blocked: true },
        { waterBodyId: 'b', skateEndTime: 3 },
        { waterBodyId: 'not-asked', skateEndTime: 4 },
      ],
      ['a', 'b', 'c'],
    );
    expect(times?.get('a')).toEqual([1]);
    expect(times?.get('b')).toEqual([3]);
    // Asked and answered with nothing: a real "none". Never asked: no entry, so no claim.
    expect(times?.get('c')).toEqual([]);
    expect(times?.has('not-asked')).toBe(false);
    expect(reportTimesByBody(undefined, ['a'])).toBeUndefined();
  });
});

describe('buildLakeLabels', () => {
  it('labels named, unfocused bodies with their slug, star, bounties and dim', () => {
    const labels = buildLakeLabels(
      [
        body({ _id: 'mascoma', name: 'Mascoma Lake', surfaceAreaSqM: 4.6e6 }),
        body({ _id: 'crystal', name: 'Crystal Lake' }),
        body({ _id: 'george', name: 'George Pond', dormant: { since: 1 } as never }),
        body({ _id: 'unnamed', name: '' }),
      ],
      {
        ...baseInputs,
        favoriteIds: new Set(['mascoma']),
        bountyCounts: new Map([['crystal', 3]]),
        reportTimes: new Map([
          ['mascoma', [now - 1000]],
          ['crystal', []],
        ]),
        dimmedIds: new Set(['crystal']),
        timeZone: 'America/New_York',
      },
    );
    expect(labels.map((l) => l.id)).toEqual(['mascoma', 'crystal', 'george']);
    expect(labels[0]).toMatchObject({ favorite: true, slug: '1 report · today', dim: false });
    expect(labels[1]).toMatchObject({ openBounties: 3, slug: 'No recent reports', dim: true });
    expect(labels[2]).toMatchObject({ inactive: true, slug: 'Inactive' });
  });

  it('gives the focused lake no label: it is the view', () => {
    const labels = buildLakeLabels([body({ _id: 'a' }), body({ _id: 'b' })], {
      ...baseInputs,
      focusId: 'a',
    });
    expect(labels.map((l) => l.id)).toEqual(['b']);
  });

  it('draws no star, and lifts no rank, with the favorites layer off', () => {
    const labels = buildLakeLabels([body({ _id: 'a' })], {
      ...baseInputs,
      favoriteIds: new Set(['a']),
      showFavorites: false,
    });
    expect(labels[0]?.favorite).toBe(false);
  });

  it('holds the slug back while the counts load, and for a body the read never asked about', () => {
    const loading = buildLakeLabels([body({ _id: 'a' })], {
      ...baseInputs,
      reportTimes: undefined,
    });
    expect(loading[0]?.slug).toBeNull();
    const unasked = buildLakeLabels([body({ _id: 'a' })], {
      ...baseInputs,
      reportTimes: new Map(),
    });
    expect(unasked[0]?.slug).toBeNull();
  });

  it('caps the set, best first, and orders ties by id', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 1, max: 30 }), (n, limit) => {
        const bodies = Array.from({ length: n }, (_, i) =>
          body({ _id: `b${String(i).padStart(2, '0')}` }),
        );
        const labels = buildLakeLabels(bodies, { ...baseInputs, limit });
        expect(labels.length).toBe(Math.min(n, limit));
        labels.slice(1).forEach((b, i) => {
          const a = labels[i] as (typeof labels)[number];
          expect(a.priority > b.priority || (a.priority === b.priority && a.id < b.id)).toBe(true);
        });
      }),
    );
  });
});

describe('labelCountIds', () => {
  it('is the labeled set, sorted, so the read’s key is stable', () => {
    const ids = labelCountIds(
      [body({ _id: 'z' }), body({ _id: 'a' }), body({ _id: 'm', name: '' })],
      {
        favoriteIds: new Set(),
        bountyCounts: new Map(),
        dimmedIds: new Set(),
        focusId: null,
        showFavorites: true,
      },
    );
    expect(ids).toEqual(['a', 'z']);
  });
});

describe('hazardMarksFrom', () => {
  it('puts one mark on each footprint, toned by kind', () => {
    const marks = hazardMarksFrom({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: square(-72, 43),
          properties: { hazardId: 'h1', hazardType: 'open_water', provisional: true },
        },
        {
          type: 'Feature',
          geometry: square(-72, 43),
          properties: { hazardId: 'h2', healing: true },
        },
        {
          type: 'Feature',
          geometry: square(-72, 43),
          properties: { hazardId: 'h3', passage: true },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: { hazardId: 'pt' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[]] },
          properties: { hazardId: 'broken' },
        },
      ],
    });
    expect(marks.map((m) => [m.id, m.tone, m.provisional, m.hazardType])).toEqual([
      ['h1', 'danger', true, 'open_water'],
      ['h2', 'healing', false, ''],
      ['h3', 'passage', false, ''],
    ]);
    expect(marks[0]?.lng).toBeGreaterThanOrEqual(-72);
    expect(marks[0]?.lng).toBeLessThanOrEqual(-71.99);
  });

  it('boxes a mark with its halo and brackets', () => {
    expect(markObstacle(100, 50)).toEqual({ left: 84, top: 34, right: 116, bottom: 66 });
  });
});

describe('bayLabelAngle', () => {
  const strip = (dx: number, dy: number): GeoJSON.Polygon => ({
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [dx, dy],
        [dx + dy * 0.05, dy - dx * 0.05],
        [dy * 0.05, -dx * 0.05],
        [0, 0],
      ],
    ],
  });

  it('runs along an east–west strip flat, and turns with a rising one', () => {
    expect(Math.abs(bayLabelAngle(strip(1, 0)))).toBeLessThan(5);
    // A strip rising to the north-east reads up and to the right: a negative (counterclockwise) angle.
    expect(bayLabelAngle(strip(1, 1))).toBeLessThan(-30);
    expect(bayLabelAngle(strip(1, -1))).toBeGreaterThan(30);
  });

  it('never turns a name upside down', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        (dx, dy) => {
          const a = bayLabelAngle(strip(dx, dy));
          expect(a).toBeGreaterThanOrEqual(-90);
          expect(a).toBeLessThanOrEqual(90);
        },
      ),
    );
  });

  it('is flat for a shape with no long axis, or no shape at all', () => {
    expect(bayLabelAngle({ type: 'Point', coordinates: [0, 0] })).toBe(0);
    expect(bayLabelAngle({ type: 'Polygon', coordinates: [[[0, 0]]] })).toBe(0);
    expect(
      bayLabelAngle({
        type: 'MultiPolygon',
        coordinates: [square(0, 0, 1).coordinates],
      }),
    ).toBe(0);
  });

  it('stamps each bay label point with its bay’s angle', () => {
    const fc2 = withBayAngles({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: strip(1, 1), properties: { _id: 's' } },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: { _id: 's', label: true },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: { _id: 'x', label: true },
        },
      ],
    });
    expect(fc2.features[1]?.properties?.angle).toBe(bayLabelAngle(strip(1, 1)));
    expect(fc2.features[2]?.properties?.angle).toBe(0);
    expect(fc2.features[0]?.properties?.angle).toBeUndefined();
  });
});

describe('clicks', () => {
  it('reads basemap water with none of ours over it as unlisted', () => {
    expect(isUnlistedWater([{ source: 'protomaps', sourceLayer: 'water' }])).toBe(true);
    expect(isUnlistedWater([{ source: 'world', layerId: 'water' }])).toBe(true);
    expect(isUnlistedWater([{ source: 'water' }, { sourceLayer: 'water' }])).toBe(false);
    expect(isUnlistedWater([{ source: 'protomaps', sourceLayer: 'roads' }])).toBe(false);
    expect(isUnlistedWater([])).toBe(false);
  });

  it('finds the first string property', () => {
    expect(hitProperty([{ properties: { _id: 3 } }, { properties: { _id: 'b' } }], '_id')).toBe(
      'b',
    );
    expect(hitProperty([{ properties: null }], '_id')).toBeUndefined();
  });
});
