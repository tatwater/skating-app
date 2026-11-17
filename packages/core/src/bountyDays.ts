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

import { DEFAULT_BOUNTY_LIFETIME_MS } from './reputationConfig';

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

/**
 * The `expiresAt` range that holds every bounty fulfilled in `[from, to)`: from
 * {@link BOUNTY_FULFILL_AFTER_EXPIRY_MS} before the day began, to twice the lifetime after the day
 * ended — a bounty is posted before it is fulfilled, so one fulfilled by `to` was posted before it and
 * expires before `to` plus its lifetime (every bounty is posted with `DEFAULT_BOUNTY_LIFETIME_MS`;
 * twice it, so a bounty posted under a longer lifetime than today's is still read). Bounded both ends,
 * so a past day's read never takes in every bounty fulfilled since.
 */
export function fulfilledExpiryRange(from: number, to: number): { from: number; to: number } {
  // Twice the lifetime: a bounty posted under a longer lifetime than today's is still in range.
  return { from: from - BOUNTY_FULFILL_AFTER_EXPIRY_MS, to: to + 2 * DEFAULT_BOUNTY_LIFETIME_MS };
}
