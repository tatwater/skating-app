import { describe, expect, it } from 'vitest';
import type { BBox } from './geometry';
import { isInRegion, isRegionOffscreen, REGION_BOUNDS, REGION_BOUNDS_CORNERS } from './mapRegion';

const view = (minLng: number, minLat: number, maxLng: number, maxLat: number): BBox => ({
  minLng,
  minLat,
  maxLng,
  maxLat,
});

describe('REGION_BOUNDS', () => {
  it('reaches south past New York City, which the map now renders in full', () => {
    expect(isInRegion({ lat: 40.71, lng: -74.01 })).toBe(true);
  });

  it('covers the corners of the five states', () => {
    for (const [name, coord] of [
      ['Burlington VT', { lat: 44.48, lng: -73.21 }],
      ['Fort Kent ME', { lat: 47.25, lng: -68.59 }],
      ['Nantucket MA', { lat: 41.28, lng: -70.1 }],
      ['Jamestown NY', { lat: 42.1, lng: -79.24 }],
      ['Berlin NH', { lat: 44.47, lng: -71.19 }],
    ] as const) {
      expect(isInRegion(coord), name).toBe(true);
    }
  });

  it('does not claim places we have nothing to say about', () => {
    expect(isInRegion({ lat: 37.77, lng: -122.42 })).toBe(false); // San Francisco
    expect(isInRegion({ lat: 39.95, lng: -75.17 })).toBe(false); // Philadelphia
  });

  it('exposes the same box as a corner pair for MapLibre cameras', () => {
    expect(REGION_BOUNDS_CORNERS).toEqual([
      [REGION_BOUNDS.minLng, REGION_BOUNDS.minLat],
      [REGION_BOUNDS.maxLng, REGION_BOUNDS.maxLat],
    ]);
  });
});

describe('isRegionOffscreen', () => {
  it('stays quiet while any sliver of the region is on screen', () => {
    expect(isRegionOffscreen(view(-74, 44, -72, 45))).toBe(false); // over Vermont
    // Panned west until only New York's western edge is still in shot.
    expect(isRegionOffscreen(view(-85, 42, -79.5, 44))).toBe(false);
  });

  it('stays quiet at world zoom, where the region is small but visible', () => {
    expect(isRegionOffscreen(view(-180, -85, 180, 85))).toBe(false);
  });

  it('speaks up once the region has left the screen entirely', () => {
    expect(isRegionOffscreen(view(-125, 32, -115, 42))).toBe(true); // California
    expect(isRegionOffscreen(view(2, 48, 3, 49))).toBe(true); // Paris
    expect(isRegionOffscreen(view(-78, 30, -70, 39))).toBe(true); // south of the region
  });

  it('treats a viewport that merely touches the region as still visible', () => {
    expect(isRegionOffscreen(view(REGION_BOUNDS.maxLng, 44, -60, 45))).toBe(false);
  });
});
