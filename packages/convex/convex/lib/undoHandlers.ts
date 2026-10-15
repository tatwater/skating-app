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
import type { MutationCtx } from '../_generated/server';
import {
  banImpl,
  type ContentTargetType,
  type PostingPermission,
  setBountyLimitImpl,
  setContentStatus,
  setPostingPermissionImpl,
  suspendImpl,
  unbanImpl,
} from '../moderation';
import type { ModerationAction } from './audit';
import { UNDO_POLICY } from './undoPolicy';

export interface UndoCall {
  ctx: MutationCtx;
  actor: Doc<'profiles'>;
  row: Doc<'moderationActions'>;
  reason: string;
}

export interface UndoHandler {
  blocked?: (row: Doc<'moderationActions'>) => string | null;
  undoTakesAway: (row: Doc<'moderationActions'>) => boolean;
  run: (call: UndoCall) => Promise<void>;
}

// biome-ignore lint/suspicious/noExplicitAny: metadata is `v.any()` in the schema; each handler reads its own shape.
type Meta = Record<string, any>;
const meta = (row: Doc<'moderationActions'>): Meta => (row.metadata ?? {}) as Meta;

const PREDATES = 'This was done before undo existed, and nothing records what it replaced.';

// ── Content: reports, posts, comments, hazards ────────────────────────────────────────────────────

const CONTENT_TARGETS = new Set<string>(['report', 'post', 'comment', 'hazard']);
type ContentStatus = 'visible' | 'hidden' | 'removed';

function contentBlocked(row: Doc<'moderationActions'>): string | null {
  if (!CONTENT_TARGETS.has(row.targetType)) {
    return 'Undo for this kind of item lands with the Body console.';
  }
  // A row a Post's verdict wrote for one of its members is undone with the Post, not on its own.
  if (meta(row).cascadedFromPostId !== undefined || meta(row).derivedFromReportId !== undefined) {
    return 'This followed from a Post; undo it on the Post.';
  }
  return null;
}

const takeContentBackTo =
  (status: ContentStatus) =>
  async ({ ctx, actor, row, reason }: UndoCall) => {
    await setContentStatus(ctx, actor, {
      targetType: row.targetType as ContentTargetType,
      targetId: row.targetId,
      status,
      reason,
    });
  };

/** hide / remove → visible again. */
const contentUndoTakedown: UndoHandler = {
  blocked: contentBlocked,
  undoTakesAway: () => false,
  run: takeContentBackTo('visible'),
};

/** restore → the status it restored from. */
const contentUndoRestore: UndoHandler = {
  blocked: (row) => {
    const prior = meta(row).priorStatus;
    if (prior !== 'hidden' && prior !== 'removed') return PREDATES;
    return contentBlocked(row);
  },
  undoTakesAway: () => true,
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

export const UNDO_HANDLERS: Partial<Record<ModerationAction, UndoHandler>> = {
  hide: contentUndoTakedown,
  remove: contentUndoTakedown,
  restore: contentUndoRestore,
  ban: undoDiscipline,
  suspend: undoDiscipline,
  unban: undoLift,
  set_posting_permission: undoPostingPermission,
};
