import { describe, expect, it } from 'vitest';
import {
  type BodySummary,
  qualityDotsFor,
  qualityMarkLabel,
  SUMMARY_QUALITY_DOTS,
  SUMMARY_QUALITY_QUORUM,
  summarizeQuality,
  summaryHasCard,
  summaryTitle,
  topHazardTypes,
} from './bodySummary';

function summary(over: Partial<BodySummary> = {}): BodySummary {
  return { recentReportCount: 0, topHazardTypes: [], updatedAt: 0, ...over };
}

describe('summarizeQuality', () => {
  /** D86's load-bearing rule. One opinion rendered as consensus is the worst failure here. */
  it('renders no dots at all below quorum — never a low score', () => {
    expect(summarizeQuality(['poor'])).toEqual({});
    expect(summarizeQuality(['poor', 'poor'])).toEqual({});
    expect(SUMMARY_QUALITY_QUORUM).toBe(3);
  });

  it('distinguishes "no dots" from "bad ice"', () => {
    const belowQuorum = summarizeQuality(['poor', 'poor']);
    const atQuorum = summarizeQuality(['poor', 'poor', 'poor']);
    expect(belowQuorum.qualityDots).toBeUndefined();
    expect(atQuorum.qualityDots).toBe(1);
  });

  it('summarises the mean once quorum is met, and names its denominator', () => {
    expect(summarizeQuality(['great', 'great', 'good'])).toEqual({
      qualityDots: 4, // (4+4+3)/3 = 3.67 → 4
      qualityCount: 3,
    });
  });

  it('ignores unrated reports rather than counting them as poor', () => {
    // Three rated + two unrated: the mean is over the three, not diluted by silence.
    expect(summarizeQuality(['good', 'good', 'good', undefined, undefined])).toEqual({
      qualityDots: 3,
      qualityCount: 3,
    });
  });

  it('does not reach quorum on unrated reports alone', () => {
    expect(summarizeQuality([undefined, undefined, undefined, undefined])).toEqual({});
  });

  it('never returns zero dots, since zero would read as a rating', () => {
    const result = summarizeQuality(['poor', 'poor', 'poor', 'poor']);
    expect(result.qualityDots).toBeGreaterThanOrEqual(1);
  });
});

describe('qualityDotsFor', () => {
  it('clamps to the scale', () => {
    expect(qualityDotsFor(0)).toBe(1);
    expect(qualityDotsFor(9)).toBe(SUMMARY_QUALITY_DOTS);
  });

  it('rounds a half toward the generous end', () => {
    expect(qualityDotsFor(3.5)).toBe(4);
  });
});

describe('topHazardTypes', () => {
  it('orders by frequency, most frequent first', () => {
    expect(topHazardTypes(['slush', 'open_water', 'open_water'])).toEqual(['open_water', 'slush']);
  });

  it('caps the list so a card stays glanceable', () => {
    expect(topHazardTypes(['a', 'b', 'c', 'd', 'e'])).toHaveLength(3);
  });

  it('breaks ties stably, so a card does not shuffle between renders', () => {
    expect(topHazardTypes(['b', 'a'])).toEqual(['a', 'b']);
  });

  it('is empty for a body with no hazards', () => {
    expect(topHazardTypes([])).toEqual([]);
  });
});

describe('summaryHasCard (E3)', () => {
  it('draws a card for recent reports', () => {
    expect(summaryHasCard(summary({ recentReportCount: 2 }))).toBe(true);
  });

  it('draws a card for active hazards even with no reports', () => {
    expect(summaryHasCard(summary({ topHazardTypes: ['open_water'] }))).toBe(true);
  });

  /** The rule that makes this shippable into a corpus with two reports in it. */
  it('draws NOTHING when there is no activity, rather than an empty card', () => {
    expect(summaryHasCard(summary())).toBe(false);
    expect(summaryHasCard(null)).toBe(false);
    expect(summaryHasCard(undefined)).toBe(false);
  });

  it('does not treat a name as news — the trigger is activity', () => {
    // A named body with no activity has no summary worth drawing; the name is irrelevant here,
    // which is precisely why `summaryHasCard` never sees it.
    expect(summaryHasCard(summary({ recentReportCount: 0, topHazardTypes: [] }))).toBe(false);
  });
});

describe('summaryTitle', () => {
  it('disambiguates a generic name with its town, like the Phase 5 feed card', () => {
    expect(summaryTitle({ name: 'Beaver Pond', place: 'Marshfield' })).toBe(
      'Beaver Pond · Marshfield',
    );
  });

  it('uses the name alone when there is no place', () => {
    expect(summaryTitle({ name: 'Lake Willoughby' })).toBe('Lake Willoughby');
  });

  it('falls back to the place for an unnamed body, and to nothing at all', () => {
    expect(summaryTitle({ place: 'Marshfield' })).toBe('Marshfield');
    expect(summaryTitle({})).toBeUndefined();
  });
});

describe('qualityMarkLabel', () => {
  it('states the denominator the glance omits', () => {
    expect(qualityMarkLabel(summary({ qualityDots: 3, qualityCount: 12 }))).toBe(
      'Rated 3 of 4 by 12 recent reports',
    );
  });

  it('is singular for one report', () => {
    expect(qualityMarkLabel(summary({ qualityDots: 2, qualityCount: 1 }))).toBe(
      'Rated 2 of 4 by 1 recent report',
    );
  });

  it('has no label when there is no mark', () => {
    expect(qualityMarkLabel(summary())).toBeUndefined();
  });
});
