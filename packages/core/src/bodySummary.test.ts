import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type BodySummary,
  qualityDotsFor,
  qualityMarkLabel,
  SUMMARY_QUALITY_DOTS,
  SUMMARY_QUALITY_QUORUM,
  SUMMARY_WINDOW_MS,
  summarizeQuality,
  summarizeQualityRevealed,
  summaryHasCard,
  summaryRefreshAt,
  summaryTitle,
  summaryWindowStart,
  topHazardTypes,
} from './bodySummary';
import { currentSeason, isInSeason, seasonEndMs } from './season';

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

  it('summarizes the mean once quorum is met, and names its denominator', () => {
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

describe('summaryHasCard (A06c §5.3)', () => {
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
  it('disambiguates a generic name with its town, like the Phase 05 feed card', () => {
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

describe('the reveal flag (A06c-2)', () => {
  it('draws a card for every body with a summary, empty ones included', () => {
    expect(summaryHasCard(summary(), true)).toBe(true);
    expect(summaryHasCard(summary({ recentReportCount: 3 }), true)).toBe(true);
  });

  /** The flag reveals what the rules hide — not bodies the sweep has never touched. */
  it('still needs a summary to exist', () => {
    expect(summaryHasCard(null, true)).toBe(false);
    expect(summaryHasCard(undefined, true)).toBe(false);
  });

  it('changes nothing when off', () => {
    expect(summaryHasCard(summary(), false)).toBe(false);
    expect(summaryHasCard(summary())).toBe(false);
  });

  it('widens the quality mark below quorum, and says that it did', () => {
    const revealed = summarizeQualityRevealed(['great', 'good'], true);
    expect(revealed.qualityDots).toBe(4); // (4+3)/2 = 3.5 → 4
    expect(revealed.qualityCount).toBe(2);
    expect(revealed.revealed).toBe(true);
  });

  it('does not mark an honestly-earned score as revealed', () => {
    const honest = summarizeQualityRevealed(['good', 'good', 'good'], true);
    expect(honest.qualityDots).toBe(3);
    expect(honest.revealed).toBeUndefined();
  });

  it('invents nothing when there are no ratings at all', () => {
    expect(summarizeQualityRevealed([undefined, undefined], true)).toEqual({});
  });

  it('leaves the honest summary untouched when off', () => {
    expect(summarizeQualityRevealed(['great', 'good'], false)).toEqual({});
  });

  /**
   * The stored summary is written by the server, which has no business knowing about a client
   * display flag — so the quorum-respecting function is the one the storage path calls, and a
   * below-quorum mark can never be persisted.
   */
  it('leaves `summarizeQuality` — the stored path — strictly quorum-respecting', () => {
    expect(summarizeQuality(['great', 'good'])).toEqual({});
  });
});

describe('summaryRefreshAt — when time next changes a card', () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const NOW = Date.UTC(2027, 0, 20, 12);

  /** The report half of a card at `t`, as `recomputeBodySummary` filters it. */
  const inCard = (times: readonly number[], t: number) =>
    times.filter((r) => r >= summaryWindowStart(t) && isInSeason(r, currentSeason(t)));

  it('is null with no reports: time alone cannot change a card with none', () => {
    expect(summaryRefreshAt([], NOW)).toBeNull();
  });

  it('is the moment the oldest report leaves the window', () => {
    const oldest = NOW - 10 * DAY;
    const at = summaryRefreshAt([NOW - DAY, oldest], NOW);
    expect(at).toBe(oldest + SUMMARY_WINDOW_MS + 1);
    expect(inCard([oldest], (at as number) - 1)).toEqual([oldest]);
    expect(inCard([oldest], at as number)).toEqual([]);
  });

  it('is the season end when that comes first', () => {
    const lateJune = Date.UTC(2027, 5, 28);
    expect(summaryRefreshAt([lateJune - DAY], lateJune)).toBe(seasonEndMs(currentSeason(lateJune)));
  });

  it('is always later than now, even for a time outside the window', () => {
    expect(summaryRefreshAt([NOW - 40 * DAY], NOW)).toBe(NOW + 1);
  });

  /**
   * The invariant the sweep rests on: **nothing the card counts can change before `refreshAt`**, so
   * a sweep that reads only due rows never leaves a stale card. Report times are drawn the way the
   * recompute reads them — inside the window at `now`, up to the write path's hour of future
   * tolerance — and `now` ranges across season boundaries.
   */
  it('property: the card is the same at every instant from now until refreshAt', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2030, 0, 1) }),
        fc.array(fc.integer({ min: -SUMMARY_WINDOW_MS, max: HOUR }), { maxLength: 12 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (now, offsets, frac) => {
          const times = offsets.map((o) => now + o);
          const at = summaryRefreshAt(times, now);
          if (times.length === 0) {
            expect(at).toBeNull();
            return;
          }
          expect(at).not.toBeNull();
          const refreshAt = at as number;
          expect(refreshAt).toBeGreaterThan(now);
          const t = now + Math.floor(frac * (refreshAt - 1 - now));
          expect(inCard(times, t)).toEqual(inCard(times, now));
          expect(inCard(times, refreshAt - 1)).toEqual(inCard(times, now));
        },
      ),
    );
  });
});
