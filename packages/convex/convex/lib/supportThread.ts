/**
 * **A support ticket's thread** (B01-5f, D284): a staffer's notes and email replies on a ticket
 * (`supportMessages`), the one rule that says who may change one and when, the reply's email, and the
 * bounded reads every reader of a thread takes — the Inbox item, a person's data export, the account
 * erasure.
 *
 * **Staff-only and PII.** A note or a reply is served by no read outside `inbox.support.read`: the
 * Inbox item (behind that capability), never a list row, an audit row (whose reason is the verb's
 * default and whose metadata names only the message's id and kind), People's record or the overview.
 * The person who filed the ticket gets the replies that reached them in their data export, and never a
 * note; erasing their account erases every message on their tickets with the tickets.
 *
 * **The address is never stored.** A reply is sent to `profiles.email`, else to the Clerk address of
 * the ticket's Clerk subject — so a ticket filed before the person had a profile is answered — resolved
 * when it is sent (`support.sendReply`), never kept on the row.
 */

import { MAX_SUPPORT_NOTE_LENGTH, MAX_SUPPORT_REPLY_LENGTH } from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { inboxBatch, leaveMember, ticketSource } from './inboxItems';
import { capabilityRefusal, DECIDED_REFUSAL, OWN_FILING_REFUSAL } from './inboxRules';
import { ReadBudget, ROW_MAX } from './readBudget';
import { escapeHtml } from './resend';
import { isSeedProfile } from './seedPeople';

// ── The words ──────────────────────────────────────────────────────────────────────────────────

/**
 * **Every reply's footer** (D284, the founder's words): the sending domain takes no mail on purpose,
 * so an answer to the email would bounce — the person writes back from the app instead.
 */
export const SUPPORT_REPLY_FOOTER =
  'Replies to this email aren’t read. Write back from the app: Settings → Help.';

/** What each support write's audit row says: its default, never the note's or reply's text (PII). */
export const SUPPORT_REASONS = {
  support_note: 'Added a staff note',
  remove_support_note: 'Removed a staff note',
  support_reply: 'Replied by email',
  cancel_support_reply: 'Canceled an email reply',
  resolve_ticket: 'Resolved',
  reopen_ticket: 'Reopened',
} as const;

/** A sent reply's undo: it went, and nothing calls an email back (D284). */
export const SENT_REPLY_REFUSAL = 'Sent replies can’t be unsent.';
/** A reply that failed or a seeded one never left: there is nothing in flight to cancel. */
export const UNSENT_REPLY_REFUSAL = 'This reply wasn’t sent, so there is nothing to cancel.';
export const CANCELED_REPLY_REFUSAL = 'This reply was already canceled.';
/** A reply past its window, or claimed by its send, with no outcome yet: it has started going. */
export const REPLY_SENDING_REFUSAL = 'This reply has started sending, so it can’t be canceled.';
/** A reply whose send stopped before saying how it went (`outcomeUnknown`). */
export const REPLY_OUTCOME_UNKNOWN_REFUSAL =
  'This reply may or may not have been sent, so it can’t be canceled.';
export const NOTE_REMOVED_REFUSAL = 'This note was already removed.';
export const NOTE_NOT_REMOVED_REFUSAL = 'This note isn’t removed.';
export const MESSAGE_GONE_REFUSAL = 'This message no longer exists.';
/** A reply is canceled while it settles, never removed. */
export const NOT_A_NOTE_REFUSAL = 'Only a note is removed; a reply is canceled while it settles.';
export const TICKET_GONE_REFUSAL = 'Ticket not found';
/** `whoRefusal`'s words for a ticket's Reopen while it is open (`lib/inboxRules`). */
export const TICKET_OPEN_REFUSAL = 'This ticket is still open.';

/** What the write says of an empty note or reply, and of one past its cap. */
export function bodyRefusal(kind: 'note' | 'reply', body: string): string | null {
  const max = kind === 'note' ? MAX_SUPPORT_NOTE_LENGTH : MAX_SUPPORT_REPLY_LENGTH;
  if (body.trim().length === 0)
    return kind === 'note' ? 'Write the note first.' : 'Write the reply first.';
  if (body.trim().length > max) {
    return `${kind === 'note' ? 'A note' : 'A reply'} holds at most ${max.toLocaleString('en-US')} characters.`;
  }
  return null;
}

/** The reply's email: the staffer's words, then the footer every reply carries (D284). */
export function supportReplyEmail(body: string): { subject: string; html: string; text: string } {
  const paragraphs = body
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return {
    subject: 'A reply to your message to Gli support',
    html: `${paragraphs}<hr><p style="color:#666;font-size:13px">${escapeHtml(SUPPORT_REPLY_FOOTER)}</p>`,
    text: `${body.trim()}\n\n—\n${SUPPORT_REPLY_FOOTER}`,
  };
}

/** Whether the person a ticket is from is one of the dev seed's fake people (D287): never mailed. */
export function seedTicket(
  ticket: Pick<Doc<'supportTickets'>, 'clerkUserId'>,
  profile: Pick<Doc<'profiles'>, 'clerkUserId'> | null,
): boolean {
  return isSeedProfile(ticket.clerkUserId) || isSeedProfile(profile);
}

/**
 * **Whether a support reply can be sent from this deployment** (B01-5f) — the one answer the ticket's
 * read (`replyBlocked`), the reply's write (stored `failed` at once, nothing scheduled) and its send
 * ask: both the support sender (`SUPPORT_FROM_EMAIL`) and the provider's key (`RESEND_API_KEY`) set.
 * A boolean and a code, never a value: what either variable holds never leaves here.
 */
export function supportSendability():
  | { sendable: true }
  | { sendable: false; code: 'unconfigured' } {
  return process.env.SUPPORT_FROM_EMAIL && process.env.RESEND_API_KEY
    ? { sendable: true }
    : { sendable: false, code: 'unconfigured' };
}

/**
 * Why a reply written now to this ticket could not be sent, before it is written: a seeded person is
 * never mailed (D287), and a deployment without its sender can't mail anyone; `null` when it would go.
 */
export function replyBlockedOf(
  ticket: Pick<Doc<'supportTickets'>, 'clerkUserId'>,
  profile: Pick<Doc<'profiles'>, 'clerkUserId'> | null,
): 'seed' | 'unconfigured' | null {
  if (seedTicket(ticket, profile)) return 'seed';
  const sendability = supportSendability();
  return sendability.sendable ? null : sendability.code;
}

/**
 * **Watching a reply's send** (B01-5f review). Convex runs a scheduled action at most once and never
 * retries it, so a send that dies — a deploy, a timeout, a runtime error — would leave its reply
 * `settling` for good. Each reply that will be sent gets a watch, scheduled with it: one point read of
 * its own row, never a sweep.
 *
 * - **Not claimed** by its send this long after its window: no send ran (it can't have mailed — the
 *   claim comes before any address is looked up), so the send is scheduled again; the claim still
 *   makes it at most one email. After {@link REPLY_SEND_ATTEMPTS} such tries it is `failed`
 *   (`sendFailed`: no send ran).
 * - **Claimed, with no outcome**, once the claim is older than an action can run: the send stopped
 *   somewhere between its claim and its answer, so it **may or may not have been sent** —
 *   `failed` (`outcomeUnknown`). **Never resent by itself:** a second email to the person is worse
 *   than a staffer re-sending by hand, having read that it may not have gone.
 * - A late answer from that same claim (`claimedAt` matching) still lands and wins: it knows.
 */
export const REPLY_WATCH_MS = 5 * 60 * 1000;
/** Convex's limit on an action's run (10 minutes), and a minute's slack: a claim older is dead. */
export const SEND_ACTION_LIMIT_MS = 11 * 60 * 1000;
/** How many times a reply's send is scheduled when none ever claimed it. */
export const REPLY_SEND_ATTEMPTS = 3;

/** The skip a blocked support reply logs, by its code (the ruling: logged, never sent). */
export const REPLY_SKIPPED_LOG =
  'support reply skipped (SUPPORT_FROM_EMAIL or RESEND_API_KEY not configured)';

// ── The one rule for changing a message, and a ticket's state, from an undo ─────────────────────

/** What an undo of a support row does to the ticket or its message (the policy's inverse). */
export type SupportUndoVerb = 'removeNote' | 'restoreNote' | 'cancelReply' | 'reopen' | 'resolve';

/** The facts the rule reads: who asks, the ticket, the message (for a message's verb), and the time. */
export type SupportRuleFacts = {
  ticket: Doc<'supportTickets'> | null;
  message?: Doc<'supportMessages'> | null;
  now: number;
};

/**
 * Whether a reply is still settling — inside its window and not yet claimed by its send. From the
 * claim on (`sentAt` stamped while it still reads `settling`), it is on its way.
 */
export function replySettling(message: Doc<'supportMessages'>, now: number): boolean {
  return (
    message.kind === 'reply' &&
    message.status === 'settling' &&
    message.sentAt === undefined &&
    message.sendAfter !== undefined &&
    now < message.sendAfter
  );
}

/** Why the message can't take `verb` as it stands (rule 3: its state), or `null`. */
function messageStateRefusal(
  verb: 'removeNote' | 'restoreNote' | 'cancelReply',
  message: Doc<'supportMessages'> | null | undefined,
  now: number,
): string | null {
  if (!message) return MESSAGE_GONE_REFUSAL;
  switch (verb) {
    case 'removeNote':
      return message.removedAt !== undefined ? NOTE_REMOVED_REFUSAL : null;
    case 'restoreNote':
      return message.removedAt === undefined ? NOTE_NOT_REMOVED_REFUSAL : null;
    case 'cancelReply':
      if (replySettling(message, now)) return null;
      if (message.status === 'canceled') return CANCELED_REPLY_REFUSAL;
      if (message.status === 'sent') return SENT_REPLY_REFUSAL;
      if (message.status === 'failed') {
        return message.failedWhy === 'outcomeUnknown'
          ? REPLY_OUTCOME_UNKNOWN_REFUSAL
          : UNSENT_REPLY_REFUSAL;
      }
      // Still settling, but claimed by its send or past its window: started, not yet confirmed.
      return REPLY_SENDING_REFUSAL;
  }
}

/**
 * **The one rule for a support undo — the offer and the run ask it** (B01-5f), in the Inbox rule's
 * order (`lib/inboxRules.whoRefusal`): the capability (`inbox.support`, a write, so refused to a
 * staffer on their way out); for the ticket's own state verbs, a decided ticket for a resolve and an
 * open one for a reopen; a ticket the viewer filed (D289); then the message as it stands. The ticket's
 * own filer is its `userId` — the filer its Inbox member carries (`lib/inboxItems.ticketFacts`).
 */
export function supportUndoRefusal(
  viewer: Pick<Doc<'profiles'>, '_id' | 'role' | 'canEditLedger' | 'deletionRequestedAt'>,
  verb: SupportUndoVerb,
  facts: SupportRuleFacts,
): string | null {
  const capability = capabilityRefusal(viewer, 'inbox.support');
  if (capability !== null) return capability;
  const { ticket } = facts;
  if (!ticket) return TICKET_GONE_REFUSAL;
  const decided = ticket.status === 'resolved';
  if (verb === 'resolve' && decided) return DECIDED_REFUSAL;
  if (verb === 'reopen' && !decided) return TICKET_OPEN_REFUSAL;
  if (ticket.userId !== undefined && ticket.userId === viewer._id) return OWN_FILING_REFUSAL;
  if (verb === 'resolve' || verb === 'reopen') return null;
  if (facts.message && facts.message.ticketId !== ticket._id) return MESSAGE_GONE_REFUSAL;
  return messageStateRefusal(verb, facts.message, facts.now);
}

// ── The thread, as the Inbox item reads it ─────────────────────────────────────────────────────

/** The newest messages a thread serves; older ones are cut, and the cut is said (`capped`). */
export const THREAD_MESSAGES = 100;

// ── Erasure ────────────────────────────────────────────────────────────────────────────────────

/**
 * **A departing person's tickets, with every message on them** (D62's bucket 1, B01-5f): a ticket is
 * private correspondence, and so is every note and reply on it — staff's words about that person,
 * which outlive no ticket. `size` rows at most: each ticket's messages go first, a ticket only once it
 * has none left (so a ticket with hundreds of notes takes several passes, never an orphaned note), and
 * the stage says "more" until every ticket is gone. A reply still settling goes with its row; its send
 * finds nothing and sends nothing. The audit rows stay (D62: the trail survives), holding only the
 * verbs' default reasons and the messages' ids.
 */
export async function eraseTicketsOf(
  ctx: MutationCtx,
  clerkUserId: string,
  size: number,
): Promise<{ deleted: number; more: boolean }> {
  const tickets = await ctx.db
    .query('supportTickets')
    .withIndex('by_clerk_user_created', (q) => q.eq('clerkUserId', clerkUserId))
    .take(size);
  let room = size;
  let deleted = 0;
  // A full page of tickets may have more behind it.
  let more = tickets.length >= size;
  const gone: Doc<'supportTickets'>[] = [];
  for (const ticket of tickets) {
    // One more than the room left, to learn whether the ticket keeps messages past this pass.
    const messages = await ctx.db
      .query('supportMessages')
      .withIndex('by_ticket_created', (q) => q.eq('ticketId', ticket._id))
      .take(room + 1);
    const taken = messages.slice(0, room);
    for (const m of taken) await ctx.db.delete(m._id);
    deleted += taken.length;
    room -= taken.length;
    if (messages.length > taken.length || room === 0) {
      // Messages left on it, or no room left for the ticket itself: the next pass finishes it.
      more = true;
      break;
    }
    await ctx.db.delete(ticket._id);
    deleted++;
    room--;
    gone.push(ticket);
  }
  // A deleted ticket is no question: each leaves its Inbox item (B01-5), which goes with it.
  await inboxBatch(ctx, async () => {
    for (const ticket of gone) await leaveMember(ctx, ticketSource(ticket._id));
  });
  return { deleted, more };
}

// ── The data export ────────────────────────────────────────────────────────────────────────────

/** A person's newest tickets an export carries, and the messages read across them at most. */
export const EXPORT_TICKETS = 200;
export const EXPORT_MESSAGES_READ = 400;
/** What the support part of an export may read at its worst, inside the export's own read. */
const EXPORT_SUPPORT_BUDGET = 8 * 1024 * 1024;

/** A ticket as its filer's export carries it: their words, its state, and the replies they were sent. */
export type ExportedTicket = {
  ticketId: Id<'supportTickets'>;
  category: Doc<'supportTickets'>['category'];
  body: string;
  status: 'open' | 'resolved';
  createdAt: number;
  resolvedAt: number | null;
  context: Doc<'supportTickets'>['context'] | null;
  /**
   * The replies that reached them by email — their words to keep; never a note, never an unsent reply.
   * `delivery: 'unknown'` for one whose send stopped before saying how it went: it may have reached
   * them, so it is theirs to see, said as that (`sentAt` then `null`).
   */
  replies: { body: string; sentAt: number | null; delivery: 'sent' | 'unknown' }[];
};

/**
 * **What a person's data export carries of support** (B01-5f): every ticket they filed (their own
 * words, D33's "everything about you") and, on each, the replies **sent** to them — correspondence they
 * already hold, so theirs to keep; never a staff note (staff-only, D284), never a reply that didn't
 * go (canceled, failed or still settling: nothing they were told), never who on staff wrote one (the
 * console's, as a request's decider is). Read newest first within a byte budget of its own; past any
 * bound, `capped` says so — the bundle's no-silent-caps rule.
 */
export async function exportTicketsOf(
  ctx: QueryCtx,
  clerkUserId: string,
): Promise<{ tickets: ExportedTicket[]; capped: boolean }> {
  const budget = new ReadBudget(EXPORT_SUPPORT_BUDGET);
  const asked = Math.min(EXPORT_TICKETS + 1, budget.rows('supportTicket'));
  const rows = await budget.take('supportTicket', asked, (n) =>
    ctx.db
      .query('supportTickets')
      .withIndex('by_clerk_user_created', (q) => q.eq('clerkUserId', clerkUserId))
      .order('desc')
      .take(n),
  );
  // Past the bound — or a budget that couldn't ask for one past it and came back full.
  let capped = rows.length > EXPORT_TICKETS || (asked <= EXPORT_TICKETS && rows.length === asked);
  let read = 0;
  const tickets: ExportedTicket[] = [];
  for (const t of rows.slice(0, EXPORT_TICKETS)) {
    // One past the room, to learn whether the ticket holds more than this export reads of it.
    const room = Math.min(EXPORT_MESSAGES_READ - read, budget.rows('supportMessage') - 1);
    const messages =
      room > 0
        ? await budget.take('supportMessage', room + 1, (n) =>
            ctx.db
              .query('supportMessages')
              .withIndex('by_ticket_created', (q) => q.eq('ticketId', t._id))
              .take(n),
          )
        : [];
    const kept = messages.slice(0, Math.max(0, room));
    if (room <= 0 || messages.length > kept.length) capped = true;
    read += kept.length;
    tickets.push({
      ticketId: t._id,
      category: t.category,
      body: t.body,
      status: t.status === 'resolved' ? 'resolved' : 'open',
      createdAt: t.createdAt,
      resolvedAt: t.resolvedAt ?? null,
      context: t.context ?? null,
      replies: kept.flatMap((m): ExportedTicket['replies'] =>
        m.kind !== 'reply'
          ? []
          : m.status === 'sent'
            ? [{ body: m.body, sentAt: m.sentAt ?? m.createdAt, delivery: 'sent' as const }]
            : m.status === 'failed' && m.failedWhy === 'outcomeUnknown'
              ? [{ body: m.body, sentAt: null, delivery: 'unknown' as const }]
              : [],
      ),
    });
  }
  return { tickets, capped };
}

/** The worst case of one message, for a caller sizing a read of them. */
export const MESSAGE_ROW_MAX = ROW_MAX.supportMessage;
