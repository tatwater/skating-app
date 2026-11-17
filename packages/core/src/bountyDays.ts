/**
 * **What a day's bounties are** (B01-2b) — the one definition the day rollup writes and the Overview's
 * *Each day* reads: a bounty is **posted** on the day it was created, whatever became of it, and
 * **fulfilled** on the day its requester's helpful thumb fulfilled it (`status: 'fulfilled'`, stamped
 * `fulfilledAt`), whenever it was posted.
 *
 * - A bounty canceled or expired was posted and is never fulfilled; nothing subtracts it from posted.
 * - Fulfillment is terminal (a retracted thumb never un-fulfills, `bounties.fulfillBountyOnHelpful`),
 *   so a fulfilled bounty is counted on exactly one day.
 * - A bounty fulfilled before `fulfilledAt` was stamped (Phase 07-2) has no day, and is not counted.
 *
 * Days are metric days: `[from, to)` in UTC instants, as every `metricSnapshots` row.
 */

/** The fields a day's count reads. */
export interface BountyMoments {
  status: string;
  createdAt: number;
  fulfilledAt?: number | undefined;
}

/** Posted in `[from, to)`: created then, whatever its status now. */
export function postedIn(b: BountyMoments, from: number, to: number): boolean {
  return b.createdAt >= from && b.createdAt < to;
}

/** Fulfilled in `[from, to)`: fulfilled, with its fulfillment stamped then. */
export function fulfilledIn(b: BountyMoments, from: number, to: number): boolean {
  return (
    b.status === 'fulfilled' &&
    b.fulfilledAt !== undefined &&
    b.fulfilledAt >= from &&
    b.fulfilledAt < to
  );
}

/** A day's two counts over the bounties a read returned. */
export function bountiesOnDay(
  rows: readonly BountyMoments[],
  from: number,
  to: number,
): { posted: number; fulfilled: number } {
  return {
    posted: rows.filter((b) => postedIn(b, from, to)).length,
    fulfilled: rows.filter((b) => fulfilledIn(b, from, to)).length,
  };
}

/**
 * How long after its `expiresAt` a bounty can still be fulfilled: an open bounty is fulfilled until
 * the 6-hourly sweep flips it to expired, so a day's fulfilled bounties all expire no earlier than this
 * before the day began. Generous, so a sweep that missed a day or two still loses nothing.
 */
export const BOUNTY_FULFILL_AFTER_EXPIRY_MS = 7 * 86_400_000;
