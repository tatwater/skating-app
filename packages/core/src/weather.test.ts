import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type HourlyWeather, summarizeWeatherSince } from './weather';

describe('summarizeWeatherSince (D19)', () => {
  it('returns an empty summary for no data', () => {
    expect(summarizeWeatherSince([])).toEqual({
      hours: 0,
      peakTempC: null,
      hoursNearFreezing: 0,
      hoursAboveFreezing: 0,
      hoursOfSun: 0,
      totalPrecipMm: 0,
      maxWindKph: null,
    });
  });

  it('summarizes a known window', () => {
    const hourly: HourlyWeather[] = [
      { temperatureC: -1, precipitationMm: 0, windSpeedKph: 5, sunshineSeconds: 3600 },
      { temperatureC: 3, precipitationMm: 1.5, windSpeedKph: 20, sunshineSeconds: 1800 },
      { temperatureC: 5, precipitationMm: 0.5, windSpeedKph: 12, sunshineSeconds: 0 },
    ];
    const s = summarizeWeatherSince(hourly);
    expect(s.hours).toBe(3);
    expect(s.peakTempC).toBe(5);
    expect(s.maxWindKph).toBe(20);
    expect(s.hoursNearFreezing).toBe(1); // only -1°C falls in [-2, 2]
    expect(s.hoursAboveFreezing).toBe(2); // 3°C and 5°C
    expect(s.hoursOfSun).toBeCloseTo(1.5); // (3600 + 1800 + 0) / 3600
    expect(s.totalPrecipMm).toBeCloseTo(2);
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

  it('invariants hold for arbitrary input (property)', () => {
    const arbHour: fc.Arbitrary<HourlyWeather> = fc.record({
      temperatureC: fc.double({ min: -60, max: 60, noNaN: true }),
      precipitationMm: fc.double({ min: 0, max: 100, noNaN: true }),
      windSpeedKph: fc.double({ min: 0, max: 200, noNaN: true }),
      sunshineSeconds: fc.option(fc.double({ min: 0, max: 3600, noNaN: true }), { nil: undefined }),
      cloudCoverPct: fc.option(fc.double({ min: 0, max: 100, noNaN: true }), { nil: undefined }),
    });

    fc.assert(
      fc.property(fc.array(arbHour), (hours) => {
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
        expect(s.hoursOfSun).toBeCloseTo(
          hours.reduce((sum, h) => {
            if (typeof h.sunshineSeconds === 'number') return sum + h.sunshineSeconds / 3600;
            if (typeof h.cloudCoverPct === 'number' && h.cloudCoverPct <= 20) return sum + 1;
            return sum;
          }, 0),
          6,
        );

        if (hours.length === 0) {
          expect(s.peakTempC).toBeNull();
          expect(s.maxWindKph).toBeNull();
        } else {
          expect(s.peakTempC).toBe(Math.max(...hours.map((h) => h.temperatureC)));
          expect(s.maxWindKph).toBe(Math.max(...hours.map((h) => h.windSpeedKph)));
        }
      }),
    );
  });
});
