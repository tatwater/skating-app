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
 * - **Nor through discipline.** Suspending or banning the last editor who can act is refused the same
 *   way, with the same message (`lib/peopleCan.disciplineRefusal`, which `moderation.banImpl` and
 *   `moderation.suspendImpl` refuse by, and an undo putting a ban or suspension back runs too).
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
import { factsOfRow, READY_ROWS, refreshPersonRow } from './peopleRows';

type Profile = Doc<'profiles'>;

/** What "can still act" and "the last editor" read of a person. */
export type LedgerFacts = Pick<
  Profile,
  '_id' | 'role' | 'canEditLedger' | 'status' | 'suspendedUntil' | 'deletionRequestedAt'
>;

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
function canStillAct(profile: LedgerFacts): boolean {
  return !isLockedOut(profile) && !isSuspendedNow(profile, Date.now()) && !isLeaving(profile);
}

/** An editor who can still act. This is who counts toward "never no editor". */
function canStillEdit(profile: LedgerFacts): boolean {
  return isLedgerEditor(profile) && canStillAct(profile);
}

/** Admins' People rows read at most when looking for another editor. */
const ADMIN_ROWS = 200;
/** Candidate editors whose profiles are read to confirm them, at most — a "select few" (D227). */
const VERIFY_PROFILES = 3;

/**
 * Editors who can still act, other than `exceptId` — counted far enough to answer "any?".
 *
 * Once the People rows exist (`ready:rows`), the candidates come from admins' light rows
 * (`peopleRows.ledgerEditor`) and at most {@link VERIFY_PROFILES} of their profiles are read to confirm
 * each can still act — so the read is a few profiles, never every admin's (a profile can weigh a
 * whole document). A holder the row already shows can't act (banned, suspended, on their way out) is
 * passed over without a read, so it never takes one of the few confirmations from a holder who can.
 * A stale row can only undercount (a holder it misses, or one it names that the profile no longer
 * confirms), which refuses a revoke rather than allowing one: never no editor. Before the rows exist,
 * the admins' profiles are read as they always were.
 */
export async function otherLedgerEditors(
  ctx: QueryCtx | MutationCtx,
  exceptId: Id<'profiles'>,
): Promise<number> {
  const ready = await ctx.db
    .query('peopleCounts')
    .withIndex('by_key', (q) => q.eq('key', READY_ROWS))
    .first();
  if (ready === null) {
    const admins = await ctx.db
      .query('profiles')
      .withIndex('by_role', (q) => q.eq('role', 'admin'))
      .take(ADMIN_READ_LIMIT);
    return admins.filter((p) => p._id !== exceptId && canStillEdit(p)).length;
  }
  const rows = await ctx.db
    .query('peopleRows')
    .withIndex('by_staff', (q) => q.eq('staffRank', 0))
    .take(ADMIN_ROWS);
  let confirmed = 0;
  let read = 0;
  for (const row of rows) {
    if (!row.ledgerEditor || row.userId === exceptId || !canStillEdit(factsOfRow(row))) continue;
    if (read >= VERIFY_PROFILES) break;
    read++;
    const profile = await ctx.db.get(row.userId);
    if (profile && canStillEdit(profile)) confirmed++;
  }
  return confirmed;
}

/**
 * One answer per person per read: a query asks it for several levers and History rows, and the
 * answer can't change inside a query. A mutation always asks afresh, since its own writes can.
 */
const LAST_MEMO = new WeakMap<object, Map<string, boolean>>();

/** Whether `target` is the only editor who can still act — taking it from them is refused. */
export async function isLastLedgerEditor(
  ctx: QueryCtx | MutationCtx,
  target: LedgerFacts,
): Promise<boolean> {
  if (!canStillEdit(target)) return false;
  const isQuery = !('insert' in ctx.db);
  const memo = isQuery ? (LAST_MEMO.get(ctx) ?? new Map<string, boolean>()) : null;
  if (memo?.has(target._id)) return memo.get(target._id) as boolean;
  const last = (await otherLedgerEditors(ctx, target._id)) === 0;
  if (memo) {
    memo.set(target._id, last);
    LAST_MEMO.set(ctx, memo);
  }
  return last;
}

export const LAST_EDITOR_MESSAGE =
  'They are the last person who can edit the ledger; give another admin ledger editing first';

/** Why `target` can't be given ledger editing, or `null` — the People row's `can` and the write's. */
export function ledgerGrantRefusal(target: LedgerFacts): string | null {
  if (target.role !== 'admin') return 'Only an admin can be given ledger editing';
  if (!canStillAct(target)) return 'This account is not active';
  if (target.canEditLedger === true) return 'They can already edit the ledger';
  return null;
}

/** Why ledger editing can't be taken from `target`, or `null`. */
export async function ledgerRevokeRefusal(
  ctx: QueryCtx | MutationCtx,
  target: LedgerFacts,
): Promise<string | null> {
  if (target.canEditLedger !== true) return 'They cannot edit the ledger';
  if (await isLastLedgerEditor(ctx, target)) return LAST_EDITOR_MESSAGE;
  return null;
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
  const refused = ledgerGrantRefusal(target);
  if (refused !== null) throw new ConvexError(refused);

  await ctx.db.patch(userId, { canEditLedger: true });
  await refreshPersonRow(ctx, userId);
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
  const refused = await ledgerRevokeRefusal(ctx, target);
  if (refused !== null) throw new ConvexError(refused);
  await takeLedgerGrant(ctx, actor, target, reason.trim(), {});
  await refreshPersonRow(ctx, userId);
}

/**
 * The demotion half (called by `admin.ts` before it changes a role): when `target` holds the grant and
 * `newRole` is not admin, the grant goes too, with its own `revoke_ledger_editor` row written **before**
 * the role row — so the role change stays the newest row on the person and keeps its undo, and this
 * row reads as following from it. Refused, like a revoke, when it would leave no editor. The person's
 * People row is the caller's to refresh, once, after its role patch.
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
