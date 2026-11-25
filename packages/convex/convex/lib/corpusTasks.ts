/**
 * **The Corpus tasks' one writer** (B01-7a): every task row and every count row is written here, and
 * every writer of a task's source — a body's `reviewReasons`, `reviewReason`, `reviewSettled`, or
 * the body itself going away — calls in, so a task can't disagree with the fact it asks about.
 * `corpusTaskWriters.test.ts` (in `packages/guards`) holds every such writer to it.
 *
 * **One task per question.** In 7a a question is one intake reason a campaign raised on one body —
 * `name-conflict` or `class-conflict` (`CORPUS_REASON_LANE`); a `class-dissent` stays on the body
 * with no task until 7b's Contested lane (D307). A question is *live* while the body is neither
 * merged away nor removed (nor deleted) and its `reviewReasons` carries the reason; each live question
 * has exactly one open task, keyed `reason:<reason>:<bodyId>`.
 *
 * **Three ways a task ends, and only one is a person's.** `decided` (with `decidedByUserId`, the
 * decision and its audit row): a moderator settled it, through {@link settleReason}. `left` (with
 * `leftBecause`): the question went away with no decision — a campaign stopped asserting the reason,
 * or the body was merged away, removed or deleted. A left task is in no tab and no count, so nothing
 * reads a machine's doing as a person's decision (Review 11 rule 7). A question asked again after a
 * decision (D306: its evidence changed) files a **new** open task; the decided one is kept.
 *
 * **The counts move in the same transaction as the task** (the `inboxCounts` pattern): `open:<lane>`
 * and `open:<lane>:<facet>` (the `notRecorded` facet counted too; the read draws it under *All*
 * only). Inside {@link corpusTaskBatch} each count row is written once, at the batch's end.
 *
 * It imports no function module (`waterBodies.ts`, `moderation.ts`, …): `importCycles.test.ts`
 * holds that line. Nothing here says or implies anything about the ice (D3): a task is a question
 * about what the catalogs published.
 */

import {
  CORPUS_REASON_LANE,
  type CorpusTaskDecision,
  type CorpusTaskLane,
  type CorpusTaskLeftReason,
  facetOf,
  primaryReviewReason,
  REVIEW_REASONS,
  type ReviewReason,
  reviewEvidence,
  UNRECORDED_EVIDENCE,
} from '@skating/core';
import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { bodyLibrarySearchText, queueLibraryRefresh } from './bodyLibrary';

// ── The vocabulary ────────────────────────────────────────────────────────────────────────────────────────

/** An intake reason 7a files a task for. */
export type CorpusTaskReason = keyof typeof CORPUS_REASON_LANE;

/** The reasons 7a files, in `REVIEW_REASONS` order. */
export const CORPUS_TASK_REASONS: readonly CorpusTaskReason[] = REVIEW_REASONS.filter(
  (r): r is CorpusTaskReason => r in CORPUS_REASON_LANE,
);

const REASON_OF_LANE = Object.fromEntries(
  CORPUS_TASK_REASONS.map((reason) => [CORPUS_REASON_LANE[reason], reason]),
) as Record<CorpusTaskLane, CorpusTaskReason>;

/** Whether 7a files a task for `reason` (`class-dissent` and the rest: not yet). */
export function isTaskReason(reason: ReviewReason): reason is CorpusTaskReason {
  return reason in CORPUS_REASON_LANE;
}

/** The intake reason a lane's task asks about. */
export function reasonOfLane(lane: CorpusTaskLane): CorpusTaskReason {
  return REASON_OF_LANE[lane];
}

/** A question's key: one open task per key. */
export function taskKeyOf(reason: CorpusTaskReason, waterBodyId: Id<'waterBodies'>): string {
  return `reason:${reason}:${waterBodyId}`;
}

/**
 * The fields of a body its tasks are read from — all a sync needs, so a writer can hand over what it
 * just wrote without the outline (a body is up to 1 MiB). A writer that hands one over hands **every**
 * field it has, its ids and aliases included: a task's search text is built from them, and one
 * missing here would be written missing, then put back by the drift repair.
 */
export type TaskBody = Pick<Doc<'waterBodies'>, 'name' | 'type'> &
  Partial<
    Pick<
      Doc<'waterBodies'>,
      | 'nameClaims'
      | 'classClaims'
      | 'displayScore'
      | 'reviewReasons'
      | 'mergedIntoId'
      | 'dedupStatus'
      | 'removedAt'
      | 'moderatorAliases'
      | 'waterBodyKey'
      | 'externalId'
      | 'osmId'
      | 'nhdId'
      | 'threeDhpId'
      | 'gnisId'
    >
  >;

/**
 * Why a body asks nothing any more, whatever its reasons say: gone (`deleted`), merged away, or
 * removed. `null` for a body whose questions are live. Dormant bodies still ask: a dormant lake is
 * still in the corpus, and its name is still shown when it wakes.
 */
export function goneBecause(
  body: Partial<Pick<Doc<'waterBodies'>, 'mergedIntoId' | 'dedupStatus' | 'removedAt'>> | null,
): Exclude<CorpusTaskLeftReason, 'notAsserted'> | null {
  if (body === null) return 'deleted';
  if (body.mergedIntoId !== undefined || body.dedupStatus === 'merged') return 'merged';
  if (body.removedAt !== undefined) return 'removed';
  return null;
}

/** The 7a questions live on `body`: its task reasons, unless the body is gone. */
export function liveReasons(body: TaskBody | null): Set<CorpusTaskReason> {
  if (body === null || goneBecause(body) !== null) return new Set();
  return new Set((body.reviewReasons ?? []).filter(isTaskReason));
}

/** What a task takes from its body, and a sync keeps fresh. */
export type TaskFields = { facet: string; rankKey: number; searchText: string };

/**
 * The fields a task takes from its body: its tab (core's `facetOf`), its rank (prominence first),
 * and its search text — what the library finds the body by (`bodyLibrarySearchText`: both names,
 * every other, its ids), so a lane's search reads the lane's own tasks.
 */
export function taskFieldsOf(
  lane: CorpusTaskLane,
  waterBodyId: Id<'waterBodies'>,
  body: TaskBody,
): TaskFields {
  return {
    searchText: bodyLibrarySearchText({ ...body, _id: waterBodyId }),
    facet: facetOf(lane, {
      name: body.name,
      type: body.type,
      ...(body.nameClaims !== undefined ? { nameClaims: body.nameClaims } : {}),
      ...(body.classClaims !== undefined ? { classClaims: body.classClaims } : {}),
    }),
    // Smaller first: the most prominent lake opens the lane. `-0` would be a second spelling of 0.
    rankKey: body.displayScore ? -body.displayScore : 0,
  };
}

/** The evidence a reason is settled on today (core's `reviewEvidence`; the import compares with it). */
export function evidenceOf(
  reason: CorpusTaskReason,
  body: Pick<Doc<'waterBodies'>, 'nameClaims' | 'classClaims'>,
): string {
  return reviewEvidence(reason, body) ?? UNRECORDED_EVIDENCE;
}

// ── The counts ────────────────────────────────────────────────────────────────────────────────────────────

type Counted = Pick<Doc<'corpusTasks'>, 'status' | 'lane' | 'facet'>;

/** The count rows a task stands in: its lane and its tab while open; none once decided or left. */
export function countKeysOf(task: Counted | null): string[] {
  if (task === null || task.status !== 'open') return [];
  return [`open:${task.lane}`, `open:${task.lane}:${task.facet}`];
}

/** The open batch of each transaction: count deltas owed until its end. */
const BATCHES = new WeakMap<object, { owed: Map<string, number> }>();

async function writeCount(ctx: MutationCtx, key: string, by: number): Promise<void> {
  if (by === 0) return;
  const row = await ctx.db
    .query('corpusTaskCounts')
    .withIndex('by_key', (q) => q.eq('key', key))
    .first();
  if (row) await ctx.db.patch(row._id, { count: row.count + by });
  else await ctx.db.insert('corpusTaskCounts', { key, count: by });
}

/** Move the counts from what `before` stood in to what `after` does: now, or at the batch's end. */
async function moveCounts(
  ctx: MutationCtx,
  before: Counted | null,
  after: Counted | null,
): Promise<void> {
  const delta = new Map<string, number>();
  for (const k of countKeysOf(before)) delta.set(k, (delta.get(k) ?? 0) - 1);
  for (const k of countKeysOf(after)) delta.set(k, (delta.get(k) ?? 0) + 1);
  const batch = BATCHES.get(ctx);
  for (const [key, by] of delta) {
    if (batch) batch.owed.set(key, (batch.owed.get(key) ?? 0) + by);
    else await writeCount(ctx, key, by);
  }
}

/**
 * **Run `work` as one Corpus task batch** (the import's; `inboxBatch`'s shape): every task inside it
 * is written at once, and each count row it moves is written **once**, at the batch's end, by the
 * sum of its moves — so a 150-body import batch writes a handful of count rows, not one per task.
 * Nested batches join the outer one. Within a batch the stored counts lag the tasks until the end;
 * nothing in the writer reads a count.
 */
export async function corpusTaskBatch<T>(ctx: MutationCtx, work: () => Promise<T>): Promise<T> {
  const batch = openTaskBatch(ctx);
  let value: T;
  try {
    value = await work();
  } catch (e) {
    batch.abandon();
    throw e;
  }
  await batch.close();
  return value;
}

/**
 * {@link corpusTaskBatch} as two calls, for a caller whose work is a long handler body (the import's):
 * `close()` writes the owed counts — once, by the outermost — and `abandon()` drops them (the caller
 * is throwing, so its transaction writes nothing anyway). A nested open joins the outer batch.
 */
export function openTaskBatch(ctx: MutationCtx): {
  close: () => Promise<void>;
  abandon: () => void;
} {
  // A nested batch joins the outer one: the outermost writes the counts.
  if (BATCHES.has(ctx)) return { close: async () => {}, abandon: () => {} };
  const batch = { owed: new Map<string, number>() };
  BATCHES.set(ctx, batch);
  return {
    close: async () => {
      BATCHES.delete(ctx);
      for (const [key, by] of batch.owed) await writeCount(ctx, key, by);
    },
    abandon: () => {
      BATCHES.delete(ctx);
    },
  };
}

/** A count row's value (zero when absent). */
export async function readTaskCount(ctx: QueryCtx, key: string): Promise<number> {
  const row = await ctx.db
    .query('corpusTaskCounts')
    .withIndex('by_key', (q) => q.eq('key', key))
    .first();
  return row?.count ?? 0;
}

/**
 * Whether the stored tasks can't yet be taken as the corpus's: until the backfill's run row says
 * done, and while any body it couldn't file is still owed (`jobFailures`, parked or not), every
 * read answers `pending` (the counts would be short, not exact).
 */
export async function corpusTasksPending(ctx: QueryCtx): Promise<boolean> {
  const run = await ctx.db
    .query('corpusTaskJobRuns')
    .withIndex('by_job', (q) => q.eq('job', 'backfill'))
    .first();
  if (run?.done !== true) return true;
  const owed = await ctx.db
    .query('jobFailures')
    .withIndex('by_job_parked', (q) => q.eq('job', 'corpusTaskBackfill'))
    .first();
  return owed !== null;
}

// ── Filing, refreshing, leaving ──────────────────────────────────────────────────────────────────────────

/**
 * The most open tasks a body's sync reads. A body has at most one per 7a reason (two); the rest is
 * room for drift, which the sync then leaves, and the repair finds past it.
 */
export const BODY_OPEN_SCAN = 16;

/** What one sync did to the body's tasks. */
export type SyncOutcome = { filed: number; refreshed: number; left: number };

/** Options every writer takes: the instant to stamp (tests and a batch's one clock). */
export type WriterOpts = { now?: number };

async function openTasksOf(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<Doc<'corpusTasks'>[]> {
  return ctx.db
    .query('corpusTasks')
    .withIndex('by_body_status', (q) => q.eq('waterBodyId', waterBodyId).eq('status', 'open'))
    .take(BODY_OPEN_SCAN);
}

/** One open task leaves with no decision: its counts fall, and nothing says a person decided it. */
export async function leaveTask(
  ctx: MutationCtx,
  task: Doc<'corpusTasks'>,
  because: CorpusTaskLeftReason,
  opts: WriterOpts = {},
): Promise<void> {
  if (task.status !== 'open') return;
  const now = opts.now ?? Date.now();
  await ctx.db.patch(task._id, {
    status: 'left',
    leftAt: now,
    leftBecause: because,
    refreshedAt: now,
  });
  await moveCounts(ctx, task, null);
}

/**
 * **Files, refreshes or leaves the body's 7a tasks from its stored `reviewReasons`.** Idempotent: a
 * second call with nothing changed writes nothing. Each live question gets its one open task (filed
 * when missing; its facet, rank and search text refreshed when the body's facts moved them); each
 * open task whose question is gone leaves — `deleted`, `merged` or `removed` when the body went, else
 * `notAsserted` (the campaign stopped raising it). A second open task on one key (drift) leaves too.
 *
 * Call it after the write that changed the body. `opts.body` is the body as the caller just wrote
 * it — at least its {@link TaskBody} fields — or `null` (deleted), so the sync doesn't read it again.
 */
export async function syncBodyTasks(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  opts: WriterOpts & { body?: TaskBody | null } = {},
): Promise<SyncOutcome> {
  const now = opts.now ?? Date.now();
  const plan = await planBodyTasks(ctx, waterBodyId, opts);
  for (const { task, because } of plan.leave) await leaveTask(ctx, task, because, { now });
  for (const { task, fields } of plan.refresh) {
    await ctx.db.patch(task._id, { ...fields, refreshedAt: now });
    await moveCounts(ctx, task, { ...task, ...fields });
  }
  for (const { reason, fields } of plan.file) {
    const lane = CORPUS_REASON_LANE[reason];
    const filed = {
      key: taskKeyOf(reason, waterBodyId),
      kind: 'reason' as const,
      lane,
      ...fields,
      status: 'open' as const,
      filedAt: now,
      waterBodyId,
      subjectId: waterBodyId as string,
      refreshedAt: now,
    };
    await ctx.db.insert('corpusTasks', filed);
    await moveCounts(ctx, null, filed);
  }
  return { filed: plan.file.length, refreshed: plan.refresh.length, left: plan.leave.length };
}

/** What a sync would write: the tasks to leave, to refresh, and the questions to file. */
export type BodyTaskPlan = {
  leave: { task: Doc<'corpusTasks'>; because: CorpusTaskLeftReason }[];
  refresh: { task: Doc<'corpusTasks'>; fields: TaskFields }[];
  file: { reason: CorpusTaskReason; fields: TaskFields }[];
};

/**
 * **What {@link syncBodyTasks} would write, read only** — the one rule, so the drift repair's dry run
 * reports exactly what its sync would fix. Empty when the body's tasks are what its fields say.
 */
export async function planBodyTasks(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  opts: { body?: TaskBody | null } = {},
): Promise<BodyTaskPlan> {
  const body = opts.body !== undefined ? opts.body : await ctx.db.get(waterBodyId);
  const gone = goneBecause(body);
  const live = liveReasons(body);
  const plan: BodyTaskPlan = { leave: [], refresh: [], file: [] };
  const held = new Set<CorpusTaskReason>();
  for (const task of await openTasksOf(ctx, waterBodyId)) {
    const reason = reasonOfLane(task.lane);
    const ours = task.key === taskKeyOf(reason, waterBodyId);
    if (body === null || !live.has(reason) || held.has(reason) || !ours) {
      plan.leave.push({ task, because: gone ?? 'notAsserted' });
      continue;
    }
    held.add(reason);
    const fields = taskFieldsOf(task.lane, waterBodyId, body);
    // A task filed before it carried a search text has none: refreshed, so the search finds it.
    const same =
      fields.facet === task.facet &&
      fields.rankKey === task.rankKey &&
      fields.searchText === task.searchText;
    if (same) continue;
    plan.refresh.push({ task, fields });
  }
  if (body === null) return plan;
  for (const reason of CORPUS_TASK_REASONS) {
    if (!live.has(reason) || held.has(reason)) continue;
    plan.file.push({
      reason,
      fields: taskFieldsOf(CORPUS_REASON_LANE[reason], waterBodyId, body),
    });
  }
  return plan;
}

/**
 * Every open task on the body leaves, `because` — for a path that ends every question at once (the
 * body merged away, removed, deleted), before or after its own write.
 */
export async function leaveBodyTasks(
  ctx: MutationCtx,
  waterBodyId: Id<'waterBodies'>,
  because: CorpusTaskLeftReason,
  opts: WriterOpts = {},
): Promise<void> {
  for (const task of await openTasksOf(ctx, waterBodyId)) {
    await leaveTask(ctx, task, because, opts);
  }
}

// ── Deciding ─────────────────────────────────────────────────────────────────────────────────────────────

/** A task id that names no row. */
export const NO_SUCH_TASK = 'This task no longer exists.';
/** A decided task whose decider isn't on record (D283: decided takes no further decision). */
export const TASK_DECIDED = 'This has already been decided.';
/** A left task's sentence, by why it left: the question went away, so there is nothing to decide. */
export const TASK_LEFT: Readonly<Record<CorpusTaskLeftReason, string>> = {
  notAsserted: 'The latest campaign no longer raises this question.',
  merged: 'This body was merged into another, so its questions went with it.',
  removed: 'This body was removed, so its questions went with it.',
  deleted: 'This body no longer exists.',
};

/**
 * **The lock's sentence** for a task that takes no decision, or `null` for an open one: *Decided by
 * Sarah · renamed* (who and what, as the inspector's lock draws them — the time is the reader's to
 * draw in their own zone), or why the question went away. One function, so the read's `can` and every
 * write say the same words (D283; `lib/corpusRules`' decided rung asks it).
 */
export async function taskLockRefusal(
  ctx: QueryCtx,
  task: Doc<'corpusTasks'>,
): Promise<string | null> {
  if (task.status === 'open') return null;
  if (task.status === 'left') return TASK_LEFT[task.leftBecause ?? 'notAsserted'];
  const by = task.decidedByUserId ? await ctx.db.get(task.decidedByUserId) : null;
  if (!by || task.decision === undefined) return TASK_DECIDED;
  return `Decided by ${by.displayName} · ${task.decision}`;
}

/** The open task, or the lock's sentence thrown ({@link taskLockRefusal}; {@link NO_SUCH_TASK}). */
export async function taskToDecide(
  ctx: MutationCtx,
  taskId: Id<'corpusTasks'>,
): Promise<Doc<'corpusTasks'>> {
  const task = await ctx.db.get(taskId);
  if (task === null) throw new ConvexError(NO_SUCH_TASK);
  const refused = await taskLockRefusal(ctx, task);
  if (refused !== null) throw new ConvexError(refused);
  return task;
}

/** `reviewReasons` with `reason` in or out, in `REVIEW_REASONS` order; absent when empty. */
function withReason(
  reasons: Doc<'waterBodies'>['reviewReasons'],
  reason: ReviewReason,
  present: boolean,
): { reviewReasons: Doc<'waterBodies'>['reviewReasons']; reviewReason: ReviewReason | undefined } {
  const set = new Set(reasons ?? []);
  if (present) set.add(reason);
  else set.delete(reason);
  const next = REVIEW_REASONS.filter((r) => set.has(r));
  return {
    reviewReasons: next.length > 0 ? next : undefined,
    reviewReason: primaryReviewReason(next),
  };
}

/**
 * **The settle** (one path for every intake decision): the reason off `reviewReasons`,
 * `reviewReason` recomputed by `primaryReviewReason` (so the old readers surface the body's next
 * reason, whose own task already stands in its own lane), an entry on `reviewSettled` with today's
 * evidence (D306: the import holds the settle while the evidence stands), the task decided with
 * `actionId`, the counts moved. In the caller's transaction, after its domain write — so a decision
 * can't half-land. The caller has already asked the rule; a task no longer open or a body gone is a
 * bug in the caller, and throws.
 */
export async function settleReason(
  ctx: MutationCtx,
  args: {
    task: Doc<'corpusTasks'>;
    decision: CorpusTaskDecision;
    actionId: Id<'moderationActions'>;
    actorId: Id<'profiles'>;
  },
  opts: WriterOpts = {},
): Promise<void> {
  const now = opts.now ?? Date.now();
  const task = await taskToDecide(ctx, args.task._id);
  const body = await ctx.db.get(task.waterBodyId);
  if (body === null) throw new ConvexError(TASK_LEFT.deleted);
  const reason = reasonOfLane(task.lane);
  const entry = { reason, evidence: evidenceOf(reason, body), at: now, actionId: args.actionId };
  await ctx.db.patch(body._id, {
    ...withReason(body.reviewReasons, reason, false),
    reviewSettled: [...(body.reviewSettled ?? []).filter((s) => s.reason !== reason), entry],
  });
  // The library's row reads `reviewReason` (its *intake* facet), and the decision's audit row
  // refreshed it before this patch: queued, so the row follows the reason off the body.
  await queueLibraryRefresh(ctx, [body._id], now);
  const decided = {
    status: 'decided' as const,
    decidedAt: now,
    decidedByUserId: args.actorId,
    decision: args.decision,
    decisionActionId: args.actionId,
    refreshedAt: now,
  };
  await ctx.db.patch(task._id, decided);
  await moveCounts(ctx, task, { ...task, ...decided });
}

/**
 * **The undo's**: the task `actionId` decided reopens — its `reviewSettled` entry goes, its reason
 * comes back onto `reviewReasons` (and `reviewReason` with it), and the task is open again with its
 * facet and rank re-derived and its counts moved back. `'none'` when `actionId` decided no task.
 * `'overtaken'`, with nothing written, when something has moved it since: the task isn't decided
 * any more, the body is gone, the settle's entry isn't this decision's (a campaign asked it again, or
 * a later decision settled it), or another task on its key is already open.
 */
export async function reopenTask(
  ctx: MutationCtx,
  actionId: Id<'moderationActions'>,
  opts: WriterOpts = {},
): Promise<'reopened' | 'overtaken' | 'none'> {
  const now = opts.now ?? Date.now();
  const task = await ctx.db
    .query('corpusTasks')
    .withIndex('by_decision_action', (q) => q.eq('decisionActionId', actionId))
    .first();
  if (task === null) return 'none';
  if (task.status !== 'decided') return 'overtaken';
  const body = await ctx.db.get(task.waterBodyId);
  if (body === null || goneBecause(body) !== null) return 'overtaken';
  const reason = reasonOfLane(task.lane);
  const entry = (body.reviewSettled ?? []).find((s) => s.reason === reason);
  if (entry?.actionId !== actionId) return 'overtaken';
  const twin = await ctx.db
    .query('corpusTasks')
    .withIndex('by_key', (q) => q.eq('key', task.key).eq('status', 'open'))
    .first();
  if (twin !== null) return 'overtaken';

  const settled = (body.reviewSettled ?? []).filter((s) => s !== entry);
  const reasons = withReason(body.reviewReasons, reason, true);
  await ctx.db.patch(body._id, {
    ...reasons,
    reviewSettled: settled.length > 0 ? settled : undefined,
  });
  // The library's row reads `reviewReason` (its *intake* facet), and the undo's own audit row may
  // have refreshed it before this patch: queued, so the row follows the reason back onto the body.
  await queueLibraryRefresh(ctx, [body._id], now);
  const reopened = {
    status: 'open' as const,
    ...taskFieldsOf(task.lane, body._id, body),
    decidedAt: undefined,
    decidedByUserId: undefined,
    decision: undefined,
    decisionActionId: undefined,
    refreshedAt: now,
  };
  await ctx.db.patch(task._id, reopened);
  await moveCounts(ctx, task, { ...task, ...reopened });
  return 'reopened';
}
