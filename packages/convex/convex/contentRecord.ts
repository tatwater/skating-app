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
  VERDICT_TABLE,
  type VerdictTargetType,
  zeroByKind,
} from './lib/contentVerdicts';
import { clockOf, ERASABLE, type ErasableDoc, HOLD_COST, holdMoved } from './lib/eraseClock';
import {
  chainedLease,
  handOn,
  LEASE_ARG,
  LEASE_READS,
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
  bodyIdOf,
  contentOf,
  decodePosition,
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
import { photoWithdrawnAt } from './lib/photoAccess';
import { type UndoState, undoStates } from './lib/undo';
import { literals } from './lib/validators';
import {
  isListedWithdrawal,
  refreshWithdrawalHold,
  WITHDRAWAL_HOLD_COST,
  type Withdrawal,
  withdrawalKey,
  withdrawalsAfter,
} from './lib/withdrawals';
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
  // A verdict's targets: what an author can withdraw (`lib/authorDeletion`), an alert its author
  // retracted, and a photo (B01-5e) — the verdict map names each one's table.
  const id = ctx.db.normalizeId(VERDICT_TABLE[targetType], targetId);
  if (!id) return null;
  return (await reads.one(targetType, () => ctx.db.get(id))) as ContentDoc | null;
}

/** The record's pages run beside the caller's own profile read (`requireCapability`). */
const _recordBudget = () => new ReadBudget(TX_BUDGET - ROW_MAX.profile);

const VERDICT_TARGETS = ['report', 'post', 'comment', 'hazard', 'accessAlert', 'photo'] as const;

/**
 * The request's one budget, opened before any helper charges it (`requestBudget`): the record's reads
 * and the undo engine's (`undoStates`) share it, beside the caller's own profile.
 */
const sheetBudget = (ctx: QueryCtx) => requestBudget(ctx, CHARGED_QUERY_BUDGET);

/**
 * Whether the verdict backfill (`peopleJobs:backfillVerdicts`, which also gives withdrawn content its
 * erasure clocks) is still to finish: until it has, a record list may miss a decision made before the
 * record existed, an item's newest decision may not be marked yet, and a withdrawal may have no clock
 * — the lists say `pending: ['verdicts']`, "still being prepared", never a short number. `also`
 * names what else a read rests on: the Deleted reads, the withdrawal rows (`withdrawals`, B01-4m).
 */
async function recordPending(
  ctx: QueryCtx,
  reads: ReadBudget,
  also: readonly PeopleBackfill[] = [],
): Promise<PeopleBackfill[]> {
  reads.reserve('small', PEOPLE_BACKFILLS.length);
  const { pending } = await readPending(ctx);
  return pending.filter((b) => b === 'verdicts' || also.includes(b));
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

/**
 * Whether a decision was an explicit *Keep on the record* — its own audit row's word
 * (`keptOnRecord`, written by the keep and by nothing else: `moderation.recordOnWithdrawn`,
 * `accessAlerts.recordAlertVerdict`). An ordinary hide, removal or retraction that lands on content
 * already withdrawn is `false`, though it is on withdrawn content too; `null` when the audit row can't
 * be read (not recorded — never a guess from timing).
 */
function keptOf(decision: Doc<'moderationActions'> | null): boolean | null {
  if (decision === null) return null;
  return (decision.metadata as { keptOnRecord?: unknown } | undefined)?.keptOnRecord === true;
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
      /** An explicit Keep on the record (`keptOf`); `null` when its audit row can't be read. */
      kept: keptOf(decision),
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
      /** An explicit Keep on the record (`keptOf`); `null` when its audit row can't be read. */
      kept: keptOf(decision),
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
 * **Deleted** — what the person took back themselves and no decision holds, newest first, all five
 * kinds in one list (or one kind with `targetType`): each with when they deleted it, when it is due
 * to be erased (`eraseAt`; `null` while an open flag holds it, its erasure is parked, or its clock
 * isn't set yet — not recorded), the body, and `can` (Keep on the record). An erased comment's
 * placeholder is not theirs any more, and an alert counts only when its author retracted it.
 *
 * One index range of the person's withdrawal rows (`lib/withdrawals`, B01-4m), in the list's order —
 * withdrawal time, then the kind's place, then the newer item — so a page reads its rows, then each
 * item in waves (a Report, a Post or a hazard can weigh a whole document) and ends where the budget
 * does: a short page is not the end, `isDone` is. Until the withdrawals backfill has concluded it
 * says `pending: ['withdrawals']`. Staff only.
 */
export const personDeleted = query({
  args: LIST_ARGS,
  handler: async (ctx, args) => {
    const viewer = await requireCapability(ctx, 'people.read');
    return deletedPage(ctx, viewer, args);
  },
});

/** What the Deleted reads rest on beyond the record itself: the withdrawal rows' backfill. */
const DELETED_PENDING: PeopleBackfill[] = ['withdrawals'];

/** `personDeleted`'s page, for a viewer already let in (the rounds test drives it on a counted context). */
export async function deletedPage(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  { userId, targetType, cursor, endCursor }: ListArgs,
) {
  const reads = sheetBudget(ctx);
  const pending = await recordPending(ctx, reads, DELETED_PENDING);
  const after = decodePosition(cursor);
  const end = endOf(endCursor);
  // One range in the list's order; a row past a page's worth says whether more follow.
  // A photo is never on the Deleted list (`lib/recordReads.withdrawnAt`): its tab is empty.
  const rows =
    targetType === 'photo'
      ? []
      : await withdrawalsAfter(ctx, reads, userId, targetType, after, RECORD_PAGE_ROWS.n + 1);
  // A pinned page's rows are those up to its end; it is whole when it returned every one of them.
  const inRange = rows.filter((row) => within(end.at, withdrawalKey(row)));
  const considered = inRange.slice(0, RECORD_PAGE_ROWS.n);
  // Each row: its item, the Report a comment or a Post names its body through (once a page), then
  // the names — the first row whole before the rest. A row whose item doesn't read as withdrawn (a
  // writer's slip; never expected) moves the cursor on and shows nothing.
  type Loaded = { row: Withdrawal; doc: RecordContentDoc | null; report: Doc<'reports'> | null };
  const cache = newPageCache();
  const listed = (l: { row: Withdrawal; doc: RecordContentDoc | null }) =>
    l.doc !== null && isListedWithdrawal(l.row.targetType, l.doc);
  const reportOfRow = (l: { row: Withdrawal; doc: RecordContentDoc | null }) =>
    listed(l) ? reportIdOf(l.row.targetType, l.doc) : null;
  const bodyOfRow = (l: Loaded) => (listed(l) ? [bodyIdOf(l.row.targetType, l.doc, l.report)] : []);
  const personOfRow = (l: Loaded) =>
    listed(l) && l.row.targetType === 'comment' ? [l.report?.authorId] : [];
  const whole = await headFirst(considered, async (some): Promise<Loaded[]> => {
    const docs = takeUntilNull(
      await reads.waves(
        some,
        (row) => ({ bytes: ROW_MAX[row.targetType], reads: 1 }),
        async (row, share) => {
          const id = targetIdOf(ctx, row.targetType, row.targetId);
          const doc = id
            ? ((await share.read(row.targetType, () => ctx.db.get(id))) as RecordContentDoc | null)
            : null;
          return { row, doc };
        },
        () => null,
      ),
    );
    const missed = await readReports(ctx, reads, docs.map(reportOfRow), cache);
    const reached: Loaded[] = [];
    for (const l of docs) {
      const reportId = reportOfRow(l);
      if (reportId !== null && missed.has(reportId)) break;
      reached.push({
        ...l,
        report: reportId !== null ? (cache.reports.get(reportId) ?? null) : null,
      });
    }
    const names = await readNames(
      ctx,
      reads,
      reached.flatMap(bodyOfRow),
      reached.flatMap(personOfRow),
      cache,
    );
    const done: Loaded[] = [];
    for (const l of reached) {
      if (names.missed(bodyOfRow(l), personOfRow(l))) break;
      done.push(l);
    }
    return done;
  });
  const names = namesOf(cache);
  const page = whole.flatMap((l) => {
    if (!listed(l)) return [];
    const kind = l.row.targetType;
    const doc = l.doc as RecordContentDoc;
    return [
      {
        targetType: kind,
        targetId: l.row.targetId,
        deletedAt: l.row.withdrawnAt,
        /** When it is due to be erased; `null` while something holds it or no clock is set yet. */
        eraseAt: (doc as { eraseAt?: number }).eraseAt ?? null,
        content: contentOf(kind, doc),
        ...placeOf({ target: doc, report: l.report }, kind, names),
        can: recordLevers(viewer, recordFactsOf(kind, doc, null)),
      },
    ];
  });
  return pageOf(
    page,
    whole.map((l) => withdrawalKey(l.row)),
    {
      more: whole.length < rows.length,
      after,
      pending,
      endCursor: end.raw,
      whole: whole.length === inRange.length,
    },
  );
}

/** A count to its cap: a floor when `capped`. */
type Count = { count: number; capped: boolean };

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
 * Withdrawals the Deleted count reads at most: exact to this many, a floor ("500+") past it — the
 * Reversed count's cap. Each row is about 250 bytes (1 KiB declared), so the whole count reserves
 * half a MiB.
 */
export const DELETED_COUNT_CAP = VERDICT_COUNT_CAP;

/**
 * **The record sheet's counts** — the tabs' figures and the person page's *On the record* row:
 * `reversed` (the Reversed list's rows, to 500) and `deleted` (the Deleted list's rows, to
 * {@link DELETED_COUNT_CAP}), each `{ count, capped, byKind }` — `capped` a floor ("500+"), never a
 * guess — and `pending` (`verdicts`, and `withdrawals` until the withdrawal rows' backfill has run:
 * "still being prepared", never a number). Standing is `people.person`'s `hidden` (the same range, to
 * 500). The row appears when any of the three is non-zero, capped, or pending.
 *
 * Deleted is exact: one index range of the person's unheld withdrawal rows (`lib/withdrawals`), the
 * very rows the Deleted list pages through — an erased comment's shell has none, and a decision
 * holding an item takes it out of the range. Staff only.
 */
export const recordCounts = query({
  args: { userId: v.id('profiles') },
  handler: async (ctx, { userId }) => {
    await requireCapability(ctx, 'people.read');
    return countsOf(ctx, { userId });
  },
});

/** The person's unheld withdrawal rows, newest first, up to `n` — the Deleted list's whole range. */
function unheldWithdrawals(
  ctx: QueryCtx,
  reads: ReadBudget,
  userId: Id<'profiles'>,
  n: number,
): Promise<Withdrawal[]> {
  return reads.take('withdrawal', n, (k) =>
    ctx.db
      .query('contentWithdrawals')
      .withIndex('by_subject_held', (q) => q.eq('subjectUserId', userId).eq('held', false))
      .order('desc')
      .take(k),
  );
}

/** `recordCounts`' answer, for a viewer already let in (the rounds test drives it on a counted context). */
export async function countsOf(ctx: QueryCtx, { userId }: { userId: Id<'profiles'> }) {
  const reads = sheetBudget(ctx);
  const pending = await recordPending(ctx, reads, DELETED_PENDING);
  const [reversedRows, deletedRows] = await Promise.all([
    reads.take('verdict', VERDICT_COUNT_CAP + 1, (n) =>
      reversedQuery(ctx, userId, undefined, undefined, null).take(n),
    ),
    unheldWithdrawals(ctx, reads, userId, DELETED_COUNT_CAP + 1),
  ]);
  const reversed = byKindCount(
    reversedRows.slice(0, VERDICT_COUNT_CAP).map((r) => r.targetType),
    reversedRows.length > VERDICT_COUNT_CAP,
  );
  const deleted = byKindCount(
    deletedRows.slice(0, DELETED_COUNT_CAP).map((r) => r.targetType),
    deletedRows.length > DELETED_COUNT_CAP,
  );
  return { reversed, deleted, pending };
}

/**
 * **Whether the person page draws *On the record*** — cheap enough to stay live on every person page,
 * where `recordCounts` is read only once the sheet is open: `{deleted, reversed, pending}`, whether
 * the Deleted list and the Reversed list would show at least one item. Each reads the first row of
 * the very range its list reads (`isReversed`'s rows; the person's unheld withdrawal rows), so it is
 * exact both ways. Staff only.
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
  // The backfill check beside the ranges, not before them: one round of reads.
  const [pending, reversedRows, deletedRows] = await Promise.all([
    recordPending(ctx, reads, DELETED_PENDING),
    reads.take('verdict', 1, (n) => reversedQuery(ctx, userId, undefined, undefined, null).take(n)),
    unheldWithdrawals(ctx, reads, userId, 1),
  ]);
  return {
    deleted: deletedRows.length > 0,
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
 * A photo's facts beyond its row (B01-5e): whether its uploader withdrew it — one point read on its
 * audit rows, measured; past the budget it stays `unknown` and the lever points at the item.
 */
async function photoFactsOf(
  ctx: QueryCtx,
  reads: ReadBudget,
  photo: Doc<'photos'>,
): Promise<{ photoWithdrawn?: boolean }> {
  const at = await reads.measured('moderationAction', () => photoWithdrawnAt(ctx, photo._id));
  return at === undefined ? {} : { photoWithdrawn: at !== null };
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
        : target !== null && targetType === 'photo'
          ? await photoFactsOf(ctx, reads, target as Doc<'photos'>)
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
    // A photo has no erasure clock: its bytes follow the purge (`purgeAt`), not this.
    const eraseAtIfReleased =
      standing && target !== null && !erasedComment && targetType !== 'photo'
        ? ((await clockOf(ctx, reads, targetType, target as ErasableDoc, Date.now(), {
            releasing: true,
          })) ?? null)
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
      eraseAt: (target as { eraseAt?: number } | null)?.eraseAt ?? null,
      /** A photo's purge (D222): when its bytes go, and when they went — `null` on anything else. */
      purgeAt: targetType === 'photo' ? ((target as Doc<'photos'> | null)?.purgeAt ?? null) : null,
      purgedAt:
        targetType === 'photo' ? ((target as Doc<'photos'> | null)?.purgedAt ?? null) : null,
      ...placeOf({ target, report }, targetType, names),
      decisions: shown.map(({ d, decision, ending }) => ({
        kind: d.kind,
        at: d.at,
        standing: d.standing,
        decidedBy: names.person(decision?.actorId),
        reason: decision?.reason ?? null,
        /** An explicit Keep on the record (`keptOf`); `null` when its audit row can't be read. */
        kept: keptOf(decision),
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
      // The run's lease: taken and handed on, its run row and progress read each time.
      reads.reserve('small', LEASE_READS);
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
const FINISH = 2 * ROW_MAX.verdict + 3 * DOC_MAX + HOLD_COST.report + WITHDRAWAL_HOLD_COST;

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
      // The run's lease: its run row and progress read here and again to hand it on, and the run row
      // once more when the pass found a gap (`foundGap`).
      reads.reserve('small', LEASE_READS);
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
        // A verdict this page ended moves the item's Deleted row (`lib/withdrawals`), inside the
        // finish the page was sized to keep back.
        if (written > 0) {
          await reads.row(WITHDRAWAL_HOLD_COST, () =>
            refreshWithdrawalHold(ctx, targetType, targetId, reads),
          );
        }
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
        // Whatever this transaction wrote, the item's Deleted row follows (`lib/withdrawals`).
        if (written > 0) await refreshWithdrawalHold(ctx, targetType, targetId, reads);
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
