/**
 * Undo handlers for roles, ledger editing, access alerts, approaches, posted rules, known features, recurrence and
 * hazard merges (D226, B01 §11). Composed into `UNDO_HANDLERS` by `undoHandlers.ts`; the shapes are
 * `undoTypes.ts`'s.
 *
 * Each handler calls the helper the inverse verb's own mutation calls, so the undo runs the same
 * guards and side effects: a role undo refuses self-targeting exactly as `admin.grantRole` does, an
 * approach undo passes the hike-in gate and recomputes the body's `accessKind`, a promotion's undo
 * clears the hazards' backlinks and sends the cluster back to the queue, and a merge's undo restores
 * the survivor's own footprint and the card's count.
 */

import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { setOfficialImpl } from '../accessAlerts';
import { setPutInAccessImpl } from '../accessPoints';
import { type ElevatedRole, grantRoleImpl, revokeRoleImpl } from '../admin';
import { demoteImpl } from '../bodyFeatures';
import { unmergeImpl } from '../hazards';
import { type PostedAccessTarget, setPostedAccessImpl } from '../postedAccess';
import { suppressImpl, unsuppressImpl } from '../recurrence';
import type { ModerationAction, ModerationTargetType } from './audit';
import { grantLedgerEditorImpl, revokeLedgerEditorImpl } from './ledgerEditors';
import { UNDO_POLICY } from './undoPolicy';
import { meta, PREDATES, type TargetUndo, type UndoCall, type UndoHandler } from './undoTypes';

// ── Roles ─────────────────────────────────────────────────────────────────────────────────────────

type Role = Doc<'profiles'>['role'];

/** Put a person's role back to `prior` through the verb that produces it (self-guard included). */
async function restoreRole({ ctx, actor, row, reason }: UndoCall, prior: Role): Promise<void> {
  const userId = row.targetId as Id<'profiles'>;
  if (prior === 'member') {
    await revokeRoleImpl(ctx, actor, { userId, reason });
  } else {
    await grantRoleImpl(ctx, actor, { userId, role: prior as ElevatedRole, reason });
  }
}

const priorRoleOf = (row: Doc<'moderationActions'>): Role | undefined => meta(row).priorRole;

/** grant_role / revoke_role → the role it replaced. Both ask a reason (the registry's rule). */
const undoRoleChange: UndoHandler = {
  blocked: (row, viewer) => {
    const prior = priorRoleOf(row);
    if (prior === undefined) return PREDATES;
    if (viewer !== undefined && row.targetId === viewer._id) {
      return 'This changed your own role; another admin has to undo it.';
    }
    if (row.action === 'revoke_role' && prior === 'member') {
      return 'Nothing was revoked: they were already a member.';
    }
    return null;
  },
  undoTakesAway: (row) => UNDO_POLICY[row.action].takesAway(priorRoleOf(row)),
  run: (call) => restoreRole(call, priorRoleOf(call.row) as Role),
};

// ── Ledger editing (D227): grant ↔ revoke ────────────────────────────────────────────────────────

/**
 * grant_ledger_editor → taken again. Through the revoke's own helper, so the last-editor rule holds:
 * the seeded first editor's grant can't be undone while they are the only one.
 */
const undoLedgerGrant: UndoHandler = {
  undoTakesAway: () => UNDO_POLICY.revoke_ledger_editor.takesAway(),
  run: ({ ctx, actor, row, reason }) =>
    revokeLedgerEditorImpl(ctx, actor, { userId: row.targetId as Id<'profiles'>, reason }),
};

/** revoke_ledger_editor → given back, unless it went with a demotion (undo that instead). */
const undoLedgerRevoke: UndoHandler = {
  blocked: (row) =>
    meta(row).cause === 'role_change'
      ? 'This went with a role change. Undoing that does not give it back; a holder gives it again.'
      : null,
  undoTakesAway: () => UNDO_POLICY.grant_ledger_editor.takesAway(),
  run: ({ ctx, actor, row, reason }) =>
    grantLedgerEditorImpl(ctx, actor, { userId: row.targetId as Id<'profiles'>, reason }),
};

// ── Access alerts: pin ↔ unpin ────────────────────────────────────────────────────────────────────

interface AlertPrev {
  status: Doc<'accessAlerts'>['status'];
  expiresAt: number | null;
}

const alertPrevOf = (row: Doc<'moderationActions'>): AlertPrev | undefined => meta(row).prev;

/**
 * pin → released. The release restarts the community clock (the unpin's own rule), which puts back
 * what was there only if the alert was live and still would be; otherwise releasing it would show a
 * claim that had lapsed, or been withdrawn, as live.
 */
const undoPin: UndoHandler = {
  blocked: (row) => {
    const prev = alertPrevOf(row);
    if (prev === undefined) return PREDATES;
    switch (prev.status) {
      case 'official':
        return 'It was already pinned before this, so there is nothing to release.';
      case 'retracted':
        return 'It had been retracted before the pin; releasing it would put a withdrawn claim back on the map.';
      case 'resolved':
        return 'The people who checked it had resolved it before the pin; releasing it would put a closed claim back on the map.';
      case 'expired':
        return 'It had expired before the pin; releasing it would put a lapsed claim back on the map.';
    }
    if (prev.expiresAt !== null && prev.expiresAt <= Date.now()) {
      return 'It would have expired by now; releasing it would put a lapsed claim back on the map. Retract it instead.';
    }
    return null;
  },
  undoTakesAway: () => UNDO_POLICY.unpin_access_alert.takesAway(),
  run: ({ ctx, actor, row, reason }) =>
    setOfficialImpl(ctx, actor, {
      accessAlertId: row.targetId as Id<'accessAlerts'>,
      official: false,
      reason,
    }),
};

/** unpin → pinned again. */
const undoUnpin: UndoHandler = {
  blocked: (row) => {
    const prev = alertPrevOf(row);
    if (prev === undefined) return PREDATES;
    if (prev.status !== 'official') return 'It was not pinned, so there is no pin to put back.';
    return null;
  },
  undoTakesAway: () => UNDO_POLICY.pin_access_alert.takesAway(),
  run: async ({ ctx, actor, row, reason }) => {
    const accessAlertId = row.targetId as Id<'accessAlerts'>;
    // What happened to the claim since the unpin writes no audit row — an author's retraction, the
    // community's votes resolving it, the expiry sweep, or an expiry the sweep hasn't reached — so
    // none of it overtakes this one; read the alert's live state here. Only a claim still live in
    // the community lifecycle can be pinned back: pinning drops its expiry, so pinning a closed or
    // lapsed one would put a dead claim back on the map for good (the pin's undo refuses the same).
    const alert = await ctx.db.get(accessAlertId);
    const closed =
      alert?.status === 'retracted'
        ? 'been retracted'
        : alert?.status === 'resolved'
          ? 'been resolved by the people who checked it'
          : alert?.status === 'expired' ||
              (alert?.status === 'active' &&
                alert.expiresAt !== undefined &&
                alert.expiresAt <= Date.now())
            ? 'expired'
            : null;
    if (closed !== null) {
      throw new ConvexError(`The alert has ${closed} since; it can’t be pinned back`);
    }
    if (alert?.status !== 'active') {
      throw new ConvexError('The alert is not in a state that can be pinned back');
    }
    await setOfficialImpl(ctx, actor, { accessAlertId, official: true, reason });
  },
};

// ── Approaches and posted rules ───────────────────────────────────────────────────────────────────

interface ApproachPrev {
  parkingAreaId: Id<'parkingAreas'> | null;
  approachKindOverride: Doc<'putIns'>['approachKindOverride'] | null;
}

/** set_approach_kind → the override it replaced (or none), through the same gate and recompute. */
const undoApproachKind: UndoHandler = {
  blocked: (row) => {
    const { prev, parkingAreaId } = meta(row) as { prev?: ApproachPrev; parkingAreaId?: string };
    if (prev === undefined) return PREDATES;
    if ((parkingAreaId ?? null) !== prev.parkingAreaId) {
      return 'This also changed the put-in’s parking, which undo can’t put back yet; set the approach by hand.';
    }
    return null;
  },
  undoTakesAway: (row) =>
    UNDO_POLICY.set_approach_kind.takesAway((meta(row).prev as ApproachPrev).approachKindOverride),
  run: ({ ctx, actor, row, reason }) => {
    const { approachKindOverride } = meta(row).prev as ApproachPrev;
    return setPutInAccessImpl(ctx, actor, {
      putInId: row.targetId as Id<'putIns'>,
      ...(approachKindOverride === null || approachKindOverride === undefined
        ? { clearApproachOverride: true }
        : { approachKindOverride }),
      reason,
    });
  },
};

/** set_posted_access → the rule it replaced (or none). */
const undoPostedAccess: UndoHandler = {
  blocked: (row) => (meta(row).prev === undefined ? PREDATES : null),
  undoTakesAway: (row) => UNDO_POLICY.set_posted_access.takesAway(meta(row).prev?.postedAccess),
  run: async ({ ctx, actor, row, reason }) => {
    await setPostedAccessImpl(ctx, actor, {
      target: { type: row.targetType, id: row.targetId } as PostedAccessTarget,
      postedAccess: meta(row).prev.postedAccess ?? null,
      reason,
    });
  },
};

// ── Known features and recurrence ─────────────────────────────────────────────────────────────────

/** promote_body_feature / promote_recurrence → demoted, with the backlinks and the queue restored. */
const undoPromotion: UndoHandler = {
  undoTakesAway: () => UNDO_POLICY.demote_body_feature.takesAway(),
  run: ({ ctx, actor, row, reason }) =>
    demoteImpl(ctx, actor, { bodyFeatureId: row.targetId as Id<'bodyFeatures'>, reason }),
};

interface SuppressionPrev {
  suppressedAt: number | null;
}

/** suppress_recurrence → lifted. Rows from before undo assume the cluster was not suppressed. */
const undoSuppress: UndoHandler = {
  blocked: (row) => {
    const prev = meta(row).prev as SuppressionPrev | undefined;
    if (prev !== undefined && prev.suppressedAt !== null) {
      return 'It was already suppressed before this; lifting it would drop the earlier suppression too.';
    }
    return null;
  },
  undoTakesAway: () => UNDO_POLICY.unsuppress_recurrence.takesAway(),
  run: ({ ctx, actor, row, reason }) =>
    unsuppressImpl(ctx, actor, {
      recurrenceId: row.targetId as Id<'hazardRecurrence'>,
      reason,
    }),
};

/** unsuppress_recurrence → suppressed again. */
const undoUnsuppress: UndoHandler = {
  blocked: (row) => {
    const prev = meta(row).prev as SuppressionPrev | undefined;
    if (prev === undefined) return PREDATES;
    if (prev.suppressedAt === null)
      return 'Nothing was suppressed, so there is nothing to put back.';
    return null;
  },
  undoTakesAway: () => UNDO_POLICY.suppress_recurrence.takesAway(),
  run: ({ ctx, actor, row, reason }) =>
    suppressImpl(ctx, actor, { recurrenceId: row.targetId as Id<'hazardRecurrence'>, reason }),
};

// ── Hazard merges ─────────────────────────────────────────────────────────────────────────────────

/** merge_hazards → unmerged, automatic merges included; the undo row names the operator. */
const undoMerge: UndoHandler = {
  blocked: (row) => (meta(row).survivorId === undefined ? PREDATES : null),
  undoTakesAway: () => UNDO_POLICY.unmerge_hazards.takesAway(),
  run: async ({ ctx, actor, row, reason }) => {
    const hazardId = row.targetId as Id<'hazards'>;
    const loser = await ctx.db.get(hazardId);
    if (loser?.mergedIntoHazardId !== meta(row).survivorId) {
      throw new ConvexError('This pin is no longer folded into the one this merge chose');
    }
    await unmergeImpl(ctx, actor, { hazardId, reason });
  },
};

/** Verb-level handlers (verbs only this area writes). */
export const CORPUS_UNDO_HANDLERS: Partial<Record<ModerationAction, UndoHandler>> = {
  grant_role: undoRoleChange,
  revoke_role: undoRoleChange,
  grant_ledger_editor: undoLedgerGrant,
  revoke_ledger_editor: undoLedgerRevoke,
  pin_access_alert: undoPin,
  unpin_access_alert: undoUnpin,
  set_approach_kind: undoApproachKind,
  set_posted_access: undoPostedAccess,
  promote_body_feature: undoPromotion,
  promote_recurrence: undoPromotion,
  suppress_recurrence: undoSuppress,
  unsuppress_recurrence: undoUnsuppress,
  merge_hazards: undoMerge,
};

/** `hide` / `remove` / `restore` for the target kinds this area owns. */
export const CORPUS_TARGET_UNDO: Partial<Record<ModerationTargetType, TargetUndo>> = {};
