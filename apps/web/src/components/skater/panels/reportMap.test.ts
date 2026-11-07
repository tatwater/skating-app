import { describe, expect, it } from 'vitest';

import { photosOverlay, trackOverlay } from './reportMap';

const path: GeoJSON.LineString = {
  type: 'LineString',
  coordinates: [
    [-72.33, 43.65],
    [-72.32, 43.66],
  ],
};

describe('reportMap', () => {
  it('draws the path as one line, keyed by what it draws', () => {
    const overlay = trackOverlay('r1', { path });
    expect(overlay?.key).toBe('track:r1:2');
    expect(overlay?.data.features).toEqual([{ type: 'Feature', geometry: path, properties: {} }]);
    expect(trackOverlay('r1', null)).toBeNull();
    expect(trackOverlay('r1', undefined)).toBeNull();
  });

  it('pins only the placed photos, numbered by their place in the card', () => {
    const overlay = photosOverlay('r1', [
      { photoId: 'p1', coord: { lat: 43.65, lng: -72.33 } },
      { photoId: 'p2' },
      { photoId: 'p3', coord: { lat: 43.66, lng: -72.32 } },
    ]);
    expect(overlay?.key).toBe('photos:r1:p1,p3');
    expect(overlay?.data.features.map((f) => f.properties)).toEqual([
      { photoId: 'p1', n: 1 },
      { photoId: 'p3', n: 3 },
    ]);
    expect(overlay?.data.features[0]?.geometry).toEqual({
      type: 'Point',
      coordinates: [-72.33, 43.65],
    });
  });

  it('draws no pins when none is placed', () => {
    expect(photosOverlay('r1', [{ photoId: 'p1' }])).toBeNull();
    expect(photosOverlay('r1', undefined)).toBeNull();
  });
});
