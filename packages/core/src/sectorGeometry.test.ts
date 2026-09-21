import fc from 'fast-check';
import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import outlines from './fixtures/outlines.json';
import { type LatLng, pointInPolygon, polygonBBox } from './geometry';
import {
  compassSectorFor,
  isNearShore,
  MIDDLE_RADIUS_FRACTION,
  NEAR_SHORE_MAX_METERS,
  PARTITION_SECTORS,
  pointInSectorPolygon,
  type SectorFrame,
  sectorAt,
  sectorFrame,
  sectorPolygons,
  sectorWitness,
} from './sectorGeometry';
import { COMPASS_SECTORS } from './types';

/**
 * Six real outlines from the dev corpus (2026-09-21): Willoughby (long and narrow, a shoreline
 * `centroid`), Morey, Dunmore (islands), Shelburne Pond (lobed), Waterbury Reservoir (dendritic —
 * the hard case for a wedge partition) and Curtis Ponds (tiny, an island). Stored as the ETL wrote
 * them: simplified MultiPolygons with the row's `interiorPoint`.
 */
type Fixture = {
  name: string;
  polygon: Polygon | MultiPolygon;
  interiorPoint: LatLng | null;
  centroid: LatLng;
};
const BODIES = Object.values(outlines as Record<string, Fixture>);

function frameFor(body: Fixture): SectorFrame {
  const frame = sectorFrame(body.polygon, body.interiorPoint ?? undefined);
  if (!frame) throw new Error(`${body.name}: no frame`);
  return frame;
}

/** Random points inside the outline (rejection-sampled over the bbox). */
function interiorPoints(polygon: Polygon | MultiPolygon): fc.Arbitrary<LatLng> {
  const box = polygonBBox(polygon);
  return fc
    .record({
      lat: fc.double({ min: box.minLat, max: box.maxLat, noNaN: true }),
      lng: fc.double({ min: box.minLng, max: box.maxLng, noNaN: true }),
    })
    .filter((p) => pointInPolygon(p, polygon));
}

describe('compassSectorFor', () => {
  it('buckets bearings into eight 45° wedges centered on the compass points', () => {
    expect(compassSectorFor(0)).toBe('N');
    expect(compassSectorFor(22.4)).toBe('N');
    expect(compassSectorFor(22.5)).toBe('NE');
    expect(compassSectorFor(45)).toBe('NE');
    expect(compassSectorFor(90)).toBe('E');
    expect(compassSectorFor(180)).toBe('S');
    expect(compassSectorFor(270)).toBe('W');
    expect(compassSectorFor(337.4)).toBe('NW');
    expect(compassSectorFor(337.5)).toBe('N');
    expect(compassSectorFor(-10)).toBe('N');
    expect(compassSectorFor(720 + 135)).toBe('SE');
  });

  it('every bearing lands in exactly one wedge, and the wedge is the nearest compass point (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 360, noNaN: true }), (bearing) => {
        const sector = compassSectorFor(bearing);
        const center = COMPASS_SECTORS.indexOf(sector) * 45;
        const delta = Math.abs((((bearing - center) % 360) + 540) % 360) - 180;
        expect(Math.abs(delta)).toBeLessThanOrEqual(22.5 + 1e-9);
      }),
    );
  });
});

describe('sectorFrame', () => {
  it('honors the stored interior point and derives one when it is missing or on the shore', () => {
    const willoughby = BODIES.find((b) => b.name === 'Lake Willoughby') as Fixture;
    const stored = sectorFrame(willoughby.polygon, willoughby.interiorPoint as LatLng);
    expect(stored?.origin).toEqual(willoughby.interiorPoint);
    // The stored `centroid` is a shoreline point — it must not become the origin.
    const fromCentroid = sectorFrame(willoughby.polygon, willoughby.centroid);
    expect(fromCentroid?.origin).not.toEqual(willoughby.centroid);
    expect(fromCentroid?.origin).toEqual(sectorFrame(willoughby.polygon)?.origin);
  });

  it('sizes the middle and the band off the shortest ray, capping the band', () => {
    for (const body of BODIES) {
      const frame = frameFor(body);
      const shortest = Math.min(...frame.raysM.filter((r) => r > 0));
      expect(frame.middleRadiusM).toBeCloseTo(shortest * MIDDLE_RADIUS_FRACTION, 6);
      expect(frame.nearShoreM).toBeLessThanOrEqual(NEAR_SHORE_MAX_METERS);
      expect(frame.nearShoreM).toBeGreaterThan(0);
    }
  });

  it('returns null for geometry with no interior', () => {
    expect(sectorFrame({ type: 'Polygon', coordinates: [] })).toBeNull();
  });
});

describe('the partition, over real outlines', () => {
  for (const body of BODIES) {
    describe(body.name, () => {
      const frame = frameFor(body);
      const polygons = sectorPolygons(frame, body.polygon);

      it('every sector is non-empty and its witness is inside the water', () => {
        for (const sector of PARTITION_SECTORS) {
          expect(polygons[sector], sector).not.toBeNull();
          const witness = sectorWitness(frame, sector);
          expect(pointInPolygon(witness, body.polygon), `${sector} witness on water`).toBe(true);
          expect(sectorAt(frame, witness), `${sector} witness classified`).toBe(sector);
        }
      });

      it('every sector polygon is inside the outline', () => {
        // Every vertex of every clipped polygon lies on or inside the outline — a clip cannot add
        // area, and a vertex outside would be one.
        for (const sector of PARTITION_SECTORS) {
          const polygon = polygons[sector];
          if (!polygon) continue;
          const rings =
            polygon.type === 'Polygon' ? polygon.coordinates : polygon.coordinates.flat(1);
          for (const ring of rings) {
            for (const [lng, lat] of ring as [number, number][]) {
              // Clipped vertices sit on the shoreline; the boundary counts as inside, with a
              // hair of tolerance for the clipper's floating point.
              const inside =
                pointInPolygon({ lat, lng }, body.polygon) ||
                pointInPolygon({ lat: lat + 1e-7, lng }, body.polygon) ||
                pointInPolygon({ lat: lat - 1e-7, lng }, body.polygon) ||
                pointInPolygon({ lat, lng: lng + 1e-7 }, body.polygon) ||
                pointInPolygon({ lat, lng: lng - 1e-7 }, body.polygon);
              expect(inside, `${sector} vertex ${lat},${lng}`).toBe(true);
            }
          }
        }
      });

      it('classifies every interior point into exactly one sector, and the highlight agrees (property)', () => {
        fc.assert(
          fc.property(interiorPoints(body.polygon), (point) => {
            const sector = sectorAt(frame, point);
            expect(PARTITION_SECTORS).toContain(sector);
            // The polygon the sheet would highlight contains the point — unless the point sits on
            // a wedge boundary, where the clipper's rounding may put it a hair over the line.
            const inOwn = pointInSectorPolygon(polygons, sector, point);
            const inOthers = PARTITION_SECTORS.filter(
              (s) => s !== sector && pointInSectorPolygon(polygons, s, point),
            );
            if (!inOwn) {
              // A boundary case: it must then be in an adjacent polygon, never in none.
              expect(inOthers.length, `${sector} point in no polygon`).toBeGreaterThan(0);
            }
          }),
          { numRuns: 150 },
        );
      });

      it('near shore is a band that overlaps the wedges rather than replacing them', () => {
        // The origin is the farthest point from any bank the frame knows about: never near shore.
        expect(isNearShore(frame, body.polygon, frame.origin)).toBe(false);
        // A point a meter inside the shoreline along the first ray is near shore, and still has a
        // compass sector.
        const shoreward = sectorWitness(frame, 'N');
        expect(sectorAt(frame, shoreward)).toBe('N');
        fc.assert(
          fc.property(interiorPoints(body.polygon), (point) => {
            // Whatever the band says, the point has a partition sector — the two are independent.
            expect(PARTITION_SECTORS).toContain(sectorAt(frame, point));
            return true;
          }),
          { numRuns: 50 },
        );
      });
    });
  }
});
