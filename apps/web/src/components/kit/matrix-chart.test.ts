import { describe, expect, it } from 'vitest';

import { TEMP_BOUNDS_F, TEMP_LEGEND, TEMP_STEPS, temperatureStep } from './matrix-chart';

describe('temperatureStep', () => {
  it('follows the boards’ ramp at every bound: a bound starts the warmer step', () => {
    TEMP_BOUNDS_F.forEach((bound, i) => {
      expect(temperatureStep(bound - 0.01)).toBe(TEMP_STEPS[i]);
      expect(temperatureStep(bound)).toBe(TEMP_STEPS[i + 1]);
    });
  });

  it('is monotonic: a warmer reading is never a colder step', () => {
    let prev = 0;
    for (let f = -40; f <= 80; f += 0.25) {
      const at = TEMP_STEPS.indexOf(temperatureStep(f));
      expect(at).toBeGreaterThanOrEqual(prev);
      prev = at;
    }
    expect(temperatureStep(-40)).toBe('cold-4');
    expect(temperatureStep(80)).toBe('warm-3');
  });

  it('puts freezing on the neutral step', () => {
    expect(temperatureStep(32)).toBe('freeze');
  });

  it('words every step as a range of readings, never a verdict', () => {
    for (const step of TEMP_STEPS)
      expect(TEMP_LEGEND[step]).toMatch(/^(under \d+|\d+–\d+|\d+ and up)$/);
  });
});
