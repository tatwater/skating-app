import { describe, expect, it } from 'vitest';
import { summarizeWeatherSince, type WeatherSinceSummary } from './weather';
import {
  formatWeatherSinceStrip,
  hazardStripWindowStartMs,
  reportStripState,
} from './weatherStrip';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

function wx(partial: Partial<WeatherSinceSummary> = {}): WeatherSinceSummary {
  return { ...summarizeWeatherSince([]), hours: 24, ...partial };
}

describe('formatWeatherSinceStrip (D19, verdict-free)', () => {
  it('formats the human subset in imperial, in order', () => {
    const s = wx({
      peakTempC: 5, // 41°F
      minTempC: -5.6, // ~22°F
      nightsBelowFreezing: 3,
      hoursOfSun: 6,
      rainMm: 12.7, // 0.5″
      maxWindGustKph: 48, // ~30 mph
    });
    expect(formatWeatherSinceStrip(s)).toBe(
      'peak 41°F · low 22°F · 3 nights below freezing · 6h sun · 0.5″ rain · gusts to 30 mph',
    );
  });

  it('singularizes one night and shows snow from the split', () => {
    const s = wx({ peakTempC: 1, minTempC: -1, nightsBelowFreezing: 1, snowfallCm: 5.08 }); // ~2″
    expect(formatWeatherSinceStrip(s)).toBe(
      'peak 34°F · low 30°F · 1 night below freezing · 2″ snow',
    );
  });

  it('omits precip below the mention threshold and never asserts a verdict', () => {
    const s = wx({ peakTempC: 2, minTempC: -3, rainMm: 0.1, maxWindGustKph: 10 });
    const line = formatWeatherSinceStrip(s);
    expect(line).toBe('peak 36°F · low 27°F'); // no trace rain, no light gust
    expect(line).not.toMatch(/safe|unsafe|danger|good|bad/i);
  });

  it('returns null when there is nothing to say', () => {
    expect(formatWeatherSinceStrip(summarizeWeatherSince([]))).toBeNull();
  });

  it('falls back to sustained wind when gust data is absent', () => {
    // A windy stretch whose hours carried no `wind_gusts_10m` — surface the sustained max, not silence.
    const s = wx({ peakTempC: 2, minTempC: -3, maxWindGustKph: null, maxWindKph: 40 }); // ~25 mph
    expect(formatWeatherSinceStrip(s)).toBe('peak 36°F · low 27°F · winds to 25 mph');
  });

  it('prefers the gust peak over sustained wind when both are present', () => {
    const s = wx({ peakTempC: 2, minTempC: -3, maxWindGustKph: 48, maxWindKph: 40 });
    expect(formatWeatherSinceStrip(s)).toBe('peak 36°F · low 27°F · gusts to 30 mph');
  });

  it('falls back to lumped precip when the rain/snow split is absent', () => {
    const s = wx({ peakTempC: 3, minTempC: 0, totalPrecipMm: 5, rainMm: 0, snowfallCm: 0 });
    expect(formatWeatherSinceStrip(s)).toContain('precip');
  });
});

describe('reportStripState (§3 gate)', () => {
  it('hides the strip on a too-fresh report (< 6h)', () => {
    expect(reportStripState(NOW - 3 * HOUR, NOW)).toEqual({ kind: 'hidden' });
  });

  it('shows the strip for a report in the useful window, keyed to the skate time', () => {
    expect(reportStripState(NOW - 2 * DAY, NOW)).toEqual({
      kind: 'strip',
      windowStartMs: NOW - 2 * DAY,
    });
  });

  it('collapses to an age line past the 14-day cap', () => {
    expect(reportStripState(NOW - 20 * DAY, NOW)).toEqual({ kind: 'aged' });
  });

  it('honors custom bounds', () => {
    expect(reportStripState(NOW - 10 * HOUR, NOW, { minAgeHours: 12 })).toEqual({ kind: 'hidden' });
  });
});

describe('hazardStripWindowStartMs (§3)', () => {
  it('uses the recent lookback for a long-unconfirmed hazard', () => {
    expect(hazardStripWindowStartMs(NOW - 30 * DAY, NOW)).toBe(NOW - 7 * DAY);
  });

  it('uses last-confirmed when it is more recent than the lookback', () => {
    expect(hazardStripWindowStartMs(NOW - 2 * DAY, NOW)).toBe(NOW - 2 * DAY);
  });
});
