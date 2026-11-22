import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { Toolbar } from '@/components/kit/toolbar';

import { ROB } from '../../people/person/personFixtures';
import { UndoProvider } from '../../shell/undo';

/**
 * The author menu across the page's minute tick (finding 1): the People read must not be re-keyed on
 * the clock, and an open dialog must keep what was typed through any re-read.
 */

const state: { answer: unknown; asked: unknown[] } = { answer: ROB, asked: [] };
vi.mock('convex/react', () => ({
  useQuery: (_ref: unknown, args: unknown) => {
    state.asked.push(args);
    return state.answer;
  },
  useMutation: () => vi.fn(async () => null),
  useConvex: () => ({}),
}));

const { AuthorMenu } = await import('./AuthorMenu');

const MINUTE = 60_000;
const NOW = new Date(2026, 9, 14, 12).getTime();

beforeEach(() => {
  state.answer = ROB;
  state.asked = [];
});
afterEach(() => vi.useRealTimers());

function Menu({ now }: { now: number }) {
  return (
    <UndoProvider server={{ latestOwn: async () => null, run: async () => {} }}>
      <Toolbar aria-label="Flag actions">
        <AuthorMenu userId={ROB.userId} name="Rob Tremblay" now={now} />
      </Toolbar>
    </UndoProvider>
  );
}

test('the read keeps its clock across the minute tick', () => {
  const { rerender } = render(<Menu now={NOW} />);
  rerender(<Menu now={NOW + MINUTE} />);
  rerender(<Menu now={NOW + 2 * MINUTE} />);
  const keys = new Set(state.asked.map((a) => JSON.stringify(a)));
  expect(keys.size).toBe(1);
});

test('the suspend dialog keeps a typed reason through a re-read that answers nothing yet', async () => {
  const { rerender } = render(<Menu now={NOW} />);
  fireEvent.click(screen.getByRole('button', { name: /Rob Tremblay/ }));
  // Rob is suspended: the suspension row's Extend opens the suspend dialog.
  const lever = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-lever="suspend"]');
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  fireEvent.click(lever);
  const field = await screen.findByRole('textbox');
  fireEvent.change(field, { target: { value: 'A second unsafe report' } });
  // A re-read in flight: Convex answers `undefined` until it lands.
  state.answer = undefined;
  act(() => rerender(<Menu now={NOW + MINUTE} />));
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('A second unsafe report'));
});
