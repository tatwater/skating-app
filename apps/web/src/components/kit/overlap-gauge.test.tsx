import { render, screen } from '@testing-library/react';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { OverlapGauge, sharePercent } from './overlap-gauge';

/** The overlap gauge: the server's share as a floored whole percent, the threshold as drawn. */

describe('sharePercent', () => {
  it('floors to a whole percent, through float noise', () => {
    expect(sharePercent(0.92)).toBe(92);
    // 0.57 * 100 is 56.99999999999999 in floats; it still reads 57.
    expect(sharePercent(0.57)).toBe(57);
    expect(sharePercent(0.799)).toBe(79);
    expect(sharePercent(0.8)).toBe(80);
    expect(sharePercent(1)).toBe(100);
    expect(sharePercent(0)).toBe(0);
  });

  it('clamps out-of-range and non-finite shares', () => {
    expect(sharePercent(-0.2)).toBe(0);
    expect(sharePercent(1.4)).toBe(100);
    expect(sharePercent(Number.NaN)).toBe(0);
    expect(sharePercent(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('never claims more than the share, nor a whole percent less', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (share) => {
        const p = sharePercent(share);
        expect(Number.isInteger(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(100);
        // At most the share (to a millionth, the float noise it rounds away)…
        expect(p).toBeLessThanOrEqual(share * 100 + 1e-4);
        // …and never a whole percent short of it.
        expect(p).toBeGreaterThan(share * 100 - 1 - 1e-4);
      }),
      { numRuns: 1_000 },
    );
  });

  it('never reads at or past a threshold the share is a millionth or more short of', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99 }),
        fc.double({ min: 1e-6, max: 1, noNaN: true }),
        (thresholdPct, short) => {
          const share = Math.max(0, thresholdPct / 100 - short);
          expect(sharePercent(share)).toBeLessThan(thresholdPct);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

describe('OverlapGauge', () => {
  const gauge = (reached: boolean, share = 0.92) =>
    render(
      <OverlapGauge
        share={share}
        threshold={0.8}
        reached={reached}
        sub="Of the drawing is Caspian Lake"
        thresholdLabel="Merge suggested from 80 %"
      />,
    );

  it('is a meter named by its sub-line, valued at the floored percent', () => {
    gauge(true);
    const meter = screen.getByRole('meter', { name: 'Of the drawing is Caspian Lake' });
    expect(meter).toHaveAttribute('aria-valuenow', '92');
    expect(screen.getByText('92')).toBeInTheDocument();
    expect(screen.getByText('0 %')).toBeInTheDocument();
    expect(screen.getByText('100 %')).toBeInTheDocument();
  });

  it('puts the tick at the threshold and ends its label on it', () => {
    const { container } = gauge(true);
    const tick = container.querySelector<HTMLElement>('[data-slot="overlap-gauge-tick"]');
    expect(tick?.style.left).toBe('80%');
    const label = container.querySelector<HTMLElement>('[data-slot="overlap-gauge-threshold"]');
    // Its right edge on the tick: 20 % in from the end (floats: within a hair).
    expect(Number.parseFloat(label?.style.right ?? '')).toBeCloseTo(20, 6);
  });

  it('lights the threshold’s label only when the caller says it is reached', () => {
    const { container, unmount } = gauge(true);
    expect(
      container
        .querySelector('[data-slot="overlap-gauge-threshold"]')
        ?.hasAttribute('data-reached'),
    ).toBe(true);
    unmount();
    const below = gauge(false, 0.41);
    expect(
      below.container
        .querySelector('[data-slot="overlap-gauge-threshold"]')
        ?.hasAttribute('data-reached'),
    ).toBe(false);
  });
});
