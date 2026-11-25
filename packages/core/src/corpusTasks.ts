/**
 * **The Corpus tasks' vocabulary** (B01-6): the lanes, kinds, statuses, decisions and facets a stored
 * task row (`corpusTasks`) can carry. The schema and both sides import it, so a lane can't be one
 * thing on the server and another on the page.
 *
 * B01-6a builds two lanes, Name conflicts and Class conflicts. **Contested as water is left out on
 * purpose, not reserved** (D307): every map keyed by `CorpusTaskLane` is exhaustive, so a reserved id
 * would be a dead entry each had to fill with a placeholder. 6b widens these constants with its lanes
 * — `contested` and its facets, `'class-dissent': 'contested'`, the `dormant` and `removed`
 * decisions — and the type checker then names every map that needs its entry (a widening; the
 * schema follows by import).
 */

import type { ReviewReason } from './confidence';

/** The task lanes 6a builds. 6b–6d widen the union with theirs (a widening; the schema follows). */
export const CORPUS_TASK_LANES = ['nameConflicts', 'classConflicts'] as const;
export type CorpusTaskLane = (typeof CORPUS_TASK_LANES)[number];

/** What one task is: in 6a, one intake reason on one body. 6b adds `duplicate`. */
export const CORPUS_TASK_KINDS = ['reason'] as const;
export type CorpusTaskKind = (typeof CORPUS_TASK_KINDS)[number];

/** `decided`: a person decided it. `left`: the question went away (no person, no tab). */
export const CORPUS_TASK_STATUSES = ['open', 'decided', 'left'] as const;
export type CorpusTaskStatus = (typeof CORPUS_TASK_STATUSES)[number];

/** What a person decided. 6b's Contested lane adds `dormant` and `removed` (D307). */
export const CORPUS_TASK_DECISIONS = ['kept', 'renamed', 'reclassed'] as const;
export type CorpusTaskDecision = (typeof CORPUS_TASK_DECISIONS)[number];

/**
 * Why a task left with no decision: a campaign stopped asserting the reason, the body was merged
 * away, removed, or deleted outright by a duplicate resolution.
 */
export const CORPUS_TASK_LEFT_REASONS = ['notAsserted', 'merged', 'removed', 'deleted'] as const;
export type CorpusTaskLeftReason = (typeof CORPUS_TASK_LEFT_REASONS)[number];

/** The intake reason each 6a lane holds: one reason, one lane. */
export const CORPUS_REASON_LANE = {
  'name-conflict': 'nameConflicts',
  'class-conflict': 'classConflicts',
} as const satisfies Partial<Record<ReviewReason, CorpusTaskLane>>;

/** The facet of a task whose facts aren't stored yet. */
export const CORPUS_NOT_RECORDED = 'notRecorded';

/**
 * Each lane's facets, in the board's tab order after *All*. `notRecorded` holds a task whose facts
 * aren't stored yet (no class claims): it reads under *All* only, never as a tab.
 */
export const CORPUS_TASK_FACETS = {
  nameConflicts: ['different', 'oneLetter', 'qualifier'],
  classConflicts: ['wetlandOrLake', 'otherPairs', CORPUS_NOT_RECORDED],
} as const satisfies Record<CorpusTaskLane, readonly string[]>;
export type CorpusTaskFacet<L extends CorpusTaskLane = CorpusTaskLane> =
  (typeof CORPUS_TASK_FACETS)[L][number];

/** A list page's rows, unless the caller asks for fewer. */
export const CORPUS_PAGE_SIZE = 50;
