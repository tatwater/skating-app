import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LANE_DRESSES, type LaneDress } from './lane-dress';
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

describe('Lanes — a group’s dress, tail and foot', () => {
  const pass = (dress?: LaneDress) => ({
    label: 'Pre-Season Pass',
    dress,
    tail: <span>Due</span>,
    foot: <span>3 of 10 decided</span>,
    lanes: [{ id: 'recurrence', label: 'Recurrence', count: 7 }],
  });
  const plain = { label: 'Tasks', lanes: [{ id: 'duplicates', label: 'Duplicates', count: 283 }] };

  it('leaves a plain sidebar as it was: no dress, no group foot, the column’s own top', () => {
    const { container } = render(<Lanes label="Corpus" groups={[plain]} />);
    const nav = screen.getByRole('navigation', { name: 'Corpus' });
    expect(container.querySelector('[data-dress]')).toBeNull();
    expect(container.querySelector('[data-slot="lanes-group-foot"]')).toBeNull();
    expect(container.querySelector('[data-slot="lanes-kicker-tail"]')).toBeNull();
    expect(nav.className).toContain('pt-(--space-3_5)');
  });

  it.each(Object.keys(LANE_DRESSES) as LaneDress[])(
    'dresses the %s group alone, its list named by the kicker and never the tail',
    (dress) => {
      render(<Lanes label="Corpus" groups={[pass(dress), plain]} />);
      const nav = screen.getByRole('navigation', { name: 'Corpus' });
      const dressed = nav.querySelectorAll('[data-dress]');
      expect(dressed).toHaveLength(1);
      expect(dressed[0]?.getAttribute('data-dress')).toBe(dress);
      // The list is the kicker's; the badge beside it is not part of its name.
      const list = screen.getByRole('list', { name: 'Pre-Season Pass' });
      expect(within(list).getByRole('button', { name: /Recurrence/ })).toBeTruthy();
      expect(within(dressed[0] as HTMLElement).getByText('Due')).toBeTruthy();
      // The foot is the group's, after its lanes and inside its dress.
      const foot = (dressed[0] as HTMLElement).querySelector('[data-slot="lanes-group-foot"]');
      expect(foot?.textContent).toBe('3 of 10 decided');
      expect(list.compareDocumentPosition(foot as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      // Leading the column, the dress sets the column's top.
      expect(nav.className).toContain(LANE_DRESSES[dress].lead);
    },
  );

  it('steps a dressed group that follows another down by a kicker’s step', () => {
    render(<Lanes label="Corpus" groups={[plain, pass('inverted')]} />);
    const nav = screen.getByRole('navigation', { name: 'Corpus' });
    expect(nav.querySelector('[data-dress="inverted"]')?.className).toContain('mt-(--space-3)');
    // Only a leading dress sets the column's top.
    expect(nav.className).toContain('pt-(--space-3_5)');
  });

  it('keys across a dressed group like any other', () => {
    render(<Lanes label="Corpus" groups={[pass('edge'), plain]} selected="recurrence" />);
    const rows = screen.getAllByRole('button');
    expect(rows.filter((r) => r.tabIndex === 0).map((r) => r.textContent)).toEqual(['Recurrence7']);
  });
});
