import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MASCOMA_BOUNDS } from '../frame/bodyFixtures';
import { fitCamera, stillSurface } from './mapSurface';

const PAD = { top: 30, right: 70, bottom: 90, left: 175 };

describe('stillSurface', () => {
  it('puts the camera’s center at the pane’s center', () => {
    const s = stillSurface(600, 400, { center: { lng: -72.15, lat: 43.62 }, zoom: 12 });
    const p = s.project([-72.15, 43.62]);
    expect(p.x).toBeCloseTo(300, 6);
    expect(p.y).toBeCloseTo(200, 6);
  });

  it('unprojects what it projects (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -170, max: 170, noNaN: true }),
        fc.double({ min: -80, max: 80, noNaN: true }),
        fc.double({ min: 0, max: 18, noNaN: true }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        (lng, lat, zoom, x, y) => {
          const s = stillSurface(1000, 1000, { center: { lng, lat }, zoom });
          const back = s.project([s.unproject({ x, y }).lng, s.unproject({ x, y }).lat]);
          expect(back.x).toBeCloseTo(x, 3);
          expect(back.y).toBeCloseTo(y, 3);
        },
      ),
    );
  });

  it('draws north up and east right', () => {
    const s = stillSurface(600, 400, { center: { lng: 0, lat: 0 }, zoom: 5 });
    expect(s.project([1, 0]).x).toBeGreaterThan(300);
    expect(s.project([0, 1]).y).toBeLessThan(200);
  });
});

describe('fitCamera', () => {
  it('frames the body inside the room the chrome leaves, touching it on one axis', () => {
    const camera = fitCamera(MASCOMA_BOUNDS, 656, 830, PAD);
    const s = stillSurface(656, 830, camera);
    const nw = s.project([MASCOMA_BOUNDS.minLng, MASCOMA_BOUNDS.maxLat]);
    const se = s.project([MASCOMA_BOUNDS.maxLng, MASCOMA_BOUNDS.minLat]);
    expect(nw.x).toBeGreaterThanOrEqual(PAD.left - 1e-6);
    expect(nw.y).toBeGreaterThanOrEqual(PAD.top - 1e-6);
    expect(se.x).toBeLessThanOrEqual(656 - PAD.right + 1e-6);
    expect(se.y).toBeLessThanOrEqual(830 - PAD.bottom + 1e-6);
    const touchesX = Math.abs(nw.x - PAD.left) < 1e-6 && Math.abs(se.x - (656 - PAD.right)) < 1e-6;
    const touchesY = Math.abs(nw.y - PAD.top) < 1e-6 && Math.abs(se.y - (830 - PAD.bottom)) < 1e-6;
    expect(touchesX || touchesY).toBe(true);
  });

  it('survives a degenerate box', () => {
    const camera = fitCamera({ minLng: 1, maxLng: 1, minLat: 2, maxLat: 2 }, 100, 100, PAD);
    expect(Number.isFinite(camera.zoom)).toBe(true);
  });
});
