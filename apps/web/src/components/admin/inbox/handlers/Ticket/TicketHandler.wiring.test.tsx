import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toaster } from '@/components/kit/toast';
import { KeysProvider, modKey } from '@/lib/keys';
import { stubJsdomAnimations } from '../../../body/tabs/jsdomStubs';
import { UndoProvider } from '../../../shell/undo';
import { LANES } from '../../list/inboxFixtures';
import type { InboxItemView } from '../../list/inboxTypes';
import {
  harness as h,
  installInboxRouteMocks,
  must,
  resetHarness,
} from '../../testing/routeHarness';
import { forgetTicketDrafts } from './ticketDrafts';
import {
  asItem,
  KATE_BUG,
  RESOLVED,
  ROB_APPEAL,
  TICKET_NOW,
  WITH_SETTLING,
} from './ticketFixtures';
import type { TicketItem } from './ticketModel';

/**
 * **The ticket handler through the real route and view** (the shared harness: only the router, the
 * role and the read layer stood in, plus the mutations and the undo server): a `ticket` item opens
 * this handler, not the placeholder; *Send reply* (and ⌘⏎), *Add note*, *Resolve* (and R) and
 * *Reopen* each call their write with the open item's ticket id — never the item's own id, the
 * person's, or the ticket opened before; a settling reply's *Cancel* and a note's *Remove* call
 * `support.cancelReply` / `support.removeNote` with that message's own id; a refusal reaches a toast in the server's words and keeps the draft; a
 * resolved ticket drops the bar and the dock; a viewer without support's read sees no lever.
 */

// ── What the harness doesn't stand in ────────────────────────────────────────────────────────
const writes = vi.hoisted(() => ({
  calls: [] as { name: string; args: Record<string, unknown> }[],
  /** A write's answer by name; throws to refuse. */
  answer: {} as Record<string, (args: Record<string, unknown>) => unknown>,
}));
const undos = vi.hoisted(() => ({ run: [] as { actionId: string; reason?: string }[] }));

vi.doMock('convex/react', async (orig) => ({
  ...(await orig<typeof import('convex/react')>()),
  useMutation: (ref: never) => {
    const name = getFunctionName(ref);
    return async (args: Record<string, unknown>) => {
      writes.calls.push({ name, args });
      const answer = writes.answer[name];
      return answer
        ? answer(args)
        : {
            ...args,
            messageId: 'm_new',
            actionId: 'ma_wired',
            undoable: true,
            undoNeedsReason: false,
          };
    };
  },
}));

const { Route } = await installInboxRouteMocks();

const ui = () => (
  <Toaster>
    <UndoProvider
      server={{
        latestOwn: async () => null,
        run: async (args) => {
          undos.run.push(args);
        },
      }}
    >
      <Route />
    </UndoProvider>
  </Toaster>
);
const mount = () => render(ui(), { wrapper: KeysProvider });

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: () =>
      ({
        cancel() {},
        pause() {},
        play() {},
        currentTime: 0,
        finished: Promise.resolve(),
      }) as unknown as Animation,
  });
  stubJsdomAnimations();
});

const open = (item: TicketItem) => {
  h.lanes = LANES;
  h.search = { lane: 'support', item: item.itemId };
  h.answers['inbox:item'] = () => ({ item: asItem(item), pending: false });
};

beforeEach(() => {
  resetHarness();
  writes.calls = [];
  writes.answer = {};
  undos.run = [];
  forgetTicketDrafts();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllTimers();
});

const inspector = () =>
  must(document.querySelector<HTMLElement>('[data-pane="detail"]'), 'the inspector');
const called = (name: string) => writes.calls.filter((c) => c.name === name);
/** ⌘ on a Mac, Ctrl elsewhere — as the keys layer reads the platform. */
const MOD = modKey() === 'Meta' ? { metaKey: true } : { ctrlKey: true };
const field = () => within(inspector()).getByRole('textbox');
const type = (text: string) => fireEvent.change(field(), { target: { value: text } });

describe('a ticket, through the route and the view', () => {
  it('opens the ticket handler, not the placeholder, with the item read by its ref', () => {
    open(ROB_APPEAL);
    mount();
    expect(inspector().querySelector('[data-slot="ticket-handler"]')).not.toBeNull();
    expect(inspector().querySelector('[data-slot="inbox-placeholder-facts"]')).toBeNull();
    expect(h.asked.some((a) => a.name === 'inbox:item' && a.args.ref === ROB_APPEAL.itemId)).toBe(
      true,
    );
    // The thread: the ticket's words, then Matt's note in the staff box.
    expect(within(inspector()).getByText(/The suspension says my reports are false/)).toBeVisible();
    expect(inspector().querySelector('[data-slot="ticket-note"][data-staff]')).not.toBeNull();
  });

  it('Send reply calls support.reply with the ticket’s id and the trimmed words, then clears them', async () => {
    open(ROB_APPEAL);
    mount();
    type('  Thanks for writing.  ');
    fireEvent.click(within(inspector()).getByRole('button', { name: /Send reply/ }));
    await waitFor(() =>
      expect(called('support:reply')).toEqual([
        {
          name: 'support:reply',
          args: {
            ticketId: ROB_APPEAL.ticket.ticketId,
            body: 'Thanks for writing.',
            clientKey: expect.any(String),
          },
        },
      ]),
    );
    // Never the item's own id or the person's.
    expect(called('support:reply')[0]?.args.ticketId).not.toBe(ROB_APPEAL.itemId);
    await waitFor(() => expect(field()).toHaveValue(''));
    expect(writes.calls.map((c) => c.name)).toEqual(['support:reply']);
  });

  it('⌘⏎ in the field sends; an empty field sends nothing', async () => {
    open(ROB_APPEAL);
    mount();
    fireEvent.keyDown(field(), { key: 'Enter', code: 'Enter', ...MOD });
    await act(async () => {});
    expect(writes.calls).toEqual([]);
    type('On it.');
    field().focus();
    fireEvent.keyDown(field(), { key: 'Enter', code: 'Enter', ...MOD });
    await waitFor(() => expect(called('support:reply')).toHaveLength(1));
    expect(called('support:reply')[0]?.args).toEqual({
      ticketId: ROB_APPEAL.ticket.ticketId,
      body: 'On it.',
      clientKey: expect.any(String),
    });
  });

  it('Note mode calls support.addNote with the ticket’s id', async () => {
    open(ROB_APPEAL);
    mount();
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Note' }));
    type('Checked his reports.');
    fireEvent.click(within(inspector()).getByRole('button', { name: /Add note/ }));
    await waitFor(() =>
      expect(called('support:addNote')).toEqual([
        {
          name: 'support:addNote',
          args: {
            ticketId: ROB_APPEAL.ticket.ticketId,
            body: 'Checked his reports.',
            clientKey: expect.any(String),
          },
        },
      ]),
    );
    expect(called('support:reply')).toEqual([]);
  });

  it('Resolve (the button and R) calls support.resolve with the ticket’s id', async () => {
    open(ROB_APPEAL);
    mount();
    fireEvent.click(within(inspector()).getByRole('button', { name: /Resolve/ }));
    await waitFor(() =>
      expect(called('support:resolve')).toEqual([
        { name: 'support:resolve', args: { ticketId: ROB_APPEAL.ticket.ticketId } },
      ]),
    );
    // R in the pane does the same; never while typing in the field.
    field().focus();
    fireEvent.keyDown(field(), { key: 'r', code: 'KeyR' });
    await act(async () => {});
    expect(called('support:resolve')).toHaveLength(1);
    inspector().focus();
    fireEvent.keyDown(inspector(), { key: 'r', code: 'KeyR' });
    await waitFor(() => expect(called('support:resolve')).toHaveLength(2));
  });

  it('a reply still out stays out across leaving and coming back: one call, the dock busy', async () => {
    // The reviewer's probe: hold the reply open, pass through loading both ways (Rob → Kate → Rob),
    // press again — the store, not the remounted handler, knows a send is out for Rob's ticket.
    let release: (answer: unknown) => void = () => {};
    writes.answer['support:reply'] = (args) =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            ...args,
            messageId: 'm_new',
            actionId: 'ma_wired',
            undoable: true,
            undoNeedsReason: false,
            status: 'settling',
          });
      });
    const byRef: Record<string, InboxItemView> = {
      [ROB_APPEAL.itemId]: asItem(ROB_APPEAL),
      [KATE_BUG.itemId]: asItem(KATE_BUG),
    };
    let loading = false;
    h.lanes = LANES;
    h.search = { lane: 'support', item: ROB_APPEAL.itemId };
    h.answers['inbox:item'] = (args) =>
      loading ? undefined : { item: byRef[args.ref as string] ?? null, pending: false };
    const page = mount();
    type('Thanks for writing.');
    fireEvent.click(within(inspector()).getByRole('button', { name: /Send reply/ }));
    await waitFor(() => expect(called('support:reply')).toHaveLength(1));
    // Away through loading to Kate, and back through loading to Rob.
    for (const item of [KATE_BUG.itemId, ROB_APPEAL.itemId]) {
      loading = true;
      h.search = { lane: 'support', item };
      page.rerender(ui());
      loading = false;
      page.rerender(ui());
    }
    await waitFor(() => expect(field()).toHaveValue('Thanks for writing.'));
    // Still out: the dock is busy for this ticket, and neither the button nor ⌘⏎ sends again.
    expect(field()).toHaveAttribute('readonly');
    fireEvent.click(within(inspector()).getByRole('button', { name: /Send reply/ }));
    field().focus();
    fireEvent.keyDown(field(), { key: 'Enter', code: 'Enter', ...MOD });
    expect(called('support:reply')).toHaveLength(1);
    // It lands: the words that went are cleared, and the dock is free again.
    await act(async () => release(undefined));
    await waitFor(() => expect(field()).toHaveValue(''));
    expect(field()).not.toHaveAttribute('readonly');
    expect(called('support:reply')).toHaveLength(1);
  });

  it('a refused press retried with the same words reuses its key; new words take a new one', async () => {
    let refuse = true;
    writes.answer['support:reply'] = (args) => {
      if (refuse) throw new ConvexError('Try again in a moment.');
      return { ...args, messageId: 'm_new', actionId: 'ma_wired', undoable: false };
    };
    open(ROB_APPEAL);
    mount();
    type('Same words');
    fireEvent.click(within(inspector()).getByRole('button', { name: /Send reply/ }));
    await waitFor(() => expect(called('support:reply')).toHaveLength(1));
    await waitFor(() => expect(field()).not.toHaveAttribute('readonly'));
    fireEvent.click(within(inspector()).getByRole('button', { name: /Send reply/ }));
    await waitFor(() => expect(called('support:reply')).toHaveLength(2));
    const [first, second] = called('support:reply').map((c) => c.args.clientKey);
    expect(first).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(second).toBe(first);
    await waitFor(() => expect(field()).not.toHaveAttribute('readonly'));
    type('Other words');
    refuse = false;
    fireEvent.click(within(inspector()).getByRole('button', { name: /Send reply/ }));
    await waitFor(() => expect(called('support:reply')).toHaveLength(3));
    expect(called('support:reply')[2]?.args.clientKey).not.toBe(first);
  });

  it('sends the open item’s ids, never the ticket opened before it', async () => {
    const byRef: Record<string, InboxItemView> = {
      [ROB_APPEAL.itemId]: asItem(ROB_APPEAL),
      [KATE_BUG.itemId]: asItem(KATE_BUG),
    };
    h.lanes = LANES;
    h.search = { lane: 'support', item: ROB_APPEAL.itemId };
    h.answers['inbox:item'] = (args) => ({
      item: byRef[args.ref as string] ?? null,
      pending: false,
    });
    const page = mount();
    type('For Rob');
    h.search = { lane: 'support', item: KATE_BUG.itemId };
    page.rerender(ui());
    // Kate's ticket opens with its own (empty) draft; Rob's words wait on his.
    await waitFor(() => expect(field()).toHaveValue(''));
    type('For Kate');
    fireEvent.click(within(inspector()).getByRole('button', { name: /Send reply/ }));
    await waitFor(() => expect(called('support:reply')).toHaveLength(1));
    expect(called('support:reply')[0]?.args).toEqual({
      ticketId: KATE_BUG.ticket.ticketId,
      body: 'For Kate',
      clientKey: expect.any(String),
    });
    fireEvent.click(within(inspector()).getByRole('button', { name: /Resolve/ }));
    await waitFor(() => expect(called('support:resolve')).toHaveLength(1));
    expect(called('support:resolve')[0]?.args).toEqual({ ticketId: KATE_BUG.ticket.ticketId });
    // Back on Rob's ticket, his draft is still there.
    h.search = { lane: 'support', item: ROB_APPEAL.itemId };
    page.rerender(ui());
    await waitFor(() => expect(field()).toHaveValue('For Rob'));
  });

  it('a refused reply reaches a toast in the server’s words, never the pane, and keeps the draft', async () => {
    open(ROB_APPEAL);
    writes.answer['support:reply'] = () => {
      throw new ConvexError('This ticket was resolved a moment ago.');
    };
    mount();
    type('Thanks for writing.');
    fireEvent.click(within(inspector()).getByRole('button', { name: /Send reply/ }));
    await waitFor(() =>
      expect(
        screen.getAllByText('The reply: This ticket was resolved a moment ago.').length,
      ).toBeGreaterThan(0),
    );
    expect(within(inspector()).queryByText(/resolved a moment ago/)).toBeNull();
    expect(field()).toHaveValue('Thanks for writing.');
  });

  it('a refused resolve reaches a toast in the server’s words', async () => {
    open(ROB_APPEAL);
    writes.answer['support:resolve'] = () => {
      throw new ConvexError('This has already been decided.');
    };
    mount();
    fireEvent.click(within(inspector()).getByRole('button', { name: /Resolve/ }));
    await waitFor(() =>
      expect(
        screen.getAllByText('The decision: This has already been decided.').length,
      ).toBeGreaterThan(0),
    );
    expect(within(inspector()).queryByText(/already been decided/)).toBeNull();
  });

  it('a draft outlives the dock: resolved under the moderator, then reopened, it comes back', async () => {
    let item: TicketItem = ROB_APPEAL;
    h.lanes = LANES;
    h.search = { lane: 'support', item: ROB_APPEAL.itemId };
    h.answers['inbox:item'] = () => ({ item: asItem(item), pending: false });
    const page = mount();
    type('Half a thought');
    item = RESOLVED;
    page.rerender(ui());
    await waitFor(() => expect(within(inspector()).queryByRole('textbox')).toBeNull());
    item = ROB_APPEAL;
    page.rerender(ui());
    await waitFor(() => expect(field()).toHaveValue('Half a thought'));
  });

  it('a settling reply’s Cancel calls support.cancelReply with that reply’s own id', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: TICKET_NOW });
    open(WITH_SETTLING);
    mount();
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(called('support:cancelReply')).toEqual([
        {
          name: 'support:cancelReply',
          args: { messageId: WITH_SETTLING.messages[1]?.messageId },
        },
      ]),
    );
    expect(undos.run).toEqual([]);
  });

  it('a note’s Remove calls support.removeNote with that note’s id; a refusal is a toast', async () => {
    open(ROB_APPEAL);
    writes.answer['support:removeNote'] = () => {
      throw new ConvexError('This note was already removed.');
    };
    mount();
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(called('support:removeNote')).toEqual([
        { name: 'support:removeNote', args: { messageId: ROB_APPEAL.messages[0]?.messageId } },
      ]),
    );
    await waitFor(() =>
      expect(
        screen.getAllByText('Removing the note: This note was already removed.').length,
      ).toBeGreaterThan(0),
    );
    expect(within(inspector()).queryByText(/already removed/)).toBeNull();
  });

  it.each([
    {
      status: 'settling' as const,
      failedWhy: null,
      says: 'It sends in about a minute unless it is canceled',
      never: 'Reply saved, not sent',
    },
    {
      status: 'failed' as const,
      failedWhy: 'seed' as const,
      says: 'It won’t be emailed: a test person’s ticket: test people are never emailed',
      never: 'It sends in about a minute unless it is canceled',
    },
  ])(
    'a reply’s receipt is what support.reply answered ($status)',
    async ({ status, failedWhy, says, never }) => {
      // Through the real useTicketWrites: the toast reads the write's own answer, not the item.
      writes.answer['support:reply'] = (args) => ({
        ...args,
        messageId: 'm_new',
        actionId: 'ma_wired',
        undoable: status === 'settling',
        undoNeedsReason: false,
        status,
        failedWhy,
      });
      open(ROB_APPEAL);
      mount();
      type('Thanks for writing.');
      fireEvent.click(within(inspector()).getByRole('button', { name: /Send reply/ }));
      await waitFor(() => expect(screen.getAllByText(says).length).toBeGreaterThan(0));
      expect(screen.queryByText(never)).toBeNull();
    },
  );

  it('Cancel’s and Reopen’s controls go with their write: focus moves to the pane, never the page', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: TICKET_NOW });
    let item: TicketItem = WITH_SETTLING;
    h.lanes = LANES;
    h.search = { lane: 'support', item: item.itemId };
    h.answers['inbox:item'] = () => ({ item: asItem(item), pending: false });
    const page = mount();
    const cancel = within(inspector()).getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.click(cancel);
    await waitFor(() => expect(called('support:cancelReply')).toHaveLength(1));
    // The read redraws the reply canceled: its Cancel is gone, with focus on it.
    const settling = must(WITH_SETTLING.messages[1], 'the settling reply');
    item = {
      ...WITH_SETTLING,
      messages: [
        must(WITH_SETTLING.messages[0], 'the note'),
        {
          ...settling,
          reply: {
            ...must(settling.reply, 'its reply'),
            status: 'canceled',
            cancel: 'This reply was already canceled.',
          },
        },
      ],
    };
    page.rerender(ui());
    await waitFor(() => expect(inspector()).toHaveFocus());
    vi.useRealTimers();
    // Reopen: its button goes once the ticket reads open again.
    item = RESOLVED;
    page.rerender(ui());
    const reopen = await within(inspector()).findByRole('button', { name: 'Reopen' });
    reopen.focus();
    fireEvent.click(reopen);
    await waitFor(() => expect(called('support:reopen')).toHaveLength(1));
    item = ROB_APPEAL;
    page.rerender(ui());
    await waitFor(() =>
      expect(within(inspector()).queryByRole('button', { name: 'Reopen' })).toBeNull(),
    );
    await waitFor(() => expect(inspector()).toHaveFocus());
  });

  it('a resolved ticket drops the bar and the dock, and Reopen calls support.reopen', async () => {
    open(RESOLVED);
    mount();
    expect(within(inspector()).queryByRole('toolbar')).toBeNull();
    expect(within(inspector()).queryByRole('textbox')).toBeNull();
    expect(inspector().querySelector('[data-slot="inbox-inspector-lock"]')).not.toBeNull();
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Reopen' }));
    await waitFor(() =>
      expect(called('support:reopen')).toEqual([
        { name: 'support:reopen', args: { ticketId: RESOLVED.ticket.ticketId } },
      ]),
    );
  });

  it('a viewer without support’s read gets the refusal’s words and no lever, and asks nothing', () => {
    open(ROB_APPEAL);
    h.search = { lane: 'support', item: `ticket:${ROB_APPEAL.ticket.ticketId}` };
    h.can = (c) => c !== 'inbox.support.read' && c !== 'inbox.support';
    mount();
    expect(inspector().querySelector('[data-slot="ticket-handler"]')).toBeNull();
    expect(within(inspector()).queryByRole('textbox')).toBeNull();
    expect(within(inspector()).queryByRole('button', { name: /Resolve|Send reply/ })).toBeNull();
    expect(h.asked.some((a) => a.name === 'inbox:item' && a.args.ref !== null)).toBe(false);
  });

  it('an item served with no verbs draws no lever', () => {
    open({ ...ROB_APPEAL, can: {} } as TicketItem);
    mount();
    expect(within(inspector()).queryByRole('textbox')).toBeNull();
    expect(within(inspector()).queryByRole('toolbar')).toBeNull();
    expect(within(inspector()).queryByRole('button', { name: /Reopen|Resolve/ })).toBeNull();
  });
});
