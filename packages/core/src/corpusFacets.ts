/**
 * **The facet a Corpus task is filed in**, from the body's stored facts (B01-6a) — the lane's tab.
 *
 * - **Name conflicts**: how the shown name and the other catalog name differ (the queue's own split,
 *   measured on run 8's 475 conflicts in `sameDisplayName`'s docstring): *Qualifier* when one name's
 *   words hold the other's (`Grand Lake` / `East Grand Lake`), *One letter* when they are one edit
 *   apart (`Tuttle Pond` / `Turtle Pond` — the Bear/Bean case, never folded), else *Different*.
 * - **Class conflicts**: *Wetland or lake* when a catalog's wetland meets another's open water (the
 *   federal catalog calling a bog what OSM calls a pond, the direction `settledWetlandDissent` leaves
 *   queued), *Other pairs* for the rest, and `notRecorded` when no class claim is stored (a body
 *   imported before B01-3d): that reads under *All* only, never as a tab.
 *
 * The writer files by this rule and the drift repair re-derives by it, so a task's tab is never
 * stored by one rule and checked by another. A facet says how the *catalogs* disagree, never anything
 * about the ice (D3).
 */

import { sameDisplayName } from './confidence';
import { CORPUS_NOT_RECORDED, type CorpusTaskFacet, type CorpusTaskLane } from './corpusTasks';
import { NAME_SOURCE_RANK } from './nameClaims';
import type { EvidenceRecord } from './reviewEvidence';
import type { WaterBodyClass } from './types';

/** The record `facetOf` reads: the evidence, the shown name and the body's class. */
export type FacetRecord = EvidenceRecord & { name: string; type: WaterBodyClass };

/** One of `CORPUS_TASK_FACETS[lane]`, never *All*. */
export function facetOf(lane: CorpusTaskLane, record: FacetRecord): CorpusTaskFacet {
  switch (lane) {
    case 'nameConflicts': {
      const other = otherNameOf(record);
      return other === null ? 'different' : splitOfNames(record.name, other);
    }
    case 'classConflicts':
      return classFacetOf(record);
  }
}

/** How two names differ: the Name conflicts lane's tabs. */
export type NameFacet = 'different' | 'oneLetter' | 'qualifier';

/**
 * The name a name conflict sets against the shown one: the most authoritative catalog claim
 * (`NAME_SOURCE_RANK`, stored order on a tie) that a reader would see as a different name
 * (`sameDisplayName`, the queue's own bar). Never a moderator's `user` claim. `null` when no catalog
 * claim differs (claims not stored, or the conflict since resolved).
 */
export function otherNameOf(record: Pick<FacetRecord, 'name' | 'nameClaims'>): string | null {
  const catalog = (record.nameClaims ?? [])
    .map((claim, at) => ({ claim, at }))
    .filter(({ claim }) => claim.source !== 'user' && claim.value.trim().length > 0)
    .sort((a, b) => rankOf(a.claim.source) - rankOf(b.claim.source) || a.at - b.at);
  const other = catalog.find(({ claim }) => !sameDisplayName(claim.value, record.name));
  return other ? other.claim.value.trim() : null;
}

function rankOf(source: string): number {
  return (NAME_SOURCE_RANK as Readonly<Record<string, number>>)[source] ?? Number.MAX_SAFE_INTEGER;
}

/** Lowercased, accents and apostrophes off, spacing collapsed: the form two names are compared in. */
function foldName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[\s\-–]+/g, ' ')
    .trim();
}

/**
 * **The split between two names** — one rule, for the facet a task is filed in and the words the
 * lane says it in. *Qualifier*: every word of the shorter is in the longer (`Lake Sunapee` /
 * `Little Lake Sunapee`). *One letter*: one letter added, dropped or changed (`Little Elligo Pond` /
 * `Little Eligo Pond`). Else *Different*. Symmetric in its two names.
 */
export function splitOfNames(shown: string, other: string): NameFacet {
  const a = foldName(shown);
  const b = foldName(other);
  const wordsA = new Set(a.split(' ').filter(Boolean));
  const wordsB = new Set(b.split(' ').filter(Boolean));
  const [small, large] = wordsA.size <= wordsB.size ? [wordsA, wordsB] : [wordsB, wordsA];
  if (small.size > 0 && small.size < large.size && [...small].every((w) => large.has(w))) {
    return 'qualifier';
  }
  return withinOneEdit(a, b) ? 'oneLetter' : 'different';
}

/** Whether `a` and `b` differ by at most one insertion, deletion or substitution (by code point). */
function withinOneEdit(a: string, b: string): boolean {
  const x = [...a];
  const y = [...b];
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0;
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  return x.length - i - j <= 1 && y.length - i - j <= 1;
}

/** Water we cover that is not a bog: the side of a *Wetland or lake* pair that isn't the wetland. */
const OPEN_WATER: ReadonlySet<string> = new Set<WaterBodyClass>(['lakePond', 'reservoir']);

function classFacetOf(record: FacetRecord): CorpusTaskFacet<'classConflicts'> {
  const values = new Set(
    (record.classClaims ?? []).filter((c) => c.source !== 'user').map((c) => c.value),
  );
  if (values.size === 0) return CORPUS_NOT_RECORDED;
  const wetland = values.has('wetland');
  const open = [...values].some((v) => OPEN_WATER.has(v));
  return wetland && open ? 'wetlandOrLake' : 'otherPairs';
}
