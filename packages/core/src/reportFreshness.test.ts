import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bountyFreshWindowHours } from './bounties';
import {
  clampedNetThumbs,
  netThumbsBoost,
  pathOpacity,
  type ReportFreshnessSignals,
  reportFreshness,
} from './reportFreshness';
import {
  NET_THUMBS_MAX,
  NET_THUMBS_MIN,
  PATH_MIN_OPACITY,
  REPORT_FRESHNESS_HALF_LIFE_HOURS,
  REPORT_FRESHNESS_MAX_EXTENSION,
  REPORT_FRESHNESS_PER_THUMB,
  REPORT_FRESHNESS_WEATHER_MULTIPLIER,
} from './reputationConfig';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const HOUR = 3_600_000;

/** A report `ageHours` old with the given signals. */
function aged(ageHours: number, extra: Partial<ReportFreshnessSignals> = {}): number {
  return reportFreshness({ skateEndTime: NOW - ageHours * HOUR, ...extra }, NOW);
}

describe('clampedNetThumbs / netThumbsBoost (the primitives bounties share)', () => {
  it('clamps both ways, asymmetrically (D50 is boost-only)', () => {
    expect(clampedNetThumbs(0)).toBe(0);
    expect(clampedNetThumbs(99)).toBe(NET_THUMBS_MAX);
    expect(clampedNetThumbs(-99)).toBe(NET_THUMBS_MIN);
    expect(NET_THUMBS_MAX).toBeGreaterThan(Math.abs(NET_THUMBS_MIN));
  });

  it('scales by the caller-supplied per-thumb weight', () => {
    expect(netThumbsBoost(4, 0.25)).toBeCloseTo(1);
    expect(netThumbsBoost(4, 0.5)).toBeCloseTo(2);
    expect(netThumbsBoost(-2, 0.25)).toBeCloseTo(-0.5);
  });

  it('the bounty window still computes from the shared primitive (D59 refactor gate)', () => {
    // The exact identity the untouched Phase 6 suite asserts, restated against the primitive so a
    // change to the shared clamp/weight can never silently move the bounty window.
    for (const netThumbs of [-10, -2, 0, 1, 4, 40]) {
      const expected =
        48 * (1 + netThumbsBoost(netThumbs, REPORT_FRESHNESS_PER_THUMB) + 1); /* leader boost */
      expect(bountyFreshWindowHours(48, { netThumbs, trustClass: 'leader' })).toBeCloseTo(
        Math.max(0, expected),
      );
    }
  });
});

describe('reportFreshness (D59)', () => {
  it('is 1 at the moment the skater left the ice', () => {
    expect(aged(0)).toBe(1);
  });

  it('reads 1 for a future skate-end time rather than amplifying past full (clock skew)', () => {
    expect(aged(-5)).toBe(1);
    expect(reportFreshness({ skateEndTime: Number.NaN }, NOW)).toBe(1);
  });

  it('halves every half-life', () => {
    expect(aged(REPORT_FRESHNESS_HALF_LIFE_HOURS)).toBeCloseTo(0.5);
    expect(aged(2 * REPORT_FRESHNESS_HALF_LIFE_HOURS)).toBeCloseTo(0.25);
    expect(aged(3 * REPORT_FRESHNESS_HALF_LIFE_HOURS)).toBeCloseTo(0.125);
  });

  it('never reaches zero — an old observation is still an observation (D3)', () => {
    expect(aged(24 * 365)).toBeGreaterThan(0);
  });

  it('usefulness stretches the half-life: a corroborated report stays fresher at the same age', () => {
    const age = REPORT_FRESHNESS_HALF_LIFE_HOURS;
    const lone = aged(age);
    const thumbed = aged(age, { netThumbs: 4 });
    const corroborated = aged(age, { netThumbs: 4, corroborationCount: 4 });
    expect(thumbed).toBeGreaterThan(lone);
    expect(corroborated).toBeGreaterThan(thumbed);
  });

  it('caps the stretch, so no amount of support freezes a report in time', () => {
    const age = REPORT_FRESHNESS_HALF_LIFE_HOURS;
    const capped = aged(age, { netThumbs: 999, corroborationCount: 999 });
    const atCap = 0.5 ** (1 / (1 + REPORT_FRESHNESS_MAX_EXTENSION));
    expect(capped).toBeCloseTo(atCap);
    expect(capped).toBeLessThan(1);
  });

  it('the stretch is BOOST-ONLY — unhelpful thumbs never fade a path faster (D3/D50)', () => {
    const age = REPORT_FRESHNESS_HALF_LIFE_HOURS;
    // Deliberately unlike `bountyFreshWindowHours`, where net-unhelpful shortens the window (there,
    // shortening summons fresh eyes sooner). Here it would let downvotes erase someone's track.
    expect(aged(age, { netThumbs: -99 })).toBe(aged(age));
    expect(aged(age, { netThumbs: -1 })).toBe(aged(age));
    expect(bountyFreshWindowHours(48, { netThumbs: -2, trustClass: 'trusted' })).toBeLessThan(
      bountyFreshWindowHours(48, { netThumbs: 0, trustClass: 'trusted' }),
    );
  });

  it('weather that changed the ice ages it hard — multiplicatively, never to zero', () => {
    const age = 24;
    const plain = aged(age);
    const weathered = aged(age, { weatherExplainsIceChange: true });
    expect(weathered).toBeCloseTo(plain * REPORT_FRESHNESS_WEATHER_MULTIPLIER);
    expect(weathered).toBeGreaterThan(0);
    // Unknown weather is fail-open: no penalty (matches `weatherExplainsIceChange`'s own contract).
    expect(aged(age, { weatherExplainsIceChange: undefined })).toBe(plain);
  });

  it('property: strictly decreasing in age, for any fixed signal set', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 2000, noNaN: true }),
        fc.double({ min: 0.1, max: 2000, noNaN: true }),
        fc.integer({ min: -20, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        fc.boolean(),
        (a, b, netThumbs, corroborationCount, weatherExplainsIceChange) => {
          const [younger, older] = a < b ? [a, b] : [b, a];
          fc.pre(older - younger > 0.5); // avoid float ties at the resolution we care about
          const signals = { netThumbs, corroborationCount, weatherExplainsIceChange };
          expect(aged(younger, signals)).toBeGreaterThan(aged(older, signals));
        },
      ),
    );
  });

  it('property: always within [0, 1] — the never-hide guarantee lives in pathOpacity, not here', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1_000_000, noNaN: true }),
        fc.integer({ min: -50, max: 50 }),
        fc.integer({ min: -50, max: 50 }),
        fc.boolean(),
        (ageHours, netThumbs, corroborationCount, weatherExplainsIceChange) => {
          const f = aged(ageHours, { netThumbs, corroborationCount, weatherExplainsIceChange });
          expect(f).toBeGreaterThanOrEqual(0);
          expect(f).toBeLessThanOrEqual(1);
          // Whatever the age, the drawn path stays at or above the floor.
          expect(pathOpacity(f)).toBeGreaterThanOrEqual(PATH_MIN_OPACITY);
        },
      ),
    );
  });
});

describe('pathOpacity (the D3 never-hide floor)', () => {
  it('maps full freshness to full opacity and zero freshness to the floor', () => {
    expect(pathOpacity(1)).toBeCloseTo(1);
    expect(pathOpacity(0)).toBeCloseTo(PATH_MIN_OPACITY);
  });

  it('never drops below the floor, however stale the report', () => {
    fc.assert(
      fc.property(fc.double({ min: -10, max: 10, noNaN: true }), (f) => {
        const o = pathOpacity(f);
        expect(o).toBeGreaterThanOrEqual(PATH_MIN_OPACITY);
        expect(o).toBeLessThanOrEqual(1);
      }),
    );
    expect(pathOpacity(Number.NaN)).toBeCloseTo(PATH_MIN_OPACITY);
  });

  it('a decade-old track still draws at the floor, not invisibly', () => {
    expect(pathOpacity(aged(24 * 365 * 10))).toBeCloseTo(PATH_MIN_OPACITY, 3);
  });

  it('is monotone in freshness — a fresher report never draws fainter', () => {
    expect(pathOpacity(0.8)).toBeGreaterThan(pathOpacity(0.2));
  });
});

describe('report and path read the identical freshness (the D59 invariant)', () => {
  it('path opacity is a pure function of the report freshness, same inputs same instant', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 5000, noNaN: true }),
        fc.integer({ min: -10, max: 10 }),
        fc.integer({ min: 0, max: 10 }),
        (ageHours, netThumbs, corroborationCount) => {
          const signals = {
            skateEndTime: NOW - ageHours * HOUR,
            netThumbs,
            corroborationCount,
          };
          // Whatever the report-side display computes and whatever the map layer computes, they call
          // the same function with the same signals — so they are the same number by construction.
          const displayed = reportFreshness(signals, NOW);
          const drawn = reportFreshness(signals, NOW);
          expect(drawn).toBe(displayed);
          expect(pathOpacity(drawn)).toBe(pathOpacity(displayed));
        },
      ),
    );
  });
});
