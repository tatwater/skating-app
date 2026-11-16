/**
 * **When the current state began** — one rule for every "since" the People pages derive from a run
 * of audit rows (a right's restriction, a suspension's or ban's start). A write that changed nothing
 * (its recorded `prev` equals what it set — a second moderator restricting a right already off, a ban
 * of a banned account) is no transition, and is passed over; walking back newest first, the answer is
 * the first real change, which has to land in the current state. If the rows read end before one is
 * found, the answer is "can't say" (`capped`) when there were more rows unread, "not recorded" when
 * the record really ends there — never the oldest row seen.
 */

/** One row's part in a state's history: what it set, and what it found (absent on old rows). */
export interface StateStep<S> {
  at: number;
  /** What the row set — `undefined` for a row that isn't about this state (it's skipped). */
  after: S | undefined;
  /** What it found, as it recorded it; `undefined` when it predates `prev` (taken as a change). */
  before: S | undefined;
}

export type StateSince<R> =
  | { since: number; row: R; capped: false }
  | { since: null; row: null; capped: boolean };

/**
 * The start of `current` from `rows` (newest first): the first real transition, if it lands in
 * `current`. `complete` says the rows are the whole record (nothing older was left unread).
 */
export function startOfCurrentState<S, R>(
  rows: readonly R[],
  step: (row: R) => StateStep<S>,
  current: S,
  complete: boolean,
): StateSince<R> {
  for (const row of rows) {
    const { at, after, before } = step(row);
    if (after === undefined) continue;
    // Changed nothing: the state ran on through it.
    if (before !== undefined && before === after) continue;
    // The newest real change: the start, if it led here; if it led elsewhere, the record and the
    // state disagree, and no date can be said.
    return after === current
      ? { since: at, row, capped: false }
      : { since: null, row: null, capped: false };
  }
  return { since: null, row: null, capped: !complete };
}
