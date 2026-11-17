import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LabelRows } from './label-rows';

/** Label rows (kit candidate): short facts down a label column, a list of terms. */

describe('LabelRows (kit candidate)', () => {
  it('is a list of terms, each label its term and what it says its definition, in order', () => {
    render(
      <LabelRows
        aria-label="If overturned"
        rows={[
          { label: 'Record', value: 'The decision comes off the record' },
          {
            label: 'Erased',
            value: (
              <>
                Sun 25 Oct · <b>30 days</b> after it was deleted
              </>
            ),
          },
        ]}
      />,
    );
    const list = document.querySelector('[data-slot="label-rows"]') as HTMLElement;
    expect(list.tagName).toBe('DL');
    expect(list).toHaveAttribute('aria-label', 'If overturned');
    expect(screen.getAllByRole('term').map((t) => t.textContent)).toEqual(['Record', 'Erased']);
    expect(screen.getAllByRole('definition').map((d) => d.textContent)).toEqual([
      'The decision comes off the record',
      'Sun 25 Oct · 30 days after it was deleted',
    ]);
    expect(document.querySelectorAll('[data-slot="label-row"]')).toHaveLength(2);
  });

  it('keeps a class it is given beside its own', () => {
    render(<LabelRows rows={[]} className="mt-4" />);
    const list = document.querySelector('[data-slot="label-rows"]') as HTMLElement;
    expect(list).toHaveClass('mt-4', 'flex');
    expect(list.childElementCount).toBe(0);
  });
});
