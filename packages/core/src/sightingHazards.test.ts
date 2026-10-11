import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import outlines from './fixtures/outlines.json';
import { type LatLng, pointInPolygon } from './geometry';
import { HAZARD_MAX_VERTICES, hazardFootprint, isValidHazardShape } from './hazardGeometry';
import { sectorFrame, sectorWitness } from './sectorGeometry';
import {
  drawnCoversDerived,
  fitToVertexCap,
  landmarkPointsOf,
  sightingHazardShape,
  sightingsMakePins,
  whereNamesPinShape,
} from './sightingHazards';

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
    const chosen = {
      coord: label,
      radiusMeters: 75,
      name: 'Apple Island',
      landmarkId: 'lm1',
      byName: true,
    };
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

  it('a tap that lands on the label is the tap’s circle — the picker says which, not the distance (Greptile P1 on #84)', () => {
    const label = { lat: 44.7, lng: -72.05 };
    const withLandmarks = { ...ctx, landmarkPoints: { lm1: label } };
    // pointFromTap's point for a thumb on the label: the coord *is* the label, and no flag.
    const tap = { coord: label, radiusMeters: 75, name: 'Apple Island', landmarkId: 'lm1' };
    expect(
      sightingHazardShape({ type: 'open', where: { point: tap } }, withLandmarks)?.shape
        .geometryKind,
    ).toBe('point_radius');
    expect(whereNamesPinShape({ point: tap }, withLandmarks.landmarkPoints)).toBe(true);
    // Chosen by name, but the landmark has moved since: the point is no longer on the label, so it
    // pins (the over-drawing direction), and a flag with no id is a plain spot.
    const moved = { ...tap, byName: true, coord: { lat: 44.71, lng: -72.05 } };
    expect(whereNamesPinShape({ point: moved }, withLandmarks.landmarkPoints)).toBe(true);
    const { landmarkId: _, ...unlinked } = { ...tap, byName: true };
    expect(whereNamesPinShape({ point: unlinked }, withLandmarks.landmarkPoints)).toBe(true);
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

describe('whereNamesPinShape / sightingsMakePins — the hint promises a pin only where one is made (Greptile P2 on #82)', () => {
  const coord = { lat: 44.75, lng: -72.06 };
  const point = { coord, radiusMeters: 80 };

  it('names a shape for a point, a partition wedge, or a bay whole or by its wedge', () => {
    for (const where of [
      { point },
      { sector: 'S' as const },
      { sector: 'middle' as const },
      { subAreaId: 'b1' },
      { subAreaId: 'b1', sector: 'head' as const },
      { subAreaId: 'b1', sector: 'mouth' as const },
      { subAreaId: 'b1', sector: 'N' as const, extent: 'patches' as const },
    ]) {
      expect(whereNamesPinShape(where)).toBe(true);
    }
  });

  it('names none for near shore, an extent alone, or a bay-relative sector with no bay', () => {
    expect(whereNamesPinShape({ sector: 'near_shore' })).toBe(false);
    expect(whereNamesPinShape({ subAreaId: 'b1', sector: 'near_shore' })).toBe(false);
    expect(whereNamesPinShape({ extent: 'patches' })).toBe(false);
    expect(whereNamesPinShape({ sector: 'head' })).toBe(false);
  });

  it('promises no pin for a landmark chosen by name alone — the sheet and the server read one rule (D202)', () => {
    const label = { lat: 44.7, lng: -72.05 };
    const points = landmarkPointsOf({ landmarks: [{ _id: 'lm1', point: label }] });
    const chosen = {
      coord: label,
      radiusMeters: 75,
      name: 'Apple Island',
      landmarkId: 'lm1',
      byName: true,
    };
    expect(whereNamesPinShape({ point: chosen }, points)).toBe(false);
    expect(whereNamesPinShape({ point: chosen, sector: 'N' }, points)).toBe(true);
    expect(sightingsMakePins([{ type: 'open', where: { point: chosen } }], points)).toBe(false);
    // A tap that took the name is still a tap; and without the points, a point reads as a tap.
    const tap = { ...chosen, coord: { lat: 44.701, lng: -72.05 } };
    expect(whereNamesPinShape({ point: tap }, points)).toBe(true);
    expect(whereNamesPinShape({ point: chosen })).toBe(true);
    expect(landmarkPointsOf({ landmarks: [] })).toBeUndefined();
    expect(landmarkPointsOf(null)).toBeUndefined();
  });

  it('agrees with the server: no hint for a placed sighting that derives nothing', () => {
    expect(sightingsMakePins([{ type: 'open', where: { sector: 'near_shore' } }])).toBe(false);
    expect(sightingsMakePins([{ type: 'skim', where: { extent: 'large_areas' } }])).toBe(false);
    expect(sightingsMakePins([{ type: 'open' }])).toBe(false);
    expect(sightingsMakePins([{ type: 'frozen', where: { sector: 'S' } }])).toBe(false);
    expect(
      sightingsMakePins([
        { type: 'open', where: { sector: 'near_shore' } },
        { type: 'skim', where: { sector: 'S' } },
      ]),
    ).toBe(true);
    for (const where of [{ sector: 'near_shore' as const }, { extent: 'patches' as const }]) {
      expect(sightingHazardShape({ type: 'open', where }, ctx)).toBeNull();
    }
    expect(sightingHazardShape({ type: 'open', where: { sector: 'S' } }, ctx)).not.toBeNull();
  });
});

describe('drawnCoversDerived — a drawn pin stands in for a derived one only when it covers it (Greptile P1 on #82)', () => {
  const frame = sectorFrame(ctx.outline, ctx.interiorPoint);
  if (!frame) throw new Error('the fixture has a frame');
  const derived = sightingHazardShape({ type: 'open', where: { sector: 'S' } }, ctx);
  if (!derived) throw new Error('the south wedge derives');
  const south = sectorWitness(frame, 'S');
  const smallPin = {
    type: 'open_water' as const,
    shape: {
      geometryKind: 'point_radius' as const,
      geometry: { type: 'Point' as const, coordinates: [south.lng, south.lat] },
      radiusMeters: 40,
    },
  };
  const wholeLake = {
    type: 'open_water' as const,
    shape: { geometryKind: 'polygon' as const, geometry: ctx.outline },
  };

  it('does not let a smaller pin inside the area stand in for it', () => {
    expect(drawnCoversDerived(derived, [smallPin])).toBe(false);
  });

  it('lets a pin of the same type covering the whole area stand in for it', () => {
    expect(drawnCoversDerived(derived, [wholeLake])).toBe(true);
    expect(drawnCoversDerived(derived, [smallPin, wholeLake])).toBe(true);
  });

  it('never counts another type, or nothing drawn', () => {
    expect(drawnCoversDerived(derived, [{ ...wholeLake, type: 'thin_ice' }])).toBe(false);
    expect(drawnCoversDerived(derived, [])).toBe(false);
  });

  it('fails open: a drawn shape the geometry cannot read covers nothing', () => {
    const broken = {
      type: 'open_water' as const,
      shape: {
        geometryKind: 'polygon' as const,
        geometry: { type: 'Polygon' as const, coordinates: [[[0, 0]]] },
      },
    };
    expect(drawnCoversDerived(derived, [broken, broken])).toBe(false); // the union fails
    const noRadius = {
      type: 'open_water' as const,
      shape: { ...smallPin.shape, radiusMeters: Number.NaN }, // the footprint throws
    };
    expect(drawnCoversDerived(derived, [noRadius])).toBe(false);
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
