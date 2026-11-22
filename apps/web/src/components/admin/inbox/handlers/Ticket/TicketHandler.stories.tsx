import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { expectNoSidewaysScroll, must } from '@/components/kit/storyKit';
import { modKey } from '@/lib/keys';
import { ThemePair } from '../../../../../../.storybook/theme';
import type { DecidedState } from '../../inspector/InspectorFrame';
import { StoryTicketInspector, type StoryWrite } from './ticketBoard';
import { forgetTicketDrafts } from './ticketDrafts';
import {
  CANCEL_REFUSED,
  COLLEAGUE_SETTLING,
  EVERY_STATE,
  GONE,
  LONG_THREAD,
  LONG_WORDS,
  NO_PROFILE,
  NO_SENDER,
  OWN_TICKET,
  RELATED_CAPPED,
  RESOLVED,
  ROB_APPEAL,
  SEED_TICKET,
  TICKET_NOW,
  UNANSWERED,
  WITH_SETTLING,
} from './ticketFixtures';
import type { TicketItem } from './ticketModel';

/**
 * Board 2.8 and every other state a ticket can be in, at the board's inspector size (788 × 874 at
 * 1440) in both modes, and at a phone's 360. The real `InspectorFrame` around `TicketView`; the
 * writes are a spy (`onWrite`), the draft the real store.
 *
 * Every layout, count, focus and state read sits inside one retry (`waitFor`): the two columns are
 * decided by a measure after the first commit, and a late web face can move what is measured.
 */
const onWrite = fn(async (_write: StoryWrite) => true);

const meta = {
  title: 'Admin/Inbox/Handlers/Ticket',
  parameters: { layout: 'fullscreen' },
  globals: { surface: 'admin' },
  beforeEach: () => {
    forgetTicketDrafts();
    onWrite.mockReset();
    onWrite.mockImplementation(async () => true);
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const pair = (ui: () => ReactNode) => (
  <ThemePair surface="admin" columns="one">
    {ui}
  </ThemePair>
);
const quads = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-theme-scope]')];
const inspector = (item: TicketItem, extra: { locked?: DecidedState; clock?: number } = {}) =>
  pair(() => <StoryTicketInspector item={item} onWrite={onWrite} {...extra} />);

/** The pane's layout, read until it settles. */
const layoutOf = (q: HTMLElement, want: 'columns' | 'stack') =>
  waitFor(() =>
    expect(must(q.querySelector('[data-slot="ticket-handler"]'))).toHaveAttribute(
      'data-layout',
      want,
    ),
  );
const seenBar = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLElement>('[role="toolbar"]')].find(
    (t) => t.closest('[data-slot="action-bar-measure"]') === null,
  );

/** 2.8 as the board draws it: Rob's appeal, Matt's note, the dock, the person and Resolve. */
export const Board: Story = {
  render: () => inspector(ROB_APPEAL),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await layoutOf(q, 'columns');
      await expect(s.getByText('Support · account')).toBeVisible();
      await expect(s.getByRole('link', { name: /Open in People/ })).toBeVisible();
      await expect(s.getByText(/The suspension says my reports are false/)).toBeVisible();
      await expect(s.getByText('Note · staff only')).toBeVisible();
      // The dock: Reply by email chosen, who it reaches, its foot.
      await expect(s.getByRole('button', { name: 'Reply by email' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(s.getByText('To Rob Tremblay')).toBeVisible();
      await expect(s.getByText(/Their answer by email isn’t read/)).toBeVisible();
      // Resolve is the side's own full-width bar, inside the side column.
      const side = must(q.querySelector<HTMLElement>('[data-slot="ticket-side"]'));
      await waitFor(() => {
        const bar = must(seenBar(side));
        expect(bar).toHaveAttribute('data-full');
        const b = bar.getBoundingClientRect();
        const c = side.getBoundingClientRect();
        expect(b.left).toBeGreaterThanOrEqual(c.left - 0.5);
        expect(b.right).toBeLessThanOrEqual(c.right + 0.5);
        // At the side's foot, the pane's foot.
        expect(c.bottom - b.bottom).toBeLessThan(16);
      });
      // The dock sits at the thread column's foot, the thread above it.
      const pane = must(q.querySelector<HTMLElement>('[data-pane="inspector"]'));
      await waitFor(() => {
        const dock = must(q.querySelector('[data-slot="reply-dock"]')).getBoundingClientRect();
        const p = pane.getBoundingClientRect();
        expect(p.bottom - dock.bottom).toBeLessThan(2);
        expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth);
        // The frame's own scroll doesn't scroll: the thread scrolls inside its column.
        const scroll = must(q.querySelector<HTMLElement>('[data-slot="inbox-inspector-scroll"]'));
        expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.clientHeight + 1);
      });
    }
  },
};

/** Nobody has answered yet: the ticket's words alone. */
export const Unanswered: Story = {
  render: () => inspector(UNANSWERED),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await waitFor(() => expect(q.querySelectorAll('[data-thread-message]')).toHaveLength(1));
    }
  },
};

/** The viewer's reply settling: its countdown and Cancel (`support.cancelReply`). */
export const Settling: Story = {
  render: () => inspector(WITH_SETTLING, { clock: TICKET_NOW }),
  play: async ({ canvasElement }) => {
    const [q] = quads(canvasElement);
    const reply = must(q?.querySelector<HTMLElement>('[data-slot="ticket-reply"]'));
    await expect(reply).toHaveTextContent('Sending in 42 s');
    await userEvent.click(within(reply).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(onWrite).toHaveBeenCalledWith({
        act: 'cancelReply',
        messageId: WITH_SETTLING.messages[1]?.messageId,
      }),
    );
  },
};

/** A colleague's reply settling: anyone with support's write may cancel it (anyone pitches in). */
export const ColleagueSettling: Story = {
  render: () => inspector(COLLEAGUE_SETTLING, { clock: TICKET_NOW }),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const reply = must(q.querySelector<HTMLElement>('[data-slot="ticket-reply"]'));
      await expect(reply).toHaveTextContent('Sending in 42 s');
      await expect(within(reply).getByRole('button', { name: 'Cancel' })).toBeVisible();
    }
  },
};

/** The server refuses this viewer a cancel and a removal: the countdown, no Cancel, no Remove. */
export const CancelRefused: Story = {
  render: () => inspector(CANCEL_REFUSED, { clock: TICKET_NOW }),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const reply = must(q.querySelector<HTMLElement>('[data-slot="ticket-reply"]'));
      await expect(reply).toHaveTextContent('Sending in 42 s');
      await expect(within(q).queryByRole('button', { name: 'Cancel' })).toBeNull();
      await expect(within(q).queryByRole('button', { name: 'Remove' })).toBeNull();
    }
  },
};

/** Every state a message can be in: sent, canceled, not sent and why, a note removed. */
export const EveryState: Story = {
  render: () => inspector(EVERY_STATE),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await waitFor(() => {
        expect(q.querySelectorAll('[data-slot="ticket-reply"][data-state="failed"]')).toHaveLength(
          4,
        );
        expect(q.querySelectorAll('[data-slot="ticket-note-removed"]')).toHaveLength(1);
      });
      await expect(within(q).getByText('Not sent · no sending address is set up')).toBeVisible();
      await expect(within(q).queryByText(/^Sent$/)).toBeNull();
    }
  },
};

/** A busy ticket: the newest 100 of 100+, said under the ticket; the thread scrolls, the dock stays. */
export const LongThread: Story = {
  render: () => inspector(LONG_THREAD),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await layoutOf(q, 'columns');
      await expect(
        within(q).getByText('Showing the newest 100 of 100+ messages'),
      ).toBeInTheDocument();
      await waitFor(() => {
        const scroller = must(q.querySelector<HTMLElement>('[data-slot="ticket-thread-scroll"]'));
        expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
        const dock = must(q.querySelector('[data-slot="reply-dock"]')).getBoundingClientRect();
        const pane = must(q.querySelector('[data-pane="inspector"]')).getBoundingClientRect();
        expect(dock.bottom).toBeLessThanOrEqual(pane.bottom + 1);
        expect(dock.top).toBeGreaterThan(pane.top);
        // The frame is filled (`fill`): no end room under it, and it never scrolls itself.
        const frame = must(q.querySelector<HTMLElement>('[data-slot="inbox-inspector-scroll"]'));
        expect(frame).toHaveAttribute('data-fill');
        expect(Number.parseFloat(getComputedStyle(frame).paddingBottom)).toBe(0);
        expect(frame.scrollHeight).toBeLessThanOrEqual(frame.clientHeight + 1);
      });
    }
  },
};

/** No sending address set up: the dock says a reply won't be sent, before it is written. */
export const NoSender: Story = {
  render: () => inspector(NO_SENDER),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).getByText(/No sending address is set up/)).toBeVisible();
    }
  },
};

/** A test person's ticket (the dev seed): a reply is saved here and never emailed, said up front. */
export const SeedTicket: Story = {
  render: () => inspector(SEED_TICKET),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).getByText(/never emailed/)).toBeVisible();
      await expect(within(q).queryByText(/Sent from/)).toBeNull();
    }
  },
};

/** Related's list and the ticket count cut by the server: floors, and the way to the rest. */
export const RelatedCapped: Story = {
  render: () => inspector(RELATED_CAPPED),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).getByText('More flags on them')).toBeVisible();
      await expect(within(q).getByText('50+ · 50+ resolved')).toBeVisible();
    }
  },
};

const MATT_RESOLVED: DecidedState = {
  by: 'Matt Steinberg',
  at: RESOLVED.ticket.resolvedAt ?? 0,
  decision: 'resolved',
  byMe: false,
  actionId: 'ma_resolve_rob',
};

/** Resolved by a colleague: the lock, no dock, no Resolve; Reopen. */
export const Resolved: Story = {
  render: () => inspector(RESOLVED, { locked: MATT_RESOLVED }),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const s = within(q);
      await expect(q.querySelector('[data-slot="inbox-inspector-lock"]')).not.toBeNull();
      await expect(s.queryByRole('textbox')).toBeNull();
      await expect(seenBar(q)).toBeUndefined();
      await expect(s.getByRole('button', { name: 'Reopen' })).toBeVisible();
      await expect(s.getByText(/Resolved by Matt Steinberg/)).toBeVisible();
    }
  },
};

/** The viewer filed it: the refusal said once, no lever. */
export const OwnTicket: Story = {
  render: () => inspector(OWN_TICKET),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(q.querySelectorAll('[data-slot="ticket-refusal"]')).toHaveLength(1);
      await expect(within(q).queryByRole('textbox')).toBeNull();
      await expect(seenBar(q)).toBeUndefined();
    }
  },
};

/** The person's account is going: never named, nothing linked. */
export const Gone: Story = {
  render: () => inspector(GONE),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(q).not.toHaveTextContent('Rob Tremblay');
      await expect(within(q).getAllByText('A former skater').length).toBeGreaterThan(0);
    }
  },
};

/** Filed before a profile: no one to name, nothing related. */
export const NoProfile: Story = {
  render: () => inspector(NO_PROFILE),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(
        within(q).getAllByText('Someone signed in, before their profile was made').length,
      ).toBeGreaterThan(0);
    }
  },
};

/** Long words wrap inside the thread; nothing pushes the pane sideways. */
export const LongWords: Story = {
  render: () => inspector(LONG_WORDS),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expectNoSidewaysScroll(must(q.querySelector<HTMLElement>('[data-pane="inspector"]')));
    }
  },
};

/** 2.8 at 360 px: one column, the dock under the thread, Resolve at the pane's foot. */
export const AtPhone: Story = {
  render: () =>
    pair(() => (
      <StoryTicketInspector item={ROB_APPEAL} onWrite={onWrite} width={360} height={800} narrow />
    )),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await layoutOf(q, 'stack');
      const pane = must(q.querySelector<HTMLElement>('[data-pane="inspector"]'));
      await waitFor(() => {
        const bar = must(seenBar(q));
        // The frame's bar, not the side's: it floats at the pane's foot, full width.
        expect(q.querySelector('[data-slot="ticket-side"] [role="toolbar"]')).toBeNull();
        const b = bar.getBoundingClientRect();
        const p = pane.getBoundingClientRect();
        expect(p.bottom - b.bottom).toBeLessThan(16);
      });
      await expectNoSidewaysScroll(pane);
    }
  },
};

const MOD = () => (modKey() === 'Meta' ? '{Meta>}{Enter}{/Meta}' : '{Control>}{Enter}{/Control}');

/** The keys: ⌘⏎ sends from the field, R resolves from the pane — never R typed in the field. */
export const Keys: Story = {
  render: () => pair(() => <StoryTicketInspector item={ROB_APPEAL} onWrite={onWrite} />),
  play: async ({ canvasElement }) => {
    const q = must(quads(canvasElement)[0]);
    const field = within(q).getByRole('textbox');
    await userEvent.click(field);
    await userEvent.keyboard('Thanks, reading now');
    await expect(onWrite).not.toHaveBeenCalled();
    await expect(field).toHaveValue('Thanks, reading now');
    await userEvent.keyboard(MOD());
    await waitFor(() =>
      expect(onWrite).toHaveBeenCalledWith({ act: 'reply', text: 'Thanks, reading now' }),
    );
    await waitFor(() => expect(field).toHaveValue(''));
    // Focus stays in the field after the send (a mail client's), ready for the next.
    await waitFor(() => expect(field).toHaveFocus());
    const pane = must(q.querySelector<HTMLElement>('[data-pane="inspector"]'));
    pane.focus();
    await waitFor(() => expect(pane).toHaveFocus());
    await userEvent.keyboard('r');
    await waitFor(() => expect(onWrite).toHaveBeenCalledWith({ act: 'resolve' }));
  },
};

/** A refused send keeps every word, and the field keeps its focus. */
export const RefusedKeepsDraft: Story = {
  render: () => pair(() => <StoryTicketInspector item={ROB_APPEAL} onWrite={onWrite} />),
  play: async ({ canvasElement }) => {
    onWrite.mockImplementation(async () => false);
    const q = must(quads(canvasElement)[0]);
    const field = within(q).getByRole('textbox');
    await userEvent.click(field);
    await userEvent.keyboard('Please hold');
    await userEvent.keyboard(MOD());
    await waitFor(() => expect(onWrite).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(field).toHaveValue('Please hold');
      expect(field).not.toHaveAttribute('readonly');
    });
  },
};
