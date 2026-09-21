import { describe, expect, it } from 'vitest';
import {
  conditionsFromWindowHour,
  describeWeatherHour,
  hourAt,
  hourStartMs,
  hoursInWindow,
  placeHours,
  summarizeWeatherWindow,
} from './weatherWindow';

const TZ = 'America/New_York';
// 2026-01-10, a local date; EST all day.
const DAY = Date.UTC(2026, 0, 10);
const day = (hours: { localHour: number; temperatureC: number; [k: string]: number }[]) => ({
  dayMs: DAY,
  hours,
});

describe('hourStartMs / placeHours', () => {
  it('puts a local hour on the clock through the zone’s offset', () => {
    // 14:00 EST on Jan 10 is 19:00Z.
    expect(hourStartMs(DAY, 14, TZ)).toBe(Date.UTC(2026, 0, 10, 19));
    expect(hourStartMs(DAY, 0, TZ)).toBe(Date.UTC(2026, 0, 10, 5));
    expect(hourStartMs(DAY, 14, 'Not/AZone')).toBeNull();
  });

  it('keeps every hour on the wall clock across the spring-forward day', () => {
    const march8 = Date.UTC(2026, 2, 8);
    // 01:00 EST = 06:00Z; 03:00 EDT = 07:00Z — the hour after the change is one UTC hour later, not two.
    expect(hourStartMs(march8, 1, TZ)).toBe(Date.UTC(2026, 2, 8, 6));
    expect(hourStartMs(march8, 3, TZ)).toBe(Date.UTC(2026, 2, 8, 7));
  });

  it('places and sorts hours, skipping days it cannot place', () => {
    const placed = placeHours(
      [
        day([
          { localHour: 15, temperatureC: -2 },
          { localHour: 13, temperatureC: -4 },
        ]),
      ],
      TZ,
    );
    expect(placed.map((h) => h.localHour)).toEqual([13, 15]);
    expect(placeHours([day([{ localHour: 13, temperatureC: -4 }])], 'Not/AZone')).toEqual([]);
  });
});

describe('hoursInWindow / hourAt', () => {
  const placed = placeHours(
    [day([13, 14, 15, 16].map((localHour) => ({ localHour, temperatureC: -4 + localHour - 13 })))],
    TZ,
  );
  const at = (h: number, m = 0) => Date.UTC(2026, 0, 10, h + 5, m);

  it('with no start, the hour the end falls in; with a start, every overlapping hour', () => {
    expect(hoursInWindow(placed, at(14, 20)).map((h) => h.localHour)).toEqual([14]);
    expect(hoursInWindow(placed, at(15, 5), at(13, 50)).map((h) => h.localHour)).toEqual([
      13, 14, 15,
    ]);
    expect(hoursInWindow(placed, at(11))).toEqual([]);
    expect(hourAt(placed, at(16, 59))?.localHour).toBe(16);
    expect(hourAt(placed, at(17))).toBeNull();
  });
});

describe('describeWeatherHour / summarizeWeatherWindow', () => {
  it('reads one hour in imperial, calm when the wind is nil, and names the precipitation', () => {
    expect(describeWeatherHour({ localHour: 14, temperatureC: -4 })).toBe('25 °F');
    expect(
      describeWeatherHour({
        localHour: 14,
        temperatureC: -4,
        windSpeedKph: 13,
        windDirectionDeg: 315,
      }),
    ).toBe('25 °F · wind NW 8 mph');
    expect(describeWeatherHour({ localHour: 14, temperatureC: -4, windSpeedKph: 0 })).toBe(
      '25 °F · calm',
    );
    expect(describeWeatherHour({ localHour: 14, temperatureC: -4, snowfallCm: 0.5 })).toBe(
      '25 °F · snow',
    );
  });

  it('summarizes a window as ranges and totals, in one sentence', () => {
    const placed = placeHours(
      [
        day([
          { localHour: 13, temperatureC: -6, windSpeedKph: 5, windDirectionDeg: 300 },
          {
            localHour: 14,
            temperatureC: -3,
            windSpeedKph: 19,
            windDirectionDeg: 320,
            snowfallCm: 1,
          },
          { localHour: 15, temperatureC: -3, windSpeedKph: 10, windDirectionDeg: 90 },
        ]),
      ],
      TZ,
    );
    const s = summarizeWeatherWindow(placed, TZ);
    expect(s).toMatchObject({
      hours: 3,
      minF: 21,
      maxF: 27,
      maxWindMph: 12,
      windFrom: 'NW',
      snowed: true,
    });
    expect(s?.sentence).toBe('1 PM–4 PM: 21–27 °F, wind up to 12 mph from the NW, 0.4 in of snow');
    expect(summarizeWeatherWindow([], TZ)).toBeNull();
    const one = summarizeWeatherWindow(placed.slice(0, 1), TZ);
    expect(one?.sentence).toBe('1 PM: 21 °F, wind up to 3 mph from the NW');
  });

  it('a rainy window says rain in inches; a trace of snow is a dusting', () => {
    const rain = placeHours([day([{ localHour: 13, temperatureC: 2, rainMm: 5.08 }])], TZ);
    expect(summarizeWeatherWindow(rain, TZ)?.sentence).toBe('1 PM: 36 °F, 0.2 in of rain');
    const dust = placeHours([day([{ localHour: 13, temperatureC: -2, snowfallCm: 0.1 }])], TZ);
    expect(summarizeWeatherWindow(dust, TZ)?.sentence).toBe('1 PM: 28 °F, a dusting of snow');
  });
});

describe('conditionsFromWindowHour', () => {
  it('maps the hour through the autofill’s rules; the WMO code names the sky when it can', () => {
    expect(
      conditionsFromWindowHour({
        localHour: 1,
        temperatureC: -4,
        windSpeedKph: 13,
        windDirectionDeg: 315,
        weatherCode: 2,
      }),
    ).toEqual({
      airTempC: -4,
      windSpeedKph: 13,
      windDir: 'NW',
      sky: 'partly_cloudy',
      precip: 'none',
    });
    expect(conditionsFromWindowHour({ localHour: 1, temperatureC: -4, weatherCode: 0 })).toEqual({
      airTempC: -4,
      sky: 'clear',
      precip: 'none',
    });
    expect(conditionsFromWindowHour({ localHour: 1, temperatureC: -4, weatherCode: 3 }).sky).toBe(
      'overcast',
    );
    expect(conditionsFromWindowHour({ localHour: 1, temperatureC: -4, weatherCode: 71 }).sky).toBe(
      'precip',
    );
    expect(
      conditionsFromWindowHour({ localHour: 1, temperatureC: -4, weatherCode: 20 }).sky,
    ).toBeUndefined();
    expect(conditionsFromWindowHour({ localHour: 1, temperatureC: -4 }).sky).toBeUndefined();
    expect(
      conditionsFromWindowHour({ localHour: 1, temperatureC: 1, rainMm: 1, snowfallCm: 0.2 }),
    ).toMatchObject({ sky: 'precip', precip: 'sleet' });
  });
});
