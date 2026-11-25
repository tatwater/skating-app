import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { faceLoaded, must } from '@/components/kit/storyKit';

import { CorpusBoard, type CorpusBoardProps } from './corpusBoard';
import { CLASS_BOARD_ROWS, NAME_BOARD_ROWS } from './corpusBoardFixtures';
import { NAME_DECIDED_ROW, NOW } from './corpusFixtures';
import type { CorpusTaskItemView } from './corpusTypes';
import { GROTON } from './handlers/Classes/classesFixtures';
import { BASIN } from './handlers/Names/namesFixtures';
import type { TaskListData } from './list/TaskTable';
import { TASK_LANES } from './taskLanes';
import type { TaskQuery } from './taskSearch';

/**
 * Boards 4.2 and 4.3: a Corpus task lane in the console's frame at the boards' 1440 × 900, on the
 * pinned clock — the one sidebar, the lane's list as the board's table, and the open task in its
 * handler's inspector (its map a still). Render one beside its board to compare.
 */
const meta = {
  title: 'Admin/Corpus/Task lane',
  component: CorpusBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: {
    initialQuery: { lane: TASK_LANES.nameConflicts, tab: null, item: BASIN.taskId, q: '' },
    listFor: listOf,
    itemFor: itemOf,
    now: NOW,
  },
} satisfies Meta<typeof CorpusBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

function listOf(query: TaskQuery): TaskListData {
  const all = query.lane.task === 'nameConflicts' ? NAME_BOARD_ROWS : CLASS_BOARD_ROWS;
  const q = query.q.trim().toLowerCase();
  const rows = all.filter(
    (r) =>
      (query.tab === null || r.facet === query.tab) &&
      (q === '' || JSON.stringify(r).toLowerCase().includes(q)),
  );
  return { status: 'done', rows, pending: false };
}

function itemOf(id: string): CorpusTaskItemView | null {
  if (id === BASIN.taskId) return BASIN as CorpusTaskItemView;
  if (id === GROTON.taskId) return GROTON as CorpusTaskItemView;
  return null;
}

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));

const CLASSES: Partial<CorpusBoardProps> = {
  initialQuery: { lane: TASK_LANES.classConflicts, tab: null, item: GROTON.taskId, q: '' },
};

/** Board 4.2 — Name conflicts; *The Basin* open. */
export const NameConflicts: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await faceLoaded(slot(canvasElement, 'page-word'));
    await expect(slot(canvasElement, 'page-word')).toHaveTextContent('Name conflicts');
    await expect(slot(canvasElement, 'corpus-kicker')).toHaveTextContent('412 bodies');
    // The lane is chosen in the one sidebar, the Tasks group above the library's.
    await expect(page.getByRole('button', { name: /^Name conflicts/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    const grid = page.getByRole('grid', { name: 'Name conflicts' });
    await expect(within(grid).getAllByRole('row')).toHaveLength(NAME_BOARD_ROWS.length);
    const chosen = must(grid.querySelector<HTMLElement>('[aria-selected="true"]'));
    await expect(chosen).toHaveTextContent('The Basin');
    // A one-letter conflict marks the letter where its names part, in each.
    const elligo = must(
      [...grid.querySelectorAll<HTMLElement>('[role="row"]')].find((r) =>
        r.textContent?.includes('Little Elligo Pond'),
      ),
    );
    await expect(
      [...elligo.querySelectorAll('[data-slot="corpus-parting-letter"]')].map((m) => m.textContent),
    ).toEqual(['l', 'i']);
    // The search, with the board's hint.
    await expect(page.getByRole('searchbox', { name: 'Find a body' })).toHaveAttribute(
      'placeholder',
      'Find a body by either name',
    );
  },
};

/** Board 4.3 — Class conflicts; Groton's unnamed water open. */
export const ClassConflicts: Story = {
  args: CLASSES,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await faceLoaded(slot(canvasElement, 'page-word'));
    await expect(slot(canvasElement, 'corpus-what')).toHaveTextContent(
      'The catalogs disagree on the kind of water',
    );
    const grid = page.getByRole('grid', { name: 'Class conflicts' });
    const chosen = must(grid.querySelector<HTMLElement>('[aria-selected="true"]'));
    await expect(chosen).toHaveTextContent('Unnamed water');
    // Each catalog's tag in its own slot, before its class.
    await expect(
      [...chosen.querySelectorAll('[data-slot="corpus-row-tag"]')].map((t) => t.textContent),
    ).toEqual(['NHD', 'OSM']);
    await expect(chosen).toHaveTextContent('Wetland');
  },
};

/** A tab narrows the list to its facet. */
export const ClassConflictsTab: Story = {
  args: CLASSES,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await faceLoaded(slot(canvasElement, 'page-word'));
    await userEvent.click(page.getByRole('button', { name: 'Other pairs' }));
    const grid = page.getByRole('grid', { name: 'Class conflicts' });
    await expect(within(grid).getAllByRole('row')).toHaveLength(3);
  },
};

/** Board 4.2 in the light mode: the page word in the ink. */
export const NameConflictsLight: Story = {
  globals: { surface: 'admin', mode: 'light' },
  play: async ({ canvasElement }) => {
    await faceLoaded(slot(canvasElement, 'page-word'));
    const word = slot(canvasElement, 'page-word');
    await expect(getComputedStyle(word).color).toEqual(sameColor(computedColor(word, 'var(--fg)')));
  },
};

/** Board 4.3 in the light mode. */
export const ClassConflictsLight: Story = {
  args: CLASSES,
  globals: { surface: 'admin', mode: 'light' },
};

/** The decided tail under a list that is all in, the lock on a decided task. */
export const WithDecidedTail: Story = {
  args: {
    initialQuery: { lane: TASK_LANES.nameConflicts, tab: null, item: null, q: '' },
    tail: { rows: [NAME_DECIDED_ROW] },
  },
  play: async ({ canvasElement }) => {
    const grid = within(canvasElement).getByRole('grid', { name: 'Name conflicts' });
    await expect(within(grid).getByText('Decided lately')).toBeInTheDocument();
    await expect(slot(canvasElement, 'corpus-row-decision')).toHaveTextContent(
      'renamed · by Avery Lindqvist',
    );
  },
};

/** Both boards, wide, in all four maps. */
export const WideFourUp: Story = {
  name: 'Wide, four-up',
  parameters: { fourUp: true },
};

/** The tabs' row and the search's field, for the width checks below. */
async function expectListFits(root: HTMLElement) {
  const page = slot(root, 'corpus-task-page');
  await expect(page).not.toHaveAttribute('data-narrow');
  // The list is the boards' 420, whatever the page's width; the lanes the console's 236.
  const list = must(page.querySelector<HTMLElement>('[data-pane="middle"]'));
  const lanes = must(page.querySelector<HTMLElement>('[data-pane="lanes"]'));
  await expect(Math.round(list.getBoundingClientRect().width)).toBe(420);
  await expect(Math.round(lanes.getBoundingClientRect().width)).toBe(236);
  // Every tab on one row: one top among them.
  const tabs = within(slot(root, 'corpus-tools')).getAllByRole('button');
  const tops = new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top)));
  await expect(tops.size).toBe(1);
  // The search's hint is drawn whole: the field holds it without cutting.
  const search = within(root).getByRole('searchbox', { name: 'Find a body' }) as HTMLInputElement;
  const probe = document.createElement('span');
  const style = getComputedStyle(search);
  probe.style.font = style.font;
  probe.style.letterSpacing = style.letterSpacing;
  probe.style.position = 'absolute';
  probe.style.whiteSpace = 'pre';
  probe.textContent = search.placeholder;
  document.body.append(probe);
  const hint = probe.getBoundingClientRect().width;
  probe.remove();
  const room = search.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  await expect(hint).toBeLessThanOrEqual(room);
}

/** Board 4.3's columns at 1440 × 900: lanes 236, the list the boards' 420, the inspector the rest. */
export const ListWidth: Story = {
  args: CLASSES,
  play: async ({ canvasElement }) => {
    await faceLoaded(slot(canvasElement, 'page-word'));
    await expectListFits(canvasElement);
    const inspector = must(canvasElement.querySelector<HTMLElement>('[data-pane="detail"]'));
    await expect(Math.round(inspector.getBoundingClientRect().width)).toBe(720);
  },
};

/**
 * The narrowest page that keeps the three columns (`useColumnsFit`: 236 + 420 + the inspector's
 * 380): every tab still on one row, the hint whole, the inspector at its least.
 */
export const NarrowestColumns: Story = {
  args: { ...CLASSES, className: 'h-[56.25rem] w-[68.75rem]' },
  play: async ({ canvasElement }) => {
    await faceLoaded(slot(canvasElement, 'page-word'));
    await expectListFits(canvasElement);
    const inspector = must(canvasElement.querySelector<HTMLElement>('[data-pane="detail"]'));
    await expect(Math.round(inspector.getBoundingClientRect().width)).toBe(380);
  },
};

/** The same narrowest page on board 4.2: the name's head and its square map share 380. */
export const NamesNarrowestColumns: Story = {
  args: { className: 'h-[56.25rem] w-[68.75rem]' },
  play: async ({ canvasElement }) => {
    await faceLoaded(slot(canvasElement, 'page-word'));
    await expectListFits(canvasElement);
  },
};

/** One step narrower than that: the lanes over the list, the open task its own page. */
export const BelowTheColumns: Story = {
  args: { ...CLASSES, className: 'h-[56.25rem] w-[68.6875rem]' },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'corpus-task-page')).toHaveAttribute('data-narrow', '');
  },
};

/** Narrow: the open task takes the page, with Back to the list; four maps. */
export const NarrowFourUp: Story = {
  name: 'Narrow, four-up',
  parameters: { fourUp: true },
  args: { className: 'h-[56.25rem] w-[48rem]' },
  play: async ({ canvasElement }) => {
    const backs = within(canvasElement).getAllByRole('button', { name: 'Back to the list' });
    await expect(backs).toHaveLength(4);
  },
};

/** Narrow with nothing open: the lanes over the list. */
export const NarrowList: Story = {
  args: {
    className: 'h-[56.25rem] w-[48rem]',
    initialQuery: { lane: TASK_LANES.classConflicts, tab: null, item: null, q: '' },
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'corpus-task-page')).toHaveAttribute('data-narrow', '');
    await expect(within(canvasElement).queryByRole('button', { name: 'Back to the list' })).toBe(
      null,
    );
  },
};
