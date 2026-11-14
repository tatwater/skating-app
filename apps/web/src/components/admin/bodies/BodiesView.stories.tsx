import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { faceLoaded, must } from '@/components/kit/storyKit';

import { resetScrollMemory } from './BodiesTable';
import { BodiesBoard, type BodiesBoardProps } from './bodiesBoard';
import { UNREAD_LIST } from './bodiesData';
import {
  LIST_ACTIVE,
  LIST_BIG,
  LIST_SEARCH,
  PREVIEW_MASCOMA,
  PREVIEW_MOREY,
} from './bodiesFixtures';
import { queryOf } from './bodiesSearch';

/**
 * Boards 5.1–5.3: the Bodies library in the console's frame, at the boards' 1440 × 1040, on the
 * pinned clock. Render one beside its board to compare.
 */
const meta = {
  title: 'Admin/Bodies/Library',
  component: BodiesBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: {
    initialQuery: queryOf({ body: 'mascoma-lake' }),
    list: LIST_ACTIVE,
    previewFor: ((id) =>
      id === 'mascoma-lake'
        ? PREVIEW_MASCOMA
        : id === 'lake-morey'
          ? PREVIEW_MOREY
          : null) as BodiesBoardProps['previewFor'],
    onQueryChange: fn(),
    onOpenBody: fn(),
  },
  beforeEach: () => resetScrollMemory(),
} satisfies Meta<typeof BodiesBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const slots = (root: ParentNode, name: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`),
];

/** Board 5.1 — Active, by reports this season; Mascoma open in the preview. */
export const Active: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await faceLoaded(slot(canvasElement, 'page-word'));
    await expect(slot(canvasElement, 'page-word')).toHaveTextContent('Active bodies');
    await expect(slot(canvasElement, 'bodies-kicker')).toHaveTextContent(
      '1,412 of 24,871 in the corpus',
    );
    // The lane is chosen, with its count.
    await expect(page.getByRole('button', { name: /^Active/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    // Reports is the lit heading, biggest first.
    await expect(page.getByRole('columnheader', { name: /Reports/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    // Mascoma's row is the chosen one, its waiting asks in amber.
    const grid = page.getByRole('grid', { name: 'Active bodies' });
    const chosen = must(grid.querySelector<HTMLElement>('[aria-selected="true"]'));
    await expect(chosen).toHaveTextContent('Mascoma Lake');
    const asks = slot(chosen, 'body-asks');
    await expect(getComputedStyle(asks).color).toEqual(
      sameColor(computedColor(asks, 'var(--warn)')),
    );
    // The preview: lockup, figures, completeness 9 / 10, three asks, the history.
    const preview = slot(canvasElement, 'body-preview');
    await expect(within(preview).getByRole('heading', { name: 'Mascoma Lake' })).toBeVisible();
    await expect(within(preview).getByRole('meter', { name: 'Complete' })).toHaveAttribute(
      'aria-valuenow',
      '9',
    );
    await expect(slots(preview, 'history-row')).toHaveLength(7);
  },
};

/**
 * Board 5.2 — one facet applied (1,000 ac and up), its chip under the facet row, and the Filter
 * menu open with *Reported this season* focused.
 */
export const Filter: Story = {
  args: { initialQuery: queryOf({ body: 'mascoma-lake', size: '1000-up' }), list: LIST_BIG },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await faceLoaded(slot(canvasElement, 'page-word'));
    await expect(slot(canvasElement, 'bodies-kicker')).toHaveTextContent(
      '187 of 1,412 active · 1,000 ac and up',
    );
    await expect(slot(canvasElement, 'filter-count')).toHaveTextContent('1');
    await expect(page.getByRole('button', { name: 'Remove Size: 1,000 ac and up' })).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: /Filter/ }));
    const menu = await within(document.body).findByRole('dialog', { name: 'Filter' });
    // Focus starts on the applied option; ↓ ×3 reaches Reports; Space would apply.
    await waitFor(() => expect(document.activeElement).toHaveTextContent('1,000 and up'));
    for (let i = 0; i < 3; i++) await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() => expect(document.activeElement).toHaveTextContent('Reported this season'));
    const current = must(menu.querySelector<HTMLElement>('[data-current]'));
    await expect(current).toHaveTextContent('Reports');
  },
};

/** Board 5.3 — "mor" typed: matches here first, then the dormant ones under their divider. */
export const Search: Story = {
  args: { initialQuery: queryOf({ body: 'lake-morey', q: 'mor' }), list: LIST_SEARCH },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await faceLoaded(slot(canvasElement, 'page-word'));
    await expect(page.getByRole('searchbox', { name: 'Find a body' })).toHaveValue('mor');
    await expect(slot(canvasElement, 'search-tally')).toHaveTextContent('2 active · 4 dormant');
    // No heading is lit: the search ranks the list.
    for (const head of page.getAllByRole('columnheader')) {
      await expect(head).not.toHaveAttribute('aria-sort', 'ascending');
      await expect(head).not.toHaveAttribute('aria-sort', 'descending');
    }
    await expect(slot(canvasElement, 'table-group-row')).toHaveTextContent('Dormant4');
    const marks = slots(canvasElement, 'search-mark').map((m) => m.textContent);
    await expect(marks).toEqual(['Mor', 'Mor', 'Mor', 'Mor', 'Mor', 'Mor']);
    await expect(within(page.getByRole('grid')).getByText('Dormant · moderator')).toBeVisible();
  },
};

/** Board 5.1 in the console's light map. */
export const ActiveLight: Story = {
  globals: { surface: 'admin', mode: 'light' },
  play: async ({ canvasElement }) => {
    await faceLoaded(slot(canvasElement, 'page-word'));
    const word = slot(canvasElement, 'page-word');
    await expect(getComputedStyle(word).color).toEqual(sameColor(computedColor(word, 'var(--fg)')));
  },
};

/** Board 5.1 in all four maps. */
export const ActiveFourUp: Story = {
  name: 'Active, four-up',
  parameters: { fourUp: true },
};

/**
 * The keyboard: Tab from the search reaches the rows; ↓ moves the cursor, ⏎ opens it and moves
 * focus into the preview, ⇧⏎ comes back; typing jumps by name.
 */
export const Keyboard: Story = {
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    const grid = page.getByRole('grid', { name: 'Active bodies' });
    grid.focus();
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(grid.getAttribute('aria-activedescendant')).toMatch(/crystal-lake$/),
    );
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(args.onQueryChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ bodyId: 'crystal-lake' }),
        { replace: true },
      ),
    );
    const inspector = must(canvasElement.querySelector<HTMLElement>('[data-pane="inspector"]'));
    await waitFor(() => expect(inspector).toHaveFocus());
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    await waitFor(() => expect(grid).toHaveFocus());
    // Type-ahead: "sq" jumps to Squam Lake.
    await userEvent.keyboard('sq');
    await waitFor(() => expect(grid.getAttribute('aria-activedescendant')).toMatch(/squam-lake$/));
  },
};

/** Nothing read yet: the list holds its rows' height with skeletons; the preview waits. */
export const Loading: Story = {
  args: {
    list: { ...UNREAD_LIST, status: 'loading' },
    previewFor: () => undefined,
    laneCounts: {},
  },
  play: async ({ canvasElement }) => {
    const grid = within(canvasElement).getByRole('grid');
    await expect(grid).toHaveAttribute('aria-busy', 'true');
    await expect(slot(canvasElement, 'preview-scroll')).toHaveAttribute('aria-busy', 'true');
  },
};

/** A lane no read serves yet: it says so, and no count, kicker or control pretends otherwise. */
export const NotRecorded: Story = {
  name: 'Not recorded yet',
  args: { list: UNREAD_LIST, previewFor: () => null, laneCounts: {} },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(slot(canvasElement, 'bodies-end')).toHaveTextContent('Not recorded yet');
    await expect(canvasElement.querySelector('[data-slot="bodies-kicker"]')).toBeNull();
    await expect(page.getByRole('button', { name: /Filter/ })).toBeDisabled();
    await expect(page.getByRole('searchbox', { name: 'Find a body' })).toBeDisabled();
    await expect(page.getByText('No body open')).toBeVisible();
  },
};
