import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import outlines from './fixtures/outlines.json';
import { type LatLng, pointInPolygon } from './geometry';
import { HAZARD_MAX_VERTICES, hazardFootprint, isValidHazardShape } from './hazardGeometry';
import { sectorFrame, sectorWitness } from './sectorGeometry';
import { fitToVertexCap, sightingHazardShape } from './sightingHazards';

type Fixture = { polygon: Polygon | MultiPolygon; interiorPoint: LatLng | null };
const WILLOUGHBY = (outlines as unknown as Record<string, Fixture>).willoughby as Fixture;
const ctx = {
  outline: WILLOUGHBY.polygon,
  ...(WILLOUGHBY.interiorPoint ? { interiorPoint: WILLOUGHBY.interiorPoint } : {}),
};

describe('sightingHazardShape (D210) — the pin a located open or skim sighting implies', () => {
  it('open at the south end is an open_water polygon over the south wedge, a valid hazard shape', () => {
    const got = sightingHazardShape({ type: 'open', where: { sector: 'S' } }, ctx);
    expect(got?.type).toBe('open_water');
    expect(got?.shape.geometryKind).toBe('polygon');
    expect(got && isValidHazardShape(got.shape)).toBe(true);
    // It covers the south wedge's own witness point, the one the sheet's highlight is tested on.
    const frame = sectorFrame(WILLOUGHBY.polygon, WILLOUGHBY.interiorPoint ?? undefined);
    if (!frame || !got) throw new Error('fixture has a frame');
    expect(pointInPolygon(sectorWitness(frame, 'S'), hazardFootprint(got.shape))).toBe(true);
  });

  it('skim is thin_ice; the middle and an extent with a wedge still pin the wedge', () => {
    expect(sightingHazardShape({ type: 'skim', where: { sector: 'middle' } }, ctx)?.type).toBe(
      'thin_ice',
    );
    expect(
      sightingHazardShape({ type: 'open', where: { sector: 'N', extent: 'patches' } }, ctx)?.shape
        .geometryKind,
    ).toBe('polygon');
  });

  it('a tapped point is its own circle', () => {
    const coord = { lat: 44.7, lng: -72.05 };
    expect(
      sightingHazardShape({ type: 'open', where: { point: { coord, radiusMeters: 80 } } }, ctx),
    ).toEqual({
      type: 'open_water',
      shape: {
        geometryKind: 'point_radius',
        geometry: { type: 'Point', coordinates: [coord.lng, coord.lat] },
        radiusMeters: 80,
      },
    });
  });

  it('a landmark chosen by name pins what the rest of its where names, never its label point (D202)', () => {
    const label = { lat: 44.7, lng: -72.05 };
    const withLandmarks = { ...ctx, landmarkPoints: { lm1: label } };
    const chosen = { coord: label, radiusMeters: 75, name: 'Apple Island', landmarkId: 'lm1' };
    // Named alone: nothing — the island is land.
    expect(
      sightingHazardShape({ type: 'open', where: { point: chosen } }, withLandmarks),
    ).toBeNull();
    // Named with a wedge: the wedge.
    expect(
      sightingHazardShape({ type: 'open', where: { point: chosen, sector: 'N' } }, withLandmarks)
        ?.shape.geometryKind,
    ).toBe('polygon');
    // A tap that took the name is the tap's circle.
    const tap = { ...chosen, coord: { lat: 44.701, lng: -72.05 } };
    expect(
      sightingHazardShape({ type: 'open', where: { point: tap } }, withLandmarks)?.shape
        .geometryKind,
    ).toBe('point_radius');
  });

  it('a bay is the bay, a wedge of a bay is the bay’s wedge, an unknown bay is nothing', () => {
    const bay: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-72.07, 44.75],
          [-72.05, 44.75],
          [-72.05, 44.77],
          [-72.07, 44.77],
          [-72.07, 44.75],
        ],
      ],
    };
    const withBay = { ...ctx, bays: { b1: bay } };
    expect(
      sightingHazardShape({ type: 'open', where: { subAreaId: 'b1' } }, withBay)?.shape.geometry,
    ).toEqual(bay);
    expect(
      sightingHazardShape({ type: 'open', where: { subAreaId: 'b1', sector: 'head' } }, withBay)
        ?.shape.geometry,
    ).toEqual(bay);
    const wedge = sightingHazardShape(
      { type: 'open', where: { subAreaId: 'b1', sector: 'N' } },
      withBay,
    );
    expect(wedge?.shape.geometryKind).toBe('polygon');
    expect(wedge?.shape.geometry).not.toEqual(bay);
    expect(sightingHazardShape({ type: 'open', where: { subAreaId: 'gone' } }, withBay)).toBeNull();
  });

  it('derives nothing where no shape is named, or the state is not a hazard', () => {
    expect(sightingHazardShape({ type: 'open' }, ctx)).toBeNull(); // the whole lake's state
    expect(sightingHazardShape({ type: 'open', where: { sector: 'near_shore' } }, ctx)).toBeNull();
    expect(sightingHazardShape({ type: 'open', where: { extent: 'patches' } }, ctx)).toBeNull();
    expect(sightingHazardShape({ type: 'frozen', where: { sector: 'S' } }, ctx)).toBeNull();
    expect(sightingHazardShape({ type: 'snow_covered', where: { sector: 'S' } }, ctx)).toBeNull();
  });
});

describe('fitToVertexCap', () => {
  it('simplifies a polygon over the hazard vertex cap until it fits, keeping it closed', () => {
    const n = HAZARD_MAX_VERTICES * 2;
    const ring = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * 2 * Math.PI;
      return [-72 + 0.02 * Math.cos(a), 44.7 + 0.02 * Math.sin(a)];
    });
    ring.push(ring[0] as number[]);
    const fitted = fitToVertexCap({ type: 'Polygon', coordinates: [ring] });
    expect(fitted).not.toBeNull();
    const out = (fitted as Polygon).coordinates[0] as number[][];
    expect(out.length).toBeLessThanOrEqual(HAZARD_MAX_VERTICES);
    expect(out[0]).toEqual(out[out.length - 1]);
    expect(isValidHazardShape({ geometryKind: 'polygon', geometry: fitted as Polygon })).toBe(true);
  });
});
