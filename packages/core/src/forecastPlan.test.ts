import { describe, expect, it } from 'vitest';
import {
  arrivalCaption,
  buildForecastPlan,
  detectEpisodes,
  EPISODE_WIND_KPH,
  FORECAST_PLAN_DAYS,
  forecastPlanIsEmpty,
  formatEpisode,
  hourCondition,
  liquidMm,
  planHourLabel,
} from './forecastPlan';
import type { ForecastHour } from './lakeForecast';

const HOUR = 3_600_000;

/**
 * A local-shifted instant from a local wall-clock string — `Date.UTC` on purpose, because that is
 * exactly what `weather.ts` produces when it adds `utc_offset_seconds` to a unix timestamp. Every
 * assertion below then reads the clock back with UTC getters, as the module does.
 */
function local(iso: string): number {
  return Date.parse(`${iso}Z`);
}

function hour(startMs: number, over: Partial<ForecastHour> = {}): ForecastHour {
  return {
    startMs,
    temperatureC: -5,
    windSpeedKph: 10,
    precipitationMm: 0,
    snowfallCm: 0,
    rainMm: 0,
    weatherCode: 1,
    shortwaveWm2: 0,
    ...over,
  };
}

/** `count` consecutive hours from `startMs`, each shaped by `f(i, startMs)`. */
function series(
  startMs: number,
  count: number,
  f: (i: number, ms: number) => Partial<ForecastHour> = () => ({}),
): ForecastHour[] {
  return Array.from({ length: count }, (_, i) =>
    hour(startMs + i * HOUR, f(i, startMs + i * HOUR)),
  );
}

/** Daylight shortwave for the fixture: sun up 7–17 with a noon peak, else zero. */
function sun(ms: number): number {
  const h = new Date(ms).getUTCHours();
  if (h < 7 || h >= 17) return 0;
  return Math.round(400 * Math.sin(((h - 7) / 10) * Math.PI));
}

const NOW = local('2026-01-14T14:20:00'); // a Wednesday afternoon on the lake's clock

describe('hourCondition', () => {
  it('lets the WMO code speak first, because only it can say freezing rain', () => {
    expect(hourCondition(hour(NOW, { weatherCode: 66, rainMm: 0.1, precipitationMm: 0.1 }))).toBe(
      'freezing-rain',
    );
    expect(hourCondition(hour(NOW, { weatherCode: 71 }))).toBe('snow');
    expect(hourCondition(hour(NOW, { weatherCode: 79 }))).toBe('sleet');
    expect(hourCondition(hour(NOW, { weatherCode: 95 }))).toBe('thunder');
    expect(hourCondition(hour(NOW, { weatherCode: 45 }))).toBe('fog');
    expect(hourCondition(hour(NOW, { weatherCode: 3 }))).toBe('cloudy');
  });

  it('derives from amounts and temperature when there is no code — liquid at or below 0 °C is freezing rain', () => {
    const noCode = (o: Partial<ForecastHour>) =>
      hourCondition({ ...hour(NOW, o), weatherCode: undefined });
    expect(noCode({ precipitationMm: 1, rainMm: 1, temperatureC: -1 })).toBe('freezing-rain');
    expect(noCode({ precipitationMm: 1, rainMm: 1, temperatureC: 3 })).toBe('rain');
    expect(noCode({ precipitationMm: 1, rainMm: 0, snowfallCm: 1 })).toBe('snow');
    expect(noCode({ precipitationMm: 1.5, rainMm: 0.5, snowfallCm: 1 })).toBe('sleet');
    expect(noCode({ cloudCoverPct: 90 })).toBe('cloudy');
    expect(noCode({ cloudCoverPct: 50 })).toBe('partly-cloudy');
    expect(noCode({ cloudCoverPct: 10 })).toBe('clear');
    expect(noCode({})).toBe('clear');
  });

  it('falls through an unknown code to the derivation rather than to clear', () => {
    expect(hourCondition(hour(NOW, { weatherCode: 42, precipitationMm: 1, snowfallCm: 1 }))).toBe(
      'snow',
    );
  });
});

describe('buildForecastPlan — hours', () => {
  it('keeps only forward hours, keeps the hour in progress, and sorts', () => {
    const hours = [
      hour(NOW + 2 * HOUR),
      hour(NOW - 3 * HOUR), // fully elapsed
      hour(NOW - 20 * 60_000), // started 20 min ago — still this hour
      hour(NOW + HOUR),
    ];
    const plan = buildForecastPlan(hours, NOW);
    expect(plan.hours.map((h) => h.startMs)).toEqual([
      NOW - 20 * 60_000,
      NOW + HOUR,
      NOW + 2 * HOUR,
    ]);
  });

  it('reads the clock and the date with UTC getters, because startMs is already local', () => {
    const plan = buildForecastPlan([hour(local('2026-01-14T22:00:00'))], NOW);
    const h = plan.hours[0]!;
    expect(h.localHour).toBe(22);
    expect(h.localDate).toBe('2026-01-14');
    expect(planHourLabel(h)).toBe('10 PM');
  });

  it('pre-rounds imperial display values (D25)', () => {
    const plan = buildForecastPlan(
      [
        hour(NOW + HOUR, {
          temperatureC: -6.7,
          snowfallCm: 2.54,
          rainMm: 2.54,
          windSpeedKph: 16.1,
          windGustKph: 40,
        }),
      ],
      NOW,
    );
    const h = plan.hours[0]!;
    expect(h.temperatureF).toBe(20);
    expect(h.snowfallIn).toBe(1);
    expect(h.rainIn).toBe(0.1);
    expect(h.windMph).toBe(10);
    expect(h.gustMph).toBe(25);
  });

  it('calls night by shortwave when it has it, and by the clock when it does not', () => {
    const lit = buildForecastPlan([hour(local('2026-01-14T20:00:00'), { shortwaveWm2: 200 })], NOW);
    expect(lit.hours[0]!.isNight).toBe(false); // trust the sensor over the clock
    const dark = buildForecastPlan(
      [hour(local('2026-01-14T20:00:00'), { shortwaveWm2: undefined })],
      NOW,
    );
    expect(dark.hours[0]!.isNight).toBe(true);
    const noon = buildForecastPlan(
      [hour(local('2026-01-15T12:00:00'), { shortwaveWm2: undefined })],
      NOW,
    );
    expect(noon.hours[0]!.isNight).toBe(false);
  });

  it('is empty when nothing is forward', () => {
    expect(forecastPlanIsEmpty(buildForecastPlan([hour(NOW - 5 * HOUR)], NOW))).toBe(true);
    expect(forecastPlanIsEmpty(null)).toBe(true);
    expect(forecastPlanIsEmpty(buildForecastPlan([hour(NOW + HOUR)], NOW))).toBe(false);
  });
});

describe('buildForecastPlan — days', () => {
  it('cuts days at the local midnight from the date string, labels today and tomorrow, and caps at seven', () => {
    const start = local('2026-01-14T15:00:00');
    const plan = buildForecastPlan(series(start, 9 * 24), NOW);
    expect(plan.days).toHaveLength(FORECAST_PLAN_DAYS);
    expect(plan.days[0]).toMatchObject({
      localDate: '2026-01-14',
      label: 'Today',
      dateLabel: 'Wed 14',
      partial: true,
      hourCount: 9,
    });
    expect(plan.days[1]).toMatchObject({
      localDate: '2026-01-15',
      label: 'Tomorrow',
      dateLabel: 'Thu 15',
      partial: false,
      hourCount: 24,
    });
    expect(plan.days[2]!.label).toBe('Fri');
    // The hour row is cut with the day row, so a tap can never target an hour that is not drawn.
    const last = plan.days[plan.days.length - 1]!;
    expect(plan.hours).toHaveLength(last.firstHourIndex + last.hourCount);
    expect(plan.hours[plan.hours.length - 1]!.localDate).toBe(last.localDate);
  });

  it('points each day at its first hour, which is what a day-card tap scrolls to', () => {
    const start = local('2026-01-14T15:00:00');
    const plan = buildForecastPlan(series(start, 48), NOW);
    const tomorrow = plan.days[1]!;
    expect(plan.hours[tomorrow.firstHourIndex]!.startMs).toBe(local('2026-01-15T00:00:00'));
  });

  it("takes the high and low over the day and the night low over the archive's window", () => {
    const start = local('2026-01-14T15:00:00');
    const plan = buildForecastPlan(
      series(start, 48, (_, ms) => {
        const h = new Date(ms).getUTCHours();
        // Wednesday night: coldest at 4 AM Thursday (−20); Thursday afternoon warms to +2.
        if (h === 4) return { temperatureC: -20 };
        if (h === 14) return { temperatureC: 2 };
        return { temperatureC: -5 };
      }),
      NOW,
    );
    const thu = plan.days[1]!;
    expect(thu.highC).toBe(2);
    expect(thu.lowC).toBe(-20);
    // Today's night (Tue 18:00 → Wed 09:00) is entirely behind us: no claim.
    expect(plan.days[0]!.nightLowC).toBeNull();
    // Thursday's night low IS its day low, so the line would only repeat it: no claim either.
    expect(thu.nightLowC).toBeNull();
  });

  it('names the night low only when the night was colder than the calendar day', () => {
    const start = local('2026-01-14T15:00:00');
    const plan = buildForecastPlan(
      series(start, 48, (_, ms) => {
        const h = new Date(ms).getUTCHours();
        const d = new Date(ms).getUTCDate();
        // Wednesday 8 PM is the cold hour (−20); Thursday itself never drops below −5.
        if (d === 14 && h === 20) return { temperatureC: -20 };
        return { temperatureC: -5 };
      }),
      NOW,
    );
    const thu = plan.days[1]!;
    expect(thu.lowC).toBe(-5);
    expect(thu.nightLowC).toBe(-20); // [Wed 18:00, Thu 09:00) reaches back into Wednesday evening
    expect(thu.nightLowF).toBe(-4);
  });

  it('does not let a trace of drizzle name the day', () => {
    const start = local('2026-01-15T00:00:00');
    const plan = buildForecastPlan(
      series(start, 24, (i) =>
        i === 10 ? { weatherCode: 51, rainMm: 0.1, precipitationMm: 0.1 } : { weatherCode: 3 },
      ),
      NOW,
    );
    expect(plan.days[0]!.condition).toBe('cloudy');
  });

  it('names a dry day by its daytime cloud, and any snow day by the snow', () => {
    const start = local('2026-01-15T00:00:00');
    const cloudyMorning = buildForecastPlan(
      series(start, 24, (_, ms) => {
        const h = new Date(ms).getUTCHours();
        return { weatherCode: h < 12 ? 3 : 0, shortwaveWm2: sun(ms) };
      }),
      NOW,
    );
    // 7–11 cloudy (5 h) vs 12–16 clear (5 h): the tie resolves toward the cloudier state.
    expect(cloudyMorning.days[0]!.condition).toBe('cloudy');

    const snowyHour = buildForecastPlan(
      series(start, 24, (i) => (i === 3 ? { weatherCode: 73, snowfallCm: 1 } : { weatherCode: 0 })),
      NOW,
    );
    expect(snowyHour.days[0]!.condition).toBe('snow');
  });

  it('names a day by a storm that is still falling on it, and gives it a continuation line with its own share', () => {
    // Thu 2 PM → Fri 8 PM at 0.5 cm/h: Friday has no episode of its own and every daytime hour is
    // snowing, which used to leave the cloud vote with an empty tally — and an empty tally named
    // the day by the first entry of the table, "freezing rain".
    const start = local('2026-01-15T00:00:00');
    const plan = buildForecastPlan(
      series(start, 72, (_, ms) => {
        const t = ms - start;
        return t >= 14 * HOUR && t < 44 * HOUR ? { weatherCode: 73, snowfallCm: 0.5 } : {};
      }),
      NOW,
    );
    const [thu, fri, sat] = plan.days as [
      (typeof plan.days)[number],
      (typeof plan.days)[number],
      (typeof plan.days)[number],
    ];
    expect(thu.condition).toBe('snow');
    expect(fri.condition).toBe('snow');
    expect(sat.condition).toBe('clear');
    // The storm's total is Thursday's sentence, and the end names its day because "2–8 PM" is six
    // hours to a reader; Friday says when it stops and how much of it is Friday's (20 h of 30).
    expect(thu.lines).toEqual(['Snow 2 PM–8 PM Fri · 5.9″']);
    expect(fri.lines).toEqual(['Snow until 8 PM · 3.9″']);
    expect(sat.lines).toEqual([]);
  });

  it('prints "all day" on a day a storm runs straight through, and "until" on the day it ends', () => {
    // Thu 8 PM → Sat 6 AM: Friday is entirely inside it.
    const start = local('2026-01-15T00:00:00');
    const plan = buildForecastPlan(
      series(start, 72, (_, ms) => {
        const t = ms - start;
        return t >= 20 * HOUR && t < 54 * HOUR ? { weatherCode: 73, snowfallCm: 0.5 } : {};
      }),
      NOW,
    );
    expect(plan.days[0]!.lines).toEqual(['Snow 8 PM–6 AM Sat · 6.7″']);
    expect(plan.days[1]!.lines).toEqual(['Snow all day · 4.7″']);
    expect(plan.days[2]!.lines).toEqual(['Snow until 6 AM · 1.2″']);
  });

  it('never says "all day" on a truncated card — the forecast ended, the weather did not', () => {
    // Thu 8 PM → the end of a series that stops Fri 9 AM: Friday's card holds nine hours.
    const start = local('2026-01-15T00:00:00');
    const plan = buildForecastPlan(
      series(start, 33, (i) => (i >= 20 ? { weatherCode: 73, snowfallCm: 0.5 } : {})),
      NOW,
    );
    expect(plan.days[1]).toMatchObject({ partial: true, hourCount: 9 });
    expect(plan.days[1]!.lines).toEqual(['Snow through 8 AM · 1.8″']);
    // And Thursday's own sentence has no end to print either.
    expect(plan.days[0]!.lines).toEqual(['Snow from 8 PM · 2.6″']);
  });

  it('gives today\'s card a range, not "all day", for a run over the rest of it', () => {
    // Now is 2:20 PM; snow from the hour in progress through midnight.
    const start = NOW - 20 * 60_000;
    const plan = buildForecastPlan(
      series(start, 30, (i) => (i < 10 ? { weatherCode: 73, snowfallCm: 0.5 } : {})),
      NOW,
    );
    expect(plan.days[0]!.partial).toBe(true);
    expect(plan.days[0]!.lines).toEqual(['Snow 2 PM–12 AM · 2″']);
  });

  it('needs no weekday for a run that ends exactly at midnight', () => {
    const start = local('2026-01-15T00:00:00');
    const plan = buildForecastPlan(
      series(start, 48, (i) => (i >= 18 && i < 24 ? { weatherCode: 73, snowfallCm: 0.5 } : {})),
      NOW,
    );
    expect(plan.days[0]!.lines).toEqual(['Snow 6 PM–12 AM · 1.2″']);
    expect(plan.days[1]!.lines).toEqual([]);
  });

  it("continues a wind run with that day's own gusts, not the storm's", () => {
    const start = local('2026-01-15T00:00:00');
    const plan = buildForecastPlan(
      series(start, 48, (i) =>
        i >= 20 && i < 30
          ? { windSpeedKph: EPISODE_WIND_KPH + 4, windGustKph: i < 24 ? 70 : 50 }
          : {},
      ),
      NOW,
    );
    expect(plan.days[0]!.lines).toEqual(['Wind 8 PM–6 AM Fri · gusts 43 mph']);
    expect(plan.days[1]!.lines).toEqual(['Wind until 6 AM · gusts 31 mph']);
  });

  it('names a day of sub-floor drizzle "drizzle", not the first row of the table', () => {
    const start = local('2026-01-15T00:00:00');
    const plan = buildForecastPlan(
      series(start, 24, () => ({ weatherCode: 51, rainMm: 0.01, precipitationMm: 0.01 })),
      NOW,
    );
    expect(plan.days[0]!.condition).toBe('drizzle');
    expect(plan.days[0]!.lines).toEqual([]);
  });

  it('lets an hour of thunder name the day even when its rain run earns a sentence', () => {
    const start = local('2026-01-15T00:00:00');
    const plan = buildForecastPlan(
      series(start, 24, (i) =>
        i >= 13 && i < 16 ? { weatherCode: 95, rainMm: 2, precipitationMm: 2 } : {},
      ),
      NOW,
    );
    expect(plan.days[0]!.condition).toBe('thunder');
    expect(plan.days[0]!.lines).toEqual(['Rain 1–4 PM · 0.24″']);
  });

  it('ranks freezing rain above snow above rain when a day has all three', () => {
    const start = local('2026-01-15T00:00:00');
    const plan = buildForecastPlan(
      series(start, 24, (i) => {
        if (i === 2) return { weatherCode: 73, snowfallCm: 2 };
        if (i === 10) return { weatherCode: 63, rainMm: 2, precipitationMm: 2 };
        if (i === 20) return { weatherCode: 66, rainMm: 0.1, precipitationMm: 0.1 };
        return {};
      }),
      NOW,
    );
    expect(plan.days[0]!.condition).toBe('freezing-rain');
  });

  it('counts sunlit hours only when shortwave is available', () => {
    const start = local('2026-01-15T00:00:00');
    const withSun = buildForecastPlan(
      series(start, 24, (_, ms) => ({ shortwaveWm2: sun(ms) })),
      NOW,
    );
    expect(withSun.days[0]!.sunlitHours).toBeGreaterThan(0);
    const without = buildForecastPlan(
      series(start, 24, () => ({ shortwaveWm2: undefined })),
      NOW,
    );
    expect(without.days[0]!.sunlitHours).toBeNull();
  });
});

describe('episodes', () => {
  const start = local('2026-01-15T00:00:00');

  it('turns a run of snow into one sentence with the founder\'s clock — "Snow 10 PM–4 AM"', () => {
    const plan = buildForecastPlan(
      series(start, 48, (_, ms) => {
        const t = ms - start;
        // Thursday 22:00 → Friday 04:00 (exclusive): six hours at 0.5 cm.
        return t >= 22 * HOUR && t < 28 * HOUR ? { weatherCode: 73, snowfallCm: 0.5 } : {};
      }),
      NOW,
    );
    const thu = plan.days[0]!;
    expect(thu.episodes).toHaveLength(1);
    // The end crosses midnight, so it names its day; Friday then says how it ends there, with
    // Friday's own share (four hours of the six).
    expect(thu.lines).toEqual(['Snow 10 PM–4 AM Fri · 1.2″']);
    expect(plan.days[1]!.lines).toEqual(['Snow until 4 AM · 0.8″']);
  });

  it('bridges a single dry hour inside a snow run, but not two', () => {
    const one = detectEpisodes(
      buildForecastPlan(
        series(start, 8, (i) => (i === 3 ? {} : { weatherCode: 73, snowfallCm: 0.5 })),
        NOW,
      ).hours,
    );
    expect(one.filter((e) => e.kind === 'snow')).toHaveLength(1);
    const two = detectEpisodes(
      buildForecastPlan(
        series(start, 8, (i) => (i === 3 || i === 4 ? {} : { weatherCode: 73, snowfallCm: 0.5 })),
        NOW,
      ).hours,
    );
    expect(two.filter((e) => e.kind === 'snow')).toHaveLength(2);
  });

  it('drops a dusting and a sprinkle, but never a trace of freezing rain', () => {
    const plan = buildForecastPlan(
      series(start, 24, (i) => {
        if (i === 2) return { weatherCode: 71, snowfallCm: 0.1 };
        if (i === 8) return { weatherCode: 51, rainMm: 0.1, precipitationMm: 0.1 };
        if (i === 14) return { weatherCode: 56, rainMm: 0.05, precipitationMm: 0.05 };
        return {};
      }),
      NOW,
    );
    expect(plan.days[0]!.lines).toEqual(['Freezing rain 2–3 PM']);
  });

  it('reports wind as its own episode, by gust when the gust outruns the speed', () => {
    const plan = buildForecastPlan(
      series(start, 24, (i) =>
        i >= 14 && i < 19 ? { windSpeedKph: EPISODE_WIND_KPH + 4, windGustKph: 60 } : {},
      ),
      NOW,
    );
    expect(plan.days[0]!.lines).toEqual(['Wind 2–7 PM · gusts 37 mph']);
  });

  it('says "all day" when the run covers the whole card', () => {
    const plan = buildForecastPlan(
      series(start, 24, () => ({ weatherCode: 73, snowfallCm: 0.2 })),
      NOW,
    );
    expect(plan.days[0]!.lines).toEqual(['Snow all day · 1.9″']);
  });

  it('names sleet by both amounts and formats rain in hundredths', () => {
    const e = detectEpisodes(
      buildForecastPlan(
        series(start, 3, () => ({
          weatherCode: 68,
          snowfallCm: 0.5,
          rainMm: 1,
          precipitationMm: 1 + 0.5 / 0.7, // self-consistent: liquid + snow water-equivalent
        })),
        NOW,
      ).hours,
    )[0]!;
    expect(formatEpisode(e)).toBe('Sleet 12–3 AM · 0.6″ snow, 0.12″ rain');
  });
});

describe('episodes across holes and DST', () => {
  const start = local('2026-01-15T00:00:00');

  it('never spans an hour the provider did not return, and the lull bridge cannot cross one', () => {
    // 10 PM, 11 PM, [midnight missing], 1 AM, 2 AM — all snowing. Two episodes, not "10 PM–3 AM".
    const snowing = { weatherCode: 73, snowfallCm: 0.5 } as const;
    const withHole = [
      hour(start + 22 * HOUR, snowing),
      hour(start + 23 * HOUR, snowing),
      hour(start + 25 * HOUR, snowing),
      hour(start + 26 * HOUR, snowing),
    ];
    const episodes = detectEpisodes(buildForecastPlan(withHole, NOW).hours);
    expect(episodes.map((e) => [e.startMs, e.endMs])).toEqual([
      [start + 22 * HOUR, start + 24 * HOUR],
      [start + 25 * HOUR, start + 27 * HOUR],
    ]);
    // A dry hour bridges a lull; a missing hour is not a dry hour.
    const bridged = detectEpisodes(
      buildForecastPlan(
        [
          hour(start + 22 * HOUR, snowing),
          hour(start + 23 * HOUR),
          hour(start + 24 * HOUR, snowing),
        ],
        NOW,
      ).hours,
    );
    expect(bridged).toHaveLength(1);
  });

  it('reads a spring-forward night as continuous — the clock jumps 1 AM → 3 AM, the hours do not', () => {
    // UTC instants one hour apart; local clocks shifted by −5 h then −4 h across 2026-03-08 07:00Z.
    const transition = Date.UTC(2026, 2, 8, 7, 0); // 2 AM EST becomes 3 AM EDT
    const snowing = { weatherCode: 73, snowfallCm: 0.5 } as const;
    const hours = Array.from({ length: 22 }, (_, i) => i - 2).map((k) => {
      const utcMs = transition + k * HOUR;
      const offset = k < 0 ? -5 * HOUR : -4 * HOUR;
      return hour(utcMs + offset, { ...(k <= 1 ? snowing : {}), utcMs });
    });
    const plan = buildForecastPlan(hours, transition - 3 * HOUR - 5 * HOUR);
    expect(plan.hours.slice(0, 4).map(planHourLabel)).toEqual(['12 AM', '1 AM', '3 AM', '4 AM']);
    expect(detectEpisodes(plan.hours)).toHaveLength(1);
    expect(plan.days[0]!.lines).toEqual(['Snow 12–5 AM · 0.8″']);
  });

  it('reads a fall-back night as continuous — 1 AM happens twice, and neither is a gap', () => {
    const transition = Date.UTC(2026, 10, 1, 6, 0); // 2 AM EDT becomes 1 AM EST
    const snowing = { weatherCode: 73, snowfallCm: 0.5 } as const;
    const hours = [-2, -1, 0, 1].map((k) => {
      const utcMs = transition + k * HOUR;
      const offset = k < 0 ? -4 * HOUR : -5 * HOUR;
      return hour(utcMs + offset, { ...snowing, utcMs });
    });
    const plan = buildForecastPlan(hours, transition - 3 * HOUR - 4 * HOUR);
    expect(plan.hours.map(planHourLabel)).toEqual(['12 AM', '1 AM', '1 AM', '2 AM']);
    expect(detectEpisodes(plan.hours)).toHaveLength(1);
    expect(plan.days[0]!.hourCount).toBe(4);
  });

  it('calls a 23-hour spring-forward day whole, not partial', () => {
    const dayStart = Date.UTC(2026, 2, 8, 5, 0); // local midnight, EST
    const hours: ForecastHour[] = [];
    for (let k = 0; k < 23; k++) {
      const utcMs = dayStart + k * HOUR;
      const offset = utcMs < Date.UTC(2026, 2, 8, 7, 0) ? -5 * HOUR : -4 * HOUR;
      hours.push(hour(utcMs + offset, { utcMs }));
    }
    const plan = buildForecastPlan(hours, dayStart - 5 * HOUR);
    expect(plan.days[0]).toMatchObject({ localDate: '2026-03-08', hourCount: 23, partial: false });
  });
});

describe('liquidMm', () => {
  it('recovers convective showers from the total, which `rain` alone omits', () => {
    // Open-Meteo: precipitation = rain + showers + snow water-equivalent; `rain` excludes showers.
    expect(liquidMm(hour(NOW, { precipitationMm: 2.0, rainMm: 0.5, snowfallCm: 0 }))).toBeCloseTo(
      2.0,
    );
    // Snow at the provider's 7:1 ratio comes off the total before it is called liquid.
    expect(liquidMm(hour(NOW, { precipitationMm: 1.0, rainMm: 0, snowfallCm: 0.7 }))).toBeCloseTo(
      0,
    );
    // Rounding can leave the derived value a hair under `rain`; `rain` is never exceeded by nothing.
    expect(liquidMm(hour(NOW, { precipitationMm: 0.9, rainMm: 1.0, snowfallCm: 0 }))).toBe(1.0);
  });

  it('lets a showers-only hour name itself rain and earn a sentence', () => {
    const start = local('2026-01-15T00:00:00');
    const plan = buildForecastPlan(
      series(start, 24, (i) =>
        i >= 13 && i < 16
          ? { weatherCode: undefined, precipitationMm: 1.5, rainMm: 0, temperatureC: 4 }
          : {},
      ),
      NOW,
    );
    expect(plan.days[0]!.condition).toBe('rain');
    expect(plan.days[0]!.lines).toEqual(['Rain 1–4 PM · 0.18″']);
    expect(plan.days[0]!.rainIn).toBe(0.18);
  });
});

describe('arrival', () => {
  it('marks exactly one card — the hour the viewer would arrive in if they left now — and captions it as a band', () => {
    const plan = buildForecastPlan(series(NOW - 20 * 60_000, 24), NOW, { arrivalBandMinutes: 60 });
    const marked = plan.hours.filter((h) => h.arrival);
    expect(marked).toHaveLength(1);
    // now = 14:20, band 60 → 15:20 → the 3 PM card.
    expect(marked[0]!.localHour).toBe(15);
    expect(plan.arrivalIndex).toBe(plan.hours.indexOf(marked[0]!));
    expect(arrivalCaption(plan)).toBe('≈ arrival, 60 min drive');
  });

  it('marks nothing without a band, and nothing when the band lands past the series', () => {
    expect(buildForecastPlan(series(NOW, 24), NOW).arrivalIndex).toBeNull();
    expect(arrivalCaption(buildForecastPlan(series(NOW, 24), NOW))).toBeNull();
    const short = buildForecastPlan(series(NOW, 1), NOW, { arrivalBandMinutes: 90 });
    expect(short.arrivalIndex).toBeNull();
  });
});
