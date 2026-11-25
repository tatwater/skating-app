/**
 * **The words a Corpus task's facts are said in** (B01-6a): what each class would do with a body
 * (board 4.3's ladder), a catalog's rank as a name authority, and how two names differ (board 4.2's
 * tabs, by the writer's own rule in `corpusFacets.ts`). The reads (`convex/corpusTasks.ts`) say every fact through these, so a word means one
 * thing wherever it is drawn: the ladder's rungs and a list row's consequence line are one rule
 * (`classConsequence`), and a neighbor's distance and bearing are measured here too.
 *
 * **No word here says or implies anything about the ice** (D3): a class's consequence is what the
 * app does with the body — it stays, the size rules refuse it, it waits for a parent — never how the
 * water freezes or whether it can be skated. `corpusFacts.test.ts` holds every word to that.
 */

import type { ClaimSource } from './confidence';
import { type NameFacet, splitOfNames } from './corpusFacets';
import { bearingDegrees, haversineMeters, type LatLng } from './geometry';
import { fetchOrigin } from './lakeGeometry';
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
export type ClassConsequence = {
  kind: ClassConsequenceKind;
  words: string;
  /**
   * The consequence's lead words, the start of `words` (board 4.3 brightens a refusal's alone):
   * "Refused by the size rules", "Stays", "Waits for a parent" — {@link CONSEQUENCE_LEAD}'s.
   */
  lead: string;
};

/** Each kind's lead words: how every consequence of the kind begins. */
export const CONSEQUENCE_LEAD: Readonly<Record<ClassConsequenceKind, string>> = {
  stays: 'Stays',
  leaves: 'Refused by the size rules',
  waitsForParent: 'Waits for a parent',
};

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
  const said = (kind: ClassConsequenceKind, rest: string): ClassConsequence => {
    const lead = CONSEQUENCE_LEAD[kind];
    return { kind, words: `${lead}${rest}`, lead };
  };
  const area = body.surfaceAreaSqM;
  if (area === null || !Number.isFinite(area)) {
    return said('stays', `, as ${STAYS_AS[cls]}: no area is on file for the size rules`);
  }
  const byRule = belongsInCorpus({ name: body.name, surfaceAreaSqM: area, type: cls });
  if (!byRule && body.includedByRequest !== true) {
    return said(
      'leaves',
      ` next campaign, as ${refusedAs({ name: body.name, areaSqM: area }, cls)}`,
    );
  }
  const asked = byRule ? '' : ': someone asked for it';
  if (cls === 'bay') return said('waitsForParent', `: a bay needs a lake to hold it${asked}`);
  return said('stays', `, as ${STAYS_AS[cls]}${asked}`);
}

/** A list row's consequence line (board 4.3's third line): what one claimed class would do. */
export type ClassConsequenceLine = {
  kind: Exclude<ClassConsequenceKind, 'stays'>;
  /** The claimed class that would do it. */
  cls: WaterBodyClass;
  /** "Refused if a wetland", "Waits for a parent if a bay". */
  words: string;
};

/** How a class is named after "if" on a row's line. */
const IF_CLASSED: Readonly<Record<WaterBodyClass, string>> = {
  lakePond: 'a lake or pond',
  wetland: 'a wetland',
  reservoir: 'a reservoir',
  bay: 'a bay',
  river: 'a river reach',
  unclassified: 'unclassified',
};

/** Each kind's short lead on a row, where the ladder's full words don't fit. */
const LINE_LEAD: Readonly<Record<ClassConsequenceLine['kind'], string>> = {
  leaves: 'Refused',
  waitsForParent: CONSEQUENCE_LEAD.waitsForParent,
};

/** A refusal outweighs a wait for a parent: the row says the heavier. */
const LINE_WEIGHT: Readonly<Record<ClassConsequenceLine['kind'], number>> = {
  leaves: 2,
  waitsForParent: 1,
};

/**
 * **A class conflict's row line** — what choosing one of the catalogs' other classes would do, by
 * {@link classConsequence} itself (one rule: the row and the ladder can't disagree). Of the classes
 * the catalogs claim, other than the body's own, the one whose consequence weighs most: a refusal
 * by the size rules, then a wait for a parent. `null` when every claimed class would keep the body
 * as it stands (a class it stays under is no consequence worth a line), and when no claims are
 * recorded (`claimed` empty). Like every consequence, it says what the app does with the body,
 * never anything about its ice (D3).
 */
export function classConsequenceLine(
  body: ConsequenceBody,
  current: WaterBodyClass,
  claimed: readonly WaterBodyClass[],
): ClassConsequenceLine | null {
  let best: ClassConsequenceLine | null = null;
  for (const cls of claimed) {
    if (cls === current) continue;
    const { kind } = classConsequence(body, cls);
    if (kind === 'stays') continue;
    if (best !== null && LINE_WEIGHT[best.kind] >= LINE_WEIGHT[kind]) continue;
    best = { kind, cls, words: `${LINE_LEAD[kind]} if ${IF_CLASSED[cls]}` };
  }
  return best;
}

// ── A neighbor's distance and bearing ────────────────────────────────────────────────────────

/**
 * How far a neighbor lies from a body and in which direction: **point to point**, from a point
 * inside the body's water to a point inside the neighbor's (never a shoreline point — the stored
 * neighbors touch, so their shores are within meters of each other and a shore-to-shore figure
 * would read 0 every time). `meters` is the great-circle distance (`haversineMeters`, symmetric);
 * `bearingDeg` the direction from the body's point to the neighbor's, degrees clockwise from north
 * in `[0, 360)` (`bearingDegrees`; `0` for coincident points).
 */
export type NeighborOffset = { meters: number; bearingDeg: number };

/** The offset between two inside points; `null` when either isn't finite. */
export function neighborOffset(from: LatLng, to: LatLng): NeighborOffset | null {
  if (![from.lat, from.lng, to.lat, to.lng].every(Number.isFinite)) return null;
  return { meters: haversineMeters(from, to), bearingDeg: bearingDegrees(from, to) };
}

/**
 * A point inside a stored ring (a neighbor's simplified outer ring, `[lng, lat]` pairs): the same
 * rule that computes a body's `interiorPoint` at import (`fetchOrigin`, the midpoint of the longest
 * water span — strictly inside). `null` for a ring with no interior (fewer than four points, or
 * collinear).
 */
export function ringInsidePoint(ring: readonly (readonly number[])[]): LatLng | null {
  return fetchOrigin({ type: 'Polygon', coordinates: [ring.map((p) => [...p])] });
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
