import { describe, expect, it } from 'vitest';

import { COLOR_TOLERANCE, colorDistance, colorsIn, sameColor } from './measure';

// The token `--bad` (#ff4a55), as Chromium computes it at rest and mid-transition.
const BAD = 'oklch(0.6713 0.2164 22.08)';

describe('colorDistance', () => {
  it.each([
    ['the same color in oklab (a finished transition, CI)', 'oklab(0.6713 0.200529 0.0813449)'],
    ['its sRGB hex, 8-bit', 'rgb(255, 74, 85)'],
    ['color(srgb …)', 'color(srgb 1 0.290196 0.333333)'],
    ['percent channels', 'oklch(67.13% 54.1% 22.08)'],
  ])('reads %s as the token', (_, form) => {
    expect(colorDistance(form, BAD)).toBeLessThanOrEqual(COLOR_TOLERANCE);
  });

  it.each([
    [
      'a third of the way from fg3 (a running transition, CI)',
      'oklab(0.628942 0.0692459 0.0280897)',
    ],
    ['the hover rule', 'oklch(0.6066 0 0)'],
    ['the warn amber', 'oklch(0.8 0.16 80)'],
  ])('tells %s apart from the token', (_, form) => {
    expect(colorDistance(form, BAD)).toBeGreaterThan(COLOR_TOLERANCE * 10);
  });

  it('matches achromatic oklch and oklab, `none` included', () => {
    expect(colorDistance('oklab(0.252 0 0)', 'oklch(0.252 0 0)')).toBe(0);
    expect(colorDistance('oklch(0.252 0 none)', 'oklch(0.252 0 0)')).toBe(0);
  });

  it('weighs alpha, in every syntax', () => {
    expect(colorDistance('rgba(255, 255, 255, 0.08)', 'oklch(1 0 0 / 0.08)')).toBeLessThan(
      COLOR_TOLERANCE,
    );
    expect(colorDistance('rgb(255 255 255 / 8%)', 'oklch(1 0 0 / 0.08)')).toBeLessThan(
      COLOR_TOLERANCE,
    );
    expect(colorDistance('oklch(1 0 0 / 0.05)', 'oklch(1 0 0 / 0.08)')).toBeCloseTo(0.03, 6);
  });

  it('treats any two fully transparent colors as the same paint', () => {
    expect(colorDistance('rgba(0, 0, 0, 0)', 'oklch(1 0 0 / 0)')).toBe(0);
    expect(colorDistance('rgba(0, 0, 0, 0)', 'oklch(1 0 0)')).toBe(1);
  });

  it('reads linear sRGB', () => {
    expect(colorDistance('color(srgb-linear 1 0 0)', 'rgb(255, 0, 0)')).toBeLessThan(1e-6);
  });

  it.each([
    ['a keyword', 'red'],
    ['a space it does not know', 'color(display-p3 1 0 0)'],
    ['a function it does not know', 'lab(50 20 20)'],
    ['a garbled channel', 'oklch(0.5 x 0)'],
  ])('throws on %s instead of comparing wrong', (_, form) => {
    expect(() => colorDistance(form, BAD)).toThrow();
  });

  it('names a detached element, which computes no style at all', () => {
    expect(() => colorDistance('', BAD)).toThrow(/not in the page/);
    // Whitespace is no color either, and the message shows what it was handed.
    expect(() => colorDistance(' ', BAD)).toThrow(/empty string \(" "\)/);
  });

  it('quotes an unreadable value, so it never prints as nothing', () => {
    expect(() => colorDistance('red', BAD)).toThrow('Not a computed color: "red"');
  });
});

describe('sameColor', () => {
  it('is an asymmetric matcher for toEqual, alone and in arrays', () => {
    expect('oklab(0.6713 0.200529 0.0813449)').toEqual(sameColor(BAD));
    expect(['rgb(255, 74, 85)', 'oklch(0.252 0 0)']).toEqual([
      sameColor(BAD),
      sameColor('oklab(0.252 0 0)'),
    ]);
    expect('oklch(0.6066 0 0)').not.toEqual(sameColor(BAD));
    expect(42).not.toEqual(sameColor(BAD));
  });

  it('prints as itself in a failure', () => {
    expect(String(sameColor(BAD))).toBe(`sameColor(${BAD})`);
    expect(sameColor(BAD).toAsymmetricMatcher()).toBe(`sameColor(${BAD})`);
  });

  it('names itself when the actual value is a detached element', () => {
    expect(() => expect('').toEqual(sameColor(BAD))).toThrow(
      `No computed color to compare with sameColor(${BAD}): the element is not in the page.`,
    );
  });

  it('rejects an expected value it cannot read, up front', () => {
    // (An unresolved token is the usual slip: resolve it with `computedColor` first.)
    expect(() => sameColor('var(--bad)')).toThrow(/can't read/);
    expect(() => sameColor('#ff4a55')).toThrow(/Not a computed color/);
  });

  it('names itself on any other unreadable actual — never a quiet mismatch', () => {
    // Whitespace, or a form it doesn't read: the comparison is named, then what it was handed.
    const named = new RegExp(
      `sameColor\\(${BAD.replace(/[()]/g, '\\$&')}\\) can't read the actual value`,
    );
    expect(() => expect(' ').toEqual(sameColor(BAD))).toThrow(named);
    expect(() => expect(' ').toEqual(sameColor(BAD))).toThrow(/empty string.*wait for the value/);
    expect(() => expect('red').toEqual(sameColor(BAD))).toThrow(/Not a computed color: "red"/);
    expect(() => sameColor('  ')).toThrow(/empty string/);
  });
});

describe('colorsIn', () => {
  it('lifts each color out of a shadow list', () => {
    expect(colorsIn('oklch(0.1 0 0) 0px 0px 0px 3px, rgba(0, 0, 0, 0.5) 0px 1px 0px 0px')).toEqual([
      'oklch(0.1 0 0)',
      'rgba(0, 0, 0, 0.5)',
    ]);
    expect(colorsIn('none')).toEqual([]);
  });
});
