import { describe, expect, test } from 'vitest';
import {
  approachesToFeatureCollection,
  approachLinePaint,
  type MappableApproach,
} from './approachLayer';

const PATH = [
  { lat: 44.5, lng: -72.5 },
  { lat: 44.502, lng: -72.503 },
  { lat: 44.504, lng: -72.505 },
];

const approach = (over: Partial<MappableApproach> = {}): MappableApproach => ({
  id: 'putin-1',
  approachPath: PATH,
  approachMeters: 1_240,
  approachAscentM: 96,
  name: 'North launch',
  ...over,
});

describe('approachesToFeatureCollection', () => {
  test('draws the stored line, in GeoJSON lng/lat order', () => {
    const collection = approachesToFeatureCollection([approach()]);
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]?.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [-72.5, 44.5],
        [-72.503, 44.502],
        [-72.505, 44.504],
      ],
    });
  });

  test('carries the distance and climb so a tap can describe the walk', () => {
    const properties = approachesToFeatureCollection([approach()]).features[0]?.properties;
    expect(properties).toMatchObject({ putInId: 'putin-1', meters: 1_240, ascentM: 96 });
  });

  /**
   * The layer's whole rule. A straight-line approach stores no path (`putIns.approachPath` is
   * written only for a routed hike-in leg), and this must render as *nothing* rather than as a
   * segment between the lot and the launch: a crow-flies line is indistinguishable on a map from a
   * walked one, so drawing it would turn an honest floor into a route through the woods.
   */
  test('a launch with no stored line draws nothing, and never a straight segment', () => {
    const collection = approachesToFeatureCollection([
      approach({ approachPath: undefined, approachMeters: 900 }),
    ]);
    expect(collection.features).toHaveLength(0);
  });

  test('a one-point path is dropped rather than rendered as an invisible line', () => {
    const collection = approachesToFeatureCollection([
      approach({ approachPath: [{ lat: 44.5, lng: -72.5 }] }),
    ]);
    expect(collection.features).toHaveLength(0);
  });

  test('omits absent measurements rather than emitting an undefined property', () => {
    const properties = approachesToFeatureCollection([
      approach({ approachAscentM: undefined, name: undefined }),
    ]).features[0]?.properties;
    expect(properties).not.toHaveProperty('ascentM');
    expect(properties).not.toHaveProperty('name');
  });

  test('draws every launch that has a line and skips the ones that do not', () => {
    const collection = approachesToFeatureCollection([
      approach({ id: 'a' }),
      approach({ id: 'b', approachPath: undefined }),
      approach({ id: 'c' }),
    ]);
    expect(collection.features.map((f) => f.id)).toEqual(['a', 'c']);
  });
});

describe('approachLinePaint', () => {
  /**
   * Dashed is a claim about provenance: a solid line reads as surveyed infrastructure, and this is
   * an ORS route over OSM's trail data — accurate to that network's own quality and no better.
   */
  test('is dashed, so the line never reads as a surveyed road', () => {
    expect(approachLinePaint('#333')['line-dasharray']).toEqual([2, 2]);
  });

  test('takes its color from the app rather than hard-coding one', () => {
    expect(approachLinePaint('#ff0000')['line-color']).toBe('#ff0000');
  });
});
