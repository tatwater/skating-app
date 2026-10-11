import { describe, expect, it } from 'vitest';
import { googleMapsUrl } from './googleMaps';

describe('googleMapsUrl', () => {
  it('pins the coordinate with the documented Maps URL form, and nothing else', () => {
    expect(googleMapsUrl({ lat: 44.5123456789, lng: -73.3 })).toBe(
      'https://www.google.com/maps/search/?api=1&query=44.512346%2C-73.300000',
    );
  });
});
