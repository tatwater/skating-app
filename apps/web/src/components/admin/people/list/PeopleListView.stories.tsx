import { PEOPLE_LANES } from '@skating/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, resolvePx, sameColor } from '@/components/kit/measure';
import { faceLoaded, must } from '@/components/kit/storyKit';

import { resetScrollMemory } from './PeopleList';
import { PeopleBoard } from './peopleBoard';
import {
  JAMIE,
  KATE,
  LANES,
  LANES_CAPPED,
  LANES_MODERATOR,
  LANES_PREPARING,
  LUC,
  MATT,
  manyPeople,
  ROB,
  SARAH,
  TEAGAN,
} from './peopleFixtures';
import { PEOPLE_LANE_INFO } from './peopleLanes';

/**
 * Boards 8.1 and 8.2: the People list in the console's frame, at the boards' 1440 × 900, on the
 * pinned clock. The third column is the person route's page; here it is left empty. Render one
 * beside its board to compare.
 */
const meta = {
  title: 'Admin/People/List',
  component: PeopleBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: {
    initialQuery: { lane: 'suspended', q: '' },
    initialSelected: ROB.userId,
    list: { status: 'done', rows: [ROB], reasons: [], pending: [] },
    detail: <span />,
    onQueryChange: fn(),
    onOpenPerson: fn(),
  },
  beforeEach: () => resetScrollMemory(),
} satisfies Meta<typeof PeopleBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));

/** Board 8.1 — Suspended, by end date; Rob open beside it. */
export const Suspended: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await faceLoaded(slot(canvasElement, 'page-word'));
    await expect(slot(canvasElement, 'page-word')).toHaveTextContent('Suspended');
    await expect(slot(canvasElement, 'people-kicker')).toHaveTextContent('1 · by end date');
    // The lane is chosen: its count takes the lit ink, as every chosen lane's does (the board draws
    // it amber; the kit lights the chosen lane's count).
    const lane = page.getByRole('button', { name: /^Suspended/ });
    await expect(lane).toHaveAttribute('aria-current', 'true');
    const count = slot(lane, 'lane-count');
    await expect(getComputedStyle(count).color).toEqual(
      sameColor(computedColor(count, 'var(--fg)')),
    );
    // Rob's row: the amber status chip first, then his class; the date, his flag and appeal; the reason.
    const row = must(page.getByRole('option', { name: /Rob Tremblay/ }));
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await expect(slot(row, 'people-row-chips')).toHaveTextContent(/Suspended\s*Trusted/i);
    await expect(slot(row, 'people-row-sub')).toHaveTextContent(
      'Until Thu 15 Oct · Restricted: comments · 1 open flag · 1 appeal',
    );
    await expect(slot(row, 'people-row-reason')).toHaveTextContent(
      'Reason: “Second unsafe report in a week; cooling off”',
    );
    await expect(slot(row, 'people-row-age')).toHaveTextContent('3 d');
    // The list ends in its tab; the status bar names the open appeal.
    await expect(slot(canvasElement, 'people-end')).toHaveTextContent('All 1');
  },
};

/** Board 8.2 — Staff, admins first. No age: no read says when staff were last in the console. */
export const Staff: Story = {
  args: {
    initialQuery: { lane: 'staff', q: '' },
    initialSelected: SARAH.userId,
    list: { status: 'done', rows: [TEAGAN, SARAH, MATT], reasons: [], pending: [] },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(slot(canvasElement, 'people-kicker')).toHaveTextContent('3 · admins first');
    const rows = page.getAllByRole('option');
    await expect(rows.map((r) => slot(r, 'person-name').textContent)).toEqual([
      'Teagan Atwater',
      'Sarah Berman',
      'Matt Steinberg',
    ]);
    // The viewer is named like anyone else; Matt shows no class at all.
    await expect(slot(rows[0] as HTMLElement, 'people-row-sub')).toHaveTextContent('Admin');
    await expect(
      (rows[2] as HTMLElement).querySelector('[data-slot="people-row-chips"]'),
    ).toBeNull();
    await expect(canvasElement.querySelector('[data-slot="people-row-age"]')).toBeNull();
  },
};

/** A search over every account: no lane chosen, the match marked in the name and the handle. */
export const Search: Story = {
  args: {
    initialQuery: { lane: 'everyone', q: 'mor' },
    initialSelected: null,
    list: { status: 'done', rows: [JAMIE], reasons: [], pending: [] },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(slot(canvasElement, 'page-word')).toHaveTextContent('Search');
    await expect(slot(canvasElement, 'people-kicker')).toHaveTextContent('best match first');
    await expect(page.getByRole('searchbox', { name: 'Search any account' })).toHaveValue('mor');
    const lanes = page.getByRole('navigation', { name: 'People' });
    await expect(lanes.querySelector('[aria-current]')).toBeNull();
    const marks = [...canvasElement.querySelectorAll('mark')].map((m) => m.textContent);
    await expect(marks).toEqual(['Mor']);
  },
};

/** Keys: ↓ moves, type-ahead jumps, ⏎ opens; `/` goes to the search. */
export const Keys: Story = {
  args: {
    initialQuery: { lane: 'newest', q: '' },
    initialSelected: null,
    list: { status: 'done', rows: [LUC, KATE], reasons: [], pending: [] },
  },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    const list = page.getByRole('listbox', { name: 'Newest' });
    list.focus();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('k');
    await userEvent.keyboard('{Enter}');
    await expect(args.onOpenPerson).toHaveBeenCalledWith(KATE.userId, 'keys');
    await userEvent.keyboard('/');
    await waitFor(() =>
      expect(page.getByRole('searchbox', { name: 'Search any account' })).toHaveFocus(),
    );
  },
};

/** Straight after a deploy: no count anywhere, and the list says it may not have everyone. */
export const StillPreparing: Story = {
  args: {
    lanesRead: LANES_PREPARING,
    initialQuery: { lane: 'everyone', q: '' },
    initialSelected: null,
    list: { status: 'done', rows: [KATE, LUC], reasons: [], pending: ['rows', 'flagSubjects'] },
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="lane-count"]')).toBeNull();
    await expect(slot(canvasElement, 'people-lanes-pending')).toHaveTextContent(
      'Counts still being prepared',
    );
    await expect(slot(canvasElement, 'people-kicker')).toHaveTextContent(/^by name$/);
    await expect(slot(canvasElement, 'people-pending')).toHaveTextContent(
      'Still being prepared: this list may not have everyone yet',
    );
    // Its end claims no total while who is in it may be wrong.
    await expect(slot(canvasElement, 'people-end')).toHaveTextContent('Still being prepared');
  },
};

/** The open flag queue read to its cap: Flagged is "200+" and says why in words. */
export const Capped: Story = {
  args: {
    lanesRead: LANES_CAPPED,
    initialQuery: { lane: 'flagged', q: '' },
    initialSelected: null,
    list: {
      status: 'more',
      rows: [ROB, SARAH],
      reasons: ['flags_capped'],
      pending: [],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'people-kicker')).toHaveTextContent('200+ · oldest first');
    await expect(slot(canvasElement, 'people-reason')).toHaveTextContent(
      'There are more open flags than one read covers, so flag figures are floors',
    );
    await expect(
      within(canvasElement).getByRole('option', { name: /Rob Tremblay/ }),
    ).toHaveTextContent('1+ open flag on their content');
  },
};

/** A moderator's sidebar: no Appeals open — no error, no blank. */
export const Moderator: Story = {
  args: { lanesRead: LANES_MODERATOR },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('button', { name: /Appeals/ })).toBeNull();
  },
};

/** The first page on its way: skeleton rows, no end tab. */
export const Loading: Story = {
  args: {
    lanesRead: null,
    initialSelected: null,
    list: { status: 'loading', rows: [], reasons: [], pending: [] },
  },
};

/** The list's read failed: said in its own place, with Try again. */
export const Failed: Story = {
  args: {
    initialSelected: null,
    list: { status: 'error', rows: [], reasons: [], pending: [] },
    onRetryList: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(page.getByText('Couldn’t read this list')).toBeInTheDocument();
    await userEvent.click(page.getByRole('button', { name: 'Try again' }));
    await expect(args.onRetryList).toHaveBeenCalled();
  },
};

/** An empty lane says so in plain words. */
export const Empty: Story = {
  args: {
    initialQuery: { lane: 'banned', q: '' },
    initialSelected: null,
    list: { status: 'done', rows: [], reasons: [], pending: [] },
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'people-end')).toHaveTextContent('No one is banned');
  },
};

/** A long list: only the rows in view are in the page; more arrive as it scrolls. */
export const Long: Story = {
  args: {
    initialQuery: { lane: 'everyone', q: '' },
    initialSelected: null,
    list: { status: 'more', rows: manyPeople(240), reasons: [], pending: [] },
    onLoadMore: fn(),
  },
  play: async ({ canvasElement }) => {
    const rendered = canvasElement.querySelectorAll('[data-slot="people-row"]').length;
    await expect(rendered).toBeGreaterThan(0);
    await expect(rendered).toBeLessThan(240);
  },
};

/**
 * Every list head at the list column's token width, with the longest counts a lane can show: no
 * head is ever cut (no ellipsis, nothing past its box), a kicker takes at most a second line, and
 * the head's height is the same whichever lane is open — the rhythm the board draws.
 */
export const Heads: Story = {
  args: {
    lanesRead: {
      ...LANES,
      lanes: LANES.lanes.map((l) => ({ ...l, count: { count: 1234, capped: true } })),
    },
    initialQuery: { lane: 'everyone', q: '' },
    initialSelected: null,
    list: { status: 'done', rows: [], reasons: [], pending: [] },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await faceLoaded(slot(canvasElement, 'page-word'));
    const column = must(canvasElement.querySelector<HTMLElement>('[data-pane="middle"]'));
    await expect(column.getBoundingClientRect().width).toBeCloseTo(
      resolvePx(column, 'var(--size-list)'),
      0,
    );
    const heights = new Set<number>();
    const check = async (name: string) => {
      const head = slot(canvasElement, 'people-head');
      const word = slot(canvasElement, 'page-word');
      const kicker = slot(canvasElement, 'people-kicker');
      for (const el of [head, word, kicker]) {
        await expect(getComputedStyle(el).textOverflow, name).not.toBe('ellipsis');
        await expect(el.scrollWidth, name).toBeLessThanOrEqual(el.clientWidth);
      }
      const line = Number.parseFloat(getComputedStyle(kicker).lineHeight);
      const text =
        kicker.getBoundingClientRect().height -
        Number.parseFloat(getComputedStyle(kicker).paddingBottom);
      await expect(text, name).toBeLessThanOrEqual(2 * line + 1);
      heights.add(Math.round(head.getBoundingClientRect().height));
    };
    for (const lane of PEOPLE_LANES) {
      const label = PEOPLE_LANE_INFO[lane].label;
      await userEvent.click(page.getByRole('button', { name: (n) => n.startsWith(label) }));
      await expect(slot(canvasElement, 'people-kicker')).toHaveTextContent('1,234+');
      await check(lane);
    }
    // A search, whose head says only its order.
    await userEvent.type(page.getByRole('searchbox', { name: 'Search any account' }), 'rob');
    await waitFor(() => expect(slot(canvasElement, 'page-word')).toHaveTextContent('Search'));
    await check('search');
    await expect([...heights]).toHaveLength(1);
  },
};
