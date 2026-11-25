import { MAX_SUPPORT_NOTE_LENGTH, MAX_SUPPORT_REPLY_LENGTH } from '@skating/core';
import { act, fireEvent, render, within } from '@testing-library/react';
import { useRef } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { KeysProvider, modKey } from '@/lib/keys';
import { stubJsdomAnimations } from '../../../body/tabs/jsdomStubs';
import { InspectorProvider } from '../../../inspector/inspectorContext';
import { TicketView, type TicketViewProps } from './TicketView';
import type { TicketDraft } from './ticketDrafts';
import {
  CANCEL_REFUSED,
  COLLEAGUE_SETTLING,
  EVERY_STATE,
  GONE,
  LONG_THREAD,
  LONG_WORDS,
  MANY_WHOLE,
  NO_PROFILE,
  NO_RESOLVE,
  NO_SENDER,
  NOTES_ONLY,
  OWN_TICKET,
  RELATED_CAPPED,
  ROB_APPEAL,
  SEED_TICKET,
  SUPPORT_FROM,
  TICKET_NOW,
  TICKET_TZ,
  UNANSWERED,
  WITH_SETTLING,
} from './ticketFixtures';
import type { TicketItem } from './ticketModel';

/**
 * **Board 2.8 from props** (jsdom): the thread in order with each reply's state, the cut line from
 * the server's flag, the dock's modes and caps from `can` and core, the person never named once
 * gone, every refusal said in place and never a button, and ⌘⏎ bound to the dock alone.
 */

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

const MOD = modKey() === 'Meta' ? { metaKey: true } : { ctrlKey: true };

function View({
  item,
  draft = { text: '', mode: 'reply', sending: false },
  ...over
}: Partial<TicketViewProps> & { item: TicketItem; draft?: TicketDraft }) {
  const pane = useRef<HTMLElement | null>(null);
  return (
    <section ref={pane} tabIndex={-1} data-pane="inspector" aria-label="Inspector">
      <InspectorProvider
        value={{ pane, decidedOnOpen: false, now: TICKET_NOW, timeZone: TICKET_TZ }}
      >
        <TicketView
          item={item}
          locked={null}
          now={TICKET_NOW}
          clock={TICKET_NOW}
          timeZone={TICKET_TZ}
          // biome-ignore lint/a11y/useAnchorContent: the view renders its label into it
          personLink={(id) => <a href={`/admin/people/${id}`} />}
          // biome-ignore lint/a11y/useAnchorContent: the view renders its label into it
          inboxAboutLink={(id) => <a href={`/admin/inbox?about=${id}`} />}
          // biome-ignore lint/a11y/useAnchorContent: the view renders its label into it
          itemLink={(ref) => <a href={`/admin/inbox?item=${ref}`} />}
          draft={draft}
          onDraftText={() => {}}
          onDraftMode={() => {}}
          onReply={() => {}}
          onNote={() => {}}
          onResolve={() => {}}
          onReopen={() => {}}
          onCancelReply={() => {}}
          onRemoveNote={() => {}}
          pending={null}
          pane={pane}
          {...over}
        />
      </InspectorProvider>
    </section>
  );
}

const draw = (props: Partial<TicketViewProps> & { item: TicketItem; draft?: TicketDraft }) =>
  render(<View {...props} />, { wrapper: KeysProvider });

const slots = (root: HTMLElement, slot: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`),
];

describe('the thread', () => {
  it('reads the ticket, then the note in the staff box, with the board’s ticket line', () => {
    const { container } = draw({ item: ROB_APPEAL });
    expect(slots(container, 'ticket-line')[0]).toHaveTextContent(
      'Ticket · 13 Oct 09:12 · from the app · Android 1.4.2',
    );
    const [body, note] = [
      ...container.querySelectorAll('[data-slot="ticket-body"], [data-slot="ticket-note"]'),
    ];
    expect(body).toHaveTextContent('Rob Tremblay');
    expect(note).toHaveAttribute('data-staff');
    expect(note).toHaveTextContent('Note · staff only');
    expect(note).toHaveTextContent('Matt Steinberg');
  });

  it('draws each reply’s state, never one that reads as sent unless it was', () => {
    const { container } = draw({ item: EVERY_STATE });
    const states = slots(container, 'ticket-reply').map((r) => [
      r.getAttribute('data-state'),
      within(r).getByText(/^(Sent|Canceled|Not sent|Sending)/).textContent,
    ]);
    expect(states).toEqual([
      ['sent', 'Sent · 13 Oct 12:06'],
      ['canceled', 'Canceled · never sent'],
      ['failed', 'Not sent · no sending address or email service is set up'],
      ['failed', 'Not sent · there is no email address for them'],
      ['failed', 'Not sent · the email service didn’t take it, or its send never ran'],
      ['failed', 'Not sent · a test person’s ticket: test people are never emailed'],
      // A send that stopped before saying how it went: neither sent nor not sent.
      ['unknown', 'Sending didn’t finish · it may or may not have been sent'],
    ]);
    // The removed note is a line, its words gone.
    expect(slots(container, 'ticket-note-removed')).toHaveLength(1);
    expect(container).not.toHaveTextContent('Wrong ticket.');
    // Nothing settling: no Cancel anywhere.
    expect(within(container).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('counts a settling reply down with its Cancel from the server’s `cancel`, whoever wrote it', () => {
    const onCancelReply = vi.fn();
    const mine = draw({ item: WITH_SETTLING, onCancelReply });
    const reply = slots(mine.container, 'ticket-reply')[0] as HTMLElement;
    expect(reply).toHaveTextContent('Sending in 42 s');
    fireEvent.click(within(reply).getByRole('button', { name: 'Cancel' }));
    expect(onCancelReply).toHaveBeenCalledWith(WITH_SETTLING.messages[1]?.messageId);
    mine.unmount();
    // A colleague's: anyone with support's write may cancel it (the founder's call).
    const theirs = draw({ item: COLLEAGUE_SETTLING });
    expect(within(theirs.container).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    theirs.unmount();
    // The server refuses this viewer: no Cancel, and no Remove on the note, whatever the state.
    const refused = draw({ item: CANCEL_REFUSED });
    expect(within(refused.container).queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(within(refused.container).queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(refused.container).toHaveTextContent('Sending in 42 s');
    refused.unmount();
    // Its minute is up but the send hasn't answered: no Cancel, and never "Sent".
    const late = draw({ item: WITH_SETTLING, clock: TICKET_NOW + 60_000 });
    expect(late.container).toHaveTextContent('Sending now');
    expect(within(late.container).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('says a cut thread from the server’s flag, never a long one that is whole', () => {
    const cut = draw({ item: LONG_THREAD });
    expect(slots(cut.container, 'ticket-cut')[0]).toHaveTextContent(
      'Showing the newest 100 of 100+ messages',
    );
    // Above the messages, under the ticket's words.
    const order = [
      ...cut.container.querySelectorAll(
        '[data-slot="ticket-body"], [data-slot="ticket-cut"], [data-slot="ticket-note"]',
      ),
    ].map((e) => e.getAttribute('data-slot'));
    expect(order.slice(0, 3)).toEqual(['ticket-body', 'ticket-cut', 'ticket-note']);
    cut.unmount();
    const whole = draw({ item: MANY_WHOLE });
    expect(slots(whole.container, 'ticket-cut')).toHaveLength(0);
    expect(slots(whole.container, 'ticket-note')).toHaveLength(100);
  });

  it('draws one message, and none', () => {
    const one = draw({ item: UNANSWERED });
    expect(one.container.querySelectorAll('[data-thread-message]')).toHaveLength(1);
    one.unmount();
    const two = draw({ item: ROB_APPEAL });
    expect(two.container.querySelectorAll('[data-thread-message]')).toHaveLength(2);
  });
});

describe('the person', () => {
  it('names them, their standing and Related, linked', () => {
    const { container } = draw({ item: ROB_APPEAL });
    const user = slots(container, 'ticket-user')[0] as HTMLElement;
    expect(user).toHaveTextContent('Rob Tremblay');
    expect(user).toHaveTextContent('Suspended');
    expect(user).toHaveTextContent('15 Oct · set by Matt Steinberg');
    expect(user).toHaveTextContent('14 · 2 counted by the contradiction check');
    expect(user).toHaveTextContent('Tickets2 · 1 resolved');
    const related = slots(container, 'ticket-related')[0] as HTMLElement;
    const links = within(related).getAllByRole('link', { name: /Inbox/ });
    // Each flag opens its own Inbox item, by the flag's id from the read.
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/admin/inbox?item=flag:f_rob_open',
      '/admin/inbox?item=flag:f_rob_actioned',
    ]);
    expect(related).toHaveTextContent('Unsafe false report flag');
    expect(related).toHaveTextContent('Actioned 11 Oct');
  });

  it('says a Related list and a ticket count the server cut, as floors and a way to the rest', () => {
    const { container } = draw({ item: RELATED_CAPPED });
    const related = slots(container, 'ticket-related')[0] as HTMLElement;
    expect(related).toHaveTextContent('More flags on them');
    expect(within(related).getAllByRole('link').at(-1)).toHaveAttribute(
      'href',
      `/admin/inbox?about=${ROB_APPEAL.person?.person.userId}`,
    );
    expect(slots(container, 'ticket-user')[0]).toHaveTextContent('Tickets50+ · 50+ resolved');
  });

  it('never names someone gone, links nothing about them, and says so', () => {
    const { container } = draw({ item: GONE });
    expect(container).not.toHaveTextContent('Rob Tremblay');
    expect(container).toHaveTextContent('A former skater');
    expect(within(container).queryByRole('link')).toBeNull();
    // The dock still reaches them by email, without a name.
    expect(container).toHaveTextContent('To the person who wrote in');
  });

  it('a ticket filed before a profile: no one to name, nothing related', () => {
    const { container } = draw({ item: NO_PROFILE });
    expect(container).toHaveTextContent('Someone signed in, before their profile was made');
    expect(container).not.toHaveTextContent('Tickets');
    expect(slots(container, 'ticket-related')).toHaveLength(0);
  });
});

describe('the levers, from can alone', () => {
  it('says a refusal once in place, never as a button', () => {
    const { container } = draw({ item: OWN_TICKET });
    expect(slots(container, 'ticket-refusal')).toHaveLength(1);
    expect(within(container).queryByRole('textbox')).toBeNull();
    expect(within(container).queryByRole('toolbar')).toBeNull();
  });

  it('draws the dock without Resolve where only resolve is refused', () => {
    const { container } = draw({ item: NO_RESOLVE });
    expect(within(container).getByRole('textbox')).toBeInTheDocument();
    expect(within(container).queryByRole('button', { name: /Resolve/ })).toBeNull();
    expect(slots(container, 'ticket-refusal')[0]).toHaveTextContent('Requires the support role');
  });

  it('with one mode, no picker', () => {
    const { container } = draw({ item: NOTES_ONLY });
    expect(within(container).queryByRole('button', { name: 'Reply by email' })).toBeNull();
    expect(within(container).getByRole('button', { name: /Add note/ })).toBeInTheDocument();
  });
});

describe('the dock', () => {
  it('says where a reply goes from and that their answer isn’t read; a note says who reads it', () => {
    const reply = draw({ item: ROB_APPEAL });
    expect(slots(reply.container, 'reply-dock-foot')[0]).toHaveTextContent(
      `Sent from ${SUPPORT_FROM}. Their answer by email isn’t read.`,
    );
    expect(slots(reply.container, 'reply-dock-to')[0]).toHaveTextContent('To Rob Tremblay');
    reply.unmount();
    const note = draw({ item: ROB_APPEAL, draft: { text: '', mode: 'note', sending: false } });
    expect(slots(note.container, 'reply-dock-foot')[0]).toHaveTextContent(
      'Seen only by staff who answer support.',
    );
    expect(slots(note.container, 'reply-dock-to')[0]).toHaveTextContent('Staff only');
  });

  it('with no sending address set up, says a reply won’t be sent, before it is written', () => {
    const { container } = draw({ item: NO_SENDER });
    expect(slots(container, 'ticket-no-sender')[0]).toHaveTextContent(
      'No sending address is set up, so a reply won’t be sent',
    );
    expect(container).not.toHaveTextContent('Sent from');
  });

  it('on a test person’s ticket, says a reply is saved and never emailed, before it is written', () => {
    const { container } = draw({ item: SEED_TICKET });
    const foot = slots(container, 'ticket-no-sender')[0];
    expect(foot).toHaveAttribute('data-blocked', 'seed');
    expect(foot).toHaveTextContent('never emailed');
    expect(container).not.toHaveTextContent('Sent from');
  });

  it('draws a note’s Remove from the server’s `remove`, by that note’s id', () => {
    const onRemoveNote = vi.fn();
    const { container } = draw({ item: ROB_APPEAL, onRemoveNote });
    fireEvent.click(within(container).getByRole('button', { name: 'Remove' }));
    expect(onRemoveNote).toHaveBeenCalledWith(ROB_APPEAL.messages[0]?.messageId);
  });

  it('takes each mode’s cap from core, and says words past it in place, the send held', () => {
    const reply = draw({ item: ROB_APPEAL });
    expect(within(reply.container).getByRole('textbox')).toHaveAttribute(
      'maxlength',
      String(MAX_SUPPORT_REPLY_LENGTH),
    );
    reply.unmount();
    const onNote = vi.fn();
    const long = 'x'.repeat(MAX_SUPPORT_NOTE_LENGTH + 5);
    const note = draw({
      item: ROB_APPEAL,
      draft: { text: long, mode: 'note', sending: false },
      onNote,
    });
    expect(within(note.container).getByRole('textbox')).toHaveAttribute(
      'maxlength',
      String(MAX_SUPPORT_NOTE_LENGTH),
    );
    expect(slots(note.container, 'reply-dock-check')[0]).toHaveTextContent(
      'A note holds 2,000 characters · this one is 2,005.',
    );
    const send = within(note.container).getByRole('button', { name: /Add note/ });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(onNote).not.toHaveBeenCalled();
  });

  it('⌘⏎ sends only from inside the dock, never from the pane’s other controls', async () => {
    const onReply = vi.fn();
    const { container } = draw({
      item: ROB_APPEAL,
      draft: { text: ' Hi ', mode: 'reply', sending: false },
      onReply,
    });
    const resolve = within(container).getByRole('button', { name: /Resolve/ });
    resolve.focus();
    fireEvent.keyDown(resolve, { key: 'Enter', code: 'Enter', ...MOD });
    await act(async () => {});
    expect(onReply).not.toHaveBeenCalled();
    const field = within(container).getByRole('textbox');
    field.focus();
    fireEvent.keyDown(field, { key: 'Enter', code: 'Enter', ...MOD });
    await act(async () => {});
    expect(onReply).toHaveBeenCalledWith('Hi');
  });

  it('is read-only while its send is out, and ⌘⏎ is inert then', async () => {
    const onReply = vi.fn();
    const { container } = draw({
      item: ROB_APPEAL,
      draft: { text: 'Hi', mode: 'reply', sending: false },
      onReply,
      pending: 'reply',
    });
    const field = within(container).getByRole('textbox');
    expect(field).toHaveAttribute('readonly');
    field.focus();
    fireEvent.keyDown(field, { key: 'Enter', code: 'Enter', ...MOD });
    await act(async () => {});
    expect(onReply).not.toHaveBeenCalled();
  });

  it('wraps long words rather than pushing the pane sideways', () => {
    const { container } = draw({ item: LONG_WORDS });
    expect(slots(container, 'thread-message-body')[0]?.className).toMatch(/break-words/);
  });
});
