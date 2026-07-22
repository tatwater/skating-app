import { describe, expect, it } from 'vitest';
import { type BadgeStats, badgeTierCount, deriveEarnedBadges } from './badges';

const NO_STATS: BadgeStats = {
  reportsWithHelpfulThumbs: 0,
  bountiesFulfilled: 0,
  helpfulThumbsReceived: 0,
  hazardsConfirmedHelpful: 0,
  othersHazardsActedOn: 0,
  reportsCorroborated: 0,
  measuredReports: 0,
  negativeReportsHelpful: 0,
};

describe('badgeTierCount', () => {
  it('is 0 below the first threshold', () => {
    expect(badgeTierCount(9, { first: 10, step: 15 })).toBe(0);
  });

  it('is 1 at the first threshold and climbs by step', () => {
    expect(badgeTierCount(10, { first: 10, step: 15 })).toBe(1);
    expect(badgeTierCount(24, { first: 10, step: 15 })).toBe(1);
    expect(badgeTierCount(25, { first: 10, step: 15 })).toBe(2);
    expect(badgeTierCount(40, { first: 10, step: 15 })).toBe(3);
  });

  it('collapses to a single tier for a non-positive step (defensive)', () => {
    expect(badgeTierCount(100, { first: 10, step: 0 })).toBe(1);
    expect(badgeTierCount(5, { first: 10, step: 0 })).toBe(0);
  });
});

describe('deriveEarnedBadges', () => {
  it('awards nothing with no qualifying stats', () => {
    expect(deriveEarnedBadges(NO_STATS)).toEqual([]);
  });

  it('awards a family once its stat reaches the first threshold', () => {
    expect(deriveEarnedBadges({ ...NO_STATS, measuredReports: 3 })).toEqual(['measured']);
    expect(deriveEarnedBadges({ ...NO_STATS, measuredReports: 2 })).toEqual([]);
    expect(deriveEarnedBadges({ ...NO_STATS, reportsCorroborated: 1 })).toEqual(['corroborator']);
    expect(deriveEarnedBadges({ ...NO_STATS, negativeReportsHelpful: 1 })).toEqual([
      'straight_shooter',
    ]);
  });

  it('returns families in stable BADGE_TYPES order', () => {
    expect(
      deriveEarnedBadges({
        ...NO_STATS,
        measuredReports: 3,
        reportsWithHelpfulThumbs: 1,
        helpfulThumbsReceived: 10,
      }),
    ).toEqual(['trusted_reporter', 'appreciated', 'measured']);
  });
});
