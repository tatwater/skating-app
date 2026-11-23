import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  EVERY_STATE,
  GONE,
  LONG_THREAD,
  MANY_WHOLE,
  NO_PROFILE,
  NOTES_ONLY,
  OWN_TICKET,
  RESOLVED,
  ROB_APPEAL,
  SETTLING_REPLY,
  TICKET_NOW,
  TICKET_TZ,
} from './ticketFixtures';
import {
  askerName,
  askerShown,
  authorName,
  cutLine,
  dockModeOf,
  type FailedWhy,
  headTitle,
  leversOf,
  peopleTarget,
  type ReplyStatus,
  replyState,
  replyStateWords,
  threadOf,
  ticketLine,
} from './ticketModel';

describe('the head', () => {
  it('names the lane and the category, and links People only for someone here', () => {
    expect(headTitle(ROB_APPEAL)).toBe('Support · account');
    expect(peopleTarget(ROB_APPEAL)).toBe(ROB_APPEAL.person?.person.userId);
    expect(peopleTarget(GONE)).toBeNull();
    expect(peopleTarget(NO_PROFILE)).toBeNull();
  });

  it('says when and from where the ticket came, never the device block', () => {
    expect(ticketLine(ROB_APPEAL, TICKET_TZ)).toBe(
      'Ticket · 13 Oct 09:12 · from the app · Android 1.4.2',
    );
    expect(ticketLine({ ticket: { ...ROB_APPEAL.ticket, context: null } }, TICKET_TZ)).toBe(
      'Ticket · 13 Oct 09:12',
    );
    expect(
      ticketLine(
        { ticket: { ...ROB_APPEAL.ticket, context: { platform: 'web', appVersion: '2.0' } } },
        TICKET_TZ,
      ),
    ).toBe('Ticket · 13 Oct 09:12 · from the web · 2.0');
  });
});

describe('the thread', () => {
  it('reads the ticket first, then every message oldest to newest, whatever order it came in', () => {
    const entries = threadOf(EVERY_STATE);
    expect(entries[0]).toMatchObject({ kind: 'ticket', body: ROB_APPEAL.ticket.body });
    const times = entries.slice(1).map((e) => (e.kind === 'ticket' ? Number.NaN : e.msg.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(entries).toHaveLength(EVERY_STATE.messages.length + 1);
  });

  it('keeps the order served for messages written in the same instant', () => {
    const same = ROB_APPEAL.messages[0];
    if (same === undefined) throw new Error('fixture');
    const a = { ...same, messageId: 'm_a' as typeof same.messageId };
    const b = { ...same, messageId: 'm_b' as typeof same.messageId };
    const ids = threadOf({ ...ROB_APPEAL, messages: [a, b] }).flatMap((e) =>
      e.kind === 'ticket' ? [] : [e.msg.messageId],
    );
    expect(ids).toEqual(['m_a', 'm_b']);
  });

  it('draws a removed note as a line, never its words', () => {
    const removed = threadOf(EVERY_STATE).filter((e) => e.kind === 'removed');
    expect(removed).toHaveLength(1);
  });

  it('says the thread was cut from the server’s flag and count, never from its length', () => {
    expect(cutLine(LONG_THREAD)).toBe('Showing the newest 100 of 100+ messages');
    // A hundred messages, the read whole: nothing said.
    expect(cutLine(MANY_WHOLE)).toBeNull();
    expect(cutLine(ROB_APPEAL)).toBeNull();
    // A count below what arrived never reads as fewer than shown, and a cut count is a floor.
    expect(cutLine({ ...LONG_THREAD, messageCount: 10 })).toBe(
      'Showing the newest 100 of 100+ messages',
    );
  });
});

describe('names', () => {
  it('never names someone gone or going', () => {
    expect(askerName(ROB_APPEAL)).toBe('Rob Tremblay');
    expect(askerName(GONE)).toBe('A former skater');
    expect(askerShown(GONE)).toBeNull();
    expect(askerName(NO_PROFILE)).toBe('Someone signed in, before their profile was made');
    expect(askerShown(NO_PROFILE)).toBeNull();
    const deleted = {
      ...GONE,
      person: GONE.person && {
        ...GONE.person,
        standing: { status: 'deleted' as const, until: null, by: null },
      },
    };
    expect(askerShown(deleted)).toBeNull();
    expect(authorName(null)).toBe('A former staffer');
    const rob = ROB_APPEAL.person?.person;
    if (rob === undefined) throw new Error('fixture');
    expect(authorName({ ...rob, deleted: true })).toBe('A former staffer');
  });
});

describe('a reply’s state', () => {
  const reply = SETTLING_REPLY.reply;
  if (reply === null) throw new Error('fixture');

  it('counts down while it settles, with the viewer’s cancel, then reads sending — never sent', () => {
    expect(replyState(reply, TICKET_NOW)).toEqual({
      kind: 'settling',
      seconds: 42,
      canCancel: true,
    });
    // The server's sentence: no cancel for this viewer, whatever the countdown says.
    expect(replyState({ ...reply, cancel: 'Sent replies can’t be unsent.' }, TICKET_NOW)).toEqual({
      kind: 'settling',
      seconds: 42,
      canCancel: false,
    });
    expect(replyStateWords(replyState(reply, TICKET_NOW))).toBe('Sending in 42 s');
    expect(replyState(reply, reply.sendAfter)).toEqual({ kind: 'sending' });
    expect(replyStateWords(replyState(reply, reply.sendAfter + 5_000))).toBe('Sending now');
  });

  it('says a failed reply was not sent, and why, by class', () => {
    const words = (failedWhy: FailedWhy | null) =>
      replyStateWords(replyState({ ...reply, status: 'failed', failedWhy }, TICKET_NOW));
    expect(words('unconfigured')).toBe('Not sent · no sending address or email service is set up');
    expect(words('seed')).toMatch(/^Not sent · a test person/);
    expect(words('noAddress')).toBe('Not sent · there is no email address for them');
    expect(words('sendFailed')).toBe(
      'Not sent · the email service didn’t take it, or its send never ran',
    );
    // An outcome nobody knows is neither sent nor not sent.
    expect(words('outcomeUnknown')).toBe('Sending stopped · it may or may not have been sent');
    expect(words('outcomeUnknown')).not.toMatch(/^(Sent|Not sent)/);
    expect(words(null)).toBe('Not sent · the reason wasn’t recorded');
  });

  it('reads as sent only when the server said sent (property)', () => {
    const statuses: ReplyStatus[] = ['settling', 'sent', 'canceled', 'failed'];
    fc.assert(
      fc.property(
        fc.constantFrom(...statuses),
        fc.integer({ min: -10 * 60_000, max: 10 * 60_000 }),
        fc.option(fc.integer({ min: 0, max: 2 ** 41 }), { nil: null }),
        fc.constantFrom('unconfigured', 'seed', 'noAddress', 'sendFailed', null),
        (status, offset, sentAt, failedWhy) => {
          const words = replyStateWords(
            replyState(
              { ...reply, status, sentAt, failedWhy: failedWhy as never },
              reply.sendAfter + offset,
            ),
            TICKET_TZ,
          );
          expect(/^Sent\b/.test(words)).toBe(status === 'sent');
          if (status === 'failed') expect(words.startsWith('Not sent')).toBe(true);
          if (status === 'canceled') expect(words).toMatch(/never sent/);
        },
      ),
    );
  });

  it('writes the sent time in the reader’s zone', () => {
    const sent = replyState({ ...reply, status: 'sent', sentAt: reply.sendAfter }, TICKET_NOW);
    expect(replyStateWords(sent, TICKET_TZ)).toBe('Sent · 14 Oct 12:00');
    expect(replyStateWords({ kind: 'sent', at: null })).toBe('Sent');
  });
});

describe('the levers, from can alone', () => {
  it('draws a verb allowed, says a refusal once, and draws nothing for a verb absent', () => {
    expect(leversOf(ROB_APPEAL)).toEqual({
      modes: ['reply', 'note'],
      resolve: true,
      reopen: false,
      refusals: [],
    });
    expect(leversOf(OWN_TICKET)).toEqual({
      modes: [],
      resolve: false,
      reopen: false,
      refusals: ['You filed this ticket, so another staff member answers it.'],
    });
    expect(leversOf(RESOLVED)).toMatchObject({ modes: [], resolve: false, reopen: true });
    expect(leversOf(NOTES_ONLY).modes).toEqual(['note']);
    expect(leversOf({ can: {} })).toEqual({
      modes: [],
      resolve: false,
      reopen: false,
      refusals: [],
    });
  });

  it('keeps the mode chosen while it is allowed, else the first that is', () => {
    expect(dockModeOf('note', ['reply', 'note'])).toBe('note');
    expect(dockModeOf('reply', ['note'])).toBe('note');
    expect(dockModeOf('reply', [])).toBeNull();
  });
});
