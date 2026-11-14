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
  SCOPE_ALL,
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
import { townsForBody } from './adminAreas';
import { requireCapability } from './lib/auth';
import { type LibraryRow, readCount } from './lib/bodyLibrary';
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

/** The shortest search the search index is asked. */
export const SEARCH_MIN_CHARS = 2;
/** The longest search read; the rest is dropped. */
const SEARCH_MAX_CHARS = 100;

const searchOf = (q: string | undefined) => {
  const t = (q ?? '').trim().slice(0, SEARCH_MAX_CHARS);
  return t.length >= SEARCH_MIN_CHARS ? t : '';
};

const scopeOf = (state: string | undefined) => {
  const code = (state ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : SCOPE_ALL;
};

/** The selection with unknown options dropped, so a hand-edited link narrows nothing it can't. */
function cleanFacets(facets: LibraryFacetSelection | undefined): LibraryFacetSelection {
  const out: LibraryFacetSelection = {};
  for (const facet of LIBRARY_FACET_IDS) {
    const known = (facets?.[facet] ?? []).filter((o) =>
      (LIBRARY_FACETS[facet] as readonly string[]).includes(o),
    );
    if (known.length > 0) out[facet] = known;
  }
  return out;
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
    const now = callerNow(args.now, Date.now(), CLOCK_SLACK_MS);
    const season = currentSeason(now);
    const q = searchOf(args.q);
    const scope = scopeOf(args.state);
    const selection = cleanFacets(args.facets);
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
    const now = callerNow(args.now, Date.now(), CLOCK_SLACK_MS);
    const q = searchOf(args.q);
    const scope = scopeOf(args.state);
    const selection = cleanFacets(args.facets);
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
      facetCounts = {};
      for (const facet of served.facets) {
        const counts: Record<string, number> = {};
        for (const option of LIBRARY_FACETS[facet]) {
          counts[option] = countOf.get(facetKey(facet, option)) ?? 0;
        }
        facetCounts[facet] = counts;
      }
      if (served.total) {
        const [only] = appliedFacets(selection);
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

/** An open ask of a body, as facts — the page words it. */
export type PreviewAsk =
  | {
      id: string;
      kind: 'request';
      requestKind: Doc<'waterBodyRequests'>['kind'];
      name: string | null;
      note: string | null;
      createdAt: number;
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
  handler: async (ctx, { waterBodyId, now: asked }) => {
    await requireCapability(ctx, 'body.read');
    const now = callerNow(asked, Date.now(), CLOCK_SLACK_MS);
    const body = await ctx.db.get(waterBodyId);
    if (!body) return null;

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
    const towns = await townsForBody(ctx, body);

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
      town: towns === null ? null : (towns.towns[0] ?? null),
      moreTowns: towns === null ? [] : towns.towns.slice(1),
      complete:
        row === null ? null : { have: row.completeHave, of: row.completeOf, missing: row.missing },
    };
  },
});

async function previewAsks(ctx: QueryCtx, waterBodyId: Id<'waterBodies'>): Promise<PreviewAsk[]> {
  const out: PreviewAsk[] = [];
  const requests: Doc<'waterBodyRequests'>[] = [];
  for (const kind of REQUEST_KINDS) {
    requests.push(
      ...(await ctx.db
        .query('waterBodyRequests')
        .withIndex('by_water_body', (q) =>
          q.eq('waterBodyId', waterBodyId).eq('kind', kind).eq('status', 'open'),
        )
        .take(PREVIEW_ASK_CAP)),
    );
  }
  for (const r of requests) {
    out.push({
      id: r._id,
      kind: 'request',
      requestKind: r.kind,
      name: r.name ?? null,
      note: r.note ?? null,
      createdAt: r.createdAt,
    });
  }
  for (const status of ['open', 'reviewing'] as const) {
    const flags = await ctx.db
      .query('contentFlags')
      .withIndex('by_target_status_reason', (q) =>
        q.eq('targetType', 'waterbody').eq('targetId', waterBodyId).eq('status', status),
      )
      .take(PREVIEW_ASK_CAP);
    for (const f of flags)
      out.push({ id: f._id, kind: 'flag', reason: f.reason, createdAt: f.createdAt });
  }
  const names = await ctx.db
    .query('corpusPlaceNames')
    .withIndex('by_water_body_status', (q) => q.eq('waterBodyId', waterBodyId).eq('status', 'open'))
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
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, PREVIEW_ASK_CAP);
}
