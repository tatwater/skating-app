import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { expectControlsInside, expectNoSidewaysScroll, must } from '@/components/kit/storyKit';

import { InboxBoard } from './inboxBoard';
import { queryOf } from './inboxSearch';
import { resetInboxScroll } from './list/InboxList';
import {
  ACCESS_ITEM,
  ACCESS_ROW,
  ALL_OPEN_ROWS,
  decidedItem,
  decidedRow,
  MATT,
  PENDING_LANES,
  SAFETY_ITEM,
  SAFETY_ROW,
  SAFETY_TAIL,
  SARAH,
  TEAGAN,
  WITHDRAWN_ROW,
  ZERO_LANES,
  ZERO_TODAY,
} from './list/inboxFixtures';

/**
 * Boards 2.1–2.9: the Inbox in the console's frame, at the boards' 1440 × 900 on the pinned clock.
 * The inspector draws each item with its registered handler — the placeholder (facts, read only)
 * until a handler builder's lands. Render one beside its board to compare.
 */
const meta = {
  title: 'Admin/Inbox/Page',
  component: InboxBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: {
    initialQuery: queryOf({ lane: 'safety', item: SAFETY_ROW.itemId }, true),
    canReadSupport: true,
    list: { status: 'done', rows: [SAFETY_ROW], pending: false },
    tail: { rows: SAFETY_TAIL },
    items: { [SAFETY_ROW.itemId]: SAFETY_ITEM, [ACCESS_ROW.itemId]: ACCESS_ITEM },
    onQueryChange: fn(),
    onOpenItem: fn(),
    // The page's list, lanes and frame, not a handler: every story draws the placeholder, as written
    // (the handlers' own stories show each handler beside its board).
    registry: new Map(),
  },
  beforeEach: () => resetInboxScroll(),
} satisfies Meta<typeof InboxBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const inspector = (root: HTMLElement) =>
  must(root.querySelector<HTMLElement>('[data-slot="inbox-page"] > [data-pane="detail"]'));
const listbox = (root: HTMLElement) => within(root).getByRole('listbox');

/** Board 2.1 — Safety: one open, Sarah's flag on Rob's report open beside it, this week under it. */
export const Safety: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(slot(canvasElement, 'page-word')).toHaveTextContent('Safety');
    await expect(slot(canvasElement, 'inbox-kicker')).toHaveTextContent('1 open');
    // The lanes: All open 19, Safety chosen with its count red, Decided and Today quiet.
    const lanes = page.getByRole('navigation', { name: 'Inbox' });
    const safety = within(lanes).getByRole('button', { name: /^Safety/ });
    await expect(safety).toHaveAttribute('aria-current', 'true');
    await expect(within(lanes).getByRole('button', { name: /^All open/ })).toHaveTextContent('19');
    await expect(within(lanes).getByRole('button', { name: /^Decided/ })).toHaveTextContent(
      '1,118',
    );
    // The tabs carry no counts; the row draws as the board does; the end, then this week.
    const tabs = page.getByRole('group', { name: 'Kind' });
    await expect(tabs).toHaveTextContent(/^AllReportsHazardsPeople$/i);
    const row = must(page.getAllByRole('option')[0]);
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await expect(slot(row, 'inbox-row-chips')).toHaveTextContent(/unsafe\s*report/i);
    await expect(slot(row, 'inbox-row-sub')).toHaveTextContent(
      'Mascoma Lake · by Rob Tremblay · flagged by Sarah Berman',
    );
    await expect(slot(row, 'inbox-row-age')).toHaveTextContent('4 d');
    await expect(slot(canvasElement, 'inbox-end')).toHaveTextContent('All 1');
    await expect(slot(canvasElement, 'inbox-tail-head')).toHaveTextContent('Decided this week');
    // The status bar: Safety's open count in red, then today's decided.
    await expect(slot(document.body, 'inbox-status-safety')).toHaveTextContent('1 safety');
    await expect(slot(document.body, 'inbox-status-today')).toHaveTextContent('decided today · 3');
    // The rail carries what waits, amber.
    const rail = page.getByRole('navigation', { name: 'Modes' });
    await expect(within(rail).getByRole('link', { name: /Inbox/ })).toHaveTextContent('19');
    // The inspector: the item's facts, read only, no action bar until its handler lands.
    await expect(slot(inspector(canvasElement), 'inbox-placeholder-facts')).toHaveTextContent(
      'Dangerously false ice report',
    );
    await expect(inspector(canvasElement).querySelector('[data-slot="toolbar"]')).toBeNull();
  },
};

/** The same board in the light mode. */
export const SafetyLight: Story = {
  globals: { surface: 'admin', mode: 'light' },
};

/**
 * The keyboard path: Tab from the lanes reaches the list; ↓ moves, typing jumps, ⏎ opens and moves
 * focus into the inspector; ⇧⏎ comes back to the list, on the row it opened from.
 */
export const Keys: Story = {
  args: {
    initialQuery: queryOf({}, true),
    list: { status: 'done', rows: ALL_OPEN_ROWS, pending: false },
    tail: null,
  },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    const lane = page.getByRole('button', { name: /^All open/ });
    lane.focus();
    await waitFor(() => expect(lane).toHaveFocus());
    await userEvent.tab();
    // Past the tabs row (there's none for All open) the next stop is Filter, then the list.
    await waitFor(() => expect(page.getByRole('button', { name: /^Filter/ })).toHaveFocus());
    await userEvent.tab();
    await waitFor(() => expect(listbox(canvasElement)).toHaveFocus());
    // The first row takes the cursor; ↓ moves it; typing jumps to "Tomhannock…".
    await waitFor(() =>
      expect(listbox(canvasElement).getAttribute('aria-activedescendant')).toBe(
        page.getAllByRole('option')[0]?.id,
      ),
    );
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(listbox(canvasElement).getAttribute('aria-activedescendant')).toBe(
        page.getAllByRole('option')[1]?.id,
      ),
    );
    await userEvent.keyboard('{ArrowUp}');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(args.onOpenItem).toHaveBeenCalledWith(SAFETY_ROW.itemId, 'keys'));
    await waitFor(() => expect(inspector(canvasElement)).toHaveFocus());
    await waitFor(() =>
      expect(slot(inspector(canvasElement), 'inbox-placeholder-facts')).toBeInTheDocument(),
    );
    // A letter in the list never acts on an item; ⇧⏎ in the inspector goes back to the list.
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    await waitFor(() => expect(listbox(canvasElement)).toHaveFocus());
    await waitFor(() =>
      expect(listbox(canvasElement).getAttribute('aria-activedescendant')).toBe(
        page.getAllByRole('option')[0]?.id,
      ),
    );
    // Space opens too.
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard(' ');
    await waitFor(() => expect(args.onOpenItem).toHaveBeenCalledWith(ACCESS_ROW.itemId, 'keys'));
    await waitFor(() => expect(inspector(canvasElement)).toHaveFocus());
    // Esc comes back as well.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(listbox(canvasElement)).toHaveFocus());
  },
};

/** All open: every lane in the flow-through order, each lane's boundary drawn. */
export const AllOpen: Story = {
  args: {
    initialQuery: queryOf({}, true),
    list: { status: 'done', rows: ALL_OPEN_ROWS, pending: false },
    tail: null,
  },
  play: async ({ canvasElement }) => {
    const boundaries = [
      ...canvasElement.querySelectorAll<HTMLElement>('[data-slot="inbox-boundary"]'),
    ].map((b) => b.textContent);
    await expect(boundaries).toEqual([
      'Safety',
      'Access reports',
      'Requests',
      'Places asked',
      'Drawn bodies',
      'Content flags',
      'Support',
    ]);
    await expect(slot(canvasElement, 'inbox-kicker')).toHaveTextContent('19 open');
    // No tabs for All open: Filter alone.
    await expect(canvasElement.querySelector('[role="group"][aria-label="Kind"]')).toBeNull();
    await expect(slot(canvasElement, 'inbox-end')).toHaveTextContent('All 11');
    await expect(slot(canvasElement, 'inbox-nothing-open')).toHaveTextContent('Nothing open');
  },
};

/** Board 2.2's list — Access reports, the dispute open, the lane's week under it. */
export const AccessReports: Story = {
  args: {
    initialQuery: queryOf({ lane: 'accessReports', item: ACCESS_ROW.itemId }, true),
    list: { status: 'done', rows: [ACCESS_ROW], pending: false },
    tail: {
      rows: [
        decidedRow(ACCESS_ROW, TEAGAN, 3 * 86_400_000, 'ruled_accessible'),
        decidedRow(ACCESS_ROW, SARAH, 5 * 86_400_000, 'ruled_closed'),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const rows = within(canvasElement).getAllByRole('option');
    await expect(rows).toHaveLength(3);
    await expect(slot(must(rows[0]), 'inbox-row-chips')).toHaveTextContent(/disputes 12 Sep/i);
    await expect(must(rows[1])).toHaveAttribute('data-done', '');
    await expect(slot(must(rows[1]), 'inbox-row-chips')).toHaveTextContent(/confirmed accessible/i);
    await expect(slot(must(rows[1]), 'inbox-row-sub')).toHaveTextContent(
      'Tomhannock Reservoir · Teagan Atwater',
    );
  },
};

/** Board 2.9 — Inbox zero: nothing open, today's decisions under it, the day in the inspector. */
export const Zero: Story = {
  args: {
    lanes: ZERO_LANES,
    initialQuery: queryOf({}, true),
    list: { status: 'done', rows: [], pending: false },
    tail: { rows: [decidedRow(SAFETY_ROW, TEAGAN, 3 * 3_600_000, 'hidden')] },
    zero: { day: { kind: 'ready', today: ZERO_TODAY } },
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'inbox-kicker')).toHaveTextContent('0 open');
    await expect(slot(canvasElement, 'inbox-end')).toHaveTextContent('Nothing open');
    await expect(slot(canvasElement, 'inbox-tail-head')).toHaveTextContent('Decided today');
    await expect(canvasElement.querySelector('[data-slot="inbox-facets"]')).toBeNull();
    const zero = slot(canvasElement, 'inbox-zero');
    await expect(slot(zero, 'inbox-zero-word')).toHaveTextContent('Inbox zero');
    await expect(slot(zero, 'inbox-zero-line')).toHaveTextContent(
      'As of 12:00, 22 decided today, a median of 1.5 days from filing to decision.',
    );
    await expect(slot(zero, 'inbox-zero-by-lane')).toHaveTextContent(/Requests\s*8/);
    await waitFor(() =>
      expect(zero.querySelectorAll('[data-slot="step-rug-fall"]').length).toBe(22),
    );
    // Nothing waits: the rail draws no count.
    const rail = within(canvasElement).getByRole('navigation', { name: 'Modes' });
    await expect(within(rail).getByRole('link', { name: /Inbox/ }).textContent).not.toMatch(/\d/);
  },
};

/**
 * Inbox zero when the server can't tell how many were open as the day began (`openAtStart: null`:
 * the day's filings or decisions were capped): the page says so and draws no line from a figure
 * worked back from capped lists; the day's line and its lanes still read.
 */
export const ZeroDayStartUnknown: Story = {
  args: {
    lanes: ZERO_LANES,
    initialQuery: queryOf({}, true),
    list: { status: 'done', rows: [], pending: false },
    tail: { rows: [] },
    zero: {
      day: { kind: 'ready', today: { ...ZERO_TODAY, openAtStart: null, decidedCapped: true } },
    },
  },
  play: async ({ canvasElement }) => {
    // The server can't tell the day's start (its lists were capped): the page says so, and draws
    // no line from a figure worked back from capped lists.
    const zero = slot(canvasElement, 'inbox-zero');
    await expect(slot(zero, 'inbox-zero-start-unknown')).toHaveTextContent(/isn’t known/);
    await expect(zero.querySelector('[data-slot="step-rug-line"]')).toBeNull();
    // The rest of the day still reads: the line, by lane.
    await expect(slot(zero, 'inbox-zero-line')).toHaveTextContent(/decided today/);
  },
};

/** Still being prepared: no count anywhere, the lanes' foot and the list say why. */
export const Preparing: Story = {
  args: {
    lanes: PENDING_LANES,
    initialQuery: queryOf({ lane: 'safety' }, true),
    list: { status: 'done', rows: [SAFETY_ROW], pending: true },
    tail: null,
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'inbox-lanes-pending')).toHaveTextContent(
      'Still being prepared',
    );
    await expect(canvasElement.querySelector('[data-slot="inbox-kicker"]')).toBeNull();
    await expect(slot(canvasElement, 'inbox-pending')).toHaveTextContent(
      /some items may not be listed/,
    );
    await expect(canvasElement.querySelector('[data-slot="lane-count"]')).toBeNull();
  },
};

/** Loading: skeleton rows, the inspector on its way. */
export const Loading: Story = {
  args: {
    lanes: undefined,
    list: { status: 'loading', rows: [], pending: false },
    tail: null,
    inspector: { kind: 'loading' },
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll('[data-slot="inbox-skeleton"]').length).toBe(5);
    await expect(listbox(canvasElement)).toHaveAttribute('aria-busy', 'true');
    await expect(slot(canvasElement, 'inbox-item-loading')).toHaveAttribute('aria-busy', 'true');
  },
};

/** A failed read, with Try again; the list stays where it was. */
export const Failed: Story = {
  args: {
    list: { status: 'error', rows: [], pending: false },
    onRetryList: fn(),
    tail: null,
  },
  play: async ({ canvasElement, args }) => {
    const error = slot(canvasElement, 'inbox-error');
    await expect(error).toHaveTextContent('The list didn’t load.');
    await userEvent.click(within(error).getByRole('button'));
    await expect(args.onRetryList).toHaveBeenCalled();
  },
};

/** A filter's scan ran out before the list did: More to read, and Read on asks for the next. */
export const MoreToRead: Story = {
  args: {
    initialQuery: queryOf({ lane: 'safety', age: 30 }, true),
    list: { status: 'budget', rows: [SAFETY_ROW], pending: false },
    onLoadMore: fn(),
    tail: { rows: SAFETY_TAIL },
  },
  play: async ({ canvasElement, args }) => {
    await expect(slot(canvasElement, 'inbox-end')).toHaveTextContent('More to read');
    // More may match past the scan: no row claims to know the list's size.
    for (const option of within(canvasElement).getAllByRole('option')) {
      await expect(option).toHaveAttribute('aria-setsize', '-1');
    }
    await expectNoAllTab(canvasElement);
    // The week's decisions wait for the list's end.
    await expect(canvasElement.querySelector('[data-slot="inbox-tail-head"]')).toBeNull();
    await expect(slot(canvasElement, 'inbox-applied')).toHaveTextContent(/30 d/);
    await userEvent.click(slot(canvasElement, 'inbox-read-on'));
    await expect(args.onLoadMore).toHaveBeenCalled();
  },
};

/** No end tab may say "All N" before every row is in: it would claim the list is whole. */
async function expectNoAllTab(root: HTMLElement) {
  const tabs = [...root.querySelectorAll<HTMLElement>('[data-slot="inbox-end"]')];
  for (const tab of tabs) await expect(tab.textContent).not.toMatch(/^All \d/);
}

/** More pages to come: the list says it is loading, never "All 1"; rows' size unknown. */
export const MorePages: Story = {
  args: {
    list: { status: 'more', rows: [SAFETY_ROW], pending: false },
    tail: { rows: SAFETY_TAIL },
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'inbox-end')).toHaveTextContent('Loading more');
    await expectNoAllTab(canvasElement);
    await expect(canvasElement.querySelector('[data-slot="inbox-tail-head"]')).toBeNull();
    await expect(within(canvasElement).getAllByRole('option')[0]).toHaveAttribute(
      'aria-setsize',
      '-1',
    );
  },
};

/** The next page on its way: the same — no end, no claim to the list's size. */
export const FetchingPages: Story = {
  args: {
    list: { status: 'fetching', rows: [SAFETY_ROW], pending: false },
    tail: { rows: SAFETY_TAIL },
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'inbox-end')).toHaveTextContent('Loading more');
    await expectNoAllTab(canvasElement);
    await expect(within(canvasElement).getAllByRole('listbox')[0]).toHaveAttribute(
      'aria-busy',
      'true',
    );
  },
};

/** A link to nothing: No such item, the list still usable. */
export const NoSuchItem: Story = {
  args: {
    initialQuery: queryOf({ lane: 'safety', item: 'jd7nothing0000000000000000000000' }, true),
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'inbox-no-such-item')).toBeInTheDocument();
    await expect(slot(canvasElement, 'inbox-inspector-title')).toHaveTextContent('No such item');
    await userEvent.click(must(within(canvasElement).getAllByRole('option')[0]));
    await waitFor(() =>
      expect(slot(inspector(canvasElement), 'inbox-placeholder-facts')).toBeInTheDocument(),
    );
  },
};

/** Decided while it was open, by a colleague: the bar goes, the lock says who, when and what. */
export const DecidedWhileOpen: Story = {
  args: {
    inspector: {
      kind: 'item',
      item: decidedItem(SAFETY_ITEM, MATT, 20 * 60_000, 'hidden'),
      phase: 'locked',
    },
  },
  play: async ({ canvasElement }) => {
    const lock = slot(canvasElement, 'inbox-decided-lock');
    await expect(lock).toHaveTextContent(/Decided by Matt Steinberg · 11:40 · hidden/);
    await expect(within(lock).getByRole('button', { name: /History/ })).toBeInTheDocument();
    // ⏎ in the inspector goes back to the queue.
    inspector(canvasElement).focus();
    await waitFor(() => expect(inspector(canvasElement)).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(listbox(canvasElement)).toHaveFocus());
  },
};

/** Opening a filter: the lane's kinds with their counts, the ages; a choice replaces the last. */
export const FilterMenu: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /^Filter/ }));
    const menu = await within(document.body).findByRole('dialog', { name: 'Filter' });
    // A menu keeps its counts: Reports 1, Hazards 0.
    await expect(within(menu).getByRole('button', { name: /Reports/ })).toHaveTextContent('1');
    // The ages keep theirs too (the lane's `olderThan`): one item four days old.
    await expect(within(menu).getByRole('button', { name: /^1 d/ })).toHaveTextContent(/^1 d\s*1$/);
    await expect(within(menu).getByRole('button', { name: /^30 d/ })).toHaveTextContent(
      /^30 d\s*0$/,
    );
    await userEvent.click(within(menu).getByRole('button', { name: /^7 d/ }));
    await waitFor(() =>
      expect(args.onQueryChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ filter: { kind: 'age', days: 7 } }),
      ),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(slot(canvasElement, 'inbox-applied')).toHaveTextContent(/7 d/));
  },
};

/** The narrow rule at 360 px: one pane at a time — the open item, with its way back. */
export const Narrow: Story = {
  args: { className: 'h-[50rem] w-[22.5rem]' },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(slot(canvasElement, 'inbox-page')).toHaveAttribute('data-narrow'));
    await expect(canvasElement.querySelector('[data-pane="middle"]')).toHaveClass('hidden');
    // The open item takes the page, nothing scrolls sideways, every control is in reach.
    await expectNoSidewaysScroll(slot(canvasElement, 'inbox-page'));
    await expectControlsInside(slot(canvasElement, 'inbox-page'), inspector(canvasElement));
    const back = within(canvasElement).getByRole('button', { name: 'Back to the list' });
    await userEvent.click(back);
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-pane="detail"]')).toHaveClass('hidden'),
    );
    await waitFor(() => expect(listbox(canvasElement)).toHaveFocus());
    // With none open, the lanes sit over the list, and still nothing scrolls sideways.
    await expectNoSidewaysScroll(slot(canvasElement, 'inbox-page'));
  },
};

/** A moderator: no Support lane (D37). */
export const Moderator: Story = {
  args: { canReadSupport: false },
  play: async ({ canvasElement }) => {
    const lanes = within(canvasElement).getByRole('navigation', { name: 'Inbox' });
    await expect(within(lanes).queryByRole('button', { name: /^Support/ })).toBeNull();
  },
};

/** A flag on content its author withdrew: said first, drawn in the quieter ink — never as live. */
export const Withdrawn: Story = {
  args: {
    initialQuery: queryOf({ lane: 'contentFlags' }, true),
    list: { status: 'done', rows: [WITHDRAWN_ROW], pending: false },
    tail: null,
  },
  play: async ({ canvasElement }) => {
    const row = must(within(canvasElement).getAllByRole('option')[0]);
    await expect(row).toHaveAttribute('data-withdrawn', '');
    await expect(slot(row, 'inbox-row-chips')).toHaveTextContent(/withdrawn/i);
    await expect(slot(row, 'inbox-row-sub')).toHaveTextContent(/^Withdrawn by its author · /);
    // Six tabs stay inside the list column.
    const facets = slot(canvasElement, 'inbox-facets');
    const tabs = within(canvasElement).getByRole('group', { name: 'Kind' });
    await expect(tabs.getBoundingClientRect().right).toBeLessThanOrEqual(
      facets.getBoundingClientRect().right + 1,
    );
    const title = slot(row, 'inbox-row-title');
    // The quieter ink a decided row wears, not a live row's.
    await expect(title.className).toMatch(/text-fg2/);
  },
};

const MANY_DECIDED = Array.from({ length: 150 }, (_, i) =>
  decidedRow(
    { ...SAFETY_ROW, itemId: `itmany${String(i).padStart(26, '0')}` } as typeof SAFETY_ROW,
    i % 2 ? MATT : SARAH,
    (i + 1) * 3_600_000,
    i % 3 ? 'dismissed' : 'hidden',
  ),
);

/** The Decided list, long: only the rows in view are in the page; the keys still reach every row. */
export const DecidedLong: Story = {
  args: {
    initialQuery: queryOf({ lane: 'decided' }, true),
    list: { status: 'done', rows: MANY_DECIDED, pending: false },
    tail: null,
  },
  play: async ({ canvasElement }) => {
    const list = within(canvasElement).getByRole('listbox');
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBeGreaterThan(0));
    await expect(within(list).getAllByRole('option').length).toBeLessThan(150);
    list.focus();
    await waitFor(() => expect(list).toHaveFocus());
    await userEvent.keyboard('{End}');
    await waitFor(() => {
      const id = list.getAttribute('aria-activedescendant');
      expect(id).not.toBeNull();
      const option = document.getElementById(id as string);
      expect(option).toHaveAttribute('aria-posinset', '150');
    });
    await waitFor(() => expect(slot(canvasElement, 'inbox-end')).toHaveTextContent('All 150'));
  },
};

const bodyQuery = fn();
const retrySearch = fn();

/** Closed, the filter's searches stop reading: what was typed is dropped with the menu. */
export const FilterSearchStops: Story = {
  args: { bodySearch: { onQuery: bodyQuery, results: [] } },
  beforeEach: () => {
    bodyQuery.mockClear();
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /^Filter/ }));
    const menu = await within(document.body).findByRole('dialog', { name: 'Filter' });
    await userEvent.type(within(menu).getByRole('searchbox', { name: 'Find a body' }), 'mas');
    await waitFor(() => expect(bodyQuery).toHaveBeenLastCalledWith('mas'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await expect(bodyQuery).toHaveBeenLastCalledWith('');
  },
};

/** A failed search says it failed, with Try again — never "no results". */
export const FilterSearchFailed: Story = {
  args: {
    bodySearch: { onQuery: fn(), results: [], failure: { retry: retrySearch, pending: false } },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /^Filter/ }));
    const menu = await within(document.body).findByRole('dialog', { name: 'Filter' });
    await userEvent.type(within(menu).getByRole('searchbox', { name: 'Find a body' }), 'mas');
    const note = await within(menu).findByText('The search didn’t load.');
    await expect(note).toBeVisible();
    await userEvent.click(within(menu).getByRole('button', { name: /Try again/ }));
    await expect(retrySearch).toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
  },
};

const HELD_ROW = decidedRow(SAFETY_ROW, MATT, 3_600_000, 'hidden');
const openHeld = fn();

/**
 * A held ⏎ on a decided item opens it once: the key's repeats never send it back to the list and on
 * again, list and inspector by turns.
 */
export const HeldEnter: Story = {
  args: {
    initialQuery: queryOf({ lane: 'decided' }, true),
    list: { status: 'done', rows: [HELD_ROW], pending: false },
    tail: null,
    items: {
      [HELD_ROW.itemId]: {
        ...decidedItem(SAFETY_ITEM, MATT, 3_600_000, 'hidden'),
        itemId: HELD_ROW.itemId,
      },
    },
    registry: new Map(),
    onOpenItem: openHeld,
  },
  beforeEach: () => {
    openHeld.mockClear();
  },
  play: async ({ canvasElement }) => {
    const list = within(canvasElement).getByRole('listbox');
    list.focus();
    await waitFor(() => expect(list).toHaveFocus());
    // Pressed and held, as a browser sends it: one keydown, then repeats, each to whatever has focus
    // when it fires.
    const press = (repeat: boolean) =>
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          repeat,
          bubbles: true,
          cancelable: true,
        }),
      );
    press(false);
    await waitFor(() => expect(inspector(canvasElement)).toHaveFocus());
    for (let i = 0; i < 5; i++) {
      press(true);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }),
    );
    await waitFor(() => expect(inspector(canvasElement)).toHaveFocus());
    await expect(openHeld).toHaveBeenCalledTimes(1);
    await expect(slot(canvasElement, 'inbox-decided-lock')).toBeInTheDocument();
    // A repeat of ⇧⏎ in the inspector does nothing either; a fresh press goes back.
    inspector(canvasElement).dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await expect(inspector(canvasElement)).toHaveFocus();
    // A fresh press is a new press: back to the queue.
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(list).toHaveFocus());
    // A repeat reaching the list never opens a row.
    list.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }),
    );
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await expect(openHeld).toHaveBeenCalledTimes(1);
    await expect(list).toHaveFocus();
  },
};
