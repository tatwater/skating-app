import { waterBodyDisplayName } from '@skating/core';

import { dayMonth } from '../../shell/consoleTime';

/**
 * **The facts both 6a handlers say alike** (boards 4.2 and 4.3), from a task item's shared part:
 * what hangs on the body, its neighbors, the campaign that queued it, a question asked again
 * (D305), its acres. Pure; every fact the item holds as not recorded is said so, never guessed.
 * The words are invented where no board supplied them, for the copy pass; none is about the ice.
 */

export const TASK_WORDS = {
  // From the boards.
  queuedBy: (day: string) => `By the ${day} campaign`,
  // Invented.
  notRecorded: 'Not recorded until the next campaign',
  noneOnFile: 'None on file',
  nothingAttached: 'Nothing: no reports, no landmarks, no asks',
  atLeast: (words: string) => `At least ${words}`,
  reports: (n: number) => (n === 1 ? '1 report' : `${n} reports`),
  landmarks: (n: number) => (n === 1 ? '1 landmark' : `${n} landmarks`),
  asks: (n: number) => (n === 1 ? '1 ask' : `${n} asks`),
  raisedAgain: (who: string, day: string, decision: string, what: string) =>
    `Asked again: ${who} settled it on ${day} (${decision}), and ${what} has changed since.`,
  someone: 'someone no longer on staff',
  decisionWords: { kept: 'kept', renamed: 'renamed', reclassed: 'reclassed' },
} as const;

const W = TASK_WORDS;

type Attached = { reports: number; landmarks: number; asks: number; capped: boolean };
type Decided = {
  at: number;
  by: { displayName: string } | null;
  decision: keyof typeof TASK_WORDS.decisionWords;
};

/** *Attached*: what hangs on the body (“3 reports · 1 landmark”), floors where the read stopped. */
export function attachedWords(attached: Attached): string {
  const parts = [
    attached.reports > 0 ? W.reports(attached.reports) : null,
    attached.landmarks > 0 ? W.landmarks(attached.landmarks) : null,
    attached.asks > 0 ? W.asks(attached.asks) : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return attached.capped ? W.notRecorded : W.nothingAttached;
  const words = parts.join(' · ');
  return attached.capped ? W.atLeast(words) : words;
}

/** The neighbors the geometry facts name, or none on file. */
export const neighborsWords = (neighbors: readonly { name: string }[]): string =>
  neighbors.length === 0
    ? W.noneOnFile
    : neighbors.map((n) => waterBodyDisplayName(n.name)).join(' · ');

/** *Queued*: the campaign that last asked it, by its day; not recorded when none is. */
export const queuedWords = (raisedBy: { at: number } | null, timeZone?: string): string =>
  raisedBy === null ? W.notRecorded : W.queuedBy(dayMonth(raisedBy.at, timeZone));

/** Acres as the boards write them (“2,263”), a part of an acre as “<1”. */
export function acresText(acres: number): string {
  if (acres > 0 && acres < 1) return '<1';
  return Math.round(acres).toLocaleString('en-US');
}

/** The *asked again* note (D305), from the decision it reopened; `what` is what changed. */
export function raisedAgainWords(
  raisedAgain: { previous: Decided } | null,
  what: string,
  timeZone?: string,
): string | null {
  if (raisedAgain === null) return null;
  const p = raisedAgain.previous;
  return W.raisedAgain(
    p.by?.displayName ?? W.someone,
    dayMonth(p.at, timeZone),
    W.decisionWords[p.decision],
    what,
  );
}
