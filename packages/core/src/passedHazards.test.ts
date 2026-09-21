import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { destinationPoint, type LatLng } from './geometry';
import { hazardBbox, lineShape, pointRadiusShape } from './hazardGeometry';
import {
  PASSED_HAZARD_METERS,
  type PassableHazard,
  type PassedTrackPoint,
  passedHazards,
  pointInHazard,
} from './passedHazards';

const ORIGIN: LatLng = { lat: 44.5, lng: -73.2 };

function hazard(
  id: string,
  type: PassableHazard['type'],
  shape: PassableHazard['shape'],
): PassableHazard {
  return { id, type, shape, bbox: hazardBbox(shape) };
}

/** A straight track from `from`, along `bearing`, `meters` long, one point every `step` meters. */
function straightTrack(
  from: LatLng,
  bearing: number,
  meters: number,
  step = 25,
): PassedTrackPoint[] {
  const out: PassedTrackPoint[] = [];
  for (let d = 0, t = 0; d <= meters; d += step, t += 5_000) {
    out.push({ ...destinationPoint(from, bearing, d), timestamp: t });
  }
  return out;
}

// A hole 30 m across at 200 m east of the origin; a ridge running north–south 400 m east; a hole
// far off to the north-west that no track here goes near.
const hole = hazard('hole', 'drain_hole', pointRadiusShape(destinationPoint(ORIGIN, 90, 200), 15));
const ridge = hazard(
  'ridge',
  'pressure_ridge',
  lineShape(
    [
      destinationPoint(destinationPoint(ORIGIN, 90, 400), 0, 150),
      destinationPoint(destinationPoint(ORIGIN, 90, 400), 180, 150),
    ],
    5,
  ),
);
const farHole = hazard(
  'far',
  'open_water',
  pointRadiusShape(destinationPoint(ORIGIN, 315, 3000), 40),
);
const HAZARDS = [hole, ridge, farHole];

describe('passedHazards', () => {
  it('a track straight through the hole and across the ridge: entered, crossed, and nothing far away', () => {
    const track = straightTrack(ORIGIN, 90, 600);
    const result = passedHazards(track, HAZARDS);
    expect(result.map((r) => [r.hazardId, r.how])).toEqual([
      ['hole', 'entered'],
      ['ridge', 'crossed'],
    ]);
    expect(result[0]?.nearestMeters).toBe(0);
    // The ridge is crossed between two fixes; with a 5 m buffer the nearest fix is a few meters off.
    expect(result[1]?.nearestMeters).toBeLessThan(25);
  });

  it('a track that skirts the hole reports passed with the nearest point and its time', () => {
    // Parallel to the first track, 40 m north: the hole's edge is ~25 m away at closest approach.
    const start = destinationPoint(ORIGIN, 0, 40);
    const track = straightTrack(start, 90, 300, 10);
    const [result] = passedHazards(track, [hole]);
    expect(result?.how).toBe('passed');
    expect(result?.nearestMeters).toBeGreaterThan(20);
    expect(result?.nearestMeters).toBeLessThanOrEqual(PASSED_HAZARD_METERS);
    // Closest approach is abeam the hole, 200 m along at 10 m steps ⇒ the 21st point, t = 100 s.
    expect(result?.nearestAtMs).toBe(20 * 5_000);
  });

  it('a track well clear of everything returns nothing', () => {
    const track = straightTrack(destinationPoint(ORIGIN, 180, 500), 90, 600);
    expect(passedHazards(track, HAZARDS)).toEqual([]);
    expect(passedHazards([], HAZARDS)).toEqual([]);
  });

  it('crossing is decided on segments, so sparse fixes either side of a ridge still count', () => {
    // Two fixes 100 m apart straddling the ridge, each 50 m from it: neither is within the 5 m
    // buffer, but the segment between them crosses the line.
    const ridgeX = destinationPoint(ORIGIN, 90, 400);
    const track: PassedTrackPoint[] = [
      { ...destinationPoint(ridgeX, 270, 50), timestamp: 0 },
      { ...destinationPoint(ridgeX, 90, 50), timestamp: 10_000 },
    ];
    const result = passedHazards(track, [ridge], { passMeters: 10 });
    expect(result).toHaveLength(1);
    expect(result[0]?.how).toBe('crossed');
  });

  it('a track parallel to the ridge just outside the pass distance is not offered', () => {
    const ridgeX = destinationPoint(ORIGIN, 90, 400);
    const track = straightTrack(destinationPoint(ridgeX, 270, 80), 0, 200, 10);
    expect(passedHazards(track, [ridge])).toEqual([]);
    // …and just inside it is passed, not crossed.
    const near = straightTrack(destinationPoint(ridgeX, 270, 40), 0, 200, 10);
    expect(passedHazards(near, [ridge]).map((r) => r.how)).toEqual(['passed']);
  });

  it('orders nearest first', () => {
    const track = straightTrack(destinationPoint(ORIGIN, 0, 30), 90, 600, 10);
    const result = passedHazards(track, HAZARDS);
    expect(result.map((r) => r.hazardId)).toEqual(['ridge', 'hole']);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]?.nearestMeters).toBeGreaterThanOrEqual(
        result[i - 1]?.nearestMeters as number,
      );
    }
  });

  it('the pass distance is the rule: passed ⇒ within it, and beyond it ⇒ absent (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 200, noNaN: true }),
        fc.double({ min: 0, max: 360, noNaN: true }),
        (offset, bearing) => {
          // A single fix `offset` meters from the hole's edge, in any direction.
          const point = destinationPoint(destinationPoint(ORIGIN, 90, 200), bearing, 15 + offset);
          const result = passedHazards([{ ...point, timestamp: 1 }], [hole]);
          if (offset > PASSED_HAZARD_METERS + 1) expect(result).toEqual([]);
          if (offset < PASSED_HAZARD_METERS - 1) {
            expect(result).toHaveLength(1);
            expect(result[0]?.nearestMeters).toBeLessThanOrEqual(PASSED_HAZARD_METERS);
          }
        },
      ),
    );
  });

  it('pointInHazard reads the footprint', () => {
    expect(pointInHazard(destinationPoint(ORIGIN, 90, 200), hole)).toBe(true);
    expect(pointInHazard(ORIGIN, hole)).toBe(false);
  });
});
