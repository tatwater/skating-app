import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type HourlyWeather, summarizeWeatherSince, weatherExplainsIceChange } from './weather';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const refNightIndex = (startMs: number) => Math.floor((startMs - 12 * HOUR_MS) / DAY_MS);

describe('summarizeWeatherSince (D19 / D56)', () => {
  it('returns an empty summary for no data', () => {
    expect(summarizeWeatherSince([])).toEqual({
      hours: 0,
      peakTempC: null,
      minTempC: null,
      hoursNearFreezing: 0,
      hoursAboveFreezing: 0,
      nightsBelowFreezing: null,
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
    });
  });

  it('summarizes a known window (descriptive + integrals)', () => {
    const hourly: HourlyWeather[] = [
      { temperatureC: -1, precipitationMm: 0, windSpeedKph: 5, sunshineSeconds: 3600 },
      { temperatureC: 3, precipitationMm: 1.5, windSpeedKph: 20, sunshineSeconds: 1800 },
      { temperatureC: 5, precipitationMm: 0.5, windSpeedKph: 12, sunshineSeconds: 0 },
    ];
    const s = summarizeWeatherSince(hourly);
    expect(s.hours).toBe(3);
    expect(s.peakTempC).toBe(5);
    expect(s.minTempC).toBe(-1);
    expect(s.maxWindKph).toBe(20);
    expect(s.hoursNearFreezing).toBe(1); // only -1°C falls in [-2, 2]
    expect(s.hoursAboveFreezing).toBe(2); // 3°C and 5°C
    expect(s.hoursOfSun).toBeCloseTo(1.5); // (3600 + 1800 + 0) / 3600
    expect(s.totalPrecipMm).toBeCloseTo(2);
    // Integrals.
    expect(s.freezingDegreeHours).toBeCloseTo(1); // −1°C → +1
    expect(s.thawDegreeHours).toBeCloseTo(8); // 3 + 5
    expect(s.windRunKm).toBeCloseTo(37); // 5 + 20 + 12
    expect(s.longestFreezeRunHours).toBe(1); // one freezing hour, then thaw
    expect(s.freezeThawCycles).toBe(1); // −1 → 3 is one freeze→thaw onset
    // No split / radiation / gust / depth / timestamps provided.
    expect(s.rainMm).toBe(0);
    expect(s.snowfallCm).toBe(0);
    expect(s.insolationWhM2).toBe(0);
    expect(s.maxWindGustKph).toBeNull();
    expect(s.maxSnowDepthM).toBeNull();
    expect(s.nightsBelowFreezing).toBeNull(); // no startMs
  });

  it('sums the rain/snow split, insolation, gust and snow depth from the raw fields', () => {
    const hourly: HourlyWeather[] = [
      {
        temperatureC: 1,
        precipitationMm: 2,
        windSpeedKph: 10,
        windGustKph: 25,
        rainMm: 2,
        snowfallCm: 0,
        snowDepthM: 0.1,
        shortwaveWm2: 300,
      },
      {
        temperatureC: -2,
        precipitationMm: 3,
        windSpeedKph: 15,
        windGustKph: 40,
        rainMm: 0,
        snowfallCm: 3,
        snowDepthM: 0.25,
        shortwaveWm2: 120,
      },
    ];
    const s = summarizeWeatherSince(hourly);
    expect(s.rainMm).toBeCloseTo(2);
    expect(s.snowfallCm).toBeCloseTo(3);
    expect(s.insolationWhM2).toBeCloseTo(420);
    expect(s.maxWindGustKph).toBe(40);
    expect(s.maxSnowDepthM).toBe(0.25);
  });

  it('counts distinct local nights whose minimum dropped below freezing', () => {
    // Three pre-dawn (02:00-local) hours on consecutive days → three distinct night buckets.
    const at = (localHours: number) => localHours * HOUR_MS;
    const hourly: HourlyWeather[] = [
      { temperatureC: -3, precipitationMm: 0, windSpeedKph: 0, startMs: at(2) }, // night A, froze
      { temperatureC: 2, precipitationMm: 0, windSpeedKph: 0, startMs: at(26) }, // night B, no
      { temperatureC: -1, precipitationMm: 0, windSpeedKph: 0, startMs: at(50) }, // night C, froze
    ];
    expect(summarizeWeatherSince(hourly).nightsBelowFreezing).toBe(2);
  });

  it('does not split a night at midnight (evening + next morning share one night)', () => {
    const at = (localHours: number) => localHours * HOUR_MS;
    const evening = { temperatureC: -5, precipitationMm: 0, windSpeedKph: 0, startMs: at(23) };
    const morning = { temperatureC: 1, precipitationMm: 0, windSpeedKph: 0, startMs: at(29) }; // 05:00 next day
    // Same night bucket → one freezing night, not two.
    expect(refNightIndex(at(23))).toBe(refNightIndex(at(29)));
    expect(summarizeWeatherSince([evening, morning]).nightsBelowFreezing).toBe(1);
  });

  it('returns null nights when any hour lacks a timestamp (no half-counting)', () => {
    const hourly: HourlyWeather[] = [
      { temperatureC: -3, precipitationMm: 0, windSpeedKph: 0, startMs: 2 * HOUR_MS },
      { temperatureC: -3, precipitationMm: 0, windSpeedKph: 0 }, // untimed
    ];
    expect(summarizeWeatherSince(hourly).nightsBelowFreezing).toBeNull();
  });

  it('treats an exactly-0°C hour as carrying the prior freeze state (no spurious run break)', () => {
    const mk = (temperatureC: number): HourlyWeather => ({
      temperatureC,
      precipitationMm: 0,
      windSpeedKph: 0,
    });
    // −2, 0, −1 is a continuous 3h freeze (the 0 carries "freezing"); then a thaw, a 0, then a re-freeze.
    const s = summarizeWeatherSince([mk(-2), mk(0), mk(-1), mk(3), mk(0), mk(-4)]);
    expect(s.longestFreezeRunHours).toBe(3);
    expect(s.freezeThawCycles).toBe(1); // only the −1 → 3 onset
  });

  it('falls back to cloud cover for sun hours when sunshineSeconds is absent', () => {
    const hourly: HourlyWeather[] = [
      { temperatureC: 0, precipitationMm: 0, windSpeedKph: 0, cloudCoverPct: 10 }, // sunny
      { temperatureC: 0, precipitationMm: 0, windSpeedKph: 0, cloudCoverPct: 80 }, // not
      { temperatureC: 0, precipitationMm: 0, windSpeedKph: 0 }, // unknown → not counted
    ];
    expect(summarizeWeatherSince(hourly).hoursOfSun).toBe(1);
  });

  it('honors custom freezing band and sunny threshold', () => {
    const hourly: HourlyWeather[] = [
      { temperatureC: 4, precipitationMm: 0, windSpeedKph: 0, cloudCoverPct: 40 },
    ];
    const s = summarizeWeatherSince(hourly, {
      freezingBandLowC: 3,
      freezingBandHighC: 5,
      sunnyCloudCoverMaxPct: 50,
    });
    expect(s.hoursNearFreezing).toBe(1);
    expect(s.hoursOfSun).toBe(1);
  });

  it('invariants hold for arbitrary untimed input (property)', () => {
    const arbHour: fc.Arbitrary<HourlyWeather> = fc.record({
      temperatureC: fc.double({ min: -60, max: 60, noNaN: true }),
      precipitationMm: fc.double({ min: 0, max: 100, noNaN: true }),
      windSpeedKph: fc.double({ min: 0, max: 200, noNaN: true }),
      windGustKph: fc.option(fc.double({ min: 0, max: 250, noNaN: true }), { nil: undefined }),
      rainMm: fc.option(fc.double({ min: 0, max: 100, noNaN: true }), { nil: undefined }),
      snowfallCm: fc.option(fc.double({ min: 0, max: 50, noNaN: true }), { nil: undefined }),
      snowDepthM: fc.option(fc.double({ min: 0, max: 3, noNaN: true }), { nil: undefined }),
      shortwaveWm2: fc.option(fc.double({ min: 0, max: 1000, noNaN: true }), { nil: undefined }),
      sunshineSeconds: fc.option(fc.double({ min: 0, max: 3600, noNaN: true }), { nil: undefined }),
      cloudCoverPct: fc.option(fc.double({ min: 0, max: 100, noNaN: true }), { nil: undefined }),
    });

    fc.assert(
      fc.property(fc.array(arbHour, { maxLength: 200 }), (hours) => {
        const s = summarizeWeatherSince(hours);
        expect(s.hours).toBe(hours.length);

        // Each aggregate must equal the value computed independently over the input —
        // a stub returning 0/constant would pass "≥ 0" but fails these.
        expect(s.hoursNearFreezing).toBe(
          hours.filter((h) => h.temperatureC >= -2 && h.temperatureC <= 2).length,
        );
        expect(s.hoursAboveFreezing).toBe(hours.filter((h) => h.temperatureC > 0).length);
        expect(s.totalPrecipMm).toBeCloseTo(
          hours.reduce((sum, h) => sum + h.precipitationMm, 0),
          6,
        );
        expect(s.windRunKm).toBeCloseTo(
          hours.reduce((sum, h) => sum + h.windSpeedKph, 0),
          6,
        );
        expect(s.freezingDegreeHours).toBeCloseTo(
          hours.reduce((sum, h) => sum + (h.temperatureC < 0 ? -h.temperatureC : 0), 0),
          6,
        );
        expect(s.thawDegreeHours).toBeCloseTo(
          hours.reduce((sum, h) => sum + (h.temperatureC > 0 ? h.temperatureC : 0), 0),
          6,
        );
        expect(s.rainMm).toBeCloseTo(
          hours.reduce((sum, h) => sum + (h.rainMm ?? 0), 0),
          6,
        );
        expect(s.snowfallCm).toBeCloseTo(
          hours.reduce((sum, h) => sum + (h.snowfallCm ?? 0), 0),
          6,
        );
        expect(s.insolationWhM2).toBeCloseTo(
          hours.reduce((sum, h) => sum + (h.shortwaveWm2 ?? 0), 0),
          6,
        );
        expect(s.hoursOfSun).toBeCloseTo(
          hours.reduce((sum, h) => {
            if (typeof h.sunshineSeconds === 'number') return sum + h.sunshineSeconds / 3600;
            if (typeof h.cloudCoverPct === 'number' && h.cloudCoverPct <= 20) return sum + 1;
            return sum;
          }, 0),
          6,
        );

        // Order-dependent freeze run + cycles. Continuous doubles are ~never exactly 0, so the simple
        // `t < 0` rule matches the reducer's exactly-0-carries-prior logic here.
        let longest = 0;
        let cur = 0;
        let cycles = 0;
        let prev: boolean | null = null;
        for (const h of hours) {
          const f = h.temperatureC < 0;
          if (f) {
            cur += 1;
            longest = Math.max(longest, cur);
          } else {
            cur = 0;
          }
          if (prev === true && f === false) cycles += 1;
          prev = f;
        }
        expect(s.longestFreezeRunHours).toBe(longest);
        expect(s.freezeThawCycles).toBe(cycles);

        // Untimed input ⇒ nights unknowable.
        expect(s.nightsBelowFreezing).toBeNull();

        const gusts = hours
          .map((h) => h.windGustKph)
          .filter((x): x is number => typeof x === 'number');
        expect(s.maxWindGustKph).toBe(gusts.length ? Math.max(...gusts) : null);
        const depths = hours
          .map((h) => h.snowDepthM)
          .filter((x): x is number => typeof x === 'number');
        expect(s.maxSnowDepthM).toBe(depths.length ? Math.max(...depths) : null);

        if (hours.length === 0) {
          expect(s.peakTempC).toBeNull();
          expect(s.minTempC).toBeNull();
          expect(s.maxWindKph).toBeNull();
        } else {
          expect(s.peakTempC).toBe(Math.max(...hours.map((h) => h.temperatureC)));
          expect(s.minTempC).toBe(Math.min(...hours.map((h) => h.temperatureC)));
          expect(s.maxWindKph).toBe(Math.max(...hours.map((h) => h.windSpeedKph)));
        }
      }),
    );
  });

  it('weatherExplainsIceChange flags a meaningful freeze or thaw, not a quiet window', () => {
    // Build a summary via the reducer so thresholds are exercised on real integrals.
    const cold = summarizeWeatherSince(
      Array.from({ length: 12 }, () => ({ temperatureC: -6, precipitationMm: 0, windSpeedKph: 0 })),
    );
    const warm = summarizeWeatherSince(
      Array.from({ length: 12 }, () => ({ temperatureC: 4, precipitationMm: 0, windSpeedKph: 0 })),
    );
    const quiet = summarizeWeatherSince(
      Array.from({ length: 12 }, () => ({ temperatureC: 0, precipitationMm: 0, windSpeedKph: 0 })),
    );
    expect(weatherExplainsIceChange(cold)).toBe(true); // 12h × 6°C = 72 FDH ≥ 48
    expect(weatherExplainsIceChange(warm)).toBe(true); // 12h × 4°C = 48 TDH ≥ 36
    expect(weatherExplainsIceChange(quiet)).toBe(false); // no degree-hours
    expect(weatherExplainsIceChange(summarizeWeatherSince([]))).toBe(false); // no data ⇒ can't tell
  });

  it('nights-below-freezing matches an independent night-bucketed recompute (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 800 }), // base hour offset (local)
        fc.array(fc.double({ min: -40, max: 40, noNaN: true }), { maxLength: 200 }),
        (baseHours, temps) => {
          const base = baseHours * HOUR_MS;
          const hours: HourlyWeather[] = temps.map((t, i) => ({
            temperatureC: t,
            precipitationMm: 0,
            windSpeedKph: 0,
            startMs: base + i * HOUR_MS,
          }));
          const s = summarizeWeatherSince(hours);

          if (hours.length === 0) {
            expect(s.nightsBelowFreezing).toBeNull();
            return;
          }
          const nightMin = new Map<number, number>();
          for (const h of hours) {
            const n = refNightIndex(h.startMs as number);
            nightMin.set(n, Math.min(nightMin.get(n) ?? Infinity, h.temperatureC));
          }
          const expected = [...nightMin.values()].filter((m) => m < 0).length;
          expect(s.nightsBelowFreezing).toBe(expected);
        },
      ),
    );
  });
});
