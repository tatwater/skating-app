/**
 * When a piece of recurring work is parked (D248) — one rule, read by the erasure sweep for each due
 * item and by the photo settlement for each owed uploader, so the two never disagree.
 *
 * - **Only a failure counts.** Each failed attempt adds one and records the error's class (never its
 *   message). After {@link MAX_ATTEMPTS} failures in a row the work is parked.
 * - **Progress clears the count.** An attempt that moves the work at all — for the sweep, an item
 *   erased or any row it carries erased or unlinked; for the settlement, a step that takes debts on,
 *   reads a page further, settles a photo or clears a debt — wipes the count, the class and any
 *   parking. So failures far apart, with work done between them, never park anything.
 * - **Held is neither.** An item a standing verdict or an open flag keeps is not attempted, and its
 *   state is left exactly as it was.
 * - **A parked piece is retried, slowly.** The daily retry tries it again; a failure there keeps it
 *   parked, re-stamps when it was last tried (so the least recently tried goes first next time) and
 *   notes that the retry ran; a success clears it like any progress.
 *
 * Returns the fields to write, or `null` when nothing changes — so the common path (a healthy item
 * with no history of failure) writes nothing.
 */

/** Failures in a row before a piece of work is parked. */
export const MAX_ATTEMPTS = 3;

export interface AttemptState {
  attempts?: number;
  errorClass?: string;
  /** When it was parked — or, once the daily retry has tried it, when that last tried it. */
  parkedAt?: number;
  /** When the daily retry last tried it, if it has. */
  retriedAt?: number;
}

export type AttemptOutcome =
  | { kind: 'failed'; errorClass: string; byDailyRetry?: boolean }
  | { kind: 'progress' }
  | { kind: 'held' };

export function nextAttemptState(
  state: AttemptState,
  outcome: AttemptOutcome,
  now: number,
): AttemptState | null {
  if (outcome.kind === 'held') return null;
  if (outcome.kind === 'progress') {
    const clean =
      (state.attempts ?? 0) === 0 &&
      state.errorClass === undefined &&
      state.parkedAt === undefined &&
      state.retriedAt === undefined;
    return clean
      ? null
      : { attempts: undefined, errorClass: undefined, parkedAt: undefined, retriedAt: undefined };
  }
  const attempts = (state.attempts ?? 0) + 1;
  const parked = state.parkedAt !== undefined || attempts >= MAX_ATTEMPTS;
  return {
    attempts,
    errorClass: outcome.errorClass,
    parkedAt: parked ? now : undefined,
    retriedAt: outcome.byDailyRetry ? now : state.retriedAt,
  };
}
