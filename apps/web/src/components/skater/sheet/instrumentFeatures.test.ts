import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { EMPTY, lakeBounds, lakeFeatures, markFeatures, trackFeatures } from './instrumentFeatures';

const LAKE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72.2, 43.6],
      [-72.1, 43.6],
      [-72.1, 43.7],
      [-72.2, 43.6],
    ],
  ],
};

describe('the instrument’s drawing', () => {
  it('draws the one lake, or nothing', () => {
    expect(lakeFeatures(null)).toBe(EMPTY);
    expect(lakeFeatures(LAKE).features[0]?.geometry).toBe(LAKE);
  });

  it('frames the lake’s bounds, across a multipolygon too', () => {
    expect(lakeBounds(null)).toBeNull();
    expect(lakeBounds(LAKE)).toEqual([
      [-72.2, 43.6],
      [-72.1, 43.7],
    ]);
    expect(
      lakeBounds({ type: 'MultiPolygon', coordinates: [LAKE.coordinates, [[[-72.3, 43.5]]]] }),
    ).toEqual([
      [-72.3, 43.5],
      [-72.1, 43.7],
    ]);
    expect(lakeBounds({ type: 'Polygon', coordinates: [] })).toBeNull();
  });

  it('marks the launches (the chosen lit), the hazards, the placed photos and a hand-set point', () => {
    const marks = markFeatures({
      polygon: LAKE,
      pins: [
        { id: 'p1', coord: { lat: 43.6, lng: -72.15 }, name: 'Launch', kind: 'putIn' },
        { id: 'l1', coord: { lat: 43.61, lng: -72.16 }, name: 'Lot', kind: 'parking' },
      ],
      chosenPinId: 'p1',
      hazards: [
        {
          id: 'h1',
          bbox: { minLat: 43.6, maxLat: 43.62, minLng: -72.2, maxLng: -72.18 },
          passage: false,
        },
        {
          id: 'h2',
          bbox: { minLat: 43.6, maxLat: 43.6, minLng: -72.2, maxLng: -72.2 },
          passage: true,
        },
      ],
      photos: [{ id: 'ph', coord: { lat: 43.65, lng: -72.15 } }],
      point: { lat: 43.63, lng: -72.14 },
    });
    expect(marks.features.map((f) => [f.properties?.kind, f.properties?.chosen])).toEqual([
      ['putIn', true],
      ['parking', false],
      ['hazard', false],
      ['passage', false],
      ['photo', false],
    ]);
    expect(marks.features[2]?.geometry.coordinates).toEqual([-72.19, 43.61]);
  });

  it('draws a hand-set point only when no launch is chosen', () => {
    const marks = markFeatures({
      polygon: null,
      pins: [],
      hazards: [],
      photos: [],
      point: { lat: 43.63, lng: -72.14 },
    });
    expect(marks.features.map((f) => f.properties?.kind)).toEqual(['point']);
  });

  it('draws the track when it has a line to draw', () => {
    expect(trackFeatures(undefined).features).toEqual([]);
    expect(trackFeatures([[-72.1, 43.6]]).features).toEqual([]);
    expect(
      trackFeatures([
        [-72.1, 43.6],
        [-72.2, 43.7],
      ]).features[0]?.geometry.coordinates,
    ).toEqual([
      [-72.1, 43.6],
      [-72.2, 43.7],
    ]);
  });
});
