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
import { auditRowsOn } from './lib/auditReads';
import { hasCapability, requireCapability } from './lib/auth';
import { readVerdictCounts } from './lib/contentVerdicts';
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
  appealsFrom,
  countTimeLane,
  flaggedPeopleFrom,
  LANE_COUNT_CAP,
  laneRange,
  listablePeople,
  readOpenFlagQueue,
  readStoredCounts,
  readWaitingTickets,
} from './lib/peopleFigures';
import { OPEN_ENDED, personRowOf } from './lib/peopleRows';
import { trustClassFor } from './lib/reputation';
import { type UndoState, undoState } from './lib/undo';
import { canceledRows, standingUndoOf } from './lib/undoChains';

const MINUTE = 60_000;
const DAY_MS = 86_400_000;

/** The page's clock, held within a minute of the server's. */
const clock = (asked: number | undefined) => callerNow(asked, Date.now(), MINUTE);

const nowArg = { now: v.optional(v.number()) };

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
  const stored = await readStoredCounts(ctx);
  const queue = await readOpenFlagQueue(ctx);
  const flagged = flaggedPeopleFrom(queue.flags, queue.capped);
  const waiting = hasCapability(viewer, 'inbox.support.read')
    ? await readWaitingTickets(ctx)
    : null;
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
      const page = await ctx.db
        .query('peopleRows')
        .withSearchIndex('search_people', (s) => s.search('searchText', search))
        .paginate({ cursor, numItems: pageSize });
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
    const page = await range.paginate({ cursor, numItems: pageSize });
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
    const target = await ctx.db.get(userId);
    if (!target) return null;
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
      const [row] = await auditRowsOn(
        ctx,
        { targetType: 'user', targetId: userId, action: verb },
        1,
      );
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
      const userRows = await ctx.db
        .query('contentFlags')
        .withIndex('by_target_status_reason', (q) =>
          q.eq('targetType', 'user').eq('targetId', userId).eq('status', status),
        )
        .take(PERSON_FLAG_CAP + 1);
      userCapped ||= userRows.length > PERSON_FLAG_CAP;
      onUser.push(...userRows.slice(0, PERSON_FLAG_CAP));
      const subjectRows = await ctx.db
        .query('contentFlags')
        .withIndex('by_subject_status', (q) => q.eq('subjectUserId', userId).eq('status', status))
        .take(2 * PERSON_FLAG_CAP + 1);
      const content = subjectRows.filter((f) => f.targetType !== 'user');
      contentCapped ||=
        subjectRows.length > 2 * PERSON_FLAG_CAP || content.length > PERSON_FLAG_CAP;
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
      const tickets = await ctx.db
        .query('supportTickets')
        .withIndex('by_clerk_user_created', (q) => q.eq('clerkUserId', target.clerkUserId))
        .order('desc')
        .take(LANE_COUNT_CAP + 1);
      appealsCapped = tickets.length > LANE_COUNT_CAP;
      appeals = tickets
        .slice(0, LANE_COUNT_CAP)
        .filter((t) => t.category === 'account' && t.status !== 'resolved')
        .map((t) => ({ ticketId: t._id, status: t.status, createdAt: t.createdAt }))
        .reverse();
    }

    // ── Flags they filed (the Flagging lever's "N filed") ──
    // An automatic flag names the rater whose thumb crossed the line as its flagger, though they
    // filed nothing (`lib/autoFlag`): only a person's own (`origin: 'user'`) counts, and a read that
    // stopped short makes the count a floor.
    const flaggedBy = await ctx.db
      .query('contentFlags')
      .withIndex('by_flagger', (q) => q.eq('flaggerId', userId))
      .take(LANE_COUNT_CAP + 1);
    const flagsFiled: Count = {
      count: flaggedBy.slice(0, LANE_COUNT_CAP).filter((f) => f.origin === 'user').length,
      capped: flaggedBy.length > LANE_COUNT_CAP,
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
    const target = await ctx.db.get(userId);
    if (!target) return null;
    const n = clampLimit(limit);
    const stored = await readStoredCounts(ctx);
    const sources: Source[] = [];
    const sourceOf = <T>(items: T[], atOf: (item: T) => number, rows: Doc<'moderationActions'>[]) =>
      sources.push({
        rows,
        horizon: items.length > n ? atOf(items[n - 1] as T) : null,
      });

    // On the person.
    const onPerson = await auditRowsOn(ctx, { targetType: 'user', targetId: userId }, n + 1);
    sourceOf(onPerson, (r) => r.createdAt, onPerson.slice(0, n));

    // Verdicts on their content, as given, and as ended.
    for (const standing of [true, false]) {
      const given = await ctx.db
        .query('contentVerdicts')
        .withIndex('by_subject_standing', (q) =>
          q.eq('subjectUserId', userId).eq('standing', standing),
        )
        .order('desc')
        .take(n + 1);
      const rows = await Promise.all(given.slice(0, n).map((vd) => ctx.db.get(vd.actionId)));
      sourceOf(
        given,
        (vd) => vd.at,
        rows.filter((r): r is Doc<'moderationActions'> => r !== null),
      );
    }
    const ended = await ctx.db
      .query('contentVerdicts')
      .withIndex('by_subject_ended', (q) => q.eq('subjectUserId', userId).gt('endedAt', 0))
      .order('desc')
      .take(n + 1);
    const endings = await Promise.all(
      ended.slice(0, n).map((vd) => (vd.endedByActionId ? ctx.db.get(vd.endedByActionId) : null)),
    );
    sourceOf(
      ended,
      (vd) => vd.endedAt ?? 0,
      endings.filter((r): r is Doc<'moderationActions'> => r !== null),
    );

    // Decisions on flags about them or their content.
    for (const status of ['actioned', 'dismissed'] as const) {
      const flags = await ctx.db
        .query('contentFlags')
        .withIndex('by_subject_status', (q) => q.eq('subjectUserId', userId).eq('status', status))
        .order('desc')
        .take(n + 1);
      const rows: Doc<'moderationActions'>[] = [];
      for (const flag of flags.slice(0, n)) {
        const decided = await auditRowsOn(
          ctx,
          { targetType: 'contentFlag', targetId: flag._id },
          4,
        );
        rows.push(
          ...decided.filter((r) => r.action === 'resolve_flag' || r.action === 'dismiss_flag'),
        );
      }
      sourceOf(flags, (f) => f.resolvedAt ?? f.createdAt, rows);
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
      rows: await Promise.all(merged.rows.map((r) => toRow(ctx, viewer, r, actors))),
      // Flags older than the subject stamp aren't found by person until its backfill has run.
      capped: merged.capped || !stored.flagSubjectsReady,
      createdAt: target.createdAt,
    };
  },
});

/** Audit rows a decisions page scans at most, past the ones it returns. */
const DECISIONS_SCAN = 2_000;

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
    const page = await ctx.db
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
      });
    const actors: Actors = new Map();
    return {
      rows: await Promise.all(page.page.map((r) => toRow(ctx, viewer, r, actors))),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

// ── A staffer's figures ────────────────────────────────────────────────────────────────────────

/** The trend's weeks. */
const WEEKS = 9;
const WEEK_MS = 7 * DAY_MS;
/** Rows the weeks' read takes at most. */
const WEEKS_ROWS = 2_000;
/** A season's decisions read for *Overturned*, at most. */
const SEASON_ROWS = 300;

/** The verbs that decide something a person filed, for *Time to decide*. Tickets wait on an audit. */
const FILED_DECISIONS: ReadonlySet<string> = new Set([
  'resolve_flag',
  'dismiss_flag',
  'approve_request',
  'decline_request',
  'approve_waterbody',
  'reject_waterbody',
]);

/** The lower median of durations, `null` for none. */
export function lowerMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/** Whether someone other than `staffer` undid `row`. */
async function undoneByOther(
  ctx: QueryCtx,
  row: Doc<'moderationActions'>,
  staffer: Id<'profiles'>,
): Promise<boolean> {
  // The undo that stands (`lib/undoChains`): one undone again by a later undo doesn't count.
  const undo = await standingUndoOf(ctx, row);
  return undo !== null && undo.actorId !== undefined && undo.actorId !== staffer;
}

/**
 * Whether the verdict `row` recorded was reversed by someone else: their restore, overturn or undo —
 * and that reversal still stands (an undone restore put the verdict back).
 */
async function verdictReversedByOther(
  ctx: QueryCtx,
  row: Doc<'moderationActions'>,
  staffer: Id<'profiles'>,
): Promise<boolean> {
  const verdict = await ctx.db
    .query('contentVerdicts')
    .withIndex('by_action', (q) => q.eq('actionId', row._id))
    .first();
  if (!verdict || verdict.standing || verdict.endedByActionId === undefined) return false;
  const ending = await ctx.db.get(verdict.endedByActionId);
  if (!ending || ending.actorId === undefined || ending.actorId === staffer) return false;
  const reverses =
    ending.action === 'restore' ||
    ending.action === 'overturn_verdict' ||
    ending.undoesActionId !== undefined;
  return reverses && (await standingUndoOf(ctx, ending)) === null;
}

/** When the item a filed decision decided was filed: from the row, or (older rows) the flag or ask. */
async function filedAtOf(ctx: QueryCtx, row: Doc<'moderationActions'>): Promise<number | null> {
  const recorded = (row.metadata as { filedAt?: unknown } | undefined)?.filedAt;
  if (typeof recorded === 'number') return recorded;
  if (row.targetType === 'contentFlag') {
    const id = ctx.db.normalizeId('contentFlags', row.targetId);
    return id ? ((await ctx.db.get(id))?.createdAt ?? null) : null;
  }
  if (row.targetType === 'waterBodyRequest') {
    const id = ctx.db.normalizeId('waterBodyRequests', row.targetId);
    return id ? ((await ctx.db.get(id))?.createdAt ?? null) : null;
  }
  // A drawn body's decision from before the row recorded it: reading the body means its outline.
  return null;
}

/** Role rows read at most for *staff since*. */
const ROLE_ROWS = 50;

/** What a role row says: the role it gave and the one it replaced (absent on rows from before). */
function roleMove(row: Doc<'moderationActions'>): { to: UserRole; from: UserRole | undefined } {
  const m = (row.metadata ?? {}) as { role?: UserRole; priorRole?: UserRole };
  return { to: row.action === 'revoke_role' ? 'member' : (m.role ?? 'member'), from: m.priorRole };
}

/**
 * When a staffer became staff, and when they took the role they hold — each `null` (not recorded)
 * unless a row on record says so (the newest {@link ROLE_ROWS} grants are read: the newest entry is
 * among them whenever it is on record within them, and an older one never stands in for it):
 * - **staff since** is the grant that moved them *in* from member (`priorRole: 'member'`) after the
 *   latest revoke. A grant that moved them between moderator and admin is not an entry, and a grant
 *   with no `priorRole` (a row from before it was recorded) can't be told from one — so when the
 *   entering grant isn't on record, the answer is `null`, never a later move's date.
 * - **role since** is the newest role row, when the role it gave is the one they hold now; if the
 *   newest row gave another role, the move to the present role was never recorded: `null`.
 * - Undo chains read as `lib/undoChains` reads them: a change and the undo standing on it cancel out,
 *   and a change undone twice is back, with its own time.
 */
export function staffTenure(
  grants: readonly Doc<'moderationActions'>[],
  revokes: readonly Doc<'moderationActions'>[],
  role: UserRole,
): {
  staffSince: { at: number; role: UserRole } | null;
  roleSince: { at: number; role: UserRole } | null;
} {
  // A change and the undo that stands on it cancel out: neither is a move (a revoke undone a minute
  // later never ended their time on staff); undone twice, the change is back (`lib/undoChains`, the
  // one reading of undo chains). An undo whose undone row is older than the read stays a move.
  const all = [...grants, ...revokes];
  const canceled = canceledRows(all);
  const live = all.filter((r) => !canceled.has(r._id)).sort((x, y) => y.createdAt - x.createdAt);
  const lastRevoke = live.find((r) => r.action === 'revoke_role');
  const entry = live.find(
    (g) =>
      g.action === 'grant_role' &&
      (lastRevoke === undefined || g.createdAt > lastRevoke.createdAt) &&
      roleMove(g).from === 'member',
  );
  const newest = live[0];
  return {
    staffSince: entry === undefined ? null : { at: entry.createdAt, role: roleMove(entry).to },
    roleSince:
      newest !== undefined && roleMove(newest).to === role ? { at: newest.createdAt, role } : null,
  };
}

/**
 * A staffer's strip (the founder's definitions, 2026-11-14):
 * - **decisions** this week — the rows they made, minus their own skater actions, and how many
 *   someone else later undid;
 * - **timeToDecide** — the lower median, over this week's decisions on filed items (flags, requests,
 *   drawn bodies), of filed to decided; `null` when none, or when any one's filing time isn't known;
 * - **overturned** this season — their decisions someone else reversed (undid, restored or
 *   overturned the verdict); `null` while the season's record hasn't opened (1 July to 1 October, or
 *   a season not begun), with `season.opensOn` to say when it does;
 * - **staffSince** and **roleSince** — {@link staffTenure}: the grant that moved them in from member
 *   after the latest revoke, and the newest role row when it gave the role they hold; each `null`
 *   (not recorded) when no row on record says so, as for the first admin;
 * - **weeks** — decisions in each of the last nine weeks, oldest first.
 *
 * `null` for anyone who isn't staff. Moderators read it on an admin's page too: the audit feed
 * already shows them everything it counts.
 */
export const staffStats = query({
  args: { userId: v.id('profiles'), season: v.optional(v.number()), ...nowArg },
  handler: async (ctx, args) => {
    const viewer = await requireCapability(ctx, 'audit.read');
    const now = clock(args.now);
    const target = await ctx.db.get(args.userId);
    if (!target || ROLE_RANK[target.role] < ROLE_RANK.moderator) return null;
    const ledgerVisible = seesLedgerGrants(viewer);
    const staffer = target._id;

    // ── The last nine weeks, newest first, whole or marked short ──
    const today = lastDays(now, 1);
    const end = today.to;
    const from = end - WEEKS * WEEK_MS;
    const page = await ctx.db
      .query('moderationActions')
      .withIndex('by_actor', (q) => q.eq('actorId', staffer).gte('_creationTime', from - DAY_MS))
      .order('desc')
      .paginate({ cursor: null, numItems: WEEKS_ROWS, maximumRowsRead: WEEKS_ROWS });
    const rows = page.page.filter((r) => r.createdAt >= from && isDecision(r, ledgerVisible));
    const oldestRead =
      page.page.length > 0
        ? (page.page[page.page.length - 1] as Doc<'moderationActions'>).createdAt
        : end;
    const readAllAfter = (t: number) => page.isDone || oldestRead < t;
    const weeks = Array.from({ length: WEEKS }, (_, i) => {
      const start = end - (WEEKS - i) * WEEK_MS;
      const count = rows.filter(
        (r) => r.createdAt >= start && r.createdAt < start + WEEK_MS,
      ).length;
      return { from: start, count, capped: !readAllAfter(start) };
    });
    const thisWeek = weeks[WEEKS - 1] as { from: number; count: number; capped: boolean };
    const weekRows = rows.filter((r) => r.createdAt >= thisWeek.from);

    let undone = 0;
    for (const r of weekRows) if (await undoneByOther(ctx, r, staffer)) undone++;

    const durations: number[] = [];
    let unknown = 0;
    for (const r of weekRows.filter((x) => FILED_DECISIONS.has(x.action))) {
      const filedAt = await filedAtOf(ctx, r);
      if (filedAt === null) unknown++;
      else durations.push(Math.max(0, r.createdAt - filedAt));
    }

    // ── This season's reversals ──
    const season: Season =
      args.season !== undefined && Number.isInteger(args.season) ? args.season : seasonOf(now);
    const span = seasonRecordSpan(season, now);
    let overturned: Count | null = null;
    if (span !== null) {
      const seasonRows = await ctx.db
        .query('moderationActions')
        .withIndex('by_actor', (q) =>
          q
            .eq('actorId', staffer)
            .gte('_creationTime', span.from - DAY_MS)
            .lt('_creationTime', span.to + DAY_MS),
        )
        .order('desc')
        .take(SEASON_ROWS + 1);
      const decided = seasonRows
        .slice(0, SEASON_ROWS)
        .filter(
          (r) => r.createdAt >= span.from && r.createdAt < span.to && isDecision(r, ledgerVisible),
        );
      let count = 0;
      for (const r of decided) {
        if (
          (await undoneByOther(ctx, r, staffer)) ||
          (await verdictReversedByOther(ctx, r, staffer))
        )
          count++;
      }
      overturned = { count, capped: seasonRows.length > SEASON_ROWS };
    }

    // ── Staff since and role since, from the role rows ──
    const grants = await auditRowsOn(
      ctx,
      { targetType: 'user', targetId: staffer, action: 'grant_role' },
      ROLE_ROWS,
    );
    const revokes = await auditRowsOn(
      ctx,
      { targetType: 'user', targetId: staffer, action: 'revoke_role' },
      ROLE_ROWS,
    );
    const { staffSince, roleSince } = staffTenure(grants, revokes, target.role);

    return {
      decisions: {
        thisWeek: { count: thisWeek.count, capped: thisWeek.capped },
        undoneByOthers: { count: undone, capped: thisWeek.capped },
      },
      timeToDecide: {
        medianMs: unknown > 0 || thisWeek.capped ? null : lowerMedian(durations),
        decided: durations.length + unknown,
        capped: thisWeek.capped,
      },
      overturned,
      season: { season, opensOn: seasonRecordWindow(season, now).opensOn, empty: span === null },
      staffSince,
      roleSince,
      weeks,
    };
  },
});

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
    const target = await ctx.db.get(args.userId);
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
    const page = await ctx.db
      .query('reports')
      .withIndex('by_author_skate_end_time', (q) => q.eq('authorId', target._id))
      .order('desc')
      .paginate({
        cursor: null,
        numItems: REPORTS_ROWS,
        maximumRowsRead: REPORTS_ROWS,
        maximumBytesRead: REPORTS_BYTES,
      });
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
