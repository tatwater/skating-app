import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { CLASS_BOARD_ROWS, NAME_BOARD_ROWS } from '../corpusBoardFixtures';
import { CLASS_ROWS, NAME_DECIDED_ROW, NOW } from '../corpusFixtures';
import { TaskTable } from './TaskTable';

/**
 * A task lane's list on its own, at the list column's width: each lane loaded, empty, with the rows
 * whose facts no campaign recorded yet, and with the decided tail under a list that is all in.
 * Four-up: both surfaces, both modes.
 */
const meta = {
  title: 'Admin/Corpus/List',
  component: TaskTable,
  parameters: { layout: 'fullscreen', fourUp: true },
  args: {
    lane: 'nameConflicts',
    label: 'Name conflicts',
    list: { status: 'done', rows: NAME_BOARD_ROWS, pending: false },
    emptyWords: 'Nothing open',
    selectedId: NAME_BOARD_ROWS[1]?.taskId ?? null,
    q: '',
    now: NOW,
    onOpen: () => {},
  },
  decorators: [
    (Story) => (
      <div className="flex h-[36rem] w-(--size-list) flex-col">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskTable>;

export default meta;
type Story = StoryObj<typeof meta>;

const grids = (root: HTMLElement) => within(root).getAllByRole('grid');

export const NamesLoaded: Story = {
  play: async ({ canvasElement }) => {
    for (const grid of grids(canvasElement)) {
      await expect(within(grid).getAllByRole('row')).toHaveLength(NAME_BOARD_ROWS.length);
      await expect(within(grid).getByText('All 14')).toBeInTheDocument();
    }
  },
};

export const NamesSearched: Story = {
  args: { q: 'pond' },
  play: async ({ canvasElement }) => {
    const marks = canvasElement.querySelectorAll('[data-slot="corpus-task-grid"] mark');
    await expect(marks.length).toBeGreaterThan(0);
  },
};

/** The consequence lines a class row carries (board 4.3's third line), from the fixtures' rows. */
const consequenceLines = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('[data-slot="corpus-row-consequence"]')].map(
    (s) => s.textContent,
  );

export const ClassesLoaded: Story = {
  args: {
    lane: 'classConflicts',
    label: 'Class conflicts',
    list: { status: 'done', rows: CLASS_BOARD_ROWS, pending: false },
    selectedId: null,
  },
  play: async ({ canvasElement }) => {
    for (const grid of grids(canvasElement)) {
      // Board 4.3's third line where a choice has a consequence, and only there.
      // Errol, Rand Cove, Barnet, Groton, Lyme, Spruce Pond (named, but 3 ac: the board drew it
      // no line), Orford and Peacham.
      await expect(consequenceLines(grid)).toEqual([
        'Refused if a wetland',
        'Waits for a parent if a bay',
        ...Array.from({ length: 6 }, () => 'Refused if a wetland'),
      ]);
    }
  },
};

/**
 * The list at the boards' 420 px (the pane the console is widening to): each consequence a single
 * line under its town, and no row wider than the pane; the open row's line in the bright ink.
 */
export const ClassesAtTheBoardsWidth: Story = {
  args: {
    lane: 'classConflicts',
    label: 'Class conflicts',
    list: { status: 'done', rows: CLASS_BOARD_ROWS, pending: false },
    selectedId: CLASS_BOARD_ROWS[6]?.taskId ?? null,
  },
  decorators: [
    (Story) => (
      <div className="flex h-[36rem] w-[420px] flex-col">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    for (const grid of grids(canvasElement)) {
      const lines = [...grid.querySelectorAll<HTMLElement>('[data-slot="corpus-row-consequence"]')];
      await expect(lines).toHaveLength(8);
      for (const line of lines) {
        const lineHeight = Number.parseFloat(getComputedStyle(line).lineHeight);
        await expect(line.getBoundingClientRect().height).toBeLessThan(lineHeight * 1.5);
      }
      const scroller = grid.closest<HTMLElement>('[data-slot="corpus-task-scroll"]');
      await expect(scroller?.scrollWidth).toBeLessThanOrEqual(scroller?.clientWidth ?? 0);
      const open = grid.querySelector<HTMLElement>(
        '[aria-selected="true"] [data-slot="corpus-row-consequence"]',
      );
      await expect(open).toHaveTextContent('Refused if a wetland');
      await expect(getComputedStyle(open as HTMLElement).color).not.toBe(
        getComputedStyle(lines[0] as HTMLElement).color,
      );
    }
  },
};

export const ClassesNotRecorded: Story = {
  args: {
    lane: 'classConflicts',
    label: 'Class conflicts',
    list: { status: 'done', rows: CLASS_ROWS, pending: false },
    selectedId: null,
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByText('Not recorded')).toHaveLength(4);
  },
};

export const Empty: Story = {
  args: { list: { status: 'done', rows: [], pending: false }, selectedId: null },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByText('Nothing open')).toHaveLength(4);
  },
};

export const Loading: Story = {
  args: { list: { status: 'loading', rows: [], pending: false }, selectedId: null },
};

export const WithDecidedTail: Story = {
  args: {
    list: { status: 'done', rows: NAME_BOARD_ROWS.slice(0, 4), pending: false },
    tail: { title: 'Decided lately', rows: [NAME_DECIDED_ROW] },
    selectedId: null,
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByText('Decided lately')).toHaveLength(4);
    await expect(within(canvasElement).getAllByText('All 4')).toHaveLength(4);
  },
};

export const Failed: Story = {
  args: {
    list: { status: 'error', rows: [], pending: false },
    onRetry: () => {},
    selectedId: null,
  },
};
