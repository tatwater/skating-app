/**
 * Support tickets (D35/D37/D38). A lightweight in-app inbox — NOT Zendesk (D35) — that auto-captures
 * context (app version, platform, device, a recent Sentry event id) an email can't. `create` is open to
 * any signed-in user on **web and mobile** (the one Expo-touching Phase-7 bit — a submission path, not
 * the operator surface); appeals/reinstatement reuse this table via `category: 'account'` rather than a
 * new table. Reading/triaging the inbox is **admin-only** (PII — D37's admin line).
 *
 * `assign`/`resolve` land in a later Phase-7 commit alongside `create`; this file starts with the
 * admin-only `list` query the inbox reads.
 */

import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, type QueryCtx, query } from './_generated/server';
import { getCurrentProfile, requireRole } from './lib/auth';
import { SUPPORT_CATEGORIES, SUPPORT_STATUSES } from './lib/enums';
import { literals } from './lib/validators';

/** Support-ticket body bounds — enough for a real report, capped so it stays an inbox row not an essay. */
const MAX_BODY_LENGTH = 5000;

const INBOX_LIMIT = 100;

interface TicketUser {
  userId: string;
  username: string;
  displayName: string;
}

async function loadTicketUser(
  ctx: QueryCtx,
  userId: Id<'profiles'> | undefined,
): Promise<TicketUser | null> {
  if (!userId) return null;
  const p = await ctx.db.get(userId);
  return p ? { userId: p._id, username: p.username, displayName: p.displayName } : null;
}

interface TicketView {
  id: string;
  category: Doc<'supportTickets'>['category'];
  body: string;
  status: Doc<'supportTickets'>['status'];
  createdAt: number;
  resolvedAt?: number;
  submitter: TicketUser | null;
  assignedTo: TicketUser | null;
  context?: Doc<'supportTickets'>['context'];
}

/**
 * The support inbox (D37 — **admin-only**, PII). Filter by `status` (off `by_status`) or read the most
 * recent tickets (implicit creation-time order); an optional `category` narrows further in-memory.
 * Bounded to `INBOX_LIMIT`. Each row resolves its submitter + assignee for the inbox list.
 */
export const list = query({
  args: {
    status: v.optional(literals(SUPPORT_STATUSES)),
    category: v.optional(literals(SUPPORT_CATEGORIES)),
  },
  handler: async (ctx, args): Promise<TicketView[]> => {
    await requireRole(ctx, 'admin');

    const { status } = args;
    const rows =
      status !== undefined
        ? await ctx.db
            .query('supportTickets')
            .withIndex('by_status', (q) => q.eq('status', status))
            .order('desc')
            .take(INBOX_LIMIT)
        : await ctx.db.query('supportTickets').order('desc').take(INBOX_LIMIT);

    const filtered =
      args.category !== undefined ? rows.filter((r) => r.category === args.category) : rows;

    return Promise.all(
      filtered.map(async (t) => ({
        id: t._id,
        category: t.category,
        body: t.body,
        status: t.status,
        createdAt: t.createdAt,
        ...(t.resolvedAt !== undefined ? { resolvedAt: t.resolvedAt } : {}),
        submitter: await loadTicketUser(ctx, t.userId),
        assignedTo: await loadTicketUser(ctx, t.assignedToUserId),
        ...(t.context !== undefined ? { context: t.context } : {}),
      })),
    );
  },
});

/**
 * File a support ticket / bug report (D35) — the one Phase-7 path that ships on **web and mobile**.
 * Deliberately uses `getCurrentProfile` (not `requireProfile`) so a **suspended or banned** user can
 * still file an **appeal** (`category: 'account'`) — the very people who most need the channel. Signed-in
 * ⇒ the `userId` is attached; a not-yet-provisioned caller files pre-auth (userId absent). The client
 * supplies auto-captured `context` (app version / platform / device / recent Sentry event id) an email
 * can't. (The founder email alert is wired in the Resend commit.)
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
    const trimmed = body.trim();
    if (trimmed.length === 0) throw new ConvexError('Please describe the issue');
    if (trimmed.length > MAX_BODY_LENGTH) throw new ConvexError('Message is too long');
    const profile = await getCurrentProfile(ctx);

    const ticketId = await ctx.db.insert('supportTickets', {
      ...(profile ? { userId: profile._id } : {}),
      category,
      body: trimmed,
      status: 'open',
      ...(context !== undefined ? { context } : {}),
      createdAt: Date.now(),
    });

    // Alert the founder on every new ticket (D38) — fire-and-forget; no-ops without Resend keys.
    await ctx.scheduler.runAfter(0, internal.operatorAlerts.send, {
      subject: `New ${category} ticket`,
      heading: `New support ticket · ${category}`,
      lines: [
        profile ? `From @${profile.username}` : 'From an anonymous / pre-auth user',
        trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed,
      ],
      deepLinkPath: '/admin/support',
    });
    return ticketId;
  },
});

/**
 * Assign a ticket for triage (D37 — **admin-only**, PII). Defaults to the acting admin when no
 * assignee is given (the common "I've got this" action), and moves an `open` ticket to `in_progress`.
 */
export const assign = mutation({
  args: { ticketId: v.id('supportTickets'), assigneeId: v.optional(v.id('profiles')) },
  handler: async (ctx, { ticketId, assigneeId }) => {
    const actor = await requireRole(ctx, 'admin');
    const ticket = await ctx.db.get(ticketId);
    if (!ticket) throw new ConvexError('Ticket not found');
    await ctx.db.patch(ticketId, {
      assignedToUserId: assigneeId ?? actor._id,
      status: ticket.status === 'open' ? 'in_progress' : ticket.status,
    });
    return ticketId;
  },
});

/** Resolve a ticket (D37 — **admin-only**). Stamps `resolvedBy`/`resolvedAt` and closes it. */
export const resolve = mutation({
  args: { ticketId: v.id('supportTickets') },
  handler: async (ctx, { ticketId }) => {
    const actor = await requireRole(ctx, 'admin');
    const ticket = await ctx.db.get(ticketId);
    if (!ticket) throw new ConvexError('Ticket not found');
    await ctx.db.patch(ticketId, {
      status: 'resolved',
      resolvedByUserId: actor._id,
      resolvedAt: Date.now(),
    });
    return ticketId;
  },
});
