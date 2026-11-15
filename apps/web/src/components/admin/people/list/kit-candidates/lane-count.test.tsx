import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Lanes } from '@/components/kit/lanes';

import { LaneCount } from './lane-count';

describe('LaneCount', () => {
  it('keeps its meaning’s ink when its lane is chosen, where the kit’s count is lit', () => {
    render(
      <Lanes
        label="People"
        selected="suspended"
        groups={[
          {
            lanes: [
              { id: 'suspended', label: 'Suspended', tail: <LaneCount tone="warn">1</LaneCount> },
              { id: 'staff', label: 'Staff', count: '3', countTone: 'warn' },
            ],
          },
        ]}
      />,
    );
    const chosen = screen.getByRole('button', { name: /Suspended/ });
    expect(within(chosen).getByText('1')).toHaveAttribute('data-tone', 'warn');
    expect(within(chosen).getByText('1')).toHaveClass('text-warn');
    // The kit's own count keeps its tone only while its lane isn't chosen.
    expect(within(screen.getByRole('button', { name: /Staff/ })).getByText('3')).toHaveAttribute(
      'data-tone',
      'warn',
    );
  });

  it('inks red for a failure', () => {
    render(<LaneCount tone="bad">2</LaneCount>);
    expect(screen.getByText('2')).toHaveClass('text-bad');
  });
});
