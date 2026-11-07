import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { haversineMeters } from './geometry';
import { HAZARD_LANDMARK_RADIUS_M, hazardPlaceLine, nearestLandmarkWithin } from './landmarks';

describe('hazardPlaceLine (B03 §11)', () => {
  it('composes the bay and the landmark, either alone, or nothing', () => {
    expect(hazardPlaceLine({ subAreaName: 'The Narrows', landmarkName: 'Shaker Bridge' })).toBe(
      'The Narrows, by Shaker Bridge',
    );
    expect(hazardPlaceLine({ subAreaName: 'The Narrows' })).toBe('The Narrows');
    expect(hazardPlaceLine({ landmarkName: 'Shaker Bridge' })).toBe('By Shaker Bridge');
    expect(hazardPlaceLine({ subAreaName: '  ', landmarkName: '' })).toBeUndefined();
    expect(hazardPlaceLine({})).toBeUndefined();
  });

  it('a landmark that is the bay by name is said once', () => {
    expect(hazardPlaceLine({ subAreaName: 'The Narrows', landmarkName: 'the narrows' })).toBe(
      'The Narrows',
    );
  });
});

describe('nearestLandmarkWithin', () => {
  const at = { lat: 43.65, lng: -72.1 };

  it('picks the nearest inside the radius, and nothing past it', () => {
    const near = { name: 'near', point: { lat: 43.651, lng: -72.1 } };
    const nearer = { name: 'nearer', point: { lat: 43.6505, lng: -72.1 } };
    const far = { name: 'far', point: { lat: 43.7, lng: -72.1 } };
    expect(nearestLandmarkWithin(at, [near, far, nearer])?.name).toBe('nearer');
    expect(nearestLandmarkWithin(at, [far])).toBeUndefined();
    expect(nearestLandmarkWithin(at, [])).toBeUndefined();
  });

  it('whatever it picks is within the radius and no farther than any other candidate', () => {
    const coord = fc.record({
      lat: fc.double({ min: 43.6, max: 43.7, noNaN: true }),
      lng: fc.double({ min: -72.15, max: -72.05, noNaN: true }),
    });
    fc.assert(
      fc.property(fc.array(coord, { maxLength: 12 }), (points) => {
        const landmarks = points.map((point, i) => ({ name: String(i), point }));
        const pick = nearestLandmarkWithin(at, landmarks);
        const inRange = landmarks.filter(
          (l) => haversineMeters(at, l.point) <= HAZARD_LANDMARK_RADIUS_M,
        );
        if (inRange.length === 0) {
          expect(pick).toBeUndefined();
          return;
        }
        expect(pick).toBeDefined();
        const d = haversineMeters(at, pick?.point ?? at);
        for (const l of inRange) expect(d).toBeLessThanOrEqual(haversineMeters(at, l.point));
      }),
    );
  });
});
