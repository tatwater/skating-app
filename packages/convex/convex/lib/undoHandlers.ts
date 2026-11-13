/**
 * How each undoable verb is undone (D226, B01 §11) — the code half of `undoPolicy.ts`.
 *
 * Every handler calls the inverse verb's **own** helper, the one its mutation calls, so the undo
 * runs the same side effects (counts, cards, cascades, Clerk). A handler says:
 * - `blocked(row)`: why this particular row can't be undone (it predates the data undo needs, or its
 *   target kind's inverse lands in a later workstream), or `null`;
 * - `undoTakesAway(row)`: whether the value the undo puts back takes something away (D226's reason);
 * - `run(call)`: the undo.
 *
 * Verbs not here yet are reported as "not built yet" by `lib/undo.ts`; the registry's `later` entries
 * say which workstream owes them.
 */

import type { Doc, Id } from '../_generated/dataModel';
import {
  banImpl,
  type ContentTargetType,
  type PostCascade,
  type PostingPermission,
  revertPostVerdict,
  setBountyLimitImpl,
  setContentStatus,
  setPostingPermissionImpl,
  suspendImpl,
  unbanImpl,
} from '../moderation';
import type { ModerationAction, ModerationTargetType } from './audit';
import { BODY_TARGET_UNDO, BODY_UNDO_HANDLERS } from './undoHandlersBody';
import { CORPUS_TARGET_UNDO, CORPUS_UNDO_HANDLERS } from './undoHandlersCorpus';
import { UNDO_POLICY } from './undoPolicy';
import { meta, PREDATES, type TargetUndo, type UndoCall, type UndoHandler } from './undoTypes';

// ── Content: reports, posts, comments, hazards ────────────────────────────────────────────────────

type ContentStatus = 'visible' | 'hidden' | 'removed';

/** How far down an item is: a step up this ladder takes something away (D226's reason rule). */
const STATUS_SEVERITY: Record<ContentStatus, number> = { visible: 0, hidden: 1, removed: 2 };

function contentBlocked(row: Doc<'moderationActions'>): string | null {
  // A row a Post's verdict wrote for one of its members is undone with the Post, not on its own.
  if (meta(row).cascadedFromPostId !== undefined || meta(row).derivedFromReportId !== undefined) {
    return 'This followed from a Post; undo it on the Post.';
  }
  return null;
}

/**
 * The members a Post's verdict moved, as its row recorded them — `undefined` on any other target, and
 * on a Post row from before the record (those undo through the cascade, as they always did).
 */
function cascadeOf(row: Doc<'moderationActions'>): PostCascade[] | undefined {
  return row.targetType === 'post' ? (meta(row).cascaded as PostCascade[] | undefined) : undefined;
}

const takeContentBackTo =
  (status: ContentStatus) =>
  async ({ ctx, actor, row, reason }: UndoCall) => {
    // A Post whose row lists its members goes back with each of them to its own prior status,
    // whatever the Post returns to (founder call, 2026-11-13).
    if (cascadeOf(row) !== undefined) {
      await revertPostVerdict(ctx, actor, { row, reason });
      return;
    }
    await setContentStatus(ctx, actor, {
      targetType: row.targetType as ContentTargetType,
      targetId: row.targetId,
      status,
      reason,
      // A Post's removal took its Reports down with it; its undo, back to visible, brings them back
      // too. (`setContentStatus` reads the flag only on the way to visible.)
      ...(row.action === 'remove' && status === 'visible' ? { reviveRemoved: true } : {}),
    });
  };

/**
 * Does undoing this row put anything — the item, or a member of a Post — back further down? Then it
 * takes something away, and asks why (D226's reason rule): one rule for hide, remove and restore.
 */
function contentUndoTakesAway(row: Doc<'moderationActions'>): boolean {
  const { priorStatus, newStatus } = meta(row) as {
    priorStatus: ContentStatus;
    newStatus: ContentStatus;
  };
  if (STATUS_SEVERITY[priorStatus] > STATUS_SEVERITY[newStatus]) return true;
  return (cascadeOf(row) ?? []).some(
    (m) => STATUS_SEVERITY[m.from as ContentStatus] > STATUS_SEVERITY[m.to as ContentStatus],
  );
}

/**
 * hide / remove → the status it took the item down from, as the row recorded it. Not "visible"
 * regardless: removing an item a moderator had already hidden, then undoing the removal, must leave
 * it hidden, never publish it. A takedown that changed nothing — not the item, and on a Post none of
 * its members — has nothing to undo, and a row without the prior status can't say what to put back.
 */
const contentUndoTakedown: UndoHandler = {
  blocked: (row) => {
    const { priorStatus, newStatus } = meta(row);
    if (priorStatus !== 'visible' && priorStatus !== 'hidden' && priorStatus !== 'removed') {
      return PREDATES;
    }
    if (priorStatus === newStatus && (cascadeOf(row) ?? []).length === 0) {
      return `Nothing changed: it was already ${priorStatus}.`;
    }
    return contentBlocked(row);
  },
  undoTakesAway: contentUndoTakesAway,
  run: (call) => takeContentBackTo(meta(call.row).priorStatus as ContentStatus)(call),
};

/** restore → the status it restored from (a Post's members, each to theirs). */
const contentUndoRestore: UndoHandler = {
  blocked: (row) => {
    const prior = meta(row).priorStatus;
    if (prior !== 'hidden' && prior !== 'removed') return PREDATES;
    return contentBlocked(row);
  },
  undoTakesAway: contentUndoTakesAway,
  run: (call) => takeContentBackTo(meta(call.row).priorStatus as ContentStatus)(call),
};

// ── People: lifecycle and posting rights ──────────────────────────────────────────────────────────

interface StatusPrev {
  status: Doc<'profiles'>['status'];
  statusReason: string | null;
  suspendedUntil: number | null;
}

/** Put a person's lifecycle back to `prev` through the verb that produces it. */
async function restoreStatus(call: UndoCall, prev: StatusPrev): Promise<void> {
  const userId = call.row.targetId as Id<'profiles'>;
  const reason = call.reason;
  if (prev.status === 'banned') {
    await banImpl(call.ctx, call.actor, { userId, reason });
  } else if (prev.status === 'suspended' && prev.suspendedUntil !== null) {
    await suspendImpl(call.ctx, call.actor, {
      userId,
      reason,
      suspendedUntil: prev.suspendedUntil,
    });
  } else {
    await unbanImpl(call.ctx, call.actor, { userId, reason });
  }
}

/** A suspension that has since run out can't be put back; everything else can. */
function statusPrevBlocked(prev: StatusPrev | undefined, now: number): string | null {
  if (prev === undefined) return null;
  if (prev.status === 'suspended' && (prev.suspendedUntil === null || prev.suspendedUntil <= now)) {
    return 'The suspension this replaced has run out since; suspend again if it should continue.';
  }
  if (prev.status === 'deleting' || prev.status === 'deleted') {
    return 'The account is being deleted.';
  }
  return null;
}

/** ban / suspend → whatever the person was before (rows from before undo assume active). */
const undoDiscipline: UndoHandler = {
  blocked: (row) => statusPrevBlocked(meta(row).prev as StatusPrev | undefined, Date.now()),
  undoTakesAway: (row) => {
    const prev = meta(row).prev as StatusPrev | undefined;
    return prev !== undefined && prev.status !== 'active';
  },
  run: (call) =>
    restoreStatus(
      call,
      (meta(call.row).prev as StatusPrev | undefined) ?? {
        status: 'active',
        statusReason: null,
        suspendedUntil: null,
      },
    ),
};

/** unban → the ban or suspension it lifted. */
const undoLift: UndoHandler = {
  blocked: (row) => {
    const prev = meta(row).prev as StatusPrev | undefined;
    if (prev === undefined) return PREDATES;
    if (prev.status === 'active') return 'Nothing was lifted: the account was already active.';
    return statusPrevBlocked(prev, Date.now());
  },
  undoTakesAway: () => true,
  run: (call) => restoreStatus(call, meta(call.row).prev as StatusPrev),
};

/** set_posting_permission → the right or the bounty limit it replaced. */
const undoPostingPermission: UndoHandler = {
  blocked: (row) => (meta(row).prev === undefined ? PREDATES : null),
  undoTakesAway: (row) => {
    const { prev, permission } = meta(row);
    return UNDO_POLICY.set_posting_permission.takesAway(
      permission === 'bounties' ? prev?.limit : prev?.allowed,
    );
  },
  run: async ({ ctx, actor, row, reason }) => {
    const { prev, permission } = meta(row);
    const userId = row.targetId as Id<'profiles'>;
    if (permission === 'bounties') {
      await setBountyLimitImpl(ctx, actor, { userId, limit: prev.limit ?? undefined, reason });
    } else {
      await setPostingPermissionImpl(ctx, actor, {
        userId,
        permission: permission as PostingPermission,
        allowed: prev.allowed as boolean,
        reason,
      });
    }
  },
};

const CONTENT: TargetUndo = {
  hide: contentUndoTakedown,
  remove: contentUndoTakedown,
  restore: contentUndoRestore,
};

/** `hide`, `remove` and `restore` are shared across kinds; each kind brings its own undo. */
const TARGET_UNDO: Partial<Record<ModerationTargetType, TargetUndo>> = {
  report: CONTENT,
  post: CONTENT,
  comment: CONTENT,
  hazard: CONTENT,
  ...BODY_TARGET_UNDO,
  ...CORPUS_TARGET_UNDO,
};

function shared(verb: keyof TargetUndo): UndoHandler {
  const forRow = (row: Doc<'moderationActions'>) => TARGET_UNDO[row.targetType]?.[verb];
  return {
    blocked: (row, viewer) => {
      const h = forRow(row);
      return h
        ? (h.blocked?.(row, viewer) ?? null)
        : 'Undo for this kind of item is not built yet.';
    },
    undoTakesAway: (row) => forRow(row)?.undoTakesAway(row) ?? false,
    run: async (call) => {
      const h = forRow(call.row);
      if (!h) throw new Error(`no undo for ${verb} on ${call.row.targetType}`);
      await h.run(call);
    },
  };
}

export const UNDO_HANDLERS: Partial<Record<ModerationAction, UndoHandler>> = {
  hide: shared('hide'),
  remove: shared('remove'),
  restore: shared('restore'),
  ban: undoDiscipline,
  suspend: undoDiscipline,
  unban: undoLift,
  set_posting_permission: undoPostingPermission,
  ...BODY_UNDO_HANDLERS,
  ...CORPUS_UNDO_HANDLERS,
};
