import { describe, expect, it } from 'vitest';
import { isBodyFreshForBounty, withinDailyBountyLimit } from './bounties';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('isBodyFreshForBounty', () => {
  it('is fresh (blocks a bounty) when a report is within the window', () => {
    expect(isBodyFreshForBounty([{ skateEndTime: NOW - 47 * HOUR }], NOW, 48)).toBe(true);
    expect(isBodyFreshForBounty([{ skateEndTime: NOW }], NOW, 48)).toBe(true);
  });

  it('treats the window edge as still fresh (inclusive), but not past it', () => {
    expect(isBodyFreshForBounty([{ skateEndTime: NOW - 48 * HOUR }], NOW, 48)).toBe(true);
    expect(isBodyFreshForBounty([{ skateEndTime: NOW - 48 * HOUR - 1 }], NOW, 48)).toBe(false);
    expect(isBodyFreshForBounty([{ skateEndTime: NOW - 100 * HOUR }], NOW, 48)).toBe(false);
    expect(isBodyFreshForBounty([], NOW, 48)).toBe(false);
  });

  it('is fresh if any one report qualifies among stale ones', () => {
    expect(
      isBodyFreshForBounty(
        [{ skateEndTime: NOW - 200 * HOUR }, { skateEndTime: NOW - HOUR }],
        NOW,
        48,
      ),
    ).toBe(true);
  });
});

describe('withinDailyBountyLimit', () => {
  it('allows while strictly under the cap', () => {
    expect(withinDailyBountyLimit([NOW - HOUR, NOW - 2 * HOUR], NOW, 3, DAY)).toBe(true);
  });

  it('blocks at or above the cap', () => {
    expect(withinDailyBountyLimit([NOW - HOUR, NOW - 2 * HOUR, NOW - 3 * HOUR], NOW, 3, DAY)).toBe(
      false,
    );
  });

  it('ignores bounties created outside the rolling window', () => {
    expect(
      withinDailyBountyLimit([NOW - 25 * HOUR, NOW - 26 * HOUR, NOW - HOUR], NOW, 3, DAY),
    ).toBe(true);
  });

  it('allows an empty history', () => {
    expect(withinDailyBountyLimit([], NOW, 3, DAY)).toBe(true);
  });
});
