/**
 * What a person can take back, and when what they took back is gone for good (D248, the founder's
 * rulings of 2026-11-13).
 *
 * Two halves, both pure so the server and any client read one rule:
 *
 * - **The erasure clock.** Content its author deleted, and a request or flag its filer retracted, is
 *   erased {@link WITHDRAWN_ERASE_DAYS} days after the withdrawal — unless something holds it (a
 *   moderator's standing verdict, an open flag on it). When the last hold clears, the clock reads
 *   the later of the withdrawal + 30 days and that moment, so a hold never shortens the wait and a
 *   long-held item is not erased the instant it is let go before its own 30 days were up.
 * - **Retraction until decided.** "If a user reports an access issue, asks for a body to be included
 *   in the corpus, reports a body as not accessible to the public, or any of those kinds of actions,
 *   they should be able to retract them at any time (up until the action is determined/taken)." Each
 *   filed kind says here which of its states a filer can still take back.
 */

import { DELETION_GRACE_DAYS } from './profile';

/**
 * How long withdrawn content waits before it is erased (D248). **A sibling of
 * {@link DELETION_GRACE_DAYS}, not a reuse of it.** The founder set the two equal ("the same 30 days
 * as account deletion"), and the invariant test pins that, but they are two promises told in two
 * places — an account's window to change one's mind, and a deleted comment's window for a complaint
 * to arrive — and the codebase names each promise it states (`DATA_EXPORT_TTL_DAYS` and
 * `DEPARTED_CONTENT_MAX_AGE_DAYS` are 30 for the same reason). A change to one is a founder call
 * about both, which is what the pinned equality makes someone ask.
 */
export const WITHDRAWN_ERASE_DAYS = DELETION_GRACE_DAYS;
export const WITHDRAWN_ERASE_MS = WITHDRAWN_ERASE_DAYS * 24 * 60 * 60 * 1000;

/**
 * The next erasure time for one item, given what holds it now.
 *
 * - Not withdrawn ⇒ never.
 * - Held ⇒ not while held (the clock is cleared, so the sweep never reads it).
 * - Already counting ⇒ unchanged: re-reading a clock never pushes it later.
 * - Otherwise — just withdrawn, or the last hold just cleared at `now` — the later of the withdrawal
 *   + 30 days and `now`.
 */
export function nextEraseAt(item: {
  withdrawnAt: number | undefined;
  held: boolean;
  current: number | undefined;
  now: number;
}): number | undefined {
  if (item.withdrawnAt === undefined || item.held) return undefined;
  if (item.current !== undefined) return item.current;
  return Math.max(item.withdrawnAt + WITHDRAWN_ERASE_MS, item.now);
}

// ── Retraction ─────────────────────────────────────────────────────────────────────────────────

/** What a filer is told when their retraction comes too late, or there is nothing to retract. */
export const RETRACT_REFUSALS = {
  decided: 'A moderator has already acted on this, so it can no longer be retracted.',
  closed: 'This is already closed, so there is nothing to retract.',
  notYours: 'Only the person who filed this can retract it.',
  sharedFlag:
    'Others have reported the same thing since, so this stays with the moderators. It can no longer be retracted.',
} as const;

/** A request to a moderator (activate, admit, restore, contest, takedown, name a bay or landmark). */
export function requestRetraction(
  status: 'open' | 'approved' | 'declined' | 'retracted',
): 'retract' | 'already' | keyof typeof RETRACT_REFUSALS {
  if (status === 'open') return 'retract';
  if (status === 'retracted') return 'already';
  return 'decided';
}

/**
 * A flag a person filed. Picked up (`reviewing`) is not decided; `actioned` and `dismissed` are. A
 * flag the system filed or bumped is not one person's to take back: an `auto` row names a person
 * who filed nothing, and a person's flag the system has since counted again (`occurrences > 1`)
 * carries others' reports with it.
 */
export function flagRetraction(flag: {
  status: 'open' | 'reviewing' | 'actioned' | 'dismissed' | 'retracted';
  origin?: 'user' | 'auto';
  occurrences?: number;
}): 'retract' | 'already' | keyof typeof RETRACT_REFUSALS {
  if (flag.status === 'retracted') return 'already';
  if (flag.status === 'actioned' || flag.status === 'dismissed') return 'decided';
  if (flag.origin !== 'user') return 'notYours';
  if ((flag.occurrences ?? 1) > 1) return 'sharedFlag';
  return 'retract';
}

/**
 * An access alert, retracted by its author. Only a live community claim: a moderator's pin
 * (`official`) is the claim acted on; `resolved`, `expired` and `retracted` have nothing left to take
 * back. (A moderator's own retraction is not this rule — it is a moderator's verdict.)
 */
export function alertRetractionByAuthor(
  status: 'active' | 'official' | 'resolved' | 'expired' | 'retracted',
): 'retract' | 'already' | keyof typeof RETRACT_REFUSALS {
  if (status === 'active') return 'retract';
  if (status === 'retracted') return 'already';
  if (status === 'official') return 'decided';
  return 'closed';
}
