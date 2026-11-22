/**
 * **The unmerge of a body merge** (`unmerge_waterbody`, B01-5d, D291) — `merge_waterbody`'s inverse,
 * from the change set the merge recorded (`MergeChangeSet` `version: 2`, in `auditSnapshots`).
 *
 * A merge has no forward verb to call back: the rows it moved, the bays it re-clipped and the flags it
 * cleared come back only from what it recorded. So the unmerge restores from those before-images, and
 * always **through the forward paths' side effects** (D291): each moved row is re-pointed the way the
 * merge re-pointed it (a report re-mirrors its bay join, an ask or a flag re-keys its Inbox item), and
 * everything derived — cells, summaries, library rows, name lists, stored counts, `inboxCounts` — is
 * recomputed by the paths that keep it, never patched.
 *
 * **What it refuses, before any write** (`unmergeRefusalOf`, the one function the offer and the run
 * ask, in one order): a merge recorded before `version: 2` (the dialog's sentence), a record with
 * parts missing, the loser no longer merged into the recorded survivor, the survivor gone or merged
 * into another body since, and the drawer of a merged drawing (D289: never decides their own drawing,
 * an undo included). The engine refuses the rest: undone, overtaken by a later row on the loser, the
 * capability (`corpus.duplicates`).
 *
 * **What it leaves, and says** (the B01-5d ruling, fork 1 (B)): a row that has moved again since the
 * merge — a report now on another body, an ask decided since, a bay or a landmark edited since, a
 * partner whose flag a moderator changed — is left where it is, counted on the unmerge's own audit
 * row (`metadata.left`, by kind, the first rows named), never a whole-unmerge refusal and never a
 * silent skip.
 *
 * **The survivor's lists are taken apart by difference** (fork 5 (A)): an entry that came only from
 * the loser and is still there goes back; one the survivor had before or gained since stays.
 *
 * **The shape** (the brief's *budget*): the first transaction runs the refusals, writes the unmerge's
 * row on the loser (its `undoes:` the merge row, through the engine's `asUndoOf`), restores both
 * bodies and the partners, reopens the drawing's Inbox item, and starts on the moved rows. Each page
 * takes rows by the transaction's live metrics (`batchHasRoom`), at least one a page, and schedules
 * the next (`unmergeRest`) carrying its audit context; a page whose unmerge is no longer current (a
 * row `undoes:` it, or the loser merged again) stops. The change set is an array sliced by offset, so
 * no page calls `.paginate()` at all. The last page recomputes the derived facts and schedules both
 * restamps.
 */

import { bodyLabel, bodySearchTextFor } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id, TableNames } from './_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx, query } from './_generated/server';
import {
  type AuditContext,
  asContinuationOf,
  auditContextArgs,
  auditContextOf,
  composed,
  writeAudit,
} from './lib/audit';
import { requireCapability } from './lib/auth';
import { refreshPinnedFacts } from './lib/bodyGeo';
import { queueLibraryRefresh, stampChanged } from './lib/bodyLibrary';
import { refreshBodyNames, setNamesAllowance } from './lib/bodyNames';
import { recomputeBodySummary } from './lib/bodySummary';
import { syncWaterBodyCells } from './lib/cellIndex';
import { markGeoStale } from './lib/geoStale';
import {
  batchHasRoom,
  bodySource,
  fileMember,
  flagSource,
  inboxBatch,
  pageIsFull,
  rekey,
  reopenItem,
  requestSource,
  type TxCost,
} from './lib/inboxItems';
import { OWN_FILING_REFUSAL } from './lib/inboxRules';
import { isListed } from './lib/listing';
import { OPEN_FLAG_STATUSES } from './lib/openFlags';
import { DOC_MAX, ROW_MAX } from './lib/readBudget';
import { mirrorReportSubAreas } from './lib/reportSubAreas';
import { zoomSortKey } from './lib/scoring';
import { scheduleRestamp, syncCellsForParent } from './subAreas';
import { type MergeChangeSet, regionStatesFields, ruleStatesOf } from './waterBodies';

// ── The refusals: one function, one order, for the offer and the run ───────────────────────────────

/** The dialog's sentence for a merge recorded before its change set kept everything (`version: 2`). */
export const UNMERGE_PREDATES =
  'This merge was recorded before merges kept everything an unmerge needs, so it can’t be undone here.';
/** A change set whose stored parts, or whose version-2 fields, are not all there. */
export const UNMERGE_PARTS_MISSING =
  'Part of this merge’s record is missing, so it can’t be undone here.';
/** The loser is no longer merged into the survivor the merge chose. */
export const UNMERGE_LOSER_MOVED =
  'This body is no longer merged into the one this merge chose, so there is nothing to unmerge.';
/** The survivor is gone (a hard delete). */
export const UNMERGE_SURVIVOR_GONE =
  'The body this was merged into no longer exists, so it can’t be unmerged.';

/** The survivor has since been merged into another body: that merge is undone first. */
export function unmergeSurvivorMerged(survivorName: string, intoName: string | null): string {
  const into = intoName === null ? 'another body' : `“${bodyLabel({ name: intoName })}”`;
  return `“${bodyLabel({ name: survivorName })}” has since been merged into ${into}. Unmerge it from ${into === 'another body' ? 'that body' : into} first.`;
}

/**
 * What the refusal reads: the change set as stored (`null`: none; `'missing'`: a part of it is not
 * there), and the bodies — the loser, the survivor, and the body the survivor was merged into since,
 * if it was.
 */
export interface UnmergeFacts {
  changeSet: MergeChangeSet | null | 'missing';
  loser: Doc<'waterBodies'> | null;
  survivor: Doc<'waterBodies'> | null;
  /** The body the survivor was merged into since, when it was (its name for the sentence). */
  survivorInto: Doc<'waterBodies'> | null;
}

/** Whether a change set carries every field the unmerge reads (`version: 2` and the rest). */
function isWhole(cs: MergeChangeSet): boolean {
  return (
    Array.isArray(cs.moved) &&
    Array.isArray(cs.dedupBefore) &&
    Array.isArray(cs.deletedFavorites) &&
    Array.isArray(cs.subAreasBefore) &&
    Array.isArray(cs.landmarksBefore) &&
    Array.isArray(cs.landmarksAfter) &&
    cs.listsBefore !== undefined &&
    Array.isArray(cs.sideActions) &&
    Array.isArray(cs.dedupAfter) &&
    Array.isArray(cs.survivorSubAreasBefore) &&
    cs.loserReview !== undefined &&
    Array.isArray(cs.movedActivities)
  );
}

/**
 * **Why this merge can't be unmerged now, or `null`** — the one rule the offer (the handler's
 * `refusal`) and the run (`unmergeBodyImpl`) both ask, on facts each reads its own way, in this order:
 * the record, the loser, the survivor, then who asks.
 */
export function unmergeRefusalOf(
  facts: UnmergeFacts,
  /** Who would unmerge it: the person who drew a merged drawing never decides it (D289). */
  viewerId?: Id<'profiles'>,
): string | null {
  const cs = facts.changeSet;
  if (cs === null) return UNMERGE_PREDATES;
  if (cs === 'missing') return UNMERGE_PARTS_MISSING;
  if (cs.version !== 2) return UNMERGE_PREDATES;
  if (!isWhole(cs)) return UNMERGE_PARTS_MISSING;
  const loser = facts.loser;
  if (loser?.dedupStatus !== 'merged' || loser.mergedIntoId !== cs.survivorId) {
    return UNMERGE_LOSER_MOVED;
  }
  const survivor = facts.survivor;
  if (!survivor) return UNMERGE_SURVIVOR_GONE;
  if (survivor.dedupStatus === 'merged' || survivor.mergedIntoId !== undefined) {
    return unmergeSurvivorMerged(survivor.name, facts.survivorInto?.name ?? null);
  }
  if (viewerId !== undefined && cs.loserReview?.decidedItem && loser.createdByUserId === viewerId) {
    return OWN_FILING_REFUSAL;
  }
  return null;
}

/** The most parts of a change set the unmerge reads — far past any merge one transaction can make. */
export const CHANGE_SET_PARTS_MAX = 16;

/**
 * A merge's change set as stored, or `null` when there is none, or `'missing'` when its parts are not
 * all there (`lib/audit`'s `readSnapshot` throws on that; the unmerge says so in words instead).
 */
export async function readChangeSet(
  ctx: QueryCtx | MutationCtx,
  mergeActionId: Id<'moderationActions'>,
): Promise<MergeChangeSet | null | 'missing'> {
  const rows = await ctx.db
    .query('auditSnapshots')
    .withIndex('by_action', (q) => q.eq('actionId', mergeActionId))
    .take(CHANGE_SET_PARTS_MAX + 1);
  return changeSetOf(rows);
}

/** The change set the stored rows of one snapshot make, in part order. */
export function changeSetOf(
  rows: readonly Pick<Doc<'auditSnapshots'>, 'part' | 'payload'>[],
): MergeChangeSet | null | 'missing' {
  const first = rows[0];
  if (!first) return null;
  const payload = first.payload as { chunk?: unknown; of?: unknown } | null;
  if (typeof payload !== 'object' || payload === null || typeof payload.chunk !== 'string') {
    return first.payload as MergeChangeSet;
  }
  const of = payload.of;
  if (typeof of !== 'number' || rows.length !== of) return 'missing';
  const sorted = [...rows].sort((a, b) => a.part - b.part);
  if (sorted.some((row, k) => row.part !== k)) return 'missing';
  try {
    return JSON.parse(
      sorted.map((row) => (row.payload as { chunk: string }).chunk).join(''),
    ) as MergeChangeSet;
  } catch {
    return 'missing';
  }
}

/** The facts the run reads, plainly (the offer reads the same through its charged reader). */
async function factsFor(
  ctx: MutationCtx,
  mergeRow: Doc<'moderationActions'>,
): Promise<UnmergeFacts> {
  const loserId = ctx.db.normalizeId('waterBodies', mergeRow.targetId);
  const loser = loserId ? await ctx.db.get(loserId) : null;
  const changeSet = await readChangeSet(ctx, mergeRow._id);
  const survivorId =
    changeSet !== null && changeSet !== 'missing' ? changeSet.survivorId : undefined;
  const survivor = survivorId ? await ctx.db.get(survivorId) : null;
  const survivorInto = survivor?.mergedIntoId ? await ctx.db.get(survivor.mergedIntoId) : null;
  return { changeSet, loser, survivor, survivorInto };
}

// ── What is left, and where it is said ─────────────────────────────────────────────────────────────

/** The kinds of row the unmerge may leave where it is. */
export type LeftKind =
  | MergeChangeSet['moved'][number]['table']
  | 'gpsActivities'
  | 'deletedFavorites'
  | 'waterBodySubAreas'
  | 'bodyLandmarks'
  | 'partners'
  | 'sideActions';

/** How many left rows the unmerge's row names (every one is counted). */
export const LEFT_NAMED = 20;

/** What the unmerge left, as its row records it: a count by kind, and the first rows named. */
export interface UnmergeLeft {
  count: number;
  byKind: Partial<Record<LeftKind, number>>;
  rows: { kind: LeftKind; id: string }[];
}

const noneLeft = (): UnmergeLeft => ({ count: 0, byKind: {}, rows: [] });

function leave(left: UnmergeLeft, kind: LeftKind, id: string): void {
  left.count++;
  left.byKind[kind] = (left.byKind[kind] ?? 0) + 1;
  if (left.rows.length < LEFT_NAMED) left.rows.push({ kind, id });
}

/**
 * Add a page's left rows to the unmerge's row (`metadata.left`), and mark it `done` on the last page.
 * The pages run one after another, each scheduled by the last at its end, so the row has one writer
 * at a time.
 */
async function recordLeft(
  ctx: MutationCtx,
  unmergeId: Id<'moderationActions'>,
  page: UnmergeLeft,
  done: boolean,
): Promise<void> {
  const row = await ctx.db.get(unmergeId);
  if (!row) return;
  const metadata = (row.metadata ?? {}) as { left?: UnmergeLeft; done?: boolean };
  const left = metadata.left ?? noneLeft();
  const byKind = { ...left.byKind };
  for (const [kind, n] of Object.entries(page.byKind) as [LeftKind, number][]) {
    byKind[kind] = (byKind[kind] ?? 0) + n;
  }
  await ctx.db.patch(unmergeId, {
    metadata: {
      ...metadata,
      left: {
        count: left.count + page.count,
        byKind,
        rows: [...left.rows, ...page.rows].slice(0, LEFT_NAMED),
      },
      done: done || metadata.done === true,
    },
  });
}

// ── The run ────────────────────────────────────────────────────────────────────────────────────────

/** The phases a run walks, in order; each is the change set's list sliced from an offset. */
export const PHASES = [
  'moved',
  'activities',
  'favorites',
  'bays',
  'landmarks',
  'sides',
  'derived',
] as const;
export type Phase = (typeof PHASES)[number];

/** Where a run stands: the phase, and the offset into its list. */
export interface UnmergeCursor {
  phase: Phase;
  from: number;
}

/**
 * **Unmerge a body merge** — `undo.run` on a `merge_waterbody` row, inside the engine's `asUndoOf`
 * (so the row written here `undoes:` the merge). The refusals first, before any write; then the
 * unmerge's row on the loser, both bodies and the partners, the drawing's item, and the first page.
 * Returns the unmerge's row.
 */
export async function unmergeBodyImpl(
  ctx: MutationCtx,
  actor: Doc<'profiles'>,
  args: { mergeRow: Doc<'moderationActions'>; reason: string },
): Promise<Id<'moderationActions'>> {
  const { mergeRow } = args;
  const facts = await factsFor(ctx, mergeRow);
  const why = unmergeRefusalOf(facts, actor._id);
  if (why !== null) throw new ConvexError(why);
  const cs = facts.changeSet as MergeChangeSet;
  const loser = facts.loser as Doc<'waterBodies'>;
  const survivor = facts.survivor as Doc<'waterBodies'>;
  const now = Date.now();
  const unmergeId = await writeAudit(ctx, {
    actorId: actor._id,
    action: 'unmerge_waterbody',
    targetType: 'waterbody',
    targetId: loser._id,
    reason: args.reason,
    metadata: {
      survivorId: survivor._id,
      mergeActionId: mergeRow._id,
      left: noneLeft(),
      done: false,
    },
    createdAt: now,
  });
  const left = noneLeft();
  await restoreBodies(ctx, cs, loser, survivor);
  await restorePartners(ctx, cs, left);
  // The drawing's Inbox item reopens (B01-5d): the member its merge closed, then the drawing re-filed,
  // as a return to review does (`moveDrawnReview`), so `inboxCounts` move back with it.
  if (cs.loserReview?.decidedItem) {
    await reopenItem(ctx, mergeRow._id);
    await fileMember(ctx, bodySource(loser._id));
  }
  await runPage(ctx, {
    cs,
    mergeRow,
    unmergeId,
    actorId: actor._id,
    cursor: { phase: 'moved', from: 0 },
    left,
  });
  return unmergeId;
}

/**
 * Rows 1 and 2 of the brief's table: the loser untombstoned with its lists, review status and dedup
 * fields as they stood; the survivor's lists taken apart by difference. Region states, the search
 * string and the pinned facts follow each list, as every writer of them keeps them; the loser's cells
 * follow its listing.
 */
async function restoreBodies(
  ctx: MutationCtx,
  cs: MergeChangeSet,
  loser: Doc<'waterBodies'>,
  survivor: Doc<'waterBodies'>,
): Promise<void> {
  const lists = cs.listsBefore as NonNullable<MergeChangeSet['listsBefore']>;
  // The survivor: what came only from the loser and is still there goes back; what it had before, or
  // gained since, stays (D291, fork 5 (A)). An alias is the same alias case aside, a link by its URL —
  // the union's own rules (`mergedModeratorLists`).
  const aliasKey = (a: string) => a.toLocaleLowerCase('en-US');
  const before = lists.survivor;
  const fromLoser = lists.loser;
  const pinsGone = new Set(fromLoser.pins.filter((p) => !before.pins.includes(p)));
  const aliasesBefore = new Set(before.aliases.map(aliasKey));
  const aliasesGone = new Set(
    fromLoser.aliases.map(aliasKey).filter((key) => !aliasesBefore.has(key)),
  );
  const urlsBefore = new Set(before.links.map((l) => l.url));
  const urlsGone = new Set(fromLoser.links.map((l) => l.url).filter((u) => !urlsBefore.has(u)));
  const pinsNow = survivor.moderatorTownKeys ?? [];
  const aliasesNow = survivor.moderatorAliases ?? [];
  const linksNow = survivor.referenceLinks ?? [];
  const pins = pinsNow.filter((p) => !pinsGone.has(p));
  const aliases = aliasesNow.filter((a) => !aliasesGone.has(aliasKey(a)));
  const links = linksNow.filter((l) => !urlsGone.has(l.url));
  const survivorPatch: Partial<Doc<'waterBodies'>> = {};
  if (pins.length !== pinsNow.length) {
    Object.assign(survivorPatch, {
      moderatorTownKeys: pins.length > 0 ? pins : undefined,
      ...regionStatesFields(ruleStatesOf(survivor), pins),
    });
  }
  if (aliases.length !== aliasesNow.length) {
    const kept = aliases.length > 0 ? aliases : undefined;
    Object.assign(survivorPatch, {
      moderatorAliases: kept,
      searchText: bodySearchTextFor({ ...survivor, moderatorAliases: kept }),
    });
  }
  if (links.length !== linksNow.length) {
    Object.assign(survivorPatch, { referenceLinks: links.length > 0 ? links : undefined });
  }
  if (Object.keys(survivorPatch).length > 0) await ctx.db.patch(survivor._id, survivorPatch);
  if (pins.length !== pinsNow.length) await refreshPinnedFacts(ctx, survivor._id, pins);

  // The loser: as it stood, with its own lists, its review status and its duplicate flags.
  const dedup = cs.dedupBefore[0] as MergeChangeSet['dedupBefore'][number];
  const review = cs.loserReview as NonNullable<MergeChangeSet['loserReview']>;
  // Its pins and aliases come back with what follows each (its states, its search string) — only
  // where it had them, as the merge took them only then; its links never left it.
  const restored: Partial<Doc<'waterBodies'>> = {
    dedupStatus: dedup.dedupStatus,
    duplicateCandidateIds: dedup.duplicateCandidateIds ?? undefined,
    mergedIntoId: dedup.mergedIntoId ?? undefined,
    reviewStatus: review.reviewStatus ?? undefined,
    ...(fromLoser.pins.length > 0
      ? {
          moderatorTownKeys: fromLoser.pins,
          ...regionStatesFields(ruleStatesOf(loser), fromLoser.pins),
        }
      : {}),
    ...(fromLoser.aliases.length > 0
      ? {
          moderatorAliases: fromLoser.aliases,
          searchText: bodySearchTextFor({ ...loser, moderatorAliases: fromLoser.aliases }),
        }
      : {}),
  };
  await ctx.db.patch(loser._id, restored);
  if (fromLoser.pins.length > 0) await refreshPinnedFacts(ctx, loser._id, fromLoser.pins);
  const now = { ...loser, ...restored } as Doc<'waterBodies'>;
  await syncWaterBodyCells(ctx, loser._id, {
    bbox: loser.bbox,
    minVisibleZoom: zoomSortKey(now),
    listed: isListed(now),
  });
}

/** The fields a duplicate flag is, compared as the merge recorded them. */
function dedupFieldsOf(body: Doc<'waterBodies'>): MergeChangeSet['dedupBefore'][number] {
  return {
    id: body._id,
    dedupStatus: body.dedupStatus,
    duplicateCandidateIds: body.duplicateCandidateIds ?? null,
    mergedIntoId: body.mergedIntoId ?? null,
  };
}

/**
 * Row 3: each partner whose flag still reads as the merge left it (`dedupAfter`) goes back to its
 * before-image and re-keys its Inbox item; one a moderator has changed since is left.
 */
async function restorePartners(
  ctx: MutationCtx,
  cs: MergeChangeSet,
  left: UnmergeLeft,
): Promise<void> {
  const after = new Map((cs.dedupAfter ?? []).map((d) => [d.id, d]));
  await inboxBatch(ctx, async () => {
    for (const before of cs.dedupBefore.slice(1)) {
      const partner = await ctx.db.get(before.id);
      const expected = after.get(before.id);
      if (!partner || !expected || !sameJson(dedupFieldsOf(partner), expected)) {
        leave(left, 'partners', before.id);
        continue;
      }
      await ctx.db.patch(partner._id, {
        dedupStatus: before.dedupStatus,
        duplicateCandidateIds: before.duplicateCandidateIds ?? undefined,
        mergedIntoId: before.mergedIntoId ?? undefined,
      });
      await rekey(ctx, bodySource(partner._id));
    }
  });
}

/** What a page carries: the change set read this transaction, and where the run stands. */
interface PageState {
  cs: MergeChangeSet;
  mergeRow: Doc<'moderationActions'>;
  unmergeId: Id<'moderationActions'>;
  actorId: Id<'profiles'> | undefined;
  cursor: UnmergeCursor;
  left: UnmergeLeft;
}

/** One moved row's worst cost: read whole and written back, plus what its re-point runs. */
function movedCost(table: MergeChangeSet['moved'][number]['table']): TxCost {
  const row =
    table === 'contentFlags'
      ? ROW_MAX.contentFlag
      : table === 'waterBodyFavorites'
        ? ROW_MAX.small
        : DOC_MAX;
  // A report re-mirrors its bay join: a small row per bay it lies in.
  const join = table === 'reports' ? REPORT_JOIN_ROWS : 0;
  return {
    bytesRead: row + join * ROW_MAX.small + ROW_MAX.small,
    documentsRead: 2 + join,
    databaseQueries: 3,
    documentsWritten: 1 + join,
    bytesWritten: row + join * ROW_MAX.small,
  };
}

/** The bay-join rows one report is assumed to carry at most, for a page's room. */
const REPORT_JOIN_ROWS = 50;

/** A bay or a landmark put back: read whole, replaced whole. */
const SHAPE_COST: TxCost = {
  bytesRead: DOC_MAX,
  documentsRead: 1,
  databaseQueries: 1,
  documentsWritten: 1,
  bytesWritten: DOC_MAX,
};

/** A side row marked undone: it, its undone check, its target, and the row written. */
const SIDE_COST: TxCost = {
  bytesRead: 2 * DOC_MAX + ROW_MAX.small,
  documentsRead: 4,
  databaseQueries: 4,
  documentsWritten: 3,
  bytesWritten: 2 * ROW_MAX.small,
};

/** A skate or a re-created favorite: a row read and a row written. */
const SMALL_COST: TxCost = {
  bytesRead: DOC_MAX,
  documentsRead: 3,
  databaseQueries: 3,
  documentsWritten: 1,
  bytesWritten: DOC_MAX,
};

/**
 * The last page's recompute, kept in a page of its own when what's left can't hold it: both bodies'
 * bays re-synced, their names rebuilt, summaries recomputed (a body's reports and hazards read),
 * library rows queued, the geometry marked, two restamps and two recurrences scheduled.
 */
export const DERIVED_COST: TxCost = {
  bytesRead: 8 * DOC_MAX,
  documentsRead: 8_000,
  databaseQueries: 400,
  documentsWritten: 2_000,
  bytesWritten: 4 * DOC_MAX,
};

/** The page's work: each phase's rows from the cursor while the room holds, then the next page. */
async function runPage(ctx: MutationCtx, state: PageState): Promise<void> {
  const { cs, mergeRow } = state;
  const survivorId = cs.survivorId;
  const loserId = cs.loserId;
  const mergedAt = mergeRow.createdAt;
  let done = 0;
  /** Whether one more item of `cost` fits this page: always the first. */
  const room = async (cost: TxCost) =>
    done === 0 || (!pageIsFull(done) && (await batchHasRoom(ctx, cost)));
  let cursor: UnmergeCursor | null = state.cursor;

  await inboxBatch(ctx, async () => {
    while (cursor !== null) {
      const { phase } = cursor;
      let from = cursor.from;
      let stopped = false;
      if (phase === 'moved') {
        for (; from < cs.moved.length; from++) {
          const m = cs.moved[from] as MergeChangeSet['moved'][number];
          if (!(await room(movedCost(m.table)))) {
            stopped = true;
            break;
          }
          done++;
          if (!(await moveBack(ctx, m, survivorId, loserId, mergedAt))) {
            leave(state.left, m.table, m.id);
          }
        }
      } else if (phase === 'activities') {
        const list = cs.movedActivities ?? [];
        for (; from < list.length; from++) {
          if (!(await room(SMALL_COST))) {
            stopped = true;
            break;
          }
          done++;
          const a = list[from] as NonNullable<MergeChangeSet['movedActivities']>[number];
          if (!(await activityBack(ctx, a, survivorId, loserId))) {
            leave(state.left, 'gpsActivities', a.id);
          }
        }
      } else if (phase === 'favorites') {
        for (; from < cs.deletedFavorites.length; from++) {
          if (!(await room(SMALL_COST))) {
            stopped = true;
            break;
          }
          done++;
          const f = cs.deletedFavorites[from] as MergeChangeSet['deletedFavorites'][number];
          if (!(await favoriteBack(ctx, f, loserId))) leave(state.left, 'deletedFavorites', f.id);
        }
      } else if (phase === 'bays') {
        const bays = baysOf(cs);
        for (; from < bays.length; from++) {
          if (!(await room(SHAPE_COST))) {
            stopped = true;
            break;
          }
          done++;
          const b = bays[from] as Snap;
          if (!(await shapeBack(ctx, 'waterBodySubAreas', b, mergedAt))) {
            leave(state.left, 'waterBodySubAreas', b.id);
          }
        }
      } else if (phase === 'landmarks') {
        const changed = landmarksOf(cs);
        for (; from < changed.length; from++) {
          if (!(await room(SHAPE_COST))) {
            stopped = true;
            break;
          }
          done++;
          const b = changed[from] as Snap;
          if (!(await shapeBack(ctx, 'bodyLandmarks', b, mergedAt))) {
            leave(state.left, 'bodyLandmarks', b.id);
          }
        }
      } else if (phase === 'sides') {
        const sides = cs.sideActions ?? [];
        for (; from < sides.length; from++) {
          if (!(await room(SIDE_COST))) {
            stopped = true;
            break;
          }
          done++;
          const id = sides[from] as Id<'moderationActions'>;
          if (!(await sideUndone(ctx, cs, id, state))) leave(state.left, 'sideActions', id);
        }
      } else {
        if (!(await room(DERIVED_COST))) {
          stopped = true;
        } else {
          done++;
          await recomputeDerived(ctx, cs, state.actorId);
          from = 1;
        }
      }
      if (stopped) {
        cursor = { phase, from };
        break;
      }
      const next = PHASES[PHASES.indexOf(phase) + 1];
      cursor = next === undefined ? null : { phase: next, from: 0 };
    }
  });

  await recordLeft(ctx, state.unmergeId, state.left, cursor === null);
  if (cursor !== null) {
    const carried: AuditContext = await auditContextOf(ctx);
    await ctx.scheduler.runAfter(0, internal.unmerge.unmergeRest, {
      unmergeId: state.unmergeId,
      mergeActionId: mergeRow._id,
      phase: cursor.phase,
      from: cursor.from,
      ...(state.actorId !== undefined ? { actorId: state.actorId } : {}),
      ...carried,
    });
  }
}

/**
 * Row 4–7: one moved row back to the loser, when it is still on the survivor and not decided since —
 * through the merge's own re-point: a report re-mirrors its bay join, an ask or a flag re-keys into
 * the loser's Inbox item. `false` when it is left (on another body, gone, decided since, or a
 * favorite the person now holds on the loser too).
 */
async function moveBack(
  ctx: MutationCtx,
  m: MergeChangeSet['moved'][number],
  survivorId: Id<'waterBodies'>,
  loserId: Id<'waterBodies'>,
  mergedAt: number,
): Promise<boolean> {
  switch (m.table) {
    case 'contentFlags': {
      const flag = await ctx.db.get(m.id as Id<'contentFlags'>);
      if (flag?.targetType !== 'waterbody' || flag.targetId !== survivorId) return false;
      // Decided since: it stands, on the survivor.
      if (!(OPEN_FLAG_STATUSES as readonly string[]).includes(flag.status)) return false;
      await ctx.db.patch(flag._id, { targetId: loserId });
      await rekey(ctx, flagSource(flag._id));
      return true;
    }
    case 'waterBodyRequests': {
      const ask = await ctx.db.get(m.id as Id<'waterBodyRequests'>);
      if (!ask || ask.waterBodyId !== survivorId) return false;
      if (ask.decidedAt !== undefined && ask.decidedAt > mergedAt) return false;
      await ctx.db.patch(ask._id, { waterBodyId: loserId });
      await rekey(ctx, requestSource(ask._id));
      return true;
    }
    case 'corpusPlaceNames': {
      const name = await ctx.db.get(m.id as Id<'corpusPlaceNames'>);
      if (!name || name.waterBodyId !== survivorId || name.status !== 'open') return false;
      await ctx.db.patch(name._id, { waterBodyId: loserId });
      return true;
    }
    case 'waterBodyFavorites': {
      const fav = await ctx.db.get(m.id as Id<'waterBodyFavorites'>);
      if (!fav || fav.waterBodyId !== survivorId) return false;
      // One row per person × body × bay: one they hold on the loser already keeps it.
      const twin = await ctx.db
        .query('waterBodyFavorites')
        .withIndex('by_user_water_body_sub_area', (q) =>
          q.eq('userId', fav.userId).eq('waterBodyId', loserId).eq('subAreaId', fav.subAreaId),
        )
        .first();
      if (twin !== null) return false;
      await ctx.db.patch(fav._id, { waterBodyId: loserId });
      return true;
    }
    case 'reports': {
      const report = await ctx.db.get(m.id as Id<'reports'>);
      if (!report || report.waterBodyId !== survivorId) return false;
      await ctx.db.patch(report._id, { waterBodyId: loserId });
      await mirrorReportSubAreas(ctx, { ...report, waterBodyId: loserId });
      return true;
    }
    default: {
      const row = (await ctx.db.get(m.id as Id<'hazards'>)) as { waterBodyId?: string } | null;
      if (!row || row.waterBodyId !== survivorId) return false;
      await ctx.db.patch(m.id as Id<'hazards'>, { waterBodyId: loserId });
      return true;
    }
  }
}

/**
 * A founding skate back (fork 2): when its body is still what the merge made it — the loser's place
 * taken by the survivor — both of its body fields go back as recorded.
 */
async function activityBack(
  ctx: MutationCtx,
  a: NonNullable<MergeChangeSet['movedActivities']>[number],
  survivorId: Id<'waterBodies'>,
  loserId: Id<'waterBodies'>,
): Promise<boolean> {
  const row = await ctx.db.get(a.id);
  if (!row) return false;
  const expected = a.waterBodyId === loserId ? survivorId : a.waterBodyId;
  if ((row.waterBodyId ?? null) !== expected) return false;
  await ctx.db.patch(row._id, {
    waterBodyId: a.waterBodyId ?? undefined,
    waterBodyIds: a.waterBodyIds.length > 0 ? a.waterBodyIds : undefined,
  });
  return true;
}

/**
 * Row 6: a favorite the merge dropped as a duplicate, made again on the loser for the kept row's
 * owner and bay, with its own first `createdAt` (a new id). Left when the kept row is gone — there is
 * nothing to name, and the snapshot names no one.
 */
async function favoriteBack(
  ctx: MutationCtx,
  f: MergeChangeSet['deletedFavorites'][number],
  loserId: Id<'waterBodies'>,
): Promise<boolean> {
  const kept = await ctx.db.get(f.keptFavoriteId);
  if (!kept) return false;
  const twin = await ctx.db
    .query('waterBodyFavorites')
    .withIndex('by_user_water_body_sub_area', (q) =>
      q.eq('userId', kept.userId).eq('waterBodyId', loserId).eq('subAreaId', kept.subAreaId),
    )
    .first();
  if (twin !== null) return true;
  await ctx.db.insert('waterBodyFavorites', {
    userId: kept.userId,
    waterBodyId: loserId,
    ...(kept.subAreaId !== undefined ? { subAreaId: kept.subAreaId } : {}),
    createdAt: f.createdAt,
  });
  return true;
}

/** A row as a snapshot stores it (`snapshotDoc`): its id and creation time renamed. */
type Snap = { id: string; creationTime: number; updatedAt?: number } & Record<string, unknown>;

/** Every bay the merge could have changed — the loser's, and the survivor's the re-clip changed. */
function baysOf(cs: MergeChangeSet): Snap[] {
  const seen = new Set<string>();
  const out: Snap[] = [];
  for (const b of [
    ...(cs.subAreasBefore as unknown as Snap[]),
    ...((cs.survivorSubAreasBefore ?? []) as unknown as Snap[]),
  ]) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    out.push(b);
  }
  return out;
}

/** The landmarks the merge changed (`landmarksAfter`), as they stood before it. */
function landmarksOf(cs: MergeChangeSet): Snap[] {
  const before = new Map((cs.landmarksBefore as unknown as Snap[]).map((b) => [b.id, b]));
  return cs.landmarksAfter.flatMap((a) => {
    const b = before.get(a.id);
    return b ? [b] : [];
  });
}

/** A snapshot's fields as a document's, its id and creation time dropped. */
function fieldsOf(snap: Snap): Record<string, unknown> {
  const { id: _id, creationTime: _created, ...rest } = snap;
  return rest;
}

/** A document's fields, its system fields dropped. */
function docFields(doc: { _id: string; _creationTime: number }): Record<string, unknown> {
  const { _id, _creationTime, ...rest } = doc as Record<string, unknown>;
  return rest;
}

/**
 * Rows 8–10: a bay or a landmark back to its before-image, when nothing has edited it since the
 * merge (its `updatedAt` no later than the merge's row). The derived facts — cells, the name lists,
 * the stamps — follow in the last page, through their own paths. `false` when it is left: gone, or
 * edited since (its edit stands).
 */
async function shapeBack(
  ctx: MutationCtx,
  table: 'waterBodySubAreas' | 'bodyLandmarks',
  before: Snap,
  mergedAt: number,
): Promise<boolean> {
  const row = await ctx.db.get(before.id as Id<typeof table>);
  if (!row) return false;
  const fields = fieldsOf(before);
  if (sameJson(docFields(row), fields)) return true;
  if ((row.updatedAt ?? 0) > mergedAt) return false;
  await ctx.db.replace(row._id, fields as never);
  return true;
}

/**
 * A row the merge wrote beside its own (an automatic delist, a fold, a retirement) marked undone: one
 * `unmerge_waterbody` row on its target that `undoes:` it, so History reads it as undone and the
 * engine refuses its own undo — once its target stands as it did before the merge. `false` when the
 * target was left (edited since), so the side row's own account of it still holds.
 */
async function sideUndone(
  ctx: MutationCtx,
  cs: MergeChangeSet,
  sideId: Id<'moderationActions'>,
  state: PageState,
): Promise<boolean> {
  const side = await ctx.db.get(sideId);
  if (!side) return true;
  const undone = await ctx.db
    .query('moderationActions')
    .withIndex('by_undoes', (q) => q.eq('undoesActionId', sideId))
    .first();
  if (undone !== null) return true;
  const before = [...baysOf(cs), ...(cs.landmarksBefore as unknown as Snap[])].find(
    (b) => b.id === side.targetId,
  );
  const table: TableNames | null =
    side.targetType === 'waterBodySubArea'
      ? 'waterBodySubAreas'
      : side.targetType === 'bodyLandmark'
        ? 'bodyLandmarks'
        : null;
  const id = table ? ctx.db.normalizeId(table, side.targetId) : null;
  const target = id ? await ctx.db.get(id) : null;
  if (!before || !target || !sameJson(docFields(target), fieldsOf(before))) return false;
  await writeAudit(ctx, {
    ...(state.actorId !== undefined ? { actorId: state.actorId } : {}),
    action: 'unmerge_waterbody',
    targetType: side.targetType,
    targetId: side.targetId,
    reason: composed`Put back by the unmerge`,
    undoesActionId: sideId,
    metadata: { mergeActionId: state.mergeRow._id, unmergeActionId: state.unmergeId },
    createdAt: Date.now(),
  });
  return true;
}

/**
 * Row 13, the last page: what derives from the rows, recomputed for both bodies through the paths
 * that keep it — bays' cells, both name lists, both map cards, the library, the geometry facts, the
 * survivor's *Changed* (forward only: the unmerge stamps it again), two restamps and two recurrences.
 */
async function recomputeDerived(
  ctx: MutationCtx,
  cs: MergeChangeSet,
  actorId: Id<'profiles'> | undefined,
): Promise<void> {
  const bodies = [cs.loserId, cs.survivorId];
  for (const id of bodies) {
    const body = await ctx.db.get(id);
    if (body) await syncCellsForParent(ctx, id, body);
  }
  // Both rows rebuilt in transactions of their own, as the merge leaves them (`lib/bodyNames`).
  setNamesAllowance(ctx, 0);
  for (const id of bodies) await refreshBodyNames(ctx, id);
  for (const id of bodies) await recomputeBodySummary(ctx, id);
  await markGeoStale(ctx, bodies);
  await queueLibraryRefresh(ctx, bodies);
  if (actorId !== undefined) await stampChanged(ctx, cs.survivorId, Date.now());
  for (const id of bodies) {
    await scheduleRestamp(ctx, id);
    await ctx.scheduler.runAfter(0, internal.recurrence.enqueueBody, { waterBodyId: id });
  }
}

/** Two values the same as stored JSON, key order aside. */
function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// ── The later pages ────────────────────────────────────────────────────────────────────────────────

/**
 * **A later page of an unmerge** — the same act, in its own transaction, under the audit context its
 * first page carried (`asContinuationOf`). It re-reads the change set and stops once the unmerge is no
 * longer current: a row `undoes:` it, or the loser has been merged again since (its rows are that
 * merge's now). Internal, so no client can call it with a forged context.
 */
export const unmergeRest = internalMutation({
  args: {
    unmergeId: v.id('moderationActions'),
    mergeActionId: v.id('moderationActions'),
    phase: v.union(...PHASES.map((p) => v.literal(p))),
    from: v.number(),
    actorId: v.optional(v.id('profiles')),
    ...auditContextArgs,
  },
  handler: async (ctx, args) => {
    const undone = await ctx.db
      .query('moderationActions')
      .withIndex('by_undoes', (q) => q.eq('undoesActionId', args.unmergeId))
      .first();
    if (undone !== null) return;
    const mergeRow = await ctx.db.get(args.mergeActionId);
    if (!mergeRow) return;
    const cs = await readChangeSet(ctx, mergeRow._id);
    if (cs === null || cs === 'missing') return;
    const loser = await ctx.db.get(cs.loserId);
    if (!loser || loser.dedupStatus === 'merged') return;
    await asContinuationOf(ctx, { undoOf: args.undoOf, via: args.via }, () =>
      runPage(ctx, {
        cs,
        mergeRow,
        unmergeId: args.unmergeId,
        actorId: args.actorId,
        cursor: { phase: args.phase, from: args.from },
        left: noneLeft(),
      }),
    );
  },
});

// ── The receipt ────────────────────────────────────────────────────────────────────────────────────

/** What an unmerge has done so far, as the receipt and History read it. */
export interface UnmergeReceipt {
  /** The unmerge's own row (`unmerge_waterbody` on the loser). */
  unmergeActionId: Id<'moderationActions'>;
  /** Every page has landed (the last recomputed the derived facts). */
  done: boolean;
  /** What it left where it was, counted (by kind) and the first rows named — final once `done`. */
  left: UnmergeLeft;
}

/**
 * **The unmerge of a merge, as it stands** — the receipt's answer to "what did that undo leave?"
 * (`undo.run` answers nothing of its own). Keyed by the merge's row, which the receipt already holds;
 * `null` until an unmerge of it exists. Live: a paged unmerge's count grows as its pages land and
 * `done` turns true with the last, so the receipt can draw the first page's answer at once and the
 * final count when it arrives. History reads the same fields off the unmerge's row
 * (`metadata.left`, `metadata.done`).
 */
export const receipt = query({
  args: { mergeActionId: v.id('moderationActions') },
  handler: async (ctx, { mergeActionId }): Promise<UnmergeReceipt | null> => {
    await requireCapability(ctx, 'audit.read');
    const rows = await ctx.db
      .query('moderationActions')
      .withIndex('by_undoes', (q) => q.eq('undoesActionId', mergeActionId))
      .take(16);
    const row = rows.find((r) => r.action === 'unmerge_waterbody' && r.targetType === 'waterbody');
    if (!row) return null;
    const metadata = (row.metadata ?? {}) as { left?: UnmergeLeft; done?: boolean };
    return {
      unmergeActionId: row._id,
      done: metadata.done === true,
      left: metadata.left ?? noneLeft(),
    };
  },
});
