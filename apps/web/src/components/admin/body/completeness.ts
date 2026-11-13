import type { LedSegment } from '@/components/kit/trace-chart';

/**
 * **How complete a body's record is** — the founder's ten (Review 13), in the order every page
 * lists them: outline, name, access, depth, elevation, wind, put-ins, lots, landmarks, bathymetry.
 * Posted rules don't count (most bodies rightly have none), nor do weather sample points (they
 * default to the interior point, so every body has them).
 *
 * **One module, both pages:** the Bodies list (its rows, its facet, its preview) and the Body
 * console (its strip, its note, the tabs' amber squares) read completeness only from here.
 *
 * ⚠ **Interim.** This mirrors `@skating/core`'s `bodyCompleteness` (`COMPLETENESS_FIELDS`,
 * `COMPLETENESS_RULES`), which is being added on the server branch and is the one rule. When that
 * branch lands, this module is replaced by it: the field list and the rules import from core, and
 * only what core doesn't say — a field's words, its tab, and *unknown* for a fact no read on the
 * page serves yet — stays here. Until then the rules below are core's, line for line.
 *
 * **Unknown is not missing.** A count the page has no read for (`null`) is *unknown*: drawn dashed
 * on the strip, never counted, and never named in the "Missing …" note — so a gap in the reads
 * never reads as a gap in the record, and never as a zero.
 */

/** The ten, in the order every page lists them (core's `COMPLETENESS_FIELDS`). */
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

/** How many things every body should have. */
export const COMPLETENESS_FIELD_COUNT = COMPLETENESS_FIELDS.length;

/** Each field in the note's words: "Missing bathymetry, a lot and a landmark". */
export const COMPLETENESS_WORDS: Record<CompletenessField, string> = {
  outline: 'an outline',
  name: 'a name',
  access: 'access',
  depth: 'depth',
  elevation: 'elevation',
  wind: 'wind',
  putIns: 'a put-in',
  lots: 'a lot',
  landmarks: 'a landmark',
  bathymetry: 'bathymetry',
};

/** The Body console tab that holds each field — where its amber square goes. */
export const COMPLETENESS_TABS: Record<
  CompletenessField,
  'shape' | 'names' | 'places' | 'access' | 'water'
> = {
  outline: 'shape',
  name: 'names',
  access: 'access',
  depth: 'water',
  elevation: 'water',
  wind: 'water',
  putIns: 'access',
  lots: 'access',
  landmarks: 'places',
  bathymetry: 'water',
};

/**
 * What the rule reads: the body's own fields (as stored) and what the page counted beside it. A
 * count is `null` when the page has no read for it — the field is then unknown, not missing.
 */
export interface CompletenessFacts {
  /** The stored outline (`waterBodies.polygon`). */
  polygon: { type: string; coordinates: unknown } | null | undefined;
  name: string;
  /** A moderator's public-access ruling. */
  publicAccess?: { verdict: string } | null | undefined;
  /** The easiest approach, derived from the body's put-ins. */
  accessKind?: string | null | undefined;
  maxDepthM?: number | null | undefined;
  meanDepthM?: number | null | undefined;
  elevationM?: number | null | undefined;
  /** The winter wind rose: one share per sector. */
  windRose?: readonly number[] | null | undefined;
  /** Visible put-ins on the body; `null` when unread. */
  putIns: number | null;
  /** Parking areas linked to it; `null` when unread. */
  lots: number | null;
  /** Live landmarks on it; `null` when unread. */
  landmarks: number | null;
  /** Whether contours were drawn for it; `null` when unread. */
  hasContours: boolean | null;
}

export type CompletenessState = 'present' | 'missing' | 'unknown';

export interface CompletenessItem {
  field: CompletenessField;
  state: CompletenessState;
}

const finite = (n: number | null | undefined) => typeof n === 'number' && Number.isFinite(n);

/** An outline with at least one ring of a closed shape: four positions (the first repeated last). */
function hasOutline(polygon: CompletenessFacts['polygon']): boolean {
  if (!polygon || !Array.isArray(polygon.coordinates)) return false;
  const rings: unknown[] =
    polygon.type === 'MultiPolygon'
      ? (polygon.coordinates as unknown[][]).flat()
      : (polygon.coordinates as unknown[]);
  return rings.some((ring) => Array.isArray(ring) && ring.length >= 4);
}

const known = (has: boolean): CompletenessState => (has ? 'present' : 'missing');
const counted = (n: number | null): CompletenessState => (n === null ? 'unknown' : known(n > 0));

/** Each field's state (core's `COMPLETENESS_RULES`, with *unknown* for an unread count). */
const RULES: Record<CompletenessField, (b: CompletenessFacts) => CompletenessState> = {
  outline: (b) => known(hasOutline(b.polygon)),
  name: (b) => known(b.name.trim().length > 0),
  access: (b) => known(b.publicAccess?.verdict != null || (b.accessKind ?? null) !== null),
  depth: (b) => known(finite(b.maxDepthM) || finite(b.meanDepthM)),
  elevation: (b) => known(finite(b.elevationM)),
  wind: (b) => known((b.windRose?.length ?? 0) > 0),
  putIns: (b) => counted(b.putIns),
  lots: (b) => counted(b.lots),
  landmarks: (b) => counted(b.landmarks),
  bathymetry: (b) => (b.hasContours === null ? 'unknown' : known(b.hasContours)),
};

/** The ten, each with its state, in the fixed order. */
export function completenessItems(facts: CompletenessFacts): CompletenessItem[] {
  return COMPLETENESS_FIELDS.map((field) => ({ field, state: RULES[field](facts) }));
}

/** What a page draws: how many it has, of how many, what's missing and what can't be said yet. */
export interface Completeness {
  have: number;
  of: number;
  missing: readonly CompletenessField[];
  unknown: readonly CompletenessField[];
}

/** The items, counted. */
export function summarizeCompleteness(items: readonly CompletenessItem[]): Completeness {
  return {
    have: items.filter((i) => i.state === 'present').length,
    of: items.length,
    missing: items.filter((i) => i.state === 'missing').map((i) => i.field),
    unknown: items.filter((i) => i.state === 'unknown').map((i) => i.field),
  };
}

/** A body's completeness from its facts. */
export function completenessOf(facts: CompletenessFacts): Completeness {
  return summarizeCompleteness(completenessItems(facts));
}

/** The strip's segments, in the fixed order: lit, dark, or dashed for unknown. */
export function completenessSegments(c: Completeness): LedSegment[] {
  return COMPLETENESS_FIELDS.slice(0, c.of).map((field) =>
    c.missing.includes(field) ? 'off' : c.unknown.includes(field) ? 'unknown' : 'on',
  );
}

/** "Missing bathymetry", "Missing depth and bathymetry", "Missing wind, depth and bathymetry". */
export function missingSentence(missing: readonly CompletenessField[]): string | null {
  if (missing.length === 0) return null;
  const words = missing.map((f) => COMPLETENESS_WORDS[f]);
  const list =
    words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
  return `Missing ${list}`;
}
