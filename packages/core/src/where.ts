/**
 * `where` — the location a chip or a reading is about (A10 / D193).
 *
 * Half of the corpus's reports locate something, and mostly by compass — "north end", "west of the
 * Broads" — not by bay name. Named bays (A09) are the right object where they exist and the wrong
 * one where they don't; sectors are the honest 90% of painting without a brush. So a `where` is a
 * **composition** rather than a choice: a bay narrows the scope, a sector narrows it inside the
 * bay ("the north end of Malletts Bay"), an extent qualifies how much of that scope the claim
 * covers ("patches"), and a point from a tap on the mini-map is the finest grain the sheet offers.
 *
 * Every part is optional and at least one must be present — `{}` says nothing and is rejected, so
 * that "no `where`" (the whole body) is spelled by *absence*, never by an empty object two readers
 * could interpret differently. The bay-relative sectors (`head`, `mouth`) require the bay.
 *
 * **A `where` is a label inside the Report, never membership.** A chip located in a bay does not
 * make the Report a member of that bay (`reportSubAreas` stays track- or point-derived, A09);
 * surfacing chip-located reports in a bay feed is a later read enhancement. Nothing here is a safety
 * claim (D3) — it says where the author looked, not where the ice is good.
 */

import { isValidCoord, type LatLng } from './geometry';
import { humanizeEnum } from './reportView';
import {
  BAY_SECTORS,
  COMPASS_SECTORS,
  SECTORS,
  type Sector,
  WHERE_EXTENTS,
  type WhereExtent,
} from './types';

/** A coarse point from a tap — the A05b tap-to-place primitive, with the radius it was placed at. */
export interface WherePoint {
  coord: LatLng;
  /** The tap's uncertainty, in meters. Coarse by design: this is "about here", not a survey. */
  radiusMeters: number;
  /** A named landmark the point stands for ("off Shelburne Point") — filled by the landmarks ETL, later. */
  name?: string;
}

export interface Where {
  extent?: WhereExtent;
  /** A named bay (A09). Stored as the sub-area id; the sheet shows the name. */
  subAreaId?: string;
  sector?: Sector;
  point?: WherePoint;
}

/**
 * The coarse kind of a `where`, for display and for the eval's per-field buckets — finest grain
 * wins, because "a point in the north end of the bay" is a point. `whole` is an extent alone.
 */
export const WHERE_KINDS = ['whole', 'subArea', 'sector', 'point'] as const;
export type WhereKind = (typeof WHERE_KINDS)[number];

export function whereKind(where: Where): WhereKind {
  if (where.point) return 'point';
  if (where.sector) return 'sector';
  if (where.subAreaId) return 'subArea';
  return 'whole';
}

export interface WhereValidationError {
  field: string;
  message: string;
}

/** Bounds on a tap radius — below a meter is a survey pin, above this is "somewhere on the lake". */
export const WHERE_POINT_RADIUS_MIN_M = 1;
export const WHERE_POINT_RADIUS_MAX_M = 2_000;

/**
 * Validate one `where`, pushing path-prefixed problems into `errors` and returning the normalized
 * value (strings trimmed, empty name dropped) or `null` when anything was wrong. Shape only: whether
 * `subAreaId` belongs to the report's body is the server's check, made with the body in hand.
 */
export function validateWhere(
  where: Where,
  path: string,
  errors: WhereValidationError[],
): Where | null {
  const before = errors.length;
  const normalized: Where = {};

  if (where.extent !== undefined) {
    if (!(WHERE_EXTENTS as readonly string[]).includes(where.extent)) {
      errors.push({ field: `${path}.extent`, message: 'is not a known extent' });
    } else normalized.extent = where.extent;
  }

  const subAreaId = typeof where.subAreaId === 'string' ? where.subAreaId.trim() : undefined;
  if (where.subAreaId !== undefined) {
    if (!subAreaId) errors.push({ field: `${path}.subAreaId`, message: 'must be an id' });
    else normalized.subAreaId = subAreaId;
  }

  if (where.sector !== undefined) {
    if (!(SECTORS as readonly string[]).includes(where.sector)) {
      errors.push({ field: `${path}.sector`, message: 'is not a known sector' });
    } else if ((BAY_SECTORS as readonly string[]).includes(where.sector) && !subAreaId) {
      // "The back of the bay" is a direction relative to a bay's shape; without the bay it names
      // nothing, and a reader would have no mouth line to render it from.
      errors.push({ field: `${path}.sector`, message: 'head and mouth need a bay' });
    } else normalized.sector = where.sector;
  }

  if (where.point !== undefined) {
    const { coord, radiusMeters, name } = where.point;
    if (coord === undefined || !isValidCoord(coord)) {
      errors.push({ field: `${path}.point.coord`, message: 'is not a valid coordinate' });
    }
    if (
      !Number.isFinite(radiusMeters) ||
      radiusMeters < WHERE_POINT_RADIUS_MIN_M ||
      radiusMeters > WHERE_POINT_RADIUS_MAX_M
    ) {
      errors.push({
        field: `${path}.point.radiusMeters`,
        message: `must be between ${WHERE_POINT_RADIUS_MIN_M} and ${WHERE_POINT_RADIUS_MAX_M} meters`,
      });
    }
    if (errors.length === before) {
      const point: WherePoint = { coord, radiusMeters };
      const trimmed = name?.trim();
      if (trimmed) point.name = trimmed;
      normalized.point = point;
    }
  }

  if (errors.length > before) return null;
  if (Object.keys(normalized).length === 0) {
    errors.push({ field: path, message: 'says nothing — omit it for the whole body' });
    return null;
  }
  return normalized;
}

/** Is this sector one of the eight compass wedges (as opposed to middle, near shore, head, mouth)? */
export function isCompassSector(sector: Sector): sector is (typeof COMPASS_SECTORS)[number] {
  return (COMPASS_SECTORS as readonly string[]).includes(sector);
}

/**
 * A `where` in words — "patches, north end of Malletts Bay", "near shore", "off Shelburne Point" —
 * for a chip's or a reading's line on the sheet and on the detail. `bayNames` resolves a bay id
 * to its name; without it (or for a bay that is gone) the bay is left unsaid rather than shown as
 * an id. Empty string for a `where` that says nothing the reader can use.
 */
const COMPASS_WORDS: Record<(typeof COMPASS_SECTORS)[number], string> = {
  N: 'north',
  NE: 'northeast',
  E: 'east',
  SE: 'southeast',
  S: 'south',
  SW: 'southwest',
  W: 'west',
  NW: 'northwest',
};

export function describeWhere(where: Where, bayNames?: Readonly<Record<string, string>>): string {
  const parts: string[] = [];
  if (where.extent && where.extent !== 'whole') parts.push(where.extent);
  const bay = where.subAreaId !== undefined ? bayNames?.[where.subAreaId] : undefined;
  if (where.sector) {
    const sector =
      where.sector === 'middle' || where.sector === 'near_shore'
        ? humanizeEnum(where.sector).toLowerCase()
        : where.sector === 'head' || where.sector === 'mouth'
          ? `the ${where.sector}`
          : `${COMPASS_WORDS[where.sector]} end`;
    parts.push(bay ? `${sector} of ${bay}` : sector);
  } else if (bay) {
    parts.push(bay);
  }
  if (where.point?.name) parts.push(where.point.name);
  return parts.join(' ');
}

/** A located chip's line — "Black ice, north end". The type alone when the `where` says nothing. */
export function describeLocatedChip(
  chip: { type: string; where?: Where },
  bayNames?: Readonly<Record<string, string>>,
): string {
  const label = humanizeEnum(chip.type);
  const where = chip.where ? describeWhere(chip.where, bayNames) : '';
  return where ? `${label}, ${where}` : label;
}
