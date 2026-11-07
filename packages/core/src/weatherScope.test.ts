import { describe, expect, it } from 'vitest';
import { resolveWeatherSubArea, subAreaWeatherPoint } from './weatherScope';

const bay = (id: string, name: string, displayScore: number, removed = false) => ({
  _id: id,
  name,
  displayScore,
  removed,
});

describe('resolveWeatherSubArea', () => {
  it('is null for a body with no bays — the body is its own place', () => {
    expect(resolveWeatherSubArea(undefined, undefined)).toBeNull();
    expect(resolveWeatherSubArea(undefined, 'a')).toBeNull();
    expect(resolveWeatherSubArea([], 'a')).toBeNull();
    expect(resolveWeatherSubArea([bay('a', 'Gone', 9, true)], undefined)).toBeNull();
  });

  it('opens on the whole lake when nothing is focused, however prominent a bay is', () => {
    const bays = [
      bay('broad', 'Broad Lake', 4),
      bay('malletts', 'Malletts Bay', 7),
      bay('s', 'Shelburne Bay', 5),
    ];
    expect(resolveWeatherSubArea(bays, undefined)).toBeNull();
    expect(resolveWeatherSubArea(bays, '')).toBeNull();
  });

  it('honors an explicit focus on a live bay', () => {
    const bays = [bay('malletts', 'Malletts Bay', 7), bay('button', 'Button Bay', 2)];
    expect(resolveWeatherSubArea(bays, 'button')?._id).toBe('button');
  });

  it('falls back to the whole lake when the focus names a delisted or foreign bay', () => {
    const bays = [bay('malletts', 'Malletts Bay', 7), bay('old', 'Old Cove', 9, true)];
    // A `?sub=` pointing at a bay delisted since the link was made must not pick it — and the lake
    // itself is still a place to be about.
    expect(resolveWeatherSubArea(bays, 'old')).toBeNull();
    expect(resolveWeatherSubArea(bays, 'not-here')).toBeNull();
  });
});

describe('subAreaWeatherPoint', () => {
  it('prefers the representative point and falls back to the deprecated centroid', () => {
    const rp = { lat: 44.6, lng: -73.2 };
    const c = { lat: 44.5, lng: -73.3 };
    expect(subAreaWeatherPoint({ representativePoint: rp, centroid: c })).toEqual(rp);
    expect(subAreaWeatherPoint({ centroid: c })).toEqual(c);
  });
});
