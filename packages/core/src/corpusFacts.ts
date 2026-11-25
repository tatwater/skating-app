/**
 * **The words a Corpus task's facts are said in** (B01-6a): what each class would do with a body,
 * a catalog's rank as a name authority, and how two names differ.
 *
 * PLACEHOLDER (S3's): the T0 stub. Its signatures are the reads' needs from the briefs' snippets
 * (`ClassRungView.consequence`, `NameChoiceView.rankWords`, the Names item's `split`); S3 replaces
 * the bodies (and this paragraph) with the rules, their tests and the D3 words test. No word here
 * may say or imply anything about the ice (D3).
 */

import type { ClaimSource } from './confidence';
import type { WaterBodyClass } from './types';

/** What the app does with a body under a class: it stays, leaves the corpus, or waits for a parent. */
export type ClassConsequenceKind = 'stays' | 'leaves' | 'waitsForParent';
export type ClassConsequence = { kind: ClassConsequenceKind; words: string };

/** The body facts a consequence is read from (`belongsInCorpus`' inputs). */
export type ConsequenceBody = {
  name: string;
  surfaceAreaSqM: number;
  includedByRequest?: boolean | undefined;
};

/** What setting `cls` on `body` would do ("Leaves the corpus next campaign, as unnamed wetland under 50 ac"). */
export function classConsequence(_body: ConsequenceBody, _cls: WaterBodyClass): ClassConsequence {
  throw new Error('PLACEHOLDER (S3): classConsequence is not built yet');
}

/** How two names differ, the Name conflicts lane's tabs. */
export type NameSplit = 'different' | 'oneLetter' | 'qualifier';

/** The split between the shown name and the other claim. */
export function nameSplit(_shown: string, _other: string): NameSplit {
  throw new Error('PLACEHOLDER (S3): nameSplit is not built yet');
}

/** A catalog's place in `NAME_SOURCE_RANK`, in words ("First: the authority on US names"). */
export function nameRankWords(_source: ClaimSource): string {
  throw new Error('PLACEHOLDER (S3): nameRankWords is not built yet');
}
