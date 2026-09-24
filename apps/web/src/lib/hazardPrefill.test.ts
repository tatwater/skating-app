import { describe, expect, it } from 'vitest';
import { setHazardPrefill, takeHazardPrefill } from './hazardPrefill';

describe('hazardPrefill', () => {
  it('is taken once: a form that mounts twice does not attach the photo twice', () => {
    const file = new File(['x'], 'ice.jpg', { type: 'image/jpeg' });
    setHazardPrefill({ coord: { lat: 43.64, lng: -72.13 }, files: [file] });
    expect(takeHazardPrefill()).toEqual({ coord: { lat: 43.64, lng: -72.13 }, files: [file] });
    expect(takeHazardPrefill()).toBeNull();
  });
});
