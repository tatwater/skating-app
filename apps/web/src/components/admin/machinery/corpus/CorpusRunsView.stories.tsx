import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { expectNoSidewaysScroll, faceLoaded, must } from '@/components/kit/storyKit';

import { MachineryBoard } from './machineryBoard';
import { BOARD_ROWS, liveRow, REBUILT_FAILED, STALLED_CAMPAIGN } from './runListFixtures';

/**
 * Board 6.2 — Machinery › Corpus in the console's frame at 1440 × 900, on the board's clock: the
 * sidebar with Corpus alone under *Pipelines*, the run list newest first with its month dividers,
 * and the open run's column — the run pages mounted as the route mounts them, on the fixtures (their
 * own stories cover every state). Render one beside the board to compare.
 */
const meta = {
  title: 'Admin/Machinery/Corpus runs',
  component: MachineryBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: { rows: BOARD_ROWS, initialOpen: STALLED_CAMPAIGN.id },
} satisfies Meta<typeof MachineryBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const slots = (root: ParentNode, name: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`),
];

/** Board 6.2: the stalled campaign open. */
export const Board: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await faceLoaded(slot(canvasElement, 'page-word'));
    await expect(slot(canvasElement, 'page-word')).toHaveTextContent('Corpus');
    await expect(slot(canvasElement, 'runs-kicker')).toHaveTextContent('Runs · newest first');
    // The sidebar: Pipelines › Corpus alone, Local, its tail red.
    const nav = page.getByRole('navigation', { name: 'Machinery' });
    await expect(within(nav).getByRole('list', { name: 'Pipelines' })).toBeVisible();
    const corpus = within(nav).getByRole('button', { name: /^Corpus/ });
    await expect(corpus).toHaveAttribute('aria-current', 'true');
    await expect(corpus).toHaveTextContent('Local');
    await expect(corpus).toHaveTextContent('stalled');
    await expect(nav).not.toHaveTextContent(/Health|Cost ledger|Imagery|\$/);
    // The list: every row, its months, its end.
    const list = page.getByRole('listbox', { name: 'Corpus runs' });
    const rows = within(list).getAllByRole('option');
    await expect(rows).toHaveLength(BOARD_ROWS.length);
    await expect(slots(canvasElement, 'run-list-month').map((m) => m.textContent)).toEqual([
      'October',
      'September',
      'August',
      'July',
    ]);
    await expect(slot(canvasElement, 'run-list-end')).toHaveTextContent('All 10');
    const first = must(rows[0]);
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(slot(first, 'run-row-state')).toHaveTextContent('stalled');
    await expect(slot(first, 'run-row-kind')).toHaveTextContent('campaign');
    await expect(slot(first, 'run-row-sub')).toHaveTextContent(
      'Full canonical · 2 of 10 passes · load stalled',
    );
    await expect(slot(first, 'run-row-age')).toHaveTextContent('41 min');
    // Red means a person is needed: the stalled chip wears the bad ink.
    const bad = computedColor(canvasElement, 'var(--bad)');
    await expect(getComputedStyle(slot(first, 'run-row-state')).color).toEqual(sameColor(bad));
    // The rebuilt campaigns say so, and never read live.
    const rebuilt = rows.filter((r) => r.hasAttribute('data-rebuilt'));
    await expect(rebuilt).toHaveLength(2);
    for (const r of rebuilt)
      await expect(slot(r, 'run-row-sub')).toHaveTextContent(/^Rebuilt from its runs/);
    // The open campaign's column.
    const detail = must(canvasElement.querySelector<HTMLElement>('[data-pane="detail"]'));
    await expect(slot(detail, 'run-title')).toHaveTextContent('a07a-20261012');
    await expect(slot(detail, 'campaign-view')).toBeVisible();
  },
};

export const BoardLight: Story = { globals: { surface: 'admin', mode: 'light' } };

/** Four-up: both modes, both densities. */
export const FourUp: Story = { name: 'Four-up', parameters: { fourUp: true } };

/** Keys: ↓ moves the cursor, ⏎ opens the row and its column follows. */
export const Keys: Story = {
  args: { initialOpen: null },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const list = page.getByRole('listbox', { name: 'Corpus runs' });
    await userEvent.click(must(within(list).getAllByRole('option')[0]));
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await userEvent.keyboard('{Enter}');
    const third = must(within(list).getAllByRole('option')[2]);
    await waitFor(() => expect(third).toHaveAttribute('aria-selected', 'true'));
    const detail = must(canvasElement.querySelector<HTMLElement>('[data-pane="detail"]'));
    await waitFor(() => expect(slot(detail, 'run-title')).toHaveTextContent('load-landmarks'));
    // Type-ahead: "s" jumps to seed-standing.
    await userEvent.keyboard('s');
    await waitFor(() =>
      expect(list.getAttribute('aria-activedescendant')).toBe(
        must(within(list).getAllByRole('option')[4]).id,
      ),
    );
  },
};

/** Every live state's chip, and a rebuilt campaign that never reads live. */
export const States: Story = {
  args: {
    initialOpen: null,
    rows: [
      liveRow('running', 21),
      liveRow('late', 22),
      liveRow('stalled', 23),
      liveRow('waiting', 24),
      liveRow('notRecorded', 25),
      { ...STALLED_CAMPAIGN, id: liveRow('running', 26).id, marked: true, status: 'failed' },
      { ...REBUILT_FAILED, status: 'running' },
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(slots(canvasElement, 'run-row-state').map((c) => c.textContent)).toEqual([
      'running',
      'late',
      'stalled',
      'waiting',
      'no heartbeat',
      'failed',
      'not recorded',
    ]);
  },
};

/** Nothing open: the column says so. */
export const NothingOpen: Story = {
  args: { initialOpen: null },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-detail-none')).toHaveTextContent('No run open');
  },
};

/** Before the history is indexed: the list says older runs are on their way, and counts honestly. */
export const NotIndexed: Story = {
  args: { rows: [STALLED_CAMPAIGN], indexed: false },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-list-not-indexed')).toHaveTextContent(
      'Older runs appear once they’re indexed.',
    );
    await expect(slot(canvasElement, 'run-list-end')).toHaveTextContent('1 listed so far');
  },
};

/** …and with nothing listed yet: never an empty history. */
export const NotIndexedEmpty: Story = {
  args: { rows: [], indexed: false, initialOpen: null, tail: { state: 'never', at: null } },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-list-end')).toHaveTextContent('None listed yet');
    await expect(
      within(canvasElement).getByRole('navigation', { name: 'Machinery' }),
    ).toHaveTextContent('not run');
  },
};

export const Loading: Story = {
  args: { rows: [], status: 'loading', initialOpen: null },
  play: async ({ canvasElement }) => {
    await expect(slots(canvasElement, 'run-list-skeleton')).toHaveLength(5);
    await expect(canvasElement.querySelector('[data-slot="run-list-end"]')).toBeNull();
  },
};

/** More to come: the list asks on as it scrolls, and says so at its foot. */
export const MoreToCome: Story = {
  args: { status: 'more', initialOpen: null },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'run-list-end')).toHaveTextContent('Loading more');
  },
};

/** At 360 px: the lanes over the list, one pane at a time, nothing scrolling sideways. */
export const Phone: Story = {
  args: { initialOpen: null, className: 'h-[50rem] w-[22.5rem]' },
  play: async ({ canvasElement }) => {
    const page = slot(canvasElement, 'machinery-corpus-page');
    await waitFor(() => expect(page).toHaveAttribute('data-narrow', ''));
    await expectNoSidewaysScroll(page);
    await expect(
      must(canvasElement.querySelector<HTMLElement>('[data-pane="detail"]')),
    ).not.toBeVisible();
    // Opening a run gives it the page, with the way back.
    await userEvent.click(must(within(canvasElement).getAllByRole('option')[0]));
    const back = await within(canvasElement).findByRole('button', { name: 'Back to the list' });
    await expect(
      must(canvasElement.querySelector<HTMLElement>('[data-pane="middle"]')),
    ).not.toBeVisible();
    await userEvent.click(back);
    await waitFor(() =>
      expect(must(canvasElement.querySelector<HTMLElement>('[data-pane="middle"]'))).toBeVisible(),
    );
  },
};

export const PhoneLight: Story = {
  args: { initialOpen: STALLED_CAMPAIGN.id, className: 'h-[50rem] w-[22.5rem]' },
  globals: { surface: 'admin', mode: 'light' },
};
