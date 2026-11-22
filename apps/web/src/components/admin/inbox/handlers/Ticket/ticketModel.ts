import { ageInWords } from '@/lib/ages';
import { shownName } from '../../blocks/shownName';
import type { InboxItemView } from '../../list/inboxTypes';
import { TICKET_CHIP } from '../../words/inboxWords';
import { dayTime } from '../Flag/flagFormat';
import { TICKET_WORDS as W } from './ticketWords';

/**
 * **What board 2.8 draws, as data** — the ticket item the handler is handed, and the pure rules over
 * it: the thread in order, each reply's state, the cut line, the levers from `can`, the dock's modes.
 *
 * **The item, as the server will serve it.** `inbox.item`'s `ticket` variant is the published
 * contract; S6 fills in its `messages` (B01-5f). Until that lands, what this handler reads past the
 * published type is typed here ({@link TicketItem}) and built on fixtures — each field a server ask
 * the integrator wires to the real read:
 *
 * - each message's `removedAt`, and for a reply its `failedWhy` (the stored class) and `undo` (its
 *   audit row, when this viewer may cancel it now — the undo engine's own answer);
 * - `messagesCut` and `messageCount`: the thread is bounded (the newest N), and the cut line says so
 *   from the server's flag and count, never from the list's length;
 * - `replyFrom`: the support address a reply is sent from, `null` while it is unset (then a reply
 *   reads *Not sent*, and the dock says so before it is written).
 */

type ServerTicket = Extract<InboxItemView, { kind: 'ticket' }>;

/** A person as the thread names them (the server's `PersonRefView`). */
export type TicketPerson = NonNullable<ServerTicket['ticket']['resolvedBy']>;

export type ReplyStatus = 'settling' | 'sent' | 'canceled' | 'failed';

/** Why a reply wasn't sent — the stored class, never an address or the provider's words. */
export type FailedWhy = 'unconfigured' | 'seed' | 'noAddress' | 'sendFailed';

/** A note or a reply on the ticket. */
export type TicketMessage = {
  messageId: string;
  kind: 'note' | 'reply';
  author: TicketPerson | null;
  body: string;
  createdAt: number;
  /** Taken back (a note's Undo): drawn as a line, its words never shown. */
  removedAt: number | null;
  reply: {
    status: ReplyStatus;
    sendAfter: number;
    sentAt: number | null;
    failedWhy: FailedWhy | null;
    /** The reply's audit row, when this viewer may cancel it now (the undo engine's rule). */
    undo: { actionId: string } | null;
  } | null;
};

/** The ticket item as the handler draws it: the published variant, its thread filled in. */
export type TicketItem = Omit<ServerTicket, 'messages'> & {
  /** Oldest first: the newest the read holds, drawn oldest to newest. */
  messages: TicketMessage[];
  /** The read stopped short of the whole thread (the server's own word). */
  messagesCut: boolean;
  /** How many messages the thread holds; `capped` past the count's own bound ("300+"). */
  messageCount: { count: number; capped: boolean };
  /** The support address replies are sent from; `null` while none is set up. */
  replyFrom: string | null;
};

// ── The head ─────────────────────────────────────────────────────────────────────────────────

/** "Support · account". */
export const headTitle = (item: Pick<TicketItem, 'ticket'>): string =>
  W.title(TICKET_CHIP[item.ticket.category]);

/** The head's age, written out ("4 days ago"). */
export const headAge = (item: Pick<TicketItem, 'ticket'>, now: number): string =>
  ageInWords(item.ticket.createdAt, now);

/** The person's People page, when they have one to open (never a departed person's). */
export function peopleTarget(item: Pick<TicketItem, 'person'>): string | null {
  const p = item.person?.person;
  return p == null || p.deleted || item.person?.standing.status === 'deleted' ? null : p.userId;
}

// ── The thread ───────────────────────────────────────────────────────────────────────────────

/** "Ticket · 13 Oct 09:12 · from the app · Android 1.4.2". */
export function ticketLine(item: Pick<TicketItem, 'ticket'>, timeZone?: string): string {
  const { context, createdAt } = item.ticket;
  const parts: string[] = [W.ticketLine, dayTime(createdAt, timeZone)];
  if (context !== null) {
    const web = context.platform?.toLowerCase() === 'web';
    parts.push(web ? W.fromTheWeb : W.fromTheApp);
    const build = [web ? null : (context.platform ?? null), context.appVersion ?? null]
      .filter((s): s is string => s !== null && s.trim() !== '')
      .map(platformWord)
      .join(' ');
    if (build !== '') parts.push(build);
  }
  return parts.join(' · ');
}

/** "android" → "Android", "ios" → "iOS"; anything else as written. */
function platformWord(s: string): string {
  const k = s.toLowerCase();
  return k === 'android' ? 'Android' : k === 'ios' ? 'iOS' : s;
}

/** One entry of the thread, oldest first: the ticket's own words, then each message. */
export type ThreadEntry =
  | { kind: 'ticket'; at: number; body: string }
  | { kind: 'message'; message: TicketMessage }
  | { kind: 'removed'; message: TicketMessage };

/**
 * The thread in the order it is read: the ticket's body first, then every message oldest to newest
 * (by when it was written, ties kept in the order served). A removed note is a line, never its words.
 */
export function threadOf(item: Pick<TicketItem, 'ticket' | 'messages'>): ThreadEntry[] {
  const messages = item.messages
    .map((message, i) => ({ message, i }))
    .sort((a, b) => a.message.createdAt - b.message.createdAt || a.i - b.i)
    .map(
      ({ message }): ThreadEntry =>
        message.removedAt !== null ? { kind: 'removed', message } : { kind: 'message', message },
    );
  return [{ kind: 'ticket', at: item.ticket.createdAt, body: item.ticket.body }, ...messages];
}

/**
 * The cut line over the messages: from the server's own word that it stopped short, set against
 * its count — never inferred from how many arrived. `null` when the thread is whole.
 */
export function cutLine(
  item: Pick<TicketItem, 'messages' | 'messagesCut' | 'messageCount'>,
): string | null {
  if (item.messagesCut !== true) return null;
  const shown = item.messages.length;
  const total = item.messageCount;
  return total === undefined || total === null
    ? W.shownNewest(shown)
    : W.shownOf(shown, Math.max(total.count, shown), total.capped);
}

/** Who wrote in, as the thread names them: their name, or the words for someone gone. */
export function askerName(item: Pick<TicketItem, 'person'>): string {
  if (item.person === null) return W.noProfile;
  const gone = item.person.standing.status === 'deleted';
  return (gone ? null : shownName(item.person.person)) ?? W.formerSkater;
}

/** Who wrote a note or reply: their name, or the words for a staffer gone. */
export const authorName = (author: TicketPerson | null): string =>
  shownName(author) ?? W.formerStaff;

/** Whether the asker may be named at all (a dock's "To ‹name›"). */
export function askerShown(item: Pick<TicketItem, 'person'>): string | null {
  if (item.person === null || item.person.standing.status === 'deleted') return null;
  return shownName(item.person.person);
}

// ── A reply's state ──────────────────────────────────────────────────────────────────────────

export type ReplyState =
  /** Waiting out its minute: the seconds left, and whether this viewer may cancel it. */
  | { kind: 'settling'; seconds: number; cancel: { actionId: string } | null }
  /** Its minute is up and the send hasn't answered yet: no cancel offered. */
  | { kind: 'sending' }
  | { kind: 'sent'; at: number | null }
  | { kind: 'canceled' }
  | { kind: 'failed'; why: FailedWhy | null };

/** A reply's state at `now`: never anything that reads as sent unless the server said `sent`. */
export function replyState(reply: NonNullable<TicketMessage['reply']>, now: number): ReplyState {
  switch (reply.status) {
    case 'settling': {
      const left = reply.sendAfter - now;
      return left > 0
        ? { kind: 'settling', seconds: Math.ceil(left / 1000), cancel: reply.undo }
        : { kind: 'sending' };
    }
    case 'sent':
      return { kind: 'sent', at: reply.sentAt };
    case 'canceled':
      return { kind: 'canceled' };
    case 'failed':
      return { kind: 'failed', why: reply.failedWhy };
  }
}

/** The words of a reply's state ("Not sent · no sending address is set up"). */
export function replyStateWords(state: ReplyState, timeZone?: string): string {
  switch (state.kind) {
    case 'settling':
      return W.sendingIn(state.seconds);
    case 'sending':
      return W.sendingNow;
    case 'sent':
      return state.at === null ? W.sent : `${W.sent} · ${dayTime(state.at, timeZone)}`;
    case 'canceled':
      return W.canceled;
    case 'failed':
      return `${W.notSent} · ${state.why === null ? W.notSentUnknown : W.notSentWhy[state.why]}`;
  }
}

/** Whether any reply in the thread is still settling (the countdown ticks only then). */
export const anySettling = (item: Pick<TicketItem, 'messages'>): boolean =>
  item.messages.some((m) => m.removedAt === null && m.reply?.status === 'settling');

// ── The levers ───────────────────────────────────────────────────────────────────────────────

export type DockMode = 'reply' | 'note';

/**
 * What the ticket's `can` draws: a verb `null` is a lever; a sentence is the server's refusal, said
 * in place (never a button); a verb absent is neither. `in_progress` and an assignee are never drawn.
 */
export type TicketLevers = {
  /** The dock's modes, in the board's order (*Reply by email*, then *Note*). */
  modes: DockMode[];
  resolve: boolean;
  reopen: boolean;
  /** The refusals to say, each once. */
  refusals: string[];
};

export function leversOf(item: Pick<TicketItem, 'can'>): TicketLevers {
  const can = item.can;
  const refusals = (['reply', 'note', 'resolve', 'reopen'] as const)
    .map((v) => can[v])
    .filter((s): s is string => typeof s === 'string' && s !== '');
  return {
    modes: (['reply', 'note'] as const).filter((m) => can[m] === null),
    resolve: can.resolve === null,
    reopen: can.reopen === null,
    refusals: [...new Set(refusals)],
  };
}

/** The mode the dock shows: the one chosen if it is still allowed, else the first that is. */
export function dockModeOf(chosen: DockMode, modes: readonly DockMode[]): DockMode | null {
  return modes.includes(chosen) ? chosen : (modes[0] ?? null);
}
