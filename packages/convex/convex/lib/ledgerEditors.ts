/**
 * Who may edit the ledger in the cost ledger (D227): a per-person grant on an admin's profile.
 *
 * The rules, in one place, so the forward mutations (`ledger.grantEditor`, `ledger.revokeEditor`),
 * their undos (`undoHandlersCorpus.ts`), the seed (`ledger.seedEditor`) and the role changes in
 * `admin.ts` all run the same checks:
 *
 * - **Only an admin holds it.** The grant is given only to an admin, and `machinery.ledger` needs the
 *   admin role as well as the grant, so a flag left on anyone else is inert.
 * - **Only a holder gives or takes it.** The gate is `requireCapability(ctx, 'machinery.ledger')`, the
 *   same capability that edits an invoice or a rate.
 * - **Never no editor.** Taking it from the last person who can act on it is refused — so a holder
 *   can step down only once another admin holds it, and the last holder can't be demoted out of
 *   admin until someone else is given it.
 * - **A demotion clears it.** Leaving admin takes the grant with it, in the same mutation and with its
 *   own audit row, so a later promotion back to admin (or the undo of the demotion) does not quietly
 *   restore it; a holder gives it again on purpose.
 */

import { isLeaving } from '@skating/core';
import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { writeAudit } from './audit';

type Profile = Doc<'profiles'>;

/**
 * How many admins a ledger query reads at most. Admins are a handful; the bound is there so the read
 * stays bounded however the table grows.
 */
const ADMIN_READ_LIMIT = 500;

/** Holds the grant and the role it needs (D227). The capability check is `hasCapability`. */
export function isLedgerEditor(profile: Pick<Profile, 'role' | 'canEditLedger'>): boolean {
  return profile.role === 'admin' && profile.canEditLedger === true;
}

/** Not banned or deleted, and not on their way out (a departing operator loses every write, D62). */
function canStillAct(profile: Profile): boolean {
  return (
    profile.status !== 'banned' &&
    profile.status !== 'deleting' &&
    profile.status !== 'deleted' &&
    !isLeaving(profile)
  );
}

/** An editor who can still act. This is who counts toward "never no editor". */
function canStillEdit(profile: Profile): boolean {
  return isLedgerEditor(profile) && canStillAct(profile);
}

/** Editors who can still act, other than `exceptId`. */
export async function otherLedgerEditors(
  ctx: QueryCtx | MutationCtx,
  exceptId: Id<'profiles'>,
): Promise<number> {
  const admins = await ctx.db
    .query('profiles')
    .withIndex('by_role', (q) => q.eq('role', 'admin'))
    .take(ADMIN_READ_LIMIT);
  return admins.filter((p) => p._id !== exceptId && canStillEdit(p)).length;
}

/** Whether `target` is the only editor who can still act — taking it from them is refused. */
export async function isLastLedgerEditor(
  ctx: QueryCtx | MutationCtx,
  target: Profile,
): Promise<boolean> {
  return canStillEdit(target) && (await otherLedgerEditors(ctx, target._id)) === 0;
}

export const LAST_EDITOR_MESSAGE =
  'They are the last person who can edit the ledger; give another admin ledger editing first';

/**
 * Give `userId` ledger editing. `actor` is the admin holding it (already gated by the caller), or
 * `null` when the system seeds it. The reason is optional: giving something does not ask why (D226).
 */
export async function grantLedgerEditorImpl(
  ctx: MutationCtx,
  actor: Profile | null,
  { userId, reason, seeded }: { userId: Id<'profiles'>; reason?: string; seeded?: boolean },
): Promise<void> {
  const target = await ctx.db.get(userId);
  if (!target) throw new ConvexError('User not found');
  if (target.role !== 'admin') {
    throw new ConvexError('Only an admin can be given ledger editing');
  }
  if (!canStillAct(target)) throw new ConvexError('This account is not active');
  if (target.canEditLedger === true) throw new ConvexError('They can already edit the ledger');

  await ctx.db.patch(userId, { canEditLedger: true });
  await writeAudit(ctx, {
    ...(actor ? { actorId: actor._id } : {}),
    action: 'grant_ledger_editor',
    targetType: 'user',
    targetId: userId,
    reason: reason?.trim() || 'Can edit the ledger',
    ...(seeded ? { metadata: { seeded: true } } : {}),
  });
}

/**
 * Take ledger editing from `userId` (a holder; yourself included, while another holder remains). A
 * reason is required: taking something away asks why (D226).
 */
export async function revokeLedgerEditorImpl(
  ctx: MutationCtx,
  actor: Profile,
  { userId, reason }: { userId: Id<'profiles'>; reason: string },
): Promise<void> {
  if (reason.trim().length === 0) throw new ConvexError('A reason is required');
  const target = await ctx.db.get(userId);
  if (!target) throw new ConvexError('User not found');
  if (target.canEditLedger !== true) throw new ConvexError('They cannot edit the ledger');
  await takeLedgerGrant(ctx, actor, target, reason.trim(), {});
}

/**
 * The demotion half (called by `admin.ts` before it changes a role): when `target` holds the grant and
 * `newRole` is not admin, the grant goes too, with its own `revoke_ledger_editor` row written **before**
 * the role row — so the role change stays the newest row on the person and keeps its undo, and this
 * row reads as following from it. Refused, like a revoke, when it would leave no editor.
 */
export async function clearLedgerGrantOnDemotion(
  ctx: MutationCtx,
  actor: Profile,
  target: Profile,
  newRole: Profile['role'],
): Promise<void> {
  if (target.canEditLedger !== true || newRole === 'admin') return;
  await takeLedgerGrant(ctx, actor, target, `No longer an admin (now ${newRole})`, {
    cause: 'role_change',
    role: newRole,
  });
}

async function takeLedgerGrant(
  ctx: MutationCtx,
  actor: Profile,
  target: Profile,
  reason: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (await isLastLedgerEditor(ctx, target)) throw new ConvexError(LAST_EDITOR_MESSAGE);
  await ctx.db.patch(target._id, { canEditLedger: undefined });
  await writeAudit(ctx, {
    actorId: actor._id,
    action: 'revoke_ledger_editor',
    targetType: 'user',
    targetId: target._id,
    reason,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  });
}
