import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Lanes } from './lanes';

describe('Lanes — a count’s ink', () => {
  it('keeps an amber or red count’s meaning on the chosen lane, and lights only a quiet one', () => {
    const groups = [
      {
        lanes: [
          { id: 'suspended', label: 'Suspended', count: 1, countTone: 'warn' as const },
          { id: 'failed', label: 'Failed', count: 2, countTone: 'bad' as const },
          { id: 'everyone', label: 'Everyone', count: 38 },
        ],
      },
    ];
    const tone = (name: string) =>
      within(screen.getByRole('button', { name: new RegExp(name) }))
        .getByText(/\d/)
        .getAttribute('data-tone');
    const { rerender } = render(<Lanes label="People" selected="suspended" groups={groups} />);
    expect(tone('Suspended')).toBe('warn');
    rerender(<Lanes label="People" selected="failed" groups={groups} />);
    expect(tone('Failed')).toBe('bad');
    rerender(<Lanes label="People" selected="everyone" groups={groups} />);
    expect(tone('Everyone')).toBe('lit');
    expect(tone('Suspended')).toBe('warn');
  });
});
