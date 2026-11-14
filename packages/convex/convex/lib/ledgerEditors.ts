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
 * - **Nor through discipline.** Suspending or banning the last editor who can act is to be refused the
 *   same way ({@link refuseDisciplineOfLastLedgerEditor}; the rule is built, its call sites owed).
 * - **A demotion clears it.** Leaving admin takes the grant with it, in the same mutation and with its
 *   own audit row, so a later promotion back to admin (or the undo of the demotion) does not quietly
 *   restore it; a holder gives it again on purpose.
 */

import { isLeaving } from '@skating/core';
import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { writeAudit } from './audit';
import { hasCapability, isLockedOut, isSuspendedNow } from './auth';

type Profile = Doc<'profiles'>;

/**
 * How many admins a ledger query reads at most. Admins are a handful; the bound is there so the read
 * stays bounded however the table grows.
 */
const ADMIN_READ_LIMIT = 500;

/**
 * May `viewer` learn who holds ledger editing (D227)? Only an admin who holds it and is not on their
 * way out — the same viewer the People row is drawn for, since anyone else "gets neither the row nor
 * who holds it". Every read that could name a holder asks this.
 */
export function seesLedgerGrants(
  viewer: Pick<Profile, 'role' | 'canEditLedger' | 'deletionRequestedAt'>,
): boolean {
  return hasCapability(viewer, 'machinery.ledger') && !isLeaving(viewer);
}

/** The audit rows that say who was given, or lost, ledger editing. */
const LEDGER_GRANT_ACTIONS: ReadonlySet<string> = new Set([
  'grant_ledger_editor',
  'revoke_ledger_editor',
]);

/**
 * `rows` without the ledger-grant rows, unless `viewer` may see who holds it. A grant row names its
 * holder by its target, so a history that showed it to anyone would undo the People row's secrecy.
 */
export function withoutLedgerGrantsFor<R extends { action: string }>(
  viewer: Pick<Profile, 'role' | 'canEditLedger' | 'deletionRequestedAt'>,
  rows: R[],
): R[] {
  return seesLedgerGrants(viewer) ? rows : rows.filter((r) => !LEDGER_GRANT_ACTIONS.has(r.action));
}

/** Holds the grant and the role it needs (D227). The capability check is `hasCapability`. */
export function isLedgerEditor(profile: Pick<Profile, 'role' | 'canEditLedger'>): boolean {
  return profile.role === 'admin' && profile.canEditLedger === true;
}

/**
 * Can write right now: not banned or deleted, not inside a suspension (`requireProfile` refuses
 * every write until it lapses), and not on their way out (a departing operator loses every write,
 * D62). A suspended holder can't edit or pass the grant on, so they don't count toward "never no
 * editor" — or the last holder who can act could step down and strand it.
 */
function canStillAct(profile: Profile): boolean {
  return !isLockedOut(profile) && !isSuspendedNow(profile, Date.now()) && !isLeaving(profile);
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
 * The discipline half of "never no editor" (B01, the governor's ruling on D227): a suspension or a
 * ban takes away the last editor who can act just as a revoke or a demotion would — a suspended or
 * banned holder can't edit or pass the grant on — so it is refused with the same message. To be
 * called before the status changes, by every path that suspends or bans (`moderation.banImpl`,
 * `moderation.suspendImpl`, and an undo that puts a suspension or ban back). **Not wired yet:**
 * those call sites are owed (the B01 register's H4), so until they land discipline does not refuse.
 */
export async function refuseDisciplineOfLastLedgerEditor(
  ctx: QueryCtx | MutationCtx,
  target: Profile,
): Promise<void> {
  if (await isLastLedgerEditor(ctx, target)) throw new ConvexError(LAST_EDITOR_MESSAGE);
}

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
