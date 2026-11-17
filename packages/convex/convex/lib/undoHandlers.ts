/**
 * How each undoable verb is undone (D226, B01 §11) — the code half of `undoPolicy.ts`.
 *
 * Every handler calls the inverse verb's **own** helper, the one its mutation calls, so the undo
 * runs the same side effects (counts, cards, cascades, Clerk). One exception: a Post's verdict whose
 * row lists the members it moved undoes through `revertPostVerdict`, which puts each member back to
 * its own prior status with the per-member helper the verdict itself used. A handler says:
 * - `blocked(row)`: why this particular row can't be undone (it predates the data undo needs, or its
 *   target kind's inverse lands in a later workstream), or `null`;
 * - `undoTakesAway(row)`: whether the value the undo puts back takes something away (D226's reason);
 * - `run(call)`: the undo.
 *
 * Verbs not here yet are reported as "not built yet" by `lib/undo.ts`; the registry's `later` entries
 * say which workstream owes them.
 */

import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import {
  banImpl,
  type ContentTargetType,
  type PersonWriteResult,
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
import { AUTHOR_DELETED_OVERTURN } from './authorDeletion';
import { type PersonWrite, type StatusTerms, sameStatusTerms } from './peopleCan';
import { ROW_MAX, type WaveCost } from './readBudget';
import { termsSetBy } from './statusTerms';
import { BODY_TARGET_UNDO, BODY_UNDO_HANDLERS } from './undoHandlersBody';
import { CORPUS_TARGET_UNDO, CORPUS_UNDO_HANDLERS } from './undoHandlersCorpus';
import { UNDO_POLICY } from './undoPolicy';
import {
  meta,
  NOTHING_TO_UNDO,
  PREDATES,
  type TargetUndo,
  type UndoCall,
  type UndoHandler,
  type UndoRead,
  type UndoScope,
} from './undoTypes';

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
      // A Post's removal from before the record took its Reports down with it; its undo, back to
      // visible, brings them back too. (`setContentStatus` reads the flag only on the way to visible.)
      ...(row.action === 'remove' && status === 'visible' ? { reviveRemoved: true } : {}),
      undoes: row._id,
    });
  };

/**
 * A row that left the item's status as it was (and, on a Post, moved none of its members): whatever it
 * did, it did to the person's record alone (B01-4h).
 */
function leftContentAsItWas(row: Doc<'moderationActions'>): boolean {
  const { priorStatus, newStatus } = meta(row);
  return priorStatus === newStatus && (cascadeOf(row) ?? []).length === 0;
}

/**
 * Does undoing this row put anything — the item, or a member of a Post — back further down? Then it
 * takes something away, and asks why (D226's reason rule): one rule for hide, remove and restore. A
 * row that only moved the record alternates down its undo chain: a takedown that put a decision on it
 * (depth 0, or a redo at an even depth) is undone by taking it off — a give-back — and the undo that
 * took it off (an odd depth) is undone by putting it back, which takes something away.
 */
function contentUndoTakesAway(row: Doc<'moderationActions'>): boolean {
  const { priorStatus, newStatus } = meta(row) as {
    priorStatus: ContentStatus;
    newStatus: ContentStatus;
  };
  if (STATUS_SEVERITY[priorStatus] > STATUS_SEVERITY[newStatus]) return true;
  if ((cascadeOf(row) ?? []).some((m) => STATUS_SEVERITY[m.from] > STATUS_SEVERITY[m.to])) {
    return true;
  }
  return row.action !== 'restore' && leftContentAsItWas(row) && (row.undoDepth ?? 0) % 2 === 1;
}

/** What {@link recordOnlyRefusal} reads at worst: the verdict a row minted and the one it ended. */
const RECORD_ONLY_COST: WaveCost = { bytes: 3 * ROW_MAX.verdict, reads: 2, docs: 3 };

/**
 * **Why the undo of a row that only moved the record would change nothing, or `null`** (B01-4h). The
 * row left the item as it found it — a hide of what its Post's hide took down, with no decision of its
 * own on it, or that hide's undo — so its undo is the record's alone, run through the same writer
 * (`setContentStatus` as an undo: `recordUndoneVerdict`), and it lands exactly when:
 * - the row put a decision on the record that still stands, and ended none — the undo takes it off;
 * - or the row ended a decision and put none on — the undo puts it back (`recordUndoneVerdict` mints
 *   again what the undone row ended).
 * A row that did both (a repeat from before D270: one decision replaced by another of its kind) or
 * neither changed nothing the undo could put back. Read from the verdict rows, never guessed from the
 * audit row, so History, the toast and the record pane offer it only where the write lands.
 */
async function recordOnlyRefusal(
  ctx: Parameters<NonNullable<UndoHandler['refusal']>>[0],
  row: Doc<'moderationActions'>,
  read: UndoRead,
): Promise<string | null> {
  if (!leftContentAsItWas(row)) return null;
  const [minted, ended] = await Promise.all([
    read.take('verdict', 2, () =>
      ctx.db
        .query('contentVerdicts')
        .withIndex('by_action', (q) => q.eq('actionId', row._id))
        .take(2),
    ),
    read.take('verdict', 1, () =>
      ctx.db
        .query('contentVerdicts')
        .withIndex('by_ended_by', (q) => q.eq('endedByActionId', row._id))
        .take(1),
    ),
  ]);
  const putOn = minted.length > 0;
  const tookOff = ended.length > 0;
  if (putOn && !tookOff && minted.some((v) => v.standing)) return null;
  if (tookOff && !putOn) return null;
  return `Nothing changed: it was already ${meta(row).priorStatus}.`;
}

/**
 * hide / remove → the status it took the item down from, as the row recorded it. Not "visible"
 * regardless: removing an item a moderator had already hidden, then undoing the removal, must leave
 * it hidden, never publish it. A takedown that left the item as it was moved the record alone, and its
 * undo moves the record back ({@link recordOnlyRefusal}); a row without the prior status can't say
 * what to put back.
 */
const contentUndoTakedown: UndoHandler = {
  blocked: (row) => {
    const { priorStatus, newStatus } = meta(row);
    // A verdict recorded on content its author had already deleted is reversed by an overturn (D248).
    if (meta(row).onAuthorDeleted === true) return AUTHOR_DELETED_OVERTURN;
    if (priorStatus !== 'visible' && priorStatus !== 'hidden' && priorStatus !== 'removed') {
      return PREDATES;
    }
    // A Post's row from before it listed the members it moved can't say it moved none: one that left
    // the Post as it found it may still have taken a Report down, which a record-only undo (through
    // `setContentStatus`, whose cascade revives nothing on the way down) would leave down.
    if (row.targetType === 'post' && cascadeOf(row) === undefined && priorStatus === newStatus) {
      return PREDATES;
    }
    return contentBlocked(row);
  },
  undoTakesAway: contentUndoTakesAway,
  // Only a row that left the item as it was reads the record; any other has nothing to check.
  refusalCost: (_scope, row) => (leftContentAsItWas(row) ? RECORD_ONLY_COST : null),
  refusal: recordOnlyRefusal,
  run: (call) => takeContentBackTo(meta(call.row).priorStatus as ContentStatus)(call),
};

/**
 * A restore that left the item up: it ended a decision standing on content already up (a history
 * rebuilt from before the record) — and, on a Post, may have brought back Reports its Post had taken
 * down. Putting that decision back would be a decision standing on content
 * that is up, which no write records — so the undo is refused, and says what puts one back.
 */
export const RESTORE_ENDED_ONLY =
  'This took a decision off something that was already up. Hide it again to put a decision on the record.';

/** restore → the status it restored from (a Post's members, each to theirs). */
const contentUndoRestore: UndoHandler = {
  blocked: (row) => {
    const prior = meta(row).priorStatus;
    if (prior === 'visible' && meta(row).newStatus === 'visible') return RESTORE_ENDED_ONLY;
    if (prior !== 'hidden' && prior !== 'removed') return PREDATES;
    return contentBlocked(row);
  },
  undoTakesAway: contentUndoTakesAway,
  run: (call) => takeContentBackTo(meta(call.row).priorStatus as ContentStatus)(call),
};

// ── People: lifecycle and posting rights ──────────────────────────────────────────────────────────

/** What a lifecycle row replaced: the person's terms as they stood (`lib/peopleCan`). */
type StatusPrev = StatusTerms;

/** The write that puts a lifecycle back to `prev`: a ban, a suspension (with its end), or a lift. */
function statusWrite(prev: StatusPrev): PersonWrite {
  if (prev.status === 'banned') return { kind: 'ban' };
  if (prev.status === 'suspended' && prev.suspendedUntil !== null) return { kind: 'suspend' };
  return { kind: 'lift' };
}

/**
 * An undo whose write changed nothing wrote no row (D270), so nothing is tagged as undoing the row and
 * History would keep offering it: refused instead, rolled back, in the write's own words.
 */
function assertChanged(result: PersonWriteResult): void {
  if (!result.changed) throw new ConvexError(NOTHING_TO_UNDO);
}

/** Put a person's lifecycle back to `prev` through the verb that produces it ({@link statusWrite}). */
async function restoreStatus(call: UndoCall, prev: StatusPrev): Promise<void> {
  const userId = call.row.targetId as Id<'profiles'>;
  const reason = call.reason;
  const write = statusWrite(prev);
  // The prior terms whole — their reason too, kept on file; the undo's own reason is its audit row's.
  // A row from before `prev` recorded one has none to put back: `null`, "not recorded", as the page
  // then says.
  // `?? null`, as `lib/statusTerms` reads a `prev`: a missing reason must never fall back to the
  // undo's own (`banImpl` reads `undefined` as "this write's reason").
  const statusReason = prev.statusReason ?? null;
  if (write.kind === 'ban') {
    assertChanged(await banImpl(call.ctx, call.actor, { userId, reason, statusReason }));
  } else if (write.kind === 'suspend') {
    assertChanged(
      await suspendImpl(call.ctx, call.actor, {
        userId,
        reason,
        suspendedUntil: prev.suspendedUntil as number,
        statusReason,
      }),
    );
  } else {
    assertChanged(await unbanImpl(call.ctx, call.actor, { userId, reason }));
  }
}

/** What a ban or suspension replaced (rows from before undo assume active). */
const disciplinePrev = (row: Doc<'moderationActions'>): StatusPrev =>
  (meta(row).prev as StatusPrev | undefined) ?? {
    status: 'active',
    statusReason: null,
    suspendedUntil: null,
  };

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
  blocked: (row) => {
    const prev = meta(row).prev as StatusPrev | undefined;
    if (prev !== undefined && sameStatusTerms(prev, termsSetBy(row))) return NOTHING_TO_UNDO;
    return statusPrevBlocked(prev, Date.now());
  },
  undoTakesAway: (row) => {
    const prev = meta(row).prev as StatusPrev | undefined;
    return prev !== undefined && prev.status !== 'active';
  },
  personWrite: (row) => statusWrite(disciplinePrev(row)),
  run: (call) => restoreStatus(call, disciplinePrev(call.row)),
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
  personWrite: (row) => statusWrite(meta(row).prev as StatusPrev),
  run: (call) => restoreStatus(call, meta(call.row).prev as StatusPrev),
};

/** set_posting_permission → the right or the bounty limit it replaced. */
const undoPostingPermission: UndoHandler = {
  blocked: (row) => {
    const { prev, permission, allowed, limit } = meta(row);
    if (prev === undefined) return PREDATES;
    const same =
      permission === 'bounties'
        ? (prev.limit ?? null) === (limit ?? null)
        : prev.allowed === allowed;
    return same ? NOTHING_TO_UNDO : null;
  },
  undoTakesAway: (row) => {
    const { prev, permission, limit } = meta(row);
    return UNDO_POLICY.set_posting_permission.takesAway(
      permission === 'bounties' ? { from: limit ?? null, to: prev?.limit ?? null } : prev?.allowed,
    );
  },
  personWrite: (row) => {
    const { prev, permission } = meta(row);
    return permission === 'bounties'
      ? { kind: 'bountyLimit' }
      : {
          kind: 'right',
          permission: permission as PostingPermission,
          allowed: prev.allowed as boolean,
        };
  },
  run: async ({ ctx, actor, row, reason }) => {
    const { prev, permission } = meta(row);
    const userId = row.targetId as Id<'profiles'>;
    if (permission === 'bounties') {
      assertChanged(
        await setBountyLimitImpl(ctx, actor, { userId, limit: prev.limit ?? undefined, reason }),
      );
    } else {
      assertChanged(
        await setPostingPermissionImpl(ctx, actor, {
          userId,
          permission: permission as PostingPermission,
          allowed: prev.allowed as boolean,
          reason,
        }),
      );
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
  const anyChecks = Object.values(TARGET_UNDO).some((t) => t?.[verb]?.refusal !== undefined);
  return {
    blocked: (row, viewer) => {
      const h = forRow(row);
      return h
        ? (h.blocked?.(row, viewer) ?? null)
        : 'Undo for this kind of item is not built yet.';
    },
    undoTakesAway: (row) => forRow(row)?.undoTakesAway(row) ?? false,
    // A kind's own check of the row as it stands (content's: what it did to the record), at that
    // kind's cost for that row — a row of a kind with no check (a body's removal) reserves nothing.
    ...(anyChecks
      ? {
          refusalCost: (scope: UndoScope, row: Doc<'moderationActions'>) => {
            const h = forRow(row);
            if (h?.refusal === undefined) return null;
            return h.refusalCost
              ? h.refusalCost(scope, row)
              : { bytes: ROW_MAX.waterBody, reads: 1 };
          },
          refusal: async (ctx, row, read) => (await forRow(row)?.refusal?.(ctx, row, read)) ?? null,
        }
      : {}),
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
