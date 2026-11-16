import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LedStrip } from './trace-chart';

/**
 * **What the strip shows a pointer, it says to a reader.** The segments are drawn, not read (each is
 * `aria-hidden`); the strip is one meter whose value text carries every state a segment can show —
 * a part nobody can say about yet (`unknown`, drawn dashed) is said as such, never folded into the
 * parts that are off.
 */
describe('LedStrip, read without a pointer', () => {
  it('says how many of the whole are on', () => {
    render(<LedStrip aria-label="Complete" value={9} max={10} />);
    expect(screen.getByRole('meter', { name: 'Complete' })).toHaveAttribute(
      'aria-valuetext',
      '9 of 10',
    );
  });

  it('says the parts nobody can say about yet, apart from the parts that are off', () => {
    render(<LedStrip aria-label="Complete" segments={['on', 'unknown', 'off', 'unknown']} />);
    const meter = screen.getByRole('meter', { name: 'Complete' });
    expect(meter).toHaveAttribute('aria-valuetext', '1 of 4, 2 not recorded yet');
    // The drawing is the picture of that: one lit, two dashed, one dark.
    const states = [...meter.querySelectorAll('[data-slot="led-segment"]')].map(
      (s) => (s as HTMLElement).dataset.state,
    );
    expect(states).toEqual(['on', 'unknown', 'off', 'unknown']);
  });
});
