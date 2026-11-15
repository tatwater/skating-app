import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { faceLoaded, must } from '@/components/kit/storyKit';

import type { ReadFailure } from '../../reads/consoleReads';
import { PersonBoard, type PersonBoardProps } from './personBoard';
import {
  HISTORY_CAPPED,
  HISTORY_PENDING,
  IDS,
  ROB,
  ROB_CAPPED,
  ROB_DELETED,
  ROB_HISTORY,
  ROB_LEAVING,
  ROB_PENDING,
  ROB_TREND,
  ROB_UNRECORDED,
  SARAH_BY_MODERATOR,
  SARAH_DECISIONS,
  SARAH_GRANTED,
  SARAH_GRANTED_HISTORY,
  SARAH_HISTORY,
  SARAH_PAGE,
  SARAH_STATS,
  SARAH_TREND,
  SEASON,
  SEASON_EMPTY,
  SEASON_PENDING,
  SEASON_UNRECORDED,
  STATS_CAPPED,
  STATS_PENDING,
  STATS_UNRECORDED,
  TEAGAN_DECISIONS,
  TEAGAN_HISTORY,
  TEAGAN_PAGE,
  TEAGAN_STATS,
  TREND_CAPPED,
} from './personFixtures';

/**
 * Boards 8.1, 8.2, 8.5 and 8.6: the person page in the boards' detail column (760 × 900), on the
 * pinned clock (Wed 14 Oct 2026, midday), with the shell's undo toast over a fixture server. Then
 * the states no board draws: pending, capped, not recorded, failed, loading, a moderator viewing an
 * admin, an empty season, an account leaving or deleted, no such person.
 */
const meta = {
  title: 'Admin/People/Person',
  component: PersonBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: {
    person: ROB,
    trend: ROB_TREND,
    history: ROB_HISTORY,
    staffStats: null,
    staffSeason: null,
    decisions: { rows: [], isDone: true, continueCursor: '' },
    viewerId: IDS.teagan,
    onWrite: fn(),
    onUndone: fn(),
  },
} satisfies Meta<typeof PersonBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const lever = (root: ParentNode, key: string) =>
  must(root.querySelector<HTMLElement>(`[data-lever="${key}"]`));
const fact = (root: ParentNode, key: string) =>
  must(root.querySelector<HTMLElement>(`[data-fact="${key}"]`));
const failure = (pending = false): ReadFailure => ({ failed: true, pending, retry: fn() });

const STAFF = {
  trend: SARAH_TREND,
  history: SARAH_HISTORY,
  staffStats: SARAH_STATS,
  staffSeason: SEASON,
  decisions: SARAH_DECISIONS,
} satisfies Partial<PersonBoardProps>;

/** Board 8.1 — a suspended skater: the amber note, the strip, the levers, what is open, History. */
export const Suspended: Story = {
  play: async ({ canvasElement, args }) => {
    await faceLoaded(slot(canvasElement, 'person-name'));
    await expect(slot(canvasElement, 'status-note')).toHaveTextContent('Suspended · 1 day left');
    await expect(slot(canvasElement, 'status-lifts')).toHaveTextContent(
      'Lifts on its own Thu 15 Oct 19:48',
    );
    // The two columns sit side by side in the board's detail column.
    const left = slot(canvasElement, 'person-left').getBoundingClientRect();
    const right = slot(canvasElement, 'person-right').getBoundingClientRect();
    await expect(right.left).toBeGreaterThan(left.right);
    await expect(slot(canvasElement, 'person-right')).toContainElement(
      slot(canvasElement, 'person-history'),
    );
    // A give-back acts at once; the receipt shows with its Undo.
    await userEvent.click(
      within(lever(canvasElement, 'comments')).getByRole('button', { name: 'Restore' }),
    );
    await expect(args.onWrite).toHaveBeenCalledWith({
      kind: 'right',
      permission: 'comments',
      allowed: true,
    });
    await waitFor(() =>
      expect(slot(canvasElement, 'toast')).toHaveTextContent('Rob Tremblay can comment again'),
    );
    await expect(
      within(slot(canvasElement, 'toast')).getByRole('button', { name: /Undo/ }),
    ).toBeInTheDocument();
    // Focus stayed in Can do.
    await expect(slot(canvasElement, 'levers-can-do').contains(document.activeElement)).toBe(true);
  },
};

/** Board 8.2 — an admin's page, by an admin who holds the ledger: Grant, the staff strip, Decisions. */
export const StaffGrantInvoices: Story = {
  args: { person: SARAH_PAGE, ...STAFF },
  play: async ({ canvasElement }) => {
    await faceLoaded(slot(canvasElement, 'person-name'));
    await expect(lever(canvasElement, 'ledger')).toHaveTextContent('Off');
    await expect(
      within(lever(canvasElement, 'ledger')).getByRole('button', { name: 'Grant' }),
    ).toBeInTheDocument();
    await expect(fact(canvasElement, 'decisions')).toHaveTextContent('18 this week');
    await expect(fact(canvasElement, 'time-to-decide')).toHaveTextContent('41 min');
    await expect(slot(canvasElement, 'person-right')).toContainElement(
      slot(canvasElement, 'person-decisions'),
    );
  },
};

/** Board 8.5 — the grant landed (the reads moved): ledger On, the toast, the role menu open. */
export const AdminHoldsInvoices: Story = {
  args: { person: SARAH_PAGE, ...STAFF },
  render: function Render(args) {
    const [granted, setGranted] = useState(false);
    return (
      <PersonBoard
        {...args}
        person={granted ? SARAH_GRANTED : SARAH_PAGE}
        history={granted ? SARAH_GRANTED_HISTORY : SARAH_HISTORY}
        onWrite={(action) => {
          args.onWrite?.(action);
          if (action.kind === 'ledger' && action.grant) setGranted(true);
          return null;
        }}
      />
    );
  },
  play: async ({ canvasElement }) => {
    await faceLoaded(slot(canvasElement, 'person-name'));
    await userEvent.click(
      within(lever(canvasElement, 'ledger')).getByRole('button', { name: 'Grant' }),
    );
    await waitFor(() => expect(lever(canvasElement, 'ledger')).toHaveTextContent('On'));
    await waitFor(() =>
      expect(slot(canvasElement, 'toast')).toHaveTextContent('Sarah Berman can edit the ledger'),
    );
    await expect(slot(canvasElement, 'person-history')).toHaveTextContent(
      'Gave Sarah Berman ledger editing',
    );
    await userEvent.click(
      within(lever(canvasElement, 'role')).getByRole('button', { name: /Change role/ }),
    );
    const menu = await within(document.body).findByRole('menu');
    await expect(within(menu).getAllByText('Also revokes ledger editing')).toHaveLength(2);
  },
};

/** Board 8.6 — the viewer's own page: no levers on yourself; Step down disabled, with why. */
export const YourOwnPage: Story = {
  args: {
    person: TEAGAN_PAGE,
    trend: SARAH_TREND,
    history: TEAGAN_HISTORY,
    staffStats: TEAGAN_STATS,
    staffSeason: SEASON,
    decisions: TEAGAN_DECISIONS,
  },
  play: async ({ canvasElement }) => {
    await faceLoaded(slot(canvasElement, 'person-name'));
    await expect(within(slot(canvasElement, 'levers-can-do')).queryAllByRole('button')).toEqual([]);
    await expect(lever(canvasElement, 'ledger')).toHaveTextContent('On · the only editor');
    await userEvent.hover(
      within(lever(canvasElement, 'ledger')).getByRole('button', { name: 'Step down' }),
    );
    await expect(
      await within(document.body).findByText('Give it to another admin first'),
    ).toBeInTheDocument();
    await expect(
      within(lever(canvasElement, 'ledger')).getByRole('button', { name: 'Step down' }),
    ).toHaveAttribute('aria-disabled', 'true');
  },
};

/** A moderator on an admin's page: the staff figures, no levers, no ledger row, no trust points. */
export const ModeratorViewing: Story = {
  args: { person: SARAH_BY_MODERATOR, ...STAFF, viewerId: IDS.matt },
  play: async ({ canvasElement }) => {
    await faceLoaded(slot(canvasElement, 'person-name'));
    await expect(canvasElement.querySelector('[data-fact="trust-points"]')).toBeNull();
    await expect(canvasElement.querySelector('[data-lever="ledger"]')).toBeNull();
    await expect(fact(canvasElement, 'decisions')).toHaveTextContent('18 this week');
    await expect(within(slot(canvasElement, 'levers-account')).queryAllByRole('button')).toEqual(
      [],
    );
  },
};

/** Still being prepared after a deploy: flags on their content, undo chains — never a number. */
export const Pending: Story = {
  args: {
    person: { ...ROB_PENDING, role: 'moderator' },
    history: HISTORY_PENDING,
    staffStats: STATS_PENDING,
    staffSeason: SEASON_PENDING,
    decisions: SARAH_DECISIONS,
  },
  play: async ({ canvasElement }) => {
    await expect(fact(canvasElement, 'open-flags')).toHaveTextContent('Still being prepared');
    await expect(fact(canvasElement, 'staff-since')).toHaveTextContent('Still being prepared');
    await expect(fact(canvasElement, 'overturned')).toHaveTextContent('Still being prepared');
    await expect(slot(canvasElement, 'history-pending')).toBeInTheDocument();
  },
};

/** Read to their caps: every figure a floor, "N+". */
export const Capped: Story = {
  args: {
    person: { ...ROB_CAPPED, role: 'moderator' },
    trend: TREND_CAPPED,
    history: HISTORY_CAPPED,
    staffStats: STATS_CAPPED,
    staffSeason: SEASON,
    decisions: SARAH_DECISIONS,
  },
  play: async ({ canvasElement }) => {
    await expect(fact(canvasElement, 'open-flags')).toHaveTextContent('50+');
    await expect(fact(canvasElement, 'reports')).toHaveTextContent('3,000+');
    await expect(fact(canvasElement, 'decisions')).toHaveTextContent('2,000+');
    await expect(lever(canvasElement, 'record')).toHaveTextContent('500+ items');
    await expect(slot(canvasElement, 'history-capped')).toBeInTheDocument();
    await expect(slot(canvasElement, 'trend-capped')).toBeInTheDocument();
  },
};

/** Not recorded: `null` everywhere a figure can be. */
export const NotRecorded: Story = {
  args: {
    person: { ...ROB_UNRECORDED, role: 'moderator' },
    staffStats: STATS_UNRECORDED,
    staffSeason: SEASON_UNRECORDED,
    decisions: SARAH_DECISIONS,
  },
  play: async ({ canvasElement }) => {
    await expect(fact(canvasElement, 'contradictions')).toHaveTextContent('Not recorded yet');
    await expect(fact(canvasElement, 'overturned')).toHaveTextContent('Not recorded yet');
    await expect(slot(canvasElement, 'status-note')).toHaveTextContent('Reason: Not recorded yet');
  },
};

/** Between 1 July and 1 October: the season is honestly empty and says when its record begins. */
export const EmptySeason: Story = {
  args: { person: SARAH_PAGE, ...STAFF, staffSeason: SEASON_EMPTY },
  play: async ({ canvasElement }) => {
    await expect(fact(canvasElement, 'overturned')).toHaveTextContent('Record begins 1 Oct');
  },
};

/** Every read failed but the person: each block says so with Try again; the page stays up. */
export const Failed: Story = {
  args: {
    person: { ...SARAH_PAGE },
    trend: failure(),
    history: failure(),
    staffStats: failure(),
    staffSeason: failure(),
    decisions: failure(true),
  },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'trend-error')).toHaveTextContent(
      'Their reports couldn’t be read',
    );
    await expect(slot(canvasElement, 'staff-error')).toHaveTextContent(
      'Their staff figures couldn’t be read',
    );
    await expect(slot(canvasElement, 'history-error')).toHaveTextContent(
      'The history couldn’t be read',
    );
    await expect(slot(canvasElement, 'decisions-error')).toHaveTextContent('Trying again');
    await expect(lever(canvasElement, 'role')).toBeInTheDocument();
  },
};

/** The person couldn't be read: its note, while the History beside it stays up. */
export const PersonFailed: Story = {
  args: { person: failure() },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'person-error')).toHaveTextContent(
      'This person couldn’t be read',
    );
    await expect(slot(canvasElement, 'person-history')).toBeInTheDocument();
  },
};

/** Loading: skeletons hold the page's shape. */
export const Loading: Story = {
  args: { person: undefined, trend: undefined, history: undefined },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'person-loading')).toBeInTheDocument();
  },
};

/** No such person — a malformed id, or one with no account. */
export const NoSuchPerson: Story = {
  args: { person: null, trend: null, history: null },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'no-such-person')).toHaveTextContent('No such person');
  },
};

/** An account in its deletion window: the day it goes, and no status levers. */
export const Leaving: Story = {
  args: { person: ROB_LEAVING },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'status-note')).toHaveTextContent('Leaving');
    await expect(canvasElement.querySelector('[data-lever="ban"]')).toBeNull();
  },
};

/** A tombstone: what the read gives, and no lever the server would refuse. */
export const Deleted: Story = {
  args: { person: ROB_DELETED },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'status-note')).toHaveTextContent('Deleted · 3 Oct');
    await expect(canvasElement.querySelector('[data-slot="public-profile"]')).toBeNull();
  },
};
