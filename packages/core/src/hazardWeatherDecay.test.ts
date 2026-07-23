import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deriveHazardFreshness } from './hazardDecay';
import {
  decayMultiplier,
  freshnessWithMultiplier,
  HAZARD_WEATHER_RESPONSE,
  isSnowHidden,
  weatherAdjustedFreshness,
  weatherDecaySignal,
} from './hazardWeatherDecay';
import { HAZARD_TYPES } from './types';
import type { WeatherSinceSummary } from './weather';

const HOUR_MS = 3_600_000;
const NOW = 1_000_000_000_000; // fixed epoch (Date is unavailable / nondeterministic in tests)

/** Build a summary with the fields the decay model reads; everything else neutral. */
function wx(partial: Partial<WeatherSinceSummary> = {}): WeatherSinceSummary {
  return {
    hours: 24,
    peakTempC: 0,
    minTempC: 0,
    hoursNearFreezing: 0,
    hoursAboveFreezing: 0,
    nightsBelowFreezing: 0,
    hoursOfSun: 0,
    totalPrecipMm: 0,
    rainMm: 0,
    snowfallCm: 0,
    maxSnowDepthM: null,
    maxWindKph: null,
    maxWindGustKph: null,
    windRunKm: 0,
    freezingDegreeHours: 0,
    thawDegreeHours: 0,
    insolationWhM2: 0,
    longestFreezeRunHours: 0,
    freezeThawCycles: 0,
    ...partial,
  };
}

const arbWeather = fc
  .record({
    freezingDegreeHours: fc.double({ min: 0, max: 2000, noNaN: true }),
    thawDegreeHours: fc.double({ min: 0, max: 2000, noNaN: true }),
    snowfallCm: fc.double({ min: 0, max: 60, noNaN: true }),
  })
  .map((p) => wx(p));

const arbType = fc.constantFrom(...HAZARD_TYPES);
const STRUCTURAL_TYPES = ['pressure_ridge', 'ice_heave', 'ridge_crossing'] as const;
const REFREEZE_TYPES = ['open_water', 'thin_ice', 'drain_hole', 'wind_hole'] as const;

describe('decayMultiplier (D56) — concrete behavior', () => {
  it('fails open: empty weather ⇒ multiplier 1, not snow-hidden, for every type', () => {
    for (const type of HAZARD_TYPES) {
      const s = weatherDecaySignal(type, wx({ hours: 0, snowfallCm: 50 }));
      expect(s.multiplier).toBe(1);
      expect(s.snowHidden).toBe(false);
    }
  });

  it('weather-insensitive types stay ≈×1 regardless of weather', () => {
    for (const type of ['spring_current', 'gas_hole', 'reef_hole'] as const) {
      expect(decayMultiplier(type, wx({ freezingDegreeHours: 500 }))).toBe(1);
      expect(decayMultiplier(type, wx({ thawDegreeHours: 500 }))).toBe(1);
    }
  });

  it('refreeze-healed: cold fades faster (m>1), thaw persists (m<1)', () => {
    expect(decayMultiplier('open_water', wx({ freezingDegreeHours: 120 }))).toBeCloseTo(2.0); // cap
    expect(decayMultiplier('open_water', wx({ thawDegreeHours: 90 }))).toBeCloseTo(0.5); // floor
  });

  it('structural (ridges): thaw escalates (m≥1), cold never discounts (m=1)', () => {
    expect(decayMultiplier('pressure_ridge', wx({ thawDegreeHours: 90 }))).toBeCloseTo(1.75);
    expect(decayMultiplier('pressure_ridge', wx({ freezingDegreeHours: 500 }))).toBe(1);
  });

  it('rotten: cold never earns a persistence discount (≥1), thaw keeps the warning up (<1)', () => {
    expect(
      decayMultiplier('thawed_rotten', wx({ freezingDegreeHours: 120 })),
    ).toBeGreaterThanOrEqual(1);
    // Only a LOT of extended cold nudges it up, and only mildly (capped 1.5).
    expect(decayMultiplier('thawed_rotten', wx({ freezingDegreeHours: 2000 }))).toBeCloseTo(1.5);
    expect(decayMultiplier('thawed_rotten', wx({ thawDegreeHours: 90 }))).toBeLessThan(1);
  });

  it('snow damps cold acceleration and flags snow-hidden, but never accelerates', () => {
    const noSnow = decayMultiplier('open_water', wx({ freezingDegreeHours: 120 }));
    const snowy = weatherDecaySignal(
      'open_water',
      wx({ freezingDegreeHours: 120, snowfallCm: 10 }),
    );
    expect(snowy.multiplier).toBeLessThan(noSnow);
    expect(snowy.multiplier).toBeGreaterThanOrEqual(1); // damped, not below 1 (still net cold)
    expect(snowy.snowHidden).toBe(true);
    expect(isSnowHidden(wx({ snowfallCm: 0.5 }))).toBe(false);
    expect(isSnowHidden(wx({ snowfallCm: 2 }))).toBe(true);
  });
});

describe('decayMultiplier (D56) — sign-flip & bound invariants (property)', () => {
  it('every hazard type has a weather-response class', () => {
    for (const type of HAZARD_TYPES) expect(HAZARD_WEATHER_RESPONSE[type]).toBeDefined();
  });

  it('sign-flip 1: thawed_rotten never gets a cold persistence discount (m≥1 without thaw)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 2000, noNaN: true }),
        fc.double({ min: 0, max: 60, noNaN: true }),
        (fdh, snow) => {
          const m = decayMultiplier(
            'thawed_rotten',
            wx({ freezingDegreeHours: fdh, thawDegreeHours: 0, snowfallCm: snow }),
          );
          expect(m).toBeGreaterThanOrEqual(1);
        },
      ),
    );
  });

  it('sign-flip 2: structural types are floored at 1 and escalate monotonically with thaw', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STRUCTURAL_TYPES),
        arbWeather,
        fc.double({ min: 0, max: 500, noNaN: true }),
        (type, w, extraThaw) => {
          const m = decayMultiplier(type, w);
          expect(m).toBeGreaterThanOrEqual(1); // cold never discounts a ridge
          const more = decayMultiplier(
            type,
            wx({ ...w, thawDegreeHours: w.thawDegreeHours + extraThaw }),
          );
          expect(more).toBeGreaterThanOrEqual(m - 1e-9); // more thaw ⇒ ages at least as fast
        },
      ),
    );
  });

  it('sign-flip 3: snowfall never increases the multiplier (only damps cold)', () => {
    fc.assert(
      fc.property(
        arbType,
        arbWeather,
        fc.double({ min: 0, max: 200, noNaN: true }),
        (type, w, extraSnow) => {
          const before = decayMultiplier(type, w);
          const after = decayMultiplier(type, wx({ ...w, snowfallCm: w.snowfallCm + extraSnow }));
          expect(after).toBeLessThanOrEqual(before + 1e-9);
        },
      ),
    );
  });

  it('refreeze-healed: pure cold ⇒ m≥1, pure thaw ⇒ m≤1', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...REFREEZE_TYPES),
        fc.double({ min: 0, max: 2000, noNaN: true }),
        (type, degHours) => {
          expect(
            decayMultiplier(type, wx({ freezingDegreeHours: degHours })),
          ).toBeGreaterThanOrEqual(1);
          expect(decayMultiplier(type, wx({ thawDegreeHours: degHours }))).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  it('the multiplier is always finite, positive and within bounds', () => {
    fc.assert(
      fc.property(arbType, arbWeather, (type, w) => {
        const m = decayMultiplier(type, w);
        expect(Number.isFinite(m)).toBe(true);
        expect(m).toBeGreaterThan(0);
        expect(m).toBeLessThanOrEqual(2.0);
        expect(m).toBeGreaterThanOrEqual(0.5);
      }),
    );
  });
});

describe('weatherAdjustedFreshness (D56) — the never-hide invariant', () => {
  it('weather alone can never push a hazard into stale (only real elapsed time can)', () => {
    fc.assert(
      fc.property(
        arbType,
        fc.integer({ min: 0, max: 2000 }), // elapsed hours since last confirmation
        arbWeather,
        (type, elapsedHours, w) => {
          const lastConfirmedAt = NOW - elapsedHours * HOUR_MS;
          const baseline = deriveHazardFreshness(type, lastConfirmedAt, NOW);
          const adjusted = weatherAdjustedFreshness(type, lastConfirmedAt, NOW, w);
          if (baseline !== 'stale') {
            expect(adjusted.freshness).not.toBe('stale');
          }
        },
      ),
    );
  });

  it('acceleration can age fresh→aging; deceleration can keep a pin fresher (both allowed)', () => {
    // A refreeze-healed hazard just past its fresh window, hit by a hard freeze → aging, not fresh.
    const type = 'open_water';
    const lastConfirmedAt = NOW - 20 * HOUR_MS; // < 24h fresh window ⇒ baseline fresh
    const hardFreeze = wx({ freezingDegreeHours: 200 });
    expect(deriveHazardFreshness(type, lastConfirmedAt, NOW)).toBe('fresh');
    expect(weatherAdjustedFreshness(type, lastConfirmedAt, NOW, hardFreeze).freshness).toBe(
      'aging',
    );

    // The same hazard under a sustained thaw stays fresh longer (deceleration keeps it visible).
    const oldish = NOW - 30 * HOUR_MS; // baseline aging (24–72h)
    const thaw = wx({ thawDegreeHours: 200 });
    expect(deriveHazardFreshness(type, oldish, NOW)).toBe('aging');
    expect(weatherAdjustedFreshness(type, oldish, NOW, thaw).freshness).toBe('fresh');
  });

  it('freshnessWithMultiplier(1) is exactly the base decay (fail-open online path)', () => {
    fc.assert(
      fc.property(arbType, fc.integer({ min: 0, max: 2000 }), (type, elapsedHours) => {
        const lastConfirmedAt = NOW - elapsedHours * HOUR_MS;
        expect(freshnessWithMultiplier(type, lastConfirmedAt, NOW, 1)).toBe(
          deriveHazardFreshness(type, lastConfirmedAt, NOW),
        );
      }),
    );
  });

  it('the stored-multiplier path matches the full weather path (same never-hide bound)', () => {
    // The online query stores the multiplier and recomputes via freshnessWithMultiplier; it must equal
    // what weatherAdjustedFreshness produces from the weather it was derived from.
    fc.assert(
      fc.property(
        arbType,
        fc.integer({ min: 0, max: 2000 }),
        arbWeather,
        (type, elapsedHours, w) => {
          const lastConfirmedAt = NOW - elapsedHours * HOUR_MS;
          const full = weatherAdjustedFreshness(type, lastConfirmedAt, NOW, w);
          expect(freshnessWithMultiplier(type, lastConfirmedAt, NOW, full.multiplier)).toBe(
            full.freshness,
          );
        },
      ),
    );
  });

  it('passes the multiplier and snow-hidden flag through for the caller (§6 stores them)', () => {
    const r = weatherAdjustedFreshness(
      'open_water',
      NOW - 10 * HOUR_MS,
      NOW,
      wx({ freezingDegreeHours: 120, snowfallCm: 5 }),
    );
    expect(r.multiplier).toBeGreaterThan(1);
    expect(r.snowHidden).toBe(true);
  });
});
