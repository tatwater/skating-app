/**
 * **The Bodies library's rules** (B01-3) — the lanes, scopes, facet options and sort keys of the
 * stored per-body library row, and the arithmetic that keeps its counts the tally of its rows.
 *
 * Pure, so the server's one writer of a row (`lib/bodyLibrary.ts` in the Convex package) and the
 * console agree on every option id: they are the ids the page's facets and lanes already use.
 *
 * **`null` is "not recorded"** wherever a fact can lack a source (an area nobody measured): it falls
 * under no facet option, and its sort keys put it last whichever way a column sorts.
 */

import { type StandingInput, standingOf } from './standing';
import { WATER_BODY_CLASSES, type WaterBodyClass } from './types';

// ── Standing and lanes ───────────────────────────────────────────────────────────────────────

/** Where a body stands, as the library files it (a row's standing). */
export const LIBRARY_STANDINGS = [
  'active',
  'inactive',
  'not_in_campaign',
  'moderator',
  'no_public_access',
  'removed',
  'rejected',
] as const;
export type LibraryStanding = (typeof LIBRARY_STANDINGS)[number];

/** The standing lanes: one per standing, removed and rejected sharing one. */
export const LIBRARY_LANES = [
  'active',
  'inactive',
  'not_in_campaign',
  'moderator',
  'no_public_access',
  'removed',
] as const;
export type LibraryLane = (typeof LIBRARY_LANES)[number];

/** What a list read can be asked for: a standing lane, every body, or those changed lately. */
export const LIBRARY_LIST_LANES = ['all', ...LIBRARY_LANES, 'changed'] as const;
export type LibraryListLane = (typeof LIBRARY_LIST_LANES)[number];

/**
 * A body's library standing, or `null` for a merged body — it has no standing of its own (reads
 * follow the survivor), so it has no row.
 */
export function libraryStandingOf(body: StandingInput): LibraryStanding | null {
  if (body.dedupStatus === 'merged') return null;
  const s = standingOf(body);
  switch (s.standing) {
    case 'unlisted':
      return 'rejected';
    case 'removed':
      return 'removed';
    case 'active':
      return 'active';
    case 'dormant':
      return s.reason;
  }
}

/** The lane a standing is filed under. */
export function laneOf(standing: LibraryStanding): LibraryLane {
  return standing === 'rejected' ? 'removed' : standing;
}

// ── Scopes: the state tabs ───────────────────────────────────────────────────────────────────

/** The scope of the row that lists a body under *All* states. */
export const SCOPE_ALL = '*';

/** The scopes a body is listed under: every state, and `*`. A malformed state code is dropped. */
export function libraryScopes(states: readonly string[] | undefined): string[] {
  const codes = new Set<string>();
  for (const s of states ?? []) {
    const code = s.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) codes.add(code);
  }
  return [SCOPE_ALL, ...[...codes].sort()];
}

// ── Facets ───────────────────────────────────────────────────────────────────────────────────

export const SIZE_OPTIONS = ['under-10', '10-100', '100-1000', '1000-up'] as const;
export type SizeOption = (typeof SIZE_OPTIONS)[number];

export const COMPLETE_OPTIONS = ['all', 'most', 'under-8'] as const;
export type CompleteOption = (typeof COMPLETE_OPTIONS)[number];

export const OUTLINE_OPTIONS = ['catalog', 'drawn'] as const;
export type OutlineOption = (typeof OUTLINE_OPTIONS)[number];

/** Every facet and its options, in the menu's order — the page's ids. */
export const LIBRARY_FACETS = {
  class: WATER_BODY_CLASSES,
  size: SIZE_OPTIONS,
  outline: OUTLINE_OPTIONS,
  putins: ['some', 'none'],
  reports: ['season', 'never'],
  complete: COMPLETE_OPTIONS,
  curation: ['curated', 'asks', 'intake', 'enrichment'],
} as const;
export type LibraryFacet = keyof typeof LIBRARY_FACETS;
export const LIBRARY_FACET_IDS = Object.keys(LIBRARY_FACETS) as LibraryFacet[];

/** Facets a body can fall under more than one option of: their option counts don't sum to a total. */
export const MULTI_VALUED_FACETS: readonly LibraryFacet[] = ['curation'];

/** What is chosen: option ids per facet. A facet absent or empty doesn't narrow. */
export type LibraryFacetSelection = Partial<Record<LibraryFacet, readonly string[]>>;

const SQM_PER_ACRE = 4046.8564224;

/** The size option an area falls under; `null` when no area is recorded. */
export function sizeOption(areaSqM: number | null | undefined): SizeOption | null {
  if (areaSqM == null || !Number.isFinite(areaSqM) || areaSqM <= 0) return null;
  const acres = areaSqM / SQM_PER_ACRE;
  if (acres < 10) return 'under-10';
  if (acres < 100) return '10-100';
  if (acres < 1000) return '100-1000';
  return '1000-up';
}

/** Completeness as the facet files it: all of them, eight or more, or fewer. */
export function completeOption(have: number, of: number): CompleteOption {
  if (have >= of) return 'all';
  if (have >= 8) return 'most';
  return 'under-8';
}

/** The facts a row's facet options are read from. */
export interface LibraryFacetFacts {
  bodyClass: WaterBodyClass;
  areaSqM: number | null;
  outline: OutlineOption;
  hasPutIns: boolean;
  /** Reports in the current season's record. */
  reports: number;
  everReported: boolean;
  completeHave: number;
  completeOf: number;
  curated: boolean;
  asks: number;
  intake: boolean;
  awaitingEnrichment: boolean;
}

/** The options of each facet a body falls under. */
export function facetOptionsOf(f: LibraryFacetFacts): Record<LibraryFacet, string[]> {
  const size = sizeOption(f.areaSqM);
  return {
    class: [f.bodyClass],
    size: size === null ? [] : [size],
    outline: [f.outline],
    putins: [f.hasPutIns ? 'some' : 'none'],
    reports: [...(f.reports > 0 ? ['season'] : []), ...(f.everReported ? [] : ['never'])],
    complete: [completeOption(f.completeHave, f.completeOf)],
    curation: [
      ...(f.curated ? ['curated'] : []),
      ...(f.asks > 0 ? ['asks'] : []),
      ...(f.intake ? ['intake'] : []),
      ...(f.awaitingEnrichment ? ['enrichment'] : []),
    ],
  };
}

/** The count key of the lane's total. */
export const TOTAL_KEY = 'total';

/** A count key for one facet option: `size:1000-up`. */
export const facetKey = (facet: LibraryFacet, option: string) => `${facet}:${option}`;

/** Every count key a row adds one to: the total and each facet option it falls under. */
export function countKeysOf(f: LibraryFacetFacts): string[] {
  const options = facetOptionsOf(f);
  return [
    TOTAL_KEY,
    ...LIBRARY_FACET_IDS.flatMap((facet) => options[facet].map((o) => facetKey(facet, o))),
  ];
}

/** Whether a body passes a selection: any option within a facet, every facet together. */
export function matchesFacets(f: LibraryFacetFacts, selection: LibraryFacetSelection): boolean {
  const options = facetOptionsOf(f);
  return LIBRARY_FACET_IDS.every((facet) => {
    const chosen = selection[facet];
    if (chosen === undefined || chosen.length === 0) return true;
    return chosen.some((c) => options[facet].includes(c));
  });
}

/** The applied facets, in the menu's order, with their known options only. */
export function appliedFacets(selection: LibraryFacetSelection): LibraryFacet[] {
  return LIBRARY_FACET_IDS.filter((facet) =>
    (selection[facet] ?? []).some((o) => (LIBRARY_FACETS[facet] as readonly string[]).includes(o)),
  );
}

/**
 * Which facets' counts the stored counts answer exactly, and whether they give the list's total.
 *
 * A facet's counts are what each option would leave **with the other facets as they are**; the
 * stored counts hold each option over a whole lane and scope, so they answer a facet exactly only
 * while no *other* facet is applied. The total is exact with nothing applied, or with one facet
 * whose options a body falls under at most one of (their counts sum).
 */
export function servedCounts(selection: LibraryFacetSelection): {
  facets: LibraryFacet[];
  total: boolean;
} {
  const applied = appliedFacets(selection);
  if (applied.length === 0) return { facets: [...LIBRARY_FACET_IDS], total: true };
  if (applied.length === 1) {
    const only = applied[0] as LibraryFacet;
    return { facets: [only], total: !MULTI_VALUED_FACETS.includes(only) };
  }
  return { facets: [], total: false };
}

// ── The counts: the tally of the rows ────────────────────────────────────────────────────────

/** What one body adds to the counts: its lane, the scopes it is listed under, and its keys. */
export interface CountFootprint {
  lane: LibraryLane;
  scopes: readonly string[];
  keys: readonly string[];
}

/** The lane every body also counts under. */
export const ALL_LANE = 'all';

/** A count's address: lane, scope and key, joined with a character none of them holds. */
export const countAddress = (lane: string, scope: string, key: string) =>
  `${lane}\u0001${scope}\u0001${key}`;

/** The parts of a {@link countAddress}. */
export function parseCountAddress(address: string): { lane: string; scope: string; key: string } {
  const [lane = '', scope = '', key = ''] = address.split('\u0001');
  return { lane, scope, key };
}

function addresses(fp: CountFootprint): string[] {
  const out: string[] = [];
  for (const lane of [ALL_LANE, fp.lane]) {
    for (const scope of fp.scopes) {
      for (const key of fp.keys) out.push(countAddress(lane, scope, key));
    }
  }
  return out;
}

/**
 * What a row's change does to the counts: `-1` at each address it left, `+1` at each it joined,
 * nothing where it stayed. `null` is no row (a new body, or one gone).
 */
export function countDeltas(
  before: CountFootprint | null,
  after: CountFootprint | null,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of before === null ? [] : addresses(before)) out.set(a, (out.get(a) ?? 0) - 1);
  for (const a of after === null ? [] : addresses(after)) out.set(a, (out.get(a) ?? 0) + 1);
  for (const [a, d] of out) if (d === 0) out.delete(a);
  return out;
}

/** The counts a set of footprints adds up to — what the stored counts must always equal. */
export function tallyCounts(footprints: readonly CountFootprint[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const fp of footprints) {
    for (const a of addresses(fp)) out.set(a, (out.get(a) ?? 0) + 1);
  }
  return out;
}

// ── Sort keys ────────────────────────────────────────────────────────────────────────────────

/** The key an unknown takes in an ascending order: after every real value. */
export const UNKNOWN_LAST_ASC = Number.MAX_VALUE;
/** The key an unknown takes in a descending order: after every real value (all are ≥ 0). */
export const UNKNOWN_LAST_DESC = -1;

/** The two keys a value that can be unknown sorts by, so an unknown is last either way. */
export function unknownLastKeys(value: number | null | undefined): { asc: number; desc: number } {
  if (value == null || !Number.isFinite(value)) {
    return { asc: UNKNOWN_LAST_ASC, desc: UNKNOWN_LAST_DESC };
  }
  return { asc: value, desc: value };
}

/** The name as the list sorts it. */
export const nameSortKey = (name: string) => name.trim().toLocaleLowerCase('en-US');

// ── Search ───────────────────────────────────────────────────────────────────────────────────

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US');

/** Whether every word of `q` starts a word of `text` (case and accents aside). */
export function textMatches(text: string, q: string): boolean {
  const words = fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const terms = fold(q)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (terms.length === 0) return false;
  return terms.every((t) => words.some((w) => w.startsWith(t)));
}

/**
 * The alias a search matched where the name didn't — the row's "Morgan Pond" — or `undefined` when
 * the name matches (or nothing does: the hit came from an id).
 */
export function matchedAlias(
  name: string,
  aliases: readonly string[],
  q: string,
): string | undefined {
  if (q.trim() === '' || textMatches(name, q)) return undefined;
  return aliases.find((a) => textMatches(a, q));
}

/** The search text a row is found by: its name, aliases and ids, one per line. */
export function librarySearchText(
  name: string,
  aliases: readonly string[],
  ids: readonly string[],
) {
  return [name, ...aliases, ...ids].filter((s) => s.trim() !== '').join('\n');
}

// ── Pages ────────────────────────────────────────────────────────────────────────────────────

/** Rows a page of the list holds. */
export const LIBRARY_PAGE_SIZE = 50;
/**
 * The most a first page may ask for — a return from a body reloads as many rows as were showing,
 * up to this. Rows are small (about half a kilobyte), so this is a few hundred kilobytes.
 */
export const LIBRARY_MAX_START = 400;

/** A requested page size, held to one row and the library's most. */
export function clampPageSize(n: number): number {
  if (!Number.isFinite(n)) return LIBRARY_PAGE_SIZE;
  return Math.min(LIBRARY_MAX_START, Math.max(1, Math.floor(n)));
}
