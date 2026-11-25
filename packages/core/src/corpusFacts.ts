/**
 * **The words a Corpus task's facts are said in** (B01-6a): what each class would do with a body
 * (board 4.3's ladder), a catalog's rank as a name authority, and how two names differ (board 4.2's
 * tabs, by the writer's own rule in `corpusFacets.ts`). The reads (`convex/corpusTasks.ts`) say every fact through these, so a word means one
 * thing wherever it is drawn.
 *
 * **No word here says or implies anything about the ice** (D3): a class's consequence is what the
 * app does with the body — it stays, the size rules refuse it, it waits for a parent — never how the
 * water freezes or whether it can be skated. `corpusFacts.test.ts` holds every word to that.
 */

import type { ClaimSource } from './confidence';
import { type NameFacet, splitOfNames } from './corpusFacets';
import { NAME_SOURCE_RANK } from './nameClaims';
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
    return {
      kind: 'stays',
      words: `Stays, as ${STAYS_AS[cls]}: no area is on file for the size rules`,
    };
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
    return {
      kind: 'waitsForParent',
      words: `Waits for a parent: a bay needs a lake to hold it${asked}`,
    };
  }
  return { kind: 'stays', words: `Stays, as ${STAYS_AS[cls]}${asked}` };
}

// ── How two names differ ───────────────────────────────────────────────────────────────────────

/** How two names differ, the Name conflicts lane's tabs (S1's `NameFacet`, one type). */
export type NameSplit = NameFacet;

/** Each split as the lane's tabs and rows say it. */
export const NAME_SPLIT_WORDS: Readonly<Record<NameSplit, string>> = {
  different: 'Different',
  oneLetter: 'One letter',
  qualifier: 'Qualifier',
};

/**
 * How the shown name and the other claim differ: **the rule the writer files a task's tab by**
 * (`corpusFacets.splitOfNames`), so a row's tab and the words its inspector says can't disagree.
 * *Qualifier*: every word of the shorter is in the longer; *One letter*: one letter added, dropped or
 * changed; else *Different*. Symmetric in its two names.
 */
export function nameSplit(shown: string, other: string): NameSplit {
  return splitOfNames(shown, other);
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
