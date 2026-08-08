/**
 * The rules `buildRegion` decides with — extracted so they can be tested (N7 audit).
 *
 * ## Why this file exists
 *
 * `buildRegion.ts` was excluded from coverage as `ogr2ogr` plus file writes, and this package's own
 * vitest config already warned about it in as many words:
 *
 * > ⚠ `buildRegion.ts` is excluded on the same grounds … but it is the largest file in the package
 * > and it does carry decisions: `nearRegion`, `needsClipping`, `maskFeature` and the union/subtract
 * > pair all choose what the region *is*. `merge.ts` in the water ETL was excluded for exactly this
 * > reason, grew a merge rule, and ended up deciding 27,074 rows untested.
 *
 * It kept growing. And one of its outputs — `downstate-ny.geojson` — is not scenery: `merge.ts` reads
 * it as the D111 corpus cut, so a rule in here **deletes water bodies**.
 *
 * Same split as `mergeRules.ts`: the caller keeps `ogr2ogr`, the file writes and the log; everything
 * below is pure and takes what it needs as an argument.
 */

import type { BBox } from '@skating/core';

/**
 * New York south of I-84, by county — the corpus cut (founder, 2026-08-05).
 *
 * **Counties rather than a latitude line**, because a lake that straddles 41.5°N would otherwise be
 * half in the corpus and half out, and because these are boundaries we already hold. The fit is
 * deliberately imperfect at both ends: I-84 runs through the middle of Orange County, which is
 * dropped whole, and clips the southern tip of Dutchess, which is kept whole. The rule a user can be
 * told — "we cover New York north of I-84" — survives both.
 */
export const DOWNSTATE_NY_COUNTIES = [
  // The five boroughs.
  'Bronx',
  'Kings',
  'New York',
  'Queens',
  'Richmond',
  // Long Island.
  'Nassau',
  'Suffolk',
  // The lower Hudson, up to and including the county I-84 crosses.
  'Westchester',
  'Rockland',
  'Putnam',
  'Orange',
] as const;

/** Connecticut, New Jersey, Pennsylvania, Rhode Island — the states that touch ours. */
export const NEIGHBOUR_FIPS: ReadonlySet<string> = new Set(['09', '34', '42', '44']);

/**
 * How far the mask has to reach, and why it does not have to reach further.
 *
 * The mask exists to cover **tile bleed** — the whole tiles `pmtiles extract --region` keeps because
 * they graze our border, Connecticut and all. Bleed cannot travel further than one tile at the lowest
 * zoom the regional layers draw, which is one z6 tile, about 450 km. Past that the regional archive
 * holds nothing at all, and the world overview already draws exactly what we want out there.
 *
 * So masking Africa is 875 KB spent to paint white over white. The first build did it anyway and the
 * file was 1.5 MB; scoping to this box is most of the difference.
 */
export const BLEED_BOX = { minLng: -86, minLat: 36, maxLng: -60, maxLat: 52 } as const;

/**
 * Does a feature's bbox overlap the bleed neighbourhood at all — the cheap keep/drop test.
 *
 * **Cheap, and therefore wrong for anything that crosses the antimeridian.** Alaska's bbox runs from
 * -180 to 180 because the Aleutians straddle the date line, so this returns true for a state two time
 * zones past Siberia — and the first build duly shipped the whole of it, which is how a mask scoped
 * to the Northeast came out with a bbox spanning the globe. That is what `needsClipping` is for: the
 * box test admits, the clip disposes.
 */
export function nearRegion(box: BBox): boolean {
  return (
    box.minLng <= BLEED_BOX.maxLng &&
    box.maxLng >= BLEED_BOX.minLng &&
    box.minLat <= BLEED_BOX.maxLat &&
    box.maxLat >= BLEED_BOX.minLat
  );
}

/**
 * Does a feature spill outside the bleed box, and so have to be clipped rather than taken whole?
 *
 * Asked per feature rather than clipping everything, because clipping is a boolean operation and the
 * shared TIGER borders are the one thing in this file worth not running through one. Connecticut sits
 * wholly inside the box and comes through untouched, vertex for vertex; Michigan and Canada do not.
 */
export function needsClipping(box: BBox): boolean {
  return (
    box.minLng < BLEED_BOX.minLng ||
    box.maxLng > BLEED_BOX.maxLng ||
    box.minLat < BLEED_BOX.minLat ||
    box.maxLat > BLEED_BOX.maxLat
  );
}

/**
 * Round every coordinate to four decimals — about eleven metres at this latitude.
 *
 * TIGER emits seven, which is centimetres: a precision no consumer of this file can render and every
 * consumer has to download. Applied **after** simplification, so it only trims digits rather than
 * moving any vertex a renderer would have kept — four decimals is finer than the finest tolerance the
 * builder uses.
 */
export function roundCoords<T>(geometry: T): T {
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  const walk = (node: unknown): unknown =>
    Array.isArray(node)
      ? typeof node[0] === 'number'
        ? (node as number[]).map(round)
        : node.map(walk)
      : node;
  const g = geometry as { coordinates?: unknown };
  return g.coordinates ? ({ ...g, coordinates: walk(g.coordinates) } as T) : geometry;
}

/**
 * `BLEED_BOX` as a ring, for the features big enough to be worth clipping rather than dropping.
 *
 * Wound counter-clockwise and closed, because a clipper handed an unclosed or self-crossing ring
 * fails in the way this whole phase keeps meeting: it returns `null`, the caller reads that as
 * "nothing left after clipping", and the feature disappears without an error.
 */
export function bleedBoxRing(): [number, number][] {
  return [
    [BLEED_BOX.minLng, BLEED_BOX.minLat],
    [BLEED_BOX.maxLng, BLEED_BOX.minLat],
    [BLEED_BOX.maxLng, BLEED_BOX.maxLat],
    [BLEED_BOX.minLng, BLEED_BOX.maxLat],
    [BLEED_BOX.minLng, BLEED_BOX.minLat],
  ];
}
