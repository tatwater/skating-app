import { describe, expect, it } from 'vitest';
import {
  cloudCoverToSky,
  conditionsFromHour,
  precipTypeFrom,
  windDirToCompass,
} from './weatherConditions';

describe('windDirToCompass', () => {
  it('maps degrees to the nearest 8-point compass heading', () => {
    expect(windDirToCompass(0)).toBe('N');
    expect(windDirToCompass(360)).toBe('N');
    expect(windDirToCompass(45)).toBe('NE');
    expect(windDirToCompass(90)).toBe('E');
    expect(windDirToCompass(180)).toBe('S');
    expect(windDirToCompass(270)).toBe('W');
    expect(windDirToCompass(315)).toBe('NW');
    expect(windDirToCompass(-45)).toBe('NW'); // wraps
    expect(windDirToCompass(200)).toBe('S'); // rounds to nearest
  });
});

describe('cloudCoverToSky', () => {
  it('bands cloud cover, and reports precip when precipitating', () => {
    expect(cloudCoverToSky(0, 0)).toBe('clear');
    expect(cloudCoverToSky(25, 0)).toBe('clear');
    expect(cloudCoverToSky(50, 0)).toBe('partly_cloudy');
    expect(cloudCoverToSky(80, 0)).toBe('overcast');
    expect(cloudCoverToSky(10, 0.5)).toBe('precip'); // precip overrides clear sky
  });
});

describe('precipTypeFrom', () => {
  it('distinguishes rain, snow, mixed and none', () => {
    expect(precipTypeFrom(0, 0)).toBe('none');
    expect(precipTypeFrom(1, 0)).toBe('rain');
    expect(precipTypeFrom(0, 0.5)).toBe('snow');
    expect(precipTypeFrom(1, 0.5)).toBe('sleet');
  });
});

describe('conditionsFromHour', () => {
  it('assembles the observed conditions from one hour', () => {
    expect(
      conditionsFromHour({
        temperatureC: -4,
        windSpeedKph: 18,
        windDirDeg: 270,
        cloudCoverPct: 90,
        rainMm: 0,
        snowfallCm: 1.2,
      }),
    ).toEqual({
      airTempC: -4,
      windSpeedKph: 18,
      windDir: 'W',
      sky: 'precip', // snowing
      precip: 'snow',
    });
  });

  it('defaults missing optional inputs sanely (calm, clear, dry)', () => {
    expect(conditionsFromHour({ temperatureC: 0, windSpeedKph: 0 })).toEqual({
      airTempC: 0,
      windSpeedKph: 0,
      windDir: 'N',
      sky: 'clear',
      precip: 'none',
    });
  });
});
