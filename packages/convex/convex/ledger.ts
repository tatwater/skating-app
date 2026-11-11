/**
 * The cost ledger (D219) — for now, who may edit it: its invoices and its rates (D227).
 *
 * Ledger editing is a per-person grant on an admin's profile, given and taken on the People page by
 * an admin who already holds it; the rules live in `lib/ledgerEditors.ts`. The invoice and rate rows
 * and their mutations land with Machinery (B01 §5.5) and gate on the same `machinery.ledger`
 * capability.
 */

import { normalizeUsername } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internalMutation, mutation } from './_generated/server';
import { requireCapability } from './lib/auth';
import { grantLedgerEditorImpl, revokeLedgerEditorImpl } from './lib/ledgerEditors';

/** Give an admin ledger editing. The caller must hold it; giving asks no reason (D226). */
export const grantEditor = mutation({
  args: { userId: v.id('profiles'), reason: v.optional(v.string()) },
  handler: async (ctx, { userId, reason }) => {
    const actor = await requireCapability(ctx, 'machinery.ledger');
    await grantLedgerEditorImpl(ctx, actor, { userId, ...(reason ? { reason } : {}) });
  },
});

/**
 * Take ledger editing from an admin — yourself included, once another admin holds it. Refused for
 * the last editor, so the ledger always has one. Taking away asks a reason (D226).
 */
export const revokeEditor = mutation({
  args: { userId: v.id('profiles'), reason: v.string() },
  handler: async (ctx, { userId, reason }) => {
    const actor = await requireCapability(ctx, 'machinery.ledger');
    await revokeLedgerEditorImpl(ctx, actor, { userId, reason });
  },
});

/**
 * Seed the first ledger editor (D227: Teagan, from the start) — `@admin1` on dev at this branch's
 * first push there, and `@teagan` on prod after the founder's admin role is set by hand at first
 * init. Idempotent: an existing holder is left alone and no row is written. The audit row has no
 * actor: the system gave it.
 *
 * `pnpm --filter @skating/convex exec convex run ledger:seedEditor '{"username":"admin1"}'`
 * `pnpm --filter @skating/convex exec convex run --prod ledger:seedEditor '{"username":"teagan"}'`
 */
export const seedEditor = internalMutation({
  args: { username: v.string() },
  handler: async (ctx, { username }): Promise<{ seeded: boolean }> => {
    const profile = await ctx.db
      .query('profiles')
      .withIndex('by_username', (q) =>
        q.eq('username', normalizeUsername(username.replace(/^@/, ''))),
      )
      .unique();
    if (!profile) throw new ConvexError(`No profile has the handle ${username}`);
    if (profile.role !== 'admin') {
      throw new ConvexError(`${username} is not an admin; make them one first`);
    }
    if (profile.canEditLedger === true) return { seeded: false };
    await grantLedgerEditorImpl(ctx, null, {
      userId: profile._id,
      reason: 'The first ledger editor, seeded',
      seeded: true,
    });
    return { seeded: true };
  },
});
