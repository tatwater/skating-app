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
  REPLAY_START,
  REVERSED_INDEX,
  type ReplayedVerdict,
  type ReplayState,
  replayStep,
  subjectOf,
  VERDICT_COUNT_CAP,
  type VerdictTargetType,
} from './lib/contentVerdicts';
import { ERASABLE, HOLD_COST, holdMoved } from './lib/eraseClock';
import {
  chainedLease,
  handOn,
  LEASE_ARG,
  PEOPLE_BACKFILLS,
  type PeopleBackfill,
  readPreparation,
  VERDICTS_DONE,
} from './lib/peopleRuns';
import {
  CHARGED_QUERY_BUDGET,
  DOC_MAX,
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
  type Position,
  RECORD_PAGE,
  type RecordContentDoc,
  readNames,
  reportIdOf,
  takeAfter,
  takeUntilNull,
  targetIdOf,
  type VerdictLoad,
  withdrawnAt,
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
  const { pending } = await readPreparation(ctx);
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
 * Reversed, by its index: each item's newest decision once ended (`lib/contentVerdicts.isReversed`,
 * and its one-line flip, `REVERSED_INDEX`). Every range keeps its lower bound — a standing verdict
 * lacks `endedAt`, which sorts first. Over `by_subject_ended` a kind is filtered after the read
 * ({@link reversedKind}); the flag's own index has the kind in it.
 */
function reversedQuery(
  ctx: QueryCtx,
  userId: Id<'profiles'>,
  targetType: VerdictTargetType | undefined,
  key: number | undefined,
  tieCt: number | null,
) {
  const verdicts = ctx.db.query('contentVerdicts');
  if (REVERSED_INDEX === 'by_subject_ended') {
    return verdicts
      .withIndex('by_subject_ended', (q) => {
        const b = q.eq('subjectUserId', userId);
        if (key === undefined) return b.gt('endedAt', 0);
        return tieCt !== null
          ? b.eq('endedAt', key).lt('_creationTime', tieCt)
          : b.gt('endedAt', 0).lt('endedAt', key);
      })
      .order('desc');
  }
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

/** The rows of one kind among a Reversed read (only over `by_subject_ended`, which has no kind). */
const reversedKind =
  (targetType: VerdictTargetType | undefined) => (rows: Doc<'contentVerdicts'>[]) =>
    targetType === undefined || REVERSED_INDEX !== 'by_subject_ended'
      ? rows
      : rows.filter((r) => r.targetType === targetType);

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
  return list === 'reversed' ? reversedKind(targetType)(rows) : rows;
}

/** A record list's arguments: whose record, one kind or all, and where the last page ended. */
interface ListArgs {
  userId: Id<'profiles'>;
  targetType?: VerdictTargetType;
  cursor?: string | null;
}

/** The levers on an item as a list row sees it (its members unread: `lib/recordRules`). */
function rowLevers(viewer: RecordViewer, load: VerdictLoad, standing: boolean): RecordLevers {
  return recordLevers(viewer, recordFactsOf(load.verdict.targetType, load.target, standing));
}

/** How a decision was ended, read off the row that ended it. */
function endedHowOf(ending: Doc<'moderationActions'>): 'restore' | 'undo' | 'overturn' {
  if (ending.action === 'overturn_verdict') return 'overturn';
  return ending.undoesActionId !== undefined ? 'undo' : 'restore';
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

/** A page's verdicts, read whole as far as the budget reaches, and named. */
async function shapeVerdictPage(
  ctx: QueryCtx,
  reads: ReadBudget,
  verdicts: Doc<'contentVerdicts'>[],
  ended: boolean,
) {
  const loaded = await loadVerdicts(ctx, reads, verdicts, { ended });
  const bodiesOf = (l: VerdictLoad) => [bodyIdOf(l.verdict.targetType, l.target, l.report)];
  const peopleOf = (l: VerdictLoad) => [
    l.decision?.actorId,
    l.ending?.actorId,
    l.verdict.targetType === 'comment' ? l.report?.authorId : undefined,
  ];
  const names = await readNames(
    ctx,
    reads,
    loaded.rows.flatMap(bodiesOf),
    loaded.rows.flatMap(peopleOf),
  );
  const whole: VerdictLoad[] = [];
  for (const l of loaded.rows) {
    if (names.missed(bodiesOf(l), peopleOf(l))) break;
    whole.push(l);
  }
  return { rows: whole, names, cut: whole.length < verdicts.length };
}

/** A page's answer: its rows, whether more follow, the cursor after its last row, and `pending`. */
function pageOf<R>(
  page: R[],
  keys: Position[],
  { more, after, pending }: { more: boolean; after: Position | null; pending: PeopleBackfill[] },
) {
  const last = keys[keys.length - 1];
  return {
    page,
    isDone: !more,
    continueCursor: last ? encodePosition(last) : after ? encodePosition(after) : '',
    pending,
  };
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
  args: {
    userId: v.id('profiles'),
    targetType: v.optional(literals(VERDICT_TARGETS)),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { userId, targetType, cursor }) => {
    const viewer = await requireCapability(ctx, 'people.read');
    return standingPage(ctx, viewer, { userId, targetType, cursor });
  },
});

/** `personVerdicts`'s page, for a viewer already let in (the rounds test drives it on a counted context). */
export async function standingPage(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  { userId, targetType, cursor }: ListArgs,
) {
  const reads = sheetBudget(ctx);
  const pending = await recordPending(ctx, reads);
  const after = decodePosition(cursor);
  const found = await verdictRange(
    ctx,
    reads,
    'standing',
    userId,
    targetType,
    after,
    RECORD_PAGE + 1,
  );
  const verdicts = found.slice(0, RECORD_PAGE);
  const { rows, names, cut } = await shapeVerdictPage(ctx, reads, verdicts, false);
  const page = rows.map((l) => {
    const { verdict, decision, target } = l;
    return {
      targetType: verdict.targetType,
      targetId: verdict.targetId,
      kind: verdict.kind,
      at: verdict.at,
      reason: decision?.reason ?? null,
      byUserId: decision?.actorId ?? null,
      decidedBy: names.person(decision?.actorId),
      content: target ? contentOf(verdict.targetType, target) : null,
      authorDeletedAt: target ? withdrawnAt(verdict.targetType, target) : null,
      ...placeOf(l, verdict.targetType, names),
      can: rowLevers(viewer, l, true),
    };
  });
  return pageOf(
    page,
    rows.map((l) => ({ key: l.verdict.at, ct: l.verdict._creationTime })),
    { more: cut || found.length > RECORD_PAGE, after, pending },
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
  args: {
    userId: v.id('profiles'),
    targetType: v.optional(literals(VERDICT_TARGETS)),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { userId, targetType, cursor }) => {
    const viewer = await requireCapability(ctx, 'people.read');
    return reversedPage(ctx, viewer, { userId, targetType, cursor });
  },
});

/** `personReversed`'s page, for a viewer already let in (the rounds test drives it on a counted context). */
export async function reversedPage(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  { userId, targetType, cursor }: ListArgs,
) {
  const reads = sheetBudget(ctx);
  const pending = await recordPending(ctx, reads);
  const after = decodePosition(cursor);
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
    RECORD_PAGE + 1,
  );
  const verdicts = found.slice(0, RECORD_PAGE);
  const { rows, names, cut } = await shapeVerdictPage(ctx, reads, verdicts, true);
  const endings = rows.flatMap((l) => (l.ending ? [l.ending] : []));
  const states = await undoStates(ctx, viewer, endings);
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
    { more: cut || found.length > RECORD_PAGE, after, pending },
  );
}

/** Rows of one kind a page asks for when the Deleted list is narrowed to it. */
const DELETED_ALONE: Record<VerdictTargetType, number> = {
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
  args: {
    userId: v.id('profiles'),
    targetType: v.optional(literals(VERDICT_TARGETS)),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { userId, targetType, cursor }) => {
    const viewer = await requireCapability(ctx, 'people.read');
    return deletedPage(ctx, viewer, { userId, targetType, cursor });
  },
});

/** `personDeleted`'s page, for a viewer already let in (the rounds test drives it on a counted context). */
export async function deletedPage(
  ctx: QueryCtx,
  viewer: Doc<'profiles'>,
  { userId, targetType, cursor }: ListArgs,
) {
  const reads = sheetBudget(ctx);
  const pending = await recordPending(ctx, reads);
  const after = decodePosition(cursor);
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
  const considered = candidates.slice(0, RECORD_PAGE);
  // Each row: whether a decision holds it (then it is Standing's, not here), and the Report a
  // comment or a Post names its body through.
  const checked = await reads.waves(
    considered,
    (c) => ({
      bytes: ROW_MAX.verdict + (reportIdOf(c.kind, c.doc) !== null ? ROW_MAX.report : 0),
      reads: reportIdOf(c.kind, c.doc) !== null ? 2 : 1,
    }),
    async (c, share) => {
      const reportId = reportIdOf(c.kind, c.doc);
      const [held, report] = await Promise.all([
        share.read('verdict', () =>
          ctx.db
            .query('contentVerdicts')
            .withIndex('by_target_standing', (q) =>
              q.eq('targetType', c.kind).eq('targetId', c.doc._id).eq('standing', true),
            )
            .first(),
        ),
        reportId !== null
          ? share.read('report', () => ctx.db.get(reportId))
          : Promise.resolve(null),
      ]);
      return { ...c, held: held !== null, report };
    },
    () => null,
  );
  const read = takeUntilNull(checked);
  const bodyOfRow = (c: (typeof read)[number]) => [bodyIdOf(c.kind, c.doc, c.report)];
  const personOfRow = (c: (typeof read)[number]) => [
    c.kind === 'comment' ? c.report?.authorId : undefined,
  ];
  const names = await readNames(ctx, reads, read.flatMap(bodyOfRow), read.flatMap(personOfRow));
  const whole: typeof read = [];
  for (const c of read) {
    if (names.missed(bodyOfRow(c), personOfRow(c))) break;
    whole.push(c);
  }
  const shown = whole.filter(
    (c) =>
      !c.held &&
      withdrawnAt(c.kind, c.doc) !== null &&
      !(c.kind === 'comment' && (c.doc as Doc<'comments'>).erasedAt !== undefined),
  );
  const page = shown.map((c) => ({
    targetType: c.kind,
    targetId: c.doc._id as string,
    deletedAt: withdrawnAt(c.kind, c.doc) as number,
    /** When it is due to be erased; `null` while something holds it or no clock is set yet. */
    eraseAt: c.doc.eraseAt ?? null,
    content: contentOf(c.kind, c.doc),
    ...placeOf({ target: c.doc, report: c.report }, c.kind, names),
    can: recordLevers(viewer, recordFactsOf(c.kind, c.doc, false)),
  }));
  return pageOf(
    page,
    whole.map((c) => c.key),
    { more: whole.length < candidates.length || limit !== null, after, pending },
  );
}

/** A count to its cap: a floor when `capped`. */
type Count = { count: number; capped: boolean };

/**
 * Withdrawn Reports counted by real weight, at most this many bytes (the count's one `paginate`,
 * charged its cap and a document past it): a Report is a whole document at worst, a couple of KB in
 * fact, so the real weight reaches every Report a person deletes in a month.
 */
const DELETED_REPORT_BYTES = DOC_MAX / 2;
/** Withdrawn Reports the count reads at most (within {@link DELETED_REPORT_BYTES}). */
const DELETED_REPORT_ROWS = 100;
/**
 * Rows of each other kind the Deleted count reads, at most — a Post or a hazard is a whole document at
 * worst, so two (one withdrawn is exact; two or more, a floor). With the Reversed count's 501 rows and
 * the Reports' cap, the reads take about 10.7 MiB of the budget's 11; each row's hold check takes what
 * is left, and a row it can't reach makes the count a floor.
 */
const DELETED_COUNT_TAKE: Record<Exclude<VerdictTargetType, 'report'>, number> = {
  post: 2,
  hazard: 2,
  comment: 30,
  accessAlert: 30,
};

/** A count by kind: the total, each kind's, and whether every figure is a floor. */
function byKindCount(
  kinds: VerdictTargetType[],
  capped: boolean,
): Count & { byKind: Record<VerdictTargetType, number> } {
  const byKind: Record<VerdictTargetType, number> = {
    report: 0,
    post: 0,
    comment: 0,
    hazard: 0,
    accessAlert: 0,
  };
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
 * `paginate`, {@link DELETED_REPORT_BYTES}) and at most {@link DELETED_COUNT_TAKE} of each other kind,
 * and says `capped` whenever any kind may hold more. Staff only.
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
  const reversedRows = await reads.take('verdict', VERDICT_COUNT_CAP + 1, (n) =>
    reversedQuery(ctx, userId, undefined, undefined, null).take(n),
  );
  const reversed = byKindCount(
    reversedRows.slice(0, VERDICT_COUNT_CAP).map((r) => r.targetType),
    reversedRows.length > VERDICT_COUNT_CAP,
  );
  // Each kind's withdrawn rows, then which a decision holds (those are Standing's, not Deleted's).
  const reports = await reads.capped(DELETED_REPORT_BYTES, DELETED_REPORT_ROWS, () =>
    ctx.db
      .query('reports')
      .withIndex('by_author_deleted', (q) => q.eq('authorId', userId).gt('authorDeletedAt', 0))
      .order('desc')
      .paginate({
        cursor: null,
        numItems: DELETED_REPORT_ROWS,
        maximumBytesRead: DELETED_REPORT_BYTES,
      }),
  );
  const others = await Promise.all(
    (['post', 'comment', 'hazard', 'accessAlert'] as const).map((kind) =>
      deletedRange(ctx, reads, kind, userId, null, DELETED_COUNT_TAKE[kind]).then((rows) => ({
        kind,
        rows,
        full: rows.length >= DELETED_COUNT_TAKE[kind],
      })),
    ),
  );
  const all: { kind: VerdictTargetType; rows: RecordContentDoc[]; full: boolean }[] = [
    { kind: 'report', rows: reports.page, full: !reports.isDone },
    ...others,
  ];
  const withdrawn = all.flatMap(({ kind, rows }) =>
    rows
      .filter(
        (doc) =>
          withdrawnAt(kind, doc) !== null &&
          !(kind === 'comment' && (doc as Doc<'comments'>).erasedAt !== undefined),
      )
      .map((doc) => ({ kind, doc })),
  );
  const held = await reads.waves(
    withdrawn,
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
  const deleted = byKindCount(
    withdrawn.filter((_, i) => held[i] === null).map((w) => w.kind),
    held.some((h) => h === undefined) || all.some((a) => a.full),
  );
  return { reversed, deleted, pending };
}

/** Decisions on one item the pane reads at most (an item gathers few; more says `decisionsCapped`). */
const ITEM_DECISIONS = 50;

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
  handler: async (ctx, { targetType, targetId }) => {
    const viewer = await requireCapability(ctx, 'content.read');
    const reads = sheetBudget(ctx);
    const pending = await recordPending(ctx, reads);
    const id = targetIdOf(ctx, targetType, targetId);
    if (id === null) return null;
    const [target, verdicts] = await Promise.all([
      reads.one(targetType, () => ctx.db.get(id)) as Promise<ContentDoc | null>,
      reads.take('verdict', ITEM_DECISIONS + 1, (n) =>
        ctx.db
          .query('contentVerdicts')
          .withIndex('by_target_standing', (q) =>
            q.eq('targetType', targetType).eq('targetId', targetId),
          )
          .take(n),
      ),
    ]);
    const decisions = verdicts
      .slice(0, ITEM_DECISIONS)
      .sort((a, b) => b.at - a.at || b._creationTime - a._creationTime);
    // Never anything on the record, and no item: nothing to show.
    if (target === null && decisions.length === 0) return null;
    const standing = decisions.some((d) => d.standing);
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
    const members =
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
    return {
      targetType,
      targetId,
      /** The item as published — the whole document, read by staff — or `null` once erased. */
      published: target === null || erasedComment ? null : target,
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
      })),
      /** More decisions than the pane read (or the budget reached): these are the newest. */
      decisionsCapped: verdicts.length > ITEM_DECISIONS || shown.length < decisions.length,
      can: recordLevers(viewer, recordFactsOf(targetType, target, standing, members)),
      pending,
    };
  },
});

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
      reads.reserve('small', 2);
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
            if (step.ended) written += await upsert(step.ended);
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
      await reads.row(FINISH, async () => {
        if (standing) written += await upsert({ ...standing, standing: true, superseded: false });
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
