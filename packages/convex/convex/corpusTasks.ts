/**
 * **The Corpus tasks' reads** (B01-6a, *The reads, one shape* in the B01 phase doc): the lanes'
 * counts, a lane's page, and one task's item behind `?item=`.
 *
 * Every list reads the stored tasks (`corpusTasks`, written only by `lib/corpusTasks.ts`), never a
 * page of the source tables; every count reads `corpusTaskCounts`, moved with the tasks; every row
 * and item carries `can` — for each verb its handler draws, `null` (allowed) or the sentence the
 * write would refuse with (`lib/corpusRules.ts`, the one rule the writes ask too, D217, D268). Labels
 * are resolved at read (`lib/corpusTaskViews.ts`, which holds the view types re-exported here).
 *
 * All gated on `corpus.read`, and bounded (`lib/corpusTaskViews.ts` says each bound). Each takes the
 * console's read clock (`now`), though no answer here turns on the time yet.
 *
 * 6a's two lanes hold `name-conflict` and `class-conflict` tasks only: a `class-dissent` reason, or a
 * body's stored `classRefusals`, changes nothing these reads return (D306).
 */

import {
  CORPUS_NOT_RECORDED,
  CORPUS_PAGE_SIZE,
  CORPUS_TASK_FACETS,
  CORPUS_TASK_LANES,
  type CorpusTaskLane,
  SEARCH_MIN_CHARS,
} from '@skating/core';
import type { NamedTableInfo, OrderedQuery } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import type { DataModel, Doc, Id } from './_generated/dataModel';
import { type QueryCtx, query } from './_generated/server';
import { requireCapability } from './lib/auth';
import { corpusTasksPending, countKeysOf, readTaskCount } from './lib/corpusTasks';
import {
  type CorpusLanesView,
  type CorpusListPage,
  CorpusReader,
  type CorpusRowView,
  type CorpusTaskItemRead,
  itemOf,
  MAX_PAGE,
  rowOf,
  TASKS_PER_BODY,
  taskOfRef,
} from './lib/corpusTaskViews';
import { literals } from './lib/validators';

export type {
  ClassClaimView,
  ClassRungView,
  CorpusDecidedState,
  CorpusLanesView,
  CorpusListPage,
  CorpusRowView,
  CorpusTaskItemRead,
  CorpusTaskItemView,
  NameChoiceView,
} from './lib/corpusTaskViews';

/**
 * The console's read clock. No answer here turns on the time yet; the page passes it, as it does to
 * every console read, and keys its subscriptions by it.
 */
const nowArg = { now: v.optional(v.number()) };

/** The longest search read; the rest is dropped. */
const SEARCH_MAX_CHARS = 100;
/** A lane's task matches a search reads at most (`scanBudgetSpent` past it). */
export const SEARCH_SCAN = 100;

/** A refusal for a tab the lane doesn't have (the page's search drops one before it gets here). */
export const NO_SUCH_TAB = 'There is no such tab in this lane';

/** The lane's tabs with a count and a page of their own: its facets but `notRecorded`. */
const tabsOf = (lane: CorpusTaskLane): readonly string[] =>
  (CORPUS_TASK_FACETS[lane] as readonly string[]).filter((f) => f !== CORPUS_NOT_RECORDED);

// ── The counts ───────────────────────────────────────────────────────────────────────────────────

/**
 * **Every task lane's open count and each tab's**, exact from the count rows (`open:<lane>`,
 * `open:<lane>:<facet>`) — no cap, so *Name conflicts 412* reads 412. One point read per key: two
 * lanes and their tabs. The sidebar, the Overview's Corpus card and Inbox Zero's line read it.
 */
export const lanes = query({
  args: { ...nowArg },
  handler: async (ctx): Promise<CorpusLanesView> => {
    await requireCapability(ctx, 'corpus.read');
    const out = {} as CorpusLanesView['lanes'];
    for (const lane of CORPUS_TASK_LANES) {
      // The writer's own keys (`countKeysOf`): an open task stands in its lane's row and its tab's.
      const keysOf = (facet: string) => countKeysOf({ status: 'open', lane, facet });
      const facets: Record<string, number> = {};
      for (const facet of tabsOf(lane)) {
        facets[facet] = await readTaskCount(ctx, keysOf(facet)[1] ?? '');
      }
      out[lane] = { open: await readTaskCount(ctx, keysOf(CORPUS_NOT_RECORDED)[0] ?? ''), facets };
    }
    return { lanes: out, pending: await corpusTasksPending(ctx) };
  },
});

// ── A lane's page ──────────────────────────────────────────────────────────────────────────────────

/** The search: trimmed, at most {@link SEARCH_MAX_CHARS}, and none under the library's minimum. */
function searchOf(q: string | undefined): string {
  const t = (q ?? '').trim().slice(0, SEARCH_MAX_CHARS).trim();
  return t.length >= SEARCH_MIN_CHARS ? t : '';
}

/** The tab asked for, checked against the lane: `null` is *All*. */
function tabOf(lane: CorpusTaskLane, tab: string | undefined): string | null {
  if (tab === undefined || tab === '' || tab === 'all') return null;
  if (tab === 'decided' || tabsOf(lane).includes(tab)) return tab;
  throw new ConvexError(NO_SUCH_TAB);
}

/**
 * The bodies a search names exactly, each once: an id of ours or a catalog's (`by_osm_id`,
 * `by_nhd_id`, `by_three_dhp_id`, `by_water_body_key`, each an `eq` on the real value) — five point
 * reads at most, so a pasted id finds its body whether or not its tasks' search text is yet written.
 */
async function bodiesById(ctx: QueryCtx, q: string): Promise<Id<'waterBodies'>[]> {
  const ids: Id<'waterBodies'>[] = [];
  const add = (id: Id<'waterBodies'> | null | undefined) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  add(ctx.db.normalizeId('waterBodies', q));
  const bodies = ctx.db.query('waterBodies');
  add((await bodies.withIndex('by_osm_id', (r) => r.eq('osmId', q)).first())?._id);
  add((await bodies.withIndex('by_nhd_id', (r) => r.eq('nhdId', q)).first())?._id);
  add((await bodies.withIndex('by_three_dhp_id', (r) => r.eq('threeDhpId', q)).first())?._id);
  add((await bodies.withIndex('by_water_body_key', (r) => r.eq('waterBodyKey', q)).first())?._id);
  return ids;
}

/**
 * **A search's page, within the lane** — never the whole library first: a task on a common name
 * ("Mud Pond", 150 bodies of it, two asked about) is found because the search reads only the lane's
 * own tasks. First the tasks of a body an exact id names (`by_body_status`, the lane and tab checked
 * in memory, a body's decisions newest first); then the lane's search index over each task's search
 * text (`corpusTasks.search_text`: both names, every other, the ids — the library's rule), filtered by
 * the lane, the status and the tab, at most {@link SEARCH_SCAN} matches, best first, a body's
 * decisions kept together and newest first. One bounded read, not a chain (`isDone`);
 * `scanBudgetSpent` when it stopped at a bound with more that might match.
 */
async function searchPage(
  ctx: QueryCtx,
  r: CorpusReader,
  args: { lane: CorpusTaskLane; tab: string | null; q: string; pageSize: number },
): Promise<{ rows: CorpusRowView[]; spent: boolean }> {
  const status = args.tab === 'decided' ? ('decided' as const) : ('open' as const);
  const facet = args.tab === 'decided' ? null : args.tab;
  const inTab = (t: Doc<'corpusTasks'>) =>
    t.lane === args.lane && t.status === status && (facet === null || t.facet === facet);
  const newestFirst = (a: Doc<'corpusTasks'>, b: Doc<'corpusTasks'>) =>
    (b.decidedAt ?? 0) - (a.decidedAt ?? 0);

  const tasks: Doc<'corpusTasks'>[] = [];
  for (const waterBodyId of await bodiesById(ctx, args.q)) {
    const own = await ctx.db
      .query('corpusTasks')
      .withIndex('by_body_status', (q) => q.eq('waterBodyId', waterBodyId).eq('status', status))
      .order('desc')
      .take(TASKS_PER_BODY);
    tasks.push(...own.filter(inTab).sort(newestFirst));
  }
  const found = await ctx.db
    .query('corpusTasks')
    .withSearchIndex('search_text', (x) => {
      const inLane = x.search('searchText', args.q).eq('lane', args.lane).eq('status', status);
      return facet === null ? inLane : inLane.eq('facet', facet);
    })
    .take(SEARCH_SCAN + 1);
  const capped = found.length > SEARCH_SCAN;
  // Best first by body, a body's own tasks together (newest decision first), each task once.
  const byBody = new Map<Id<'waterBodies'>, Doc<'corpusTasks'>[]>();
  for (const task of found.slice(0, SEARCH_SCAN)) {
    byBody.set(task.waterBodyId, [...(byBody.get(task.waterBodyId) ?? []), task]);
  }
  const seen = new Set(tasks.map((t) => t._id));
  for (const group of byBody.values()) {
    for (const task of group.filter(inTab).sort(newestFirst)) {
      if (!seen.has(task._id)) tasks.push(task);
      seen.add(task._id);
    }
  }

  const rows: CorpusRowView[] = [];
  for (const task of tasks) {
    if (rows.length === args.pageSize) return { rows, spent: true };
    const row = await rowOf(r, task);
    if (row !== null) rows.push(row);
  }
  return { rows, spent: capped };
}

/**
 * **A lane's page**: *All* (every open task, the `notRecorded` ones included), one tab's open tasks
 * (a facet, never `notRecorded`), or `decided` — the tasks a person decided, newest first, never one
 * that left. Ranked by the task's `rankKey` (the body's prominence), one `.paginate()` on the lane's
 * own index, People's `endCursor` chain: a page read past is pinned to `(cursor, endCursor]`, so a
 * decision on page one moves nothing on page two. `q` searches the lane's own tasks instead (by
 * either name, id or external id; {@link searchPage}). A task whose body is gone is not drawn.
 */
export const listPage = query({
  args: {
    lane: literals(CORPUS_TASK_LANES),
    /** A facet of the lane (never `notRecorded`) or `decided`; absent: *All*, open. */
    tab: v.optional(v.string()),
    /** The task's body by name, id or external id. */
    q: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    /** Where the page ended when first read: the page then reads exactly `(cursor, endCursor]`. */
    endCursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    ...nowArg,
  },
  handler: async (ctx, args): Promise<CorpusListPage> => {
    const viewer = await requireCapability(ctx, 'corpus.read');
    const lane = args.lane;
    const tab = tabOf(lane, args.tab);
    const asked = args.pageSize ?? CORPUS_PAGE_SIZE;
    const pageSize = Math.min(
      Math.max(1, Math.floor(Number.isFinite(asked) ? asked : 1)),
      MAX_PAGE,
    );
    const pending = await corpusTasksPending(ctx);
    const r = new CorpusReader(ctx, viewer);

    const q = searchOf(args.q);
    if (q !== '') {
      // One page: a later page of a search reads nothing (there is none).
      if ((args.cursor ?? null) !== null) {
        return { rows: [], isDone: true, continueCursor: '', scanBudgetSpent: false, pending };
      }
      const { rows, spent } = await searchPage(ctx, r, { lane, tab, q, pageSize });
      return { rows, isDone: true, continueCursor: '', scanBudgetSpent: spent, pending };
    }

    const tasks = ctx.db.query('corpusTasks');
    let ranged: OrderedQuery<NamedTableInfo<DataModel, 'corpusTasks'>>;
    if (tab === 'decided') {
      // `eq` on lane and status: the open and left rows (no `decidedAt`) are never in the range.
      ranged = tasks
        .withIndex('by_lane_status_decided', (x) => x.eq('lane', lane).eq('status', 'decided'))
        .order('desc');
    } else if (tab !== null) {
      ranged = tasks.withIndex('by_status_lane_facet_rank', (x) =>
        x.eq('status', 'open').eq('lane', lane).eq('facet', tab),
      );
    } else {
      ranged = tasks.withIndex('by_status_lane_rank', (x) =>
        x.eq('status', 'open').eq('lane', lane),
      );
    }
    const endCursor = args.endCursor ?? null;
    const page = await ranged.paginate({
      cursor: args.cursor ?? null,
      numItems: pageSize,
      ...(endCursor !== null ? { endCursor } : {}),
    });
    const rows: CorpusRowView[] = [];
    for (const task of page.page) {
      const row = await rowOf(r, task);
      if (row !== null) rows.push(row);
    }
    return {
      rows,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      ...(page.splitCursor ? { splitCursor: page.splitCursor } : {}),
      ...(page.pageStatus ? { pageStatus: page.pageStatus } : {}),
      scanBudgetSpent: false,
      pending,
    };
  },
});

// ── One task ────────────────────────────────────────────────────────────────────────────────────────

/**
 * **One task behind `?item=`**: `ref` a task id, or `body:<id>` — the body's task in `lane` (open,
 * else its latest decision), so the audit feed's links and the Body console resolve to the task
 * that holds them. `item: null` is *No such task*: no task, one that left with no decision, or one
 * whose body is gone. `pending` while the backfill runs (*Not yet*).
 */
export const item = query({
  args: { ref: v.string(), lane: v.optional(literals(CORPUS_TASK_LANES)), ...nowArg },
  handler: async (ctx, args): Promise<CorpusTaskItemRead> => {
    const viewer = await requireCapability(ctx, 'corpus.read');
    const pending = await corpusTasksPending(ctx);
    const task = await taskOfRef(ctx, args.ref.trim(), args.lane);
    if (task === null) return { item: null, pending };
    return { item: await itemOf(new CorpusReader(ctx, viewer), task), pending };
  },
});
