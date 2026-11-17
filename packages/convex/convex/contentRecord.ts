/**
 * A person's moderation record on their content, for the People page (D248, the founder's rulings
 * of 2026-11-13), and the backfill that builds it from the audit log.
 *
 * Staff-only: gated like the other People reads, and nothing here reaches a skater-facing read or a
 * score (D17/D50 stay boost-only). The page itself mounts it with the People workstream.
 */
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type QueryCtx, query } from './_generated/server';
import { requireCapability } from './lib/auth';
import { authorDeletedAtOf } from './lib/authorDeletion';
import {
  isReversed,
  REPLAY_START,
  type ReplayedVerdict,
  type ReplayState,
  replayStep,
  subjectOf,
  VERDICT_COUNT_CAP,
  type VerdictTargetType,
  zeroByKind,
} from './lib/contentVerdicts';
import { clockOf, ERASABLE, HOLD_COST, holdMoved } from './lib/eraseClock';
import {
  chainedLease,
  handOn,
  LEASE_ARG,
  PEOPLE_BACKFILLS,
  type PeopleBackfill,
  readPending,
  VERDICTS_DONE,
} from './lib/peopleRuns';
import {
  CHARGED_QUERY_BUDGET,
  DOC_MAX,
  OverBudget,
  ReadBudget,
  ROW_MAX,
  requestBudget,
  sizePage,
  TX_BUDGET,
  traced,
} from './lib/readBudget';
import {
  before,
  bodyIdOf,
  contentOf,
  DELETED_KINDS,
  DELETED_TAKE,
  decodePosition,
  deletedKey,
  deletedRange,
  encodePosition,
  loadVerdicts,
  type Names,
  namesOf,
  newPageCache,
  type Position,
  RECORD_PAGE,
  RECORD_PAGE_ROWS,
  type RecordContentDoc,
  readNames,
  readReports,
  reportIdOf,
  takeAfter,
  takeUntilNull,
  targetIdOf,
  type VerdictLoad,
  withdrawnAt,
  within,
} from './lib/recordReads';
import {
  type RecordLevers,
  type RecordViewer,
  recordFactsOf,
  recordLevers,
} from './lib/recordRules';
import { type UndoState, undoStates } from './lib/undo';
import { literals } from './lib/validators';
import { planPostRestore } from './moderation';

/** Audit rows per backfill page, at most; each page is its own transaction and schedules the next. */
const BACKFILL_PAGE = 200;

type ContentDoc = RecordContentDoc;

/** The item a verdict is on, charged at its kind's worst case. */
async function loadTarget(
  ctx: QueryCtx,
  reads: ReadBudget,
  targetType: VerdictTargetType,
  targetId: string,
): Promise<ContentDoc | null> {
  // A verdict's targets are what an author can withdraw (`lib/authorDeletion`), and an alert its
  // author retracted — every one of them erasable, so the erasure map names its table.
  const id = ctx.db.normalizeId(ERASABLE[targetType], targetId);
  if (!id) return null;
  return (await reads.one(targetType, () => ctx.db.get(id))) as ContentDoc | null;
}

/** The record's pages run beside the caller's own profile read (`requireCapability`). */
const recordBudget = () => new ReadBudget(TX_BUDGET - ROW_MAX.profile);

const VERDICT_TARGETS = ['report', 'post', 'comment', 'hazard', 'accessAlert'] as const;

/**
 * The request's one budget, opened before any helper charges it (`requestBudget`): the record's reads
 * and the undo engine's (`undoStates`) share it, beside the caller's own profile.
 */
const sheetBudget = (ctx: QueryCtx) => requestBudget(ctx, CHARGED_QUERY_BUDGET);

/**
 * Whether the verdict backfill (`peopleJobs:backfillVerdicts`, which also gives withdrawn content its
 * erasure clocks) is still to finish: until it has, a record list may miss a decision made before the
 * record existed, an item's newest decision may not be marked yet, and a withdrawal may have no clock
 * — the lists say `pending: ['verdicts']`, "still being prepared", never a short number.
 */
async function recordPending(ctx: QueryCtx, reads: ReadBudget): Promise<PeopleBackfill[]> {
  reads.reserve('small', PEOPLE_BACKFILLS.length);
  const { pending } = await readPending(ctx);
  return pending.filter((b) => b === 'verdicts');
}

/** Standing, by its index: the person's standing verdicts after `key` (its tie, with `tieCt`). */
function standingQuery(
  ctx: QueryCtx,
  userId: Id<'profiles'>,
  targetType: VerdictTargetType | undefined,
  key: number | undefined,
  tieCt: number | null,
) {
  return (
    targetType === undefined
      ? ctx.db.query('contentVerdicts').withIndex('by_subject_standing', (q) => {
          const b = q.eq('subjectUserId', userId).eq('standing', true);
          if (key === undefined) return b;
          return tieCt !== null ? b.eq('at', key).lt('_creationTime', tieCt) : b.lt('at', key);
        })
      : ctx.db.query('contentVerdicts').withIndex('by_subject_standing_type', (q) => {
          const b = q.eq('subjectUserId', userId).eq('standing', true).eq('targetType', targetType);
          if (key === undefined) return b;
          return tieCt !== null ? b.eq('at', key).lt('_creationTime', tieCt) : b.lt('at', key);
        })
  ).order('desc');
}

/**
 * Reversed, by its index: each item's newest decision once ended (`lib/contentVerdicts.isReversed`).
 * Every range keeps its lower bound — a standing verdict lacks `endedAt`, which sorts first.
 */
function reversedQuery(
  ctx: QueryCtx,
  userId: Id<'profiles'>,
  targetType: VerdictTargetType | undefined,
  key: number | undefined,
  tieCt: number | null,
) {
  const verdicts = ctx.db.query('contentVerdicts');
  if (targetType === undefined) {
    return verdicts
      .withIndex('by_subject_reversed', (q) => {
        const b = q.eq('subjectUserId', userId).eq('superseded', false);
        if (key === undefined) return b.gt('endedAt', 0);
        return tieCt !== null
          ? b.eq('endedAt', key).lt('_creationTime', tieCt)
          : b.gt('endedAt', 0).lt('endedAt', key);
      })
      .order('desc');
  }
  return verdicts
    .withIndex('by_subject_reversed_type', (q) => {
      const b = q.eq('subjectUserId', userId).eq('superseded', false).eq('targetType', targetType);
      if (key === undefined) return b.gt('endedAt', 0);
      return tieCt !== null
        ? b.eq('endedAt', key).lt('_creationTime', tieCt)
        : b.gt('endedAt', 0).lt('endedAt', key);
    })
    .order('desc');
}

/** A Standing or Reversed page's rows: the cursor's two-part read over one index range. */
async function verdictRange(
  ctx: QueryCtx,
  reads: ReadBudget,
  list: 'standing' | 'reversed',
  userId: Id<'profiles'>,
  targetType: VerdictTargetType | undefined,
  after: Position | null,
  n: number,
): Promise<Doc<'contentVerdicts'>[]> {
  const range = list === 'standing' ? standingQuery : reversedQuery;
  const key = after?.key;
  const tie = after?.ct ?? null;
  const rows = await takeAfter(
    reads,
    'verdict',
    n,
    tie === null ? null : (m) => range(ctx, userId, targetType, key, tie).take(m),
    (m) => range(ctx, userId, targetType, key, null).take(m),
  );
  return rows;
}

/**
 * A record list's arguments: whose record, one kind or all, where the last page ended, and — once the
 * page has been read past — where this page ended then (`endCursor`).
 */
interface ListArgs {
  userId: Id<'profiles'>;
  targetType?: VerdictTargetType;
  cursor?: string | null;
  endCursor?: string | null;
}

/**
 * A record list's page arguments, every list alike. `endCursor` is where the page ended when it was
 * first read (its `continueCursor`): the page then reads exactly `(cursor, endCursor]` and keeps that
 * end as its `continueCursor`, so a change to an earlier page never drops or repeats a row on a later
 * one — Convex's own reactive pagination, as `people.listPage` reads it. A range that has grown past
 * what one page returns answers `pageStatus: 'SplitRequired'` with a `splitCursor` after the rows it
 * did return, and the client reads `(cursor, splitCursor]` and `(splitCursor, endCursor]`.
 */
const LIST_ARGS = {
  userId: v.id('profiles'),
  targetType: v.optional(literals(VERDICT_TARGETS)),
  cursor: v.optional(v.union(v.string(), v.null())),
  endCursor: v.optional(v.union(v.string(), v.null())),
};

/** The levers on an item as a list row sees it (its members unread: `lib/recordRules`). */
function rowLevers(viewer: RecordViewer, load: VerdictLoad, standing: boolean): RecordLevers {
  return recordLevers(
    viewer,
    recordFactsOf(load.verdict.targetType, load.target, standing ? load.verdict.kind : null),
  );
}

/**
 * How a decision was ended, read off the row that ended it: a reversal — or, on the item pane, which
 * shows every decision, a later hide, removal or retraction that superseded it (a hide that became a
 * removal was not restored).
 */
function endedHowOf(
  ending: Doc<'moderationActions'>,
): 'restore' | 'undo' | 'overturn' | 'superseded' {
  if (ending.action === 'overturn_verdict') return 'overturn';
  if (ending.undoesActionId !== undefined) return 'undo';
  const takedown =
    ending.action === 'hide' ||
    ending.action === 'remove' ||
    ending.action === 'retract_access_alert';
  return takedown ? 'superseded' : 'restore';
}

/** A reason as the sheet shows it: `null` for a give-back's default (History leaves those out too). */
function shownReason(row: Doc<'moderationActions'> | null): string | null {
  if (row === null) return null;
  return (row.metadata as { reasonDefaulted?: boolean } | undefined)?.reasonDefaulted === true
    ? null
    : row.reason;
}

/** What every record row says of its item's place: the body, and what a comment or a Post is on. */
function placeOf(
  load: Pick<VerdictLoad, 'target' | 'report'>,
  targetType: VerdictTargetType,
  names: Names,
) {
  const body = names.body(bodyIdOf(targetType, load.target, load.report));
  return {
    waterBodyId: body?.id ?? null,
    waterBodyName: body?.name ?? null,
    /** A comment's: whose Report it is on (`null` for any other kind, or once it is gone). */
    reportAuthor: targetType === 'comment' ? names.person(load.report?.authorId) : null,
    /** A Post's: how many Reports it holds (`null` for any other kind, or once it is gone). */
    postReportCount:
      targetType === 'post' && load.target ? (load.target as Doc<'posts'>).reportIds.length : null,
  };
}

/**
 * **A page always moves on.** Its first row is read whole — every stage, by itself — before any other
 * row is admitted (its worst case fits what the page's rows leave of the budget,
 * `recordRounds.test.ts` holds that), so a page that says `isDone: false` has returned a row or moved
 * its cursor, whatever its other rows weigh; the rest follow in waves with what is left, sharing what
 * the first already read (`PageCache`). `shape` answers the leading run of `some` it read whole.
 */
export async function headFirst<R, S>(
  rows: readonly R[],
  shape: (some: readonly R[]) => Promise<S[]>,
): Promise<S[]> {
  if (rows.length === 0) return [];
  const head = await shape(rows.slice(0, 1));
  if (head.length === 0) {
    // A plan error, never a data condition.
    throw new OverBudget('record: a page’s first row did not fit what its rows left of the budget');
  }
  return rows.length === 1 ? head : [...head, ...(await shape(rows.slice(1)))];
}

/** A page's verdicts, read whole as far as the budget reaches, and named. */
async function shapeVerdictPage(
  ctx: QueryCtx,
  reads: ReadBudget,
  verdicts: Doc<'contentVerdicts'>[],
  ended: boolean,
) {
  const cache = newPageCache();
  const bodiesOf = (l: VerdictLoad) => [bodyIdOf(l.verdict.targetType, l.target, l.report)];
  const peopleOf = (l: VerdictLoad) => [
    l.decision?.actorId,
    l.ending?.actorId,
    l.verdict.targetType === 'comment' ? l.report?.authorId : undefined,
  ];
  const rows = await headFirst(verdicts, async (some) => {
    const loaded = await loadVerdicts(ctx, reads, some, { ended, cache });
    const names = await readNames(
      ctx,
      reads,
      loaded.rows.flatMap(bodiesOf),
      loaded.rows.flatMap(peopleOf),
      cache,
    );
    const whole: VerdictLoad[] = [];
    for (const l of loaded.rows) {
      if (names.missed(bodiesOf(l), peopleOf(l))) break;
      whole.push(l);
    }
    return whole;
  });
  return { rows, names: namesOf(cache), cut: rows.length < verdicts.length };
}

/**
 * A page's answer: its rows, whether more follow, the cursor after its last row, and `pending`. A
 * page given an end (`endCursor`) keeps it as its `continueCursor` when it returned every row up to
 * it (`whole`); one that didn't says `SplitRequired`, split after its last row — or, with no row to
 * split after, with no `splitCursor`, and the client reads the range again unbounded.
 */
function pageOf<R>(
  page: R[],
  keys: Position[],
  {
    more,
    after,
    pending,
    endCursor,
    whole,
  }: {
    more: boolean;
    after: Position | null;
    pending: PeopleBackfill[];
    endCursor: string | null;
    whole: boolean;
  },
) {
  const last = keys[keys.length - 1];
  if (endCursor !== null && !whole) {
    return {
      page,
      isDone: false,
      continueCursor: endCursor,
      ...(last ? { splitCursor: encodePosition(last) } : {}),
      pageStatus: 'SplitRequired' as const,
      pending,
    };
  }
  return {
    page,
    isDone: !more,
    continueCursor:
      endCursor !== null
        ? endCursor
        : last
          ? encodePosition(last)
          : after
            ? encodePosition(after)
            : '',
    pending,
  };
}

/** The end a page was pinned to: `null` when it has none (the chain's last page). */
function endOf(endCursor: string | null | undefined): { raw: string | null; at: Position | null } {
  const at = decodePosition(endCursor);
  return { raw: at === null ? null : (endCursor as string), at };
}

/**
 * **Standing** — the person's standing verdicts, newest first, a page at a time (the record sheet's
 * first tab): each with the decision's reason and who made it (`decidedBy`, from their People row;
 * `null` for a system row), the content still readable where it is kept, labeled when its author
 * deleted it afterward, the body it is on, and `can` — the one lever its state offers this viewer, as
 * the write would answer (`lib/recordRules`; a Post whose author didn't delete it answers Restore on
 * its item, whose members decide). `targetType` narrows it to one kind. A short page is not the end,
 * `isDone` is; `pending` names the verdict backfill until it has run. The counts by kind are
 * `lib/contentVerdicts.readVerdictCounts`, over the same range (`people.person`'s `hidden`). Staff
 * only.
 */
export const personVerdicts = query({
  args: LIST_ARGS,
  handler: async (ctx, args) => {
    const viewer = await requireCapability(ctx, 'people.read');
    return standingPage(ctx, viewer, args);
  },
});

/** `personVerdicts`'s page, for a viewer already let in (the rounds test drives it on a counted context). */
export async function standingPage(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  { userId, targetType, cursor, endCursor }: ListArgs,
) {
  const reads = sheetBudget(ctx);
  const pending = await recordPending(ctx, reads);
  const after = decodePosition(cursor);
  const end = endOf(endCursor);
  const found = await verdictRange(
    ctx,
    reads,
    'standing',
    userId,
    targetType,
    after,
    RECORD_PAGE_ROWS.n + 1,
  );
  const inRange = found.filter((v) => within(end.at, { key: v.at, ct: v._creationTime }));
  const verdicts = inRange.slice(0, RECORD_PAGE_ROWS.n);
  const { rows, names, cut } = await shapeVerdictPage(ctx, reads, verdicts, false);
  const page = rows.map((l) => {
    const { verdict, decision, target } = l;
    // A comment the sweep reduced to its placeholder keeps no words: `null`, as Reversed and the pane.
    const erasedComment =
      target !== null &&
      verdict.targetType === 'comment' &&
      (target as Doc<'comments'>).erasedAt !== undefined;
    return {
      targetType: verdict.targetType,
      targetId: verdict.targetId,
      kind: verdict.kind,
      at: verdict.at,
      reason: decision?.reason ?? null,
      byUserId: decision?.actorId ?? null,
      decidedBy: names.person(decision?.actorId),
      content: target && !erasedComment ? contentOf(verdict.targetType, target) : null,
      authorDeletedAt: target ? withdrawnAt(verdict.targetType, target) : null,
      ...placeOf(l, verdict.targetType, names),
      can: rowLevers(viewer, l, true),
    };
  });
  return pageOf(
    page,
    rows.map((l) => ({ key: l.verdict.at, ct: l.verdict._creationTime })),
    {
      more: cut || found.length > rows.length,
      after,
      pending,
      endCursor: end.raw,
      whole: !cut && inRange.length === verdicts.length,
    },
  );
}

/**
 * **Reversed** — decisions a moderator ended (restored, undone or overturned), newest ended first, each
 * item once, as its newest decision (`lib/contentVerdicts.isReversed`: a hide that became a removal is
 * the removal, never also a Reversed hide), kept as history even after the words are erased (`content:
 * null` with `erasedAt` set: *The words were erased*). Each row: the decision (what, when, who, why),
 * how it ended (`endedHow`, who, when, and their reason — `null` for a give-back's default), the ending
 * row's undo state for this viewer (`lib/undo.undoStates`, in page order), and `can`. A short page is
 * not the end, `isDone` is; `pending` names the verdict backfill until it has run. Staff only.
 */
export const personReversed = query({
  args: LIST_ARGS,
  handler: async (ctx, args) => {
    const viewer = await requireCapability(ctx, 'people.read');
    return reversedPage(ctx, viewer, args);
  },
});

/** `personReversed`'s page, for a viewer already let in (the rounds test drives it on a counted context). */
export async function reversedPage(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  { userId, targetType, cursor, endCursor }: ListArgs,
) {
  const reads = sheetBudget(ctx);
  const pending = await recordPending(ctx, reads);
  const after = decodePosition(cursor);
  const end = endOf(endCursor);
  // The undo engine's first step for each row (main's, `undoStates`): its calls and documents
  // counted ahead — the undoing row (up to 16 tagged), the target's newest, the author stamp.
  reads.reserveCalls(3 * RECORD_PAGE, 18 * RECORD_PAGE);
  const found = await verdictRange(
    ctx,
    reads,
    'reversed',
    userId,
    targetType,
    after,
    RECORD_PAGE_ROWS.n + 1,
  );
  const inRange = found.filter((v) =>
    within(end.at, { key: v.endedAt as number, ct: v._creationTime }),
  );
  const verdicts = inRange.slice(0, RECORD_PAGE_ROWS.n);
  const { rows, names, cut } = await shapeVerdictPage(ctx, reads, verdicts, true);
  const endings = rows.flatMap((l) => (l.ending ? [l.ending] : []));
  // List rows: the `list` scope (a page never runs a refusal only a single view can afford), read by
  // the page (`read`: the last-editor sentence for a holder only).
  const states = await undoStates(ctx, viewer, endings, 'list', 'read');
  const undoOf = new Map(endings.map((e, i) => [e._id as string, states[i] as UndoState]));
  const page = rows.map((l) => {
    const { verdict, decision, ending, target, erase } = l;
    const erasedComment =
      target !== null &&
      verdict.targetType === 'comment' &&
      (target as Doc<'comments'>).erasedAt !== undefined;
    return {
      targetType: verdict.targetType,
      targetId: verdict.targetId,
      kind: verdict.kind,
      decidedAt: verdict.at,
      decidedBy: names.person(decision?.actorId),
      reason: decision?.reason ?? null,
      endedAt: verdict.endedAt as number,
      endedBy: names.person(ending?.actorId),
      endedHow: ending ? endedHowOf(ending) : null,
      endedReason: shownReason(ending),
      endActionId: verdict.endedByActionId ?? null,
      undo: ending ? (undoOf.get(ending._id) ?? null) : null,
      /** When its words were erased; `null` while they are kept (or no erasure row says when). */
      erasedAt: erasedComment
        ? ((target as Doc<'comments'>).erasedAt as number)
        : target === null
          ? (erase?.createdAt ?? null)
          : null,
      content: target === null || erasedComment ? null : contentOf(verdict.targetType, target),
      authorDeletedAt: target ? withdrawnAt(verdict.targetType, target) : null,
      ...placeOf(l, verdict.targetType, names),
      can: rowLevers(viewer, l, false),
    };
  });
  return pageOf(
    page,
    rows.map((l) => ({ key: l.verdict.endedAt as number, ct: l.verdict._creationTime })),
    {
      more: cut || found.length > rows.length,
      after,
      pending,
      endCursor: end.raw,
      whole: !cut && inRange.length === verdicts.length,
    },
  );
}

/**
 * **The Deleted list's one filter, before the hold check**: their own withdrawal (an alert, their
 * own retraction), and not an erased comment's placeholder — read by the list, its count and the
 * presence check alike; a decision holding it then sends it to Standing.
 */
function listedWithdrawal(kind: VerdictTargetType, doc: RecordContentDoc): boolean {
  return (
    withdrawnAt(kind, doc) !== null &&
    !(kind === 'comment' && (doc as Doc<'comments'>).erasedAt !== undefined)
  );
}

/** Rows of one kind a page asks for when the Deleted list is narrowed to it. */
export const DELETED_ALONE: Record<VerdictTargetType, number> = {
  report: 4,
  post: 2,
  comment: RECORD_PAGE,
  hazard: 4,
  accessAlert: RECORD_PAGE,
};

/**
 * **Deleted** — what the person took back themselves and no decision holds, newest first, all five
 * kinds in one list (or one kind with `targetType`): each with when they deleted it, when it is due
 * to be erased (`eraseAt`; `null` while an open flag holds it, its erasure is parked, or its clock
 * isn't set yet — not recorded), the body, and `can` (Keep on the record). An erased comment's
 * placeholder is not theirs any more, and an alert counts only when its author retracted it. The five
 * ranges are merged by position — each heavy kind a few rows a page — so a page ends where every
 * range is still known, and a short page is not the end: `isDone` is. Staff only.
 */
export const personDeleted = query({
  args: LIST_ARGS,
  handler: async (ctx, args) => {
    const viewer = await requireCapability(ctx, 'people.read');
    return deletedPage(ctx, viewer, args);
  },
});

/** `personDeleted`'s page, for a viewer already let in (the rounds test drives it on a counted context). */
export async function deletedPage(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  { userId, targetType, cursor, endCursor }: ListArgs,
) {
  const reads = sheetBudget(ctx);
  const pending = await recordPending(ctx, reads);
  const after = decodePosition(cursor);
  const end = endOf(endCursor);
  const kinds: readonly VerdictTargetType[] =
    targetType === undefined ? DELETED_KINDS : [targetType];
  const asks = kinds.map((kind) =>
    targetType === undefined ? DELETED_TAKE[kind] : DELETED_ALONE[kind],
  );
  const ranges = await Promise.all(
    kinds.map((kind, i) => deletedRange(ctx, reads, kind, userId, after, asks[i] as number)),
  );
  // Every row up to the first place a full range might still hold one before it: the earliest, in
  // the merged order, of the full ranges' last rows.
  let fence: Position | null = null;
  ranges.forEach((rows, i) => {
    const last = rows[rows.length - 1];
    if (last === undefined || rows.length < (asks[i] as number)) return;
    const key = deletedKey(kinds[i] as VerdictTargetType, last);
    if (fence === null || before(key, fence)) fence = key;
  });
  const limit = fence as Position | null;
  const candidates = ranges
    .flatMap((rows, i) => rows.map((doc) => ({ kind: kinds[i] as VerdictTargetType, doc })))
    .map((c) => ({ ...c, key: deletedKey(c.kind, c.doc) }))
    .filter((c) => limit === null || !before(limit, c.key))
    .sort((a, b) => (before(a.key, b.key) ? -1 : before(b.key, a.key) ? 1 : 0));
  // A pinned page's rows are those up to its end; it is whole only if every range is known that far.
  const inRange = candidates.filter((c) => within(end.at, c.key));
  const known = end.at === null || limit === null || !before(limit, end.at);
  const considered = inRange.slice(0, RECORD_PAGE_ROWS.n);
  // Each row: whether a decision holds it (then it is Standing's, not here); the Report a comment or
  // a Post names its body through, once a page; then the names — the first row whole before the rest.
  // A row the list leaves out (held, an erased comment's placeholder) moves the cursor on and needs
  // nothing more read: its Report and names would be read only to be dropped.
  type Candidate = (typeof candidates)[number];
  type Checked = Candidate & { held: boolean; report: Doc<'reports'> | null };
  const cache = newPageCache();
  const listed = (c: Candidate, held: boolean) => !held && listedWithdrawal(c.kind, c.doc);
  const reportOfRow = (c: Candidate, held: boolean) =>
    listed(c, held) ? reportIdOf(c.kind, c.doc) : null;
  const bodyOfRow = (c: Checked) => (listed(c, c.held) ? [bodyIdOf(c.kind, c.doc, c.report)] : []);
  const personOfRow = (c: Checked) =>
    listed(c, c.held) && c.kind === 'comment' ? [c.report?.authorId] : [];
  const whole = await headFirst(considered, async (some): Promise<Checked[]> => {
    const held = takeUntilNull(
      await reads.waves(
        some,
        () => ({ bytes: ROW_MAX.verdict, reads: 1 }),
        async (c, share) => ({
          c,
          held:
            (await share.read('verdict', () =>
              ctx.db
                .query('contentVerdicts')
                .withIndex('by_target_standing', (q) =>
                  q.eq('targetType', c.kind).eq('targetId', c.doc._id).eq('standing', true),
                )
                .first(),
            )) !== null,
        }),
        () => null,
      ),
    );
    const missed = await readReports(
      ctx,
      reads,
      held.map(({ c, held: h }) => reportOfRow(c, h)),
      cache,
    );
    const reached: Checked[] = [];
    for (const { c, held: h } of held) {
      const reportId = reportOfRow(c, h);
      if (reportId !== null && missed.has(reportId)) break;
      const report = reportId !== null ? (cache.reports.get(reportId) ?? null) : null;
      reached.push({ ...c, held: h, report });
    }
    const names = await readNames(
      ctx,
      reads,
      reached.flatMap(bodyOfRow),
      reached.flatMap(personOfRow),
      cache,
    );
    const done: Checked[] = [];
    for (const row of reached) {
      if (names.missed(bodyOfRow(row), personOfRow(row))) break;
      done.push(row);
    }
    return done;
  });
  const names = namesOf(cache);
  const shown = whole.filter((c) => listed(c, c.held));
  const page = shown.map((c) => ({
    targetType: c.kind,
    targetId: c.doc._id as string,
    deletedAt: withdrawnAt(c.kind, c.doc) as number,
    /** When it is due to be erased; `null` while something holds it or no clock is set yet. */
    eraseAt: c.doc.eraseAt ?? null,
    content: contentOf(c.kind, c.doc),
    ...placeOf({ target: c.doc, report: c.report }, c.kind, names),
    can: recordLevers(viewer, recordFactsOf(c.kind, c.doc, null)),
  }));
  return pageOf(
    page,
    whole.map((c) => c.key),
    {
      more: whole.length < candidates.length || limit !== null,
      after,
      pending,
      endCursor: end.raw,
      whole: known && whole.length === inRange.length,
    },
  );
}

/** A count to its cap: a floor when `capped`. */
type Count = { count: number; capped: boolean };

/**
 * Each withdrawn row's standing decision, in waves: a decision holds it (then it is Standing's, not
 * Deleted's), `null` when none does, `undefined` past what the budget left — the count and the
 * presence check read the holds alike.
 */
function standingHolds(
  ctx: QueryCtx,
  reads: ReadBudget,
  rows: readonly { kind: VerdictTargetType; doc: RecordContentDoc }[],
) {
  return reads.waves(
    rows,
    () => ({ bytes: ROW_MAX.verdict, reads: 1 }),
    ({ kind, doc }, share) =>
      share.read('verdict', () =>
        ctx.db
          .query('contentVerdicts')
          .withIndex('by_target_standing', (q) =>
            q.eq('targetType', kind).eq('targetId', doc._id).eq('standing', true),
          )
          .first(),
      ),
    (): Doc<'contentVerdicts'> | null | undefined => undefined,
  );
}

/**
 * Withdrawn Reports counted by real weight, at most this many bytes (the count's one `paginate`,
 * charged its cap and a document past it): a Report is a whole document at worst, a couple of KB in
 * fact, so the real weight reaches every Report a person deletes in a month.
 */
const DELETED_REPORT_BYTES = DOC_MAX / 2;
/** Withdrawn Reports the count reads at most (within {@link DELETED_REPORT_BYTES}). */
const DELETED_REPORT_ROWS = 100;
/**
 * Rows of each light kind the Deleted count reads, at most. With the Reversed count's 501 rows and the
 * Reports' cap, these reads take about 6.2 MiB of the budget's 11; the heavy kinds count in what is
 * left ({@link countHeavy}), and each row's hold check after them.
 */
const DELETED_COUNT_TAKE = { comment: 30, accessAlert: 30 } as const;

/** Steps of the heavy kinds' count, at most (each step reads its kind's whole share of what is left). */
export const HEAVY_STEPS = 7;

type Heavy = 'post' | 'hazard';

/**
 * A heavy kind's withdrawn rows, newest first, at or before `key` (all of them when `null`). The caller
 * takes from it inside its wave share, so the read is charged there.
 */
function heavyRange(
  ctx: QueryCtx,
  kind: Heavy,
  userId: Id<'profiles'>,
  key: number | null,
): { take(n: number): Promise<RecordContentDoc[]> } {
  if (kind === 'post') {
    return ctx.db
      .query('posts')
      .withIndex('by_author_deleted', (q) => {
        const b = q.eq('authorId', userId).gt('authorDeletedAt', 0);
        return key === null ? b : b.lte('authorDeletedAt', key);
      })
      .order('desc');
  }
  return ctx.db
    .query('hazards')
    .withIndex('by_author_deleted', (q) => {
      const b = q.eq('createdByUserId', userId).gt('authorDeletedAt', 0);
      return key === null ? b : b.lte('authorDeletedAt', key);
    })
    .order('desc');
}

/**
 * **The heavy kinds, counted by their real weight** — a Post or a hazard is a whole document at its
 * declared worst, a few KB in fact. Each kind reads, in steps after the last row read, as many rows as
 * its share of what is left affords at the worst case: every step reserves that and hands back what
 * the rows really weighed when it is done (`ReadBudget.waves`), so the next step's share is nearly as
 * large again, and the count reaches far past what one worst case allows. A kind is exact when its range ends; a floor (`full`) when it
 * reached {@link HEAVY_STEPS} or the budget couldn't reserve even one more row. Deterministic: each
 * step is one wave over the open kinds, in order, sized by what earlier steps really weighed.
 */
async function countHeavy(ctx: QueryCtx, reads: ReadBudget, userId: Id<'profiles'>) {
  const state = (['post', 'hazard'] as const).map((kind) => ({
    kind,
    rows: [] as RecordContentDoc[],
    k: 0,
    /** The rows already read at the last one's time: they come again first, and are passed over. */
    tied: 0,
    done: false,
    full: false,
  }));
  for (let step = 0; step < HEAVY_STEPS; step++) {
    const open = state.filter((s) => !s.done);
    if (open.length === 0) break;
    for (const s of open) {
      // Its share of what is left — never past it, so one kind can't starve the other — less the
      // rows it reads again at the last one's time.
      s.tied = tiedAtLast(s.kind, s.rows);
      const rowsLeft = Math.floor(reads.bytes / (open.length * ROW_MAX[s.kind]));
      s.k = rowsLeft - s.tied;
      if (s.k < 1) Object.assign(s, { done: true, full: true });
    }
    const asking = open.filter((s) => !s.done);
    const read = await reads.waves(
      asking,
      (s) => ({ bytes: (s.k + s.tied) * ROW_MAX[s.kind], reads: 1, docs: s.k + s.tied }),
      async (s, share) => {
        const last = s.rows[s.rows.length - 1];
        const key = last ? withdrawnAt(s.kind, last) : null;
        const n = s.k + s.tied;
        const rows = await share.take(s.kind, n, () =>
          heavyRange(ctx, s.kind, userId, key).take(n),
        );
        return rows.slice(s.tied);
      },
      () => null,
    );
    asking.forEach((s, i) => {
      const rows = read[i];
      // Never reached while the shares above sum to what is left; kept so a change to them can only
      // make the count a floor, never a miscount.
      if (rows === null || rows === undefined) {
        Object.assign(s, { done: true, full: true });
        return;
      }
      s.rows.push(...rows);
      if (rows.length < s.k) s.done = true;
    });
  }
  for (const s of state) if (!s.done) s.full = true;
  return state.map(({ kind, rows, full }) => ({ kind, rows, full }));
}

/** How many of `rows` (newest first) share the last one's withdrawal time. */
function tiedAtLast(kind: Heavy, rows: RecordContentDoc[]): number {
  const last = rows[rows.length - 1];
  if (last === undefined) return 0;
  const key = withdrawnAt(kind, last);
  let n = 0;
  for (
    let i = rows.length - 1;
    i >= 0 && withdrawnAt(kind, rows[i] as RecordContentDoc) === key;
    i--
  ) {
    n++;
  }
  return n;
}

/** A count by kind: the total, each kind's, and whether every figure is a floor. */
function byKindCount(
  kinds: VerdictTargetType[],
  capped: boolean,
): Count & { byKind: Record<VerdictTargetType, number> } {
  const byKind = zeroByKind();
  for (const k of kinds) byKind[k]++;
  return { count: kinds.length, capped, byKind };
}

/**
 * **The record sheet's counts** — the tabs' figures and the person page's *On the record* row:
 * `reversed` (the Reversed list's rows, to 500) and `deleted` (the Deleted list's rows, as far as the
 * read affords), each `{ count, capped, byKind }` — `capped` a floor ("500+"), never a guess — and
 * `pending: ['verdicts']` until the verdict backfill has run ("still being prepared", never a
 * number). Standing is `people.person`'s `hidden` (the same range, to 500). The row appears when any
 * of the three is non-zero, capped, or pending.
 *
 * Deleted counts whole documents (Convex has no index-only count): a withdrawn Report, Post or hazard
 * can each weigh a whole document, so the read counts Reports by their real weight (its one
 * `paginate`, {@link DELETED_REPORT_BYTES}) Posts and hazards by real weight in doubling steps
 * ({@link countHeavy}), at most {@link DELETED_COUNT_TAKE} of each light kind, and says `capped`
 * whenever any kind may hold more. Staff only.
 */
export const recordCounts = query({
  args: { userId: v.id('profiles') },
  handler: async (ctx, { userId }) => {
    await requireCapability(ctx, 'people.read');
    return countsOf(ctx, { userId });
  },
});

/** `recordCounts`' answer, for a viewer already let in (the rounds test drives it on a counted context). */
export async function countsOf(ctx: QueryCtx, { userId }: { userId: Id<'profiles'> }) {
  const reads = sheetBudget(ctx);
  const pending = await recordPending(ctx, reads);
  // The three ranges at once: each charges its worst case as it starts, in this order.
  const [reversedRows, reports, light] = await Promise.all([
    reads.take('verdict', VERDICT_COUNT_CAP + 1, (n) =>
      reversedQuery(ctx, userId, undefined, undefined, null).take(n),
    ),
    // Each kind's withdrawn rows, then which a decision holds (those are Standing's, not Deleted's).
    reads.capped(DELETED_REPORT_BYTES, DELETED_REPORT_ROWS, () =>
      ctx.db
        .query('reports')
        .withIndex('by_author_deleted', (q) => q.eq('authorId', userId).gt('authorDeletedAt', 0))
        .order('desc')
        .paginate({
          cursor: null,
          numItems: DELETED_REPORT_ROWS,
          maximumBytesRead: DELETED_REPORT_BYTES,
        }),
    ),
    Promise.all(
      (['comment', 'accessAlert'] as const).map((kind) =>
        deletedRange(ctx, reads, kind, userId, null, DELETED_COUNT_TAKE[kind]).then((rows) => ({
          kind,
          rows,
          full: rows.length >= DELETED_COUNT_TAKE[kind],
        })),
      ),
    ),
  ]);
  const reversed = byKindCount(
    reversedRows.slice(0, VERDICT_COUNT_CAP).map((r) => r.targetType),
    reversedRows.length > VERDICT_COUNT_CAP,
  );
  const others = [...light, ...(await countHeavy(ctx, reads, userId))];
  const all: { kind: VerdictTargetType; rows: RecordContentDoc[]; full: boolean }[] = [
    { kind: 'report', rows: reports.page, full: !reports.isDone },
    ...others,
  ];
  const withdrawn = all.flatMap(({ kind, rows }) =>
    rows.filter((doc) => listedWithdrawal(kind, doc)).map((doc) => ({ kind, doc })),
  );
  const held = await standingHolds(ctx, reads, withdrawn);
  const deleted = byKindCount(
    withdrawn.filter((_, i) => held[i] === null).map((w) => w.kind),
    held.some((h) => h === undefined) || all.some((a) => a.full),
  );
  return { reversed, deleted, pending };
}

/**
 * Rows of each kind the presence check looks at, at most: the Deleted list's first page leaves out
 * a row a decision holds and an erased comment's placeholder, so the check looks a little past them;
 * the heavy kinds (a whole document each at worst) one or two.
 */
const PRESENCE_LOOK: Record<VerdictTargetType, number> = {
  report: 2,
  post: 1,
  comment: 8,
  hazard: 1,
  accessAlert: 8,
};

/**
 * **Whether the person page draws *On the record*** — cheap enough to stay live on every person page,
 * where `recordCounts` is read only once the sheet is open: `{deleted, reversed, pending}`, whether
 * the Deleted list and the Reversed list would show at least one item. Reversed reads the first row of
 * the very range its list reads (`isReversed`'s rows); Deleted looks at the first few rows of each of
 * the five ranges its list merges, through the list's own filter (a decision holds it, an erased
 * placeholder, a moderator's retraction). When a range has more rows than it looked at and none it
 * read would show, the answer is `true`: the row appearing over an empty tab is honest, a missing row
 * is not. Never false while the list's first page has a row (a property holds that). Staff only.
 */
export const recordPresence = query({
  args: { userId: v.id('profiles') },
  handler: async (ctx, { userId }) => {
    await requireCapability(ctx, 'people.read');
    return presenceOf(ctx, { userId });
  },
});

/** `recordPresence`' answer, for a viewer already let in (the rounds test drives it). */
export async function presenceOf(ctx: QueryCtx, { userId }: { userId: Id<'profiles'> }) {
  const reads = sheetBudget(ctx);
  // The backfill check beside the ranges, not before them: every one charges as it starts, in this
  // order, so the page is one round of reads and then the holds.
  const [pending, reversedRows, ...ranges] = await Promise.all([
    recordPending(ctx, reads),
    reads.take('verdict', 1, (n) => reversedQuery(ctx, userId, undefined, undefined, null).take(n)),
    ...DELETED_KINDS.map((kind) =>
      deletedRange(ctx, reads, kind, userId, null, PRESENCE_LOOK[kind]).then((rows) => ({
        kind,
        rows,
        full: rows.length >= PRESENCE_LOOK[kind],
      })),
    ),
  ]);
  const candidates = ranges.flatMap(({ kind, rows }) =>
    rows.filter((doc) => listedWithdrawal(kind, doc)).map((doc) => ({ kind, doc })),
  );
  const held = await standingHolds(ctx, reads, candidates);
  // Shown: read, and no decision holds it (`null`). Unknown — a hold the budget couldn't check
  // (`undefined`), or a range with more rows than it looked at: true, never a missing row.
  const deleted = held.some((h) => !h) || ranges.some((r) => r.full);
  return {
    deleted,
    reversed: reversedRows.some((r) => isReversed(r)),
    pending,
  };
}

/** Decisions on one item the pane reads at most (an item gathers few; more says `decisionsCapped`). */
const ITEM_DECISIONS = 50;
/** Standing verdicts read on one item, at most (the writers keep one). */
const STANDING_ON_ITEM = 4;

/** Comments on a Report counted at most (what comes back with it), and its ratings. */
const COMES_BACK_COMMENTS = 50;
const COMES_BACK_RATINGS = 200;

/**
 * What a Report's restore brings back with it (boards 8.7–8.8): its comments still up — a hidden
 * Report hides its comments at read time, so they return with it — and its ratings, each counted to
 * its cap (a floor past it), both reads at once.
 */
async function comesBackWith(ctx: QueryCtx, reads: ReadBudget, reportId: Id<'reports'>) {
  const [comments, ratings] = await Promise.all([
    reads.take('comment', COMES_BACK_COMMENTS + 1, (n) =>
      ctx.db
        .query('comments')
        .withIndex('by_report', (q) => q.eq('reportId', reportId))
        .take(n),
    ),
    reads.take('small', COMES_BACK_RATINGS + 1, (n) =>
      ctx.db
        .query('reportRatings')
        .withIndex('by_target', (q) => q.eq('targetType', 'report').eq('targetId', reportId))
        .take(n),
    ),
  ]);
  // Up: shown, and still its author's words — not withdrawn, and not a departed author's emptied
  // shell (`redactedAt`), which comes back only as a placeholder.
  const up = comments
    .slice(0, COMES_BACK_COMMENTS)
    .filter(
      (c) =>
        c.moderationStatus === 'visible' &&
        c.authorDeletedAt === undefined &&
        c.redactedAt === undefined,
    );
  return {
    comments: { count: up.length, capped: comments.length > COMES_BACK_COMMENTS },
    ratings: {
      count: Math.min(ratings.length, COMES_BACK_RATINGS),
      capped: ratings.length > COMES_BACK_RATINGS,
    },
  };
}

/**
 * A Post's members as its restore reads them — each Report and, for one that is down, the newest row
 * on it — in waves, then the restore's own plan over them (`moderation.planPostRestore`) and whether
 * every member was withdrawn by its author (what an overturn asks). `undefined` past what the budget
 * left: the levers then say to check on the item, never a guess.
 */
async function postMembersOf(ctx: QueryCtx, reads: ReadBudget, post: Doc<'posts'>) {
  const read = await reads.waves(
    post.reportIds,
    () => ({ bytes: ROW_MAX.report + ROW_MAX.moderationAction, reads: 2 }),
    async (reportId, share) => {
      const report = await share.read('report', () => ctx.db.get(reportId));
      const last =
        report && report.moderationStatus !== 'visible'
          ? await share.read('moderationAction', () =>
              ctx.db
                .query('moderationActions')
                .withIndex('by_target', (q) =>
                  q.eq('targetType', 'report').eq('targetId', reportId),
                )
                .order('desc')
                .first(),
            )
          : null;
      return { reportId, report, last };
    },
    () => null,
  );
  const known = takeUntilNull(read);
  if (known.length < post.reportIds.length) return undefined;
  const byId = new Map(known.map((m) => [m.reportId as string, m]));
  const plan = await planPostRestore(
    ctx,
    post,
    {},
    {
      report: async (rid) => byId.get(rid)?.report ?? null,
      newest: async (rid) => byId.get(rid)?.last ?? null,
    },
  );
  return {
    everyWithdrawn: known.every((m) => m.report === null || m.report.authorDeletedAt !== undefined),
    plan: { visibleAfter: plan.visibleAfter, choosable: plan.choosable },
    // Its Reports up now — what a takedown of the Post would still move (`takedownRefusal`).
    up: known.filter((m) => m.report?.moderationStatus === 'visible').length,
  };
}

/**
 * **One item on the record, for the sheet's pane** — the item as published (`published`, the whole
 * document; `null` once erased, with `erasedAt`), when its author took it back and when it is due to
 * be erased, the body it is on, every decision on it newest first (who, when, why; how and by whom it
 * ended), and `can` — the lever its state offers this viewer, decided over a Post's members (Restore
 * needing a choice says `needsChoice`; the chooser is `moderation.postRestoreChoices`). Its life strip
 * is `moderation.listActions`. `null` for an item that never existed. Staff only (`content.read`).
 */
export const item = query({
  args: { targetType: literals(VERDICT_TARGETS), targetId: v.string() },
  handler: async (ctx, args) => itemPane(ctx, await requireCapability(ctx, 'content.read'), args),
});

/** `item`'s pane, for a viewer already let in (the pane's cost test drives it on a counted context). */
export async function itemPane(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  { targetType, targetId }: { targetType: VerdictTargetType; targetId: string },
) {
  {
    const reads = sheetBudget(ctx);
    const pending = await recordPending(ctx, reads);
    const id = targetIdOf(ctx, targetType, targetId);
    if (id === null) return null;
    // The decisions newest first by when they were made — selected in the order they are shown
    // (`by_target_at`, on the required `at`), never a window by insertion time sorted afterward — and,
    // beside them, the one that stands, however old (the writers keep at most one).
    const [target, newest, standingRows] = await Promise.all([
      reads.one(targetType, () => ctx.db.get(id)) as Promise<ContentDoc | null>,
      reads.take('verdict', ITEM_DECISIONS + 1, (n) =>
        ctx.db
          .query('contentVerdicts')
          .withIndex('by_target_at', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
          .order('desc')
          .take(n),
      ),
      reads.take('verdict', STANDING_ON_ITEM, (n) =>
        ctx.db
          .query('contentVerdicts')
          .withIndex('by_target_standing', (q) =>
            q.eq('targetType', targetType).eq('targetId', targetId).eq('standing', true),
          )
          .take(n),
      ),
    ]);
    const shownIds = new Set(newest.slice(0, ITEM_DECISIONS).map((d) => d._id as string));
    const decisions = [
      ...newest.slice(0, ITEM_DECISIONS),
      ...standingRows.filter((d) => !shownIds.has(d._id)),
    ].sort((a, b) => b.at - a.at || b._creationTime - a._creationTime);
    // Never anything on the record, and no item: nothing to show.
    if (target === null && decisions.length === 0) return null;
    // The kind of the one that stands (the writers keep at most one), `null` with none.
    const held = decisions.find((d) => d.standing)?.kind ?? null;
    const standing = held !== null;
    // Each decision's row and the row that ended it.
    const rows = await reads.waves(
      decisions,
      (d) => ({ bytes: (d.endedByActionId ? 2 : 1) * ROW_MAX.moderationAction, reads: 2 }),
      async (d, share) => {
        const endedBy = d.endedByActionId;
        const [decision, ending] = await Promise.all([
          share.read('moderationAction', () => ctx.db.get(d.actionId)),
          endedBy
            ? share.read('moderationAction', () => ctx.db.get(endedBy))
            : Promise.resolve(null),
        ]);
        return { d, decision, ending };
      },
      () => null,
    );
    const shown = takeUntilNull(rows);
    // The undo of the write that ended the item's newest decision, for this viewer — where the pane
    // offers one (B01-4h): only that decision's, and only while it is Reversed (ended, and nothing
    // newer minted since). Every older decision's ending was overtaken by the write that made a newer
    // one, so it has no undo to read. Main's engine, one row in view (`one`): its first step's calls
    // and documents reserved here, as Reversed's rows reserve theirs; a refusal that reads (content's,
    // what the row did to the record) is charged to the request's budget in the engine's waves.
    const newestShown = shown[0];
    const reversal =
      newestShown !== undefined && isReversed(newestShown.d) && newestShown.ending !== null
        ? newestShown.ending
        : null;
    let reversalUndo: UndoState | null = null;
    if (reversal !== null) {
      reads.reserveCalls(3, 18);
      reversalUndo = (await undoStates(ctx, viewer, [reversal], 'one', 'read'))[0] ?? null;
    }
    // The Report a comment or a Post is on; the erasure row of an item that is gone; a Post's
    // members, which decide its restore.
    const reportId = reportIdOf(targetType, target);
    const [report, erase] = await Promise.all([
      reportId !== null ? reads.one('report', () => ctx.db.get(reportId)) : Promise.resolve(null),
      target === null
        ? reads.measured('moderationAction', () =>
            ctx.db
              .query('moderationActions')
              .withIndex('by_target_action', (q) =>
                q.eq('targetType', targetType).eq('targetId', targetId).eq('action', 'erase'),
              )
              .order('desc')
              .first(),
          )
        : Promise.resolve(null),
    ]);
    // Only a standing verdict's lever (Restore or Overturn) rests on the members; with none standing
    // the levers never read them, so neither does the pane.
    const members =
      standing &&
      targetType === 'post' &&
      target !== null &&
      authorDeletedAtOf(target as Doc<'posts'>) === undefined
        ? await postMembersOf(ctx, reads, target as Doc<'posts'>)
        : undefined;
    const names = await readNames(
      ctx,
      reads,
      [bodyIdOf(targetType, target, report)],
      [
        ...shown.flatMap((r) => [r.decision?.actorId, r.ending?.actorId]),
        targetType === 'comment' ? report?.authorId : undefined,
      ],
    );
    const erasedComment =
      target !== null &&
      targetType === 'comment' &&
      (target as Doc<'comments'>).erasedAt !== undefined;
    // "If overturned": the clock the overturn would leave — the same `clockOf` the write's own clock
    // refresh runs, asked as if the item's standing verdicts were ended (its Post's and an open flag
    // still hold it, and then there is no date). Only while a decision stands to overturn.
    const eraseAtIfReleased =
      standing && target !== null && !erasedComment
        ? ((await clockOf(ctx, reads, targetType, target, Date.now(), { releasing: true })) ?? null)
        : null;
    // What a Report's restore brings back with it: its comments still up and its ratings, counted
    // (no documents returned) to their caps.
    const comesBack =
      targetType === 'report' && target !== null
        ? await comesBackWith(ctx, reads, target._id as Id<'reports'>)
        : null;
    return {
      targetType,
      targetId,
      /** The item as published — the whole document, read by staff — or `null` once erased. */
      published: target === null || erasedComment ? null : target,
      /** Its words, as every record row shows them (`contentOf`); `null` once erased. */
      content: target === null || erasedComment ? null : contentOf(targetType, target),
      /**
       * When it would be erased if its standing decision were overturned now — what the overturn
       * itself would return; `null` when nothing stands, it isn't withdrawn, or something else
       * (its Post's decision, an open flag) would still hold it. Withdrawn more than 30 days ago,
       * it is the moment this was read (a query's clock doesn't move on its own): read any date not
       * in the future as "at once".
       */
      eraseAtIfReleased,
      /** A Report's: what a restore brings back with it — counts and floors; `null` for other kinds. */
      comesBack,
      erasedAt: erasedComment
        ? ((target as Doc<'comments'>).erasedAt as number)
        : target === null
          ? (erase?.createdAt ?? null)
          : null,
      authorDeletedAt: target ? withdrawnAt(targetType, target) : null,
      eraseAt: target?.eraseAt ?? null,
      ...placeOf({ target, report }, targetType, names),
      decisions: shown.map(({ d, decision, ending }) => ({
        kind: d.kind,
        at: d.at,
        standing: d.standing,
        decidedBy: names.person(decision?.actorId),
        reason: decision?.reason ?? null,
        endedAt: d.endedAt ?? null,
        endedBy: names.person(ending?.actorId),
        endedHow: ending ? endedHowOf(ending) : null,
        endedReason: shownReason(ending),
        // Both optional — added for the pane's Undo (B01-4h), absent where there is nothing to say.
        /** The write that ended it — what its Undo undoes; absent while it stands. */
        ...(d.endedByActionId !== undefined ? { endActionId: d.endedByActionId } : {}),
        /**
         * That write's undo for this viewer — on the item's newest decision while it is Reversed (the
         * one the pane offers an Undo on); absent on every other, whose ending a newer decision's write
         * has overtaken, and on one that stands.
         */
        ...(ending !== null && ending === reversal && reversalUndo !== null
          ? { undo: reversalUndo }
          : {}),
      })),
      /** More decisions than the pane read (or the budget reached): these are the newest. */
      decisionsCapped: newest.length > ITEM_DECISIONS || shown.length < decisions.length,
      can: recordLevers(viewer, recordFactsOf(targetType, target, held, members)),
      pending,
    };
  }
}

/**
 * What the person withdrew themselves, of one kind, newest first, a page at a time — with when each is
 * due to be erased. Each range carries its lower bound: `authorDeletedAt` is optional, and an absent
 * value sorts first. An alert counts only when its author retracted it (a moderator's retraction is
 * not theirs to list). Staff only. (The record sheet reads `personDeleted`: every kind in one list.)
 */
export const personWithdrawals = query({
  args: {
    userId: v.id('profiles'),
    kind: literals(VERDICT_TARGETS),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { userId, kind, cursor }) => {
    await requireCapability(ctx, 'people.read');
    const reads = recordBudget();
    const opts = (numItems: number) => ({ cursor: cursor ?? null, numItems });
    const n = reads.rows(kind, RECORD_PAGE);
    const page = await (async () => {
      switch (kind) {
        case 'post':
          return reads.page(kind, n, (numItems) =>
            ctx.db
              .query('posts')
              .withIndex('by_author_deleted', (q) =>
                q.eq('authorId', userId).gt('authorDeletedAt', 0),
              )
              .order('desc')
              .paginate(opts(numItems)),
          );
        case 'report':
          return reads.page(kind, n, (numItems) =>
            ctx.db
              .query('reports')
              .withIndex('by_author_deleted', (q) =>
                q.eq('authorId', userId).gt('authorDeletedAt', 0),
              )
              .order('desc')
              .paginate(opts(numItems)),
          );
        case 'comment':
          return reads.page(kind, n, (numItems) =>
            ctx.db
              .query('comments')
              .withIndex('by_author_deleted', (q) =>
                q.eq('authorId', userId).gt('authorDeletedAt', 0),
              )
              .order('desc')
              .paginate(opts(numItems)),
          );
        case 'hazard':
          return reads.page(kind, n, (numItems) =>
            ctx.db
              .query('hazards')
              .withIndex('by_author_deleted', (q) =>
                q.eq('createdByUserId', userId).gt('authorDeletedAt', 0),
              )
              .order('desc')
              .paginate(opts(numItems)),
          );
        case 'accessAlert':
          return reads.page(kind, n, (numItems) =>
            ctx.db
              .query('accessAlerts')
              .withIndex('by_author_status_expires_at', (q) =>
                q.eq('createdByUserId', userId).eq('status', 'retracted'),
              )
              .order('desc')
              .paginate(opts(numItems)),
          );
      }
    })();
    const rows = (page.page as ContentDoc[]).filter(
      // An erased comment's placeholder is no longer anything they wrote; a moderator's retraction
      // of their alert is not their withdrawal.
      (row) =>
        !('erasedAt' in row && row.erasedAt !== undefined) && withdrawnAt(kind, row) !== null,
    );
    return {
      page: rows.map((row) => ({
        targetType: kind,
        targetId: row._id as string,
        deletedAt: withdrawnAt(kind, row) as number,
        eraseAt: row.eraseAt ?? null,
        content: contentOf(kind, row),
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

// ── The backfill (run once on each deployment after this ships) ──────────────────────────────────

const CONTENT_TYPES: ReadonlySet<string> = new Set(VERDICT_TARGETS);

const replayStateValidator = v.object({
  standing: v.union(
    v.null(),
    v.object({
      actionId: v.id('moderationActions'),
      kind: literals(['hidden', 'removed', 'retracted'] as const),
      at: v.number(),
    }),
  ),
  previousEnded: v.boolean(),
  reversed: v.optional(
    v.union(
      v.null(),
      v.object({
        actionId: v.id('moderationActions'),
        kind: literals(['hidden', 'removed', 'retracted'] as const),
        at: v.number(),
        endedAt: v.number(),
        endedByActionId: v.id('moderationActions'),
      }),
    ),
  ),
});
const resumeValidator = v.object({ cursor: v.union(v.string(), v.null()), skip: v.number() });

/**
 * Walk the audit log and rebuild every item's record from its **whole** history, through the live
 * writers' rules (`replayStep`): every verdict since the audit log began, including a takedown recorded
 * on content its author had already deleted (written as history only before the record existed).
 * Idempotent: a verdict row is keyed by its action and brought to what the replay says.
 *
 * Each item is replayed once, when the walk reaches its newest audit row, by
 * `replayVerdictHistory` — a job that reads the item's history to its end a page at a time, however
 * long, and hands the walk back where it left off. Nothing is guessed: there is no history too long to
 * read, so there is no fallback. The walk is one chain, so when its last page is done every item is
 * replayed, and only then does it start the erasure clocks' backfill, which must not run before the
 * verdicts that hold content back exist. Run once after deploy:
 * `convex run contentRecord:backfillVerdicts '{}'`.
 */
export const backfillVerdicts = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    /** Rows of the page at `cursor` already walked (a replay hands the walk back mid-page). */
    skip: v.optional(v.number()),
    pageSize: v.optional(v.number()),
    /** Test seam: stop after the record, without starting the clocks. */
    clocks: v.optional(v.boolean()),
    /** The People run this pass belongs to (`peopleJobs:backfillVerdicts`); absent when run by hand. */
    lease: LEASE_ARG,
  },
  handler: (ctx, args) =>
    traced('contentRecord.backfillVerdicts', args, async () => {
      const { cursor, skip = 0, pageSize, clocks } = args;
      const reads = new ReadBudget();
      // The run's lease, its row read and written once each.
      reads.reserve('small', 2);
      const lease = await chainedLease(ctx, 'verdicts', args.lease);
      if (lease === null) return { replaying: null, more: false, superseded: true };
      const size = Math.min(Math.max(pageSize ?? BACKFILL_PAGE, 1), BACKFILL_PAGE);
      // What one row may cost beside its own read, on its dearest branch: its item's newest row, the
      // item itself — looked up on every newest row, found or gone (Greptile #110: a page of rows whose
      // items were erased paid for the lookup on each and ran past a budget sized for one) — and, for
      // an item that is gone, one of its verdict rows, for whose record it is.
      const work = ROW_MAX.moderationAction + DOC_MAX + ROW_MAX.verdict;
      const page = await reads.page(
        'moderationAction',
        sizePage(reads, 'moderationAction', { cap: size, work }),
        (numItems) =>
          ctx.db
            .query('moderationActions')
            .order('asc')
            .paginate({ cursor: cursor ?? null, numItems }),
      );
      const carry = {
        ...(pageSize !== undefined ? { pageSize } : {}),
        ...(clocks !== undefined ? { clocks } : {}),
      };
      for (let i = skip; i < page.page.length; i++) {
        const row = page.page[i] as Doc<'moderationActions'>;
        if (!CONTENT_TYPES.has(row.targetType)) continue;
        const targetType = row.targetType as VerdictTargetType;
        const found = await reads.row(work, async () => {
          const newest = await reads.one('moderationAction', () =>
            ctx.db
              .query('moderationActions')
              .withIndex('by_target', (q) =>
                q.eq('targetType', targetType).eq('targetId', row.targetId),
              )
              .order('desc')
              .first(),
          );
          if (newest?._id !== row._id) return null;
          const target = await loadTarget(ctx, reads, targetType, row.targetId);
          if (target) return { subjectUserId: subjectOf(targetType, target) };
          // A verdict outlives its content (D248): an item that is gone — erased, most often — is
          // replayed all the same, and whose record its verdicts are on is read off a verdict row it
          // left, or else, in the replay, off its history: the person a moderator's action recorded,
          // or its author's own deletion.
          const left = await reads.one('verdict', () =>
            ctx.db
              .query('contentVerdicts')
              .withIndex('by_target_standing', (q) =>
                q.eq('targetType', targetType).eq('targetId', row.targetId),
              )
              .first(),
          );
          return { subjectUserId: left?.subjectUserId };
        });
        if (!found) continue;
        await ctx.scheduler.runAfter(0, internal.contentRecord.replayVerdictHistory, {
          targetType,
          targetId: row.targetId,
          ...(found.subjectUserId !== undefined ? { subjectUserId: found.subjectUserId } : {}),
          pass: 'scan' as const,
          resume: { cursor: cursor ?? null, skip: i + 1 },
          ...carry,
          ...(await handOn(ctx, lease, { cursor: cursor ?? null, gap: false })),
        });
        return { replaying: `${targetType}:${row.targetId}`, more: true };
      }
      if (!page.isDone) {
        await ctx.scheduler.runAfter(0, internal.contentRecord.backfillVerdicts, {
          cursor: page.continueCursor,
          ...carry,
          ...(await handOn(ctx, lease, { cursor: page.continueCursor, gap: false })),
        });
        return { replaying: null, more: true };
      }
      const handed = await handOn(ctx, lease, { cursor: null, gap: false });
      if (clocks !== false) {
        await ctx.scheduler.runAfter(0, internal.erasure.backfillClocks, handed);
      } else if (handed.lease !== undefined) {
        // The test seam with a run: the record is its whole range.
        await ctx.scheduler.runAfter(0, internal.peopleJobs.backfillVerdicts, {
          ...handed.lease,
          cursor: VERDICTS_DONE,
        });
      }
      return { replaying: null, more: false };
    }),
});

/**
 * What finishing a pass reads: whether the item is still there, the final verdict's row, and the
 * item's clock (`holdMoved`).
 */
const FINISH = 2 * ROW_MAX.verdict + 3 * DOC_MAX + HOLD_COST.report;

/**
 * Replay one item's whole history, oldest first, a page a transaction, carrying the replay's small
 * state (`ReplayState`) between them — then hand the audit walk back. Two passes, so no reader ever
 * sees the item less held than its history leaves it:
 *
 * 1. **scan** reads to the end and makes the verdict the history leaves standing stand (inserting it,
 *    or standing it up again), and moves the item's clock — only ever adding a hold.
 * 2. **write** reads it again and brings every other row to the history: a verdict the history ended
 *    is ended (inserted ended, if it was missing), and a row keyed by an action that mints nothing (an
 *    earlier build's) is deleted. The standing one is never touched here, so the item stays held
 *    throughout if its history holds it. Rows a moderator adds meanwhile are read too, at the end.
 */
export const replayVerdictHistory = internalMutation({
  args: {
    targetType: literals(VERDICT_TARGETS),
    targetId: v.string(),
    /**
     * Whose record the item's verdicts are on. Absent for an item that is gone and left no verdict
     * row: the scan reads it off the history — the person a moderator's action recorded, or the
     * author's own deletion — if anything there names them.
     */
    subjectUserId: v.optional(v.id('profiles')),
    pass: literals(['scan', 'write'] as const),
    cursor: v.optional(v.string()),
    state: v.optional(replayStateValidator),
    resume: resumeValidator,
    pageSize: v.optional(v.number()),
    clocks: v.optional(v.boolean()),
    /** The People run this pass belongs to (`peopleJobs:backfillVerdicts`); absent when run by hand. */
    lease: LEASE_ARG,
  },
  handler: (ctx, args) =>
    traced('contentRecord.replayVerdictHistory', args, async () => {
      const { targetType, targetId, pass, cursor, resume, pageSize, clocks } = args;
      let subjectUserId = args.subjectUserId;
      let unnamed = 0;
      const reads = new ReadBudget();
      // The run's lease: its row read here, again to hand it on, and once more when the pass found a
      // gap (`foundGap`).
      reads.reserve('small', 3);
      const lease = await chainedLease(ctx, 'verdicts', args.lease);
      if (lease === null) return { written: 0, more: false, superseded: true };
      // A row's work beside its read, in the write pass: the row keyed by it, the one it ends and the
      // reversed one it supersedes, each looked up and written. The finish is kept back.
      const work = 6 * ROW_MAX.verdict;
      const page = await reads.page(
        'moderationAction',
        sizePage(reads, 'moderationAction', {
          cap: pageSize ?? BACKFILL_PAGE,
          work,
          reserve: FINISH,
        }),
        (numItems) =>
          ctx.db
            .query('moderationActions')
            .withIndex('by_target', (q) => q.eq('targetType', targetType).eq('targetId', targetId))
            .order('asc')
            .paginate({ cursor: cursor ?? null, numItems }),
      );
      const upsert = async (verdict: ReplayedVerdict) => {
        const existing = await reads.one('verdict', () =>
          ctx.db
            .query('contentVerdicts')
            .withIndex('by_action', (q) => q.eq('actionId', verdict.actionId))
            .first(),
        );
        if (!existing) {
          // A verdict is on someone's record; one whose person can't be named is not made up.
          if (subjectUserId === undefined) {
            unnamed++;
            return 0;
          }
          await ctx.db.insert('contentVerdicts', {
            subjectUserId,
            targetType,
            targetId,
            ...verdict,
          });
          return 1;
        }
        if (
          existing.standing === verdict.standing &&
          existing.endedByActionId === verdict.endedByActionId &&
          existing.superseded === verdict.superseded
        ) {
          return 0;
        }
        reads.touch('verdict');
        await ctx.db.patch(existing._id, {
          standing: verdict.standing,
          endedAt: verdict.endedAt,
          endedByActionId: verdict.endedByActionId,
          superseded: verdict.superseded,
        });
        return 1;
      };
      let state: ReplayState = args.state ?? REPLAY_START;
      let written = 0;
      for (const row of page.page) {
        // For an item gone with no verdict row left: its author's own deletion names them, or the
        // person a verdict's action recorded it was on.
        if (subjectUserId === undefined) {
          const named = ((row.metadata ?? {}) as { subjectUserId?: Id<'profiles'> }).subjectUserId;
          if (named !== undefined) subjectUserId = named;
          else if (row.action === 'author_delete' && row.actorId) subjectUserId = row.actorId;
        }
        const step = replayStep(state, row);
        if (pass === 'write')
          await reads.row(work, async () => {
            if (!step.minted) {
              // A row keyed by an action that mints nothing is not what the rules make.
              const stray = await reads.one('verdict', () =>
                ctx.db
                  .query('contentVerdicts')
                  .withIndex('by_action', (q) => q.eq('actionId', row._id))
                  .first(),
              );
              if (stray) {
                reads.touch('verdict');
                await ctx.db.delete(stray._id);
                written++;
              }
            }
            // A verdict a reversal ended is the item's newest until a later one is minted, so it is
            // written once its flag is known — superseded, by the row that mints the next, or as the
            // history leaves it, at the end — never first unsuperseded and then superseded again,
            // which would rewrite a record already right on every run and report that as a gap.
            if (step.ended?.superseded) written += await upsert(step.ended);
            if (step.superseding) written += await upsert(step.superseding);
          });
        state = step.state;
      }
      const base = {
        targetType,
        targetId,
        ...(subjectUserId !== undefined ? { subjectUserId } : {}),
        resume,
        ...(pageSize !== undefined ? { pageSize } : {}),
        ...(clocks !== undefined ? { clocks } : {}),
      };
      // Said on every page that skipped one, not only the last: each page is its own transaction, and
      // a count kept to the end would lose what the earlier pages left unrebuilt.
      const sayUnnamed = () => {
        if (unnamed > 0) {
          console.error(
            `contentRecord.replayVerdictHistory: ${targetType} ${targetId} is gone and nothing left names its author; ${unnamed} verdict(s) of its history were not rebuilt`,
          );
        }
      };
      // Every pass that rewrote a verdict found what the backfill exists to fix.
      const handed = () => handOn(ctx, lease, { cursor: resume.cursor, gap: written > 0 });
      if (!page.isDone) {
        await ctx.scheduler.runAfter(0, internal.contentRecord.replayVerdictHistory, {
          ...base,
          pass,
          cursor: page.continueCursor,
          state,
          ...(await handed()),
        });
        sayUnnamed();
        return { written, more: true };
      }
      // The end of its history: what it leaves standing stands — whether or not the item is still
      // there, since a verdict outlives its content (D248) — and the clock follows, on an item that is.
      const standing = state.standing;
      // The write pass's last reversal, held back above: the item's newest decision, ended (never
      // beside a standing one, so the finish writes one or the other).
      const reversed = pass === 'write' ? (state.reversed ?? null) : null;
      await reads.row(FINISH, async () => {
        if (standing) written += await upsert({ ...standing, standing: true, superseded: false });
        else if (reversed) {
          written += await upsert({ ...reversed, standing: false, superseded: false });
        }
        if (await loadTarget(ctx, reads, targetType, targetId)) {
          await holdMoved(ctx, targetType, targetId, Date.now(), reads);
        }
      });
      sayUnnamed();
      if (pass === 'scan') {
        await ctx.scheduler.runAfter(0, internal.contentRecord.replayVerdictHistory, {
          ...base,
          pass: 'write' as const,
          ...(await handed()),
        });
      } else {
        await ctx.scheduler.runAfter(0, internal.contentRecord.backfillVerdicts, {
          cursor: resume.cursor,
          skip: resume.skip,
          ...(pageSize !== undefined ? { pageSize } : {}),
          ...(clocks !== undefined ? { clocks } : {}),
          ...(await handed()),
        });
      }
      return { written, more: pass === 'scan' };
    }),
});
