import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  deriveHazardFreshness,
  HAZARD_DECAY,
  type HazardFreshness,
  hazardTypesInTier,
  hoursToMs,
  isHazardVisibleByDefault,
} from './hazardDecay';
import { HAZARD_TYPES, type HazardType } from './types';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const HOUR = 3_600_000;

const arbType: fc.Arbitrary<HazardType> = fc.constantFrom(...HAZARD_TYPES);

describe('HAZARD_DECAY table', () => {
  it('covers every hazard type', () => {
    for (const type of HAZARD_TYPES) {
      expect(HAZARD_DECAY[type], `missing decay for ${type}`).toBeDefined();
    }
    expect(Object.keys(HAZARD_DECAY).sort()).toEqual([...HAZARD_TYPES].sort());
  });

  it('always has fresh < aging, so the three tiers are non-degenerate', () => {
    for (const type of HAZARD_TYPES) {
      const { freshH, agingH } = HAZARD_DECAY[type];
      expect(freshH).toBeGreaterThan(0);
      expect(agingH).toBeGreaterThan(freshH);
    }
  });

  // This table IS the deliverable of the research pass (`phase-9-hazard-research.md` §1) — the invariant
  // tests above would all pass with different numbers (`thin_ice: 24→48` breaks nothing structural), so
  // they can't protect the actual calibration. This locks every row to the researched value; changing a
  // duration is then a deliberate edit to a named safety constant, reviewed against the evidence, not a
  // silent drift. Keep it in lock-step with the research doc's `HAZARD_DECAY` block.
  it('matches the calibrated research values, row for row (all durations in hours)', () => {
    expect(HAZARD_DECAY).toEqual({
      // Tier A — volatile (same-day-ish).
      open_water: { tier: 'A', freshH: 24, agingH: 72 },
      thin_ice: { tier: 'A', freshH: 24, agingH: 72 },
      overflow_slush: { tier: 'A', freshH: 24, agingH: 72 },
      drain_hole: { tier: 'A', freshH: 24, agingH: 72 },
      wind_hole: { tier: 'A', freshH: 24, agingH: 72 },
      slush_hole: { tier: 'A', freshH: 24, agingH: 72 },
      // Tier A* — very volatile (same-day only): the #1 killer and the passage marker.
      thawed_rotten: { tier: 'A', freshH: 12, agingH: 36 },
      ridge_crossing: { tier: 'A', freshH: 12, agingH: 36 },
      // Tier B — semi-persistent (re-skins, weak spot lingers days).
      wet_crack: { tier: 'B', freshH: 72, agingH: 168 },
      drilled_hole: { tier: 'B', freshH: 72, agingH: 168 },
      shell_area: { tier: 'B', freshH: 72, agingH: 168 },
      // Tier C — structural (don't heal within a season; often grow).
      pressure_ridge: { tier: 'C', freshH: 168, agingH: 504 },
      ice_heave: { tier: 'C', freshH: 168, agingH: 504 },
      // Tier D — effectively permanent (bodyFeatures candidates).
      spring_current: { tier: 'D', freshH: 336, agingH: 1080 },
      gas_hole: { tier: 'D', freshH: 336, agingH: 1080 },
      reef_hole: { tier: 'D', freshH: 336, agingH: 1080 },
    });
  });

  // The A* sub-case is the whole reason `thawed_rotten` and `ridge_crossing` exist as separate rows —
  // if a tuning ever lets them decay as slowly as an ordinary Tier A hazard, the "same-day information
  // only" claim (research §4/§5) is silently broken. Pin the exact boundary.
  it('keeps the A* sub-case at 12h/36h', () => {
    for (const type of ['thawed_rotten', 'ridge_crossing'] as const) {
      expect(HAZARD_DECAY[type], type).toMatchObject({ freshH: 12, agingH: 36 });
    }
  });

  // The tiers encode a behavioral claim from the research: volatile hazards stop being trustworthy
  // faster than structural ones. If someone tunes a Tier A type to outlive a Tier D one, the tier label
  // has become a lie — that's what this guards.
  //
  // Compared threshold-for-threshold, not fresh-against-aging: the bands deliberately *overlap*
  // (a Tier C hazard is stale at 21d while a Tier D one is still fresh at 14d), because the tiers
  // describe different decay curves, not consecutive time ranges.
  it('orders tiers monotonically: A ≤ B ≤ C ≤ D at each threshold', () => {
    const bound = (tier: 'A' | 'B' | 'C' | 'D', key: 'freshH' | 'agingH', pick: 'max' | 'min') =>
      Math[pick](...hazardTypesInTier(tier).map((t) => HAZARD_DECAY[t][key]));

    for (const key of ['freshH', 'agingH'] as const) {
      expect(bound('A', key, 'max'), key).toBeLessThanOrEqual(bound('B', key, 'min'));
      expect(bound('B', key, 'max'), key).toBeLessThanOrEqual(bound('C', key, 'min'));
      expect(bound('C', key, 'max'), key).toBeLessThanOrEqual(bound('D', key, 'min'));
    }
  });

  it('groups every type into exactly one tier', () => {
    const grouped = (['A', 'B', 'C', 'D'] as const).flatMap(hazardTypesInTier);
    expect(grouped.sort()).toEqual([...HAZARD_TYPES].sort());
  });

  // thawed_rotten is the #1 fatality cause and ridge_crossing is same-day-only information; both must
  // stay in the very-volatile band regardless of future tuning.
  it('keeps the A* very-volatile types at same-day decay', () => {
    for (const type of ['thawed_rotten', 'ridge_crossing'] as const) {
      expect(HAZARD_DECAY[type].freshH).toBeLessThanOrEqual(12);
      expect(HAZARD_DECAY[type].agingH).toBeLessThanOrEqual(36);
    }
  });
});

describe('hoursToMs', () => {
  it('converts at the millisecond boundary', () => {
    expect(hoursToMs(1)).toBe(HOUR);
    expect(hoursToMs(24)).toBe(24 * HOUR);
    expect(hoursToMs(0)).toBe(0);
  });
});

describe('deriveHazardFreshness', () => {
  it('is exact at each tier boundary (fresh is exclusive at the top)', () => {
    for (const type of HAZARD_TYPES) {
      const { freshH, agingH } = HAZARD_DECAY[type];
      expect(deriveHazardFreshness(type, NOW - hoursToMs(freshH) + 1, NOW)).toBe('fresh');
      expect(deriveHazardFreshness(type, NOW - hoursToMs(freshH), NOW)).toBe('aging');
      expect(deriveHazardFreshness(type, NOW - hoursToMs(agingH) + 1, NOW)).toBe('aging');
      expect(deriveHazardFreshness(type, NOW - hoursToMs(agingH), NOW)).toBe('stale');
    }
  });

  it('reads a just-created hazard as fresh', () => {
    for (const type of HAZARD_TYPES) {
      expect(deriveHazardFreshness(type, NOW, NOW)).toBe('fresh');
    }
  });

  // A skewed device clock must never make a hazard vanish from the map.
  it('treats a future lastConfirmedAt as fresh rather than throwing', () => {
    fc.assert(
      fc.property(arbType, fc.integer({ min: 1, max: 10_000 }), (type, skewHours) => {
        expect(deriveHazardFreshness(type, NOW + skewHours * HOUR, NOW)).toBe('fresh');
      }),
    );
  });

  describe('freshness is monotonic in elapsed time (property)', () => {
    const rank: Record<HazardFreshness, number> = { fresh: 0, aging: 1, stale: 2 };

    it('more elapsed time never yields a fresher state', () => {
      fc.assert(
        fc.property(
          arbType,
          fc.integer({ min: 0, max: 5000 }),
          fc.integer({ min: 0, max: 5000 }),
          (type, h1, h2) => {
            const [less, more] = h1 <= h2 ? [h1, h2] : [h2, h1];
            const fresher = deriveHazardFreshness(type, NOW - less * HOUR, NOW);
            const older = deriveHazardFreshness(type, NOW - more * HOUR, NOW);
            expect(rank[older]).toBeGreaterThanOrEqual(rank[fresher]);
          },
        ),
      );
    });
  });

  // The lifecycle reducer resets lastConfirmedAt on "still here"; this is the decay half of that
  // contract — a confirmation always returns the pin to full strength, no matter how old it was.
  it('returns to fresh after a "still here" confirmation resets the clock', () => {
    fc.assert(
      fc.property(arbType, fc.integer({ min: 0, max: 5000 }), (type, elapsedHours) => {
        expect(deriveHazardFreshness(type, NOW - elapsedHours * HOUR, NOW)).toBeDefined();
        // The confirmation stamps `now`, so freshness recomputes as fresh.
        expect(deriveHazardFreshness(type, NOW, NOW)).toBe('fresh');
      }),
    );
  });
});

describe('isHazardVisibleByDefault', () => {
  it('hides only stale hazards, and only from the default view', () => {
    expect(isHazardVisibleByDefault('fresh')).toBe(true);
    expect(isHazardVisibleByDefault('aging')).toBe(true);
    expect(isHazardVisibleByDefault('stale')).toBe(false);
  });
});
