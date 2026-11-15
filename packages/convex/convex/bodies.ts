/**
 * **The Bodies library's reads** (B01-3) — the list, its counts and the preview, over the stored
 * library row (`bodyLibraryRows`, written only by `lib/bodyLibrary.ts`). The design is in B01 §12.8,
 * *The Bodies library on the server*. Every read is gated on `body.read`.
 *
 * - {@link listPage} — one page of a lane: an index range per sort column, the state tab as the
 *   index's scope, a search through the search index, facets narrowing inside the paged read.
 * - {@link listSummary} — the lanes' counts, the corpus, the state tabs, the list's total and its
 *   facet counts, and what the list read honors for this query.
 * - {@link preview} — what the list's preview needs beyond the reads that already exist: reports this
 *   season (by vantage) and all time, the open asks, the towns, completeness.
 *
 * **`null` is "not recorded"**, never a zero: an area nobody measured, a change no moderator made, a
 * count the stored counts cannot answer for this query.
 */

import {
  ADVISORY_REVIEW_REASONS,
  ALL_LANE,
  appliedFacets,
  callerNow,
  clampPageSize,
  currentSeason,
  facetKey,
  LIBRARY_FACET_IDS,
  LIBRARY_FACETS,
  LIBRARY_LANES,
  LIBRARY_LIST_LANES,
  type LibraryFacet,
  type LibraryFacetSelection,
  type LibraryListLane,
  matchedAlias,
  type OBSERVED_FROM,
  REQUEST_KINDS,
  REVIEW_REASON_PRIORITY,
  type ReviewReason,
  SCOPE_ALL,
  SEARCH_MIN_CHARS,
  seasonOf,
  seasonRecordSpan,
  servedCounts,
  TOTAL_KEY,
  UNKNOWN_LAST_ASC,
} from '@skating/core';
import { type PaginationResult, paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type QueryCtx, query } from './_generated/server';
import { requireCapability } from './lib/auth';
import { resolveSurvivor } from './lib/bodies';
import { geoFactsOf, townsWithStateOf } from './lib/bodyGeo';
import { type LibraryRow, openAsksFor, readCount } from './lib/bodyLibrary';
import { FLAG_REASONS } from './lib/enums';
import { OPEN_FLAG_STATUSES } from './lib/openFlags';
import { literals } from './lib/validators';

/** How long the caller's clock may drift from the server's. */
const CLOCK_SLACK_MS = 5 * 60_000;
/** *Changed this week*: a moderator's action in the last seven days. */
export const CHANGED_WITHIN_MS = 7 * 86_400_000;
/** The rows a page may scan to fill itself while facets narrow it — about a megabyte. */
export const PAGE_MAX_ROWS_READ = 2_000;
/** The most rows the *Changed this week* count reads before it says it stopped. */
const CHANGED_COUNT_CAP = 500;
/** Count keys one lane and scope can hold: the total and every facet option, with room to spare. */
const COUNT_KEYS_CAP = 1 + Object.values(LIBRARY_FACETS).reduce((n, o) => n + o.length, 0) + 32;

export const BODY_COLUMNS = [
  'name',
  'class',
  'state',
  'acres',
  'complete',
  'asks',
  'reports',
  'changed',
] as const;
type BodyColumn = (typeof BODY_COLUMNS)[number];

const facetsArg = v.object(
  Object.fromEntries(LIBRARY_FACET_IDS.map((f) => [f, v.optional(v.array(v.string()))])) as Record<
    LibraryFacet,
    ReturnType<typeof v.optional<ReturnType<typeof v.array<ReturnType<typeof v.string>>>>>
  >,
);

const listArgs = {
  lane: literals(LIBRARY_LIST_LANES),
  /** A state tab; absent is All. */
  state: v.optional(v.string()),
  /** The search; under two characters is no search. */
  q: v.optional(v.string()),
  facets: v.optional(facetsArg),
  /** The page's clock (the minute), for *Changed this week* and the season's reports. */
  now: v.optional(v.number()),
};

/** The longest search read; the rest is dropped. */
const SEARCH_MAX_CHARS = 100;

/** The most raw options a facet's argument is read for (its known options are far fewer). */
const MAX_FACET_INPUT = 32;

/** The search: trimmed, at most {@link SEARCH_MAX_CHARS}, and none under {@link SEARCH_MIN_CHARS}. */
export const searchOf = (q: string | undefined) => {
  const t = (q ?? '').trim().slice(0, SEARCH_MAX_CHARS).trim();
  return t.length >= SEARCH_MIN_CHARS ? t : '';
};

/** The state tab: a two-letter code in any case, else All. */
export const scopeOf = (state: string | undefined) => {
  const code = (state ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : SCOPE_ALL;
};

/**
 * The facets as one canonical selection: each facet's known options only, each once, in the menu's
 * order, read from at most {@link MAX_FACET_INPUT} raw entries — so a repeated, unknown, empty or
 * oversized argument narrows nothing it can't, and the filter and the counts see the same selection.
 */
export function cleanFacets(facets: LibraryFacetSelection | undefined): LibraryFacetSelection {
  const out: LibraryFacetSelection = {};
  for (const facet of LIBRARY_FACET_IDS) {
    const asked = new Set((facets?.[facet] ?? []).slice(0, MAX_FACET_INPUT));
    const known = (LIBRARY_FACETS[facet] as readonly string[]).filter((o) => asked.has(o));
    if (known.length > 0) out[facet] = known;
  }
  return out;
}

/**
 * **A list query, normalized once at the edge** — the one canonical form `listPage` and
 * `listSummary` both read, so a page and its counts can never answer two different questions.
 */
export function listQueryOf(args: {
  state?: string | undefined;
  q?: string | undefined;
  facets?: LibraryFacetSelection | undefined;
  now?: number | undefined;
}) {
  return {
    now: callerNow(args.now, Date.now(), CLOCK_SLACK_MS),
    q: searchOf(args.q),
    scope: scopeOf(args.state),
    selection: cleanFacets(args.facets),
  };
}

// ── A row as the page draws it ───────────────────────────────────────────────────────────────

/** A library row as the list draws it — the page's `BodyRow`, with completeness as core states it. */
export interface LibraryRowView {
  id: Id<'waterBodies'>;
  name: string;
  matchedAlias?: string;
  bodyClass: Doc<'waterBodies'>['type'];
  states: string[];
  areaSqM: number | null;
  complete: { have: number; of: number; missing: LibraryRow['missing'] };
  asks: number;
  /** `asks` is a floor: a kind of ask reached its read cap. */
  asksCapped: boolean;
  asksWaiting: boolean;
  /** Reports this season; `0` from 1 July to 30 September, when the new season's record is empty. */
  reports: number;
  /** `reports` is a floor: the scan stopped inside the season's record. */
  reportsCapped: boolean;
  changedAt: number | null;
  standing: LibraryRow['standing'];
}

function rowView(row: LibraryRow, season: number, q: string): LibraryRowView {
  const alias = q === '' ? undefined : matchedAlias(row.name, row.aliases, q);
  return {
    id: row.waterBodyId,
    name: row.name,
    ...(alias !== undefined ? { matchedAlias: alias } : {}),
    bodyClass: row.bodyClass,
    states: row.states,
    areaSqM: row.areaSqM ?? null,
    complete: { have: row.completeHave, of: row.completeOf, missing: row.missing },
    asks: row.asks,
    asksCapped: row.asksCapped,
    asksWaiting: row.asksWaiting,
    // A row counted for an earlier season belongs to a record that has closed: the season sweep
    // re-counts it, and until it does the honest figure for this season is the empty record's.
    reports: row.reportsSeason === season ? row.reports : 0,
    reportsCapped: row.reportsSeason === season && row.reportsCapped,
    changedAt: row.changedAt ?? null,
    standing: row.standing,
  };
}

// ── The list ─────────────────────────────────────────────────────────────────────────────────

/** The index a column sorts by, for one lane or all of them. */
function indexFor(column: BodyColumn, dir: 'asc' | 'desc', laned: boolean): string {
  const base = laned ? 'by_scope_lane_' : 'by_scope_';
  switch (column) {
    case 'acres':
      return `${base}area_${dir}`;
    case 'changed':
      return `${base}changed_${dir}`;
    default:
      return `${base}${column}`;
  }
}

/** What the list read honors for a query: the sorts, the facets, the state tabs and the search. */
export function servesFor(lane: LibraryListLane, q: string) {
  if (q !== '') {
    // The search ranks: no column orders it.
    return { sort: [] as BodyColumn[], facets: [...LIBRARY_FACET_IDS], states: true, search: true };
  }
  return {
    sort: lane === 'changed' ? (['changed'] as BodyColumn[]) : [...BODY_COLUMNS],
    facets: [...LIBRARY_FACET_IDS],
    states: true,
    search: true,
  };
}

// The filter builder's own type is long to spell; the predicate is built against it at runtime.
// biome-ignore lint/suspicious/noExplicitAny: Convex's FilterBuilder generic over this table.
type F = any;

/** The facets as one filter expression: any option within a facet, every facet together. */
function facetFilter(f: F, selection: LibraryFacetSelection, season: number) {
  const terms: unknown[] = [];
  const field = (name: string) => f.field(name);
  for (const facet of appliedFacets(selection)) {
    const options = (selection[facet] ?? []).map((option): unknown => {
      switch (facet) {
        case 'class':
          return f.eq(field('bodyClass'), option);
        case 'size':
          return f.eq(field('size'), option);
        case 'outline':
          return f.eq(field('outline'), option);
        case 'putins':
          return f.eq(field('hasPutIns'), option === 'some');
        case 'reports':
          return option === 'season'
            ? f.and(f.gt(field('reports'), 0), f.eq(field('reportsSeason'), season))
            : f.eq(field('everReported'), false);
        case 'complete':
          return f.eq(field('complete'), option);
        default: // curation
          return option === 'curated'
            ? f.eq(field('curated'), true)
            : option === 'asks'
              ? f.gt(field('asks'), 0)
              : option === 'intake'
                ? f.eq(field('intake'), true)
                : f.eq(field('awaitingEnrichment'), true);
      }
    });
    terms.push(options.length === 1 ? options[0] : f.or(...options));
  }
  return terms.length === 0 ? true : terms.length === 1 ? terms[0] : f.and(...terms);
}

/**
 * **One page of a lane.** Ordered by the sort column's index (ties by name), or by the match while
 * searching; the state tab is the index's scope; facets narrow inside the read, which scans at most
 * {@link PAGE_MAX_ROWS_READ} rows a page — so a narrow facet returns a short page with more to come,
 * never a wrong one, and says so: `scanBudgetSpent` is true when the page came back short because
 * the scan ran out, not because the list ended (`isDone` stays false; the page keeps loading). A first page may ask for up to the library's most (`clampPageSize`), so a return
 * from a body reloads as many rows as were showing.
 *
 * Lanes: `all`, a standing lane, or `changed` (a moderator's action in the last seven days, newest
 * first — or oldest first; no other column orders it).
 */
export const listPage = query({
  args: {
    ...listArgs,
    /** The column and direction; absent is the match while searching, else name A→Z. */
    sort: v.optional(v.object({ column: literals(BODY_COLUMNS), dir: literals(['asc', 'desc']) })),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireCapability(ctx, 'body.read');
    const { now, q, scope, selection } = listQueryOf(args);
    const season = currentSeason(now);
    const opts = {
      ...args.paginationOpts,
      numItems: clampPageSize(args.paginationOpts.numItems),
      maximumRowsRead: PAGE_MAX_ROWS_READ,
    };
    const since = now - CHANGED_WITHIN_MS;
    const laned = (LIBRARY_LANES as readonly string[]).includes(args.lane);

    let page: PaginationResult<LibraryRow>;
    if (q !== '') {
      const searched = ctx.db.query('bodyLibraryRows').withSearchIndex('search_text', (s) => {
        const scoped = s.search('searchText', q).eq('scope', scope);
        return laned ? scoped.eq('lane', args.lane as (typeof LIBRARY_LANES)[number]) : scoped;
      });
      page = await searched
        .filter((f) =>
          f.and(
            args.lane === 'changed' ? f.gte(f.field('changedDesc'), since) : true,
            facetFilter(f, selection, season),
          ),
        )
        .paginate(opts);
    } else {
      const sort =
        args.lane === 'changed' && args.sort?.column !== 'changed'
          ? ({ column: 'changed', dir: 'desc' } as const)
          : (args.sort ?? ({ column: 'name', dir: 'asc' } as const));
      const index = indexFor(sort.column, sort.dir, laned);
      // biome-ignore lint/suspicious/noExplicitAny: the index name is chosen per column at runtime.
      const ranged = (ctx.db.query('bodyLibraryRows') as any).withIndex(index, (r: any) => {
        const scoped = r.eq('scope', scope);
        const withLane = laned ? scoped.eq('lane', args.lane) : scoped;
        if (args.lane !== 'changed') return withLane;
        // Changed this week: a lower bound on the change key (an unknown is -1 or the largest
        // number, outside the range either way).
        return sort.dir === 'desc'
          ? withLane.gte('changedDesc', since)
          : withLane.gte('changedAsc', since).lt('changedAsc', UNKNOWN_LAST_ASC);
      });
      page = await ranged
        .order(sort.dir)
        .filter((f: F) => facetFilter(f, selection, season))
        .paginate(opts);
    }
    return {
      ...page,
      page: page.page.map((row) => rowView(row, season, q)),
      // The page stopped because its scan budget ran out, not because the list ended: there may be
      // more matches past it, so the list keeps loading (`isDone` is false) and draws no end.
      // A reload pinned to an `endCursor` is sized by its range, not by `numItems`: only the read's
      // own split signal says the scan ran out there.
      scanBudgetSpent:
        !page.isDone &&
        (page.pageStatus === 'SplitRequired' ||
          (args.paginationOpts.endCursor == null && page.page.length < opts.numItems)),
    };
  },
});

// ── A search across standings ──────────────────────────────────────────────────────────────────

/** Matches each other standing shows at most. */
export const OTHER_STANDING_ROWS = 5;
/** Matches each other standing counts at most; past it the count is a floor (`capped`). */
export const OTHER_STANDING_COUNT_CAP = 50;

/**
 * **A search's matches in the other standings** (B01-3c) — beside a lane's search, the board's
 * "2 active · 4 dormant": for each standing lane but the one searched, how many bodies match (to
 * {@link OTHER_STANDING_COUNT_CAP}, `capped` past it) and the best {@link OTHER_STANDING_ROWS} of them
 * in the list's row shape. The same arguments as `listPage`, normalized the same way
 * (`listQueryOf`), so the search, the state tab and the facets mean what the lane's page means. No
 * groups for no search, nor for *All* or *Changed* (every standing is already in them). Each lane is
 * one search-index read, ranked by the match: the shown rows are the best, never a cap's leftovers.
 */
export const searchOtherStandings = query({
  args: listArgs,
  handler: async (ctx, args) => {
    await requireCapability(ctx, 'body.read');
    const { now, q, scope, selection } = listQueryOf(args);
    const season = currentSeason(now);
    const others =
      q === '' || args.lane === 'all' || args.lane === 'changed'
        ? []
        : LIBRARY_LANES.filter((lane) => lane !== args.lane);
    const groups = [];
    for (const lane of others) {
      const found = await ctx.db
        .query('bodyLibraryRows')
        .withSearchIndex('search_text', (s) =>
          s.search('searchText', q).eq('scope', scope).eq('lane', lane),
        )
        .filter((f) => facetFilter(f, selection, season))
        .take(OTHER_STANDING_COUNT_CAP + 1);
      groups.push({
        lane,
        count: Math.min(found.length, OTHER_STANDING_COUNT_CAP),
        capped: found.length > OTHER_STANDING_COUNT_CAP,
        rows: found.slice(0, OTHER_STANDING_ROWS).map((row) => rowView(row, season, q)),
      });
    }
    return { q, groups };
  },
});

// ── Rows by id ─────────────────────────────────────────────────────────────────────────────────

/** The most ids one `rowsByIds` call reads — *Opened recently* holds 12. */
export const ROWS_BY_IDS_MAX = 12;

/** What became of one requested id. */
export type RowByIdEntry = {
  /** The id as asked (trimmed). */
  requested: string;
  /**
   * `ok` — the row; `merged` — the row of the body it was merged into (`survivorId`); `unlisted` —
   * a body with no library row (or a merged one whose survivor has none); `unknown` — not a body id,
   * or no such body.
   */
  status: 'ok' | 'merged' | 'unlisted' | 'unknown';
  row: LibraryRowView | null;
  survivorId?: Id<'waterBodies'>;
};

/**
 * **The list's rows for a handful of ids** (B01-3c) — *Opened recently*. Ids are trimmed and
 * de-duplicated in the order given, then held to {@link ROWS_BY_IDS_MAX} (`dropped` counts the rest,
 * duplicates included); every id kept comes back in order with what became of it, never silently
 * left out. A row is one indexed read; only an id with no row reads its body (to follow a merge, at
 * most eight hops, as every body read does).
 */
export const rowsByIds = query({
  args: { ids: v.array(v.string()), now: v.optional(v.number()) },
  handler: async (ctx, { ids, now: asked }) => {
    await requireCapability(ctx, 'body.read');
    const season = currentSeason(callerNow(asked, Date.now(), CLOCK_SLACK_MS));
    const distinct = [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ''))];
    const kept = distinct.slice(0, ROWS_BY_IDS_MAX);
    const rowOf = (waterBodyId: Id<'waterBodies'>) =>
      ctx.db
        .query('bodyLibraryRows')
        .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId).eq('scope', SCOPE_ALL))
        .first();
    const entries: RowByIdEntry[] = [];
    for (const requested of kept) {
      const id = ctx.db.normalizeId('waterBodies', requested);
      if (id === null) {
        entries.push({ requested, status: 'unknown', row: null });
        continue;
      }
      const own = await rowOf(id);
      if (own !== null) {
        entries.push({ requested, status: 'ok', row: rowView(own, season, '') });
        continue;
      }
      const body = await ctx.db.get(id);
      if (body === null) {
        entries.push({ requested, status: 'unknown', row: null });
        continue;
      }
      if (body.dedupStatus !== 'merged') {
        entries.push({ requested, status: 'unlisted', row: null });
        continue;
      }
      const survivor = await resolveSurvivor(ctx, id);
      const row = survivor === null ? null : await rowOf(survivor._id);
      entries.push(
        row === null
          ? { requested, status: 'unlisted', row: null }
          : {
              requested,
              status: 'merged',
              row: rowView(row, season, ''),
              survivorId: row.waterBodyId,
            },
      );
    }
    return { entries, dropped: ids.length - kept.length };
  },
});

// ── The summary: counts and what the read honors ─────────────────────────────────────────────

type Count = { count: number; capped: boolean };

/** How many rows of a scope changed since `since`, counted up to a cap. */
async function changedCount(ctx: QueryCtx, scope: string, since: number): Promise<Count> {
  const rows = await ctx.db
    .query('bodyLibraryRows')
    .withIndex('by_scope_changed_desc', (r) => r.eq('scope', scope).gte('changedDesc', since))
    .take(CHANGED_COUNT_CAP + 1);
  return {
    count: Math.min(rows.length, CHANGED_COUNT_CAP),
    capped: rows.length > CHANGED_COUNT_CAP,
  };
}

/** Whether some row still counts an earlier season's reports — the season turn not yet finished. */
async function seasonTurning(ctx: QueryCtx, current: number): Promise<boolean> {
  for (let s = current - 1; s >= current - 3; s--) {
    const row = await ctx.db
      .query('bodyLibraryRows')
      .withIndex('by_reports_season', (q) => q.eq('reportsSeason', s).gt('reports', 0))
      .first();
    if (row !== null) return true;
  }
  return false;
}

/**
 * **The list's counts**: every lane's total (`changed` counted from its range, up to a cap), the
 * corpus, the lane's state tabs (most bodies first), and — for this query — the list's total and the
 * facet counts the stored counts answer exactly (`servedCounts`): every facet with nothing applied,
 * the one applied facet's own options, none with two. A search or *Changed this week* answers no
 * facet counts and no total (`null`).
 */
export const listSummary = query({
  args: listArgs,
  handler: async (ctx, args) => {
    await requireCapability(ctx, 'body.read');
    const { now, q, scope, selection } = listQueryOf(args);
    const lane = args.lane === 'changed' ? null : args.lane;

    const laneCounts: Record<string, Count> = {};
    for (const l of [ALL_LANE, ...LIBRARY_LANES]) {
      laneCounts[l] = { count: await readCount(ctx, l, SCOPE_ALL, TOTAL_KEY), capped: false };
    }
    laneCounts.changed = await changedCount(ctx, SCOPE_ALL, now - CHANGED_WITHIN_MS);

    const tabLane = lane ?? ALL_LANE;
    const stateRows = await ctx.db
      .query('bodyLibraryCounts')
      .withIndex('by_lane_key_scope', (r) => r.eq('lane', tabLane).eq('key', TOTAL_KEY))
      .take(64);
    const states = stateRows
      .filter((r) => r.scope !== SCOPE_ALL && r.count > 0)
      .sort((a, b) => b.count - a.count || a.scope.localeCompare(b.scope))
      .map((r) => r.scope);

    let total: Count | null = null;
    let facetCounts: Partial<Record<LibraryFacet, Record<string, number>>> | null = null;
    if (q === '' && lane !== null) {
      const served = servedCounts(selection);
      // Every key of this lane and scope in one range (the total and each facet option — a few dozen
      // rows), rather than a point read per option.
      const stored = await ctx.db
        .query('bodyLibraryCounts')
        .withIndex('by_lane_scope_key', (r) => r.eq('lane', lane).eq('scope', scope))
        .take(COUNT_KEYS_CAP);
      const countOf = new Map(stored.map((r) => [r.key, r.count]));
      // While the season turns, rows still counting last season's reports are filed under
      // *reported this season* in the counts, but the page's filter (and every row) reads them as
      // this season's empty record: the reports facet's counts would disagree with its pages, so the
      // read gives none until the turn finishes.
      const turning = await seasonTurning(ctx, currentSeason(now));
      facetCounts = {};
      for (const facet of served.facets) {
        if (turning && facet === 'reports') continue;
        const counts: Record<string, number> = {};
        for (const option of LIBRARY_FACETS[facet]) {
          counts[option] = countOf.get(facetKey(facet, option)) ?? 0;
        }
        facetCounts[facet] = counts;
      }
      const [only] = appliedFacets(selection);
      if (served.total && !(turning && only === 'reports')) {
        const count =
          only === undefined
            ? (countOf.get(TOTAL_KEY) ?? 0)
            : (selection[only] ?? []).reduce((n, o) => n + (facetCounts?.[only]?.[o] ?? 0), 0);
        total = { count, capped: false };
      }
    } else if (args.lane === 'changed' && q === '' && appliedFacets(selection).length === 0) {
      total = await changedCount(ctx, scope, now - CHANGED_WITHIN_MS);
    }

    return {
      laneCounts,
      corpus: laneCounts[ALL_LANE] as Count,
      states,
      total,
      facetCounts,
      serves: servesFor(args.lane, q),
    };
  },
});

// ── The preview ──────────────────────────────────────────────────────────────────────────────

/** The most reports the preview counts across all time before it says it stopped. */
const PREVIEW_REPORT_CAP = 1_000;
/** The most open asks the preview lists. */
const PREVIEW_ASK_CAP = 20;
/** The most open twins of one ask the askers count reads; past it, `capped`. */
export const ASKERS_CAP = 50;

/** An intake review reason and the facts stored with it (B01-3c). The page words it. */
export interface PreviewIntake {
  reason: ReviewReason;
  /** Nothing is wrong, the body could be better (`ADVISORY_REVIEW_REASONS`). */
  advisory: boolean;
  /**
   * What is stored beside the reason: a duplicate candidate's count of overlapping bodies, a class
   * or name conflict's corroboration level — `null` when nothing is stored for it.
   */
  detail:
    | { candidates: number }
    | { confidence: NonNullable<Doc<'waterBodies'>['confidence']>['cls'] }
    | null;
}

/** A body's intake review reasons, worst first, each with what is stored for it. */
function intakeOf(body: Doc<'waterBodies'>): PreviewIntake[] {
  const reasons = body.reviewReasons ?? [];
  return REVIEW_REASON_PRIORITY.filter((r) => reasons.includes(r)).map((reason) => ({
    reason,
    advisory: ADVISORY_REVIEW_REASONS.includes(reason),
    detail:
      reason === 'duplicate-candidate' && body.duplicateCandidateIds !== undefined
        ? { candidates: body.duplicateCandidateIds.length }
        : (reason === 'class-conflict' || reason === 'class-dissent') && body.confidence
          ? { confidence: body.confidence.cls }
          : reason === 'name-conflict' && body.confidence
            ? { confidence: body.confidence.name }
            : null,
  }));
}

/** An open ask of a body, as facts — the page words it. */
export type PreviewAsk =
  | {
      id: string;
      kind: 'request';
      requestKind: Doc<'waterBodyRequests'>['kind'];
      name: string | null;
      note: string | null;
      createdAt: number;
      /**
       * How many distinct people have this same question open on the body — this ask and its twins
       * (the same kind and, for a named ask, the same name key), counted to {@link ASKERS_CAP}
       * (`capped` past it). Added in B01-3c; always present in the read, optional in the type so the
       * pages' fixtures written before it still type.
       */
      askers?: { count: number; capped: boolean };
    }
  | { id: string; kind: 'placeName'; name: string; messages: number; createdAt: number }
  | { id: string; kind: 'flag'; reason: Doc<'contentFlags'>['reason']; createdAt: number };

/**
 * **The list's preview, beyond the reads that exist**: reports this season (visible, in the season's
 * record, by how they were made — `null` per vantage never; a report stating none is counted under
 * `unstated`) and since the record began (with the season of the first), the open asks, the towns
 * the body lies in (sampled, `null` when no boundary contains it), and completeness.
 */
export const preview = query({
  args: { waterBodyId: v.id('waterBodies'), now: v.optional(v.number()) },
  handler: async (ctx, { waterBodyId: requested, now: asked }) => {
    await requireCapability(ctx, 'body.read');
    const now = callerNow(asked, Date.now(), CLOCK_SLACK_MS);
    // A merged-away id reads its survivor, as `waterBodies.get` does.
    const body = await resolveSurvivor(ctx, requested);
    if (!body) return null;
    const waterBodyId = body._id;

    const reports = await ctx.db
      .query('reports')
      .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', waterBodyId))
      .order('desc')
      .take(PREVIEW_REPORT_CAP + 1);
    const visible = reports
      .slice(0, PREVIEW_REPORT_CAP)
      .filter((r) => r.moderationStatus === 'visible');
    const capped = reports.length > PREVIEW_REPORT_CAP;
    const span = seasonRecordSpan(currentSeason(now), now);
    const inSeason =
      span === null
        ? []
        : visible.filter((r) => r.skateEndTime >= span.from && r.skateEndTime < span.to);
    const byVantage: Record<(typeof OBSERVED_FROM)[number] | 'unstated', number> = {
      on_ice: 0,
      shore: 0,
      secondhand: 0,
      unstated: 0,
    };
    for (const r of inSeason) byVantage[r.observedFrom ?? 'unstated']++;
    const oldest = visible[visible.length - 1];
    // The read stopped inside the season's record: older reports of this season may lie past it.
    const lastRead = reports[PREVIEW_REPORT_CAP - 1];
    const seasonCapped =
      capped && span !== null && lastRead !== undefined && lastRead.skateEndTime >= span.from;

    const row = await ctx.db
      .query('bodyLibraryRows')
      .withIndex('by_body', (q) => q.eq('waterBodyId', waterBodyId).eq('scope', SCOPE_ALL))
      .first();
    const asks = await previewAsks(ctx, waterBodyId);
    // Every open ask, by the rule the list's row counts them by — beside a list of the newest, so
    // a list shorter than the count says so ("20 of N").
    const openAsks = await openAsksFor(ctx, waterBodyId);
    // The places stored at the write (`lib/bodyGeo.ts`) — no geometry in this read.
    const geo = await geoFactsOf(ctx, body._id);
    const towns = geo === null ? [] : (geo.towns ?? []);
    const withState = townsWithStateOf(geo) ?? [];

    return {
      season: {
        count: inSeason.length,
        /** The read stopped at its cap inside the season's record: `count` is a floor. */
        capped: seasonCapped,
        /** The record is empty from 1 July to 30 September; it opens on this instant. */
        recordOpen: span !== null,
        byVantage,
      },
      allTime: {
        count: visible.length,
        /** The read stopped at its cap: `count` is a floor. */
        capped,
        firstSeason: oldest === undefined || capped ? null : seasonOf(oldest.skateEndTime),
      },
      asks,
      /** All open asks (a floor when `capped`); `asks` is the newest of them. */
      askCount: { count: openAsks.count, capped: openAsks.capped },
      /** `asks` is not every open ask: show it as "N of the count". */
      asksListCapped: openAsks.capped || openAsks.count > asks.length,
      town: towns[0] ?? null,
      moreTowns: towns.slice(1),
      /** `town`'s state; `null` with no town, or on facts computed before towns carried states. */
      townState: withState[0]?.state ?? null,
      /** `moreTowns`, each with its state (B01-3c). */
      moreTownsWithState: withState.slice(1),
      /** The body's intake review reasons, worst first (B01-3c). */
      intake: intakeOf(body),
      /** When the towns were computed (`lib/bodyGeo.ts`); `null` until they are — not "no town". */
      townsComputedAt: geo?.computedAt ?? null,
      complete:
        row === null ? null : { have: row.completeHave, of: row.completeOf, missing: row.missing },
    };
  },
});

/**
 * The newest {@link PREVIEW_ASK_CAP} open asks of a body, newest first. Each source is read newest
 * first through its index — every request kind, every flag status and reason, the place names — so
 * the cap keeps each source's newest, and the merge of those holds the body's newest overall: a
 * cap never drops an ask the newest-first order says belongs on the list.
 */
async function previewAsks(ctx: QueryCtx, waterBodyId: Id<'waterBodies'>): Promise<PreviewAsk[]> {
  // A request carries its name key until its askers are counted, then sheds it.
  const out: (PreviewAsk & { nameKey?: string })[] = [];
  for (const kind of REQUEST_KINDS) {
    const requests = await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_water_body', (q) =>
        q.eq('waterBodyId', waterBodyId).eq('kind', kind).eq('status', 'open'),
      )
      .order('desc')
      .take(PREVIEW_ASK_CAP);
    for (const r of requests) {
      out.push({
        id: r._id,
        kind: 'request',
        requestKind: r.kind,
        name: r.name ?? null,
        note: r.note ?? null,
        createdAt: r.createdAt,
        askers: { count: 1, capped: false },
        ...(r.nameKey !== undefined ? { nameKey: r.nameKey } : {}),
      });
    }
  }
  // The flag index orders by reason before time: each reason is its own newest-first range.
  for (const status of OPEN_FLAG_STATUSES) {
    for (const reason of FLAG_REASONS) {
      const flags = await ctx.db
        .query('contentFlags')
        .withIndex('by_target_status_reason', (q) =>
          q
            .eq('targetType', 'waterbody')
            .eq('targetId', waterBodyId)
            .eq('status', status)
            .eq('reason', reason),
        )
        .order('desc')
        .take(PREVIEW_ASK_CAP);
      for (const f of flags) {
        out.push({ id: f._id, kind: 'flag', reason: f.reason, createdAt: f.createdAt });
      }
    }
  }
  const names = await ctx.db
    .query('corpusPlaceNames')
    .withIndex('by_water_body_status', (q) => q.eq('waterBodyId', waterBodyId).eq('status', 'open'))
    .order('desc')
    .take(PREVIEW_ASK_CAP);
  for (const n of names) {
    out.push({
      id: n._id,
      kind: 'placeName',
      name: n.name,
      messages: n.messages,
      createdAt: n.createdAt,
    });
  }
  const shown = out.sort((a, b) => b.createdAt - a.createdAt).slice(0, PREVIEW_ASK_CAP);
  // The askers of each shown request, one bounded read per distinct question (at most 20).
  const askers = new Map<string, { count: number; capped: boolean }>();
  for (const ask of shown) {
    if (ask.kind !== 'request') continue;
    const key = `${ask.requestKind}\u0001${ask.nameKey ?? ''}`;
    let counted = askers.get(key);
    if (counted === undefined) {
      counted = await askersOf(ctx, waterBodyId, ask.requestKind, ask.nameKey);
      askers.set(key, counted);
    }
    ask.askers = counted;
  }
  return shown.map(({ nameKey: _key, ...ask }) => ask as PreviewAsk);
}

/** The distinct people with one question open on a body, counted to {@link ASKERS_CAP}. */
async function askersOf(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  kind: Doc<'waterBodyRequests'>['kind'],
  nameKey: string | undefined,
): Promise<{ count: number; capped: boolean }> {
  const rows =
    nameKey === undefined
      ? await ctx.db
          .query('waterBodyRequests')
          .withIndex('by_water_body', (q) =>
            q.eq('waterBodyId', waterBodyId).eq('kind', kind).eq('status', 'open'),
          )
          .take(ASKERS_CAP + 1)
      : await ctx.db
          .query('waterBodyRequests')
          .withIndex('by_water_body_name', (q) =>
            q
              .eq('waterBodyId', waterBodyId)
              .eq('kind', kind)
              .eq('status', 'open')
              .eq('nameKey', nameKey),
          )
          .take(ASKERS_CAP + 1);
  const people = new Set(rows.slice(0, ASKERS_CAP).map((r) => r.requesterId));
  return { count: people.size, capped: rows.length > ASKERS_CAP };
}
