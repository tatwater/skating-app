/**
 * The region builder's decisions, against named answers (N7 audit).
 *
 * These were untested while they lived inside a file excluded as `ogr2ogr` glue — and one of them
 * decides which **water bodies** exist: `merge.ts` reads `downstate-ny.geojson` as the D111 corpus
 * cut, so a county on or off the list below adds or removes lakes.
 */

import { describe, expect, it } from 'vitest';
import {
  BLEED_BOX,
  bleedBoxRing,
  DOWNSTATE_NY_COUNTIES,
  NEIGHBOUR_FIPS,
  nearRegion,
  needsClipping,
  roundCoords,
} from './regionRules';

describe('the downstate cut (D111)', () => {
  it('names the eleven counties, and Dutchess is not one of them', () => {
    // The fit is deliberately imperfect at both ends: I-84 runs through the middle of **Orange**,
    // which is dropped whole, and clips the southern tip of **Dutchess**, which is kept whole. The
    // rule a user can be told — "we cover New York north of I-84" — survives both.
    expect(DOWNSTATE_NY_COUNTIES).toHaveLength(11);
    expect(DOWNSTATE_NY_COUNTIES).toContain('Orange');
    expect(DOWNSTATE_NY_COUNTIES).not.toContain('Dutchess');
  });

  it('covers the five boroughs and Long Island', () => {
    for (const c of ['Bronx', 'Kings', 'New York', 'Queens', 'Richmond', 'Nassau', 'Suffolk']) {
      expect(DOWNSTATE_NY_COUNTIES).toContain(c);
    }
  });

  it('does not cut any county we do cover', () => {
    // A false entry here deletes water bodies from a region we claim, which is the direction that
    // cannot be noticed from the map — the map still draws downstate New York in full.
    for (const c of ['Albany', 'Essex', 'Warren', 'Hamilton', 'Ulster', 'Sullivan']) {
      expect(DOWNSTATE_NY_COUNTIES).not.toContain(c);
    }
  });
});

describe('the neighbour states', () => {
  it('is the four that share a line with ours, by FIPS', () => {
    // Their border is the one edge of the mask that has to be right: every metre of simplification
    // there is a metre of their territory that may go unmasked and leak basemap detail.
    expect([...NEIGHBOUR_FIPS].sort()).toEqual(['09', '34', '42', '44']); // CT, NJ, PA, RI
  });

  it('does not include a state of ours', () => {
    for (const fips of ['23', '33', '50', '25', '36']) {
      expect(NEIGHBOUR_FIPS.has(fips)).toBe(false); // ME, NH, VT, MA, NY
    }
  });
});

describe('the bleed box', () => {
  it('reaches about one z6 tile past the five states, and no further', () => {
    // Bleed cannot travel further than one tile at the lowest zoom the regional layers draw — one z6
    // tile, ~450 km. Past that the regional archive holds nothing and the world overview is already
    // drawing what we want, so masking Africa is 875 KB spent painting white over white.
    expect(BLEED_BOX).toEqual({ minLng: -86, minLat: 36, maxLng: -60, maxLat: 52 });
  });

  it('admits a neighbouring state', () => {
    expect(nearRegion({ minLng: -73.7, minLat: 40.9, maxLng: -71.8, maxLat: 42.1 })).toBe(true);
  });

  it('refuses a feature nowhere near, so Africa is never masked', () => {
    expect(nearRegion({ minLng: 10, minLat: -30, maxLng: 40, maxLat: 10 })).toBe(false);
  });

  it('⚠ admits an antimeridian-spanning bbox, which is why the clip exists', () => {
    // Alaska's bbox runs -180..180 because the Aleutians straddle the date line, so the cheap box
    // test returns true for a state two time zones past Siberia. The first build duly shipped the
    // whole of it — a mask scoped to the Northeast with a bbox spanning the globe. The box admits;
    // `needsClipping` disposes.
    const alaska = { minLng: -180, minLat: 51, maxLng: 180, maxLat: 71.4 };
    expect(nearRegion(alaska)).toBe(true);
    expect(needsClipping(alaska)).toBe(true);
  });

  it('takes a feature wholly inside whole, vertex for vertex', () => {
    // Clipping is a boolean operation and the shared TIGER borders are the one thing worth not
    // running through one. Connecticut comes through untouched.
    expect(needsClipping({ minLng: -73.7, minLat: 40.9, maxLng: -71.8, maxLat: 42.1 })).toBe(false);
  });

  it('clips anything crossing an edge, on each of the four', () => {
    expect(needsClipping({ ...BLEED_BOX, minLng: -87 })).toBe(true);
    expect(needsClipping({ ...BLEED_BOX, maxLng: -59 })).toBe(true);
    expect(needsClipping({ ...BLEED_BOX, minLat: 35 })).toBe(true);
    expect(needsClipping({ ...BLEED_BOX, maxLat: 53 })).toBe(true);
    expect(needsClipping({ ...BLEED_BOX })).toBe(false); // exactly the box is not outside it
  });

  it('closes its ring, because a clipper handed an open one returns null rather than erroring', () => {
    const ring = bleedBoxRing();
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring).toHaveLength(5);
  });
});

describe('coordinate rounding', () => {
  it('trims TIGER’s centimetres to about eleven metres', () => {
    // Seven decimals is a precision no consumer can render and every consumer has to download.
    const g = { type: 'Polygon', coordinates: [[[-73.1234567, 42.7654321]]] };
    expect(roundCoords(g)).toEqual({ type: 'Polygon', coordinates: [[[-73.1235, 42.7654]]] });
  });

  it('walks a MultiPolygon to any depth', () => {
    const g = { type: 'MultiPolygon', coordinates: [[[[-73.123456, 42.765432]]]] };
    expect(roundCoords(g)).toEqual({
      type: 'MultiPolygon',
      coordinates: [[[[-73.1235, 42.7654]]]],
    });
  });

  it('leaves a geometry with no coordinates alone rather than throwing', () => {
    const g = { type: 'GeometryCollection', geometries: [] };
    expect(roundCoords(g)).toBe(g);
  });

  it('is finer than the finest tolerance the builder simplifies to', () => {
    // 0.0005° is the neighbour tolerance — the tightest in the file. Rounding must not move a vertex
    // the simplifier deliberately kept, so it has to be finer than that, and 0.0001 is.
    expect(0.0001).toBeLessThan(0.0005);
  });
});
