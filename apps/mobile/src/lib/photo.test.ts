import { describe, expect, it } from 'vitest';
import { exifCoord, exifTakenAt } from './photo';

describe('exifCoord', () => {
  it('returns undefined for missing/empty EXIF', () => {
    expect(exifCoord(null)).toBeUndefined();
    expect(exifCoord(undefined)).toBeUndefined();
    expect(exifCoord({})).toBeUndefined();
  });

  it('applies N/W refs to the magnitude (Vermont)', () => {
    expect(
      exifCoord({
        GPSLatitude: 44.46,
        GPSLatitudeRef: 'N',
        GPSLongitude: 73.15,
        GPSLongitudeRef: 'W',
      }),
    ).toEqual({ lat: 44.46, lng: -73.15 });
  });

  it('applies an S ref to a positive magnitude', () => {
    expect(
      exifCoord({
        GPSLatitude: 33.87,
        GPSLatitudeRef: 'S',
        GPSLongitude: 151.2,
        GPSLongitudeRef: 'E',
      }),
    ).toEqual({ lat: -33.87, lng: 151.2 });
  });

  it('parses numeric-string tags', () => {
    expect(
      exifCoord({
        GPSLatitude: '44.46',
        GPSLatitudeRef: 'N',
        GPSLongitude: '73.15',
        GPSLongitudeRef: 'W',
      }),
    ).toEqual({ lat: 44.46, lng: -73.15 });
  });

  it('trusts an already-signed decimal when no ref is present', () => {
    expect(exifCoord({ GPSLatitude: 44.46, GPSLongitude: -73.15 })).toEqual({
      lat: 44.46,
      lng: -73.15,
    });
  });

  it('rejects out-of-range and null-island coordinates', () => {
    expect(exifCoord({ GPSLatitude: 200, GPSLongitude: 10 })).toBeUndefined();
    expect(exifCoord({ GPSLatitude: 0, GPSLongitude: 0 })).toBeUndefined();
  });
});

describe('exifTakenAt (A10-7)', () => {
  it('reads the EXIF clock as local time, honoring an offset when the camera wrote one', () => {
    const local = new Date(2026, 0, 10, 14, 5, 30).getTime();
    expect(exifTakenAt({ DateTimeOriginal: '2026:01:10 14:05:30' })).toBe(local);
    expect(
      exifTakenAt({ DateTimeOriginal: '2026:01:10 14:05:30', OffsetTimeOriginal: '-05:00' }),
    ).toBe(Date.UTC(2026, 0, 10, 19, 5, 30));
    expect(exifTakenAt({ DateTime: '2026:01:10 14:05:30' })).toBe(local);
  });
  it('is undefined for no EXIF, no date, or a date it cannot read', () => {
    expect(exifTakenAt(undefined)).toBeUndefined();
    expect(exifTakenAt({})).toBeUndefined();
    expect(exifTakenAt({ DateTimeOriginal: 'yesterday' })).toBeUndefined();
    expect(exifTakenAt({ DateTimeOriginal: 42 })).toBeUndefined();
  });
});
