import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ItemTimeline } from './item-timeline';

describe('ItemTimeline', () => {
  it('lists the events in order, each mark by meaning, the line under all but the last', () => {
    const { container } = render(
      <ItemTimeline
        events={[
          { key: 'a', date: '13 Oct', mark: 'bad', children: 'A claim' },
          { key: 'b', date: '12 Sep', mark: 'bright', children: 'The ruling' },
          { key: 'c', date: '6 Sep', mark: 'quiet', children: 'Past claims' },
        ]}
      />,
    );
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '13 OctA claim',
      '12 SepThe ruling',
      '6 SepPast claims',
    ]);
    const marks = [...container.querySelectorAll('[data-slot="item-timeline-mark"]')].map(
      (m) => m.className,
    );
    expect(marks[0]).toContain('bg-bad');
    expect(marks[1]).toContain('bg-fg');
    expect(marks[2]).toContain('bg-line2');
    expect(container.querySelectorAll('[data-slot="item-timeline-line"]')).toHaveLength(2);
  });

  it('draws one event with no line', () => {
    const { container } = render(
      <ItemTimeline events={[{ key: 'a', date: '1 Oct', mark: 'bad', children: 'x' }]} />,
    );
    expect(container.querySelector('[data-slot="item-timeline-line"]')).toBeNull();
  });
});
