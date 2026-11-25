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

export const ClassesLoaded: Story = {
  args: {
    lane: 'classConflicts',
    label: 'Class conflicts',
    list: { status: 'done', rows: CLASS_BOARD_ROWS, pending: false },
    selectedId: null,
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
