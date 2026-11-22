import type { Id, TableNames } from '@skating/convex/dataModel';

import type { InboxItemView } from '../../list/inboxTypes';
import { at, BOARD_NOW, BOARD_ZONE, KATE, MATT, ROB, SARAH, TEAGAN } from '../Flag/flagFixtures';
import type { AuthorBlockData } from '../Flag/flagTypes';
import type { TicketItem, TicketMessage, TicketPerson } from './ticketModel';

/**
 * **Board 2.8's tickets, as `inbox.item` will return them** once S6 fills in the thread — for
 * stories and tests only (`fixturesStayInStories.test.ts`). The board's appeal from Rob Tremblay
 * with Matt's note, and every other state a ticket's thread and levers can be in, each with the
 * `can` its viewer would be answered.
 *
 * **Ids that would catch the wrong one.** Every id is distinct and named for what it is — the item
 * (`i_…`), the ticket (`tk_…`), the person (`p_…`), each message (`m_…`) — so a write sent with the
 * item's id, the person's or another ticket's fails its test; and the second ticket
 * ({@link KATE_BUG}) is the one a test opens *after* the first, so a write that kept the first
 * item's ids is caught.
 */

const id = <T extends TableNames>(s: string) => s as Id<T>;

export const TICKET_NOW = BOARD_NOW;
export const TICKET_TZ = BOARD_ZONE;
export const SUPPORT_FROM = 'support@skating.teaganatwater.com';

const ref = (p: typeof ROB): TicketPerson => ({
  userId: p.userId,
  displayName: p.displayName,
  username: p.username,
  deleted: p.deleted,
  isStaff: p.isStaff,
});

/** Rob, suspended until 15 Oct by Matt; 14 reports, 2 contradicted; one open flag. */
export const ROB_USER: AuthorBlockData = {
  person: ROB,
  standing: { status: 'suspended', until: at(10, 15, 12), by: ref(MATT) },
  reports: { count: 14, capped: false },
  contradicted: { count: 2, capped: false },
  contradictedReports: [],
  priorActioned: { count: 1, capped: false, lastAt: at(10, 11, 9) },
  openFlags: { count: 1, capped: false },
  restrictions: [],
};

/** Every verb an open ticket's viewer with support's write is allowed. */
export const OPEN_CAN = { reply: null, note: null, resolve: null };

let n = 0;
const message = (
  kind: 'note' | 'reply',
  author: typeof ROB,
  createdAt: number,
  body: string,
  reply: Partial<NonNullable<TicketMessage['reply']>> | null = null,
  removedAt: number | null = null,
): TicketMessage => ({
  messageId: `m_${kind}_${++n}`,
  kind,
  author: ref(author),
  body,
  createdAt,
  removedAt,
  reply:
    kind === 'note'
      ? null
      : {
          status: 'sent',
          sendAfter: createdAt + 60_000,
          sentAt: createdAt + 61_000,
          failedWhy: null,
          undo: null,
          ...reply,
        },
});

/** 2.8's note, as the board draws it. */
export const MATT_NOTE = message(
  'note',
  MATT,
  at(10, 13, 10, 20),
  'Suspended after the first unsafe flag was actioned on 11 Oct; that report is hidden. A second flag on his 10 Oct Mascoma report is still open in Safety. Decide that one there, not here.',
);

/** 2.8 as the board draws it: Rob's appeal and Matt's staff note. */
export const ROB_APPEAL = {
  itemId: id<'inboxItems'>('i_ticket_rob'),
  lane: 'support',
  facet: 'account',
  filedAt: at(10, 13, 9, 12),
  lastActivityAt: at(10, 13, 10, 20),
  memberCount: 1,
  memberCountIsFloor: false,
  can: OPEN_CAN,
  canCode: {},
  decided: null,
  kind: 'ticket',
  ticket: {
    ticketId: id<'supportTickets'>('tk_rob_appeal'),
    category: 'account',
    body: 'The suspension says my reports are false. I measured where I drilled, not where anyone else did. If I’m wrong about the south end, fine, but I didn’t lie and I want that off my account.',
    createdAt: at(10, 13, 9, 12),
    status: 'open',
    context: { platform: 'android', appVersion: '1.4.2', deviceModel: 'Pixel 8' },
    resolvedAt: null,
    resolvedBy: null,
  },
  messages: [MATT_NOTE],
  messagesCut: false,
  messageCount: { count: 1, capped: false },
  replyFrom: SUPPORT_FROM,
  person: ROB_USER,
} as unknown as TicketItem;

/** A ticket nobody has answered yet: its words alone. */
export const UNANSWERED = {
  ...ROB_APPEAL,
  messages: [],
  messageCount: { count: 0, capped: false },
} as TicketItem;

/** The viewer's own reply, 42 s from sending: its Cancel is its Undo. */
export const SETTLING_REPLY = message(
  'reply',
  TEAGAN,
  TICKET_NOW - 18_000,
  'Thanks for writing. The suspension lifts on its own on 15 Oct. The open flag on your Mascoma report is being reviewed separately and you’ll hear the outcome.',
  {
    status: 'settling',
    sendAfter: TICKET_NOW + 42_000,
    sentAt: null,
    undo: { actionId: 'ma_reply_rob' },
  },
);

export const WITH_SETTLING = {
  ...ROB_APPEAL,
  messages: [MATT_NOTE, SETTLING_REPLY],
  messageCount: { count: 2, capped: false },
} as TicketItem;

/** A colleague's reply settling: no Cancel for this viewer (the undo engine's own rule). */
export const COLLEAGUE_SETTLING = {
  ...ROB_APPEAL,
  messages: [
    MATT_NOTE,
    { ...SETTLING_REPLY, author: ref(SARAH), reply: { ...SETTLING_REPLY.reply, undo: null } },
  ],
} as TicketItem;

/** Every state a message can be in, in one thread (served out of order: the thread sorts it). */
export const EVERY_STATE = {
  ...ROB_APPEAL,
  messages: [
    message('reply', SARAH, at(10, 13, 14, 0), 'We’ve had a look, more soon.', {
      status: 'failed',
      failedWhy: 'unconfigured',
      sentAt: null,
    }),
    MATT_NOTE,
    message('reply', SARAH, at(10, 13, 12, 5), 'Thanks, we’re on it.', {
      status: 'sent',
      sentAt: at(10, 13, 12, 6),
    }),
    message('reply', MATT, at(10, 13, 12, 30), 'Sorry, ignore that.', {
      status: 'canceled',
      sentAt: null,
    }),
    message('note', MATT, at(10, 13, 13, 0), 'Wrong ticket.', null, at(10, 13, 13, 1)),
    message('reply', SARAH, at(10, 13, 15, 0), 'Checking.', {
      status: 'failed',
      failedWhy: 'noAddress',
      sentAt: null,
    }),
    message('reply', SARAH, at(10, 13, 16, 0), 'Again.', {
      status: 'failed',
      failedWhy: 'sendFailed',
      sentAt: null,
    }),
    message('reply', SARAH, at(10, 13, 17, 0), 'A test.', {
      status: 'failed',
      failedWhy: 'seed',
      sentAt: null,
    }),
  ],
  messageCount: { count: 8, capped: false },
} as TicketItem;

/** A busy ticket: the read served the newest 50 of 300+ and said it stopped short. */
export const LONG_THREAD = {
  ...ROB_APPEAL,
  messages: Array.from({ length: 50 }, (_, i) =>
    message(
      'note',
      i % 2 === 0 ? MATT : SARAH,
      at(10, 13, 10) + i * 60_000,
      `Checked again (${i + 1}).`,
    ),
  ),
  messagesCut: true,
  messageCount: { count: 300, capped: true },
} as TicketItem;

/** Many messages served, the read not cut: no cut line, whatever the length. */
export const MANY_WHOLE = {
  ...LONG_THREAD,
  messagesCut: false,
  messageCount: { count: 50, capped: false },
} as TicketItem;

/** No sending address is set up: the dock says a reply won't be sent, before it is written. */
export const NO_SENDER = { ...ROB_APPEAL, replyFrom: null } as TicketItem;

/** Resolved by Matt: the lock, no dock, no Resolve; Reopen where `can` allows. */
export const RESOLVED = {
  ...ROB_APPEAL,
  can: { reopen: null },
  decided: {
    at: at(10, 13, 11),
    by: { userId: MATT.userId, displayName: MATT.displayName },
    decision: 'resolved',
    actionId: id<'moderationActions'>('ma_resolve_rob'),
    byMe: false,
  },
  ticket: {
    ...ROB_APPEAL.ticket,
    status: 'resolved',
    resolvedAt: at(10, 13, 11),
    resolvedBy: ref(MATT),
  },
} as unknown as TicketItem;

/** The viewer filed the ticket themselves (D289): every verb refused in one sentence, said once. */
export const OWN_TICKET = {
  ...ROB_APPEAL,
  can: {
    reply: 'You filed this ticket, so another staff member answers it.',
    note: 'You filed this ticket, so another staff member answers it.',
    resolve: 'You filed this ticket, so another staff member answers it.',
  },
} as TicketItem;

/** A viewer who may answer but not resolve: the dock, no Resolve, the refusal said. */
export const NO_RESOLVE = {
  ...ROB_APPEAL,
  can: { reply: null, note: null, resolve: 'Requires the support role' },
} as TicketItem;

/** Notes only: the picker isn't drawn, the dock is the note's. */
export const NOTES_ONLY = { ...ROB_APPEAL, can: { note: null, resolve: null } } as TicketItem;

/** Filed before the person's profile was made: nobody to name, nothing related to list. */
export const NO_PROFILE = { ...UNANSWERED, person: null } as TicketItem;

/** Rob's account is being deleted: never named, nothing linked. */
export const GONE = {
  ...ROB_APPEAL,
  person: {
    ...ROB_USER,
    person: { ...ROB, deleted: true },
    standing: { status: 'leaving', until: null, by: null },
  },
} as TicketItem;

/** A long body and a long word: the thread wraps, never pushes the pane sideways. */
export const LONG_WORDS = {
  ...UNANSWERED,
  ticket: {
    ...ROB_APPEAL.ticket,
    body: `${'The map stays blank after the update. '.repeat(12)}\nhttps://example.invalid/${'a'.repeat(180)}`,
  },
} as TicketItem;

/** Kate's bug ticket — the second item a test opens, every id its own. */
export const KATE_BUG = {
  ...UNANSWERED,
  itemId: id<'inboxItems'>('i_ticket_kate'),
  facet: 'bug',
  ticket: {
    ...ROB_APPEAL.ticket,
    ticketId: id<'supportTickets'>('tk_kate_bug'),
    category: 'bug',
    body: 'Map blank after the update.',
    context: { platform: 'ios', appVersion: '1.4.2' },
  },
  person: {
    ...ROB_USER,
    person: KATE,
    standing: { status: 'active', until: null, by: null },
    openFlags: { count: 0, capped: false },
    priorActioned: { count: 0, capped: false, lastAt: null },
  },
} as TicketItem;

/** As the Inbox's list read hands the item (the published variant). */
export const asItem = (t: TicketItem) => t as unknown as InboxItemView;
