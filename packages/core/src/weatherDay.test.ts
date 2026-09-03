import { describe, expect, it } from 'vitest';
import {
  approximateUtcOffsetSeconds,
  DAYLIGHT_END_HOUR,
  DAYLIGHT_START_HOUR,
  dayMsToLocalDate,
  dominantWindSector,
  estimateAlbedo,
  isCompleteDay,
  type LocalHourlyWeather,
  lastSnowDay,
  localDateToDayMs,
  localDayMsAt,
  MELT_WH_PER_MM,
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

    // ⚠ Not 24. A clear sky at 2 AM is not sunshine, and a field named "hours of sun" reporting a
    // cloudless January day as a full 24 is a claim a reader would use to reason about melt.
    const cloudOnly = summarizeWeatherDays(flatDay('2026-01-15', -2, { cloudCoverPct: 10 }));
    expect(cloudOnly[0]?.hoursOfSun).toBe(DAYLIGHT_END_HOUR - DAYLIGHT_START_HOUR);

    // `shortwave_radiation` beats the clock when it is there: it knows the real sunrise for this
    // date and latitude, and is zero at night by construction.
    const withRadiation = summarizeWeatherDays(
      flatDay('2026-01-15', -2, { cloudCoverPct: 10 }).map((h) => ({
        ...h,
        shortwaveWm2: h.localHour >= 9 && h.localHour < 15 ? 120 : 0,
      })),
    );
    expect(withRadiation[0]?.hoursOfSun).toBe(6);
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

describe('solar weighting (the melt side)', () => {
  /** A day whose sun follows a plausible arc rather than a flat block. */
  function sunArc(localDate: string, tempC: number, peakWm2: number, snowDepthM?: number) {
    return Array.from({ length: 24 }, (_, h) => {
      // Zero outside 08–16, a half-sine in between: the shape that makes noon and dusk differ.
      const frac = h >= 8 && h <= 16 ? Math.sin(((h - 8) / 8) * Math.PI) : 0;
      return hr(localDate, h, tempC, {
        shortwaveWm2: Math.round(peakWm2 * frac),
        ...(snowDepthM === undefined ? {} : { snowDepthM }),
      });
    });
  }

  it('prices reflection: the same sun does far more to bare ice than to snow', () => {
    const [bare] = summarizeWeatherDays(sunArc('2026-01-15', -5, 400));
    const [snowy] = summarizeWeatherDays(sunArc('2026-01-15', -5, 400, 0.1));
    if (!bare || !snowy) throw new Error('expected one day each');

    // Identical energy arrived...
    expect(bare.insolationWhM2).toBe(snowy.insolationWhM2);
    // ...and very different amounts stayed. 0.85 absorbed vs 0.20 — the ~4× that makes albedo the
    // largest single term in what the sun actually does.
    expect(bare.absorbedInsolationWhM2 / snowy.absorbedInsolationWhM2).toBeCloseTo(4.25, 1);
  });

  it('tracks albedo hour by hour, so an afternoon melt-out is not shielded by the morning', () => {
    // Snow until noon, bare after. The daily *max* depth would call this a snowy day all day.
    const hours = sunArc('2026-01-15', 1, 400).map((h, i) =>
      i < 12 ? { ...h, snowDepthM: 0.1 } : h,
    );
    const [day] = summarizeWeatherDays(hours);
    const [allSnow] = summarizeWeatherDays(sunArc('2026-01-15', 1, 400, 0.1));
    if (!day || !allSnow) throw new Error('expected one day each');
    expect(day.maxSnowDepthM).toBe(0.1); // the daily max says "snow covered"
    expect(day.absorbedInsolationWhM2).toBeGreaterThan(allSnow.absorbedInsolationWhM2 * 2);
  });

  it('separates a sunny thaw from a grey one, which hoursAboveFreezing cannot', () => {
    const [sunny] = summarizeWeatherDays(sunArc('2026-01-15', 2, 400));
    const [grey] = summarizeWeatherDays(sunArc('2026-01-15', 2, 60));
    if (!sunny || !grey) throw new Error('expected one day each');

    // The measure that misses it, and the measure that catches it.
    expect(sunny.hoursAboveFreezing).toBe(grey.hoursAboveFreezing);
    expect(sunny.sunlitThawHours).toBeGreaterThan(0);
    expect(grey.sunlitThawHours).toBe(0);
    expect(sunny.meltIndexMm).toBeGreaterThan(grey.meltIndexMm);
  });

  it('counts no sunlit thaw hours while the air stays below freezing', () => {
    const [cold] = summarizeWeatherDays(sunArc('2026-01-15', -5, 400));
    if (!cold) throw new Error('expected one day');
    expect(cold.sunlitThawHours).toBe(0);
    // But the sun still deposits energy, which is the whole reason the two are separate fields.
    expect(cold.absorbedInsolationWhM2).toBeGreaterThan(0);
    expect(cold.meltIndexMm).toBeGreaterThan(0);
  });

  it('estimateAlbedo steps on snow presence, not on depth in general', () => {
    expect(estimateAlbedo(null)).toBe(0.15);
    expect(estimateAlbedo(0)).toBe(0.15);
    expect(estimateAlbedo(0.01)).toBe(0.5);
    expect(estimateAlbedo(0.5)).toBe(estimateAlbedo(0.05));
  });

  it('converts absorbed energy to melt at the latent heat of fusion, not a fudge factor', () => {
    // One flat cold day, sun only: no thaw-degree-hours, so the whole index is the radiation term.
    const [day] = summarizeWeatherDays(
      Array.from({ length: 24 }, (_, h) => hr('2026-01-15', h, -5, { shortwaveWm2: 100 })),
    );
    if (!day) throw new Error('expected one day');
    expect(day.meltIndexMm).toBeCloseTo(day.absorbedInsolationWhM2 / MELT_WH_PER_MM, 6);
  });
});

describe('instant → local day key (the conversion that had no owner)', () => {
  const EST = -5 * 3600;
  const EDT = -4 * 3600;

  it('files an evening skate on the day it was actually skated', () => {
    // 8 PM EST on 10 Feb is 01:00 UTC on 11 Feb. A UTC floor calls that the 11th; the lake was on
    // the 10th, and `weatherDays.dayMs` keys the 10th. This is the common case, not an edge case —
    // most skating ends in the evening.
    const skate = Date.UTC(2026, 1, 11, 1, 0); // 2026-02-11T01:00Z
    expect(dayMsToLocalDate(localDayMsAt(skate, EST))).toBe('2026-02-10');
    // What the old open-coded arithmetic did, preserved so the difference is visible:
    expect(dayMsToLocalDate(Math.floor(skate / 86_400_000) * 86_400_000)).toBe('2026-02-11');
  });

  it('leaves a midday skate on its own day under either offset', () => {
    const noon = Date.UTC(2026, 1, 10, 17, 0); // noon EST
    expect(dayMsToLocalDate(localDayMsAt(noon, EST))).toBe('2026-02-10');
    expect(dayMsToLocalDate(localDayMsAt(noon, EDT))).toBe('2026-02-10');
  });

  it('round-trips against dayMsToLocalDate at the local midnight boundary', () => {
    // One minute either side of local midnight must land on different days, and the right ones.
    const justBefore = Date.UTC(2026, 1, 11, 4, 59); // 23:59 EST on the 10th
    const justAfter = Date.UTC(2026, 1, 11, 5, 1); // 00:01 EST on the 11th
    expect(dayMsToLocalDate(localDayMsAt(justBefore, EST))).toBe('2026-02-10');
    expect(dayMsToLocalDate(localDayMsAt(justAfter, EST))).toBe('2026-02-11');
  });

  it('guesses the region right from longitude when nothing is stored', () => {
    // Every state the corpus covers is US Eastern. A fallback that returned 0 would reintroduce the
    // exact bug, so this asserts the sign and magnitude rather than merely "a number".
    for (const lng of [-73.9, -72.6, -71.1, -68.8]) {
      expect(approximateUtcOffsetSeconds(lng)).toBe(-5 * 3600);
    }
  });
});

describe('isCompleteDay — a partial day is data, not a finished day', () => {
  it('rejects a day still in progress', () => {
    expect(isCompleteDay(3)).toBe(false);
    expect(isCompleteDay(0)).toBe(false);
    expect(isCompleteDay(22)).toBe(false);
  });

  it('accepts both DST lengths, which an equality test would not', () => {
    // ⚠ 23 and 25 are real day lengths and both transitions fall inside a skating season. `=== 24`
    // would mark the spring-forward day permanently unfinished and drop it out of every window.
    expect(isCompleteDay(23)).toBe(true);
    expect(isCompleteDay(24)).toBe(true);
    expect(isCompleteDay(25)).toBe(true);
  });

  it('treats absent hours as not complete rather than as complete', () => {
    expect(isCompleteDay(undefined)).toBe(false);
    expect(isCompleteDay(null)).toBe(false);
  });
});
