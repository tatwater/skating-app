import { WATER_BODY_CLASS_LABELS } from '@skating/core';

import type { CorpusRowView } from '../corpusTypes';
import { acresText, DECIDER_GONE, DECISION_WORDS, NOT_RECORDED } from '../words/corpusWords';

/**
 * **A task row → what the list draws** (boards 4.2, 4.3), pure, so each lane's rule is tested
 * without a page: its title, the line under it, and its acres on the right. Every fact is the
 * server's, resolved at read; nothing is invented, and nothing says anything about the ice (D3).
 *
 * - **Name conflicts**: the shown name, then *the other* and where.
 * - **Class conflicts**: the body, then what the catalogs say (*OSM Lake or pond · NHD Wetland*), or
 *   *Not recorded* for a body loaded before its campaign carried the claims.
 * - **A decided row** (the tail) says what was decided and by whom first.
 */

export type TaskRowView = {
  id: string;
  title: string;
  sub: string;
  /** The acres, or `null` where the body has none recorded. */
  acres: string | null;
  /** Decided: drawn in the tail, opened read-only. */
  done: boolean;
};

const join = (...parts: (string | null | undefined)[]): string =>
  parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ');

/** What the catalogs say a body is, as a row's line: "OSM Lake or pond · NHD Wetland". */
export function claimsLine(row: Extract<CorpusRowView, { lane: 'classConflicts' }>): string {
  if (row.claims === null) return NOT_RECORDED;
  return row.claims
    .map((c) => `${c.source.toUpperCase()} ${WATER_BODY_CLASS_LABELS[c.cls]}`)
    .join(' · ');
}

export function taskRowView(row: CorpusRowView): TaskRowView {
  const facts =
    row.lane === 'nameConflicts'
      ? { title: row.shown, sub: join(`/ ${row.other}`, row.body.place) }
      : { title: row.body.name, sub: join(claimsLine(row), row.body.place) };
  const decided = row.decided;
  return {
    id: row.taskId,
    title: facts.title,
    sub:
      decided === null
        ? facts.sub
        : join(
            DECISION_WORDS[row.lane][decided.decision],
            `by ${decided.by?.displayName ?? DECIDER_GONE}`,
            facts.sub,
          ),
    acres: row.body.acres === null ? null : acresText(row.body.acres),
    done: decided !== null,
  };
}
