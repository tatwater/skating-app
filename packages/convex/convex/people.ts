/**
 * The People pages' reads (B01 §5.7, boards 8.1, 8.2, 8.5, 8.6): the lanes and their counts, a lane's
 * page, a person's page, their history, a staffer's figures and decisions, and their reports' trend.
 *
 * Every list reads the light `peopleRows` (`lib/peopleRows`), never a page of `profiles`; every count
 * is read the way its lane is (`lib/peopleFigures`); every lever the page draws comes with the verdict
 * the write would give (`lib/peopleCan`); every history or decisions read drops the ledger-grant rows
 * for a viewer who doesn't hold the grant (D227). A figure the server can't know is `null` — never
 * zero — and a read that stopped short says `capped`.
 *
 * A read whose answer turns on the time takes the page's clock (`now`), held near the server's
 * (`callerNow`), so a cached answer moves as the clock does.
 */

import {
  COUNT_CAP,
  type Count,
  callerNow,
  DELETION_GRACE_MS,
  deriveTrustClass,
  effectiveBountyLimitOf,
  isLeaving,
  lastDays,
  MAX_OPEN_BOUNTIES_PER_DAY,
  normalizePeopleListArgs,
  PEOPLE_LANES,
  type PeopleLane,
  type Restriction,
  ROLE_RANK,
  restrictionsOf,
  type Season,
  seasonOf,
  seasonRecordSpan,
  seasonRecordWindow,
  type TrustClass,
  type UserRole,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type QueryCtx, query } from './_generated/server';
import { auditTargetLabel } from './lib/auditReads';
import { hasCapability, requireCapability } from './lib/auth';
import { readVerdictCounts, VERDICT_COUNT_CAP } from './lib/contentVerdicts';
import {
  isLastLedgerEditor,
  isLedgerEditor,
  seesLedgerGrants,
  withoutLedgerGrantsFor,
} from './lib/ledgerEditors';
import { OPEN_FLAG_STATUSES } from './lib/openFlags';
import {
  no,
  type PersonWrite,
  viewerCan,
  writeRefusal,
  writeTakesAway,
  yes,
} from './lib/peopleCan';
import {
  APPEALS_CAP,
  appealsFrom,
  countTimeLane,
  flaggedPeopleFrom,
  laneRange,
  listablePeople,
  readOpenFlagQueue,
  readStoredCounts,
  readWaitingAppeals,
} from './lib/peopleFigures';
import { OPEN_ENDED, personRowOf, READY_UNDO_CHAINS } from './lib/peopleRows';
import { DOC_MAX, type ReadBudget, type RowKind, requestBudget } from './lib/readBudget';
import { trustClassFor } from './lib/reputation';
import { type UndoState, undoState } from './lib/undo';
import { chainRootId, isStandingChange, stands, undoneBy } from './lib/undoChains';

const MINUTE = 60_000;
const DAY_MS = 86_400_000;

/** The page's clock, held within a minute of the server's. */
const clock = (asked: number | undefined) => callerNow(asked, Date.now(), MINUTE);

const nowArg = { now: v.optional(v.number()) };

// ── Reads within one budget ────────────────────────────────────────────────────────────────────

/**
 * Up to `cap` rows of `kind` within `budget`, and whether there may be more: reads one past the cap
 * when the budget affords it, and as many as it affords otherwise — saying `capped` whenever the read
 * came back full. Every axis (bytes at the worst, calls, documents) is asked before the read.
 */
async function takeCapped<T>(
  budget: ReadBudget,
  kind: RowKind,
  cap: number,
  read: (n: number) => Promise<T[]>,
): Promise<{ rows: T[]; capped: boolean }> {
  const n = budget.affordsRead(kind) ? Math.min(cap + 1, budget.rows(kind, cap + 1)) : 0;
  if (n === 0) return { rows: [], capped: true };
  const rows = await budget.take(kind, n, read);
  return { rows: rows.slice(0, cap), capped: rows.length >= n };
}

/** A query's budget: the transaction's, less the caller's own profile (`requireCapability`). */
/** The request's one budget (`requestBudget`), shared with every helper the query calls. */
const queryBudget = (ctx: QueryCtx) => requestBudget(ctx);

// ── Lanes ──────────────────────────────────────────────────────────────────────────────────────

/** The lanes a viewer gets: every lane but Appeals open, which needs support's PII read (D37). */
function lanesFor(viewer: Doc<'profiles'>): PeopleLane[] {
  const support = hasCapability(viewer, 'inbox.support.read');
  return PEOPLE_LANES.filter((lane) => lane !== 'appeals' || support);
}

/**
 * Why a lane's count or list may not be whole — each the cap or the gap of one read it depends on,
 * so the page can word it:
 * - `rows_backfill` — the People rows backfill hasn't finished: a stored count and a list may miss
 *   people;
 * - `rows_missing` — a queue lane named someone who has no row yet, so the list left them out;
 * - `flags_capped` — the open flag queue was read to its cap (Flagged, and every row's open flags);
 * - `flag_subjects_pending` — an open content flag predates its subject stamp (the same);
 * - `tickets_capped` — a waiting support status was read to its cap (Appeals open, and every row's
 *   appeals);
 * - `count_capped` — a time-bound lane's count stopped at its cap (its list pages on).
 */
export type PartialReason =
  | 'rows_backfill'
  | 'rows_missing'
  | 'flags_capped'
  | 'flag_subjects_pending'
  | 'tickets_capped'
  | 'count_capped';

/** Every upstream read a People lane can depend on, read once for a request. */
async function readUpstream(ctx: QueryCtx, viewer: Doc<'profiles'>) {
  // The shared helpers' reads, charged ahead to the request's budget: the counts, each open-flag
  // status and each waiting-ticket status read one past their cap.
  const budget = requestBudget(ctx);
  budget.reserve('small', 64);
  const stored = await readStoredCounts(ctx);
  budget.reserve('contentFlag', COUNT_CAP + 1);
  budget.reserve('contentFlag', COUNT_CAP + 1);
  const queue = await readOpenFlagQueue(ctx);
  const flagged = flaggedPeopleFrom(queue.flags, queue.capped);
  const support = hasCapability(viewer, 'inbox.support.read');
  if (support) {
    budget.reserve('supportTicket', APPEALS_CAP + 1);
    budget.reserve('supportTicket', APPEALS_CAP + 1);
  }
  const waiting = support ? await readWaitingAppeals(ctx) : null;
  const appeals = waiting === null ? null : appealsFrom(waiting.tickets, waiting.capped);
  return {
    stored,
    flagged,
    appeals,
    /** What each upstream read leaves out, by reason. */
    gaps: {
      rows_backfill: !stored.rowsReady,
      flags_capped: queue.capped,
      flag_subjects_pending: flagged.unknown,
      tickets_capped: waiting?.capped === true,
    },
  };
}
type Upstream = Awaited<ReturnType<typeof readUpstream>>;

/** The reasons from `keys` whose read had a gap. */
function reasonsOf(up: Upstream, keys: readonly (keyof Upstream['gaps'])[]): PartialReason[] {
  return keys.filter((k) => up.gaps[k]);
}

/** The upstream reads each lane's own membership depends on (its count and its list alike). */
const LANE_DEPENDS: Record<PeopleLane, readonly (keyof Upstream['gaps'])[]> = {
  everyone: ['rows_backfill'],
  staff: ['rows_backfill'],
  suspended: ['rows_backfill'],
  banned: ['rows_backfill'],
  restricted: ['rows_backfill'],
  flagged: ['flags_capped', 'flag_subjects_pending', 'rows_backfill'],
  appeals: ['tickets_capped', 'rows_backfill'],
  newest: ['rows_backfill'],
  leaving: ['rows_backfill'],
  deleted: ['rows_backfill'],
};

/**
 * The sidebar: each lane the viewer has, in the board's order, with its count — read the way the
 * lane's own list is read (`lib/peopleFigures`), so a count is the rows its list yields — and the
 * reasons it may be short: `count.capped` is true exactly when `reasons` is not empty.
 */
export const lanes = query({
  args: nowArg,
  handler: async (ctx, args) => {
    const viewer = await requireCapability(ctx, 'people.read');
    const now = clock(args.now);
    const up = await readUpstream(ctx, viewer);
    const { stored } = up;
    const admins = stored.count('admins');
    const moderators = stored.count('moderators');
    const time = async (lane: 'suspended' | 'newest') => {
      const { count } = await countTimeLane(ctx, lane, now, true);
      return { count: count.count, over: count.capped };
    };
    // A queue lane counts the people its list can show: those with a row (light reads, ≤ 200).
    const listable = async (ids: Id<'profiles'>[]) => {
      const { rows, missing } = await listablePeople(ctx, ids);
      return { count: rows.length, over: false, missing };
    };
    const counts: Record<
      PeopleLane,
      () => Promise<{ count: number; over: boolean; missing?: boolean }>
    > = {
      everyone: async () => ({ count: stored.count('everyone').count, over: false }),
      staff: async () => ({ count: admins.count + moderators.count, over: false }),
      suspended: () => time('suspended'),
      banned: async () => ({ count: stored.count('banned').count, over: false }),
      restricted: async () => ({ count: stored.count('restricted').count, over: false }),
      flagged: () => listable(up.flagged.people.map((p) => p.userId)),
      appeals: () => listable((up.appeals?.people ?? []).map((p) => p.userId)),
      newest: () => time('newest'),
      leaving: async () => ({ count: stored.count('leaving').count, over: false }),
      deleted: async () => ({ count: stored.count('deleted').count, over: false }),
    };
    const out: Array<{ lane: PeopleLane; count: Count; reasons: PartialReason[] }> = [];
    for (const lane of lanesFor(viewer)) {
      const { count, over, missing = false } = await counts[lane]();
      const reasons: PartialReason[] = [
        ...reasonsOf(up, LANE_DEPENDS[lane]),
        ...(missing ? (['rows_missing'] as const) : []),
        ...(over ? (['count_capped'] as const) : []),
      ];
      out.push({ lane, count: { count, capped: reasons.length > 0 }, reasons });
    }
    return { lanes: out, ready: stored.rowsReady };
  },
});

/** A list row: what the board's row draws, from the light row and the open queues. */
export interface PersonListRow {
  userId: Id<'profiles'>;
  displayName: string;
  username: string;
  profileImageUrl: string | null;
  role: UserRole;
  status: Doc<'profiles'>['status'];
  trustClass: TrustClass | null;
  /** When the stored status began, if recorded. */
  statusSince: number | null;
  /** A suspension still running: when it lapses (`null` for an open-ended one). Absent otherwise. */
  suspension: { until: number | null } | null;
  /** The reason on file for a suspension or ban, cut to a line. */
  statusReason: string | null;
  restrictions: Restriction[];
  restrictedSince: number | null;
  /** When the deletion window ends, while in it. */
  leavingUntil: number | null;
  deletedAt: number | null;
  createdAt: number;
  /**
   * Open flags on them and on their content, from the open queue — a floor when the page's `reasons`
   * name `flags_capped` or `flag_subjects_pending`.
   */
  openFlags: { onUser: number; onContent: number };
  /** Appeals still waiting — admins only (`null` for a viewer without support). */
  appeals: number | null;
}

function toListRow(
  row: Doc<'peopleRows'>,
  now: number,
  flags: Map<string, { onUser: number; onContent: number }>,
  appeals: Map<string, number> | null,
): PersonListRow {
  const live = row.suspendedUntil > now;
  return {
    userId: row.userId,
    displayName: row.displayName,
    username: row.username,
    profileImageUrl: row.profileImageUrl ?? null,
    role: row.role,
    status: row.status,
    trustClass: row.live ? deriveTrustClass(row.reputationPoints, now - row.createdAt) : null,
    statusSince: row.statusSince > 0 ? row.statusSince : null,
    suspension: live
      ? { until: row.suspendedUntil >= OPEN_ENDED ? null : row.suspendedUntil }
      : null,
    statusReason: row.statusReason ?? null,
    restrictions: row.restrictions,
    restrictedSince: row.restrictedSince > 0 ? row.restrictedSince : null,
    leavingUntil: row.leavingUntil > 0 ? row.leavingUntil : null,
    deletedAt: row.deletedAt > 0 ? row.deletedAt : null,
    createdAt: row.createdAt,
    openFlags: flags.get(row.userId) ?? { onUser: 0, onContent: 0 },
    appeals: appeals === null ? null : (appeals.get(row.userId) ?? 0),
  };
}

/** The stored lanes' index ranges, in each lane's order — mirroring `storedLanesOf`. */
function storedRange(
  ctx: QueryCtx,
  lane: 'everyone' | 'staff' | 'banned' | 'restricted' | 'leaving' | 'deleted',
) {
  const rows = ctx.db.query('peopleRows');
  switch (lane) {
    case 'everyone':
      // By name.
      return rows.withIndex('by_live_name', (q) => q.eq('live', true)).order('asc');
    case 'staff':
      // Admins first, then moderators, each by name.
      return rows.withIndex('by_staff', (q) => q.lt('staffRank', 2)).order('asc');
    case 'banned':
      // Most recently banned first; a ban from before this record last.
      return rows.withIndex('by_status_since', (q) => q.eq('status', 'banned')).order('desc');
    case 'restricted':
      return rows.withIndex('by_restricted', (q) => q.eq('restricted', true)).order('desc');
    case 'leaving':
      // The window that ends soonest first.
      return rows.withIndex('by_leaving', (q) => q.gt('leavingUntil', 0)).order('asc');
    case 'deleted':
      // Most recently deleted first.
      return rows.withIndex('by_status_since', (q) => q.eq('status', 'deleted')).order('desc');
  }
}

/**
 * One page of a lane, or of a search over every account. Arguments are cleaned once
 * (`normalizePeopleListArgs`): an unknown lane is refused, the search trimmed and bounded, the page
 * size clamped. A search ignores the lane and orders by match. The queue lanes (Flagged, Appeals
 * open) page through the people their open queue names, oldest first, with an offset cursor.
 */
export const listPage = query({
  args: {
    lane: v.string(),
    search: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    ...nowArg,
  },
  handler: async (ctx, args) => {
    const viewer = await requireCapability(ctx, 'people.read');
    const now = clock(args.now);
    const clean = normalizePeopleListArgs(args);
    if (clean === null) throw new ConvexError('There is no such list of people');
    const { lane, search, pageSize } = clean;
    if (lane === 'appeals' && !lanesFor(viewer).includes('appeals')) {
      throw new ConvexError('Appeals are support tickets, which only an admin can read');
    }
    const cursor = args.cursor ?? null;
    const budget = queryBudget(ctx);
    const up = await readUpstream(ctx, viewer);
    const { flagged, appeals } = up;
    const flagsBy = new Map(
      flagged.people.map((p) => [p.userId as string, { onUser: p.onUser, onContent: p.onContent }]),
    );
    const appealsBy =
      appeals === null ? null : new Map(appeals.people.map((p) => [p.userId as string, p.appeals]));
    const shape = (rows: Doc<'peopleRows'>[]) =>
      rows.map((r) => toListRow(r, now, flagsBy, appealsBy));
    // What this page may be missing: the lane's own reads (a search reads only the rows), and the
    // queues every row's open flags and appeals come from.
    const own = search !== null ? (['rows_backfill'] as const) : LANE_DEPENDS[lane];
    const truth = (missing: boolean) => {
      const reasons = [
        ...new Set<PartialReason>([
          ...reasonsOf(up, own),
          ...reasonsOf(up, ['flags_capped', 'flag_subjects_pending', 'tickets_capped']),
          ...(missing ? (['rows_missing'] as const) : []),
        ]),
      ];
      return { partial: reasons.length > 0, reasons };
    };

    if (search !== null) {
      const page = await budget.page('personRow', pageSize, (n) =>
        ctx.db
          .query('peopleRows')
          .withSearchIndex('search_people', (s) => s.search('searchText', search))
          .paginate({ cursor, numItems: n }),
      );
      return {
        rows: shape(page.page),
        isDone: page.isDone,
        continueCursor: page.continueCursor,
        ...truth(false),
      };
    }

    if (lane === 'flagged' || lane === 'appeals') {
      const ids =
        lane === 'flagged'
          ? flagged.people.map((p) => p.userId)
          : (appeals?.people ?? []).map((p) => p.userId);
      // The whole lane's rows (≤ 200 light reads), so a person missing on any page is said on every
      // page, as the lane's count says it; the page is a slice of the people the list can show.
      const { rows, missing } = await listablePeople(ctx, ids);
      const start = cursor === null ? 0 : Math.max(0, Number.parseInt(cursor, 10) || 0);
      const end = Math.min(rows.length, start + pageSize);
      return {
        rows: shape(rows.slice(start, end)),
        isDone: end >= rows.length,
        continueCursor: String(end),
        ...truth(missing),
      };
    }

    const range =
      lane === 'suspended' || lane === 'newest'
        ? laneRange(ctx, lane, now)
        : storedRange(ctx, lane);
    const page = await budget.page('personRow', pageSize, (n) =>
      range.paginate({ cursor, numItems: n }),
    );
    return {
      rows: shape(page.page),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      ...truth(false),
    };
  },
});

// ── A person ───────────────────────────────────────────────────────────────────────────────────

/**
 * A person named on the page, from their light People row — never their profile, which can weigh a
 * whole document. `displayName` and `username` are `null` only for someone with no row yet (before
 * the rows backfill has reached them).
 */
export interface PersonRef {
  userId: Id<'profiles'>;
  displayName: string | null;
  username: string | null;
  profileImageUrl: string | null;
}

async function personRef(ctx: QueryCtx, id: Id<'profiles'> | undefined): Promise<PersonRef | null> {
  if (id === undefined) return null;
  const row = await personRowOf(ctx, id);
  return {
    userId: id,
    displayName: row?.displayName ?? null,
    username: row?.username ?? null,
    profileImageUrl: row?.profileImageUrl ?? null,
  };
}

/** Open flags read for a person, at most this many a status and kind. */
const PERSON_FLAG_CAP = 50;
/** A person's support tickets read for their appeals, newest first, at most. */
const PERSON_TICKETS = 50;
/** Flags a person filed, counted to at most. */
const PERSON_FILED = 100;

/** What the page's "Open about this person" shows of one open flag. */
interface OpenFlag {
  flagId: Id<'contentFlags'>;
  reason: Doc<'contentFlags'>['reason'];
  targetType: Doc<'contentFlags'>['targetType'];
  targetId: string;
  status: Doc<'contentFlags'>['status'];
  createdAt: number;
}

/**
 * A person's page (boards 8.1, 8.2, 8.5, 8.6): who they are, their status with who set it and when,
 * the strip's figures, the rights and levers, what is open about them, how much of their content is
 * hidden, the ledger row for a viewer who holds it, and `can` — for every lever, whether the write
 * would accept it from this viewer and, if not, why (`lib/peopleCan`, the rule the writes refuse by).
 * `null` for an id with no profile.
 *
 * A new read rather than `profiles.getAdmin` changed in place: the old user page and the skater
 * profile's moderator tools still read that one's shape until People replaces them, and this one
 * answers with a different contract (counts that can say *not recorded* or *capped*).
 */
export const person = query({
  args: { userId: v.id('profiles'), ...nowArg },
  handler: async (ctx, { userId, now: asked }) => {
    const viewer = await requireCapability(ctx, 'people.read');
    const now = clock(asked);
    const budget = queryBudget(ctx);
    const target = await budget.one('profile', () => ctx.db.get(userId));
    if (!target) return null;
    budget.reserve('small', 64);
    // The helpers' reads are reserved before the page's own: each `takeCapped` below sizes itself by
    // what is left, so a reserve after them could find a heavily flagged person's reads had spent it,
    // and throw. The ledger check reads admins' People rows once for every lever, and only for a
    // holder (`lib/ledgerEditors`, behind `isLastLedgerEditor`).
    if (isLedgerEditor(target)) budget.reserve('personRow', 200);
    budget.reserve('verdict', VERDICT_COUNT_CAP + 1);
    const stored = await readStoredCounts(ctx);

    // ── The status note: who set the suspension or ban, and when ──
    let statusNote: {
      action: 'ban' | 'suspend';
      at: number | null;
      by: PersonRef | null;
      via: string | null;
      reason: string | null;
      suspendedUntil: number | null;
      lapsed: boolean;
    } | null = null;
    if (target.status === 'suspended' || target.status === 'banned') {
      const verb = target.status === 'banned' ? 'ban' : 'suspend';
      const row =
        (await budget.measured('moderationAction', () =>
          ctx.db
            .query('moderationActions')
            .withIndex('by_target_action', (q) =>
              q.eq('targetType', 'user').eq('targetId', userId).eq('action', verb),
            )
            .order('desc')
            .first(),
        )) ?? null;
      statusNote = {
        action: verb,
        at: row?.createdAt ?? null,
        by: await personRef(ctx, row?.actorId),
        via: row?.via ?? null,
        reason: target.statusReason ?? null,
        suspendedUntil: target.status === 'suspended' ? (target.suspendedUntil ?? null) : null,
        lapsed:
          target.status === 'suspended' &&
          target.suspendedUntil !== undefined &&
          target.suspendedUntil <= now,
      };
    }

    // ── Open flags: on the person, and on their content ──
    const onUser: Doc<'contentFlags'>[] = [];
    const onContent: Doc<'contentFlags'>[] = [];
    let userCapped = false;
    let contentCapped = !stored.flagSubjectsReady;
    for (const status of OPEN_FLAG_STATUSES) {
      const userRows = await takeCapped(budget, 'contentFlag', PERSON_FLAG_CAP, (n) =>
        ctx.db
          .query('contentFlags')
          .withIndex('by_target_status_reason', (q) =>
            q.eq('targetType', 'user').eq('targetId', userId).eq('status', status),
          )
          .take(n),
      );
      userCapped ||= userRows.capped;
      onUser.push(...userRows.rows);
      const subjectRows = await takeCapped(budget, 'contentFlag', 2 * PERSON_FLAG_CAP, (n) =>
        ctx.db
          .query('contentFlags')
          .withIndex('by_subject_status', (q) => q.eq('subjectUserId', userId).eq('status', status))
          .take(n),
      );
      const content = subjectRows.rows.filter((f) => f.targetType !== 'user');
      contentCapped ||= subjectRows.capped || content.length > PERSON_FLAG_CAP;
      onContent.push(...content.slice(0, PERSON_FLAG_CAP));
    }
    const openFlags: OpenFlag[] = [...onUser, ...onContent]
      .sort((a, b) => a.createdAt - b.createdAt || a._creationTime - b._creationTime)
      .map((f) => ({
        flagId: f._id,
        reason: f.reason,
        targetType: f.targetType,
        targetId: f.targetId,
        status: f.status,
        createdAt: f.createdAt,
      }));

    // ── Appeals: support tickets, admins only (PII, D37) ──
    let appeals: Array<{
      ticketId: Id<'supportTickets'>;
      status: string;
      createdAt: number;
    }> | null = null;
    let appealsCapped = false;
    if (hasCapability(viewer, 'inbox.support.read')) {
      const tickets = await takeCapped(budget, 'supportTicket', PERSON_TICKETS, (n) =>
        ctx.db
          .query('supportTickets')
          .withIndex('by_clerk_user_created', (q) => q.eq('clerkUserId', target.clerkUserId))
          .order('desc')
          .take(n),
      );
      appealsCapped = tickets.capped;
      appeals = tickets.rows
        .filter((t) => t.category === 'account' && t.status !== 'resolved')
        .map((t) => ({ ticketId: t._id, status: t.status, createdAt: t.createdAt }))
        .reverse();
    }

    // ── Flags they filed (the Flagging lever's "N filed") ──
    // An automatic flag names the rater whose thumb crossed the line as its flagger, though they
    // filed nothing (`lib/autoFlag`): only a person's own (`origin: 'user'`) counts, and a read that
    // stopped short makes the count a floor.
    const flaggedBy = await takeCapped(budget, 'contentFlag', PERSON_FILED, (n) =>
      ctx.db
        .query('contentFlags')
        .withIndex('by_flagger', (q) => q.eq('flaggerId', userId))
        .take(n),
    );
    const flagsFiled: Count = {
      count: flaggedBy.rows.filter((f) => f.origin === 'user').length,
      capped: flaggedBy.capped,
    };

    // ── The levers, and whether this viewer may pull each: the write's own refusal ──
    const discipline = viewerCan(viewer, 'people.discipline');
    const roles = viewerCan(viewer, 'people.role');
    const answer = async (write: PersonWrite, allowed: boolean, family: 'discipline' | 'role') => {
      if (!allowed) return no(cannotUse(viewer, family));
      const why = await writeRefusal(ctx, viewer, target, write);
      return why === null ? yes(writeTakesAway(target, write)) : no(why);
    };
    const lever = (write: PersonWrite) => answer(write, discipline, 'discipline');
    const restrict = await lever({ kind: 'right', permission: 'reports', allowed: false });
    const flaggingOff = await lever({ kind: 'right', permission: 'flagging', allowed: false });
    const roleCan = (role: UserRole) => answer({ kind: 'role', role }, roles, 'role');
    const ledgerVisible = target.role === 'admin' && seesLedgerGrants(viewer);
    const grantWhy = ledgerVisible
      ? await writeRefusal(ctx, viewer, target, { kind: 'ledgerGrant' })
      : null;
    const revokeWhy = ledgerVisible
      ? await writeRefusal(ctx, viewer, target, { kind: 'ledgerRevoke' })
      : null;

    const hidden = await readVerdictCounts(ctx, userId);
    const contradictions = target.contradictionCount;

    return {
      userId,
      displayName: target.displayName,
      username: target.username,
      profileImageUrl: target.profileImageUrl ?? null,
      profileVisibility: target.profileVisibility,
      role: target.role,
      status: target.status,
      trustClass: target.status === 'deleted' ? null : trustClassFor(target, now),
      createdAt: target.createdAt,
      leavingUntil:
        target.deletionRequestedAt !== undefined && target.status !== 'deleted'
          ? target.deletionRequestedAt + DELETION_GRACE_MS
          : null,
      deletedAt: target.deletedAt ?? null,
      statusNote,
      strip: {
        /** Private, unexplained by weather; `null` when never counted (not zero). */
        contradictions: contradictions === undefined ? null : contradictions,
        openFlags: {
          onUser: { count: onUser.length, capped: userCapped },
          onContent: { count: onContent.length, capped: contentCapped },
        },
        /** Raw trust points: admins only (`people.trustScore`, D50); `null` for anyone else. */
        trustPoints: hasCapability(viewer, 'people.trustScore') ? target.reputationPoints : null,
      },
      rights: {
        reports: target.canPostReports !== false,
        hazards: target.canPostHazards !== false,
        comments: target.canPostComments !== false,
        // Staff are exempt from the switch (D222): they can always flag.
        flagging: target.canFlag !== false || ROLE_RANK[target.role] >= ROLE_RANK.moderator,
        /** Their own bounty limit, or `null` for the global one. */
        bountyLimit: target.activeBountyPostLimit ?? null,
        defaultBountyLimit: MAX_OPEN_BOUNTIES_PER_DAY,
        effectiveBountyLimit: effectiveBountyLimitOf(target.activeBountyPostLimit),
        restrictions: target.status === 'deleted' ? [] : restrictionsOf(target),
        flagsFiled,
      },
      open: {
        flags: openFlags,
        flagsCapped: userCapped || contentCapped,
        appeals,
        appealsCapped,
      },
      hidden,
      ledger: ledgerVisible
        ? {
            editor: isLedgerEditor(target),
            /** The last editor who can act: their switch can't be turned off (D227). */
            last: await isLastLedgerEditor(ctx, target),
          }
        : null,
      can: {
        restrict,
        flaggingOff,
        suspend: await lever({ kind: 'suspend' }),
        ban: await lever({ kind: 'ban' }),
        lift: await lever({ kind: 'lift' }),
        role: {
          admin: await roleCan('admin'),
          moderator: await roleCan('moderator'),
          member: await roleCan('member'),
        },
        ledger: ledgerVisible
          ? {
              grant: grantWhy === null ? yes(false) : no(grantWhy),
              revoke: revokeWhy === null ? yes(true) : no(revokeWhy),
            }
          : null,
      },
    };
  },
});

/** Why a viewer can't use a lever family at all: their role, or their own deletion. */
function cannotUse(viewer: Doc<'profiles'>, family: 'discipline' | 'role'): string {
  if (isLeaving(viewer)) return 'Your account is being deleted, so you can no longer change this.';
  return family === 'role' ? 'Only an admin can change roles.' : 'Only staff can change this.';
}

// ── History and decisions ──────────────────────────────────────────────────────────────────────

/** Rows a history or decisions read returns by default, and at most. */
const HISTORY_DEFAULT = 50;
/** The person's own audit rows read at most, as they really weigh. */
const HISTORY_BYTES = 2 * DOC_MAX;
const HISTORY_MAX = 100;

const clampLimit = (limit: number | undefined) =>
  limit === undefined || !Number.isFinite(limit)
    ? HISTORY_DEFAULT
    : Math.min(HISTORY_MAX, Math.max(1, Math.floor(limit)));

/** A history or decisions row: the audit row as History draws it, with its undo state. */
export interface PersonActionRow {
  id: Id<'moderationActions'>;
  action: Doc<'moderationActions'>['action'];
  targetType: Doc<'moderationActions'>['targetType'];
  targetId: string;
  reason: string;
  /** `false` when the server filled the reason in for a give-back that asked none (D226). */
  reasonGiven: boolean;
  metadata?: unknown;
  createdAt: number;
  /** Who acted, from their People row; `null` for the system. */
  actor: PersonRef | null;
  /** The target's name — a body's or a person's — as the audit feed labels it (`auditTargetLabel`). */
  targetLabel?: string;
  /** Set on the row an undo wrote: the row it undid (D226). */
  undoesActionId?: Id<'moderationActions'>;
  /** The script or agent the actor made the write through (D256). */
  via?: string;
  /** Whether the viewer can undo this row now, and if not, why (D226). */
  undo: UndoState;
}

/**
 * Each actor's row read once a page. The rows are shaped concurrently (`Promise.all`), so the memo
 * holds the read itself, not its answer: an answer stored after an `await` would land only once every
 * row had already started its own read.
 */
type Actors = Map<string, Promise<PersonRef | null>>;

/** Target names a request has read, once each (many rows name the same person or body). */
const LABELS = new WeakMap<object, Map<string, Promise<string | null>>>();

async function labelOf(
  ctx: QueryCtx,
  row: Doc<'moderationActions'>,
): Promise<{ targetLabel?: string }> {
  const seen = LABELS.get(ctx) ?? new Map<string, Promise<string | null>>();
  LABELS.set(ctx, seen);
  const key = `${row.targetType}:${row.targetId}`;
  let read = seen.get(key);
  if (read === undefined) {
    read = auditTargetLabel(ctx, row.targetType, row.targetId);
    seen.set(key, read);
  }
  const label = await read;
  return label === null ? {} : { targetLabel: label };
}

/**
 * What shaping one History or Decisions row reads through helpers on main and in this PR — undo state
 * (the undo tagged rows ≤ 16, the newest row on the target, the content's author stamp, the person's
 * row, a rowless fallback), the actor's and the target's names — counted ahead: calls and documents.
 * Their bytes are audit rows and content items read as they really weigh (an audit row's reason has
 * no cap; the phase doc's open ruling).
 */
const ROW_SHAPE_CALLS = 8;
const ROW_SHAPE_DOCS = 24;

/** Rows shaped in order, each counted ahead against the request's budget (≤ 100 rows: it fits). */
async function shapeRows(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  rows: readonly Doc<'moderationActions'>[],
  actors: Actors,
): Promise<PersonActionRow[]> {
  const budget = requestBudget(ctx);
  const out: PersonActionRow[] = [];
  for (const row of rows) {
    budget.reserveCalls(ROW_SHAPE_CALLS, ROW_SHAPE_DOCS);
    out.push(await toRow(ctx, viewer, row, actors));
  }
  return out;
}

async function toRow(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  row: Doc<'moderationActions'>,
  actors: Actors,
): Promise<PersonActionRow> {
  let actor: PersonRef | null = null;
  if (row.actorId !== undefined) {
    let read = actors.get(row.actorId);
    if (read === undefined) {
      read = personRef(ctx, row.actorId);
      actors.set(row.actorId, read);
    }
    actor = await read;
  }
  return {
    id: row._id,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    reason: row.reason,
    reasonGiven:
      (row.metadata as { reasonDefaulted?: boolean } | undefined)?.reasonDefaulted !== true,
    ...(row.metadata !== undefined ? { metadata: row.metadata } : {}),
    createdAt: row.createdAt,
    actor,
    ...(row.undoesActionId !== undefined ? { undoesActionId: row.undoesActionId } : {}),
    ...(row.via !== undefined ? { via: row.via } : {}),
    ...(await labelOf(ctx, row)),
    undo: await undoState(ctx, viewer, row),
  };
}

/** One source of a merged history: rows in the order of `at`, and how far back it read when capped. */
interface Source {
  rows: Doc<'moderationActions'>[];
  /** The `at` of the last item read, when the source stopped short — older rows may be missing. */
  horizon: number | null;
}

/**
 * Merge sources newest first. A source that stopped short read everything after its horizon and
 * nothing before it, so the merge keeps only rows at or after the latest such horizon: a capped
 * source never lets an older row in ahead of one it didn't read ("cap, then sort" never drops the
 * row the order says belongs). `capped` says the list is not the whole history.
 */
export function mergeSources(
  sources: Source[],
  limit: number,
): { rows: Doc<'moderationActions'>[]; capped: boolean } {
  const horizon = Math.max(0, ...sources.map((s) => s.horizon ?? 0));
  const seen = new Set<string>();
  const merged: Doc<'moderationActions'>[] = [];
  for (const row of sources.flatMap((s) => s.rows)) {
    if (seen.has(row._id) || row.createdAt < horizon) continue;
    seen.add(row._id);
    merged.push(row);
  }
  merged.sort((a, b) => b.createdAt - a.createdAt || (a._id < b._id ? 1 : -1));
  const anyCapped = sources.some((s) => s.horizon !== null);
  return { rows: merged.slice(0, limit), capped: anyCapped || merged.length > limit };
}

/** The verbs a staffer's own skater life writes: never a decision (the founder, 2026-11-14). */
const SKATER_ACTIONS: ReadonlySet<string> = new Set([
  'author_delete',
  'author_resolve_access_alert',
]);
const LEDGER_ACTIONS: ReadonlySet<string> = new Set([
  'grant_ledger_editor',
  'revoke_ledger_editor',
]);

/** A decision: a row the staffer made as staff, which the viewer may see (D227). */
function isDecision(row: Doc<'moderationActions'>, ledgerVisible: boolean): boolean {
  return (
    row.actorId !== undefined &&
    !SKATER_ACTIONS.has(row.action) &&
    (ledgerVisible || !LEDGER_ACTIONS.has(row.action))
  );
}

/**
 * A person's history (the page's History block): every action on them, every verdict on their
 * content and its reversal, and every decision on a flag about them or their content — newest first,
 * each with its undo state and audit-row id, a script's write carrying its `via`. The ledger-grant
 * rows are dropped for a viewer who doesn't hold the grant (D227). `capped` when the list is not the
 * whole history; `createdAt` is the account's creation, which no audit row records, for the page's
 * last line. `null` for an id with no profile.
 */
export const history = query({
  args: { userId: v.id('profiles'), limit: v.optional(v.number()) },
  handler: async (ctx, { userId, limit }) => {
    const viewer = await requireCapability(ctx, 'audit.read');
    const budget = queryBudget(ctx);
    const target = await budget.one('profile', () => ctx.db.get(userId));
    if (!target) return null;
    const n = clampLimit(limit);
    budget.reserve('small', 64);
    const stored = await readStoredCounts(ctx);
    const sources: Source[] = [];
    type Audit = Doc<'moderationActions'>;
    /**
     * One source, in the order of `at`: each item's audit rows, read until the items or the budget
     * run out. A source cut short — its read capped, or the budget gone — keeps its horizon.
     */
    const source = async <T>(
      read: { rows: T[]; capped: boolean },
      atOf: (item: T) => number,
      rowsOf: (item: T) => Promise<Audit[] | undefined>,
    ) => {
      const rows: Audit[] = [];
      let last: T | undefined;
      let cut = read.capped;
      for (const item of read.rows) {
        const got = await rowsOf(item);
        if (got === undefined) {
          cut = true;
          break;
        }
        rows.push(...got);
        last = item;
      }
      sources.push({
        rows,
        horizon: cut ? (last === undefined ? Number.POSITIVE_INFINITY : atOf(last)) : null,
      });
    };
    const one = async (id: Id<'moderationActions'> | undefined) => {
      if (id === undefined) return [];
      const row = await budget.measured('moderationAction', () => ctx.db.get(id));
      return row === undefined ? undefined : row === null ? [] : [row];
    };

    // On the person: their own rows, under a real-weight cap.
    const onPerson = await budget.capped(HISTORY_BYTES, n, () =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) => q.eq('targetType', 'user').eq('targetId', userId))
        .order('desc')
        .paginate({ cursor: null, numItems: n, maximumBytesRead: HISTORY_BYTES }),
    );
    await source(
      { rows: onPerson.page, capped: !onPerson.isDone },
      (r) => r.createdAt,
      async (r) => [r],
    );

    // Verdicts on their content, as given, and as ended.
    for (const standing of [true, false]) {
      const given = await takeCapped(budget, 'verdict', n, (k) =>
        ctx.db
          .query('contentVerdicts')
          .withIndex('by_subject_standing', (q) =>
            q.eq('subjectUserId', userId).eq('standing', standing),
          )
          .order('desc')
          .take(k),
      );
      await source(
        given,
        (vd) => vd.at,
        (vd) => one(vd.actionId),
      );
    }
    const ended = await takeCapped(budget, 'verdict', n, (k) =>
      ctx.db
        .query('contentVerdicts')
        .withIndex('by_subject_ended', (q) => q.eq('subjectUserId', userId).gt('endedAt', 0))
        .order('desc')
        .take(k),
    );
    await source(
      ended,
      (vd) => vd.endedAt ?? 0,
      (vd) => one(vd.endedByActionId),
    );

    // Decisions on flags about them or their content: each flag's deciding row.
    for (const status of ['actioned', 'dismissed'] as const) {
      const flags = await takeCapped(budget, 'contentFlag', n, (k) =>
        ctx.db
          .query('contentFlags')
          .withIndex('by_subject_status', (q) => q.eq('subjectUserId', userId).eq('status', status))
          .order('desc')
          .take(k),
      );
      const verb = status === 'actioned' ? 'resolve_flag' : 'dismiss_flag';
      await source(
        flags,
        (f) => f.resolvedAt ?? f.createdAt,
        async (flag) => {
          const row = await budget.measured('moderationAction', () =>
            ctx.db
              .query('moderationActions')
              .withIndex('by_target_action', (q) =>
                q.eq('targetType', 'contentFlag').eq('targetId', flag._id).eq('action', verb),
              )
              .order('desc')
              .first(),
          );
          return row === undefined ? undefined : row === null ? [] : [row];
        },
      );
    }

    const visible = withoutLedgerGrantsFor(
      viewer,
      sources.flatMap((s) => s.rows),
    );
    const keep = new Set(visible.map((r) => r._id));
    const merged = mergeSources(
      sources.map((s) => ({ ...s, rows: s.rows.filter((r) => keep.has(r._id)) })),
      n,
    );
    const actors: Actors = new Map();
    return {
      rows: await shapeRows(ctx, viewer, merged.rows, actors),
      // Flags older than the subject stamp aren't found by person until its backfill has run.
      capped: merged.capped || !stored.flagSubjectsReady,
      createdAt: target.createdAt,
    };
  },
});

/** Audit rows a decisions page scans at most, past the ones it returns. */
const DECISIONS_SCAN = 2_000;
/** And their real weight at most. */
const DECISIONS_BYTES = 2 * DOC_MAX;

/**
 * A staffer's decisions, newest first, a page at a time (the staff page's Decisions block): the rows
 * they made, minus their own skater actions (deleting their own content, resolving their own alert),
 * minus the ledger-grant rows for a viewer who doesn't hold the grant — the same rows `staffStats`
 * counts. Each with its undo state.
 */
export const decisions = query({
  args: {
    userId: v.id('profiles'),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { userId, cursor, limit }) => {
    const viewer = await requireCapability(ctx, 'audit.read');
    const ledgerVisible = seesLedgerGrants(viewer);
    const budget = queryBudget(ctx);
    const page = await budget.capped(DECISIONS_BYTES, DECISIONS_SCAN, () =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_actor', (q) => q.eq('actorId', userId))
        .order('desc')
        .filter((q) => {
          const hidden = [...SKATER_ACTIONS, ...(ledgerVisible ? [] : [...LEDGER_ACTIONS])];
          return q.and(...hidden.map((a) => q.neq(q.field('action'), a)));
        })
        .paginate({
          cursor: cursor ?? null,
          numItems: clampLimit(limit),
          maximumRowsRead: DECISIONS_SCAN,
          maximumBytesRead: DECISIONS_BYTES,
        }),
    );
    const actors: Actors = new Map();
    return {
      rows: await shapeRows(ctx, viewer, page.page, actors),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

// ── A staffer's figures ────────────────────────────────────────────────────────────────────────

/** The trend's weeks. */
const WEEKS = 9;
const WEEK_MS = 7 * DAY_MS;
/**
 * A staffer's decisions read at most — one read for the weeks and the season both — by count and by
 * their real weight (`maximumBytesRead`): an audit row's reason is uncapped, so no worst case per row
 * would let a useful number through.
 */
const DECISION_ROWS = 2_000;
const DECISION_BYTES = 4 * DOC_MAX;
/** Role rows walked at most for *staff since*. */
const ROLE_ROWS = 50;

/** The verbs that decide something a person filed, for *Time to decide*. Tickets wait on an audit. */
const FILED_DECISIONS: ReadonlySet<string> = new Set([
  'resolve_flag',
  'dismiss_flag',
  'approve_request',
  'decline_request',
  'approve_waterbody',
  'reject_waterbody',
]);
/** The verbs that put a verdict on the person's record (`lib/contentVerdicts`). */
const VERDICT_ACTIONS: ReadonlySet<string> = new Set(['hide', 'remove', 'retract_access_alert']);

/** The lower median of durations, `null` for none. */
export function lowerMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

type Audit = Doc<'moderationActions'>;

/**
 * Chain roots for a read: from the rows already in hand, else read once each as they really weigh
 * (`ReadBudget.measured`). `undefined` when the budget can't afford the read — the caller's figure is
 * then capped.
 */
function rootReader(ctx: QueryCtx, budget: ReadBudget, known: readonly Audit[]) {
  const byId = new Map<string, Audit>(known.map((r) => [r._id, r]));
  return async (row: Audit): Promise<Audit | undefined> => {
    const id = chainRootId(row);
    // A row no undo is its own first row: already in hand, never read again.
    if (id === row._id) return row;
    const have = byId.get(id);
    if (have) return have;
    const read = await budget.measured('moderationAction', () => ctx.db.get(id));
    if (read === undefined) return undefined;
    // The first row is gone: judge the row on its own — nothing known above it, so it stands.
    if (read === null) return { ...row, undoTop: row.undoDepth ?? 0, undoTopActorId: undefined };
    byId.set(id, read);
    return read;
  };
}

/** What a role row says: the role it gave and the one it replaced (absent on rows from before). */
function roleMove(row: Audit): { to: UserRole; from: UserRole | undefined } {
  const m = (row.metadata ?? {}) as { role?: UserRole; priorRole?: UserRole };
  return { to: row.action === 'revoke_role' ? 'member' : (m.role ?? 'member'), from: m.priorRole };
}

/**
 * When a staffer became staff, and when they took the role they hold — each `null` (not recorded)
 * unless a row on record says so:
 * - only **standing changes** count (`lib/undoChains`): an undo is no change of its own, and a change
 *   undone on net is gone — undone twice, it is back with its own time;
 * - **staff since** is the grant that moved them *in* from member (`priorRole: 'member'`) after the
 *   latest revoke. A move between moderator and admin is not an entry, and a grant with no
 *   `priorRole` (a row from before it was recorded) can't be told from one — so when the entering
 *   grant isn't on record, the answer is `null`, never a later move's date;
 * - **role since** is the newest standing change, when the role it gave is the one held now; else the
 *   move to the present role was never recorded: `null`.
 */
export function staffTenure(
  rows: readonly Audit[],
  rootOf: (row: Audit) => Audit,
  role: UserRole,
): {
  staffSince: { at: number; role: UserRole } | null;
  roleSince: { at: number; role: UserRole } | null;
} {
  const changes = rows
    .filter((r) => isStandingChange(r, rootOf(r)))
    .sort((x, y) => y.createdAt - x.createdAt);
  const lastRevoke = changes.find((r) => r.action === 'revoke_role');
  const entry = changes.find(
    (g) =>
      g.action === 'grant_role' &&
      (lastRevoke === undefined || g.createdAt > lastRevoke.createdAt) &&
      roleMove(g).from === 'member',
  );
  const newest = changes[0];
  return {
    staffSince: entry === undefined ? null : { at: entry.createdAt, role: roleMove(entry).to },
    roleSince:
      newest !== undefined && roleMove(newest).to === role ? { at: newest.createdAt, role } : null,
  };
}

/**
 * A staffer's strip (the founder's definitions, 2026-11-14):
 * - **decisions** this week — the rows they made, minus their own skater actions, and how many
 *   someone else undid on net (`lib/undoChains`);
 * - **timeToDecide** — the lower median, over this week's decisions on filed items (flags, requests,
 *   drawn bodies), of filed to decided; `null` when none, or when any one's filing time isn't known;
 * - **overturned** this season — their decisions someone else reversed on net (an undo, or a restore
 *   or overturn that ended the verdict and still stands); `null` while the season's record hasn't
 *   opened (1 July to 1 October, or a season not begun), with `season.opensOn` to say when it does;
 * - **staffSince** and **roleSince** — {@link staffTenure}; `null` when no row on record says so;
 * - **weeks** — decisions in each of the last nine weeks, oldest first.
 *
 * **Fits by construction**: one read of the staffer's decisions serves both windows (real-weight
 * capped), and every further read — a chain's first row, a verdict, the row that ended it, a filing
 * — goes through one budget that counts bytes, calls and documents and is asked before each read; when
 * it runs out the loop stops and the figure says `capped` (the median reading `null` as well). The
 * role rows are read first, so those loops can't starve the dates. Before the undo-chain backfill has
 * run, the undo figures say `capped`, and so do the dates when an undo among the role rows predates it.
 *
 * `null` for anyone who isn't staff. Moderators read it on an admin's page too: the audit feed
 * already shows them everything it counts.
 */
export const staffStats = query({
  args: { userId: v.id('profiles'), ...nowArg },
  handler: async (ctx, args) => {
    const viewer = await requireCapability(ctx, 'audit.read');
    const now = clock(args.now);
    const budget = queryBudget(ctx);
    const target = await budget.one('profile', () => ctx.db.get(args.userId));
    if (!target || ROLE_RANK[target.role] < ROLE_RANK.moderator) return null;
    const ledgerVisible = seesLedgerGrants(viewer);
    const staffer = target._id;
    const chainsReady =
      (await budget.one('small', () =>
        ctx.db
          .query('peopleCounts')
          .withIndex('by_key', (q) => q.eq('key', READY_UNDO_CHAINS))
          .first(),
      )) !== null;

    // ── One read of their decisions over the nine weeks ──
    const today = lastDays(now, 1);
    const end = today.to;
    const weeksFrom = end - WEEKS * WEEK_MS;
    const readFrom = weeksFrom - DAY_MS;
    const page = await budget.capped(DECISION_BYTES, DECISION_ROWS, () =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_actor', (q) => q.eq('actorId', staffer).gte('_creationTime', readFrom))
        .order('desc')
        .paginate({
          cursor: null,
          numItems: DECISION_ROWS,
          maximumRowsRead: DECISION_ROWS,
          maximumBytesRead: DECISION_BYTES,
        }),
    );
    const decisions = page.page.filter((r) => isDecision(r, ledgerVisible));
    const oldestRead =
      page.page.length > 0 ? (page.page[page.page.length - 1] as Audit).createdAt : end;
    const readAllAfter = (t: number) => page.isDone || oldestRead < t;
    const rootOf = rootReader(ctx, budget, page.page);

    // ── Staff since and role since, from the role rows, walked newest first ──
    // Read before the per-decision loops below, which run until the budget is spent: read after them,
    // a busy staffer's dates would be starved and say capped whenever those loops ran out.
    const roleRows: Audit[] = [];
    let roleShort = false;
    let roleFull = false;
    for (const action of ['grant_role', 'revoke_role'] as const) {
      let before = Number.POSITIVE_INFINITY;
      for (let i = 0; i < ROLE_ROWS; i++) {
        if (i === ROLE_ROWS - 1) roleFull = true;
        const row = await budget.measured('moderationAction', () =>
          ctx.db
            .query('moderationActions')
            .withIndex('by_target_action', (q) =>
              q
                .eq('targetType', 'user')
                .eq('targetId', staffer)
                .eq('action', action)
                .lt('_creationTime', before),
            )
            .order('desc')
            .first(),
        );
        if (row === undefined) {
          roleShort = true;
          break;
        }
        if (row === null) break;
        roleRows.push(row);
        before = row._creationTime;
      }
    }
    // Before the undo-chain backfill, an undo written before chains were kept carries no place, and
    // the change it undid still reads as standing: the dates can't be told, so they say so.
    if (!chainsReady && roleRows.some((r) => r.undoesActionId !== undefined && !r.undoRoot)) {
      roleShort = true;
    }
    const roleRoot = rootReader(ctx, budget, roleRows);
    const roots = new Map<string, Audit>();
    for (const r of roleShort ? [] : roleRows) {
      const root = await roleRoot(r);
      if (root === undefined) {
        roleShort = true;
        break;
      }
      roots.set(r._id, root);
    }
    const tenure = roleShort
      ? { staffSince: null, roleSince: null }
      : staffTenure(roleRows, (r) => roots.get(r._id) ?? r, target.role);

    const weeks = Array.from({ length: WEEKS }, (_, i) => {
      const start = end - (WEEKS - i) * WEEK_MS;
      const count = decisions.filter(
        (r) => r.createdAt >= start && r.createdAt < start + WEEK_MS,
      ).length;
      return { from: start, count, capped: !readAllAfter(start) };
    });
    const thisWeek = weeks[WEEKS - 1] as { from: number; count: number; capped: boolean };
    const weekRows = decisions.filter((r) => r.createdAt >= thisWeek.from && r.createdAt < end);

    // Undone on net by someone else: from the row and its chain's first row, no chain walked.
    const byOther = (by: Id<'profiles'> | undefined | null) =>
      by !== null && by !== undefined && by !== staffer;
    let undone = 0;
    let undoShort = !chainsReady;
    for (const r of weekRows) {
      const root = await rootOf(r);
      if (root === undefined) {
        undoShort = true;
        break;
      }
      if (byOther(undoneBy(r, root))) undone++;
    }

    const durations: number[] = [];
    let unknown = 0;
    // A filing time the budget ran out before reading is capped, not unrecorded.
    let decideShort = false;
    const filed = weekRows.filter((x) => FILED_DECISIONS.has(x.action));
    for (const r of filed) {
      const filedAt = await filedAtOf(ctx, budget, r);
      if (filedAt === undefined) {
        decideShort = true;
        break;
      }
      if (filedAt === null) unknown++;
      else durations.push(Math.max(0, r.createdAt - filedAt));
    }

    return {
      decisions: {
        thisWeek: { count: thisWeek.count, capped: thisWeek.capped },
        undoneByOthers: { count: undone, capped: thisWeek.capped || undoShort },
      },
      timeToDecide: {
        medianMs: unknown > 0 || thisWeek.capped || decideShort ? null : lowerMedian(durations),
        decided: filed.length,
        capped: thisWeek.capped || decideShort,
      },
      staffSince: tenure.staffSince,
      roleSince: tenure.roleSince,
      /**
       * The role rows couldn't all be read, or an undo among them predates the undo-chain backfill:
       * both dates are `null` for that reason, not unrecorded.
       */
      tenureCapped: roleShort || (roleFull && tenure.staffSince === null),
      weeks,
    };
  },
});

/** A season's decisions checked for reversals at most: the query's time bound (Convex gives one second). */
const SEASON_CHECKED = 600;

/**
 * A staffer's *Overturned this season* — their decisions in the season's record window someone else
 * reversed on net: undid (from the stored chain facts), or ended the verdict with a restore, an
 * overturn or an undo that still stands. Its own query, reading that season's range — so a past
 * season, chosen, is read whole rather than behind newer rows — under one budget, checking at most
 * {@link SEASON_CHECKED} decisions (the time bound); past any bound `overturned.capped`. Between 1
 * July and 1 October the season is honestly empty: `overturned: null`, `empty: true`, and `opensOn`
 * says when its record begins. `null` for anyone who isn't staff.
 */
export const staffSeason = query({
  args: { userId: v.id('profiles'), season: v.optional(v.number()), ...nowArg },
  handler: async (ctx, args) => {
    const viewer = await requireCapability(ctx, 'audit.read');
    const now = clock(args.now);
    const budget = queryBudget(ctx);
    const target = await budget.one('profile', () => ctx.db.get(args.userId));
    if (!target || ROLE_RANK[target.role] < ROLE_RANK.moderator) return null;
    const season: Season =
      args.season !== undefined && Number.isInteger(args.season) ? args.season : seasonOf(now);
    const span = seasonRecordSpan(season, now);
    const head = { season, opensOn: seasonRecordWindow(season, now).opensOn, empty: span === null };
    if (span === null) return { ...head, overturned: null };
    const ledgerVisible = seesLedgerGrants(viewer);
    const staffer = target._id;
    const chainsReady =
      (await budget.one('small', () =>
        ctx.db
          .query('peopleCounts')
          .withIndex('by_key', (q) => q.eq('key', READY_UNDO_CHAINS))
          .first(),
      )) !== null;
    const page = await budget.capped(DECISION_BYTES, DECISION_ROWS, () =>
      ctx.db
        .query('moderationActions')
        .withIndex('by_actor', (q) =>
          q
            .eq('actorId', staffer)
            .gte('_creationTime', span.from - DAY_MS)
            .lt('_creationTime', span.to + DAY_MS),
        )
        .order('desc')
        .paginate({
          cursor: null,
          numItems: DECISION_ROWS,
          maximumRowsRead: DECISION_ROWS,
          maximumBytesRead: DECISION_BYTES,
        }),
    );
    const rootOf = rootReader(ctx, budget, page.page);
    const inSeason = page.page.filter(
      (r) => r.createdAt >= span.from && r.createdAt < span.to && isDecision(r, ledgerVisible),
    );
    let count = 0;
    let short = !chainsReady || !page.isDone || inSeason.length > SEASON_CHECKED;
    for (const r of inSeason.slice(0, SEASON_CHECKED)) {
      const reversed = await reversedByOther(ctx, budget, rootOf, r, staffer);
      if (reversed === undefined) {
        short = true;
        break;
      }
      if (reversed) count++;
    }
    return { ...head, overturned: { count, capped: short } as Count };
  },
});

/**
 * Whether someone else reversed `row` on net — undid it, or ended the verdict it recorded with a
 * restore, an overturn or an undo that still stands. `undefined` when the budget ran out first.
 */
async function reversedByOther(
  ctx: QueryCtx,
  budget: ReadBudget,
  rootOf: (row: Audit) => Promise<Audit | undefined>,
  row: Audit,
  staffer: Id<'profiles'>,
): Promise<boolean | undefined> {
  const root = await rootOf(row);
  if (root === undefined) return undefined;
  const by = undoneBy(row, root);
  if (by !== null && by !== undefined && by !== staffer) return true;
  if (!VERDICT_ACTIONS.has(row.action)) return false;
  const verdict = await budget.measured('verdict', () =>
    ctx.db
      .query('contentVerdicts')
      .withIndex('by_action', (q) => q.eq('actionId', row._id))
      .first(),
  );
  if (verdict === undefined) return undefined;
  if (verdict === null || verdict.standing || verdict.endedByActionId === undefined) return false;
  const endedBy = verdict.endedByActionId;
  const ending = await budget.measured('moderationAction', () => ctx.db.get(endedBy));
  if (ending === undefined) return undefined;
  if (ending === null || ending.actorId === undefined || ending.actorId === staffer) return false;
  const reverses =
    ending.action === 'restore' ||
    ending.action === 'overturn_verdict' ||
    ending.undoesActionId !== undefined;
  if (!reverses) return false;
  const endingRoot = await rootOf(ending);
  if (endingRoot === undefined) return undefined;
  return stands(ending, endingRoot);
}

/**
 * When the item a filed decision decided was filed: from the row, or (older rows) the flag or ask,
 * read as it really weighs within the budget. `null` when it can't be told; `undefined` when the
 * budget ran out before the read.
 */
async function filedAtOf(
  ctx: QueryCtx,
  budget: ReadBudget,
  row: Audit,
): Promise<number | null | undefined> {
  const recorded = (row.metadata as { filedAt?: unknown } | undefined)?.filedAt;
  if (typeof recorded === 'number') return recorded;
  if (row.targetType === 'contentFlag') {
    const id = ctx.db.normalizeId('contentFlags', row.targetId);
    if (!id) return null;
    const flag = await budget.measured('contentFlag', () => ctx.db.get(id));
    return flag === undefined ? undefined : (flag?.createdAt ?? null);
  }
  if (row.targetType === 'waterBodyRequest') {
    const id = ctx.db.normalizeId('waterBodyRequests', row.targetId);
    if (!id) return null;
    const ask = await budget.measured('waterBodyRequest', () => ctx.db.get(id));
    return ask === undefined ? undefined : (ask?.createdAt ?? null);
  }
  // A drawn body's decision from before the row recorded it: reading the body means its outline.
  return null;
}

// ── Their reports ──────────────────────────────────────────────────────────────────────────────

/** The trend's months by default, and at most. */
const TREND_MONTHS = 9;
const TREND_MONTHS_MAX = 24;
/** A person's reports read at most, by count and by their real weight. */
const REPORTS_ROWS = 3_000;
const REPORTS_BYTES = 8 * 1024 * 1024;

/** `YYYY-MM` for an instant, UTC. */
function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** The months from `fromMs`'s through `toMs`'s, UTC, oldest first. */
export function monthsBetween(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  const d = new Date(fromMs);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  const end = monthOf(toMs);
  for (;;) {
    const key = `${y}-${String(m + 1).padStart(2, '0')}`;
    if (key > end) break;
    out.push(key);
    m++;
    if (m === 12) {
      m = 0;
      y++;
    }
  }
  return out;
}

/**
 * A person's reports, for the strip's *Reports* cell and its trend: how many they have up (kept),
 * how many a moderator took down (hidden or removed) and how many they edited — a report its author
 * deleted is neither kept nor hidden, so it is left out — and the same kept and hidden per month
 * (UTC, by the skate's end) over the last `months`. Months before the account existed are absent,
 * not zero. Read newest first, so the trend is whole unless the read stopped inside it; every figure
 * says `capped` when the read stopped short.
 */
export const reportTrend = query({
  args: { userId: v.id('profiles'), months: v.optional(v.number()), ...nowArg },
  handler: async (ctx, args) => {
    await requireCapability(ctx, 'people.read');
    const now = clock(args.now);
    const budget = queryBudget(ctx);
    const target = await budget.one('profile', () => ctx.db.get(args.userId));
    if (!target) return null;
    const asked =
      args.months !== undefined && Number.isFinite(args.months)
        ? Math.floor(args.months)
        : TREND_MONTHS;
    const span = Math.min(TREND_MONTHS_MAX, Math.max(1, asked));
    const nowDate = new Date(now);
    const windowStart = Math.max(
      Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - (span - 1), 1),
      Date.UTC(
        new Date(target.createdAt).getUTCFullYear(),
        new Date(target.createdAt).getUTCMonth(),
        1,
      ),
    );
    const page = await budget.capped(REPORTS_BYTES, REPORTS_ROWS, () =>
      ctx.db
        .query('reports')
        .withIndex('by_author_skate_end_time', (q) => q.eq('authorId', target._id))
        .order('desc')
        .paginate({
          cursor: null,
          numItems: REPORTS_ROWS,
          maximumRowsRead: REPORTS_ROWS,
          maximumBytesRead: REPORTS_BYTES,
        }),
    );
    const months = new Map(monthsBetween(windowStart, now).map((m) => [m, { kept: 0, hidden: 0 }]));
    let kept = 0;
    let hidden = 0;
    let edited = 0;
    for (const r of page.page) {
      if (r.authorDeletedAt !== undefined) continue;
      const down = r.moderationStatus !== 'visible';
      if (down) hidden++;
      else kept++;
      if (r.editedAt !== undefined) edited++;
      const bucket = months.get(monthOf(r.skateEndTime));
      if (bucket) {
        if (down) bucket.hidden++;
        else bucket.kept++;
      }
    }
    const last = page.page[page.page.length - 1];
    const capped = !page.isDone;
    const trendCapped = capped && last !== undefined && last.skateEndTime >= windowStart;
    return {
      total: { count: kept + hidden, capped },
      kept: { count: kept, capped },
      hidden: { count: hidden, capped },
      edited: { count: edited, capped },
      months: [...months.entries()].map(([month, m]) => ({ month, ...m })),
      monthsCapped: trendCapped,
    };
  },
});
