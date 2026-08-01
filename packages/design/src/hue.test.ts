import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hueDistance, hueOf, MAX_HUE_DISTANCE } from './hue';

describe('hueOf', () => {
  it('places the primaries and secondaries on the wheel', () => {
    expect(hueOf('#ff0000')).toBeCloseTo(0);
    expect(hueOf('#ffff00')).toBeCloseTo(60);
    expect(hueOf('#00ff00')).toBeCloseTo(120);
    expect(hueOf('#00ffff')).toBeCloseTo(180);
    expect(hueOf('#0000ff')).toBeCloseTo(240);
    expect(hueOf('#ff00ff')).toBeCloseTo(300);
  });

  it('ignores lightness — a ramp within one hue reports one hue', () => {
    // The whole point for D82: the contour ramp varies in nothing but lightness, so a measure that
    // moved with lightness would answer a different question than "could this be a severity scale?"
    // The pair is an exact 2× scale from a zero channel, which is what makes it the *same* hue
    // rather than merely a similar-looking one.
    expect(hueOf('#00447f')).toBeCloseTo(hueOf('#0088fe') as number, 6);
  });

  it('reports no hue for greys, rather than reporting red', () => {
    // A neutral reported as 0° sits exactly on top of the danger colour and would fail a separation
    // check it should pass.
    expect(hueOf('#000000')).toBeUndefined();
    expect(hueOf('#808080')).toBeUndefined();
    expect(hueOf('#ffffff')).toBeUndefined();
  });

  it('stays inside [0, 360) for any colour', () => {
    fc.assert(
      fc.property(fc.nat({ max: 0xffffff }), (int) => {
        const hue = hueOf(`#${int.toString(16).padStart(6, '0')}`);
        if (hue === undefined) return true;
        return hue >= 0 && hue < 360;
      }),
    );
  });
});

describe('hueDistance', () => {
  it('is zero for the same hue at any lightness', () => {
    expect(hueDistance('#ff0000', '#ff0000')).toBe(0);
    expect(hueDistance('#0088fe', '#00447f')).toBeCloseTo(0, 6);
  });

  it('takes the short way round the wheel', () => {
    // 350° and 10° are 20° apart, not 340°. Getting this wrong would let a red-orange pass a check
    // against red.
    expect(hueDistance('#ff0000', '#00ff00')).toBeCloseTo(120);
    expect(hueDistance('#ff0000', '#0000ff')).toBeCloseTo(120);
    expect(hueDistance('#ff0000', '#00ffff')).toBeCloseTo(MAX_HUE_DISTANCE);
  });

  it('scores an achromatic colour as maximally separated', () => {
    // A grey cannot be mistaken for a red, which is the question this answers.
    expect(hueDistance('#808080', '#ff0000')).toBe(MAX_HUE_DISTANCE);
    expect(hueDistance('#ff0000', '#ffffff')).toBe(MAX_HUE_DISTANCE);
  });

  it('is symmetric and bounded, for any pair', () => {
    const hex = fc.nat({ max: 0xffffff }).map((n) => `#${n.toString(16).padStart(6, '0')}`);
    fc.assert(
      fc.property(hex, hex, (a, b) => {
        const forward = hueDistance(a, b);
        return forward === hueDistance(b, a) && forward >= 0 && forward <= MAX_HUE_DISTANCE;
      }),
    );
  });
});
