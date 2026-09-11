import { describe, expect, it } from 'vitest';
import { resolveWeatherSubArea, subAreaWeatherPoint, weatherScopeLabel } from './weatherScope';

const bay = (id: string, name: string, displayScore: number, removed = false) => ({
  _id: id,
  name,
  displayScore,
  removed,
});

describe('resolveWeatherSubArea', () => {
  it('is null for a body with no bays — the body is its own place', () => {
    expect(resolveWeatherSubArea(undefined, undefined)).toBeNull();
    expect(resolveWeatherSubArea([], undefined)).toBeNull();
    expect(resolveWeatherSubArea([bay('a', 'Gone', 9, true)], undefined)).toBeNull();
  });

  it('pre-selects the most prominent bay when nothing is focused', () => {
    const bays = [
      bay('broad', 'Broad Lake', 4),
      bay('malletts', 'Malletts Bay', 7),
      bay('s', 'Shelburne Bay', 5),
    ];
    expect(resolveWeatherSubArea(bays, undefined)?._id).toBe('malletts');
  });

  it('honours an explicit focus over prominence', () => {
    const bays = [bay('malletts', 'Malletts Bay', 7), bay('button', 'Button Bay', 2)];
    expect(resolveWeatherSubArea(bays, 'button')?._id).toBe('button');
  });

  it('falls back to prominence when the focus names a delisted or foreign bay', () => {
    const bays = [bay('malletts', 'Malletts Bay', 7), bay('old', 'Old Cove', 9, true)];
    // A `?sub=` pointing at a bay delisted since the link was made must not pick it, and must not
    // pick nothing either — the panel still has a place to be about.
    expect(resolveWeatherSubArea(bays, 'old')?._id).toBe('malletts');
    expect(resolveWeatherSubArea(bays, 'not-here')?._id).toBe('malletts');
  });

  it('breaks a tie by name so two renders cannot disagree', () => {
    const bays = [bay('z', 'Zeta Bay', 5), bay('a', 'Alpha Bay', 5)];
    expect(resolveWeatherSubArea(bays, undefined)?._id).toBe('a');
    expect(resolveWeatherSubArea([...bays].reverse(), undefined)?._id).toBe('a');
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

describe('weatherScopeLabel', () => {
  it('names the place', () => {
    expect(weatherScopeLabel('Malletts Bay')).toBe('Weather at Malletts Bay');
  });
});
