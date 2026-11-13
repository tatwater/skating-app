import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { must } from '@/components/kit/storyKit';
import { BOARD_NOW_NH } from '../../../test/boardNow';
import { HistoryPanelView } from './HistoryPanel';
import { HISTORY_ROWS } from './historyFixtures';

const onUndo = fn();

const meta = {
  title: 'Admin/Shell/History',
  component: HistoryPanelView,
  tags: ['autodocs'],
  globals: { surface: 'admin' },
  parameters: {
    docs: {
      description: {
        component:
          'The audit trail of one thing, or of everything, newest first (D226). Each row says what was done from the operator’s side, when, and who — a person, or System — and offers Undo only where the server does. A row someone undid says who; a row something changed since jumps to the row that did. Times are pinned to the boards’ Saturday.',
      },
    },
  },
  args: {
    rows: HISTORY_ROWS,
    now: BOARD_NOW_NH,
    timeZone: 'America/New_York',
    onUndo,
    className: 'w-[30rem]',
  },
  beforeEach: () => onUndo.mockClear(),
} satisfies Meta<typeof HistoryPanelView>;

export default meta;
type Story = StoryObj<typeof meta>;

const rowOf = (root: HTMLElement, text: string) =>
  must(within(root).getByText(text).closest<HTMLElement>('li'));

/** Every way a row ends: Undo, undone, changed since, and the machines' rows that have none. */
export const Trail: Story = {
  play: async ({ canvasElement }) => {
    const rows = within(canvasElement).getAllByRole('listitem');
    await expect(rows).toHaveLength(HISTORY_ROWS.length);
    await expect(rows[0]).toHaveTextContent('11:41');
    await expect(rows[2]).toHaveTextContent('Fri');
    await expect(rows[7]).toHaveTextContent('3 Oct');
    await userEvent.click(
      within(rowOf(canvasElement, 'Hid a report')).getByRole('button', { name: 'Undo' }),
    );
    await expect(onUndo).toHaveBeenCalledWith(HISTORY_ROWS[0]);
    // Whoever acted sits on its own line under what was done, never after a "·".
    const first = rowOf(canvasElement, 'Hid a report');
    const what = must(first.querySelector('[data-slot="history-what"] > span'));
    const who = must(first.querySelector('[data-slot="history-who"]'));
    await expect(who.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      what.getBoundingClientRect().bottom - 1,
    );
  },
};

/** "Changed since" takes the reader to the row that changed it. */
export const ChangedSince: Story = {
  play: async ({ canvasElement }) => {
    const since = within(rowOf(canvasElement, 'Set the curated boost')).getByRole('button', {
      name: /Changed since/,
    });
    await userEvent.click(since);
    await waitFor(() => expect(rowOf(canvasElement, 'Renamed a body')).toHaveFocus());
  },
};

/** Loading holds the section; nothing is invented while the trail comes. */
export const Loading: Story = {
  args: { rows: undefined },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('region', { name: 'History' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  },
};

/** An empty trail still says what it is: its count, 0. */
export const Empty: Story = {
  args: { rows: [] },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('0')).toBeVisible();
  },
};

/** The trail in all four maps. */
export const FourUp: Story = {
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      await expect(within(q).getAllByRole('button', { name: 'Undo' })).toHaveLength(4);
    }
  },
};
