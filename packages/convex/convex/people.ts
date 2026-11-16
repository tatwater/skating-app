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
  type PeopleLane,
  peopleLanesFor,
  type Restriction,
  ROLE_RANK,
  resolveSeason,
  restrictionsOf,
  type Season,
  seasonOf,
  seasonRecordSpan,
  seasonRecordWindow,
  seasonStartMs,
  signInRetentionFromMs,
  type TrustClass,
  type UserRole,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id, TableNames } from './_generated/dataModel';
import { type QueryCtx, query } from './_generated/server';
import { GATE_EVENT_RETENTION_DAYS } from './analyticsRollup';
import { auditTargetLabel } from './lib/auditReads';
import { hasCapability, isSuspendedNow, requireCapability } from './lib/auth';
import { readVerdictCounts, VERDICT_COUNT_CAP } from './lib/contentVerdicts';
import {
  isLastLedgerEditor,
  isLedgerEditor,
  seesLedgerGrants,
  withoutLedgerGrantsFor,
} from './lib/ledgerEditors';
import { flagBodyId, OPEN_FLAG_STATUSES } from './lib/openFlags';
import {
  no,
  type PersonWrite,
  refusalFor,
  viewerCan,
  writeRefusal,
  writeTakesAway,
  yes,
} from './lib/peopleCan';
import {
  APPEALS_CAP,
  appealsFrom,
  flaggedPeopleFrom,
  laneCounter,
  laneRange,
  listablePeople,
  readOpenFlagQueue,
  readStoredCounts,
  readWaitingAppeals,
} from './lib/peopleFigures';
import { OPEN_ENDED, type PeopleBackfill, personRowOf, readPreparation } from './lib/peopleRows';
import {
  CHARGED_QUERY_BUDGET,
  DOC_MAX,
  type ReadBudget,
  type RowKind,
  requestBudget,
} from './lib/readBudget';
import { profileAccess } from './lib/reportVisibility';
import { trustClassFor } from './lib/reputation';
import { readTenure, rootReader, tenureCappedOf } from './lib/staffTenure';
import { startOfCurrentState } from './lib/stateSince';
import { type UndoState, undoState } from './lib/undo';
import { stands, undoneBy } from './lib/undoChains';
import { SUPPRESSION_ROWS_READ } from './putIns';

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

/**
 * The request's one budget (`requestBudget`), shared with every helper the query calls: opened at the
 * transaction's, less the caller's own profile (`requireCapability`). Every handler here calls this
 * (directly or through {@link readUpstream}) before any helper charges the request.
 */
const queryBudget = (ctx: QueryCtx) => requestBudget(ctx, CHARGED_QUERY_BUDGET);

// ── Lanes ──────────────────────────────────────────────────────────────────────────────────────

/**
 * A person's id as the page passes it, normalized once at the edge: a well-formed id of another table,
 * or anything else, is `null` — no such person — rather than a validator error the page can only show
 * as "couldn't be read".
 */
function profileIdOf(ctx: QueryCtx, raw: string): Id<'profiles'> | null {
  return ctx.db.normalizeId('profiles', raw.trim());
}

/** The backfills' state (`lib/peopleRows.readPreparation`, the one reading), its rows charged ahead. */
function preparationOf(budget: ReadBudget, ctx: QueryCtx) {
  budget.reserve('small', 4);
  return readPreparation(ctx);
}

/** The lanes a viewer gets: every lane but Appeals open, which needs support's PII read (D37). */
function lanesFor(viewer: Doc<'profiles'>): PeopleLane[] {
  return peopleLanesFor(hasCapability(viewer, 'inbox.support.read'));
}

/**
 * Why a lane's count or list may be short — each the cap of one read it depends on, so the page can
 * word it (a backfill not yet finished is not a cap: it's the read's `pending`):
 * - `rows_missing` — a queue lane named someone who has no row yet, so the list left them out;
 * - `flags_capped` — the open flag queue was read to its cap (Flagged, and every row's open flags);
 * - `tickets_capped` — a waiting support status was read to its cap (Appeals open, and every row's
 *   appeals);
 * - `count_capped` — a time-bound lane's count stopped at its cap (its list pages on).
 */
export type PartialReason = 'rows_missing' | 'flags_capped' | 'tickets_capped' | 'count_capped';

/** Every upstream read a People lane can depend on, read once for a request. */
async function readUpstream(ctx: QueryCtx, viewer: Doc<'profiles'>) {
  // The shared helpers' reads, charged ahead to the request's budget: the counts, each open-flag
  // status and each waiting-ticket status read one past their cap.
  const budget = queryBudget(ctx);
  budget.reserve('small', 64 + 4);
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
      flags_capped: queue.capped,
      tickets_capped: waiting?.capped === true,
    },
    /** The backfills not yet finished — a flag read without its subject counts as one. */
    pending: new Set<PeopleBackfill>([
      ...stored.pending,
      ...(flagged.unknown ? (['flagSubjects'] as const) : []),
    ]),
  };
}
type Upstream = Awaited<ReturnType<typeof readUpstream>>;

/** The reasons from `keys` whose read had a gap. */
function reasonsOf(up: Upstream, keys: readonly (keyof Upstream['gaps'])[]): PartialReason[] {
  return keys.filter((k) => up.gaps[k]);
}

/** The capped reads each lane's own membership depends on (its count and its list alike). */
const LANE_DEPENDS: Record<PeopleLane, readonly (keyof Upstream['gaps'])[]> = {
  everyone: [],
  staff: [],
  suspended: [],
  banned: [],
  restricted: [],
  flagged: ['flags_capped'],
  appeals: ['tickets_capped'],
  newest: [],
  leaving: [],
  deleted: [],
};

/** The backfills each lane's membership rests on: every lane reads the rows; Flagged, the subjects. */
function lanePending(lane: PeopleLane | null): readonly PeopleBackfill[] {
  return lane === 'flagged' ? ['rows', 'flagSubjects'] : ['rows'];
}

/** The backfills among `deps` not yet finished, in the registry's order. */
function pendingOf(up: Upstream, deps: readonly PeopleBackfill[]): PeopleBackfill[] {
  return (['rows', 'flagSubjects', 'undoChains'] as const).filter(
    (b) => deps.includes(b) && up.pending.has(b),
  );
}

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
    const counts = laneCounter(ctx, now, up.stored, up.flagged.people, up.appeals?.people ?? null);
    const out: Array<{
      lane: PeopleLane;
      count: Count;
      reasons: PartialReason[];
      pending: PeopleBackfill[];
    }> = [];
    for (const lane of lanesFor(viewer)) {
      const { count, over, missing } = await counts(lane);
      const reasons: PartialReason[] = [
        ...reasonsOf(up, LANE_DEPENDS[lane]),
        ...(missing ? (['rows_missing'] as const) : []),
        ...(over ? (['count_capped'] as const) : []),
      ];
      out.push({
        lane,
        count: { count, capped: reasons.length > 0 },
        reasons,
        pending: pendingOf(up, lanePending(lane)),
      });
    }
    return { lanes: out, pending: pendingOf(up, ['rows', 'flagSubjects']) };
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
   * name `flags_capped`, or its `pending` names `flagSubjects`.
   */
  openFlags: { onUser: number; onContent: number };
  /** Appeals still waiting — admins only (`null` for a viewer without support). */
  appeals: number | null;
  /**
   * On the Flagged and Appeals lanes, when their oldest open flag or oldest waiting ticket was filed —
   * the very key those lanes sort by, so the order and the age are one rule. `null` on other lanes.
   */
  oldestOpenAt: number | null;
  /**
   * On the Staff lane (`null` elsewhere): when they were last seen in the console (the presence row,
   * kept one per staffer and shown only within the current season and the one before — the sign-in
   * record's own retention, D254; `null` when not recorded, `lastSeenCapped` when the presence read
   * stopped before it could say); when they took the role they hold (the tenure `people.staffStats`
   * reads, stamped on the row; `null` when not recorded, `roleSinceCapped` when its read stopped
   * short, and the page's `pending` names `undoChains` while it can't be told yet); and their
   * decisions this week, as `staffStats` counts them.
   */
  staff: {
    lastSeenInConsoleAt: number | null;
    lastSeenCapped: boolean;
    roleSince: number | null;
    roleSinceCapped: boolean;
    decisionsThisWeek: Count;
  } | null;
}

function toListRow(
  row: Doc<'peopleRows'>,
  now: number,
  flags: Map<string, { onUser: number; onContent: number }>,
  appeals: Map<string, number> | null,
  oldest: Map<string, number> | null = null,
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
    oldestOpenAt: oldest?.get(row.userId) ?? null,
    staff: null,
  };
}

/** Presence rows read at most for a Staff page: one per staffer, so the staff lane's whole size. */
const PRESENCE_ROWS = 500;
/**
 * A week of audit rows read at most for the Staff lane's decision counts, and their real weight. One
 * document's worth: a support viewer's queues are charged ahead (`readUpstream`) and leave about
 * three, and the capped read is charged its cap and a document past it.
 */
const STAFF_WEEK_ROWS = 2_000;
const STAFF_WEEK_BYTES = DOC_MAX;

/**
 * The Staff lane's own columns for a page of staff rows: two reads for the whole page (presence, and
 * the week's audit rows), never one a row.
 */
async function withStaffColumns(
  ctx: QueryCtx,
  budget: ReadBudget,
  viewer: Doc<'profiles'>,
  now: number,
  rows: PersonListRow[],
  stored: Map<string, Doc<'peopleRows'>>,
): Promise<PersonListRow[]> {
  if (rows.length === 0) return rows;
  // Only the rows the lane may show (within the sign-in record's retention), newest first: an older
  // row — a former staffer's, say — is never read, so it can't crowd a current one past the cap.
  const keepFrom = signInRetentionFromMs(now);
  const presence = await takeCapped(budget, 'presence', PRESENCE_ROWS, (n) =>
    ctx.db
      .query('consolePresence')
      .withIndex('by_seen_at', (q) => q.gte('seenAt', keepFrom))
      .order('desc')
      .take(n),
  );
  const seen = new Map(presence.rows.map((p) => [p.userId as string, p.seenAt]));
  const week = thisWeekOf(now);
  const ledgerVisible = seesLedgerGrants(viewer);
  // The week's rows only while the request can still afford them whole — the cap and the document
  // past it that `capped` charges; otherwise every count is a floor of zero, said as capped — never
  // a number shown as whole.
  const page =
    budget.affords(STAFF_WEEK_BYTES + DOC_MAX) && budget.affordsCalls(1, STAFF_WEEK_ROWS)
      ? await budget.capped(STAFF_WEEK_BYTES, STAFF_WEEK_ROWS, () =>
          ctx.db
            .query('moderationActions')
            .withIndex('by_created_at', (q) =>
              q.gte('createdAt', week.from).lt('createdAt', week.to),
            )
            .paginate({
              cursor: null,
              numItems: STAFF_WEEK_ROWS,
              maximumRowsRead: STAFF_WEEK_ROWS,
              maximumBytesRead: STAFF_WEEK_BYTES,
            }),
        )
      : { page: [] as Doc<'moderationActions'>[], isDone: false };
  const decided = new Map<string, number>();
  for (const r of page.page) {
    if (!isDecision(r, ledgerVisible)) continue;
    decided.set(r.actorId as string, (decided.get(r.actorId as string) ?? 0) + 1);
  }
  return rows.map((row) => {
    const light = stored.get(row.userId);
    return {
      ...row,
      staff: {
        // Not found: not recorded — unless the read stopped at its cap, when it can't say.
        lastSeenInConsoleAt: seen.get(row.userId) ?? null,
        lastSeenCapped: presence.capped && !seen.has(row.userId),
        // A staffer whose row was never stamped (before the procedure's step 6, or a stamp that
        // failed) can't say yet: capped, never "not recorded" while the strip has a date.
        roleSince:
          light?.tenureCapped || light?.tenureAt === undefined ? null : (light?.roleSince ?? null),
        roleSinceCapped: light?.tenureCapped === true || light?.tenureAt === undefined,
        decisionsThisWeek: { count: decided.get(row.userId) ?? 0, capped: !page.isDone },
      },
    };
  });
}

/** This week, as the staff strip counts it: the seven days to the end of today. */
function thisWeekOf(now: number): { from: number; to: number } {
  const to = lastDays(now, 1).to;
  return { from: to - WEEK_MS, to };
}

/**
 * A lane read whole (≤ a few hundred light rows) and paged by key: a row's place is a tuple of its
 * lane's order — a queue lane's oldest open item and id, the Staff lane's rank, name and id — written
 * as JSON, so a person who leaves or joins an earlier page moves nothing on a later one, and a page
 * given an `endCursor` reads exactly `(cursor, endCursor]`. A cursor from before (a bare offset) is
 * still read as one.
 */
type LaneKey = readonly (number | string)[];

function compareKeys(a: LaneKey, b: LaneKey): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? '';
    const y = b[i] ?? '';
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function parseKey(cursor: string): LaneKey | null {
  try {
    const key = JSON.parse(cursor);
    return Array.isArray(key) ? key : null;
  } catch {
    return null;
  }
}

function sliceByKey<T>(
  rows: readonly T[],
  keyOf: (row: T) => LaneKey,
  cursor: string | null,
  endCursor: string | null,
  pageSize: number,
): {
  slice: T[];
  isDone: boolean;
  continueCursor: string;
  splitCursor?: string;
  pageStatus?: 'SplitRequired';
} {
  // In the key's own order, whatever order the rows were read in (an index breaks a tie by creation
  // time, the key by id): a page cut by position and the next found by key must agree, or a tie
  // straddling the cut is skipped or repeated.
  const ordered = [...rows].sort((a, b) => compareKeys(keyOf(a), keyOf(b)));
  const from = cursor === null ? null : parseKey(cursor);
  const legacy = cursor !== null && /^\d+$/.test(cursor);
  const after = legacy
    ? ordered.slice(Number(cursor))
    : ordered.filter((r) => from === null || compareKeys(keyOf(r), from) > 0);
  const to = endCursor === null ? null : parseKey(endCursor);
  const bounded = to !== null ? after.filter((r) => compareKeys(keyOf(r), to) <= 0) : null;
  // A bounded page that grew past the cap returns the cap and where to split it — Convex's own
  // `SplitRequired` — so the client reads `(cursor, splitCursor]` and `(splitCursor, endCursor]`.
  const split = bounded !== null && bounded.length > END_ROWS;
  const slice = bounded === null ? after.slice(0, pageSize) : bounded.slice(0, END_ROWS);
  const last = slice[slice.length - 1];
  if (split && last !== undefined) {
    return {
      slice,
      isDone: false,
      continueCursor: endCursor as string,
      splitCursor: JSON.stringify(keyOf(last)),
      pageStatus: 'SplitRequired',
    };
  }
  return {
    slice,
    isDone: slice.length === after.length,
    // A page bounded by its end keeps that end, as Convex's own pagination does, so the next page —
    // asked from it — still starts where this one stops even when its last row has left.
    continueCursor:
      to !== null
        ? (endCursor as string)
        : last === undefined
          ? (cursor ?? '')
          : JSON.stringify(keyOf(last)),
  };
}

/** Staff read whole for their lane, at most: admins and moderators are a few dozen, not thousands. */
const STAFF_LANE_ROWS = 500;

/**
 * Rows a page given an `endCursor` reads at most: the page it was, grown by whatever was inserted
 * into its range since — past that it returns `pageStatus: 'SplitRequired'` and a `splitCursor`, as
 * Convex's own pagination does, and the client splits it.
 */
const END_ROWS = 200;

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
    /**
     * Where the page ended when it was first read (its `continueCursor`): the page then reads exactly
     * `(cursor, endCursor]`, so a change to an earlier page never drops or repeats a row on a later
     * one — Convex's own reactive pagination.
     */
    endCursor: v.optional(v.union(v.string(), v.null())),
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
    const endCursor = args.endCursor ?? null;
    const budget = queryBudget(ctx);
    // A page bounded by its end reads up to `END_ROWS` and says when it must be split.
    const paged = (n: number) =>
      endCursor === null
        ? { cursor, numItems: n }
        : { cursor, numItems: n, endCursor, maximumRowsRead: n };
    const size = endCursor === null ? pageSize : END_ROWS;
    const tail = (page: { splitCursor?: string | null; pageStatus?: string | null }) => ({
      ...(page.splitCursor ? { splitCursor: page.splitCursor } : {}),
      ...(page.pageStatus ? { pageStatus: page.pageStatus } : {}),
    });
    // A bounded page holds at most `END_ROWS`, whatever the index returned (a search index does not
    // hold `maximumRowsRead`): past it, the rows over the cap are dropped and the page says
    // `SplitRequired` — with Convex's own `splitCursor` where it gave one; a search gives none, so the
    // client reads that range again unbounded. Rows the index did return were read, and are charged.
    const capped = <P extends { page: Doc<'peopleRows'>[]; splitCursor?: string | null }>(
      page: P,
    ): P => {
      if (endCursor === null || page.page.length <= END_ROWS) return page;
      return {
        ...page,
        page: page.page.slice(0, END_ROWS),
        isDone: false,
        pageStatus: 'SplitRequired',
      };
    };
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
    const own = search !== null ? [] : LANE_DEPENDS[lane];
    // Every row's open flags rest on the subjects as well as the lane's own reads.
    const pending = pendingOf(up, ['rows', 'flagSubjects']);
    const truth = (missing: boolean) => {
      const reasons = [
        ...new Set<PartialReason>([
          ...reasonsOf(up, own),
          ...reasonsOf(up, ['flags_capped', 'tickets_capped']),
          ...(missing ? (['rows_missing'] as const) : []),
        ]),
      ];
      return { partial: reasons.length > 0, reasons, pending };
    };

    if (search !== null) {
      const read = await budget.page('personRow', size, (n) =>
        ctx.db
          .query('peopleRows')
          .withSearchIndex('search_people', (s) => s.search('searchText', search))
          .paginate(paged(n)),
      );
      const page = capped(read);
      return {
        rows: shape(page.page),
        isDone: page.isDone,
        continueCursor: page.continueCursor,
        ...tail(page),
        ...truth(false),
      };
    }

    if (lane === 'flagged' || lane === 'appeals') {
      const queue = lane === 'flagged' ? flagged.people : (appeals?.people ?? []);
      const oldest = new Map(queue.map((p) => [p.userId as string, p.oldestAt]));
      // The whole lane's rows (≤ 200 light reads), so a person missing on any page is said on every
      // page, as the lane's count says it; the page is a slice of the people the list can show.
      const { rows, missing } = await listablePeople(
        ctx,
        queue.map((p) => p.userId),
      );
      // The lane's own order: their oldest open item, then id.
      const { slice, isDone, continueCursor, ...splitting } = sliceByKey(
        rows,
        (r) => [oldest.get(r.userId) ?? 0, r.userId],
        cursor,
        endCursor,
        pageSize,
      );
      return {
        rows: slice.map((r) => toListRow(r, now, flagsBy, appealsBy, oldest)),
        isDone,
        continueCursor,
        ...splitting,
        ...truth(missing),
      };
    }

    if (lane === 'staff') {
      // Read whole (a function gets one `paginate`, which the week's decisions below need), and
      // paged by its own order: admins first, then moderators, each by name.
      const read = await takeCapped(budget, 'personRow', STAFF_LANE_ROWS, (n) =>
        storedRange(ctx, 'staff').take(n),
      );
      const { slice, isDone, continueCursor, ...splitting } = sliceByKey(
        read.rows,
        (r) => [r.staffRank, r.nameKey, r.userId],
        cursor,
        endCursor,
        pageSize,
      );
      const truthful = truth(false);
      return {
        rows: await withStaffColumns(
          ctx,
          budget,
          viewer,
          now,
          slice.map((r) => toListRow(r, now, flagsBy, appealsBy)),
          new Map(slice.map((r) => [r.userId as string, r])),
        ),
        // The end of what was read: past the cap the page says `count_capped` rather than ask for
        // more pages that could only come back empty.
        isDone,
        continueCursor,
        ...splitting,
        ...truthful,
        // Role since rests on the undo chains too: until they are placed it can't be told (`null`,
        // not capped), as the strip says it.
        pending: pendingOf(up, ['rows', 'flagSubjects', 'undoChains']),
        ...(read.capped
          ? { partial: true, reasons: [...truthful.reasons, 'count_capped' as const] }
          : {}),
      };
    }

    const range =
      lane === 'suspended' || lane === 'newest'
        ? laneRange(ctx, lane, now)
        : storedRange(ctx, lane);
    const page = capped(await budget.page('personRow', size, (n) => range.paginate(paged(n))));
    return {
      rows: shape(page.page),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      ...tail(page),
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
  /**
   * The flagged thing's label, by the audit feed's rule (`auditTargetLabel`): a person's name, or the
   * body a body, report, Post, hazard or alert is about ("on his Mascoma report"). Absent when there is
   * none, or past `open.flagLabelsCapped`.
   */
  targetLabel?: string;
}

/** A person's bounty asks read for the season line, at most (one past it to tell). */
const SEASON_ASKS = 500;

async function bountySeasonOf(
  ctx: QueryCtx,
  budget: ReadBudget,
  userId: Id<'profiles'>,
  now: number,
): Promise<{ since: number; asks: Count; overLimit: Count; hadRecentReport: Count } | null> {
  const since = seasonStartMs(seasonOf(now));
  if (since < now - GATE_EVENT_RETENTION_DAYS * DAY_MS) return null;
  // Past the request's budget: a floor of zero, said as capped — never "not recorded", never whole.
  const read = !budget.affordsRead('gateEvent', SEASON_ASKS + 1)
    ? { rows: [] as Doc<'bountyGateEvents'>[], capped: true }
    : await takeCapped(budget, 'gateEvent', SEASON_ASKS, (n) =>
        ctx.db
          .query('bountyGateEvents')
          .withIndex('by_requester_created', (q) =>
            q.eq('requesterId', userId).gte('createdAt', since),
          )
          .take(n),
      );
  const count = (keep: (d: Doc<'bountyGateEvents'>['decision']) => boolean): Count => ({
    count: read.rows.filter((e) => keep(e.decision)).length,
    capped: read.capped,
  });
  return {
    since,
    asks: count(() => true),
    overLimit: count((d) => d === 'capped'),
    hadRecentReport: count((d) => d === 'suppressed'),
  };
}

/**
 * A status verb's rows a status note walks back at most, looking for the write that began it, and
 * their real weight at most (as the rights read is held to one document's worth).
 */
const STATUS_ROWS = 10;
const STATUS_ROWS_BYTES = DOC_MAX;

/**
 * The status a ban or suspension row found, as a status note's start weighs it (`lib/stateSince`):
 * a suspension whose window had run out by the write was over — it lapses at read time (the gate's
 * own rule, `isSuspendedNow`), and the sweep may not have reset the stored status yet — so a
 * suspension after it begins a new one.
 */
function statusFound(row: Doc<'moderationActions'>): string | undefined {
  const prev = (
    row.metadata as { prev?: { status?: string; suspendedUntil?: number | null } } | undefined
  )?.prev;
  if (
    prev?.status === 'suspended' &&
    !isSuspendedNow(
      { status: 'suspended', suspendedUntil: prev.suspendedUntil ?? undefined },
      row.createdAt,
    )
  ) {
    return 'lapsed';
  }
  return prev?.status;
}

/** A person's posting-right rows read at most, newest first, and their real weight at most. */
const RIGHT_ROWS = 50;
const RIGHT_ROWS_BYTES = DOC_MAX;

/** The person's rights, as `set_posting_permission` names them, and the profile field of each. */
const RIGHT_FIELDS = {
  reports: 'canPostReports',
  hazards: 'canPostHazards',
  comments: 'canPostComments',
  flagging: 'canFlag',
} as const;
type Right = keyof typeof RIGHT_FIELDS;

/**
 * When each right now off was taken away — the start of the restriction, a repeat that changed nothing
 * passed over (`startOfCurrentState`) — from one capped read of the person's right rows.
 */
async function rightsSinceOf(
  ctx: QueryCtx,
  budget: ReadBudget,
  target: Doc<'profiles'>,
): Promise<{ since: Record<Right, number | null>; capped: boolean }> {
  const since: Record<Right, number | null> = {
    reports: null,
    hazards: null,
    comments: null,
    flagging: null,
  };
  // Off as the page's `rights` says it: staff can always flag (D222), so their flagging is never off.
  const staff = ROLE_RANK[target.role] >= ROLE_RANK.moderator;
  const off = (Object.keys(RIGHT_FIELDS) as Right[]).filter(
    (r) => target[RIGHT_FIELDS[r]] === false && !(r === 'flagging' && staff),
  );
  if (off.length === 0) return { since, capped: false };
  // `capped` charges its cap and a document past it: asked for both, or the read would throw.
  if (!budget.affords(RIGHT_ROWS_BYTES + DOC_MAX) || !budget.affordsCalls(1, RIGHT_ROWS)) {
    return { since, capped: true };
  }
  const page = await budget.capped(RIGHT_ROWS_BYTES, RIGHT_ROWS, () =>
    ctx.db
      .query('moderationActions')
      .withIndex('by_target_action', (q) =>
        q
          .eq('targetType', 'user')
          .eq('targetId', target._id)
          .eq('action', 'set_posting_permission'),
      )
      .order('desc')
      .paginate({
        cursor: null,
        numItems: RIGHT_ROWS,
        maximumRowsRead: RIGHT_ROWS,
        maximumBytesRead: RIGHT_ROWS_BYTES,
      }),
  );
  // Each right's off-run began at its newest real change (`lib/stateSince`): a moderator restricting a
  // right already off changed nothing, and doesn't move the date.
  let capped = false;
  for (const right of off) {
    const start = startOfCurrentState(
      page.page,
      (row) => {
        const m = (row.metadata ?? {}) as {
          permission?: string;
          allowed?: boolean;
          prev?: { allowed?: boolean };
        };
        return {
          at: row.createdAt,
          after: m.permission === right ? m.allowed : undefined,
          before: m.prev?.allowed,
        };
      },
      false,
      page.isDone,
    );
    since[right] = start.since;
    capped ||= start.capped;
  }
  return { since, capped };
}

/**
 * When a holder's ledger grant was given: the newest `grant_ledger_editor` row on them. `capped` when
 * the request's budget couldn't afford the read — `null` then is "can't say", not "not recorded".
 */
async function ledgerSinceOf(
  ctx: QueryCtx,
  budget: ReadBudget,
  userId: Id<'profiles'>,
): Promise<{ at: number | null; capped: boolean }> {
  const row = await budget.measured('moderationAction', () =>
    ctx.db
      .query('moderationActions')
      .withIndex('by_target_action', (q) =>
        q.eq('targetType', 'user').eq('targetId', userId).eq('action', 'grant_ledger_editor'),
      )
      .order('desc')
      .first(),
  );
  return { at: row?.createdAt ?? null, capped: row === undefined };
}

/** Distinct flagged things the person page names, at most. */
const FLAG_LABELS = 20;

/** A read on the way to a flag's body the request's budget couldn't afford: the label is capped. */
class LabelUnaffordable extends Error {}

/**
 * Label each open flag's target, at most {@link FLAG_LABELS} distinct ones, through the request's
 * budget: a flag on the person by their own name; anything else by the body it is about — the Inbox's
 * own rule (`lib/openFlags.flagBodyId`: a report, Post, comment, photo, hazard or alert, through the
 * report it hangs on), each read as it really weighs. A body's name is read once however many of
 * its items are flagged. Returns whether any went unlabeled for the cap or the budget.
 */
async function labelFlags(
  ctx: QueryCtx,
  budget: ReadBudget,
  person: Doc<'profiles'>,
  flags: OpenFlag[],
): Promise<boolean> {
  const bodyNames = new Map<string, string | null>();
  const personName = person.displayName.trim() || person.username;
  // Each read on the way to the body: started only while a whole document fits, charged its weight.
  const get = async <T extends TableNames>(id: Id<T>): Promise<Doc<T> | null> => {
    const doc = await budget.measured('report', () => ctx.db.get(id));
    if (doc === undefined) throw new LabelUnaffordable();
    return doc;
  };
  const labelOf = async (flag: OpenFlag): Promise<string | null | undefined> => {
    let bodyId: Id<'waterBodies'> | null;
    try {
      bodyId = await flagBodyId(ctx, flag, get);
    } catch (err) {
      if (err instanceof LabelUnaffordable) return undefined;
      throw err;
    }
    if (bodyId === null) return null;
    // Each lake read once, whichever flags name it.
    const known = bodyNames.get(bodyId);
    if (known !== undefined) return known;
    // A body's library row, whose name no writer caps.
    if (!budget.affordsRead('bodyLibraryRow') || !budget.affordsCalls(1, 1)) return undefined;
    budget.reserve('bodyLibraryRow', 1);
    const name = await auditTargetLabel(ctx, 'waterbody', bodyId);
    bodyNames.set(bodyId, name);
    return name;
  };
  // The distinct things flagged, at most `FLAG_LABELS`, labelled one after another (at once follows
  // with the shared reservation, B01-3i).
  const byKey = new Map<string, OpenFlag>();
  for (const flag of flags) {
    const key = `${flag.targetType}:${flag.targetId}`;
    if (!byKey.has(key) && byKey.size < FLAG_LABELS) byKey.set(key, flag);
  }
  // A flag on the person is labelled by their own name, which needs no read: labelled whatever the
  // budget, never left behind a body the reads below stopped short of.
  const labels = new Map<string, string | null>();
  const toRead: string[] = [];
  for (const [key, flag] of byKey) {
    if (flag.targetType === 'user' && flag.targetId === person._id) labels.set(key, personName);
    else toRead.push(key);
  }
  let capped = false;
  for (const key of toRead) {
    const label = await labelOf(byKey.get(key) as OpenFlag);
    // Past the budget: this one unlabelled (and said so); later ones may still fit.
    if (label === undefined) {
      capped = true;
      continue;
    }
    labels.set(key, label);
  }
  for (const flag of flags) {
    const key = `${flag.targetType}:${flag.targetId}`;
    if (!labels.has(key)) {
      capped = true;
      continue;
    }
    const label = labels.get(key);
    if (label) flag.targetLabel = label;
  }
  return capped;
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
  args: { userId: v.string(), ...nowArg },
  handler: async (ctx, { userId: raw, now: asked }) => {
    const viewer = await requireCapability(ctx, 'people.read');
    const userId = profileIdOf(ctx, raw);
    if (userId === null) return null;
    const now = clock(asked);
    const budget = queryBudget(ctx);
    const target = await budget.one('profile', () => ctx.db.get(userId));
    if (!target) return null;
    // The counts and the backfills' state, twice over (here and in the ledger check).
    budget.reserve('small', 64 + 8);
    // The helpers' reads are reserved before the page's own: each `takeCapped` below sizes itself by
    // what is left, so a reserve after them could find a heavily flagged person's reads had spent it,
    // and throw. The ledger check reads admins' People rows once for every lever, and only for a
    // holder (`lib/ledgerEditors`, behind `isLastLedgerEditor`).
    if (isLedgerEditor(target)) budget.reserve('personRow', 200);
    budget.reserve('verdict', VERDICT_COUNT_CAP + 1);
    const stored = await readStoredCounts(ctx);
    // The status note's setter, named from their row.
    budget.reserve('personRow', 1);

    // ── Whether this viewer can open the public profile: the profile read's own rule ──
    // Every fixed read comes before the first read that sizes itself by what is left (the flags,
    // tickets and filed flags below, then the labels): a heavily flagged person spends the budget
    // on those, never on these, and the page returns capped figures rather than throwing.
    // Its block check: one point read each way (`blockedEitherWay`).
    budget.reserve('small', 1);
    budget.reserve('small', 1);
    const publicAccess = await profileAccess(ctx, target, viewer);

    // ── When a holder's grant was given (holders only), while the budget is whole ──
    const ledgerVisible = target.role === 'admin' && seesLedgerGrants(viewer);
    const ledgerSince =
      ledgerVisible && isLedgerEditor(target)
        ? await ledgerSinceOf(ctx, budget, userId)
        : { at: null, capped: false };

    // ── The status note: when the suspension or ban began, and who last set it ──
    let statusNote: {
      action: 'ban' | 'suspend';
      at: number | null;
      atCapped: boolean;
      by: PersonRef | null;
      via: string | null;
      reason: string | null;
      suspendedUntil: number | null;
      lapsed: boolean;
    } | null = null;
    if (target.status === 'suspended' || target.status === 'banned') {
      const verb = target.status === 'banned' ? 'ban' : 'suspend';
      // When the status began (`lib/stateSince`): a ban of a banned account, or a
      // suspension's new window, changed nothing about the status, so the walk passes over it to the
      // write that did. A few rows of the verb, newest first, each read as it weighs — a suspension
      // that had run out before the next one is no run of it (`statusFound`).
      const seen: Doc<'moderationActions'>[] = [];
      let complete = false;
      let before = Number.POSITIVE_INFINITY;
      const walkFrom = budget.bytes;
      for (let i = 0; i < STATUS_ROWS; i++) {
        // Held to its weight too: past it, the start is "can't say", never the budget's last bytes.
        if (walkFrom - budget.bytes >= STATUS_ROWS_BYTES) break;
        const next = await budget.measured('moderationAction', () =>
          ctx.db
            .query('moderationActions')
            .withIndex('by_target_action', (q) =>
              q
                .eq('targetType', 'user')
                .eq('targetId', userId)
                .eq('action', verb)
                .lt('_creationTime', before),
            )
            .order('desc')
            .first(),
        );
        if (next === undefined) break;
        if (next === null) {
          complete = true;
          break;
        }
        seen.push(next);
        before = next._creationTime;
        // A real change ends the walk — the same test `startOfCurrentState` makes below (a row
        // with no `prev` is taken as one, and `undefined` is never the current status).
        if (statusFound(next) !== target.status) break;
      }
      const start = startOfCurrentState(
        seen,
        (r) => ({ at: r.createdAt, after: target.status as string, before: statusFound(r) }),
        target.status as string,
        complete,
      );
      // When, who, via and why all come from one write — the one that began the status — so the
      // note is one true sentence: no moderator is credited with another's date or words. The window
      // is the state's own. With no start found, the reason on file stands alone, unattributed.
      const row = start.row;
      statusNote = {
        action: verb,
        /** When the status began (`lib/stateSince`), not when it was last set. */
        at: start.since,
        /** The status began before the rows read: `at` is "can't say", not "not recorded". */
        atCapped: start.capped,
        /** Who began it, and through what — the write `at` dates. */
        by: await personRef(ctx, row?.actorId),
        via: row?.via ?? null,
        /** The reason that write gave; the one on file when no start was found. */
        reason: (row === null ? target.statusReason : row.reason) ?? null,
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
    let contentCapped = false;
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
      /** What they wrote — support's to read (PII, D37), and only ever sent to a viewer who may. */
      body: string;
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
        .map((t) => ({ ticketId: t._id, status: t.status, createdAt: t.createdAt, body: t.body }))
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

    // ── The bounty season line: their asks this season, from the create gate's record ──
    const bountySeason = await bountySeasonOf(ctx, budget, userId, now);

    // ── When each right now off was taken away, from its `set_posting_permission` rows ──
    const rightsSince = await rightsSinceOf(ctx, budget, target);

    // ── The open flags' labels, through the budget left ──
    const flagLabelsCapped = await labelFlags(ctx, budget, target, openFlags);

    // ── The levers, and whether this viewer may pull each: the write's own refusal ──
    const discipline = viewerCan(viewer, 'people.discipline');
    const roles = viewerCan(viewer, 'people.role');
    const seesLedger = seesLedgerGrants(viewer);
    const answer = async (
      write: PersonWrite,
      allowed: boolean,
      family: 'discipline' | 'role',
      needsReason = writeTakesAway(target, write),
    ) => {
      if (!allowed) return no(cannotUse(viewer, family));
      const why = await writeRefusal(ctx, viewer, target, write);
      // The last-editor sentence names who holds the ledger: a holder's to read, no one else's.
      return why === null ? yes(needsReason) : no(refusalFor(why, seesLedger));
    };
    const lever = (write: PersonWrite) => answer(write, discipline, 'discipline');
    const restrict = await lever({ kind: 'right', permission: 'reports', allowed: false });
    const giveBack = (permission: 'reports' | 'hazards' | 'comments' | 'flagging') =>
      lever({ kind: 'right', permission, allowed: true });
    const flaggingOff = await lever({ kind: 'right', permission: 'flagging', allowed: false });
    const roleCan = (role: UserRole) => answer({ kind: 'role', role }, roles, 'role');
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
      /**
       * Their bounty asks this season, from the create gate's record (`bountyGateEvents`, kept 180
       * days): every attempt, those refused for being over their limit, and those refused because the
       * lake had a recent report. `null` — not recorded — when the season began before the record's
       * window, rather than a part of the season shown as the whole.
       */
      bountySeason,
      /**
       * When each right now taken away was taken — the `set_posting_permission` row that turned it
       * off, a later one that changed nothing passed over (`lib/stateSince`); `null` for a right they
       * have, or when no row read says — `rightsSinceCapped` when the read stopped before finding one.
       */
      rightsSince: rightsSince.since,
      rightsSinceCapped: rightsSince.capped,
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
      /**
       * Backfills not yet finished that this page rests on: until `flagSubjects` is done, flags on
       * their content filed before the stamp aren't found (`strip.openFlags.onContent`, `open.flags`).
       */
      pending: (stored.flagSubjectsReady ? [] : ['flagSubjects']) as PeopleBackfill[],
      open: {
        flags: openFlags,
        flagsCapped: userCapped || contentCapped,
        /** Some open flags carry no `targetLabel`: past the label cap or the budget, not unnamed. */
        flagLabelsCapped,
        appeals,
        appealsCapped,
      },
      hidden,
      ledger: ledgerVisible
        ? {
            editor: isLedgerEditor(target),
            /** The last editor who can act: their switch can't be turned off (D227). */
            last: await isLastLedgerEditor(ctx, target),
            /**
             * When the grant they hold was given; `null` when not a holder, or no row says — or, with
             * `sinceCapped`, when the read couldn't be afforded and it can't be said.
             */
            since: ledgerSince.at,
            sinceCapped: ledgerSince.capped,
          }
        : null,
      /**
       * Whether this viewer can open the person's public profile — the profile read's own rule
       * (`profileAccess`): not deleted, not leaving, not blocked either way. `private` when it opens
       * to their name and avatar only.
       */
      publicProfile: {
        opens: publicAccess !== 'hidden',
        private: publicAccess === 'private',
        path: `/u/${target.username}`,
      },
      can: {
        restrict,
        flaggingOff,
        suspend: await lever({ kind: 'suspend' }),
        ban: await lever({ kind: 'ban' }),
        lift: await lever({ kind: 'lift' }),
        /** A new window for a running suspension (the suspend write); refused when not suspended. */
        extend: await lever({ kind: 'extend' }),
        /** Each give-back, as the write answers it: no reason asked (D226). */
        restore: {
          reports: await giveBack('reports'),
          hazards: await giveBack('hazards'),
          comments: await giveBack('comments'),
        },
        flaggingOn: await giveBack('flagging'),
        /** The bounty limit: raising or clearing asks no reason, lowering asks one (D226). */
        bountyRaise: await answer({ kind: 'bountyLimit' }, discipline, 'discipline', false),
        bountyLower: await answer({ kind: 'bountyLimit' }, discipline, 'discipline', true),
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

/** Each actor's row read once a page (the memo holds the read itself, so a repeat waits on it). */
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
 * What a row's refusal hook (`UndoHandler.refusal`) reads **outside** the share `undoStates` reserves
 * for it through `ReadBudget.waves` (B01-3h) — the rows it reads through its share are reserved there,
 * on this same budget, so they aren't counted here again: when the plan has used the budget up, those
 * rows say "check elsewhere" (`UNDO_CHECKED_ELSEWHERE`), and nothing over-reads. Outside it: a
 * launch's body's hidden launches (`launchRefusal`, up to {@link SUPPRESSION_ROWS_READ}) and a row's
 * snapshot (one call, at most 8 chunks) — calls and documents the per-row plan has to count itself.
 */
const REFUSAL_CALLS = 2;
const REFUSAL_DOCS = SUPPRESSION_ROWS_READ + 8;

/**
 * What shaping one History or Decisions row reads through helpers on main and in this PR, counted
 * ahead: calls and documents — undo state (the undo tagged rows ≤ 16, the newest row on the target,
 * the content's author stamp, the person's row, a rowless fallback, and the refusal hook's reads
 * outside its share, {@link REFUSAL_CALLS} and {@link REFUSAL_DOCS}), the actor's and the target's
 * names. Bytes: the hook's share reads are reserved and charged by `ReadBudget.waves`; a rowless
 * profile is charged by `rowlessProfile`; the rest are **not** charged — the undo engine reads audit
 * rows and content items whose worst case is the document limit (an audit row's metadata has no cap),
 * and the hook's snapshot and hidden-launch bytes are owed (the phase doc's B01-3f "Owed").
 */
const ROW_SHAPE_CALLS = 8 + REFUSAL_CALLS;
export const ROW_SHAPE_DOCS = 24 + REFUSAL_DOCS;

/**
 * How many of `n` rows {@link shapeRows} can shape once `calls` more calls reading `docs` documents
 * have been made: each row's calls and documents counted at {@link ROW_SHAPE_CALLS} and
 * {@link ROW_SHAPE_DOCS}.
 */
function shapeable(budget: ReadBudget, n: number, calls = 0, docs = 0): number {
  let k = n;
  while (k > 0 && !budget.affordsCalls(calls + ROW_SHAPE_CALLS * k, docs + ROW_SHAPE_DOCS * k)) k--;
  return k;
}

/** Rows shaped in order, each counted ahead against the request's budget (≤ 100 rows: it fits). */
export async function shapeRows(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  rows: readonly Doc<'moderationActions'>[],
  actors: Actors,
): Promise<PersonActionRow[]> {
  const budget = queryBudget(ctx);
  // Every row's calls are counted before any starts (as many rows as fit; the caller says capped for
  // the rest). Rows are shaped one after another for now, each asking `undoState` alone; B01-3i's
  // page reading (`undoStates`, in waves) has landed, and shaping them at once on it follows in its
  // own PR (`b01-4c-people-rounds`).
  const n = shapeable(budget, rows.length);
  budget.reserveCalls(ROW_SHAPE_CALLS * n, ROW_SHAPE_DOCS * n);
  const out: PersonActionRow[] = [];
  for (const row of rows.slice(0, n)) out.push(await toRow(ctx, viewer, row, actors));
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
  const label = await labelOf(ctx, row);
  const undo = await undoState(ctx, viewer, row);
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
    ...label,
    undo,
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
  args: { userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { userId: raw, limit }) => {
    const viewer = await requireCapability(ctx, 'audit.read');
    const userId = profileIdOf(ctx, raw);
    if (userId === null) return null;
    const budget = queryBudget(ctx);
    const target = await budget.one('profile', () => ctx.db.get(userId));
    if (!target) return null;
    const n = clampLimit(limit);
    budget.reserve('small', 64 + 4);
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
    const shaped = await shapeRows(ctx, viewer, merged.rows, new Map());
    return {
      rows: shaped,
      capped: merged.capped || shaped.length < merged.rows.length,
      /** Flags older than the subject stamp aren't found by person until its backfill has run. */
      pending: (stored.flagSubjectsReady ? [] : ['flagSubjects']) as PeopleBackfill[],
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
    userId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { userId: raw, cursor, limit }) => {
    const viewer = await requireCapability(ctx, 'audit.read');
    const userId = profileIdOf(ctx, raw);
    if (userId === null) return null;
    const ledgerVisible = seesLedgerGrants(viewer);
    const budget = queryBudget(ctx);
    // A page asks only for the rows it can shape after its own read: a row read but not shaped would
    // lie behind the page's cursor, and the next page would start past it — never shown.
    const size = Math.max(1, shapeable(budget, clampLimit(limit), 1, DECISIONS_SCAN));
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
          numItems: size,
          maximumRowsRead: DECISIONS_SCAN,
          maximumBytesRead: DECISIONS_BYTES,
        }),
    );
    const shaped = await shapeRows(ctx, viewer, page.page, new Map());
    // Rows the request couldn't afford to shape (only when not even one row's calls and documents
    // were left): `capped`, and the page isn't the end.
    const short = shaped.length < page.page.length;
    return {
      rows: shaped,
      isDone: page.isDone && !short,
      capped: short,
      continueCursor: page.continueCursor,
    };
  },
});

// ── A staffer's figures ────────────────────────────────────────────────────────────────────────

/** The trend's weeks. */
const WEEKS = 9;
const WEEK_MS = 7 * DAY_MS;
/**
 * A staffer's decisions read at most — the nine weeks' read (`staffStats`), and a season's own read
 * (`staffSeason`) — by count and by their real weight (`maximumBytesRead`): an audit row's reason is
 * uncapped, so no worst case per row would let a useful number through.
 */
const DECISION_ROWS = 2_000;
const DECISION_BYTES = 4 * DOC_MAX;

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
 * A staffer's strip (the founder's definitions, 2026-11-14):
 * - **decisions** this week — the rows they made, minus their own skater actions, and how many
 *   someone else undid on net (`lib/undoChains`);
 * - **timeToDecide** — the lower median, over this week's decisions on filed items (flags, requests,
 *   drawn bodies), of filed to decided; `null` when none, or when any one's filing time isn't known;
 * - **staffSince** and **roleSince** — `lib/staffTenure.staffTenure`; `null` when no row on record says so;
 * - **weeks** — decisions in each of the last nine weeks, oldest first.
 *
 * *Overturned this season* is its own query, {@link staffSeason}.
 *
 * **Fits by construction**: one read of the staffer's decisions over the nine weeks (real-weight
 * capped), and every further read — a chain's first row, a filing — goes through one budget that
 * counts bytes, calls and documents and is asked before each read; when it runs out the loop stops
 * and the figure says `capped` (the median reading `null` as well). The role rows are read before
 * those loops, so they can't starve the dates; a walk that reads its last allowed row without finding
 * the entering grant says `tenureCapped`. Before the undo-chain backfill has run, `pending` names it:
 * the undo figures may be wrong, and the dates are `null` when an undo among the role rows predates it.
 *
 * `null` for anyone who isn't staff. Moderators read it on an admin's page too: the audit feed
 * already shows them everything it counts.
 */
export const staffStats = query({
  args: { userId: v.string(), ...nowArg },
  handler: async (ctx, args) => {
    const viewer = await requireCapability(ctx, 'audit.read');
    const now = clock(args.now);
    const budget = queryBudget(ctx);
    const userId = profileIdOf(ctx, args.userId);
    if (userId === null) return null;
    const target = await budget.one('profile', () => ctx.db.get(userId));
    if (!target || ROLE_RANK[target.role] < ROLE_RANK.moderator) return null;
    const ledgerVisible = seesLedgerGrants(viewer);
    const staffer = target._id;
    const chainsReady = (await preparationOf(budget, ctx)).pending.includes('undoChains') === false;

    // ── One read of their decisions over the nine weeks ──
    // The week the Staff lane's column counts too (`thisWeekOf`): one window for one figure.
    const end = thisWeekOf(now).to;
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
    // The reads its per-row loops make, for the query's time bound (`STAFF_CHECKED`).
    const counted = { reads: 0 };
    const rootOf = rootReader(ctx, budget, page.page, counted);

    // ── Staff since and role since (`lib/staffTenure`, the rule the Staff lane's rows are stamped by) ──
    // Read before the per-decision loops below, which run until the budget is spent: read after them,
    // a busy staffer's dates would be starved and say capped whenever those loops ran out.
    const { tenure, roleShort, roleFull, roleUnplaced } = await readTenure(
      ctx,
      budget,
      staffer,
      target.role,
      chainsReady,
    );

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
    let undoShort = false;
    // The query's time bound (Convex gives a query one second): at most `STAFF_CHECKED` database calls
    // across both loops below (a row whose answer is in hand costs none), past which each figure says
    // capped, as a budget stop does.
    const overTime = () => counted.reads >= STAFF_CHECKED;
    const undoers = new Map<string, number>();
    for (const r of weekRows) {
      if (overTime()) {
        undoShort = true;
        break;
      }
      const root = await rootOf(r);
      if (root === undefined) {
        undoShort = true;
        break;
      }
      const by = undoneBy(r, root);
      if (byOther(by)) {
        undone++;
        undoers.set(by as string, (undoers.get(by as string) ?? 0) + 1);
      }
    }

    const durations: number[] = [];
    let unknown = 0;
    // A filing time the budget ran out before reading is capped, not unrecorded.
    let decideShort = false;
    const filed = weekRows.filter((x) => FILED_DECISIONS.has(x.action));
    for (const r of filed) {
      if (overTime()) {
        decideShort = true;
        break;
      }
      const filedAt = await filedAtOf(ctx, budget, r, counted);
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
        undoneByOthers: {
          count: undone,
          capped: thisWeek.capped || undoShort,
          ...(await undoneByWhom(ctx, budget, undoers)),
        },
      },
      timeToDecide: {
        medianMs: unknown > 0 || thisWeek.capped || decideShort ? null : lowerMedian(durations),
        decided: filed.length,
        capped: thisWeek.capped || decideShort,
      },
      staffSince: tenure.staffSince,
      roleSince: tenure.roleSince,
      /** The role rows couldn't all be read: both dates are `null` for that reason, not unrecorded. */
      tenureCapped: tenureCappedOf({ tenure, roleShort, roleFull, roleUnplaced }),
      /**
       * Backfills not yet run that a figure here rests on — distinct from `capped` (a read stopped
       * short) and from `null` (nothing on record): until `undoChains` is done, `undoneByOthers` and
       * the tenure dates may be wrong, not merely short.
       */
      pending: (chainsReady ? [] : ['undoChains']) as PeopleBackfill[],
      weeks,
    };
  },
});

/** Undoers a staffer's strip names at most ("2 later undone by ‹name›"); the rest are counted. */
const UNDOERS_NAMED = 3;

/**
 * Who undid a staffer's decisions this week, most first: up to {@link UNDOERS_NAMED} named from their
 * light rows (staff all — only staff undo), and how many more there were. A name the budget can't
 * afford is left out and counted with the rest.
 */
async function undoneByWhom(
  ctx: QueryCtx,
  budget: ReadBudget,
  undoers: Map<string, number>,
): Promise<{ by: Array<PersonRef & { count: number }>; byMore: number }> {
  const ranked = [...undoers.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const by: Array<PersonRef & { count: number }> = [];
  for (const [id, count] of ranked.slice(0, UNDOERS_NAMED)) {
    if (!budget.affordsRead('personRow')) break;
    const ref = await budget.one('personRow', () => personRef(ctx, id as Id<'profiles'>));
    if (ref) by.push({ ...ref, count });
  }
  return { by, byMore: ranked.length - by.length };
}

/**
 * Database calls a staffer's week may make, row by row, for undos and filing times together: the
 * query's time bound. A busy week past it reads as capped; the counts themselves come from the one
 * page read and stay whole.
 */
const STAFF_CHECKED = 400;

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
  args: { userId: v.string(), season: v.optional(v.number()), ...nowArg },
  handler: async (ctx, args) => {
    const viewer = await requireCapability(ctx, 'audit.read');
    const now = clock(args.now);
    const budget = queryBudget(ctx);
    const userId = profileIdOf(ctx, args.userId);
    if (userId === null) return null;
    const target = await budget.one('profile', () => ctx.db.get(userId));
    if (!target || ROLE_RANK[target.role] < ROLE_RANK.moderator) return null;
    // A season no one can name (`NaN`, a fraction, a year past what a date can hold) is this season.
    const season: Season = resolveSeason(args.season, seasonOf(now));
    const span = seasonRecordSpan(season, now);
    const head = { season, opensOn: seasonRecordWindow(season, now).opensOn, empty: span === null };
    if (span === null) return { ...head, overturned: null, pending: [] as PeopleBackfill[] };
    const ledgerVisible = seesLedgerGrants(viewer);
    const staffer = target._id;
    const chainsReady = (await preparationOf(budget, ctx)).pending.includes('undoChains') === false;
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
    let short = !page.isDone || inSeason.length > SEASON_CHECKED;
    for (const r of inSeason.slice(0, SEASON_CHECKED)) {
      const reversed = await reversedByOther(ctx, budget, rootOf, r, staffer);
      if (reversed === undefined) {
        short = true;
        break;
      }
      if (reversed) count++;
    }
    return {
      ...head,
      overturned: { count, capped: short } as Count,
      /** Backfills not yet run that `overturned` rests on (see `staffStats.pending`). */
      pending: (chainsReady ? [] : ['undoChains']) as PeopleBackfill[],
    };
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
  counter: { reads: number } = { reads: 0 },
): Promise<number | null | undefined> {
  const recorded = (row.metadata as { filedAt?: unknown } | undefined)?.filedAt;
  if (typeof recorded === 'number') return recorded;
  // Each read counted where it is made: an id that names nothing costs none.
  if (row.targetType === 'contentFlag') {
    const id = ctx.db.normalizeId('contentFlags', row.targetId);
    if (!id) return null;
    counter.reads++;
    const flag = await budget.measured('contentFlag', () => ctx.db.get(id));
    return flag === undefined ? undefined : (flag?.createdAt ?? null);
  }
  if (row.targetType === 'waterBodyRequest') {
    const id = ctx.db.normalizeId('waterBodyRequests', row.targetId);
    if (!id) return null;
    counter.reads++;
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
  args: { userId: v.string(), months: v.optional(v.number()), ...nowArg },
  handler: async (ctx, args) => {
    await requireCapability(ctx, 'people.read');
    const now = clock(args.now);
    const budget = queryBudget(ctx);
    const userId = profileIdOf(ctx, args.userId);
    if (userId === null) return null;
    const target = await budget.one('profile', () => ctx.db.get(userId));
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
