import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fontSize, gap, size, space } from './sizes';
import {
  assertUnitClass,
  em,
  formatNumber,
  GROUP_UNIT,
  px,
  REM_BASE_PX,
  ratio,
  rem,
  toCssLength,
  toNativeNumber,
  UnitClassError,
} from './units';

describe('unit constructors', () => {
  it('converts the mock px to rem at the 16 px base', () => {
    expect(rem(13)).toEqual({ unit: 'rem', value: 0.8125 });
    expect(toCssLength(rem(13))).toBe('0.8125rem');
    expect(REM_BASE_PX).toBe(16);
  });

  it('writes each class with its unit (a ratio has none)', () => {
    expect(toCssLength(em(0.22))).toBe('0.22em');
    expect(toCssLength(px(1))).toBe('1px');
    expect(toCssLength(ratio(1.45))).toBe('1.45');
    expect(toCssLength(px(0))).toBe('0px');
  });

  it('gives React Native dp for rem and px, multipliers for em and ratio', () => {
    expect(toNativeNumber(rem(13))).toBe(13);
    expect(toNativeNumber(px(2))).toBe(2);
    expect(toNativeNumber(em(0.22))).toBe(0.22);
    expect(toNativeNumber(ratio(1.8))).toBe(1.8);
  });

  it('round-trips any mock px through rem to the same dp (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4000 }), (mockPx) => {
        expect(toNativeNumber(rem(mockPx))).toBe(mockPx);
      }),
    );
  });

  it('formats numbers stably: at most 4 decimals, no trailing zeros, no -0', () => {
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(1 / 3)).toBe('0.3333');
  });
});

describe('unit classes are enforced', () => {
  it('maps each group to one class', () => {
    expect(GROUP_UNIT).toMatchObject({
      fontSize: 'rem',
      space: 'rem',
      size: 'rem',
      breakpoint: 'rem',
      tracking: 'em',
      leading: 'ratio',
      radius: 'px',
      border: 'px',
      nudge: 'px',
    });
  });

  it('refuses a length in the wrong class', () => {
    expect(() => assertUnitClass('fontSize', { row: px(13) })).toThrow(UnitClassError);
    expect(() => assertUnitClass('fontSize', { row: px(13) })).toThrow(
      'fontSize.row is 13px, but fontSize must be rem',
    );
    expect(() => assertUnitClass('radius', { key: rem(2) })).toThrow(UnitClassError);
    expect(() => assertUnitClass('tracking', { kick: rem(4) })).toThrow(UnitClassError);
    expect(() => assertUnitClass('leading', { body: px(20) })).toThrow(UnitClassError);
  });

  it('refuses non-finite and negative values, except negative tracking', () => {
    expect(() => assertUnitClass('space', { x: rem(Number.NaN) })).toThrow(/invalid value/);
    expect(() => assertUnitClass('size', { x: rem(-4) })).toThrow(/invalid value/);
    expect(assertUnitClass('tracking', { logo: em(-0.03) })).toEqual({ logo: em(-0.03) });
  });

  it('holds for every exported length', () => {
    const every = [
      ...Object.values(fontSize.admin),
      ...Object.values(fontSize.skater),
      ...Object.values(size.admin),
      ...Object.values(size.skater),
      ...Object.values(gap.admin),
      ...Object.values(gap.skater),
      ...Object.values(space),
    ];
    expect(every.every((l) => l.unit === 'rem')).toBe(true);
  });
});

describe('the spacing ruler', () => {
  it('is n × 0.25rem, which is Tailwind v4 default `--spacing` arithmetic', () => {
    for (const [key, length] of Object.entries(space)) {
      expect(length.value, key).toBeCloseTo(Number(key.replace('_', '.')) * 0.25, 10);
    }
  });
});
