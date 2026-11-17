import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  BOUNTY_FULFILL_AFTER_EXPIRY_MS,
  type BountyMoments,
  bountiesOnDay,
  fulfilledExpiryRange,
  fulfilledIn,
  postedIn,
} from './bountyDays';
import { DEFAULT_BOUNTY_LIFETIME_MS } from './reputationConfig';

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1);

/** A bounty posted in the window, in any state it can end in; a fulfilled one stamped or not. */
const bounty: fc.Arbitrary<BountyMoments> = fc
  .record({
    createdAt: fc.integer({ min: START, max: START + 60 * DAY }),
    status: fc.constantFrom('open', 'fulfilled', 'canceled', 'expired'),
    after: fc.integer({ min: 0, max: 40 * DAY }),
    stamped: fc.boolean(),
  })
  .map(({ createdAt, status, after, stamped }) => ({
    createdAt,
    status,
    ...(status === 'fulfilled' && stamped ? { fulfilledAt: createdAt + after } : {}),
  }));

describe('a day’s bounties', () => {
  const property = fc.property(fc.array(bounty, { maxLength: 60 }), (rows) => {
    const days = Array.from({ length: 100 }, (_, i) => START + i * DAY);
    const counts = days.map((from) => bountiesOnDay(rows, from, from + DAY));
    // Posted: every bounty once, on the day it was created, whatever became of it.
    expect(counts.reduce((a, c) => a + c.posted, 0)).toBe(rows.length);
    for (const b of rows) {
      expect(days.filter((from) => postedIn(b, from, from + DAY))).toHaveLength(1);
    }
    // Fulfilled: each stamped fulfilled bounty on exactly one day; canceled, expired, open or
    // unstamped ones never.
    const fulfilled = rows.filter((b) => b.status === 'fulfilled' && b.fulfilledAt !== undefined);
    expect(counts.reduce((a, c) => a + c.fulfilled, 0)).toBe(fulfilled.length);
    for (const b of rows) {
      const on = days.filter((from) => fulfilledIn(b, from, from + DAY));
      expect(on).toHaveLength(fulfilled.includes(b) ? 1 : 0);
      // The day it counts on is the day of its stamp, not of its posting.
      if (on.length === 1)
        expect(on[0]).toBe(START + Math.floor(((b.fulfilledAt as number) - START) / DAY) * DAY);
    }
  });

  it('counts each bounty posted once and each fulfilled once, on their own days (pinned seeds and one random)', () => {
    for (const seed of [20261117, 6, 900]) fc.assert(property, { seed, numRuns: 200 });
    fc.assert(property, { numRuns: 200 });
  });

  it('the fulfilled read’s expiry range holds every bounty fulfilled that day, and no later one', () => {
    // Posted with the one lifetime, fulfilled while open: any time from its posting until the sweep
    // closes it, at most BOUNTY_FULFILL_AFTER_EXPIRY_MS past its expiry.
    const fulfilledBounty = fc
      .record({
        createdAt: fc.integer({ min: START, max: START + 60 * DAY }),
        after: fc.integer({
          min: 0,
          max: DEFAULT_BOUNTY_LIFETIME_MS + BOUNTY_FULFILL_AFTER_EXPIRY_MS - 1,
        }),
      })
      .map(({ createdAt, after }) => ({
        expiresAt: createdAt + DEFAULT_BOUNTY_LIFETIME_MS,
        fulfilledAt: createdAt + after,
      }));
    const holds = fc.property(fulfilledBounty, ({ expiresAt, fulfilledAt }) => {
      const from = START + Math.floor((fulfilledAt - START) / DAY) * DAY;
      const range = fulfilledExpiryRange(from, from + DAY);
      expect(expiresAt).toBeGreaterThanOrEqual(range.from);
      expect(expiresAt).toBeLessThan(range.to);
    });
    for (const seed of [20261117, 6, 900]) fc.assert(holds, { seed, numRuns: 200 });
    fc.assert(holds, { numRuns: 200 });
    // Bounded above, with room for a lifetime once twice today's: a range of three lifetimes and a
    // week, never every bounty fulfilled since the day.
    const range = fulfilledExpiryRange(START, START + DAY);
    expect(range.to - range.from).toBe(
      DAY + 2 * DEFAULT_BOUNTY_LIFETIME_MS + BOUNTY_FULFILL_AFTER_EXPIRY_MS,
    );
  });

  it('a day’s edges: from is in, to is out', () => {
    const b = { status: 'fulfilled', createdAt: START, fulfilledAt: START + DAY };
    expect(bountiesOnDay([b], START, START + DAY)).toEqual({ posted: 1, fulfilled: 0 });
    expect(bountiesOnDay([b], START + DAY, START + 2 * DAY)).toEqual({ posted: 0, fulfilled: 1 });
  });
});
