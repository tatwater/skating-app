import fc from 'fast-check';
import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  lineToPath,
  reportWhereSummary,
  ringsToPath,
  ringToPath,
  SILHOUETTE_MAX_POINTS,
  sectorHighlightPath,
  silhouettePath,
  silhouetteProjection,
  silhouetteRings,
} from './bodySilhouette';
import outlines from './fixtures/outlines.json';
import type { LatLng } from './geometry';

interface Fixture {
  name: string;
  polygon: Polygon | MultiPolygon;
  interiorPoint: LatLng | null;
}
const BODIES = Object.values(outlines as Record<string, Fixture>);

const SQUARE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-73, 44],
      [-73, 44.01],
      [-72.99, 44.01],
      [-72.99, 44],
      [-73, 44],
    ],
  ],
};

describe('silhouetteRings — the outline at card scale (A10 §12.3)', () => {
  it('fits every real outline in the point budget and keeps its bbox', () => {
    for (const body of BODIES) {
      const { rings, bbox } = silhouetteRings(body.polygon as never);
      const total = rings.reduce((n, r) => n + r.length, 0);
      expect(total, body.name).toBeLessThanOrEqual(SILHOUETTE_MAX_POINTS);
      expect(rings.length, body.name).toBeGreaterThan(0);
      expect(bbox.maxLat).toBeGreaterThan(bbox.minLat);
    }
  });

  it('a small outline comes back whole; every kept point is one of the original vertices', () => {
    const { rings } = silhouetteRings(SQUARE);
    expect(rings).toEqual([SQUARE.coordinates[0]]);
    for (const body of BODIES) {
      const original = new Set<string>();
      const coords =
        body.polygon.type === 'Polygon' ? [body.polygon.coordinates] : body.polygon.coordinates;
      for (const poly of coords)
        for (const ring of poly) for (const p of ring) original.add(p.join(','));
      const { rings } = silhouetteRings(body.polygon as never);
      for (const ring of rings) for (const p of ring) expect(original.has(p.join(','))).toBe(true);
    }
  });

  it('a path is simplified to the same budget and keeps its ends', () => {
    const line = Array.from({ length: 2_000 }, (_, i) => [
      -73 + i * 0.00001,
      44 + Math.sin(i / 50) * 0.0005,
    ]);
    const { bbox } = silhouetteRings(SQUARE);
    const out = silhouettePath(line, bbox);
    expect(out.length).toBeLessThan(line.length);
    expect(out[0]).toEqual(line[0]);
    expect(out[out.length - 1]).toEqual(line[line.length - 1]);
  });
});

describe('silhouetteProjection — an equirectangular fit', () => {
  it('maps the bbox corners inside the padded frame, preserving aspect', () => {
    fc.assert(
      fc.property(
        fc.record({
          minLat: fc.double({ min: -80, max: 79, noNaN: true }),
          minLng: fc.double({ min: -179, max: 178, noNaN: true }),
          dLat: fc.double({ min: 0.0001, max: 1, noNaN: true }),
          dLng: fc.double({ min: 0.0001, max: 1, noNaN: true }),
        }),
        ({ minLat, minLng, dLat, dLng }) => {
          const bbox = { minLat, minLng, maxLat: minLat + dLat, maxLng: minLng + dLng };
          const p = silhouetteProjection(bbox, 100, 60, 4);
          for (const corner of [
            [minLng, minLat],
            [minLng + dLng, minLat + dLat],
          ] as [number, number][]) {
            const [x, y] = p.toXY(corner);
            expect(x).toBeGreaterThanOrEqual(4 - 1e-6);
            expect(x).toBeLessThanOrEqual(96 + 1e-6);
            expect(y).toBeGreaterThanOrEqual(4 - 1e-6);
            expect(y).toBeLessThanOrEqual(56 + 1e-6);
          }
          // North is up: a higher latitude is a smaller y.
          expect(p.toXY([minLng, minLat + dLat])[1]).toBeLessThan(p.toXY([minLng, minLat])[1]);
        },
      ),
    );
  });

  it('draws paths from the projection: closed rings end in Z, a one-point line is empty', () => {
    const p = silhouetteProjection(silhouetteRings(SQUARE).bbox, 64, 64);
    expect(ringToPath(SQUARE.coordinates[0] as never, p)).toMatch(/^M [\d.]+ [\d.]+ L .* Z$/);
    expect(ringsToPath(silhouetteRings(SQUARE).rings, p).split(' Z').length).toBe(2);
    expect(lineToPath([[-73, 44]], p)).toBe('');
  });
});

describe('sectorHighlightPath', () => {
  const origin = { lat: 44.005, lng: -72.995 };
  const p = silhouetteProjection(silhouetteRings(SQUARE).bbox, 64, 64);
  it('a compass sector is a fan from the origin that reaches past the frame', () => {
    const fan = sectorHighlightPath({ origin }, 'N', p);
    expect(fan).toMatch(/^M 32\.0 32\.0 L /);
    const ys = [...(fan ?? '').matchAll(/L [\d.-]+ ([\d.-]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeLessThan(0); // north of the frame
  });
  it('middle is a disc sized from the radius, near shore and the bay sectors are not paths', () => {
    expect(sectorHighlightPath({ origin, middleRadiusM: 200 }, 'middle', p)).toMatch(/^M .* a /);
    expect(sectorHighlightPath({ origin }, 'near_shore', p)).toBeNull();
    expect(sectorHighlightPath({ origin }, 'head', p)).toBeNull();
  });
});

describe('reportWhereSummary', () => {
  it('draws the first located chip’s where whole — its sector and bay together', () => {
    expect(
      reportWhereSummary({
        iceTypes: [{ where: { extent: 'patches' } }, { where: { sector: 'N', subAreaId: 'b1' } }],
        surfaceTags: [{ where: { sector: 'S' } }],
        iceThickness: { readings: [{ where: { subAreaId: 'b2' } }] },
      }),
    ).toEqual({ sector: 'N', subAreaId: 'b1' });
    expect(reportWhereSummary({ iceTypes: [], surfaceTags: [] })).toEqual({});
  });

  it('never composes a sector from one chip with a bay from another', () => {
    // "Black ice, south" then a reading in bay b2: the south wedge alone — not "the south end of b2".
    expect(
      reportWhereSummary({
        iceTypes: [{ where: { extent: 'patches' } }, { where: { sector: 'S' } }],
        surfaceTags: [],
        iceThickness: { readings: [{ where: { subAreaId: 'b2' } }] },
      }),
    ).toEqual({ sector: 'S' });
    // A bay alone is the ring alone, even when a later chip names a sector.
    expect(
      reportWhereSummary({
        iceTypes: [{ where: { subAreaId: 'b1' } }],
        surfaceTags: [{ where: { sector: 'E' } }],
      }),
    ).toEqual({ subAreaId: 'b1' });
    // A point-only where is not a highlight; the next located chip is.
    expect(
      reportWhereSummary({
        iceTypes: [{ where: { point: { coord: { lat: 0, lng: 0 }, radiusMeters: 50 } } }],
        surfaceTags: [{ where: { sector: 'W' } }],
      }),
    ).toEqual({ sector: 'W' });
  });
});
