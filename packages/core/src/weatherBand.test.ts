import { describe, expect, it } from 'vitest';
import { archivedHourCondition, weatherCells, weatherRunSummary } from './weatherBand';
import type { WindowHour } from './weatherWindow';

const TZ = 'America/New_York';
const local = (h: number) => Date.UTC(2026, 0, 10, h + 5);
const hour = (h: number, over: Partial<WindowHour> = {}): WindowHour => ({
  localHour: h,
  startMs: local(h),
  temperatureC: -7,
  windSpeedKph: 13,
  windDirectionDeg: 315,
  ...over,
});
const sun = { sunriseMs: local(7), sunsetMs: local(16) + 31 * 60_000 };

describe('weatherCells', () => {
  it('draws one card per hour with the drawer lockup: hour, symbol, temperature, amount, wind', () => {
    const cells = weatherCells(
      [hour(14), hour(15, { temperatureC: -8, windSpeedKph: 19 })],
      TZ,
      sun,
    );
    expect(cells).toHaveLength(2);
    expect(cells[0]).toMatchObject({
      label: '2 PM',
      condition: 'clear',
      glyph: 'sun',
      conditionLabel: 'Clear',
      temperatureF: 19,
      windMph: 8,
      windFrom: 'NW',
    });
    expect(cells[0]?.amount).toBeUndefined();
    expect(cells[1]).toMatchObject({ label: '3 PM', temperatureF: 18, windMph: 12 });
  });

  it('draws precipitation from the timeline rule, snow first, and a moon after sunset', () => {
    const cells = weatherCells(
      [
        hour(16, { snowfallCm: 0.5, precipitationMm: 0.5 }),
        hour(17, { rainMm: 1, precipitationMm: 1, temperatureC: 1 }),
      ],
      TZ,
      sun,
    );
    expect(cells[0]).toMatchObject({ condition: 'snow', glyph: 'snow', amount: '0.2″' });
    expect(cells[1]).toMatchObject({ condition: 'rain', amount: '0.04″' });
    expect(weatherCells([hour(18)], TZ, sun)[0]?.glyph).toBe('moon');
    expect(weatherCells([hour(18)], TZ, null)[0]?.glyph).toBe('sun');
  });

  it('maps every precipitation kind the timeline can name', () => {
    expect(archivedHourCondition(hour(1, { snowfallCm: 0.4, precipitationMm: 0.4 }))).toBe('snow');
    expect(
      archivedHourCondition(hour(1, { snowfallCm: 0.2, rainMm: 0.5, precipitationMm: 0.7 })),
    ).toBe('sleet');
    expect(archivedHourCondition(hour(1, { rainMm: 0.5, precipitationMm: 0.5 }))).toBe(
      'freezing-rain',
    );
    expect(
      archivedHourCondition(hour(1, { rainMm: 0.5, precipitationMm: 0.5, temperatureC: 2 })),
    ).toBe('rain');
    expect(archivedHourCondition(hour(1))).toBe('clear');
  });

  it('reads a dry hour’s sky from its WMO code — overcast and fog are not clear', () => {
    expect(archivedHourCondition(hour(1, { weatherCode: 3 }))).toBe('cloudy');
    expect(archivedHourCondition(hour(1, { weatherCode: 2 }))).toBe('partly-cloudy');
    expect(archivedHourCondition(hour(1, { weatherCode: 45 }))).toBe('fog');
    expect(archivedHourCondition(hour(1, { weatherCode: 0 }))).toBe('clear');
    // A code the table does not know, like a row written before codes were asked for, reads clear.
    expect(archivedHourCondition(hour(1, { weatherCode: 42 }))).toBe('clear');
    // Precipitation still wins over the code's sky.
    expect(
      archivedHourCondition(hour(1, { snowfallCm: 0.4, precipitationMm: 0.4, weatherCode: 3 })),
    ).toBe('snow');
    // The card's glyph and word follow: an overcast night is a cloud, not a moon.
    const [cell] = weatherCells([hour(20, { weatherCode: 3 })], TZ, sun);
    expect(cell?.condition).toBe('cloudy');
    expect(cell?.conditionLabel).toBe('Cloudy');
    expect(cell?.glyph).not.toBe('moon');
  });
});

describe('weatherRunSummary', () => {
  it('reads first to last: temperature, the wind range and where from, the sky and when it changed', () => {
    const cells = weatherCells(
      [
        hour(14),
        hour(15, { temperatureC: -8, windSpeedKph: 19 }),
        hour(16, { temperatureC: -8, windSpeedKph: 22, snowfallCm: 0.5, precipitationMm: 0.5 }),
      ],
      TZ,
      sun,
    );
    expect(weatherRunSummary(cells)).toEqual({
      temperature: '19→18 °F',
      wind: 'wind NW 8→14 mph',
      sky: 'clear, snow after 4 pm',
    });
  });

  it('says a steady hour plainly and copes with no wind', () => {
    const cells = weatherCells(
      [hour(14, { windSpeedKph: undefined, windDirectionDeg: undefined })],
      TZ,
      sun,
    );
    expect(weatherRunSummary(cells)).toEqual({ temperature: '19 °F', sky: 'clear' });
    expect(weatherRunSummary([])).toBeNull();
  });
});
