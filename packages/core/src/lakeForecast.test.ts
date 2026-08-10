import { describe, expect, it } from 'vitest';
import {
  FORECAST_HORIZON_HOURS,
  FORECAST_NOTABLE_SNOW_CM,
  forecastIsEmpty,
  formatForecastStrip,
  summarizeForecast,
} from './lakeForecast';
import type { HourlyWeather } from './weather';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function hour(offsetHours: number, over: Partial<HourlyWeather> = {}): HourlyWeather {
  return {
    startMs: NOW + offsetHours * HOUR,
    temperatureC: -5,
    precipitationMm: 0,
    windSpeedKph: 10,
    ...over,
  };
}

describe('summarizeForecast', () => {
  it('keeps only the hours inside the horizon', () => {
    const summary = summarizeForecast([hour(-2), hour(1), hour(5), hour(20)], NOW);
    expect(summary.hours.map((h) => h.startMs)).toEqual([NOW + HOUR, NOW + 5 * HOUR]);
  });

  it('sorts hours, because a provider does not promise order', () => {
    const summary = summarizeForecast([hour(6), hour(2), hour(4)], NOW);
    expect(summary.hours.map((h) => h.startMs)).toEqual([
      NOW + 2 * HOUR,
      NOW + 4 * HOUR,
      NOW + 6 * HOUR,
    ]);
  });

  it('drops an hour with no clock rather than placing it wrongly', () => {
    const noClock: HourlyWeather = { temperatureC: -3, precipitationMm: 0, windSpeedKph: 5 };
    expect(summarizeForecast([noClock, hour(1)], NOW).hours).toHaveLength(1);
  });

  /** The founder's scenario, and the reason the field is computed here rather than per client. */
  it('names the hour snow starts', () => {
    const summary = summarizeForecast(
      [hour(1), hour(2), hour(3, { snowfallCm: 2 }), hour(4, { snowfallCm: 3 })],
      NOW,
    );
    expect(summary.precipStartsMs).toBe(NOW + 3 * HOUR);
    expect(summary.precipIsSnow).toBe(true);
  });

  it('names rain as rain', () => {
    const summary = summarizeForecast([hour(1), hour(2, { precipitationMm: 3 })], NOW);
    expect(summary.precipStartsMs).toBe(NOW + 2 * HOUR);
    expect(summary.precipIsSnow).toBe(false);
  });

  it('calls an hour that is both snow and rain a snow hour', () => {
    const summary = summarizeForecast([hour(1, { snowfallCm: 1, precipitationMm: 2 })], NOW);
    expect(summary.precipIsSnow).toBe(true);
  });

  it('ignores flurries below the notable floor', () => {
    const summary = summarizeForecast([hour(1, { snowfallCm: FORECAST_NOTABLE_SNOW_CM / 2 })], NOW);
    expect(summary.precipStartsMs).toBeUndefined();
  });

  it('reports the temperature range across the horizon', () => {
    const summary = summarizeForecast(
      [
        hour(1, { temperatureC: -12 }),
        hour(2, { temperatureC: -2 }),
        hour(3, { temperatureC: -7 }),
      ],
      NOW,
    );
    expect(summary.minTemperatureC).toBe(-12);
    expect(summary.maxTemperatureC).toBe(-2);
  });

  it('takes a horizon override', () => {
    expect(summarizeForecast([hour(1), hour(5)], NOW, 2).hours).toHaveLength(1);
    expect(FORECAST_HORIZON_HOURS).toBe(12);
  });

  it('returns an empty strip rather than a fabricated one when there are no forward hours', () => {
    const summary = summarizeForecast([hour(-4), hour(-1)], NOW);
    expect(summary.hours).toEqual([]);
    expect(summary.precipStartsMs).toBeUndefined();
    expect(summary.minTemperatureC).toBeUndefined();
  });
});

describe('forecastIsEmpty', () => {
  it('treats absent, null and hourless summaries alike', () => {
    expect(forecastIsEmpty(undefined)).toBe(true);
    expect(forecastIsEmpty(null)).toBe(true);
    expect(forecastIsEmpty({ hours: [] })).toBe(true);
    expect(forecastIsEmpty(summarizeForecast([hour(1)], NOW))).toBe(false);
  });
});

describe('formatForecastStrip', () => {
  /** Local-shifted ms whose UTC hour reads as the local clock hour (Open-Meteo's `timezone=auto`). */
  function atLocalHour(h: number): number {
    return Date.UTC(2026, 0, 15, h, 0, 0);
  }

  it('renders nothing when there is nothing to say', () => {
    expect(formatForecastStrip(null)).toBeNull();
    expect(formatForecastStrip({ hours: [] })).toBeNull();
    // Hours but no derived fields at all — nothing worth a sentence.
    expect(
      formatForecastStrip({
        hours: [
          {
            startMs: atLocalHour(9),
            temperatureC: -5,
            windSpeedKph: 5,
            precipitationMm: 0,
            snowfallCm: 0,
          },
        ],
      }),
    ).toBeNull();
  });

  it('reports the range in Fahrenheit (D25), not Celsius', () => {
    const line = formatForecastStrip({
      hours: [
        {
          startMs: atLocalHour(9),
          temperatureC: -10,
          windSpeedKph: 5,
          precipitationMm: 0,
          snowfallCm: 0,
        },
      ],
      minTemperatureC: -10,
      maxTemperatureC: 0,
    });
    expect(line).toBe('Next 1 hour: 14–32°F.');
  });

  it('collapses a flat range to a single reading', () => {
    const line = formatForecastStrip({
      hours: [
        {
          startMs: atLocalHour(9),
          temperatureC: -5,
          windSpeedKph: 5,
          precipitationMm: 0,
          snowfallCm: 0,
        },
        {
          startMs: atLocalHour(10),
          temperatureC: -5,
          windSpeedKph: 5,
          precipitationMm: 0,
          snowfallCm: 0,
        },
      ],
      minTemperatureC: -5,
      maxTemperatureC: -5,
    });
    expect(line).toBe('Next 2 hours: Around 23°F.');
  });

  /** The founder's scenario, rendered. */
  it('names the hour snow starts, on a plain clock', () => {
    const line = formatForecastStrip({
      hours: [
        {
          startMs: atLocalHour(9),
          temperatureC: -5,
          windSpeedKph: 5,
          precipitationMm: 0,
          snowfallCm: 0,
        },
      ],
      minTemperatureC: -5,
      maxTemperatureC: -1,
      precipStartsMs: atLocalHour(15),
      precipIsSnow: true,
    });
    expect(line).toContain('snow starting around 3pm');
  });

  it('says rain when it is rain', () => {
    const line = formatForecastStrip({
      hours: [
        {
          startMs: atLocalHour(9),
          temperatureC: 1,
          windSpeedKph: 5,
          precipitationMm: 0,
          snowfallCm: 0,
        },
      ],
      minTemperatureC: 1,
      maxTemperatureC: 2,
      precipStartsMs: atLocalHour(0),
      precipIsSnow: false,
    });
    expect(line).toContain('rain starting around midnight');
  });

  it('reads noon as noon', () => {
    const line = formatForecastStrip({
      hours: [
        {
          startMs: atLocalHour(9),
          temperatureC: -2,
          windSpeedKph: 5,
          precipitationMm: 0,
          snowfallCm: 0,
        },
      ],
      minTemperatureC: -2,
      maxTemperatureC: -2,
      precipStartsMs: atLocalHour(12),
      precipIsSnow: true,
    });
    expect(line).toContain('around noon');
  });

  /** D3: this strip forecasts weather. It must never acquire a sentence about the ice. */
  it('never says anything about the ice itself', () => {
    const line =
      formatForecastStrip({
        hours: [
          {
            startMs: atLocalHour(9),
            temperatureC: -5,
            windSpeedKph: 5,
            precipitationMm: 0,
            snowfallCm: 0,
          },
        ],
        minTemperatureC: -5,
        maxTemperatureC: -1,
        precipStartsMs: atLocalHour(15),
        precipIsSnow: true,
      }) ?? '';
    expect(line.toLowerCase()).not.toMatch(/ice|skat|safe|unsafe|condition/);
  });
});
