import { describe, expect, it } from 'vitest';
import {
  dayMsToLocalDate,
  dominantWindSector,
  type LocalHourlyWeather,
  lastSnowDay,
  localDateToDayMs,
  nightsBelowThresholdC,
  rainTotalMm,
  snowfallTotalCm,
  summarizeWeatherDays,
  windSectorOf,
} from './weatherDay';

/** One hour, with everything optional defaulted to something inert. */
function hr(
  localDate: string,
  localHour: number,
  temperatureC: number,
  extra: Partial<LocalHourlyWeather> = {},
): LocalHourlyWeather {
  return {
    localDate,
    localHour,
    temperatureC,
    precipitationMm: 0,
    windSpeedKph: 0,
    ...extra,
  };
}

/** A full 24-hour day at a flat temperature, so a test can vary one thing at a time. */
function flatDay(
  localDate: string,
  temperatureC: number,
  extra: Partial<LocalHourlyWeather> = {},
): LocalHourlyWeather[] {
  return Array.from({ length: 24 }, (_, h) => hr(localDate, h, temperatureC, extra));
}

describe('localDateToDayMs / dayMsToLocalDate', () => {
  it('round-trips a date through the sortable key', () => {
    expect(localDateToDayMs('2026-01-15')).toBe(Date.UTC(2026, 0, 15));
    expect(dayMsToLocalDate(Date.UTC(2026, 0, 15))).toBe('2026-01-15');
  });

  it('rejects malformed dates rather than guessing', () => {
    for (const bad of ['2026-1-5', '', 'yesterday', '2026-13-01', '2026-01-00']) {
      expect(localDateToDayMs(bad)).toBeNull();
    }
  });

  it('orders correctly across a month and year boundary', () => {
    const dec = localDateToDayMs('2025-12-31') ?? 0;
    const jan = localDateToDayMs('2026-01-01') ?? 0;
    expect(jan).toBeGreaterThan(dec);
    expect(jan - dec).toBe(86_400_000);
  });
});

describe('windSectorOf', () => {
  it('maps cardinal bearings to the expected 16-point indices', () => {
    expect(windSectorOf(0)).toBe(0); // N
    expect(windSectorOf(90)).toBe(4); // E
    expect(windSectorOf(180)).toBe(8); // S
    expect(windSectorOf(270)).toBe(12); // W
  });

  it('wraps rather than overflowing at and past 360°', () => {
    expect(windSectorOf(360)).toBe(0);
    expect(windSectorOf(348.75)).toBe(0); // upper half of the N sector
    expect(windSectorOf(-90)).toBe(12); // W, expressed negatively
    expect(windSectorOf(720 + 90)).toBe(4);
  });
});

describe('summarizeWeatherDays — bucketing', () => {
  it('groups by local date and returns days in ascending order', () => {
    const days = summarizeWeatherDays([...flatDay('2026-01-16', -5), ...flatDay('2026-01-15', -3)]);
    expect(days.map((d) => d.localDate)).toEqual(['2026-01-15', '2026-01-16']);
    expect(days[0]?.hours).toBe(24);
  });

  it('reports 23 and 25 hour days honestly instead of assuming 24 (DST)', () => {
    // A spring-forward day has 23 local hours; the local dates Open-Meteo returns simply skip one.
    const short = Array.from({ length: 23 }, (_, i) => hr('2026-03-08', i < 2 ? i : i + 1, -1));
    const days = summarizeWeatherDays(short);
    expect(days[0]?.hours).toBe(23);
    // And the integrals scale with the hours actually seen, not with a hardcoded 24.
    expect(days[0]?.freezingDegreeHours).toBeCloseTo(23, 6);
  });

  it('drops hours with an unparseable local date rather than misfiling them', () => {
    const days = summarizeWeatherDays([
      ...flatDay('2026-01-15', -5),
      hr('not-a-date', 3, -40), // would wreck the minimum if it landed anywhere
    ]);
    expect(days).toHaveLength(1);
    expect(days[0]?.minTempC).toBe(-5);
  });

  it('returns nothing for empty input', () => {
    expect(summarizeWeatherDays([])).toEqual([]);
  });
});

describe('summarizeWeatherDays — aggregates', () => {
  it('separates freezing and thawing hours and their degree-hour integrals', () => {
    const hours = [
      ...Array.from({ length: 6 }, (_, i) => hr('2026-01-15', i, -4)),
      ...Array.from({ length: 6 }, (_, i) => hr('2026-01-15', 6 + i, 3)),
      ...Array.from({ length: 12 }, (_, i) => hr('2026-01-15', 12 + i, 0)),
    ];
    const [day] = summarizeWeatherDays(hours);
    expect(day?.hoursBelowFreezing).toBe(6);
    expect(day?.hoursAboveFreezing).toBe(6);
    expect(day?.freezingDegreeHours).toBeCloseTo(24, 6); // 6 h × 4°
    expect(day?.thawDegreeHours).toBeCloseTo(18, 6); // 6 h × 3°
    expect(day?.minTempC).toBe(-4);
    expect(day?.maxTempC).toBe(3);
    // Exactly 0°C counts as neither, matching `summarizeWeatherSince`'s convention.
    expect((day?.hoursBelowFreezing ?? 0) + (day?.hoursAboveFreezing ?? 0)).toBe(12);
  });

  it('sums precipitation, splits rain from snow, and peaks snow depth', () => {
    const [day] = summarizeWeatherDays(
      flatDay('2026-01-15', -2, {
        precipitationMm: 0.5,
        rainMm: 0.2,
        snowfallCm: 0.3,
        snowDepthM: 0.14,
      }),
    );
    expect(day?.precipitationMm).toBeCloseTo(12, 6);
    expect(day?.rainMm).toBeCloseTo(4.8, 6);
    expect(day?.snowfallCm).toBeCloseTo(7.2, 6);
    expect(day?.maxSnowDepthM).toBeCloseTo(0.14, 6);
  });

  it('prefers sunshine seconds over the cloud-cover fallback', () => {
    const withSun = summarizeWeatherDays(
      flatDay('2026-01-15', -2, { sunshineSeconds: 1800, cloudCoverPct: 90 }),
    );
    expect(withSun[0]?.hoursOfSun).toBeCloseTo(12, 6); // 24 × 0.5 h

    const cloudOnly = summarizeWeatherDays(flatDay('2026-01-15', -2, { cloudCoverPct: 10 }));
    expect(cloudOnly[0]?.hoursOfSun).toBe(24);
  });

  it('leaves optional maxima null when nothing supplied them', () => {
    const [day] = summarizeWeatherDays(flatDay('2026-01-15', -2));
    expect(day?.maxSnowDepthM).toBeNull();
    expect(day?.maxWindGustKph).toBeNull();
    expect(day?.windSectorHours).toEqual([]);
  });
});

describe('summarizeWeatherDays — wind during the freeze (the black-ice signal)', () => {
  it('averages wind across freezing hours only', () => {
    const hours = [
      // Cold and calm overnight...
      ...Array.from({ length: 8 }, (_, i) => hr('2026-01-15', i, -6, { windSpeedKph: 2 })),
      // ...then mild and blowing all afternoon, which must not pollute the freeze average.
      ...Array.from({ length: 8 }, (_, i) => hr('2026-01-15', 12 + i, 4, { windSpeedKph: 40 })),
    ];
    const [day] = summarizeWeatherDays(hours);
    expect(day?.freezingHoursMeanWindKph).toBeCloseTo(2, 6);
    expect(day?.freezingHoursMaxWindKph).toBe(2);
    expect(day?.maxWindKph).toBe(40); // the whole-day maximum is still reported
    expect(day?.windRunKm).toBeCloseTo(8 * 2 + 8 * 40, 6);
  });

  it('reports null freeze-wind when nothing froze', () => {
    const [day] = summarizeWeatherDays(flatDay('2026-01-15', 5, { windSpeedKph: 10 }));
    expect(day?.freezingHoursMeanWindKph).toBeNull();
    expect(day?.freezingHoursMaxWindKph).toBeNull();
  });

  it('builds a 16-sector histogram from hourly directions', () => {
    const hours = [
      ...Array.from({ length: 6 }, (_, i) => hr('2026-01-15', i, -2, { windDirectionDeg: 315 })),
      ...Array.from({ length: 3 }, (_, i) => hr('2026-01-15', 6 + i, -2, { windDirectionDeg: 90 })),
    ];
    const [day] = summarizeWeatherDays(hours);
    expect(day?.windSectorHours[14]).toBe(6); // NW
    expect(day?.windSectorHours[4]).toBe(3); // E
    expect(day?.windSectorHours).toHaveLength(16);
  });
});

describe('summarizeWeatherDays — the night window (D159 headline predicate)', () => {
  it('takes the minimum across [prev 18:00, this 09:00)', () => {
    const hours = [
      // Previous evening: mild until 18:00, then the cold arrives.
      ...Array.from({ length: 18 }, (_, i) => hr('2026-01-14', i, 5)),
      ...Array.from({ length: 6 }, (_, i) => hr('2026-01-14', 18 + i, -8)),
      // This morning: coldest pre-dawn, then a thaw that must NOT raise the night minimum.
      ...Array.from({ length: 9 }, (_, i) => hr('2026-01-15', i, -12)),
      ...Array.from({ length: 15 }, (_, i) => hr('2026-01-15', 9 + i, 6)),
    ];
    const days = summarizeWeatherDays(hours);
    const jan15 = days.find((d) => d.localDate === '2026-01-15');
    expect(jan15?.nightMinTempC).toBe(-12);
    // The mild afternoon before 18:00 is outside the window and must not appear.
    expect(jan15?.minTempC).toBe(-12);
    expect(jan15?.maxTempC).toBe(6);
  });

  it('is null on the first day, which has no previous evening', () => {
    const days = summarizeWeatherDays(flatDay('2026-01-15', -10));
    expect(days[0]?.nightMinTempC).toBeNull();
  });

  it('is null when only half the night was observed', () => {
    // Evening present, morning missing entirely.
    const hours = [
      ...Array.from({ length: 6 }, (_, i) => hr('2026-01-14', 18 + i, -8)),
      ...Array.from({ length: 6 }, (_, i) => hr('2026-01-15', 12 + i, 3)),
    ];
    const days = summarizeWeatherDays(hours);
    expect(days.find((d) => d.localDate === '2026-01-15')?.nightMinTempC).toBeNull();
  });

  it('does not borrow a night across a missing day', () => {
    // Jan 14 and Jan 16 present, Jan 15 absent — Jan 16's night must stay unknown rather than
    // reaching back two days for an evening.
    const hours = [...flatDay('2026-01-14', -20), ...flatDay('2026-01-16', -1)];
    const days = summarizeWeatherDays(hours);
    expect(days.find((d) => d.localDate === '2026-01-16')?.nightMinTempC).toBeNull();
  });
});

describe('nightsBelowThresholdC', () => {
  const days = summarizeWeatherDays([
    ...flatDay('2026-01-14', -10),
    ...flatDay('2026-01-15', -10),
    ...flatDay('2026-01-16', -2),
    ...flatDay('2026-01-17', -10),
  ]);

  it('counts only days whose night window is known and below the threshold', () => {
    // Jan 14 has no previous evening ⇒ null ⇒ uncounted. The other three all count, and Jan 16 is
    // the interesting one: its *calendar* minimum is -2, but the night that ended on its morning
    // began in Jan 15's -10 evening. That divergence is the entire reason `nightMinTempC` exists
    // separately from `minTempC` — a filter asking "three nights below 20°F" wants the night, and a
    // daily row's displayed low wants the day.
    expect(nightsBelowThresholdC(days, -6.7)).toBe(3);
    expect(days.find((d) => d.localDate === '2026-01-16')?.minTempC).toBe(-2);
    expect(days.find((d) => d.localDate === '2026-01-16')?.nightMinTempC).toBe(-10);
  });

  it('never counts an unknown night as either cold or warm', () => {
    const withUnknown = days.filter((d) => d.nightMinTempC === null);
    expect(withUnknown.length).toBeGreaterThan(0);
    // Threshold above every observed value: every *known* night counts, unknowns still do not.
    expect(nightsBelowThresholdC(days, 100)).toBe(days.length - withUnknown.length);
    // Threshold below every observed value: nothing counts.
    expect(nightsBelowThresholdC(days, -100)).toBe(0);
  });
});

describe('span helpers', () => {
  const days = summarizeWeatherDays([
    ...flatDay('2026-01-14', -5, { snowfallCm: 0.5, rainMm: 0 }),
    ...flatDay('2026-01-15', -5),
    ...flatDay('2026-01-16', 2, { rainMm: 0.25 }),
  ]);

  it('totals snow and rain across the span', () => {
    expect(snowfallTotalCm(days)).toBeCloseTo(12, 6);
    expect(rainTotalMm(days)).toBeCloseTo(6, 6);
  });

  it('finds the most recent day with measurable snow', () => {
    expect(lastSnowDay(days)?.localDate).toBe('2026-01-14');
  });

  it('ignores a dusting below the threshold', () => {
    const dusting = summarizeWeatherDays(flatDay('2026-01-15', -5, { snowfallCm: 0.001 }));
    expect(lastSnowDay(dusting)).toBeNull();
    expect(lastSnowDay(dusting, 0.001)).not.toBeNull();
  });

  it('returns null for a snow-free span', () => {
    expect(lastSnowDay(summarizeWeatherDays(flatDay('2026-01-15', -5)))).toBeNull();
  });

  it('picks the dominant wind sector by hours', () => {
    const windy = summarizeWeatherDays([
      ...Array.from({ length: 20 }, (_, i) => hr('2026-01-15', i, -2, { windDirectionDeg: 315 })),
      ...Array.from({ length: 4 }, (_, i) =>
        hr('2026-01-15', 20 + i, -2, { windDirectionDeg: 45 }),
      ),
    ]);
    expect(dominantWindSector(windy)).toBe(14); // NW
  });

  it('returns null when no direction data exists', () => {
    expect(dominantWindSector(days)).toBeNull();
  });
});
