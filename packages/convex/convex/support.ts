/**
 * Support tickets (D35/D37/D38). A lightweight in-app inbox — NOT Zendesk (D35) — that auto-captures
 * context (app version, platform, device, a recent Sentry event id) an email can't. `create` is open to
 * any signed-in user on **web and mobile** (the one Expo-touching Phase-07 bit — a submission path, not
 * the operator surface); appeals/reinstatement reuse this table via `category: 'account'` rather than a
 * new table. Reading/triaging the inbox is **admin-only** (PII — D37's admin line).
 *
 * **Answering one** (B01-5f, D284): a staffer adds a staff-only note, replies by email, resolves or
 * reopens — four writes behind `inbox.support`, each through the Inbox's one rule (`lib/inboxRules`:
 * what the item's `can` offers is what the write enforces, in its order: the capability, a decided
 * ticket, the staffer's own filing), each audited with the verb's default reason (never the text) and
 * answering as every Inbox decision does: its item, its audit row and the undo it offers. A reply is
 * stored `settling` and sent by `sendReply` once its window (`SETTLE_MS`) has run, re-reading the row;
 * `cancelReply` is its undo inside the window, through the undo engine. There is no assignee and no
 * "in progress" (D284): `assign` stays only for the old page until it goes.
 */

import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalAction, internalMutation, type MutationCtx, mutation } from './_generated/server';
import { writeAudit } from './lib/audit';
import { getCurrentProfile, requireCapability } from './lib/auth';
import { clerkEmailLookup } from './lib/clerkEmail';
import { SUPPORT_CATEGORIES } from './lib/enums';
import { fileMember, itemToDecide, ticketSource } from './lib/inboxItems';
import { assertInboxVerb } from './lib/inboxRules';
import { SETTLE_MS } from './lib/notificationQueue';
import { sendEmailOutcome } from './lib/resend';
import { isSeedProfile } from './lib/seedPeople';
import {
  bodyRefusal,
  clientKeyRefusal,
  MESSAGE_GONE_REFUSAL,
  messageByClientKey,
  NOT_A_NOTE_REFUSAL,
  REPLY_SEND_ATTEMPTS,
  REPLY_SKIPPED_LOG,
  REPLY_WATCH_MS,
  replyBlockedOf,
  SEND_ACTION_LIMIT_MS,
  SUPPORT_REASONS,
  seedTicket,
  supportReplyEmail,
  supportReplyTo,
  supportSendability,
  TICKET_GONE_REFUSAL,
} from './lib/supportThread';
import { removeNoteImpl, reopenTicketImpl, resolveTicketImpl } from './lib/supportWrites';
import { runUndo, undoRowOf } from './lib/undo';
import { literals } from './lib/validators';
import { undoOfferAfterWrite } from './moderation';
import { undoWriters } from './undo';

/** Support-ticket body bounds — enough for a real report, capped so it stays an inbox row not an essay. */
const MAX_BODY_LENGTH = 5000;

/**
 * Per-submitter abuse bound. `create` is deliberately status-blind (a banned user must be able to
 * appeal), so the boundary can't be `requireProfile` — it's *authenticated identity + a rate limit*.
 * Five tickets an hour is far above any honest use (a person filing a bug, then a follow-up) and caps
 * both table growth and the D38 operator-email fan-out at 5/hour/account.
 */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const MAX_TICKETS_PER_WINDOW = 5;

/**
 * File a support ticket / bug report (D35) — the one Phase-07 path that ships on **web and mobile**.
 *
 * Two gates, deliberately split (2026-07-24 review):
 *  - **Authentication is required** — a Clerk identity must be present. Without it, an anonymous client
 *    could loop this mutation into unbounded rows *and* unbounded D38 operator emails. Both clients
 *    already sit behind sign-in, so this costs no real submitter anything.
 *  - **Account status is NOT checked** — `getCurrentProfile`, not `requireProfile`, so a **suspended or
 *    banned** user can still file an **appeal** (`category: 'account'`). That's the whole point of the
 *    channel. A signed-in caller whose profile isn't provisioned yet files with `userId` absent; the
 *    Clerk subject is stamped either way so the rate limit still binds them.
 *
 * On top of that, `MAX_TICKETS_PER_WINDOW` per submitter per hour bounds the abuse an authenticated
 * account can do. The client supplies auto-captured `context` (app version / platform / device /
 * recent Sentry event id) an email can't.
 */
export const create = mutation({
  args: {
    category: literals(SUPPORT_CATEGORIES),
    body: v.string(),
    context: v.optional(
      v.object({
        appVersion: v.optional(v.string()),
        platform: v.optional(v.string()),
        deviceModel: v.optional(v.string()),
        sentryEventId: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { category, body, context }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError('Sign in to contact support');
    const trimmed = body.trim();
    if (trimmed.length === 0) throw new ConvexError('Please describe the issue');
    if (trimmed.length > MAX_BODY_LENGTH) throw new ConvexError('Message is too long');
    const profile = await getCurrentProfile(ctx);
    // This mutation gates on *identity*, not on `requireProfile` — deliberately, so a banned or
    // profile-less user can still write to support (an appeal is exactly what support is for). That
    // exemption has one edge it must not cover: an account being finalized (PR #29 review). A ticket
    // is private free text that D62 erases, and `erase` finds tickets by Clerk subject — which the
    // tombstone is seconds from scrubbing — so one filed now would survive the deletion with nothing
    // able to find it again. Unlike a ban, there is no appeal left to make: the account is going.
    if (profile?.status === 'deleting' || profile?.status === 'deleted') {
      throw new ConvexError('Account is not active');
    }

    const now = Date.now();
    const recent = await ctx.db
      .query('supportTickets')
      .withIndex('by_clerk_user_created', (q) =>
        q.eq('clerkUserId', identity.subject).gte('createdAt', now - RATE_LIMIT_WINDOW_MS),
      )
      .take(MAX_TICKETS_PER_WINDOW);
    if (recent.length >= MAX_TICKETS_PER_WINDOW) {
      throw new ConvexError("You've sent several messages recently — we'll reply to those first");
    }

    const ticketId = await ctx.db.insert('supportTickets', {
      ...(profile ? { userId: profile._id } : {}),
      clerkUserId: identity.subject,
      category,
      body: trimmed,
      status: 'open',
      ...(context !== undefined ? { context } : {}),
      createdAt: now,
    });
    // The Inbox's Support item for it (B01-5).
    await fileMember(ctx, ticketSource(ticketId), { now });

    // Alert the founder on every new ticket (D38) — fire-and-forget; no-ops without Resend keys. Never
    // for a fake person from the dev seed (D287): a seeded ticket must not send real mail.
    if (isSeedProfile(identity.subject)) return ticketId;
    await ctx.scheduler.runAfter(0, internal.operatorAlerts.send, {
      subject: `New ${category} ticket`,
      heading: `New support ticket · ${category}`,
      lines: [
        profile ? `From @${profile.username}` : 'From a signed-in user with no profile row yet',
        trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed,
      ],
      // The ticket's own Inbox item (B01-5f: the old Support page is retired).
      deepLinkPath: `/admin/inbox?item=ticket:${ticketId}`,
    });
    return ticketId;
  },
});

// ── Answering a ticket (B01-5f, D284) ────────────────────────────────────────────────────────────

/**
 * What every support write answers, as every Inbox decision does (`inboxWrites.InboxWriteResult`): the
 * ticket's item, the audit row the toast's Undo undoes, and — only when this viewer can undo that row
 * right now — whether the undo asks a reason (none of these does). **A published contract** for the
 * web's Ticket handler.
 */
export type SupportWriteResult = {
  itemId: Id<'inboxItems'>;
  ticketId: Id<'supportTickets'>;
  actionId: Id<'moderationActions'>;
} & ({ undoable: true; undoNeedsReason: boolean } | { undoable: false });

/** `addNote`'s answer: the note's row besides. */
export type SupportNoteResult = SupportWriteResult & { messageId: Id<'supportMessages'> };

/**
 * `reply`'s answer: the reply's row, and how it stands — `settling` until `sendAfter` (the toast's
 * *Sending in 60 s · Undo*), or `failed` at once for a seeded ticket (`failedWhy: 'seed'`: the seed is
 * never mailed).
 */
export type SupportReplyResult = SupportWriteResult & {
  messageId: Id<'supportMessages'>;
  /**
   * As it stands: a fresh reply is `settling` or `failed` (blocked); a repeat of a `clientKey` answers
   * the first reply as it now stands, which may be `sent` or `canceled` by then.
   */
  status: 'settling' | 'sent' | 'canceled' | 'failed';
  sendAfter: number;
  failedWhy: Doc<'supportMessages'>['failedWhy'] | null;
};

/** `cancelReply`'s answer: the cancel's own row (which has no undo: a canceled reply is written anew). */
export type SupportCancelResult = {
  itemId: Id<'inboxItems'>;
  ticketId: Id<'supportTickets'>;
  messageId: Id<'supportMessages'>;
  actionId: Id<'moderationActions'>;
  undoable: false;
};

type Actor = Doc<'profiles'>;

/** The ticket and its Inbox item, the item filed first if the backfill hasn't reached it. */
async function ticketAndItem(
  ctx: MutationCtx,
  ticketId: Id<'supportTickets'>,
  now: number,
): Promise<{ ticket: Doc<'supportTickets'>; item: Doc<'inboxItems'> }> {
  const ticket = await ctx.db.get(ticketId);
  if (!ticket) throw new ConvexError(TICKET_GONE_REFUSAL);
  const item = await itemToDecide(ctx, ticketSource(ticketId), { now });
  // A ticket is always an Inbox item (`lib/inboxItems.ticketFacts`); none means it is going.
  if (!item) throw new ConvexError(TICKET_GONE_REFUSAL);
  return { ticket, item };
}

async function answer<T extends object>(
  ctx: MutationCtx,
  actor: Actor,
  base: {
    itemId: Id<'inboxItems'>;
    ticketId: Id<'supportTickets'>;
    actionId: Id<'moderationActions'>;
  },
  extra: T,
): Promise<SupportWriteResult & T> {
  return { ...base, ...extra, ...(await undoOfferAfterWrite(ctx, actor._id, base.actionId)) };
}

/**
 * Add a staff-only note to a ticket (D284). Asks the Inbox's rule (`note`), then the note's own words
 * (empty, past `MAX_SUPPORT_NOTE_LENGTH`). Its undo removes it.
 */
export const addNote = mutation({
  args: { ticketId: v.id('supportTickets'), body: v.string(), clientKey: v.optional(v.string()) },
  handler: async (ctx, { ticketId, body, clientKey }): Promise<SupportNoteResult> => {
    const actor = await requireCapability(ctx, 'inbox.support');
    const now = Date.now();
    const keyRefused = clientKeyRefusal(clientKey);
    if (keyRefused !== null) throw new ConvexError(keyRefused);
    const { item } = await ticketAndItem(ctx, ticketId, now);
    // The same request again (a Send pressed twice): the first write's answer, nothing written.
    const earlier = await messageByClientKey(ctx, {
      ticketId,
      clientKey,
      kind: 'note',
      authorId: actor._id,
    });
    if (earlier?.actionId) {
      return answer(
        ctx,
        actor,
        { itemId: item._id, ticketId, actionId: earlier.actionId },
        { messageId: earlier._id },
      );
    }
    await assertInboxVerb(ctx, actor, item, 'note');
    const refused = bodyRefusal('note', body);
    if (refused !== null) throw new ConvexError(refused);
    const messageId = await ctx.db.insert('supportMessages', {
      ticketId,
      kind: 'note',
      authorId: actor._id,
      body: body.trim(),
      createdAt: now,
      ...(clientKey !== undefined ? { clientKey } : {}),
    });
    const actionId = await writeAudit(ctx, {
      actorId: actor._id,
      action: 'support_note',
      targetType: 'supportTicket',
      targetId: ticketId,
      reason: SUPPORT_REASONS.support_note,
      metadata: { messageId, kind: 'note', reasonDefaulted: true },
      createdAt: now,
    });
    await ctx.db.patch(messageId, { actionId });
    return answer(ctx, actor, { itemId: item._id, ticketId, actionId }, { messageId });
  },
});

/**
 * Reply to the person who filed a ticket, by email (D284). Asks the Inbox's rule (`reply`), then the
 * reply's words. Stored `settling`, sent by {@link sendReply} at `sendAfter` (one settle window on),
 * which re-reads the row and sends only a reply still settling — so {@link cancelReply} inside the
 * window means nothing is sent. **A reply that can't go reads `failed` from the start** (the plan's
 * "with the sender unset the reply reads `failed`"): a seeded ticket (`seed`, D287) or a deployment
 * without its sender or the provider's key (`unconfigured`, the skip logged) is stored `failed` here,
 * and nothing is scheduled; the send asks both again besides.
 */
export const reply = mutation({
  args: { ticketId: v.id('supportTickets'), body: v.string(), clientKey: v.optional(v.string()) },
  handler: async (ctx, { ticketId, body, clientKey }): Promise<SupportReplyResult> => {
    const actor = await requireCapability(ctx, 'inbox.support');
    const now = Date.now();
    const keyRefused = clientKeyRefusal(clientKey);
    if (keyRefused !== null) throw new ConvexError(keyRefused);
    const { ticket, item } = await ticketAndItem(ctx, ticketId, now);
    // The same request again (a Send pressed twice): the first reply's answer — no second row, no
    // second send scheduled.
    const earlier = await messageByClientKey(ctx, {
      ticketId,
      clientKey,
      kind: 'reply',
      authorId: actor._id,
    });
    if (earlier?.actionId) {
      return answer(
        ctx,
        actor,
        { itemId: item._id, ticketId, actionId: earlier.actionId },
        {
          messageId: earlier._id,
          status: earlier.status ?? 'failed',
          sendAfter: earlier.sendAfter ?? earlier.createdAt,
          failedWhy: earlier.failedWhy ?? null,
        },
      );
    }
    await assertInboxVerb(ctx, actor, item, 'reply');
    const refused = bodyRefusal('reply', body);
    if (refused !== null) throw new ConvexError(refused);
    const profile = ticket.userId ? await ctx.db.get(ticket.userId) : null;
    // A reply that can't go is stored `failed` at once, with nothing scheduled — the ruling: it
    // *reads* failed, never a countdown for a reply that can never be sent (a seeded person, D287;
    // a deployment without its sender). The same function answers the read's `replyBlocked`.
    const blocked = replyBlockedOf(ticket, profile);
    if (blocked === 'unconfigured') console.warn(REPLY_SKIPPED_LOG);
    const sendAfter = now + SETTLE_MS;
    const messageId = await ctx.db.insert('supportMessages', {
      ticketId,
      kind: 'reply',
      authorId: actor._id,
      body: body.trim(),
      createdAt: now,
      sendAfter,
      ...(clientKey !== undefined ? { clientKey } : {}),
      ...(blocked
        ? { status: 'failed' as const, failedWhy: blocked }
        : { status: 'settling' as const }),
    });
    const actionId = await writeAudit(ctx, {
      actorId: actor._id,
      action: 'support_reply',
      targetType: 'supportTicket',
      targetId: ticketId,
      reason: SUPPORT_REASONS.support_reply,
      metadata: { messageId, kind: 'reply', reasonDefaulted: true },
      createdAt: now,
    });
    await ctx.db.patch(messageId, { actionId });
    if (!blocked) {
      await ctx.scheduler.runAt(sendAfter, internal.support.sendReply, { messageId });
      // Its watch: a send that dies never leaves the reply settling for good (`REPLY_WATCH_MS`).
      await ctx.scheduler.runAt(sendAfter + REPLY_WATCH_MS, internal.support.watchReply, {
        messageId,
        attempt: 1,
      });
    }
    return answer(
      ctx,
      actor,
      { itemId: item._id, ticketId, actionId },
      {
        messageId,
        status: blocked ? ('failed' as const) : ('settling' as const),
        sendAfter,
        failedWhy: blocked,
      },
    );
  },
});

/**
 * Remove a staff note (B01-5f): soft-removed, its words kept for its undo, which puts it back. The
 * support undo's one rule decides it (`lib/supportThread.supportUndoRefusal`: the capability, the
 * staffer's own ticket, a note already removed) — the same answer the thread's `remove` gives.
 */
export const removeNote = mutation({
  args: { messageId: v.id('supportMessages') },
  handler: async (ctx, { messageId }): Promise<SupportNoteResult> => {
    const actor = await requireCapability(ctx, 'inbox.support');
    const message = await ctx.db.get(messageId);
    if (!message) throw new ConvexError(MESSAGE_GONE_REFUSAL);
    if (message.kind !== 'note') throw new ConvexError(NOT_A_NOTE_REFUSAL);
    const now = Date.now();
    const { item } = await ticketAndItem(ctx, message.ticketId, now);
    const actionId = await removeNoteImpl(ctx, actor, {
      ticketId: message.ticketId,
      messageId,
      now,
    });
    return answer(
      ctx,
      actor,
      { itemId: item._id, ticketId: message.ticketId, actionId },
      { messageId },
    );
  },
});

/**
 * Cancel a reply still settling — its undo, through the undo engine (`undo.run` on the reply's row
 * answers the same): refused once it was sent ("Sent replies can't be unsent"), or is on its way.
 */
export const cancelReply = mutation({
  args: { messageId: v.id('supportMessages') },
  handler: async (ctx, { messageId }): Promise<SupportCancelResult> => {
    const actor = await requireCapability(ctx, 'inbox.support');
    const message = await ctx.db.get(messageId);
    if (message?.kind !== 'reply') throw new ConvexError(MESSAGE_GONE_REFUSAL);
    const row = message.actionId ? await ctx.db.get(message.actionId) : null;
    if (!row) throw new ConvexError('This reply’s record is missing, so it can’t be canceled.');
    await runUndo(ctx, actor, row._id, undefined, undoWriters);
    const cancel = await undoRowOf(ctx, row);
    const item = await itemToDecide(ctx, ticketSource(message.ticketId));
    if (!cancel || !item) throw new Error('cancelReply: the cancel wrote no row');
    return {
      itemId: item._id,
      ticketId: message.ticketId,
      messageId,
      actionId: cancel._id,
      undoable: false,
    };
  },
});

/** Resolve a ticket (D37 — **admin-only**). Stamps `resolvedBy`/`resolvedAt` and closes it; audited. */
export const resolve = mutation({
  args: { ticketId: v.id('supportTickets') },
  handler: async (ctx, { ticketId }): Promise<SupportWriteResult> => {
    const actor = await requireCapability(ctx, 'inbox.support');
    const now = Date.now();
    // The Inbox's one rule (B01-5): a decided ticket takes no second resolve (D283), and no staffer
    // resolves a ticket they filed themselves (D289) — the same answer the item's `can` gives. A ticket
    // the backfill hasn't reached is filed first, so it gets that answer too.
    const { item } = await ticketAndItem(ctx, ticketId, now);
    await assertInboxVerb(ctx, actor, item, 'resolve');
    const actionId = await resolveTicketImpl(ctx, actor, { ticketId, now });
    return answer(ctx, actor, { itemId: item._id, ticketId, actionId }, {});
  },
});

/** Reopen a resolved ticket (B01-5f): open again, its item reopened; audited. Its undo resolves it. */
export const reopen = mutation({
  args: { ticketId: v.id('supportTickets') },
  handler: async (ctx, { ticketId }): Promise<SupportWriteResult> => {
    const actor = await requireCapability(ctx, 'inbox.support');
    const now = Date.now();
    const { item } = await ticketAndItem(ctx, ticketId, now);
    await assertInboxVerb(ctx, actor, item, 'reopen');
    const actionId = await reopenTicketImpl(ctx, actor, { ticketId, now });
    return answer(ctx, actor, { itemId: item._id, ticketId, actionId }, {});
  },
});

// ── The send ─────────────────────────────────────────────────────────────────────────────────────

/** What the send needs, once it has claimed the reply: never the address, which it resolves itself. */
type ReplyClaim = {
  body: string;
  email: string | null;
  clerkUserId: string | null;
  seed: boolean;
  /** The claim's stamp (`sentAt` while it settles): the send's answer names it, so only it lands. */
  claimedAt: number;
};

/**
 * **The send's claim** — the re-read the snippet's `replyToSend` is, as a mutation: a reply still
 * settling (not canceled, not claimed before) is stamped `sentAt` while it still reads `settling`, and
 * from then on its cancel is refused — so a cancel and a send can't both land (they write the same row,
 * and one of them retries and sees the other). `null`: canceled, gone, already sent or claimed.
 */
export const claimReply = internalMutation({
  args: { messageId: v.id('supportMessages') },
  handler: async (ctx, { messageId }): Promise<ReplyClaim | null> => {
    const message = await ctx.db.get(messageId);
    if (message?.kind !== 'reply') return null;
    if (message.status !== 'settling' || message.sentAt !== undefined) return null;
    const ticket = await ctx.db.get(message.ticketId);
    if (!ticket) {
      await ctx.db.patch(messageId, { status: 'failed', failedWhy: 'noAddress' });
      return null;
    }
    const profile = ticket.userId ? await ctx.db.get(ticket.userId) : null;
    const claimedAt = Date.now();
    await ctx.db.patch(messageId, { sentAt: claimedAt });
    return {
      body: message.body,
      email: profile?.email ?? null,
      clerkUserId: ticket.clerkUserId ?? profile?.clerkUserId ?? null,
      seed: seedTicket(ticket, profile),
      claimedAt,
    };
  },
});

/**
 * Whether the send's answer for `claimedAt` may still land: the reply is still that claim's — settling
 * under it, or marked `outcomeUnknown` by the watch while it was out (a late answer knows; it wins).
 */
function claimAnswerable(message: Doc<'supportMessages'> | null, claimedAt: number): boolean {
  if (!message || message.sentAt !== claimedAt) return false;
  return (
    message.status === 'settling' ||
    (message.status === 'failed' && message.failedWhy === 'outcomeUnknown')
  );
}

/** The claimed reply went: `sent`, stamped when the provider took it. */
export const replySent = internalMutation({
  args: { messageId: v.id('supportMessages'), claimedAt: v.number() },
  handler: async (ctx, { messageId, claimedAt }) => {
    const message = await ctx.db.get(messageId);
    if (!claimAnswerable(message, claimedAt)) return;
    await ctx.db.patch(messageId, { status: 'sent', sentAt: Date.now(), failedWhy: undefined });
  },
});

/** The claimed reply didn't go: `failed`, with its class (never the provider's words or an address). */
export const replyFailed = internalMutation({
  args: {
    messageId: v.id('supportMessages'),
    claimedAt: v.number(),
    why: literals(['unconfigured', 'seed', 'noAddress', 'sendFailed', 'outcomeUnknown'] as const),
  },
  handler: async (ctx, { messageId, claimedAt, why }) => {
    const message = await ctx.db.get(messageId);
    if (!claimAnswerable(message, claimedAt)) return;
    // An unknown outcome keeps the claim's stamp, as the watch's mark does (a later answer from that
    // claim may still say how it went); a definite failure clears it.
    await ctx.db.patch(messageId, {
      status: 'failed',
      failedWhy: why,
      sentAt: why === 'outcomeUnknown' ? claimedAt : undefined,
    });
  },
});

/**
 * The send found nothing it could trust about the address (a Clerk lookup that errored): nothing was
 * sent, so the claim is let go — the reply settles again, past its window (no cancel), and its watch
 * schedules the send again, within `REPLY_SEND_ATTEMPTS`. Never recorded as "no address", which the
 * person may well have.
 */
export const releaseClaim = internalMutation({
  args: { messageId: v.id('supportMessages'), claimedAt: v.number() },
  handler: async (ctx, { messageId, claimedAt }) => {
    const message = await ctx.db.get(messageId);
    if (message?.status !== 'settling' || message.sentAt !== claimedAt) return;
    await ctx.db.patch(messageId, { sentAt: undefined });
  },
});

/**
 * **A reply's watch** (`lib/supportThread.REPLY_WATCH_MS`): one point read of its row. Settled → done.
 * Not claimed → no send ran: the send again (at most one email, by the claim) and another watch, up
 * to `REPLY_SEND_ATTEMPTS`, then `failed` (`sendFailed`). Claimed with no answer → once the claim is
 * older than an action can run, `failed` (`outcomeUnknown`), never resent; before that, watched again
 * when it would be.
 */
export const watchReply = internalMutation({
  args: { messageId: v.id('supportMessages'), attempt: v.number() },
  handler: async (ctx, { messageId, attempt }) => {
    const message = await ctx.db.get(messageId);
    if (message?.kind !== 'reply' || message.status !== 'settling') return;
    const now = Date.now();
    if (message.sentAt === undefined) {
      if (attempt >= REPLY_SEND_ATTEMPTS) {
        await ctx.db.patch(messageId, { status: 'failed', failedWhy: 'sendFailed' });
        return;
      }
      await ctx.scheduler.runAfter(0, internal.support.sendReply, { messageId });
      await ctx.scheduler.runAfter(REPLY_WATCH_MS, internal.support.watchReply, {
        messageId,
        attempt: attempt + 1,
      });
      return;
    }
    const deadAt = message.sentAt + SEND_ACTION_LIMIT_MS;
    if (now < deadAt) {
      await ctx.scheduler.runAt(deadAt, internal.support.watchReply, { messageId, attempt });
      return;
    }
    // Keeps `sentAt` (the claim's stamp), so a late answer from that claim still lands.
    await ctx.db.patch(messageId, { status: 'failed', failedWhy: 'outcomeUnknown' });
  },
});

/**
 * **The reply's send** (B01-5f), scheduled at `sendAfter`: claim the row (still settling, or nothing
 * is sent); with no `SUPPORT_FROM_EMAIL`, `failed` (`unconfigured`) with the skip logged — never sent
 * from the general address (ruled); a seeded ticket `failed` (`seed`) **before any address is
 * resolved**; then the address — the profile's, else the ticket's Clerk subject's, so a ticket filed
 * before provisioning is answered — `failed` (`noAddress`) only when Clerk said there is none, the
 * claim let go for the watch's retry when the lookup errored; then the email, with its footer, from
 * the support sender, under an idempotency key from the message's id, recorded by what became of it
 * (`lib/resend.SendOutcome`): `sent`, `failed` (`sendFailed`: definitely not sent), or `failed`
 * (`outcomeUnknown`: it may have gone).
 */
export const sendReply = internalAction({
  args: { messageId: v.id('supportMessages') },
  handler: async (ctx, { messageId }) => {
    const claim = await ctx.runMutation(internal.support.claimReply, { messageId });
    if (claim === null) return; // canceled, gone, or already sent
    const from = process.env.SUPPORT_FROM_EMAIL;
    // Asked again at send: the deployment's variables may have changed since the write.
    if (!supportSendability().sendable || !from) {
      console.warn(REPLY_SKIPPED_LOG);
      await ctx.runMutation(internal.support.replyFailed, {
        messageId,
        claimedAt: claim.claimedAt,
        why: 'unconfigured',
      });
      return;
    }
    if (claim.seed) {
      await ctx.runMutation(internal.support.replyFailed, {
        messageId,
        claimedAt: claim.claimedAt,
        why: 'seed',
      });
      return;
    }
    let to = claim.email;
    if (!to) {
      const lookup = claim.clerkUserId
        ? await clerkEmailLookup(claim.clerkUserId)
        : ({ kind: 'none' } as const);
      if (lookup.kind === 'error') {
        // Nothing sent, and nothing known about the address: the watch tries the send again.
        await ctx.runMutation(internal.support.releaseClaim, {
          messageId,
          claimedAt: claim.claimedAt,
        });
        return;
      }
      if (lookup.kind === 'none') {
        await ctx.runMutation(internal.support.replyFailed, {
          messageId,
          claimedAt: claim.claimedAt,
          why: 'noAddress',
        });
        return;
      }
      to = lookup.email;
    }
    // Resend's idempotency key, from the message's id: a repeat of this reply within Resend's 24 hours
    // (the watch's send of a reply never claimed, a send that lost its answer) is refused by Resend.
    // The skater's answer goes to `SUPPORT_REPLY_TO_EMAIL` when it holds one address; without it, no
    // reply-to, and the reply goes all the same (not part of sendability).
    const replyTo = supportReplyTo();
    const outcome = await sendEmailOutcome({
      to,
      from,
      ...supportReplyEmail(claim.body),
      ...(replyTo !== undefined ? { replyTo } : {}),
      context: 'support reply',
      idempotencyKey: `support-reply/${messageId}`,
    });
    if (outcome.kind === 'accepted') {
      await ctx.runMutation(internal.support.replySent, { messageId, claimedAt: claim.claimedAt });
      return;
    }
    // Definitely not sent → `sendFailed`, or `unconfigured` for a missing key. A request that may
    // have gone with no trustworthy answer (thrown, timed out, 5xx, 409) → `outcomeUnknown`: never
    // read as "not sent", so no one sends it again thinking it didn't go.
    await ctx.runMutation(internal.support.replyFailed, {
      messageId,
      claimedAt: claim.claimedAt,
      why:
        outcome.kind === 'unknown'
          ? 'outcomeUnknown'
          : outcome.code === 'unconfigured'
            ? 'unconfigured'
            : 'sendFailed',
    });
  },
});
