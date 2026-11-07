import {
  buildForecastPlan,
  buildPastWeatherPanel,
  type ForecastHour,
  type ForecastPayload,
  type ForecastPlan,
  type LocalHourlyWeather,
  type SubAreaSpread,
  summarizeWeatherDays,
  type TimelineDayInput,
  type TimelineHour,
} from '@skating/core';

/**
 * Weather fixtures for the tab's stories and tests, shaped like boards 1.6/1.7: "today" is Saturday
 * 16 January 2027 on Mascoma's clock (11:52 AM), a thaw and rain on the 7th–8th, a cold snap, snow
 * on the 13th. Invented weather; the shapes are core's own inputs, so every number on screen is
 * still computed by core.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Five hours behind UTC in January (EST). */
const OFFSET = -5 * HOUR;

/** A lake-local wall-clock time as a local-shifted stamp (how the server sends `startMs`). */
export const localMs = (iso: string): number => Date.parse(`${iso}Z`);

/** The board's "now", as a real instant. */
export const NOW_MS = localMs('2027-01-16T11:52:00') - OFFSET;

const fToC = (f: number) => ((f - 32) * 5) / 9;

/** [day of January, low °F, high °F, sun 0–1, wind mph] — the board's ten days and today. */
const DAYS: [number, number, number, number, number][] = [
  [6, 22, 34, 0.5, 7],
  [7, 30, 41, 0.8, 9],
  [8, 33, 43, 0.08, 14],
  [9, 24, 36, 0.3, 12],
  [10, 8, 22, 0.9, 6],
  [11, -2, 14, 1, 4],
  [12, -7, 9, 1, 3],
  [13, 4, 18, 0.15, 11],
  [14, 6, 20, 0.7, 8],
  [15, 3, 22, 0.9, 5],
  [16, 9, 24, 0.95, 9],
];

const date = (d: number) => `2027-01-${String(d).padStart(2, '0')}`;

/** The archive's hours for the board's eleven days (today runs to 11 AM). */
export function timelineDays(): TimelineDayInput[] {
  let depthM = 0.04;
  return DAYS.map(([d, lo, hi, sun, wind], i) => {
    const prevHi = DAYS[i - 1]?.[2] ?? hi;
    const nextLo = DAYS[i + 1]?.[1] ?? lo;
    const hours: TimelineHour[] = [];
    for (let h = 0; h < 24; h++) {
      if (d === 16 && h > 11) break;
      const tF =
        h < 6
          ? prevHi + ((lo - prevHi) * (h + 9)) / 15
          : h <= 15
            ? lo + ((hi - lo) * (1 - Math.cos(((h - 6) / 9) * Math.PI))) / 2
            : hi + ((nextLo - hi) * (h - 15)) / 15;
      const rain = d === 8 && h >= 9 && h <= 16 ? 1.2 : 0;
      const snowCm = d === 13 && h >= 2 && h <= 13 ? 0.66 : 0;
      if (rain) depthM = Math.max(0.01, depthM - 0.004);
      depthM += snowCm / 100;
      hours.push({
        localDate: date(d),
        localHour: h,
        temperatureC: fToC(tF),
        precipitationMm: rain + snowCm,
        rainMm: rain,
        snowfallCm: snowCm,
        snowDepthM: depthM,
        windSpeedKph: Math.max(1.6, (wind + (h > 10 && h < 17 ? 1.5 : 0)) * 1.609),
        windDirectionDeg: 315,
        shortwaveWm2:
          h >= 8 && h <= 16 ? Math.round(450 * Math.sin(((h - 7.5) / 9.5) * Math.PI) * sun) : 0,
        weatherCode: rain ? 63 : snowCm ? 73 : 1,
      });
    }
    return {
      dayMs: Date.UTC(2027, 0, d),
      localDate: date(d),
      hours,
      ...(d === 16 ? { partial: true } : {}),
    };
  });
}

/** The lake's today, as the archive serves it (UTC midnight of the local date). */
export const TODAY_DAY_MS = Date.UTC(2027, 0, 16);

/**
 * What `weatherArchive.getWeatherDaysForBody` answers for these days: the day summaries (core's
 * `summarizeWeatherDays`) and the raw hours, so every sentence on screen is core's.
 */
export function archiveResult() {
  const days = timelineDays();
  const hourly: LocalHourlyWeather[] = days.flatMap((d) =>
    (d.hours ?? []).map((h) => ({
      ...h,
      precipitationMm: h.precipitationMm ?? 0,
      windSpeedKph: h.windSpeedKph ?? 0,
      cloudCoverPct: (h.shortwaveWm2 ?? 0) > 200 ? 5 : 80,
    })),
  );
  return {
    days: summarizeWeatherDays(hourly),
    hours: days.map((d) => ({
      dayMs: d.dayMs,
      localDate: d.localDate,
      hours: (d.hours ?? []) as unknown as {
        localHour: number;
        temperatureC: number;
        [measure: string]: number;
      }[],
    })),
    missingDayMs: [] as number[],
    todayLocalDayMs: TODAY_DAY_MS,
    anyBorrowed: false,
    oneSampleForALargeBody: false,
  };
}

/** Core's sentences over the ten full days before today. */
export function pastHeadline(): string[] {
  const days = archiveResult().days;
  return buildPastWeatherPanel(days.slice(-11), { todayLocalDayMs: TODAY_DAY_MS }).headline;
}

/** Seven days of forecast hours from 11 AM today, snow Sunday, a cold Tuesday. */
export function forecastPayload(): ForecastPayload {
  const start = localMs('2027-01-16T11:00:00');
  const hours: ForecastHour[] = Array.from({ length: 7 * 24 + 13 }, (_, i) => {
    const startMs = start + i * HOUR;
    const h = (11 + i) % 24;
    const day = Math.floor((11 + i) / 24);
    const base = [18, 20, 12, 3, 6, 18, 26, 30][day] ?? 20;
    const swing = 8 * Math.sin(((h - 9) / 24) * 2 * Math.PI);
    const snowing = day === 1 && h >= 2 && h <= 14;
    return {
      startMs,
      utcMs: startMs - OFFSET,
      temperatureC: fToC(base + swing),
      windSpeedKph: 12 + (h % 5),
      windDirectionDeg: day < 2 ? 315 : 270,
      precipitationMm: snowing ? 2.4 : 0,
      snowfallCm: snowing ? 0.6 : 0,
      rainMm: 0,
      weatherCode: snowing ? 73 : h >= 7 && h <= 16 ? 1 : 3,
      shortwaveWm2: h >= 8 && h <= 16 ? 300 : 0,
    };
  });
  return { hours, utcOffsetMs: OFFSET, arrivalBandMinutes: 60 };
}

/** The planner the board draws, from core. */
export function forecastPlan(): ForecastPlan {
  const payload = forecastPayload();
  return buildForecastPlan(payload.hours, NOW_MS + payload.utcOffsetMs, {
    arrivalBandMinutes: payload.arrivalBandMinutes,
  });
}

/** Mascoma's spread across its two bays (the board's "Across the lake"). */
export const SPREAD: SubAreaSpread = {
  bays: 2,
  days: 7,
  similar: false,
  summary: 'Across both bays over the last 7 days',
  lines: [
    {
      kind: 'lows',
      similar: false,
      minF: -7,
      maxF: -4,
      coldest: { subAreaId: 'north', name: 'Mascoma North' },
      mildest: { subAreaId: 'south', name: 'Mascoma South' },
      parts: [
        'Lows −7°F to −4°F — coldest at ',
        { subAreaId: 'north', name: 'Mascoma North' },
        ', mildest at ',
        { subAreaId: 'south', name: 'Mascoma South' },
      ],
      text: 'Lows −7°F to −4°F — coldest at Mascoma North, mildest at Mascoma South',
    },
  ],
};

export const BAYS = [
  { _id: 'north', name: 'Mascoma North', displayScore: 2 },
  { _id: 'south', name: 'Mascoma South', displayScore: 1 },
];

export { DAY };
