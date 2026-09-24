import { describe, expect, it } from 'vitest';
import { setHazardPrefill, takeHazardPrefill } from './hazardPrefill';

describe('hazardPrefill', () => {
  it('is taken once: a capture asked twice does not attach the photo twice', () => {
    const photo = {
      id: 'h1',
      fullUri: 'file:///h1-full.jpg',
      thumbUri: 'file:///h1-thumb.jpg',
      placeOnMap: false,
    };
    setHazardPrefill({ coord: { lat: 43.64, lng: -72.13 }, photos: [photo], sourceIds: ['p1'] });
    expect(takeHazardPrefill()).toEqual({
      coord: { lat: 43.64, lng: -72.13 },
      photos: [photo],
      sourceIds: ['p1'],
    });
    expect(takeHazardPrefill()).toBeNull();
  });
});
