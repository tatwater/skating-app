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

import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type QueryCtx, query } from './_generated/server';
import { requireRole } from './lib/auth';
import { SUPPORT_CATEGORIES, SUPPORT_STATUSES } from './lib/enums';
import { literals } from './lib/validators';

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
