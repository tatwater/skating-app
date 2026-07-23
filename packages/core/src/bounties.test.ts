import { describe, expect, it } from 'vitest';
import {
  bountyFreshWindowHours,
  isBodyFreshForBounty,
  reportSuppressesBounty,
  withinDailyBountyLimit,
} from './bounties';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('bountyFreshWindowHours (decay-based freshness, §7c)', () => {
  it('a lone new-account report suppresses for LESS than the base window', () => {
    // new: −0.5 boost, 0 thumbs ⇒ 48 × 0.5 = 24h
    expect(bountyFreshWindowHours(48, { netThumbs: 0, trustClass: 'new' })).toBeCloseTo(24);
    expect(bountyFreshWindowHours(48, { netThumbs: 0, trustClass: null })).toBeCloseTo(24);
  });

  it('a well-corroborated, trusted report suppresses for LONGER', () => {
    // leader: +1, 4 net thumbs: +1 ⇒ 48 × 3 = 144h
    expect(bountyFreshWindowHours(48, { netThumbs: 4, trustClass: 'leader' })).toBeCloseTo(144);
    // thumbs are bounded (+4 max) so it can't run away
    expect(bountyFreshWindowHours(48, { netThumbs: 40, trustClass: 'leader' })).toBeCloseTo(144);
  });

  it('never goes negative, and weather that changed the ice collapses it to 0', () => {
    expect(bountyFreshWindowHours(48, { netThumbs: -10, trustClass: 'new' })).toBe(0);
    expect(
      bountyFreshWindowHours(48, {
        netThumbs: 4,
        trustClass: 'leader',
        weatherChangedIceSince: true,
      }),
    ).toBe(0);
  });

  it('reportSuppressesBounty compares age against the decayed window', () => {
    const now = NOW;
    // A leader report 100h old with 4 thumbs (window 144h) still suppresses; a new one 30h old (window 24h) does not.
    expect(
      reportSuppressesBounty(now - 100 * HOUR, now, 48, { netThumbs: 4, trustClass: 'leader' }),
    ).toBe(true);
    expect(
      reportSuppressesBounty(now - 30 * HOUR, now, 48, { netThumbs: 0, trustClass: 'new' }),
    ).toBe(false);
    // Weather changed the ice ⇒ even a fresh, trusted report reopens bounties.
    expect(
      reportSuppressesBounty(now - 1 * HOUR, now, 48, {
        netThumbs: 4,
        trustClass: 'leader',
        weatherChangedIceSince: true,
      }),
    ).toBe(false);
  });
});

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
