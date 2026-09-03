import { describe, expect, it } from 'vitest';
import {
  estimateIceThickness,
  fitStefanAlpha,
  STEFAN_ALPHA_DEFAULT,
  STEFAN_MIN_FDD,
} from './iceThickness';
import { cmToInches, inchesToCm } from './units';

describe('estimateIceThickness (D160 — admin-only instrument)', () => {
  it('follows the Stefan square-root law', () => {
    // 100 freezing-degree-days = 2400 freezing-degree-hours. α√100 = 10α.
    const e = estimateIceThickness(2400);
    expect(e.freezingDegreeDays).toBeCloseTo(100, 6);
    expect(e.thicknessCm).toBeCloseTo(STEFAN_ALPHA_DEFAULT * 10, 6);
    expect(e.thicknessIn).toBeCloseTo((STEFAN_ALPHA_DEFAULT * 10) / 2.54, 6);
  });

  it('quadruples the cold for double the ice — the property that makes it a square root', () => {
    const one = estimateIceThickness(2400).thicknessCm ?? 0;
    const four = estimateIceThickness(2400 * 4).thicknessCm ?? 0;
    expect(four).toBeCloseTo(one * 2, 6);
  });

  it('refuses to estimate below the meaningfulness floor', () => {
    const e = estimateIceThickness(STEFAN_MIN_FDD * 24 - 1);
    expect(e.thicknessCm).toBeNull();
    expect(e.thicknessIn).toBeNull();
    // The inputs are still reported, so an operator can see *why* it declined.
    expect(e.freezingDegreeDays).toBeGreaterThan(0);
    expect(e.alpha).toBe(STEFAN_ALPHA_DEFAULT);
  });

  it('treats zero and negative accumulations as no ice rather than as NaN', () => {
    for (const fdh of [0, -1, -10_000]) {
      const e = estimateIceThickness(fdh);
      expect(e.thicknessCm).toBeNull();
      expect(e.freezingDegreeDays).toBe(0);
    }
  });

  it('honours an override α, which is the whole point of storing it alongside the result', () => {
    const e = estimateIceThickness(2400, { alpha: 3 });
    expect(e.alpha).toBe(3);
    expect(e.thicknessCm).toBeCloseTo(30, 6);
  });
});

describe('fitStefanAlpha', () => {
  it('recovers the coefficient from noiseless samples', () => {
    const truth = 2.4;
    const samples = [50, 100, 200, 400].map((fdd) => ({
      freezingDegreeHours: fdd * 24,
      observedCm: truth * Math.sqrt(fdd),
    }));
    const fit = fitStefanAlpha(samples);
    expect(fit?.alpha).toBeCloseTo(truth, 6);
    expect(fit?.n).toBe(4);
    expect(fit?.rmseCm).toBeCloseTo(0, 6);
  });

  it('reports a non-zero RMSE when the data disagrees with any single α', () => {
    const fit = fitStefanAlpha([
      { freezingDegreeHours: 100 * 24, observedCm: 10 },
      { freezingDegreeHours: 100 * 24, observedCm: 30 },
    ]);
    expect(fit?.n).toBe(2);
    expect(fit?.rmseCm).toBeGreaterThan(5);
  });

  it('passes through the origin — no cold can never predict ice', () => {
    // A fit with an intercept could report positive thickness at zero FDD. Ours cannot.
    const fit = fitStefanAlpha([{ freezingDegreeHours: 100 * 24, observedCm: 20 }]);
    const atZero = estimateIceThickness(0, { alpha: fit?.alpha });
    expect(atZero.thicknessCm).toBeNull();
  });

  it('drops samples below the floor or with a non-positive observation', () => {
    const fit = fitStefanAlpha([
      { freezingDegreeHours: 100 * 24, observedCm: 20 },
      { freezingDegreeHours: 0, observedCm: 5 }, // no cold
      { freezingDegreeHours: 100 * 24, observedCm: 0 }, // no ice reported
      { freezingDegreeHours: 100 * 24, observedCm: -3 }, // nonsense
    ]);
    expect(fit?.n).toBe(1);
  });

  it('returns null when nothing is usable', () => {
    expect(fitStefanAlpha([])).toBeNull();
    expect(fitStefanAlpha([{ freezingDegreeHours: 0, observedCm: 10 }])).toBeNull();
  });

  it('lands inside the published lake-ice range for realistic winter data', () => {
    // Roughly a Vermont January: a month averaging -8°C, ice measured around 30 cm.
    const fit = fitStefanAlpha([{ freezingDegreeHours: 8 * 24 * 30, observedCm: 30 }]);
    expect(fit?.alpha).toBeGreaterThan(1.4);
    expect(fit?.alpha).toBeLessThan(3.0);
  });
});

describe('unit conversion', () => {
  it('round-trips inches and centimetres', () => {
    expect(inchesToCm(4)).toBeCloseTo(10.16, 6);
    expect(cmToInches(10.16)).toBeCloseTo(4, 6);
    expect(cmToInches(inchesToCm(7.5))).toBeCloseTo(7.5, 6);
  });
});
