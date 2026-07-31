import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RECURRENCE_FAMILIES, type RecurrenceFamily } from './hazardCluster';
import {
  isPubliclyVisible,
  medoidOf,
  publicMinSeasonsFor,
  RECURRENCE_ADVISORIES_PUBLIC,
  RECURRENCE_PUBLIC_MIN_SEASONS,
  RECURRENCE_WINDOW_SEASONS,
  type RecurrenceScoreInput,
  rankRecurrence,
  recurrencePriority,
  suggestedFeatureTypeFor,
  tierForTypes,
  VOLATILE_MIN_SEASONS,
} from './hazardRecurrence';

function score(overrides: Partial<RecurrenceScoreInput> = {}): RecurrenceScoreInput {
  return {
    seasonsObserved: 2,
    windowSeasons: RECURRENCE_WINDOW_SEASONS,
    tier: 'C',
    seasonsSinceLastObserved: 0,
    confirmationsPerSeason: 1,
    healedSeasons: 0,
    neverExistedCount: 0,
    ...overrides,
  };
}

describe('suggestedFeatureTypeFor', () => {
  it('proposes something for every family a record can be about', () => {
    for (const family of RECURRENCE_FAMILIES) {
      expect(suggestedFeatureTypeFor(family)).not.toBeNull();
    }
  });

  it('mirrors promotionTargetFor for the four that already promoted', () => {
    expect(suggestedFeatureTypeFor('ridge')).toBe('recurring_pressure_ridge');
    expect(suggestedFeatureTypeFor('spring')).toBe('spring_current');
    expect(suggestedFeatureTypeFor('gas')).toBe('gas_hole');
    expect(suggestedFeatureTypeFor('reef')).toBe('reef_hole');
  });

  it('reaches the type no hazard could reach', () => {
    // The whole argument for §C7: a single winter's thin patch is weather, and N5a scored tier-A at
    // zero promotability. A spot that goes out early every March is a property of the lake bed.
    expect(suggestedFeatureTypeFor('volatile')).toBe('shallow_early_thaw');
  });
});

describe('the public bar', () => {
  it('is off entirely while the master switch is off', () => {
    expect(RECURRENCE_ADVISORIES_PUBLIC).toBe(false);
    expect(isPubliclyVisible({ family: 'ridge', seasonsObserved: [2024, 2025, 2026, 2027] })).toBe(
      false,
    );
  });

  it('holds the volatile family to a higher bar than everything else', () => {
    expect(publicMinSeasonsFor('volatile')).toBe(VOLATILE_MIN_SEASONS);
    expect(publicMinSeasonsFor('volatile')).toBeGreaterThan(publicMinSeasonsFor('ridge'));
    expect(publicMinSeasonsFor('ridge')).toBe(RECURRENCE_PUBLIC_MIN_SEASONS);
  });

  it('never shows a suppressed or promoted cluster, whatever the flag says', () => {
    // Asserted against the bar directly, since the master switch short-circuits ahead of both.
    const seasons = [2024, 2025, 2026, 2027];
    for (const cluster of [
      { family: 'ridge' as RecurrenceFamily, seasonsObserved: seasons, suppressedAt: 1 },
      { family: 'ridge' as RecurrenceFamily, seasonsObserved: seasons, promotedToFeatureId: 'f1' },
    ]) {
      expect(isPubliclyVisible(cluster)).toBe(false);
    }
  });
});

describe('recurrencePriority', () => {
  it('is dominated by seasons observed — the only input about recurrence', () => {
    // Four winters of a volatile hazard nobody confirmed must outrank one winter of a tier-D one with
    // every other signal maxed. Anything else is `rankPromotionCandidates` with extra steps.
    const recurring = score({ seasonsObserved: 4, tier: 'A', confirmationsPerSeason: 0 });
    const oneGoodWinter = score({ seasonsObserved: 1, tier: 'D', confirmationsPerSeason: 10 });
    expect(recurrencePriority(recurring)).toBeGreaterThan(recurrencePriority(oneGoodWinter));
  });

  it('rises with each additional winter', () => {
    const seasons = [1, 2, 3, 4].map((n) => recurrencePriority(score({ seasonsObserved: n })));
    for (let i = 1; i < seasons.length; i++) {
      expect(seasons[i] as number).toBeGreaterThan(seasons[i - 1] as number);
    }
  });

  it('falls as the pattern recedes — a pattern that stopped is evidence too', () => {
    const lastWinter = recurrencePriority(score({ seasonsSinceLastObserved: 0 }));
    const threeAgo = recurrencePriority(score({ seasonsSinceLastObserved: 3 }));
    expect(threeAgo).toBeLessThan(lastWinter);
  });

  it('counts corroboration per season, so one loud winter cannot buy a pattern', () => {
    const quietRecurring = score({ seasonsObserved: 3, confirmationsPerSeason: 1 });
    const loudOnce = score({ seasonsObserved: 1, confirmationsPerSeason: 10 });
    expect(recurrencePriority(quietRecurring)).toBeGreaterThan(recurrencePriority(loudOnce));
  });

  it('subtracts "never existed" far harder than "it healed"', () => {
    // "It healed in March" is a fact about last winter. "There was never anything here" is a claim the
    // report was bogus, which is the opposite of corroboration.
    const base = recurrencePriority(score());
    const healed = recurrencePriority(score({ healedSeasons: 1 }));
    const bogus = recurrencePriority(score({ neverExistedCount: 1 }));
    expect(healed).toBeLessThan(base);
    expect(bogus).toBeLessThan(healed);
  });

  it('stays inside 0–1 for anything at all (property)', () => {
    // A score outside the range would render as a nonsense bar and, worse, would reorder silently.
    fc.assert(
      fc.property(
        fc.record({
          seasonsObserved: fc.integer({ min: 0, max: 20 }),
          windowSeasons: fc.integer({ min: 0, max: 10 }),
          tier: fc.constantFrom<'A' | 'B' | 'C' | 'D'>('A', 'B', 'C', 'D'),
          seasonsSinceLastObserved: fc.integer({ min: 0, max: 20 }),
          confirmationsPerSeason: fc.double({ min: 0, max: 50, noNaN: true }),
          healedSeasons: fc.integer({ min: 0, max: 20 }),
          neverExistedCount: fc.integer({ min: 0, max: 20 }),
        }),
        (input) => {
          const value = recurrencePriority(input);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
          expect(Number.isFinite(value)).toBe(true);
        },
      ),
    );
  });

  it('is monotone in seasons observed, all else equal (property)', () => {
    // The invariant that would make a sign error visible: more winters can never rank lower.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3 }),
        fc.constantFrom<'A' | 'B' | 'C' | 'D'>('A', 'B', 'C', 'D'),
        fc.integer({ min: 0, max: 4 }),
        (seasons, tier, since) => {
          const fewer = recurrencePriority(
            score({ seasonsObserved: seasons, tier, seasonsSinceLastObserved: since }),
          );
          const more = recurrencePriority(
            score({ seasonsObserved: seasons + 1, tier, seasonsSinceLastObserved: since }),
          );
          expect(more).toBeGreaterThanOrEqual(fewer);
        },
      ),
    );
  });

  it('survives a zero-length window without dividing by it', () => {
    expect(recurrencePriority(score({ windowSeasons: 0 }))).toBeGreaterThanOrEqual(0);
  });
});

describe('rankRecurrence', () => {
  it('sorts most promotable first and drops nothing', () => {
    // Unlike `rankPromotionCandidates`, which drops what cannot be acted on: a low score is a low
    // place in the queue, not a reason to hide a winter's history from the operator.
    const ranked = rankRecurrence([
      score({ seasonsObserved: 1, tier: 'A' }),
      score({ seasonsObserved: 4, tier: 'D' }),
      score({ seasonsObserved: 2 }),
    ]);
    expect(ranked).toHaveLength(3);
    expect(ranked[0]?.seasonsObserved).toBe(4);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i]?.priority).toBeLessThanOrEqual(ranked[i - 1]?.priority as number);
    }
  });
});

describe('tierForTypes', () => {
  it('takes the most permanent tier in the cluster', () => {
    expect(tierForTypes(['thin_ice', 'pressure_ridge'])).toBe('C');
    expect(tierForTypes(['thin_ice', 'open_water'])).toBe('A');
    expect(tierForTypes(['spring_current'])).toBe('D');
  });

  it('is tier A for an empty cluster rather than throwing', () => {
    expect(tierForTypes([])).toBe('A');
  });
});

describe('medoidOf', () => {
  const at = (id: string, lat: number, firstReportedAt = 1) => ({
    id,
    centre: { lat, lng: -72.5 },
    firstReportedAt,
  });

  it('picks a member, never an average — a promoted cluster inherits a real shape', () => {
    const chosen = medoidOf([at('north', 44.52), at('middle', 44.5), at('south', 44.48)]);
    expect(chosen?.id).toBe('middle');
  });

  it('breaks a tie on the earliest sighting, so recomputes are stable', () => {
    // A representative that flipped between two equidistant pins would rewrite a promoted feature's
    // shape on a job nobody ran on purpose.
    const first = medoidOf([at('later', 44.5, 900), at('earlier', 44.5, 100)]);
    expect(first?.id).toBe('earlier');
    const reversed = medoidOf([at('earlier', 44.5, 100), at('later', 44.5, 900)]);
    expect(reversed?.id).toBe('earlier');
  });

  it('returns null for an empty cluster', () => {
    expect(medoidOf([])).toBeNull();
  });
});
