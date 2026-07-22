import { describe, expect, it } from 'vitest';
import { photoUploadCoord } from './photo';

describe('photoUploadCoord (D42 client gate)', () => {
  const coord = { lat: 44.4, lng: -73.2 };

  it('passes the coord only when placeOnMap is opted in', () => {
    expect(photoUploadCoord(true, coord)).toEqual(coord);
  });

  it('drops the coord when not opted in', () => {
    expect(photoUploadCoord(false, coord)).toBeUndefined();
  });

  it('is undefined when there is no coord regardless of opt-in', () => {
    expect(photoUploadCoord(true, undefined)).toBeUndefined();
  });
});
