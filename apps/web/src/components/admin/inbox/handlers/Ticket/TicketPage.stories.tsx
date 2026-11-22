import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { expectNoSidewaysScroll, must } from '@/components/kit/storyKit';

import { InboxBoard } from '../../inboxBoard';
import { queryOf } from '../../inboxSearch';
import { resetInboxScroll } from '../../list/InboxList';
import { decidedRow, SARAH } from '../../list/inboxFixtures';
import type { InboxItemView } from '../../list/inboxTypes';
import { type StoryWrite, storyTicketRegistry, ticketRowOf } from './ticketBoard';
import { forgetTicketDrafts } from './ticketDrafts';
import { KATE_BUG, ROB_APPEAL, UNANSWERED } from './ticketFixtures';
import type { TicketItem } from './ticketModel';

/**
 * Board 2.8 as a whole page — the Inbox's own page with the ticket handler in its inspector, at the
 * boards' 1440 × 900 (the render-compare beside `inbox-handler-v5.html?h=ticket`) and at a phone's
 * 360 px, where one pane shows at a time and Resolve is the bar at the pane's foot.
 */
const onWrite = fn(async (_write: StoryWrite) => true);

const ITEMS: TicketItem[] = [KATE_BUG, ROB_APPEAL];
const ROWS = [
  ticketRowOf(KATE_BUG, '“Map blank after the update”'),
  ticketRowOf(ROB_APPEAL, '“Appeal: my suspension”'),
];
const BY_ID: Record<string, InboxItemView> = Object.fromEntries(
  ITEMS.map((i) => [i.itemId, i as unknown as InboxItemView]),
);
const TAIL = [
  decidedRow(
    ticketRowOf(
      { ...UNANSWERED, itemId: 'i_ticket_verify' } as TicketItem,
      '“Can’t verify my email”',
    ),
    SARAH,
    2 * 86_400_000,
    'resolved',
  ),
];

const at = (item: TicketItem) => queryOf({ lane: 'support', item: item.itemId }, true);

const meta = {
  title: 'Admin/Inbox/Handlers/Ticket/Page',
  component: InboxBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: {
    initialQuery: at(ROB_APPEAL),
    canReadSupport: true,
    list: { status: 'done', rows: ROWS, pending: false },
    tail: { rows: TAIL },
    items: BY_ID,
    registry: new Map(storyTicketRegistry(onWrite)),
  },
  beforeEach: () => {
    resetInboxScroll();
    forgetTicketDrafts();
    onWrite.mockClear();
  },
} satisfies Meta<typeof InboxBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

const detail = (root: HTMLElement) =>
  must(root.querySelector<HTMLElement>('[data-slot="inbox-page"] > [data-pane="detail"]'));
const handler = (root: HTMLElement) =>
  waitFor(() => must(detail(root).querySelector<HTMLElement>('[data-slot="ticket-handler"]')));

/** Board 2.8, the page: R resolves only with the inspector focused. */
export const Appeal: Story = {
  play: async ({ canvasElement }) => {
    await handler(canvasElement);
    const pane = detail(canvasElement);
    await waitFor(() =>
      expect(pane.querySelector('[data-slot="ticket-handler"]')).toHaveAttribute(
        'data-layout',
        'columns',
      ),
    );
    pane.focus();
    await waitFor(() => expect(pane.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard('r');
    await waitFor(() => expect(onWrite).toHaveBeenCalledWith({ act: 'resolve' }));
  },
};

/** Board 2.8, light. */
export const AppealLight: Story = {
  globals: { surface: 'admin', mode: 'light' },
  play: async ({ canvasElement }) => {
    await handler(canvasElement);
  },
};

/** 2.8 at 360 px: one pane, the dock under the thread, nothing sideways. */
export const AppealAtPhone: Story = {
  args: { className: 'h-[50rem] w-[22.5rem]' },
  play: async ({ canvasElement }) => {
    await handler(canvasElement);
    await within(detail(canvasElement)).findByRole('toolbar');
    await expectNoSidewaysScroll(
      must(canvasElement.querySelector<HTMLElement>('[data-slot="inbox-page"]')),
    );
  },
};
