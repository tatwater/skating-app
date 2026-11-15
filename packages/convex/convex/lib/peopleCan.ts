/**
 * What may be done to a person, decided once (B01 §5.7, D217's "a control the server would refuse is
 * never drawn"). The writes refuse through these, and `people.person` computes its `can` from the
 * same functions, so the page never draws a lever the server turns down.
 *
 * - **Discipline** (posting rights, the bounty limit, flagging, suspend, ban, lift): never yourself,
 *   never an admin unless you are one (D37), never an account being finalized or deleted. The
 *   status levers — suspend, ban, lift — are also refused while the account is in its deletion
 *   window: a status write there would overwrite or outlast the deletion (a lapsing suspension would
 *   unlock an account partway through it), and a lift was already refused there (#113). Suspending
 *   or banning the last ledger editor who can act is refused (D252).
 * - **Flagging** can't be switched off on staff: they are exempt from it (D222).
 * - **Roles**: never your own; never on an account being finalized or deleted; a demotion of the
 *   last ledger editor is refused (D227).
 * - **A reason is asked only when something is taken away** (D226): a give-back's audit row gets a
 *   default reason, marked so History can leave it out.
 */

import { canUse, isLeaving, ROLE_RANK } from '@skating/core';
import { ConvexError } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import {
  isLastLedgerEditor,
  LAST_EDITOR_MESSAGE,
  type LedgerFacts,
  ledgerGrantRefusal,
  ledgerRevokeRefusal,
} from './ledgerEditors';

type Profile = Doc<'profiles'>;

/**
 * What the rule reads of a person: a profile, or the People row's copy of these facts
 * (`lib/peopleRows.factsOfRow` — undo state reads a row per History line, and the row carries the
 * ledger grant, so the last-editor refusal is the same from either).
 */
export type PersonFacts = LedgerFacts;
type Ctx = QueryCtx | MutationCtx;

/** Whether a control may be drawn and pressed, and if not, why — in words the page can show. */
export type Can = { ok: true; needsReason: boolean } | { ok: false; why: string };
export const yes = (needsReason: boolean): Can => ({ ok: true, needsReason });
export const no = (why: string): Can => ({ ok: false, why });

export type Lever = 'restrict' | 'suspend' | 'ban' | 'lift';

export const DISCIPLINE_REFUSALS = {
  self: 'You cannot moderate your own account',
  admin: 'Only an admin can moderate an admin',
  /** A lift on an account on its way out, or gone (#113's words, kept). */
  liftLeaving: 'This account is being deleted, so its suspension or ban can’t be lifted.',
  liftDeleted: 'This account is deleted, so there is nothing to lift.',
  statusLeaving: 'This account is being deleted, so it can’t be suspended or banned.',
  statusDeleted: 'This account is deleted, so it can’t be suspended or banned.',
  restrictGone: 'This account is deleted, so there is nothing to restrict.',
  staffFlagging: 'Staff can always flag, so flagging can’t be switched off for them.',
} as const;

export const ROLE_REFUSALS = {
  self: 'You cannot change your own role',
  gone: 'This account is being deleted, so its role can’t change.',
  current: 'This is their role now.',
} as const;

/** Being taken apart (the finalization lock) or a tombstone. */
function gone(target: Pick<Profile, 'status'>): boolean {
  return target.status === 'deleting' || target.status === 'deleted';
}

/** Why `actor` may not pull `lever` on `target`, or `null`. The writes and `can` both read this. */
export async function disciplineRefusal(
  ctx: Ctx,
  actor: Pick<Profile, '_id' | 'role'>,
  target: PersonFacts,
  lever: Lever,
): Promise<string | null> {
  if (target._id === actor._id) return DISCIPLINE_REFUSALS.self;
  if (target.role === 'admin' && actor.role !== 'admin') return DISCIPLINE_REFUSALS.admin;
  if (lever === 'restrict') return gone(target) ? DISCIPLINE_REFUSALS.restrictGone : null;
  const leaving = gone(target) || isLeaving(target);
  if (lever === 'lift') {
    if (target.status === 'deleted') return DISCIPLINE_REFUSALS.liftDeleted;
    return leaving ? DISCIPLINE_REFUSALS.liftLeaving : null;
  }
  if (target.status === 'deleted') return DISCIPLINE_REFUSALS.statusDeleted;
  if (leaving) return DISCIPLINE_REFUSALS.statusLeaving;
  // Never no ledger editor (D252): a suspended or banned holder can neither edit nor pass it on.
  if (await isLastLedgerEditor(ctx, target)) return LAST_EDITOR_MESSAGE;
  return null;
}

/**
 * Every write the People page can make to a person, as the one rule sees it. Each forward write
 * refuses through {@link writeRefusal} with its own write; `people.person`'s `can` asks it for each
 * lever; and an undo — a write of the previous state — asks it for the write that undo would run
 * (`lib/undoHandlers`' `personWrite`), so what History offers is what the write accepts.
 */
export type PersonWrite =
  | { kind: 'right'; permission: 'reports' | 'hazards' | 'comments' | 'flagging'; allowed: boolean }
  | { kind: 'bountyLimit' }
  | { kind: 'suspend' }
  | { kind: 'ban' }
  | { kind: 'lift' }
  | { kind: 'role'; role: Profile['role'] }
  | { kind: 'ledgerGrant' }
  | { kind: 'ledgerRevoke' };

/** Why `actor` may not make `write` to `target`, or `null` — the one rule. */
export async function writeRefusal(
  ctx: Ctx,
  actor: Pick<Profile, '_id' | 'role'>,
  target: PersonFacts,
  write: PersonWrite,
): Promise<string | null> {
  switch (write.kind) {
    case 'right': {
      const refused = await disciplineRefusal(ctx, actor, target, 'restrict');
      if (refused !== null) return refused;
      return write.permission === 'flagging' && !write.allowed ? flaggingOffRefusal(target) : null;
    }
    case 'bountyLimit':
      return disciplineRefusal(ctx, actor, target, 'restrict');
    case 'suspend':
    case 'ban':
    case 'lift':
      return disciplineRefusal(ctx, actor, target, write.kind);
    case 'role':
      return roleRefusal(ctx, actor, target, write.role);
    case 'ledgerGrant':
      return ledgerGrantRefusal(target);
    case 'ledgerRevoke':
      return ledgerRevokeRefusal(ctx, target);
  }
}

/**
 * Whether `write` takes something away from `target`, so the page asks a reason (D226) — the rule
 * the writes require one by. A bounty limit takes away when it lowers the limit in force, which the
 * page knows from the value chosen; restricting is the lever drawn, so it is `true` here.
 */
export function writeTakesAway(target: Pick<Profile, 'role'>, write: PersonWrite): boolean {
  switch (write.kind) {
    case 'right':
      return !write.allowed;
    case 'role':
      return roleChangeTakesAway(target.role, write.role);
    case 'lift':
    case 'ledgerGrant':
      return false;
    default:
      return true;
  }
}

/** Refuse unless {@link writeRefusal} allows it. */
export async function assertWrite(
  ctx: MutationCtx,
  actor: Pick<Profile, '_id' | 'role'>,
  target: PersonFacts,
  write: PersonWrite,
): Promise<void> {
  const why = await writeRefusal(ctx, actor, target, write);
  if (why !== null) throw new ConvexError(why);
}

/** Why flagging can't be switched off on `target`: staff are exempt (D222). */
export function flaggingOffRefusal(target: Pick<Profile, 'role'>): string | null {
  return ROLE_RANK[target.role] >= ROLE_RANK.moderator ? DISCIPLINE_REFUSALS.staffFlagging : null;
}

/** Why `actor` may not move `target` to `role`, or `null`. */
export async function roleRefusal(
  ctx: Ctx,
  actor: Pick<Profile, '_id'>,
  target: PersonFacts,
  role: Profile['role'],
): Promise<string | null> {
  if (target._id === actor._id) return ROLE_REFUSALS.self;
  if (gone(target)) return ROLE_REFUSALS.gone;
  if (role === target.role) return ROLE_REFUSALS.current;
  // A demotion out of admin takes ledger editing with it, refused for the last editor (D227).
  if (
    role !== 'admin' &&
    target.canEditLedger === true &&
    (await isLastLedgerEditor(ctx, target))
  ) {
    return LAST_EDITOR_MESSAGE;
  }
  return null;
}

/** Whether moving `from` to `to` takes something away (a demotion asks why; a promotion does not). */
export function roleChangeTakesAway(from: Profile['role'], to: Profile['role']): boolean {
  return ROLE_RANK[to] < ROLE_RANK[from];
}

/**
 * The audit reason for a write: the person's own, trimmed; required when the write takes something
 * away (D226); otherwise `fallback`, with `defaulted` set so History can leave the line out.
 */
export function reasonFor(
  given: string | undefined,
  takesAway: boolean,
  fallback: string,
): { reason: string; defaulted: boolean } {
  const trimmed = given?.trim() ?? '';
  if (trimmed.length > 0) return { reason: trimmed, defaulted: false };
  if (takesAway) throw new ConvexError('A reason is required');
  return { reason: fallback, defaulted: true };
}

/** Whether the viewer can use a write capability right now (the role, and not on their way out). */
export function viewerCan(
  viewer: Pick<Profile, 'role' | 'deletionRequestedAt' | 'canEditLedger'>,
  capability: 'people.discipline' | 'people.role',
): boolean {
  return canUse(viewer.role, isLeaving(viewer), capability, viewer);
}
