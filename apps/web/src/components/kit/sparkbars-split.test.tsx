import { cleanup, render } from '@testing-library/react';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Sparkbars, type SplitPart, splitDay } from './trace-chart';

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

/** What a drawn part says, read back off the DOM: its series, and what it is. */
function drawnOf(el: Element): Pick<SplitPart, 'series' | 'as'> & { mark?: string } {
  if (el.getAttribute('data-slot') === 'sparkbar-zero') {
    return { series: el.getAttribute('data-series') as SplitPart['series'], as: 'zero' };
  }
  const series = el.getAttribute('data-slot') === 'sparkbar-first' ? 'first' : 'second';
  const mark = el.getAttribute('data-mark') ?? '';
  if (mark === 'unrecorded') return { series, as: 'unrecorded' };
  if (mark === 'dashed') return { series, as: 'unsplit' };
  return { series, as: 'value', mark };
}

const cell = fc.oneof(fc.constant(null), fc.constant(0), fc.integer({ min: 1, max: 40 }));

/**
 * **The strip renders `splitDay`, part for part** — every day, both layouts, every combination of not
 * recorded, zero and a value: what the DOM draws is the rule the agreement property checks, in its
 * order (stacked bottom to top), each value part in its series' mark.
 */
describe('the strip draws what splitDay says', () => {
  const marks = { first: 'outline', second: 'solid' } as const;
  const property = fc.property(
    fc.integer({ min: 1, max: 8 }).chain((n) =>
      fc.record({
        first: fc.array(cell, { minLength: n, maxLength: n }),
        second: fc.array(cell, { minLength: n, maxLength: n }),
        layout: fc.constantFrom('beside' as const, 'stack' as const),
      }),
    ),
    ({ first, second, layout }) => {
      const { container } = render(
        <Sparkbars
          aria-label="Two series"
          values={first}
          split={{ values: second, layout, marks }}
        />,
      );
      const days = [...container.querySelectorAll(':scope [data-slot="sparkbar"]')];
      expect(days).toHaveLength(first.length);
      days.forEach((day, i) => {
        const want = splitDay(first[i] ?? null, second[i] ?? null, layout).map((p) => ({
          series: p.series,
          as: p.as,
          ...(p.as === 'value' && { mark: marks[p.series] }),
        }));
        const drawn =
          layout === 'beside'
            ? [...day.children].map((half) => drawnOf(half.children[0] as Element))
            : [...day.children].reverse().map(drawnOf);
        expect(drawn).toEqual(want);
      });
      cleanup();
    },
  );

  it('pinned seeds and one random', () => {
    for (const seed of [20261117, 150]) fc.assert(property, { seed, numRuns: 100 });
    fc.assert(property, { numRuns: 100 });
  });
});
