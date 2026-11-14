/**
 * **How complete a body's record is** (the founder's list, Review 13; D255): ten things a body has
 * or lacks, in a fixed order. The mock notes listed twelve; Review 13 ruled out posted rules (rules
 * are optional — most bodies rightly have none) and weather sample points (they default to the
 * interior point, so every body has them).
 *
 * The rule is pure: it reads the body's own fields and three counts the caller has (its put-ins,
 * lots and landmarks), and whether contours were drawn for it. Storing it per body is a later
 * server batch; the pages call this until then.
 */

/** The ten, in the order every page lists them. */
export const COMPLETENESS_FIELDS = [
  'outline',
  'name',
  'access',
  'depth',
  'elevation',
  'wind',
  'putIns',
  'lots',
  'landmarks',
  'bathymetry',
] as const;
export type CompletenessField = (typeof COMPLETENESS_FIELDS)[number];

/** What the rule reads: the body's fields (as stored) and what the caller counted beside it. */
export interface CompletenessInput {
  /** The stored outline (`waterBodies.polygon`). */
  polygon: { type: string; coordinates: unknown } | null | undefined;
  name: string;
  /** A moderator's public-access ruling (A06f). */
  publicAccess?: { verdict: string } | null | undefined;
  /** The easiest approach, derived from the body's put-ins (A06e). */
  accessKind?: string | null | undefined;
  maxDepthM?: number | null | undefined;
  meanDepthM?: number | null | undefined;
  elevationM?: number | null | undefined;
  /** The winter wind rose (A06c): one share per sector. */
  windRose?: readonly number[] | null | undefined;
  /** Visible put-ins on the body. */
  putIns: number;
  /** Parking areas linked to it (`parkingAreaBodies`). */
  lots: number;
  /** Live landmarks on it. */
  landmarks: number;
  /** Whether contours were drawn for it (`bathymetryCoverage`). */
  hasContours: boolean;
}

const finite = (n: number | null | undefined) => typeof n === 'number' && Number.isFinite(n);

/** An outline with at least one ring of a closed shape: four positions (the first repeated last). */
function hasOutline(polygon: CompletenessInput['polygon']): boolean {
  if (!polygon || !Array.isArray(polygon.coordinates)) return false;
  const rings: unknown[] =
    polygon.type === 'MultiPolygon'
      ? (polygon.coordinates as unknown[][]).flat()
      : (polygon.coordinates as unknown[]);
  return rings.some((ring) => Array.isArray(ring) && ring.length >= 4);
}

/**
 * Each field's "has it":
 *
 * - **outline** — a stored outline with a closed ring;
 * - **name** — a name that isn't blank (19,610 catalog rows carry none);
 * - **access** — a moderator's public-access ruling, or an approach the put-ins establish;
 * - **depth** — a maximum or a mean depth;
 * - **elevation** — a surface elevation;
 * - **wind** — a winter wind rose with at least one sector;
 * - **put-ins**, **lots**, **landmarks** — at least one;
 * - **bathymetry** — contours drawn for it.
 */
export const COMPLETENESS_RULES: Record<CompletenessField, (b: CompletenessInput) => boolean> = {
  outline: (b) => hasOutline(b.polygon),
  name: (b) => b.name.trim().length > 0,
  access: (b) => b.publicAccess?.verdict != null || (b.accessKind ?? null) !== null,
  depth: (b) => finite(b.maxDepthM) || finite(b.meanDepthM),
  elevation: (b) => finite(b.elevationM),
  wind: (b) => (b.windRose?.length ?? 0) > 0,
  putIns: (b) => b.putIns > 0,
  lots: (b) => b.lots > 0,
  landmarks: (b) => b.landmarks > 0,
  bathymetry: (b) => b.hasContours,
};

/** How many of the ten a body has, and which it lacks, in the fixed order. */
export function bodyCompleteness(body: CompletenessInput): {
  have: number;
  of: number;
  missing: CompletenessField[];
} {
  const missing = COMPLETENESS_FIELDS.filter((field) => !COMPLETENESS_RULES[field](body));
  return {
    have: COMPLETENESS_FIELDS.length - missing.length,
    of: COMPLETENESS_FIELDS.length,
    missing,
  };
}
