import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  EMPTY,
  instrumentKeyKinds,
  instrumentMarks,
  lakeBounds,
  lakeFeatures,
  pointedPinId,
  trackFeatures,
} from './instrumentFeatures';

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

  const FULL = {
    polygon: LAKE,
    pins: [
      { id: 'p1', coord: { lat: 43.6, lng: -72.15 }, name: 'Launch', kind: 'putIn' as const },
      { id: 'l1', coord: { lat: 43.61, lng: -72.16 }, name: 'Lot', kind: 'parking' as const },
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
      {
        id: 'h3',
        bbox: { minLat: 43.6, maxLat: 43.6, minLng: -72.2, maxLng: -72.2 },
        passage: false,
        healing: true,
      },
    ],
    photos: [{ id: 'ph', coord: { lat: 43.65, lng: -72.15 } }],
    point: { lat: 43.63, lng: -72.14 },
  };

  it('marks the launches (the chosen lit), the hazards by tone, the placed photos', () => {
    const marks = instrumentMarks(FULL);
    expect(marks.map((m) => [m.id, m.kind, 'tone' in m ? m.tone : null, m.chosen])).toEqual([
      ['p1', 'putIn', null, true],
      ['l1', 'parking', null, false],
      ['h1', 'hazard', 'danger', false],
      ['h2', 'hazard', 'passage', false],
      ['h3', 'hazard', 'healing', false],
      ['ph', 'photo', null, false],
    ]);
    // A hazard stands at its footprint's center.
    expect(marks[2]?.coord).toEqual({ lat: 43.61, lng: -72.19 });
  });

  it('draws a hand-set point only when no launch is chosen', () => {
    const marks = instrumentMarks({ pins: [], hazards: [], photos: [], point: FULL.point });
    expect(marks.map((m) => [m.kind, m.chosen])).toEqual([['point', true]]);
  });

  it('points only at a launch, a lot or the shore point it is drawing', () => {
    const marks = instrumentMarks(FULL);
    expect(pointedPinId(marks, 'p1')).toBe('p1');
    expect(pointedPinId(marks, 'l1')).toBe('l1');
    // A hazard or a photo is not a pin a chip names; nor is a pin this lake doesn't draw.
    expect(pointedPinId(marks, 'h1')).toBeNull();
    expect(pointedPinId(marks, 'ph')).toBeNull();
    expect(pointedPinId(marks, 'elsewhere')).toBeNull();
    expect(pointedPinId(marks, null)).toBeNull();
    expect(pointedPinId(marks, undefined)).toBeNull();
    const shore = instrumentMarks({ pins: [], hazards: [], photos: [], point: FULL.point });
    expect(pointedPinId(shore, 'point')).toBe('point');
  });

  it('keys only the kinds it draws', () => {
    expect(instrumentKeyKinds({ polygon: null, pins: [], hazards: [], photos: [] })).toEqual([]);
    expect(instrumentKeyKinds({ ...FULL, track: [[-72.1, 43.6]] })).toEqual([
      'putIn',
      'lot',
      'hazard',
      'passage',
      'healing',
      'photo',
    ]);
    // The point is a put-in somewhere else; a track of two points is drawn, so keyed.
    expect(
      instrumentKeyKinds({
        polygon: null,
        pins: [],
        hazards: [],
        photos: [],
        point: FULL.point,
        track: [
          [-72.1, 43.6],
          [-72.2, 43.7],
        ],
      }),
    ).toEqual(['putIn', 'yourTrack']);
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
