/**
 * **The words a Corpus task's facts are said in** (B01-6a): what each class would do with a body
 * (board 4.3's ladder), a catalog's rank as a name authority, and how two names differ (board 4.2's
 * tabs). The reads (`convex/corpusTasks.ts`) say every fact through these, so a word means one
 * thing wherever it is drawn.
 *
 * **No word here says or implies anything about the ice** (D3): a class's consequence is what the
 * app does with the body — it stays, the size rules refuse it, it waits for a parent — never how the
 * water freezes or whether it can be skated. `corpusFacts.test.ts` holds every word to that.
 */

import type { ClaimSource } from './confidence';
import { NAME_SOURCE_RANK, type NameClaim } from './nameClaims';
import {
  belongsInCorpus,
  HARD_MIN_SURFACE_AREA_ACRES,
  HARD_MIN_SURFACE_AREA_SQM,
  isWetlandClass,
  MIN_SURFACE_AREA_ACRES,
  MIN_SURFACE_AREA_SQM,
  UNNAMED_WETLAND_MIN_ACRES,
} from './osm';
import type { WaterBodyClass } from './types';

// ── What each class would do ─────────────────────────────────────────────────────────────────────

/** What the app does with a body under a class: it stays, the size rules refuse it, or it waits for a parent. */
export type ClassConsequenceKind = 'stays' | 'leaves' | 'waitsForParent';
export type ClassConsequence = { kind: ClassConsequenceKind; words: string };

/** The body facts a consequence is read from (`belongsInCorpus`' inputs). */
export type ConsequenceBody = {
  name: string;
  /**
   * The area the admission rules read (`sourceAreaSqM`, else `surfaceAreaSqM`, as the floor's prune
   * does). `null`: none on file — the prune keeps such a body, and the words say why.
   */
  surfaceAreaSqM: number | null;
  includedByRequest?: boolean | undefined;
};

/** How each class is named when a body stays under it ("Stays, as a reservoir"). */
const STAYS_AS: Readonly<Record<WaterBodyClass, string>> = {
  lakePond: 'a lake or pond',
  wetland: 'a wetland',
  reservoir: 'a reservoir',
  bay: 'a bay',
  river: 'a slow river reach',
  unclassified: 'water no catalog classed',
};

/** Why the size rules refuse a body under a class, as the ladder says it. */
function refusedAs(body: { name: string; areaSqM: number }, cls: WaterBodyClass): string {
  const named = body.name.trim().length > 0;
  const wetland = isWetlandClass(cls);
  if (body.areaSqM < HARD_MIN_SURFACE_AREA_SQM) {
    return `water under ${HARD_MIN_SURFACE_AREA_ACRES} ac`;
  }
  if (body.areaSqM < MIN_SURFACE_AREA_SQM) {
    const what = wetland ? (named ? 'wetland' : 'unnamed wetland') : 'unnamed water';
    return `${what} under ${MIN_SURFACE_AREA_ACRES} ac`;
  }
  return `unnamed wetland under ${UNNAMED_WETLAND_MIN_ACRES} ac`;
}

/**
 * What setting `cls` on `body` would do — one rung of *What each class would do*, from
 * `belongsInCorpus`, the rule the import and the floor's prune both read:
 *
 * - the size rules refuse it (`leaves`): "Refused by the size rules next campaign, as unnamed
 *   wetland under 50 ac" — the rule's verdict, which the floor's prune acts on at the next campaign
 *   unless something on the body keeps it (the prune's own exemptions, not this rule's);
 * - a bay the rules admit `waitsForParent`: a bay is drawn as an arm of a lake;
 * - else it `stays`, "Stays, as a reservoir" — with "someone asked for it" when only a request
 *   admits it (`includedByRequest` outranks every rule).
 *
 * A body with no area on file stays: the prune keeps it, since "we can't measure it" is not "it's
 * small".
 */
export function classConsequence(body: ConsequenceBody, cls: WaterBodyClass): ClassConsequence {
  const area = body.surfaceAreaSqM;
  if (area === null || !Number.isFinite(area)) {
    return { kind: 'stays', words: `Stays, as ${STAYS_AS[cls]}: no area is on file for the size rules` };
  }
  const byRule = belongsInCorpus({ name: body.name, surfaceAreaSqM: area, type: cls });
  if (!byRule && body.includedByRequest !== true) {
    return {
      kind: 'leaves',
      words: `Refused by the size rules next campaign, as ${refusedAs({ name: body.name, areaSqM: area }, cls)}`,
    };
  }
  const asked = byRule ? '' : ': someone asked for it';
  if (cls === 'bay') {
    return { kind: 'waitsForParent', words: `Waits for a parent: a bay needs a lake to hold it${asked}` };
  }
  return { kind: 'stays', words: `Stays, as ${STAYS_AS[cls]}${asked}` };
}

// ── How two names differ ───────────────────────────────────────────────────────────────────────

/** How two names differ, the Name conflicts lane's tabs. */
export type NameSplit = 'different' | 'oneLetter' | 'qualifier';

/** Each split as the lane's tabs and rows say it. */
export const NAME_SPLIT_WORDS: Readonly<Record<NameSplit, string>> = {
  different: 'Different',
  oneLetter: 'One letter',
  qualifier: 'Qualifier',
};

/**
 * The words that qualify a name rather than make it: what kind of water, which end, which size, an
 * article. Two names whose other words are the same differ by a *qualifier* ("Kezar Pond" and
 * "Upper Kezar Pond", "Lake Auburn" and "Auburn Lake").
 */
export const NAME_QUALIFIER_WORDS: ReadonlySet<string> = new Set([
  'the',
  'of',
  'lake',
  'lakes',
  'pond',
  'ponds',
  'pool',
  'reservoir',
  'basin',
  'bay',
  'cove',
  'flowage',
  'upper',
  'lower',
  'middle',
  'north',
  'south',
  'east',
  'west',
  'big',
  'little',
  'great',
]);

/**
 * A name folded for comparing: lower case, accents dropped, an apostrophe or a period dropped
 * ("Harvey's" and "Harveys" are one word), any other punctuation a space, spaces collapsed.
 */
function folded(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Whether `a` becomes `b` by at most one inserted, deleted or changed character. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  // Past the first difference the rest must match: a change skips one of each, an insert one of the longer.
  const skip = short.length === long.length ? 1 : 0;
  return short.slice(i + skip) === long.slice(i + 1);
}

/** A name's own words, its qualifiers aside, in order of spelling (so word order is no difference). */
function coreWords(name: string): string[] {
  return folded(name)
    .split(' ')
    .filter((w) => w !== '' && !NAME_QUALIFIER_WORDS.has(w))
    .sort();
}

/**
 * How the shown name and the other claim differ — the lane's tabs, one rule:
 *
 * - `oneLetter`: one letter apart once case, accents, apostrophes and spacing are set aside
 *   ("Damariscotta" and "Damariscota"; two spellings that fold to the same are one letter apart too);
 * - `qualifier`: the same words but for {@link NAME_QUALIFIER_WORDS}, in any order ("Lake Auburn"
 *   and "Auburn Lake", "Kezar Pond" and "Upper Kezar Pond") — and at least one word of its own;
 * - `different`: anything else ("The Basin" and "Lake Auburn").
 *
 * Symmetric: the order the two are given in never changes the answer.
 */
export function nameSplit(shown: string, other: string): NameSplit {
  const a = folded(shown);
  const b = folded(other);
  if (withinOneEdit(a, b)) return 'oneLetter';
  const ca = coreWords(shown);
  const cb = coreWords(other);
  if (ca.length > 0 && ca.length === cb.length && ca.every((w, i) => w === cb[i])) {
    return 'qualifier';
  }
  return 'different';
}

/**
 * The name a body could show instead: the best-ranked catalog claim (`NAME_SOURCE_RANK`) whose
 * spelling isn't the shown one, case and spacing aside. A moderator's own claim is never the other
 * name — it is a choice already made. `null` when no catalog claims another spelling.
 */
export function otherNameOf(shown: string, claims: readonly NameClaim[] | undefined): string | null {
  const key = (s: string) => s.trim().toLowerCase();
  const shownKey = key(shown);
  let best: NameClaim | null = null;
  for (const claim of claims ?? []) {
    if (claim.source === 'user' || claim.value.trim() === '' || key(claim.value) === shownKey) {
      continue;
    }
    if (best === null || NAME_SOURCE_RANK[claim.source] < NAME_SOURCE_RANK[best.source]) best = claim;
  }
  return best === null ? null : best.value.trim();
}

// ── A catalog's rank, in words ────────────────────────────────────────────────────────────────

/** What each source's name is, after its place in the ranking. */
const RANK_WHAT: Readonly<Record<ClaimSource, string>> = {
  gnis: 'the authority on US names',
  nhd: "the gazetteer's name, as NHD publishes it",
  '3dhp': "the gazetteer's name, a later release",
  osm: "a mapper's free text",
  user: "a moderator's choice",
  name: "a word read from a catalog's name",
};

/** The ordinals for a catalog's place among the catalogs, the last one said as *Last*. */
const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth'] as const;

/**
 * The catalogs that publish names, best first: every source `NAME_SOURCE_RANK` places at zero or
 * after, but `name` — not a catalog, a keyword read off a string a catalog supplied.
 */
const RANKED_CATALOGS: readonly ClaimSource[] = (Object.keys(NAME_SOURCE_RANK) as ClaimSource[])
  .filter((s) => s !== 'name' && NAME_SOURCE_RANK[s] >= 0)
  .sort((a, b) => NAME_SOURCE_RANK[a] - NAME_SOURCE_RANK[b]);

/**
 * A catalog's place in `NAME_SOURCE_RANK`, in words: "First: the authority on US names" … "Last: a
 * mapper's free text". A moderator's claim is above every catalog; `name` is not a catalog. The
 * ordinal is read from the ranking, so a change to it re-words every catalog by itself.
 */
export function nameRankWords(source: ClaimSource): string {
  if (source === 'user') return `Above every catalog: ${RANK_WHAT.user}`;
  const at = RANKED_CATALOGS.indexOf(source);
  if (at < 0) return `Not a catalog: ${RANK_WHAT[source]}`;
  const ordinal = at === RANKED_CATALOGS.length - 1 ? 'Last' : (ORDINALS[at] ?? `Number ${at + 1}`);
  return `${ordinal}: ${RANK_WHAT[source]}`;
}
