import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Sparkbars } from './trace-chart';

/**
 * Greptile on #150: a day whose first series isn't recorded hid its second, recorded one — the
 * strip said nothing where its hover said "Fulfilled 2".
 */
describe('a two-series strip draws each series on its own answer', () => {
  it('beside: a recorded second value draws though the first is not recorded', () => {
    const { container } = render(
      <Sparkbars
        aria-label="Bounties"
        values={[null]}
        split={{ values: [2], layout: 'beside', marks: { first: 'outline', second: 'solid' } }}
      />,
    );
    const day = container.querySelector('[data-slot="sparkbar"]');
    expect(day?.querySelector('[data-slot="sparkbar-second"]')).not.toBeNull();
    // The first half says it isn't recorded: never a zero, never absent.
    expect(day?.querySelector('[data-slot="sparkbar-first"]')?.getAttribute('data-mark')).toBe(
      'unrecorded',
    );
  });
});
