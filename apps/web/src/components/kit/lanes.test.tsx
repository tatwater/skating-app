import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { LANE_DRESSES } from './lane-dress';
import { type LaneGroup, Lanes } from './lanes';

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

const PASS_LANES = [
  { id: 'recurrence', label: 'Recurrence', count: 7 },
  { id: 'features', label: 'Known features', count: 12 },
];
const TASKS: LaneGroup = {
  label: 'Tasks',
  lanes: [{ id: 'duplicates', label: 'Duplicates', count: 283 }],
};
const stops = () =>
  screen
    .getAllByRole('button')
    .filter((r) => r.tabIndex === 0)
    .map((r) => r.textContent);

describe('Lanes — a group’s dress and foot', () => {
  const card: LaneGroup = {
    label: 'Pre-Season Pass',
    dress: 'bracketed',
    foot: <span>3 of 10 decided</span>,
    lanes: PASS_LANES,
  };

  it('leaves a plain sidebar as it was: no dress, no group foot, the column’s own top', () => {
    const { container } = render(<Lanes label="Corpus" groups={[TASKS]} />);
    const nav = screen.getByRole('navigation', { name: 'Corpus' });
    expect(container.querySelector('[data-dress], [data-collapsible]')).toBeNull();
    expect(container.querySelector('[data-slot="lanes-group-foot"]')).toBeNull();
    expect(nav.className).toContain('pt-(--space-3_5)');
  });

  it('dresses the card alone, its foot after its lanes, and sets the column’s top when it leads', () => {
    render(<Lanes label="Corpus" groups={[card, TASKS]} />);
    const nav = screen.getByRole('navigation', { name: 'Corpus' });
    const dressed = nav.querySelectorAll('[data-dress]');
    expect(dressed).toHaveLength(1);
    expect(dressed[0]?.getAttribute('data-dress')).toBe('bracketed');
    expect(dressed[0]?.getAttribute('data-slot')).toBe('lanes-group');
    const list = screen.getByRole('list', { name: 'Pre-Season Pass' });
    const foot = (dressed[0] as HTMLElement).querySelector('[data-slot="lanes-group-foot"]');
    expect(foot?.textContent).toBe('3 of 10 decided');
    expect(list.compareDocumentPosition(foot as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(nav.className).toContain(LANE_DRESSES.bracketed.lead);
  });

  it('steps a card that follows another group down by a kicker’s step', () => {
    render(<Lanes label="Corpus" groups={[TASKS, card]} />);
    const nav = screen.getByRole('navigation', { name: 'Corpus' });
    expect(nav.querySelector('[data-dress]')?.className).toContain('mt-(--space-3)');
    expect(nav.className).toContain('pt-(--space-3_5)');
  });
});

describe('Lanes — a collapsible group', () => {
  /** A route holding the group's open state and the chosen lane. */
  function Route({
    open: initial = false,
    selected: chosen,
  }: {
    open?: boolean;
    selected?: string;
  }) {
    const [open, setOpen] = useState(initial);
    const [selected, setSelected] = useState(chosen);
    return (
      <Lanes
        label="Corpus"
        selected={selected}
        onSelect={setSelected}
        groups={[
          {
            label: 'Pre-Season Pass',
            lanes: PASS_LANES,
            collapsible: { open, onOpenChange: setOpen, summary: 'Done 14 Sep' },
          },
          TASKS,
        ]}
      />
    );
  }
  const line = () => screen.getByRole('button', { name: /Pre-Season Pass/ });

  it('folds to one line — its kicker and its word — that says it is closed, its lanes gone', () => {
    render(<Route selected="duplicates" />);
    expect(line()).toHaveAttribute('aria-expanded', 'false');
    expect(line().textContent).toBe('Pre-Season PassDone 14 Sep');
    expect(screen.queryByRole('button', { name: /Recurrence/ })).toBeNull();
    expect(screen.getByRole('navigation').className).toContain('pt-[calc(var(--space-3_5)-');
  });

  it('opens to a plain list named by its kicker, and asks the caller to close it again', () => {
    const onOpenChange = vi.fn();
    render(
      <Lanes
        label="Corpus"
        groups={[
          {
            label: 'Pre-Season Pass',
            lanes: PASS_LANES,
            collapsible: { open: true, onOpenChange, summary: 'Done 14 Sep' },
          },
        ]}
      />,
    );
    expect(line()).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('list', { name: 'Pre-Season Pass' });
    expect(within(list).getAllByRole('button')).toHaveLength(2);
    fireEvent.click(line());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('puts its line in the keyboard’s run, and its lanes only while open', () => {
    render(<Route selected="duplicates" />);
    const duplicates = screen.getByRole('button', { name: /Duplicates/ });
    duplicates.focus();
    fireEvent.keyDown(duplicates, { key: 'ArrowUp' });
    expect(line()).toHaveFocus();
    fireEvent.keyDown(line(), { key: 'ArrowDown' });
    expect(duplicates).toHaveFocus();
    // Type-ahead finds the line by its kicker (a folded lane's letter finds nothing: the story).
    fireEvent.keyDown(duplicates, { key: 'p' });
    expect(line()).toHaveFocus();
    fireEvent.click(line());
    fireEvent.keyDown(line(), { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: /Recurrence/ })).toHaveFocus();
  });

  it('never hides the chosen lane: a closed line holding it says so, and is the tab stop', () => {
    render(<Route selected="recurrence" />);
    expect(line()).toHaveAttribute('data-holds-selected');
    expect(line().textContent).toBe('Pre-Season PassRecurrence');
    expect(stops()).toEqual(['Pre-Season PassRecurrence']);
    fireEvent.click(line());
    expect(line()).not.toHaveAttribute('data-holds-selected');
    expect(line().textContent).toBe('Pre-Season PassDone 14 Sep');
    expect(screen.getByRole('button', { name: /Recurrence/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(stops()).toEqual(['Recurrence7']);
  });
});
