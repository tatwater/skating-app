/**
 * What every contour line carries into the tile (N6b).
 *
 * Split out of the builder and tested, because these five properties are the entire contract between
 * the ETL and the two clients, and **every one of them fails silently if it is wrong**:
 *
 * - `bodyId` wrong → D81's filter matches nothing and the lake renders flat. Looks exactly like a
 *   lake nobody surveyed.
 * - `lane` wrong → a surface *we* fitted is captioned as one the state surveyed. This is the single
 *   claim this phase most cares about, and it is one string.
 * - `agency` wrong → we credit the wrong people, which is a licence problem rather than a bug.
 * - `intervalFt` wrong → the drawer says "5 ft contours" over lines drawn every 25.
 *
 * None of those throws, none of them fails a build, and none is visible on a rendered map. That is
 * the profile of a thing that should be a pure function with tests rather than an object literal
 * inside a loop.
 */

import type { Position } from 'geojson';
import type { ArchivedLake } from './lakes';

/** The properties a client reads back off a tile. Mirrors `ContourFeatureProperties` in core. */
export interface ContourProperties {
  bodyId: string;
  depthFt: number;
  lane: 'surveyed' | 'interpolated';
  agency: string;
  state: string;
  intervalFt: number | null;
}

export interface ContourFeature {
  type: 'Feature';
  properties: ContourProperties;
  geometry: { type: 'LineString'; coordinates: Position[] };
}

/** The body a lake resolved to, as far as this module needs it. */
export interface StampBody {
  externalId?: string;
  waterBodyId: string;
}

/**
 * The provenance claim, from the lane the data arrived in.
 *
 * A contour lane is the agency's own isobath; a sounding lane is our fitted surface. They are
 * different assertions and the UI must never render them as the same thing (§Maine step 5, gate 3 of
 * §6) — so the mapping lives here, once, rather than as a ternary at each call site.
 */
export function laneClaim(lake: ArchivedLake): 'surveyed' | 'interpolated' {
  return lake.lane === 'contours' ? 'surveyed' : 'interpolated';
}

/**
 * The stable id the client filters on.
 *
 * **`externalId` (the OSM id), falling back to the Convex `_id`.** The fallback exists so a body
 * somehow lacking an `externalId` still renders rather than silently vanishing, but it is a fallback:
 * `_id` changes if a row is ever recreated, and re-tiling five states because a re-import churned ids
 * is not a thing we should be one accident away from.
 */
export function stampBodyId(body: StampBody): string {
  return body.externalId?.trim() || body.waterBodyId;
}

/** One contour line, stamped and ready to write. */
export function contourFeature(options: {
  lake: ArchivedLake;
  body: StampBody;
  agency: string;
  coordinates: Position[];
  depthFt: number;
  intervalFt?: number;
}): ContourFeature {
  const { lake, body, agency, coordinates, depthFt, intervalFt } = options;
  return {
    type: 'Feature',
    properties: {
      bodyId: stampBodyId(body),
      depthFt,
      lane: laneClaim(lake),
      agency,
      state: lake.state,
      // `null` rather than omitted: a tile property that is sometimes absent and sometimes present
      // is harder for a client to reason about than one that is explicitly unknown.
      intervalFt: intervalFt ?? null,
    },
    geometry: { type: 'LineString', coordinates },
  };
}
