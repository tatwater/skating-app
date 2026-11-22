import { ageInWords } from '@/lib/ages';
import { shownName } from '../../blocks/shownName';
import type { InboxItemView } from '../../list/inboxTypes';
import { TICKET_CHIP } from '../../words/inboxWords';
import { dayTime } from '../Flag/flagFormat';
import { TICKET_WORDS as W } from './ticketWords';

/**
 * **What board 2.8 draws, as data** — the ticket item the handler is handed (`inbox.item`'s `ticket`
 * variant, as S6 serves it), and the pure rules over it: the thread in order, each reply's state, the
 * cut line, the levers from `can`, the dock's modes.
 *
 * Every lever on a message is the server's: a note's `remove` and a settling reply's `cancel` are
 * `null` where this viewer may act now, else the sentence the write refuses with (D217) — drawn only
 * where `null`. The cut line reads the server's `messagesCut` against its `messageCount`, never the
 * list's length; the dock reads `replyFrom` and `replyBlocked`, never the environment.
 */

/** The ticket item as the server serves it. */
export type TicketItem = Extract<InboxItemView, { kind: 'ticket' }>;

/** A person as the thread names them (the server's `PersonRefView`). */
export type TicketPerson = NonNullable<TicketItem['ticket']['resolvedBy']>;

/** A note or a reply on the ticket. */
export type TicketMessage = TicketItem['messages'][number];

export type ReplyStatus = NonNullable<TicketMessage['reply']>['status'];

/** Why a reply wasn't sent — the stored class, never an address or the provider's words. */
export type FailedWhy = NonNullable<NonNullable<TicketMessage['reply']>['failedWhy']>;

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
  | { kind: 'message'; msg: TicketMessage }
  | { kind: 'removed'; msg: TicketMessage };

/**
 * The thread in the order it is read: the ticket's body first, then every message oldest to newest
 * (by when it was written, ties kept in the order served). A removed note is a line, never its words.
 */
export function threadOf(item: Pick<TicketItem, 'ticket' | 'messages'>): ThreadEntry[] {
  const messages = item.messages
    .map((msg, i) => ({ msg, i }))
    .sort((a, b) => a.msg.createdAt - b.msg.createdAt || a.i - b.i)
    .map(
      ({ msg }): ThreadEntry =>
        msg.removedAt !== null || msg.body === null
          ? { kind: 'removed', msg }
          : { kind: 'message', msg },
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
  if (!item.messagesCut) return null;
  const shown = item.messages.length;
  // Cut: the thread holds more than it served, so the count is a floor ("100+").
  return W.shownOf(shown, Math.max(item.messageCount, shown), true);
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
  /** Waiting out its minute: the seconds left, and whether this viewer may cancel it (the server's). */
  | { kind: 'settling'; seconds: number; canCancel: boolean }
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
        ? { kind: 'settling', seconds: Math.ceil(left / 1000), canCancel: reply.cancel === null }
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
