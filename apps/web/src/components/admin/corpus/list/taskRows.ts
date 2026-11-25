import { WATER_BODY_CLASS_LABELS } from '@skating/core';

import { ageInWords } from '@/lib/ages';

import type { CorpusRowView } from '../corpusTypes';
import {
  acresFigure,
  DECIDER_GONE,
  DECISION_WORDS,
  NOT_RECORDED,
  TAB_LABELS,
  UNNAMED,
} from '../words/corpusWords';

/**
 * **A task row → what the list's table draws** (boards 4.2, 4.3), pure, so each lane's rule is
 * tested without a page. Every fact is the server's, resolved at read; nothing is invented, and
 * nothing says anything about the ice (D3).
 *
 * - **Name conflicts** (4.2): the shown name over the other, then where; the kind (the tab's words);
 *   the acres. On a *One letter* conflict the letter where the two names part is marked in each.
 * - **Class conflicts** (4.3): the body and where; each catalog's class on its own line (*NHD
 *   Wetland*), or *Not recorded* for a body loaded before its campaign carried the claims; the acres.
 * - **A decided row** (the tail) adds what was decided, by whom and when, under the body.
 */

/** A name as a cell draws it: its text, and the letter to mark (where two names part), if any. */
export type MarkedName = { text: string; mark: number | null };

export type TaskRowView = {
  id: string;
  /** What type-ahead matches: the row's first name. */
  title: string;
  /** The first cell's names: the shown and the other (names), the body alone (classes). */
  names: readonly MarkedName[];
  place: string;
  /** The middle column's lines: the kind, or each catalog's class. */
  middle: readonly string[];
  /** The acres as the column writes them, or `null` where the body has none recorded. */
  acres: string | null;
  /** Decided (a tail row): "renamed · by Avery Lindqvist · 2 h"; `null` while open. */
  decision: string | null;
};

const join = (...parts: (string | null | undefined)[]): string =>
  parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ');

/**
 * Where two names part: the index of the first letter that differs, in each — `null` in a name
 * that is all the other's start (nothing of its own to mark). Case counts: *Lake* and *lake* differ.
 */
export function partingLetter(a: string, b: string): [number | null, number | null] {
  const x = [...a];
  const y = [...b];
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i += 1;
  return [i < x.length ? i : null, i < y.length ? i : null];
}

/** What the catalogs say a body is, a line each: "NHD Wetland". */
export function claimLines(row: Extract<CorpusRowView, { lane: 'classConflicts' }>): string[] {
  if (row.claims === null) return [NOT_RECORDED];
  return row.claims.map((c) => `${c.source.toUpperCase()} ${WATER_BODY_CLASS_LABELS[c.cls]}`);
}

function namesOf(row: CorpusRowView): MarkedName[] {
  if (row.lane === 'classConflicts') {
    return [{ text: row.body.name === '' ? UNNAMED : row.body.name, mark: null }];
  }
  if (row.other === '') return [{ text: row.shown, mark: null }];
  // Only a one-letter conflict marks its letter: elsewhere the names differ whole.
  const [a, b] = row.facet === 'oneLetter' ? partingLetter(row.shown, row.other) : [null, null];
  return [
    { text: row.shown, mark: a },
    { text: row.other, mark: b },
  ];
}

function middleOf(row: CorpusRowView): string[] {
  if (row.lane === 'classConflicts') return claimLines(row);
  const labels = TAB_LABELS.nameConflicts as Record<string, string>;
  // A facet with no tab (not recorded) has no kind to say.
  const kind = labels[row.facet];
  return kind === undefined ? [] : [kind];
}

export function taskRowView(row: CorpusRowView, now: number): TaskRowView {
  const names = namesOf(row);
  const decided = row.decided;
  return {
    id: row.taskId,
    title: names[0]?.text ?? '',
    names,
    place: row.body.place,
    middle: middleOf(row),
    acres: row.body.acres === null ? null : acresFigure(row.body.acres),
    decision:
      decided === null
        ? null
        : join(
            DECISION_WORDS[row.lane][decided.decision],
            `by ${decided.by?.displayName ?? DECIDER_GONE}`,
            ageInWords(decided.at, now),
          ),
  };
}
