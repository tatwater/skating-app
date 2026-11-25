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

import { type DormancyReason, isLeaving, requiresHikeInAssertion, standingOf } from '@skating/core';
import { ConvexError } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import {
  type AlertRetractionPrev,
  retractAlertImpl,
  setOfficialImpl,
  unretractAlertImpl,
  unretractRefusal,
} from '../accessAlerts';
import { relinkRefusalOf, setPutInAccessImpl } from '../accessPoints';
import type { ElevatedRole } from '../admin';
import { demoteImpl, type FeatureShape, shapeRefusal, updateShapeImpl } from '../bodyFeatures';
import { unmergeImpl } from '../hazards';
import { type PostedAccessTarget, setPostedAccessImpl } from '../postedAccess';
import { suppressImpl, unsuppressImpl } from '../recurrence';
import { setStandingImpl } from '../standing';
import { readChangeSet, unmergeBodyImpl, unmergeRefusalOf } from '../unmerge';
import { type MergeChangeSet, setIncludedByRequestImpl } from '../waterBodies';
import {
  type AuditContext,
  asContinuationOf,
  asUndoOf,
  auditContextOf,
  type ModerationAction,
  type ModerationTargetType,
  readSnapshot,
  writeAudit,
} from './audit';
import { hasCapability } from './auth';
import { goneBecause, reasonOfLane, reopenTask } from './corpusTasks';
import { flagSubject } from './flagSubject';
import {
  closeFlagsUnder,
  flagReopenRefusalOf,
  isOpenFlag,
  REOPEN_FACT_READS,
  reopenFactsOf,
  reopenFlagsClosedBy,
} from './inboxFlags';
import {
  flagSource,
  type InboxSource,
  inboxBatch,
  MAX_MEMBERS,
  owedRefreshes,
  pageIsFull,
  refreshCost,
  requestSource,
  syncInboxSource,
} from './inboxItems';
import { capabilitiesFor, capabilityRefusal, OWN_FILING_REFUSAL } from './inboxRules';
import { grantLedgerEditorImpl, revokeLedgerEditorImpl } from './ledgerEditors';
import { ownContentRefusal } from './ownContent';
import { ROW_MAX, type RowKind } from './readBudget';
import { assertMayDecide, closeRequestPage, closeRow } from './requestDecisions';
import { runUndo, undoRowOf } from './undo';
import { UNDO_POLICY, undoCapability } from './undoPolicy';
import { UNDO_CHECKED_ELSEWHERE } from './undoReads';
import {
  meta,
  PREDATES,
  type TargetUndo,
  type UndoCall,
  type UndoHandler,
  type UndoViewer,
} from './undoTypes';

// ── Roles ─────────────────────────────────────────────────────────────────────────────────────────

type Role = Doc<'profiles'>['role'];

/** Put a person's role back to `prior` through the verb that produces it (self-guard included). */
async function restoreRole(
  { ctx, actor, row, reason, writers }: UndoCall,
  prior: Role,
): Promise<void> {
  const userId = row.targetId as Id<'profiles'>;
  if (prior === 'member') {
    await writers.revokeRoleImpl(ctx, actor, { userId, reason });
  } else {
    await writers.grantRoleImpl(ctx, actor, { userId, role: prior as ElevatedRole, reason });
  }
}

const priorRoleOf = (row: Doc<'moderationActions'>): Role | undefined => meta(row).priorRole;

/** The role a role row moved the person to. */
const newRoleOf = (row: Doc<'moderationActions'>): Role =>
  row.action === 'revoke_role' ? 'member' : ((meta(row).role as Role | undefined) ?? 'member');

/**
 * grant_role / revoke_role → the role it replaced. A reason is asked when the role put back is lower
 * than the one it replaces — a demotion — and not for a promotion back (D226; the founder, 2026-11-14).
 */
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
  undoTakesAway: (row) => {
    const prior = priorRoleOf(row);
    return (
      prior !== undefined && UNDO_POLICY[row.action].takesAway({ from: newRoleOf(row), to: prior })
    );
  },
  personWrite: (row) => ({ kind: 'role', role: priorRoleOf(row) ?? 'member' }),
  run: (call) => restoreRole(call, priorRoleOf(call.row) as Role),
};

// ── Ledger editing (D227): grant ↔ revoke ────────────────────────────────────────────────────────

/**
 * grant_ledger_editor → taken again. Through the revoke's own helper, so the last-editor rule holds:
 * the seeded first editor's grant can't be undone while they are the only one.
 */
const undoLedgerGrant: UndoHandler = {
  undoTakesAway: () => UNDO_POLICY.revoke_ledger_editor.takesAway(),
  personWrite: () => ({ kind: 'ledgerRevoke' }),
  run: async ({ ctx, actor, row, reason }) => {
    await revokeLedgerEditorImpl(ctx, actor, { userId: row.targetId as Id<'profiles'>, reason });
  },
};

/** revoke_ledger_editor → given back, unless it went with a demotion (undo that instead). */
const undoLedgerRevoke: UndoHandler = {
  blocked: (row) =>
    meta(row).cause === 'role_change'
      ? 'This went with a role change. Undoing that does not give it back; a holder gives it again.'
      : null,
  undoTakesAway: () => UNDO_POLICY.grant_ledger_editor.takesAway(),
  personWrite: () => ({ kind: 'ledgerGrant' }),
  run: async ({ ctx, actor, row, reason }) => {
    await grantLedgerEditorImpl(ctx, actor, { userId: row.targetId as Id<'profiles'>, reason });
  },
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
  run: async ({ ctx, actor, row, reason }) => {
    await setOfficialImpl(ctx, actor, {
      accessAlertId: row.targetId as Id<'accessAlerts'>,
      official: false,
      reason,
    });
    // A pin made from the Inbox dismissed the alert's flags with it: they reopen with the release.
    await reopenFlagsClosedBy(ctx, actor, row._id, reason, { withUndoOf: true });
  },
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
    // An unpin made from the Inbox closed the alert's flags with it: they reopen with the pin.
    await reopenFlagsClosedBy(ctx, actor, row._id, reason, { withUndoOf: true });
  },
};

// ── Access alerts: a moderator's retraction ↔ its unretraction (B01-5) ─────────────────────────────

/** Why a retraction recorded on an alert its author already retracted has no undo of its own. */
export const RETRACTION_IS_A_VERDICT =
  'Its author had already retracted this alert; this retraction is a verdict on the record. Overturn it there instead.';

const retractionPrevOf = (row: Doc<'moderationActions'>): AlertRetractionPrev | undefined =>
  meta(row).prev;

/**
 * retract_access_alert → the alert back to the status, expiry and pin its retraction recorded as
 * `prev`. A retraction recorded on an alert its author had already retracted moved nothing — it is a
 * verdict, reversed by an overturn. Rows from before `prev` was recorded can't say what to put back.
 * The alert as it stands is read for the offer and the write alike (`unretractRefusal`).
 */
const undoRetraction: UndoHandler = {
  blocked: (row) => {
    if (meta(row).onAuthorWithdrawn === true) return RETRACTION_IS_A_VERDICT;
    return retractionPrevOf(row) === undefined ? PREDATES : null;
  },
  undoTakesAway: () => UNDO_POLICY.unretract_access_alert.takesAway(),
  refusalCost: () => ({ bytes: ROW_MAX.accessAlert, reads: 1 }),
  refusal: async (ctx, row, read) => {
    const id = ctx.db.normalizeId('accessAlerts', row.targetId);
    const alert = id ? await read.row('accessAlert', id) : null;
    return unretractRefusal(alert, row, retractionPrevOf(row) as AlertRetractionPrev, Date.now());
  },
  run: async ({ ctx, actor, row, reason }) => {
    await unretractAlertImpl(ctx, actor, {
      accessAlertId: row.targetId as Id<'accessAlerts'>,
      retractedBy: row.actorId,
      prev: retractionPrevOf(row) as AlertRetractionPrev,
      reason,
    });
    // A retraction made from the Inbox closed the alert's flags with it: they reopen with the alert.
    await reopenFlagsClosedBy(ctx, actor, row._id, reason, { withUndoOf: true });
  },
};

/** unretract_access_alert → retracted again, through the moderator's retraction (its `prev` anew). */
const undoUnretraction: UndoHandler = {
  undoTakesAway: () => UNDO_POLICY.retract_access_alert.takesAway(),
  run: async ({ ctx, actor, row, reason }) => {
    await retractAlertImpl(ctx, actor, {
      accessAlertId: row.targetId as Id<'accessAlerts'>,
      reason,
    });
  },
};

// ── Who may undo a decision on what a person filed (D289, D269) ───────────────────────────────────

/**
 * A point read the refusal side charges to its reservation — as the row it is (a member is a 1 KiB
 * row, not an 8 KiB "small" one) — and the write side reads plainly.
 */
type SmallRead = <D>(read: () => Promise<D[]>, kind?: RowKind) => Promise<D[]>;
const plainRead: SmallRead = (read) => read();
const chargedRead =
  (read: Parameters<NonNullable<UndoHandler['refusal']>>[2]): SmallRead =>
  (r, kind = 'small') =>
    read.take(kind, 1, r);

/**
 * Whether a member the decision `actionId` closed was filed by `viewerId` — a sibling's, in any item
 * (D289, PR #170): the decision's undo reopens every one of them, and an undo is a decision too. One
 * point read on the stored fact (`by_closed_filer`), whatever the group's size — not the decision's
 * members read whole to look for theirs.
 */
async function filedAmongClosedBy(
  ctx: QueryCtx,
  actionId: Id<'moderationActions'>,
  viewerId: Id<'profiles'>,
  take: SmallRead,
): Promise<boolean> {
  const [mine] = await take(
    () =>
      ctx.db
        .query('inboxItemMembers')
        .withIndex('by_closed_filer', (q) =>
          q.eq('closedByActionId', actionId).eq('filedByUserId', viewerId),
        )
        .take(1),
    'inboxMember',
  );
  return mine !== undefined;
}

/** What {@link filedAmongClosedBy} reads: one member row. */
const CLOSED_BY_CHECK_COST = { bytes: ROW_MAX.inboxMember, reads: 1, docs: 1 };

/** The reads {@link decisionActorRefusal} makes: the member, its item, the filer probe. */
const ACTOR_CHECK_COST = {
  bytes: 2 * ROW_MAX.inboxMember + ROW_MAX.small,
  reads: 3,
  docs: 3,
};

/**
 * The items a flag reopen's check reads the own-filing answer of: a flag decision closes one item's
 * flags, and they reopen into it or a newer open item on the same key — two at most, held to four.
 */
const REOPEN_ITEMS = 4;

/** A reopen whose flags have since spread past {@link REOPEN_ITEMS} items: not checked here. */
export const UNDO_SPREAD_TOO_WIDE =
  'These flags have moved into more items than this can check here; decide them in the Inbox.';

/** One reopened source's stored facts: its member (open, by whom), charged as the row it is. */
const MEMBER_FACT_COST = { bytes: ROW_MAX.inboxMember, reads: 1, docs: 1 };

/** A source's member, read on the stored fact. */
const memberOfSource = async (ctx: QueryCtx, source: InboxSource, take: SmallRead) =>
  (
    await take(
      () =>
        ctx.db
          .query('inboxItemMembers')
          .withIndex('by_source', (q) =>
            q.eq('sourceTable', source.table).eq('sourceId', source.id),
          )
          .take(1),
      'inboxMember',
    )
  )[0] ?? null;

/**
 * **Whether `viewer` may undo a decision on `source`** — the forward rule's own answer, so History
 * never offers what the write refuses (D217): no staffer decides an item one of whose members they
 * filed (D289; any member, a sibling's included), nor a flag about them or their content (D269). A
 * source with no item (before the backfill, or a script's ask) is held by its own filer, if a person.
 */
async function decisionActorRefusal(
  ctx: QueryCtx,
  viewer: UndoViewer,
  source: InboxSource,
  fallback: { filer?: Id<'profiles'>; subject?: Id<'profiles'> },
  take: SmallRead,
  /** The source's member, when the caller has read it already. */
  known?: Doc<'inboxItemMembers'> | null,
): Promise<string | null> {
  const member = known !== undefined ? known : await memberOfSource(ctx, source, take);
  const [item] = member
    ? await take(async () => {
        const got = await ctx.db.get(member.itemId);
        return got ? [got] : [];
      })
    : [];
  if (!item) {
    if (fallback.filer !== undefined && fallback.filer === viewer._id) return OWN_FILING_REFUSAL;
    return ownContentRefusal(viewer, fallback.subject);
  }
  const [filed] = await take(
    () =>
      ctx.db
        .query('inboxItemMembers')
        .withIndex('by_item_filer', (q) => q.eq('itemId', item._id).eq('filedByUserId', viewer._id))
        .take(1),
    'inboxMember',
  );
  if (filed) return OWN_FILING_REFUSAL;
  return item.kind === 'flag' || item.kind === 'access'
    ? ownContentRefusal(viewer, item.subjectUserId)
    : null;
}

/** The person a flag is filed by (a person's flag only) and is about, for the no-item fallback. */
const flagPeople = (flag: Doc<'contentFlags'> | null) => ({
  ...(flag?.origin === 'user' ? { filer: flag.flaggerId } : {}),
  ...(flag ? { subject: flagSubject(flag) ?? undefined } : {}),
});

// ── Flag decisions ↔ reopened (B01-5) ─────────────────────────────────────────────────────────────

/** Why a row that closed with another decision has no undo of its own. */
export const UNDO_WITH_ITS_DECISION = 'This closed with another decision; undo that one.';

/**
 * resolve_flag / dismiss_flag → reopened (`reopen_flag`): every flag this decision's row closed — a
 * dismissal's whole item, or the one flag `resolveFlag` decided — back to open, the erasure hold and
 * today's disposition count put back, the item reopened. A flag's row written for another decision (a
 * takedown's, an alert verdict's, a dismissal's later flags) undoes with that one. Refused, as the
 * write is, when a newer flag supersedes it or an open flag of its reason is on the target now.
 */
const undoFlagDecision: UndoHandler = {
  blocked: (row) => (meta(row).withActionId !== undefined ? UNDO_WITH_ITS_DECISION : null),
  undoTakesAway: () => UNDO_POLICY.reopen_flag.takesAway(),
  // The flag, and the reopen rule's exact facts about its target — at most `REOPEN_FACT_READS` one-row
  // reads (PR #170: never the target's newest flags, which can leave out the deciding row).
  refusalCost: () => ({
    bytes: (1 + REOPEN_FACT_READS) * ROW_MAX.contentFlag + ACTOR_CHECK_COST.bytes,
    reads: 1 + REOPEN_FACT_READS + ACTOR_CHECK_COST.reads,
    docs: 1 + REOPEN_FACT_READS + ACTOR_CHECK_COST.docs,
  }),
  refusal: async (ctx, row, read, viewer) => {
    const id = ctx.db.normalizeId('contentFlags', row.targetId);
    const flag = id ? await read.row('contentFlag', id) : null;
    const facts = flag
      ? await reopenFactsOf(ctx, flag, (r) => read.take('contentFlag', 1, r))
      : null;
    return (
      flagReopenRefusalOf(flag, facts) ??
      (id
        ? await decisionActorRefusal(
            ctx,
            viewer,
            flagSource(id),
            flagPeople(flag),
            chargedRead(read),
          )
        : null)
    );
  },
  run: async ({ ctx, actor, row, reason }) => {
    const alsoFlagId = ctx.db.normalizeId('contentFlags', row.targetId) ?? undefined;
    if (alsoFlagId) {
      const own = await decisionActorRefusal(
        ctx,
        actor,
        flagSource(alsoFlagId),
        flagPeople(await ctx.db.get(alsoFlagId)),
        plainRead,
      );
      if (own !== null) throw new ConvexError(own);
    }
    await reopenFlagsClosedBy(ctx, actor, row._id, reason, alsoFlagId ? { alsoFlagId } : {});
  },
};

/**
 * reopen_flag → decided again as the reopened decision had it: every flag the reopen reopened (the
 * lead row lists them, `reopened`) closed again in one act with its prior resolution, under one fresh
 * decision whose first row stamps their Inbox members. The other flags' rows undo with the lead's.
 * Refused once any of them has been decided again, and to a filer or a subject (D289, D269).
 */
/** The flags a reopen reopened: the lead row lists them; a row from before the list names its own. */
const reopenedFlagsOf = (row: Doc<'moderationActions'>): Id<'contentFlags'>[] =>
  (meta(row).reopened as Id<'contentFlags'>[] | undefined) ?? [row.targetId as Id<'contentFlags'>];

/** A reopened flag decided since: the undo of the reopen has nothing to close it from. */
export const FLAG_DECIDED_SINCE = 'A flag has been decided since, so this can’t be put back.';

/**
 * Why closing `flag` again (one of a reopen's) is refused to `viewer`, or `null` — one rule for the
 * offer and the write: it must still be open, and the viewer mustn't decide its item (any member
 * they filed, D289; a flag about them, D269), as the forward dismissal and the reopen's own undo ask.
 */
async function recloseRefusal(
  ctx: QueryCtx,
  viewer: UndoViewer,
  id: Id<'contentFlags'>,
  flag: Doc<'contentFlags'> | null,
  take: SmallRead,
): Promise<string | null> {
  if (!flag || !isOpenFlag(flag)) return FLAG_DECIDED_SINCE;
  return decisionActorRefusal(ctx, viewer, flagSource(id), flagPeople(flag), take);
}

/**
 * Whether a flag a `reopen_flag` row names is still closed by the decision that row undid — a later
 * page of the reopen hasn't reached it (and, once the reopen is undone, never will).
 */
const stillHeldBy = (
  member: Doc<'inboxItemMembers'> | null,
  row: Doc<'moderationActions'>,
): boolean =>
  member?.status === 'closed' &&
  member.closedByActionId !== undefined &&
  member.closedByActionId === (meta(row).reopens as Id<'moderationActions'> | undefined);

const undoFlagReopen: UndoHandler = {
  blocked: (row) => {
    // A flag reopened beside the lead, or by a takedown's (an alert verdict's, a restore's, a ruling's)
    // undo, goes back with that.
    if (meta(row).withActionId !== undefined) return UNDO_WITH_ITS_DECISION;
    return meta(row).prev?.status === undefined ? PREDATES : null;
  },
  undoTakesAway: (row) => UNDO_POLICY.reopen_flag.takesAway(meta(row).prev.status),
  // On the stored facts, each flag's member (PR #170): open while its flag is (the writer's
  // invariant), and by whom — a 1 KiB row a flag, not the flag read whole — and each item's own-filing
  // answer read once. A reopen of any size the wave supports fits the request's budget.
  refusalCost: (_scope, row) => {
    const n = reopenedFlagsOf(row).length;
    const items = Math.min(n, REOPEN_ITEMS);
    return {
      bytes: n * MEMBER_FACT_COST.bytes + items * ACTOR_CHECK_COST.bytes,
      reads: n * MEMBER_FACT_COST.reads + items * ACTOR_CHECK_COST.reads,
      docs: n * MEMBER_FACT_COST.docs + items * ACTOR_CHECK_COST.docs,
    };
  },
  refusal: async (ctx, row, read, viewer) => {
    const take = chargedRead(read);
    const byItem = new Map<string, string | null>();
    for (const id of reopenedFlagsOf(row)) {
      const member = await memberOfSource(ctx, flagSource(id), take);
      // A flag the reopen's later pages haven't reached yet is still held by the decision it undid:
      // undoing a reopen mid-way closes what reopened and stops the rest (PR #170).
      if (stillHeldBy(member, row)) continue;
      // Every reopened flag was filed by its reopen; an open member is an open flag.
      if (member?.status !== 'open') return FLAG_DECIDED_SINCE;
      let why = byItem.get(member.itemId);
      if (why === undefined) {
        if (byItem.size >= REOPEN_ITEMS) return UNDO_SPREAD_TOO_WIDE;
        why = await decisionActorRefusal(ctx, viewer, flagSource(id), {}, take, member);
        byItem.set(member.itemId, why);
      }
      if (why !== null) return why;
    }
    return null;
  },
  run: async ({ ctx, actor, row, reason }) => {
    const flags: Doc<'contentFlags'>[] = [];
    for (const id of reopenedFlagsOf(row)) {
      if (stillHeldBy(await memberOfSource(ctx, flagSource(id), plainRead), row)) continue;
      const flag = await ctx.db.get(id);
      const why = await recloseRefusal(ctx, actor, id, flag, plainRead);
      if (why !== null) throw new ConvexError(why);
      flags.push(flag as Doc<'contentFlags'>);
    }
    const resolution = meta(row).prev.status as 'actioned' | 'dismissed';
    await closeFlagsUnder(ctx, actor, flags, {
      resolution,
      decision: resolution,
      reason,
      defaulted: false,
      now: Date.now(),
    });
  },
};

// ── Request decisions ↔ reopened (B01-5) ──────────────────────────────────────────────────────────

/** The request kinds whose approval acts on a body (the rest — bays, landmarks — act in the editor). */
const BODY_ACTS: ReadonlySet<string> = new Set([
  'activate',
  'restore',
  'contest_access',
  'takedown',
  'admit',
]);

/** The approval's body-side row, as the primary's row recorded it: `null` — the act wrote none. */
const bodySideOf = (row: Doc<'moderationActions'>): Id<'moderationActions'> | null | undefined => {
  const m = meta(row);
  if ('bodySide' in m) return m.bodySide ?? null;
  return m.bodyActionId;
};

/**
 * Whether the request still stands as this decision left it: decided the same way at the same
 * instant (the row's own `createdAt` is the decision's `now`).
 */
export function requestDecisionRefusal(
  request: Doc<'waterBodyRequests'> | null,
  row: Doc<'moderationActions'>,
): string | null {
  if (!request) return 'The request no longer exists.';
  const status = row.action === 'approve_request' ? 'approved' : 'declined';
  if (request.status !== status || request.decidedAt !== row.createdAt) {
    return 'The request has changed since this decision, so it can’t be reopened.';
  }
  return null;
}

/**
 * An admission's body-side row (`set_included_by_request`, naming the request) is blocked by its own
 * handler — reopening the request is its undo — so the request's undo runs it here, with the engine's
 * own checks kept equal (not undone already, not overtaken by a later row on the body, the undoer
 * holding its capability and not on their way out), tagged as that row's undo: the body's flag put
 * back to the `prev` the admission recorded, and its standing with it — a twin shelved again for the
 * reason it was shelved, new water back to what the corpus doesn't keep (`not_in_campaign`).
 */
async function undoAdmission(call: UndoCall, bodyRow: Doc<'moderationActions'>): Promise<void> {
  const { ctx, actor, reason } = call;
  if (await undoRowOf(ctx, bodyRow)) throw new ConvexError('That action has already been undone');
  const newest = await ctx.db
    .query('moderationActions')
    .withIndex('by_target', (q) =>
      q.eq('targetType', bodyRow.targetType).eq('targetId', bodyRow.targetId),
    )
    .order('desc')
    .first();
  if (newest && newest._id !== bodyRow._id) {
    throw new ConvexError('Something changed this since; open its history to see what');
  }
  const capability = undoCapability(UNDO_POLICY.set_included_by_request, 'waterbody');
  if (!hasCapability(actor, capability)) {
    throw new ConvexError('Undoing this takes a role you do not hold.');
  }
  if (isLeaving(actor)) {
    throw new ConvexError('Your account is being deleted, so you can no longer undo.');
  }
  const waterBodyId = bodyRow.targetId as Id<'waterBodies'>;
  const prev = meta(bodyRow).prev as
    | { includedByRequest: boolean; dormant?: Doc<'waterBodies'>['dormant'] }
    | undefined;
  await asUndoOf(ctx, bodyRow._id, async () => {
    const body = await ctx.db.get(waterBodyId);
    if (!body) throw new ConvexError('Water body not found');
    await setIncludedByRequestImpl(ctx, actor._id, {
      body,
      included: prev?.includedByRequest === true,
      reason,
    });
    const dormancy: { reason: DormancyReason; note?: string } | undefined =
      prev === undefined ? { reason: 'not_in_campaign' } : prev.dormant;
    const now = await ctx.db.get(waterBodyId);
    if (dormancy && now && standingOf(now).standing === 'active') {
      await setStandingImpl(ctx, actor, {
        waterBodyId,
        standing: 'dormant',
        dormancyReason: dormancy.reason,
        ...(dormancy.note !== undefined ? { note: dormancy.note } : {}),
        reason,
      });
    }
  });
}

/** What a viewer without the body-side undo's capability is told — the engine's own words. */
const BODY_SIDE_ROLE = 'Undoing this takes a role you do not hold.';

/**
 * Whether `viewer` holds what the approval's body-side undo needs — the engine asks it when the
 * request's undo runs that undo (a restore's or a takedown's needs `body.remove`, as the act did; an
 * admission's, `body.standing`), so the offer asks it too.
 */
async function bodySideCapabilityRefusal(
  row: Doc<'moderationActions'>,
  viewer: UndoViewer,
  read: Parameters<NonNullable<UndoHandler['refusal']>>[2],
): Promise<string | null> {
  const bodyActionId = bodySideOf(row);
  if (!bodyActionId) return null;
  const bodyRow = await read.row('moderationAction', bodyActionId);
  if (!bodyRow) return null;
  const capability = undoCapability(UNDO_POLICY[bodyRow.action], bodyRow.targetType);
  return hasCapability(viewer, capability) ? null : BODY_SIDE_ROLE;
}

/**
 * Un-deciding a decline is the decision's own lever (B01-5c, ruled): an admin decides a restore or a
 * takedown ask both ways, so reopening one's decline asks `body.remove`, by the Inbox's rule
 * (`capabilitiesFor`); a decline of any other kind, `inbox.request` as before. An approval's undo is
 * held by its body-side act's own capability (`bodySideCapabilityRefusal`). Asked in `refusal`, which
 * the engine reads for the offer and again before every run (`runUndo`, the write's audience).
 */
function declineLeverRefusal(
  row: Doc<'moderationActions'>,
  request: Pick<Doc<'waterBodyRequests'>, 'kind'> | null,
  viewer: UndoViewer,
): string | null {
  if (row.action !== 'decline_request' || !request) return null;
  for (const cap of capabilitiesFor('decline', { requestKind: request.kind })) {
    const refused = capabilityRefusal(viewer, cap);
    if (refused !== null) return refused;
  }
  return null;
}

/**
 * approve_request / decline_request → reopened (`reopen_request`): an approval's body-side act undone
 * first — through the engine, with its capability and its "still current" (a restore or takedown
 * approval's undo needs `body.remove`, as the act did), or through {@link undoAdmission} — then the
 * request and every sibling its decision closed (their Inbox members, stamped with this row) back to
 * open, the item reopened. A sibling's own row undoes with the primary's. Refused when the request
 * has changed since, when the body-side row was overtaken (History's sentence), and to the staffer
 * who filed the ask (D289; a script's ask is exempt).
 */
const undoRequestDecision: UndoHandler = {
  blocked: (row) => {
    if (meta(row).withRequestId !== undefined) {
      return 'This closed with another request’s decision; undo that one.';
    }
    if (
      row.action === 'approve_request' &&
      BODY_ACTS.has(meta(row).kind) &&
      bodySideOf(row) === undefined
    ) {
      return PREDATES;
    }
    return null;
  },
  // Undoing an approval that acted on a body puts the body back as it was — dormant, removed, ruled
  // closed, shelved — which takes something away; a takedown's undo restores, a decline's reopens.
  undoTakesAway: (row) =>
    row.action === 'approve_request' && bodySideOf(row) != null && meta(row).kind !== 'takedown',
  refusalCost: () => ({
    bytes:
      ROW_MAX.waterBodyRequest +
      ROW_MAX.moderationAction +
      ACTOR_CHECK_COST.bytes +
      CLOSED_BY_CHECK_COST.bytes,
    reads: 2 + ACTOR_CHECK_COST.reads + CLOSED_BY_CHECK_COST.reads,
    docs: 2 + ACTOR_CHECK_COST.docs + CLOSED_BY_CHECK_COST.docs,
  }),
  refusal: async (ctx, row, read, viewer) => {
    const id = ctx.db.normalizeId('waterBodyRequests', row.targetId);
    const request = id ? await read.row('waterBodyRequest', id) : null;
    return (
      requestDecisionRefusal(request, row) ??
      declineLeverRefusal(row, request, viewer) ??
      (await bodySideCapabilityRefusal(row, viewer, read)) ??
      (id && request
        ? await decisionActorRefusal(
            ctx,
            viewer,
            requestSource(id),
            askPeople(request),
            chargedRead(read),
          )
        : null) ??
      ((await filedAmongClosedBy(ctx, row._id, viewer._id, chargedRead(read)))
        ? OWN_FILING_REFUSAL
        : null)
    );
  },
  run: async (call) => {
    const { ctx, actor, row, reason, writers } = call;
    const primaryId = row.targetId as Id<'waterBodyRequests'>;
    const primary = await ctx.db.get(primaryId);
    const why = requestDecisionRefusal(primary, row);
    if (why !== null || !primary) throw new ConvexError(why ?? 'The request no longer exists.');
    // Any member the viewer filed, a sibling's included — the forward rule's answer (D289).
    const own = await decisionActorRefusal(
      ctx,
      actor,
      requestSource(primaryId),
      askPeople(primary),
      plainRead,
    );
    if (own !== null) throw new ConvexError(own);
    if (await filedAmongClosedBy(ctx, row._id, actor._id, plainRead)) {
      throw new ConvexError(OWN_FILING_REFUSAL);
    }
    const bodyActionId = bodySideOf(row);
    if (bodyActionId) {
      const bodyRow = await ctx.db.get(bodyActionId);
      if (!bodyRow) throw new ConvexError('The change this approval made no longer exists.');
      if (bodyRow.action === 'set_included_by_request' && meta(bodyRow).requestId === primaryId) {
        await undoAdmission(call, bodyRow);
      } else {
        await runUndo(ctx, actor, bodyActionId, reason, writers);
      }
    }
    // The request and every sibling the decision closed (each stamped with this row), back to open:
    // all of them, the decision's cap (`REQUEST_SIBLINGS_MAX`) — never a window; past it, refused.
    const members = await ctx.db
      .query('inboxItemMembers')
      .withIndex('by_closed_by', (q) => q.eq('closedByActionId', row._id))
      .take(MAX_MEMBERS + 1);
    if (members.length > MAX_MEMBERS) throw new ConvexError(UNDO_GROUP_TOO_LARGE);
    const ids = new Set<Id<'waterBodyRequests'>>([primaryId]);
    for (const m of members) {
      const id =
        m.sourceTable === 'waterBodyRequests'
          ? ctx.db.normalizeId('waterBodyRequests', m.sourceId)
          : null;
      if (id) ids.add(id);
    }
    // Tagged as this row's undo by name: the body-side undo above ran as its own row's undo. It
    // names every ask the undo reopens — this page's and the pages after — so its own undo (closing
    // them again) reaches them all, closing only those still open.
    const order = [primaryId, ...[...ids].filter((id) => id !== primaryId)];
    const reopenRow = await writeAudit(ctx, {
      actorId: actor._id,
      action: 'reopen_request',
      targetType: 'waterBodyRequest',
      targetId: primaryId,
      reason,
      undoesActionId: row._id,
      metadata: {
        kind: primary.kind,
        reopened: order,
        prev: { status: primary.status, note: primary.decisionNote ?? null },
        ...(primary.waterBodyId ? { waterBodyId: primary.waterBodyId } : {}),
      },
    });
    await reopenRequestPage(ctx, row, reopenRow, order, actor._id);
  },
};

/**
 * What reopening one ask may cost a page, at its worst: read whole (an admit ask carries a catalog
 * polygon near the document limit), read again by its patch and by its reconcile, written back whole
 * by the patch, and its member and item touched.
 */
export const REOPEN_ASK_COST = {
  bytesRead: 3 * ROW_MAX.waterBodyRequest + 4 * ROW_MAX.small,
  bytesWritten: ROW_MAX.waterBodyRequest + 2 * ROW_MAX.small,
};

/**
 * **A decision's undo, one page of its asks** (PR #170): the asks the decision closed, reopened while
 * the transaction's live metrics still hold one more at its worst ({@link REOPEN_ASK_COST}) and every
 * item refresh the batch owes — always one at least, so the undo advances — each reconciled through
 * the one writer as one batch (only the asks this page reopened: `reopenItem` would read every member's
 * source); the rest follow in `inboxWrites.reopenRequestsRest`, which stops once this reopen is itself
 * undone. A group of any size the wave supports reopens, a page at a time, whatever its rows weigh.
 */
export async function reopenRequestPage(
  ctx: MutationCtx,
  decision: Doc<'moderationActions'>,
  reopenRow: Id<'moderationActions'>,
  ids: readonly Id<'waterBodyRequests'>[],
  actorId: Id<'profiles'>,
): Promise<void> {
  let done = 0;
  await inboxBatch(ctx, async () => {
    for (const id of ids) {
      if (done > 0 && pageIsFull(done)) break;
      if (done > 0) {
        const m = await ctx.meta.getTransactionMetrics();
        const refreshes = (owedRefreshes(ctx) + 1) * refreshCost().bytesRead;
        if (
          m.bytesRead.remaining < REOPEN_ASK_COST.bytesRead + refreshes + REOPEN_RESERVE ||
          m.bytesWritten.remaining < REOPEN_ASK_COST.bytesWritten + REOPEN_RESERVE
        ) {
          break;
        }
      }
      done++;
      const r = await ctx.db.get(id);
      if (!r || requestDecisionRefusal(r, decision) !== null) continue;
      await ctx.db.patch(id, {
        status: 'open',
        decidedAt: undefined,
        decidedByUserId: undefined,
        decisionNote: undefined,
        admittedWaterBodyId: undefined,
        landmarkId: undefined,
      });
      // Its member reopens in place (a decided item reopens with it), whatever stamp it carries.
      await syncInboxSource(ctx, requestSource(id));
    }
  });
  const rest = ids.slice(done);
  if (rest.length > 0) {
    await ctx.scheduler.runAfter(0, internal.inboxWrites.reopenRequestsRest, {
      ...(await auditContextOf(ctx)),
      decisionId: decision._id,
      reopenRowId: reopenRow,
      ids: [...rest],
      actorId,
    });
  }
}

/** Headroom a reopen page keeps past its asks: its audit row, the next page's schedule. */
export const REOPEN_RESERVE = 512 * 1024;

/**
 * A decision's undo, a later page: unless the reopen was itself undone since (its asks then closed
 * again), the rest reopened as the first page did.
 */
export async function reopenRequestsRestPage(
  ctx: MutationCtx,
  args: AuditContext & {
    decisionId: Id<'moderationActions'>;
    reopenRowId: Id<'moderationActions'>;
    ids: Id<'waterBodyRequests'>[];
    actorId: Id<'profiles'>;
  },
): Promise<void> {
  const undone = await ctx.db
    .query('moderationActions')
    .withIndex('by_undoes', (q) => q.eq('undoesActionId', args.reopenRowId))
    .first();
  if (undone !== null) return;
  const decision = await ctx.db.get(args.decisionId);
  if (!decision) return;
  // The same act, in another transaction: each ask re-checked as the first page checks it (still
  // closed by this decision, `requestDecisionRefusal`), written under the undo and `via` it had.
  await asContinuationOf(ctx, { undoOf: args.undoOf, via: args.via }, () =>
    reopenRequestPage(ctx, decision, args.reopenRowId, args.ids, args.actorId),
  );
}

/** A decision whose stamps pass its cap (no writer makes one): refused, never part-reopened. */
export const UNDO_GROUP_TOO_LARGE =
  'This decision closed more than an undo reopens at once; reopen the asks from the Inbox instead.';

/** An ask's filer, for the no-item fallback: a script's ask (`origin: 'seed'`) has none (D289). */
const askPeople = (r: Doc<'waterBodyRequests'>) =>
  r.origin === 'seed' ? {} : { filer: r.requesterId };

// ── Approaches and posted rules ───────────────────────────────────────────────────────────────────

interface ApproachPrev {
  parkingAreaId: Id<'parkingAreas'> | null;
  approachKindOverride: Doc<'putIns'>['approachKindOverride'] | null;
}

/** Whether an approach row also moved the put-in's lot (a link that asserted the kind with it). */
const movedTheLot = (row: Doc<'moderationActions'>): boolean => {
  const { prev, parkingAreaId } = meta(row) as { prev: ApproachPrev; parkingAreaId?: string };
  return (parkingAreaId ?? null) !== prev.parkingAreaId;
};

/**
 * set_approach_kind → the override it replaced (or none), through the same gate and recompute. A row
 * that also moved the put-in's lot — a link made with the hike-in asserted (B01-6b) — puts back the
 * lot it replaced too (or none), and the walk is routed again (D313). Refused where the write would
 * be: the put-in or the lot gone, or a walk past the D144 line left unasserted.
 */
const undoApproachKind: UndoHandler = {
  blocked: (row) => (meta(row).prev === undefined ? PREDATES : null),
  undoTakesAway: (row) =>
    UNDO_POLICY.set_approach_kind.takesAway((meta(row).prev as ApproachPrev).approachKindOverride),
  refusalCost: () => ({ bytes: ROW_MAX.launch + ROW_MAX.putIn, reads: 2 }),
  refusal: async (_ctx, row, read) => {
    const { prev } = meta(row) as { prev: ApproachPrev };
    const putIn = await read.row('launch', row.targetId as Id<'putIns'>);
    if (!movedTheLot(row)) {
      if (!putIn) return 'That put-in no longer exists.';
      return requiresHikeInAssertion(putIn.approachMeters) &&
        prev.approachKindOverride !== 'hike_in'
        ? 'The walk to that put-in is past the hike-in line now, so its approach can’t go back unasserted. Set it by hand.'
        : null;
    }
    // A lot's row weighs at most a document (an imported lot's name is uncapped).
    const lot = prev.parkingAreaId === null ? 'none' : await read.row('putIn', prev.parkingAreaId);
    return relinkRefusalOf(putIn, lot, prev.approachKindOverride);
  },
  run: ({ ctx, actor, row, reason }) => {
    const { approachKindOverride, parkingAreaId } = meta(row).prev as ApproachPrev;
    return setPutInAccessImpl(ctx, actor, {
      putInId: row.targetId as Id<'putIns'>,
      ...(approachKindOverride === null || approachKindOverride === undefined
        ? { clearApproachOverride: true }
        : { approachKindOverride }),
      ...(movedTheLot(row)
        ? parkingAreaId !== null
          ? { parkingAreaId }
          : { clearParking: true }
        : {}),
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

/** update_body_feature_shape → the shape it replaced (the row's snapshot), through the same write. */
const undoFeatureShape: UndoHandler = {
  blocked: (row) => (meta(row).prev?.snapshot === true ? null : PREDATES),
  undoTakesAway: () => UNDO_POLICY.update_body_feature_shape.takesAway(undefined),
  // A merge moves the feature to the survivor's box, and a redrawn or re-imported outline can leave
  // the shape it puts back off the lake — neither writes a row on the feature, so the shape is
  // checked against the rows as they stand, by the redraw's own rule.
  refusalCost: () => ({
    bytes: ROW_MAX.bodyFeature + ROW_MAX.waterBody + ROW_MAX.shapeSnapshot,
    reads: 3,
  }),
  refusal: async (ctx, row, read) => {
    const id = ctx.db.normalizeId('bodyFeatures', row.targetId);
    const feature = id ? await read.row('bodyFeature', id) : null;
    const body = feature ? await read.row('waterBody', feature.waterBodyId) : null;
    const unshaped = shapeRefusal(feature, body);
    if (unshaped !== null) return unshaped;
    const prev = await read.snapshot<FeatureShape>('shapeSnapshot', row._id);
    if (prev === null) return PREDATES;
    // A shape is always one stored document; one split in parts isn't this verb's to check here.
    if (prev === 'parts') return UNDO_CHECKED_ELSEWHERE;
    return shapeRefusal(feature, body, prev);
  },
  run: async ({ ctx, actor, row, reason }) => {
    const prev = await readSnapshot<FeatureShape>(ctx, row._id);
    if (prev === null) throw new ConvexError(PREDATES);
    await updateShapeImpl(ctx, actor, {
      bodyFeatureId: row.targetId as Id<'bodyFeatures'>,
      shape: prev,
      reason,
    });
  },
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

// ── Body merges (B01-5d, D291) ────────────────────────────────────────────────────────────────────

/**
 * merge_waterbody → unmerged (`unmerge.ts`), from the change set the merge recorded. The offer and the
 * run ask one refusal (`unmergeRefusalOf`) in one order, on the same facts: the change set, the loser,
 * the survivor and the body it was merged into since. The bodies are read first, through the page's
 * charged reader. The change set is read whole where one row is in view (`one`: the toast, the run) —
 * a snapshot read, which the reader leaves uncharged (`lib/undoReads`), bounded by
 * `CHANGE_SET_PARTS_MAX` parts; on a page (`list`) only a record stored as one row is read, charged,
 * and one split in parts says "check elsewhere", as a feature's split shape does.
 */
const undoBodyMerge: UndoHandler = {
  undoTakesAway: () => UNDO_POLICY.unmerge_waterbody.takesAway(),
  refusalCost: (scope) => ({
    bytes: 3 * ROW_MAX.waterBody + (scope === 'list' ? ROW_MAX.moderationAction : 0),
    reads: scope === 'list' ? 4 : 3,
  }),
  refusal: async (ctx, row, read, viewer) => {
    const loserId = ctx.db.normalizeId('waterBodies', row.targetId);
    const loser = loserId ? await read.row('waterBody', loserId) : null;
    let changeSet: MergeChangeSet | null | 'missing';
    if (read.scope === 'one') {
      changeSet = await readChangeSet(ctx, row._id);
    } else {
      const first = await read.snapshot<MergeChangeSet>('moderationAction', row._id);
      if (first === 'parts') return UNDO_CHECKED_ELSEWHERE;
      changeSet = first;
    }
    const survivorId =
      changeSet !== null && changeSet !== 'missing' ? changeSet.survivorId : undefined;
    const survivor = survivorId ? await read.row('waterBody', survivorId) : null;
    const survivorInto = survivor?.mergedIntoId
      ? await read.row('waterBody', survivor.mergedIntoId)
      : null;
    return unmergeRefusalOf({ changeSet, loser, survivor, survivorInto }, viewer._id);
  },
  run: async ({ ctx, actor, row, reason }) => {
    await unmergeBodyImpl(ctx, actor, { mergeRow: row, reason });
  },
};

/**
 * reopen_request → declined again, exactly the asks it reopened, with the note the asker read. An
 * approval reopened isn't re-run by an undo — it acts on the body, through the approval's own checks
 * — so it is approved again from the Inbox.
 */
/** A reopened ask decided again since: its reopen's undo has nothing to decline. */
export const REQUEST_DECIDED_SINCE =
  'The request has been decided since, so this can’t be put back.';

/** The asks a `reopen_request` row reopened (its primary among them). */
const reopenedAsksOf = (row: Doc<'moderationActions'>): Id<'waterBodyRequests'>[] =>
  (meta(row).reopened ?? []) as Id<'waterBodyRequests'>[];

/**
 * Whether a sibling a `reopen_request` reopened is open now and the viewer's own — on its member, the
 * stored fact (open while its ask is; `filedByUserId` the person who asked; a script's ask has no
 * member): one 1 KiB row a sibling.
 */
async function ownReopenedSibling(
  ctx: QueryCtx,
  row: Doc<'moderationActions'>,
  primaryId: Id<'waterBodyRequests'>,
  viewerId: Id<'profiles'>,
  take: SmallRead,
): Promise<boolean> {
  for (const sid of reopenedAsksOf(row)) {
    if (sid === primaryId) continue;
    const member = await memberOfSource(ctx, requestSource(sid), take);
    if (member?.status === 'open' && member.filedByUserId === viewerId) return true;
  }
  return false;
}

const undoRequestReopen: UndoHandler = {
  blocked: (row) => {
    const prev = meta(row).prev as { status?: string } | undefined;
    if (prev?.status === undefined) return PREDATES;
    return prev.status === 'approved'
      ? 'An approval acts on the body; approve it again from the Inbox.'
      : null;
  },
  undoTakesAway: () => UNDO_POLICY.decline_request.takesAway(),
  // The decision's own rule, as its write asks it (`assertMayDecide`): the ask still open, and the
  // viewer not the filer of any member of its item — the primary's or a sibling's (D289).
  // The primary read whole (one row); each reopened sibling on its stored facts — its member, open
  // and by whom — not its row read whole (PR #170: a 1 MiB reservation a sibling made eleven asks
  // more than the request's budget, for asks of any real size).
  refusalCost: (_scope, row) => {
    const n = reopenedAsksOf(row).length;
    return {
      bytes: ROW_MAX.waterBodyRequest + ACTOR_CHECK_COST.bytes + n * MEMBER_FACT_COST.bytes,
      reads: 1 + ACTOR_CHECK_COST.reads + n * MEMBER_FACT_COST.reads,
      docs: 1 + ACTOR_CHECK_COST.docs + n * MEMBER_FACT_COST.docs,
    };
  },
  refusal: async (ctx, row, read, viewer) => {
    const id = row.targetId as Id<'waterBodyRequests'>;
    const primary = await read.row('waterBodyRequest', id);
    if (primary?.status !== 'open') return REQUEST_DECIDED_SINCE;
    // Declining again is the decision's lever, by the Inbox's rule (`capabilitiesFor`): a restore or a
    // takedown is an admin's (`body.remove`), as its run's `assertMayDecide` asks (B01-5c).
    for (const cap of capabilitiesFor('decline', { requestKind: primary.kind })) {
      const refused = capabilityRefusal(viewer, cap);
      if (refused !== null) return refused;
    }
    const own = await decisionActorRefusal(
      ctx,
      viewer,
      requestSource(id),
      askPeople(primary),
      chargedRead(read),
    );
    if (own !== null) return own;
    // Closing them again decides every reopened sibling: one of the viewer's own refuses it (D289).
    return (await ownReopenedSibling(ctx, row, id, viewer._id, chargedRead(read)))
      ? OWN_FILING_REFUSAL
      : null;
  },
  run: async ({ ctx, actor, row }) => {
    const primaryId = row.targetId as Id<'waterBodyRequests'>;
    const primary = await ctx.db.get(primaryId);
    if (primary?.status !== 'open') throw new ConvexError(REQUEST_DECIDED_SINCE);
    const note = (meta(row).prev.note as string | null) ?? undefined;
    const now = Date.now();
    await assertMayDecide(ctx, primary, actor._id, 'declined');
    if (await ownReopenedSibling(ctx, row, primaryId, actor._id, plainRead)) {
      throw new ConvexError(OWN_FILING_REFUSAL);
    }
    const decision = {
      requestId: primaryId,
      status: 'declined' as const,
      actorId: actor._id,
      now,
      ...(note !== undefined ? { note } : {}),
    };
    // The primary, then its reopened siblings a page at a time (each read whole and written back:
    // an ask can weigh near the document limit), one batch a page — the rest in later pages.
    let actionId: Id<'moderationActions'> | undefined;
    await inboxBatch(ctx, async () => {
      actionId = await closeRow(ctx, primary, decision);
    });
    await closeRequestPage(
      ctx,
      reopenedAsksOf(row).filter((id) => id !== primaryId),
      { ...decision, actionId },
    );
  },
};

// ── The Corpus tasks: a settled intake question (B01-7a) ───────────────────────────────────────────────────

/** A settle whose task no row records (none was filed, or it was written by hand). */
export const SETTLE_NOT_FOUND = 'Nothing records the question this settled.';
/** The question the settle answered has since been asked again — a campaign's new evidence (D306). */
export const SETTLE_ASKED_AGAIN = 'This question was asked again since; decide it from its lane.';
/** The task the settle decided is no longer decided by it (it left with its body, or was reopened). */
export const SETTLE_CLOSED = 'This question has closed since, so there is nothing to reopen.';

/**
 * Whether a settle still stands: its task decided by it, its body still in the corpus and still
 * recording this decision as the reason's settle, and no open task asking the same question again.
 * The offer's check (History, the toast), case for case where the reopen itself (`reopenTask`, the
 * writer's) answers `'none'` or `'overtaken'` — so History never offers an undo the run refuses.
 */
export function settleStandsRefusal(
  row: Doc<'moderationActions'>,
  task: Doc<'corpusTasks'> | null,
  body: Doc<'waterBodies'> | null,
  askedAgain: boolean,
): string | null {
  if (task === null) return SETTLE_NOT_FOUND;
  if (task.status !== 'decided' || body === null || goneBecause(body) !== null) {
    return SETTLE_CLOSED;
  }
  const reason = reasonOfLane(task.lane);
  const entry = (body.reviewSettled ?? []).find((s) => s.reason === reason);
  return entry?.actionId !== row._id || askedAgain ? SETTLE_ASKED_AGAIN : null;
}

/**
 * settle_review_reason → the question asked again: the task reopens, its reason back on the body and
 * its settled entry gone (`reopenTask`, the writer's), recorded as `unsettle_review_reason`. A *Keep*
 * changed nothing else, so the reopen is the whole undo. Refused once the question moved on without
 * it — a later campaign asked it again on new evidence (D306), or the body left with its task; a
 * later write on the body overtakes it as any row is overtaken.
 */
const undoSettle: UndoHandler = {
  undoTakesAway: () => UNDO_POLICY.unsettle_review_reason.takesAway(),
  // The task (a few ids and literals), the body, and one probe for an open task on the same key.
  refusalCost: () => ({ bytes: ROW_MAX.waterBody + 2 * ROW_MAX.small, reads: 3 }),
  refusal: async (ctx, row, read) => {
    const [task] = await read.take('small', 1, () =>
      ctx.db
        .query('corpusTasks')
        .withIndex('by_decision_action', (q) => q.eq('decisionActionId', row._id))
        .take(1),
    );
    if (task === undefined || task.status !== 'decided') {
      return settleStandsRefusal(row, task ?? null, null, false);
    }
    const [again] = await read.take('small', 1, () =>
      ctx.db
        .query('corpusTasks')
        .withIndex('by_key', (q) => q.eq('key', task.key).eq('status', 'open'))
        .take(1),
    );
    const body = await read.row('waterBody', task.waterBodyId);
    return settleStandsRefusal(row, task, body, again !== undefined);
  },
  run: async ({ ctx, actor, row, reason }) => {
    const outcome = await reopenTask(ctx, row._id);
    if (outcome === 'overtaken') throw new ConvexError(SETTLE_ASKED_AGAIN);
    if (outcome === 'none') throw new ConvexError(SETTLE_NOT_FOUND);
    await writeAudit(ctx, {
      actorId: actor._id,
      action: 'unsettle_review_reason',
      targetType: row.targetType,
      targetId: row.targetId,
      reason,
      metadata: { taskId: meta(row).taskId, reviewReason: meta(row).reviewReason },
    });
  },
};

/** Verb-level handlers (verbs only this area writes). */
export const CORPUS_UNDO_HANDLERS: Partial<Record<ModerationAction, UndoHandler>> = {
  grant_role: undoRoleChange,
  revoke_role: undoRoleChange,
  grant_ledger_editor: undoLedgerGrant,
  revoke_ledger_editor: undoLedgerRevoke,
  resolve_flag: undoFlagDecision,
  dismiss_flag: undoFlagDecision,
  approve_request: undoRequestDecision,
  decline_request: undoRequestDecision,
  reopen_flag: undoFlagReopen,
  reopen_request: undoRequestReopen,
  pin_access_alert: undoPin,
  unpin_access_alert: undoUnpin,
  retract_access_alert: undoRetraction,
  unretract_access_alert: undoUnretraction,
  set_approach_kind: undoApproachKind,
  set_posted_access: undoPostedAccess,
  promote_body_feature: undoPromotion,
  update_body_feature_shape: undoFeatureShape,
  promote_recurrence: undoPromotion,
  suppress_recurrence: undoSuppress,
  unsuppress_recurrence: undoUnsuppress,
  merge_hazards: undoMerge,
  merge_waterbody: undoBodyMerge,
  settle_review_reason: undoSettle,
};

/** `hide` / `remove` / `restore` for the target kinds this area owns. */
export const CORPUS_TARGET_UNDO: Partial<Record<ModerationTargetType, TargetUndo>> = {};
