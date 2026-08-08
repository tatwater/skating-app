import { describe, expect, it } from 'vitest';
import { formatShare } from './CatalogueCoverage';

/**
 * This panel's whole job is to be readable while the number it reports is almost zero — USGS has
 * re-surveyed 0% of our five states and will for some years. A formatter that rounds to whole
 * percents renders every one of those years as "0%", which reads as a broken chart rather than as a
 * real measurement, and would hide the first genuine movement when it finally arrives.
 */
describe('formatShare', () => {
  it('keeps the zero honest and unadorned', () => {
    expect(formatShare(0)).toBe('0%');
  });

  it('distinguishes the first real movement from zero', () => {
    // The live service's actual reading on 2026-08-03: 1,590 of 356,980.
    expect(formatShare(1590 / 356_980)).toBe('0.445%');
    // A whole-percent formatter would render both of these as "0%".
    expect(formatShare(0)).not.toBe(formatShare(1590 / 356_980));
  });

  it('scales precision to the value rather than fixing it', () => {
    expect(formatShare(0.00005)).toBe('0.0050%'); // one work unit in a big state
    expect(formatShare(0.004)).toBe('0.400%');
    expect(formatShare(0.055)).toBe('5.5%');
    expect(formatShare(0.42)).toBe('42%'); // the day this matters, decimals are noise
  });

  it('renders an unmeasured value as absent, never as zero', () => {
    // A year we did not measure is not a year with no coverage.
    expect(formatShare(null)).toBe('—');
    expect(formatShare(undefined)).toBe('—');
  });
});
