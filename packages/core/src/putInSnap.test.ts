import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { haversineMeters } from './geometry';
import { PUT_IN_SNAP_METERS, putInsByDistance, snapPutIn } from './putInSnap';

const ramp = { id: 'ramp', coord: { lat: 44.0, lng: -72.0 } };
// ~110 m north of the ramp; ~1.1 km north of it.
const near = { id: 'near', coord: { lat: 44.001, lng: -72.0 } };
const far = { id: 'far', coord: { lat: 44.01, lng: -72.0 } };

describe('snapPutIn (D198)', () => {
  it('snaps inside the radius to the nearest, and asks (null) outside it', () => {
    const start = { lat: 44.0002, lng: -72.0 }; // ~22 m from the ramp
    expect(snapPutIn([far, near, ramp], start)?.id).toBe('ramp');
    expect(snapPutIn([far], start)).toBeNull();
    expect(snapPutIn([], start)).toBeNull();
    // Exactly the radius is inside; a meter past it is not.
    const atRadius = { id: 'edge', coord: { lat: 44.0, lng: -72.0 } };
    const m = haversineMeters(start, atRadius.coord);
    expect(snapPutIn([atRadius], start, m)).not.toBeNull();
    expect(snapPutIn([atRadius], start, m - 1)).toBeNull();
    expect(PUT_IN_SNAP_METERS).toBe(150);
  });

  it('orders by distance, ascending, carrying the meters', () => {
    const start = { lat: 44.0, lng: -72.0 };
    const ordered = putInsByDistance([far, near, ramp], start);
    expect(ordered.map((p) => p.id)).toEqual(['ramp', 'near', 'far']);
    expect(ordered[0]?.meters).toBe(0);
    expect(ordered[1]?.meters).toBeGreaterThan(100);
  });

  it('never snaps to a put-in farther than the radius (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1 }),
            coord: fc.record({
              lat: fc.double({ min: 43, max: 45, noNaN: true }),
              lng: fc.double({ min: -73, max: -71, noNaN: true }),
            }),
          }),
          { maxLength: 8 },
        ),
        fc.record({
          lat: fc.double({ min: 43, max: 45, noNaN: true }),
          lng: fc.double({ min: -73, max: -71, noNaN: true }),
        }),
        (putIns, start) => {
          const hit = snapPutIn(putIns, start);
          if (hit === null) {
            for (const p of putIns)
              expect(haversineMeters(start, p.coord)).toBeGreaterThan(PUT_IN_SNAP_METERS);
          } else {
            expect(hit.meters).toBeLessThanOrEqual(PUT_IN_SNAP_METERS);
            for (const p of putIns)
              expect(haversineMeters(start, p.coord)).toBeGreaterThanOrEqual(hit.meters);
          }
        },
      ),
    );
  });
});
