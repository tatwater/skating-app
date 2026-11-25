/**
 * **The Corpus tasks' views** (B01-6a): the shapes `convex/corpusTasks.ts` answers in, and the
 * row and item builders that resolve a stored task (`corpusTasks`, written only by
 * `lib/corpusTasks.ts`) into what its lane's list and inspector draw. Every label is resolved at
 * read from the body as stored; **every fact not stored reads `null`, never a guess** — class claims
 * a campaign hasn't recorded, a body's neighbors before its geometry facts are computed, the run of
 * a campaign with no run row. A `class-dissent` reason and a body's `classRefusals` are read by
 * nothing here: 6a files no task for them (D306).
 *
 * **Bounds.** Every read here is one indexed read with a count cap, or a point read; none ranges
 * over an optional field without `eq`. A list row reads its task's body, its geometry facts and its
 * decider; an item adds the facts its inspector draws, each capped below (`ATTACHED_CAP`,
 * `NAMESAKES_CAP`, `RAISED_AGAIN_READ`) or bounded by its helper (`openAsksFor`, the library's own
 * rule). Bodies are the heavy rows: the last merge's queued name and class conflicts weighed 82 KB
 * at the most and 2 MB all together, so a page at {@link MAX_PAGE} reads well inside a
 * transaction's 16 MiB.
 */

import {
  type ClaimSource,
  type ConsequenceBody,
  type CorpusTaskDecision,
  type CorpusTaskLane,
  classConsequence,
  classConsequenceLine,
  NAME_SOURCE_RANK,
  type NameClaim,
  type NameSplit,
  nameRankWords,
  nameSortKey,
  nameSplit,
  neighborOffset,
  otherNameOf,
  ringInsidePoint,
  SCOPE_ALL,
  SQM_PER_ACRE,
  type WaterBodyClass,
} from '@skating/core';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { geoFactsOf, placesOf, townsWithStateOf } from './bodyGeo';
import { openAsksFor } from './bodyLibrary';
import { campaignRunOf } from './campaignRuns';
import { type CorpusCan, corpusCan } from './corpusRules';

// ── The views (the briefs' snippets) ──────────────────────────────────────────────────────────────

/** `lanes({ now })`: exact counts from the count rows — no cap. */
export type CorpusLanesView = {
  /**
   * Each lane's open tasks, and each of its tabs' (`CORPUS_TASK_FACETS[lane]` but `notRecorded`, which
   * reads under *All* only and so has no count of its own).
   */
  lanes: Record<CorpusTaskLane, { open: number; facets: Record<string, number> }>;
  /** The backfill hasn't finished: the counts aren't the corpus's yet. */
  pending: boolean;
};

/** `listPage`: the People and Inbox `endCursor` chain. */
export type CorpusListPage = {
  rows: CorpusRowView[];
  isDone: boolean;
  continueCursor: string;
  splitCursor?: string;
  pageStatus?: string;
  /**
   * A search (`q`) is one bounded read, not a chain: `true` when it stopped at its bound with more
   * that might match — a narrower search finds them (`isDone` is still `true`: there is no next page).
   */
  scanBudgetSpent: boolean;
  pending: boolean;
};

/** Who decided a task, when and what (the lock's facts). */
export type CorpusDecidedState = {
  at: number;
  by: { userId: Id<'profiles'>; displayName: string } | null;
  decision: CorpusTaskDecision;
  actionId: Id<'moderationActions'>;
  byMe: boolean;
};

/** A catalog's class claim, as a row or item draws it. */
export type ClassClaimView = {
  source: ClaimSource;
  cls: WaterBodyClass;
  /** The catalog's own class token (`nhd:fcode=46600`); `null` before the campaign that records it. */
  token: string | null;
  /** That catalog's feature's area, in acres; `null` as `token` is. */
  acres: number | null;
};

type RowBase = {
  taskId: Id<'corpusTasks'>;
  facet: string;
  filedAt: number;
  body: {
    id: Id<'waterBodies'>;
    /** As stored: `''` for an unnamed body (the page says "Unnamed water"). */
    name: string;
    /**
     * The lead town and its state ("Auburn, ME") once the geometry facts are computed by today's
     * rule; else the body's states ("NH, VT"); `''` with neither on file.
     */
    place: string;
    cls: WaterBodyClass;
    acres: number | null;
  };
  can: CorpusCan;
  decided: CorpusDecidedState | null;
};

export type CorpusRowView = RowBase &
  (
    | {
        lane: 'nameConflicts';
        shown: string;
        /**
         * The best-ranked catalog name that reads differently from the shown one (core's
         * `otherNameOf`, the writer's rule); `''` when no catalog claim differs.
         */
        other: string;
      }
    | {
        lane: 'classConflicts';
        // `claims: null`: not recorded (a body imported before its campaign carried them).
        claims: ClassClaimView[] | null;
        /**
         * Board 4.3's third line: what choosing one of the catalogs' other classes would do, by core's
         * `classConsequenceLine` — the ladder's own rule (`classConsequence`) over the claimed
         * classes. `null` when every claimed class keeps the body, and when no claims are recorded.
         * (Optional only so a row written before it still types; the read always sends it.)
         */
        consequence?: ClassConsequenceLineView | null;
      }
  );

/** A class conflict row's consequence line (core's `ClassConsequenceLine`). */
export type ClassConsequenceLineView = {
  kind: 'leaves' | 'waitsForParent';
  cls: WaterBodyClass;
  words: string;
};

/** One name the body could display, with its catalogs, rank and namesakes. */
export type NameChoiceView = {
  value: string;
  /** Every catalog publishing the spelling, rank order; the top one alone when not recorded. */
  sources: ClaimSource[];
  /**
   * `sources` was recorded by a campaign (the claim's `sources` field). `false`: a claim stored before
   * it, or a moderator's — the run shows the one catalog, and nothing says the catalogs agree.
   */
  sourcesRecorded: boolean;
  /** "First: the authority on US names" (core's `nameRankWords`). */
  rankWords: string;
  shown: boolean;
  /** `false` on every name until 6c's email counts name a suggestion (D307). */
  suggested: boolean;
  /** Other bodies in the library with the name, "50+" past fifty. */
  namesakes: { count: number; capped: boolean };
};

/** One rung of *What each class would do*. */
export type ClassRungView = {
  cls: WaterBodyClass;
  now: boolean;
  /** `false` on every rung in 6a: nothing stored names a suggestion. */
  suggested: boolean;
  /**
   * Each catalog's token for this class, where its claim recorded one. A claim stored before the
   * campaign that records tokens has no entry here: `claims` holds it, with `token: null`.
   */
  byCatalog: Partial<Record<ClaimSource, string>>;
  /**
   * Core's `classConsequence`. `lead` is the start of `words` that says the kind ("Refused by the
   * size rules"), its own field so the inspector can brighten it alone (optional only so a fixture
   * written before it still types; the read always sends it).
   */
  consequence: { kind: 'stays' | 'leaves' | 'waitsForParent'; words: string; lead?: string };
};

type ItemBase = RowBase & {
  /** The campaign that last asserted the reason: the body's `lastCampaignId`'s run; `null` with no run on file. */
  raisedBy: { campaignId: string; at: number } | null;
  /** Asked again after a settle, because its evidence changed (D305). */
  raisedAgain: { previous: CorpusDecidedState } | null;
  /** Each counted to {@link ATTACHED_CAP} (asks to the library's own cap); `capped`: one is a floor. */
  attached: { reports: number; landmarks: number; asks: number; capped: boolean };
  /**
   * At most 3 touching bodies, from the stored geometry facts. `null`: the facts aren't computed
   * yet — never "none". (The snippet's `[]`, made nullable so not computed can't read as no
   * neighbors.)
   */
  neighbors: NeighborView[] | null;
};

/** A touching body the geometry facts name. */
export type NeighborView = {
  id: Id<'waterBodies'>;
  name: string;
  /**
   * How far it lies and which way, **point to point** (core's `neighborOffset`): from the body's
   * stored `interiorPoint` to a point inside the neighbor's stored ring (core's `ringInsidePoint`,
   * the rule that computes `interiorPoint`), meters and degrees clockwise from north. Never from
   * `centroid`, which may sit on the shore. `null` when either point isn't on file: a body imported
   * before its `interiorPoint`, a ring with no inside. (Optional only so a fixture written before
   * it still types; the read always sends it.)
   */
  offset?: { meters: number; bearingDeg: number } | null;
};

export type CorpusTaskItemView = ItemBase &
  (
    | {
        lane: 'nameConflicts';
        names: NameChoiceView[];
        split: NameSplit;
      }
    | {
        lane: 'classConflicts';
        ladder: ClassRungView[];
        claims: ClassClaimView[] | null;
        /**
         * The body's deepest measure on file: its maximum, else its mean (`measure` says which; always
         * sent, optional only so fixtures written before it still type). `null`: no depth on file.
         */
        depth: { meters: number; source: string; measure?: 'max' | 'mean' } | null;
      }
  );

/** `item({ ref, lane?, now })`: `item: null` is *No such task*. */
export type CorpusTaskItemRead = { item: CorpusTaskItemView | null; pending: boolean };

// ── Bounds ─────────────────────────────────────────────────────────────────────────────────────

/** The most rows a list page asks for. */
export const MAX_PAGE = 100;
/** Reports and landmarks an item counts at most; past it, `capped`. */
export const ATTACHED_CAP = 50;
/** Other bodies with a name an item counts at most; past it, "50+". */
export const NAMESAKES_CAP = 50;
/** Touching bodies an item names at most. */
export const NEIGHBORS_SHOWN = 3;
/** Earlier decided tasks of the same question an item reads, for *raised again*. */
export const RAISED_AGAIN_READ = 5;
/** Tasks of one body read to resolve a `body:` ref or a search hit. */
export const TASKS_PER_BODY = 10;

// ── Shared reads ────────────────────────────────────────────────────────────────────────────────

/**
 * One request's reads of what several rows share: each profile and body once. A list's deciders
 * repeat, and an item's task and its earlier decision may share a decider.
 */
export class CorpusReader {
  private readonly profiles = new Map<string, Promise<Doc<'profiles'> | null>>();
  constructor(
    readonly ctx: QueryCtx,
    readonly viewer: Doc<'profiles'>,
  ) {}

  profile(id: Id<'profiles'> | undefined): Promise<Doc<'profiles'> | null> {
    if (id === undefined) return Promise.resolve(null);
    let read = this.profiles.get(id);
    if (read === undefined) {
      read = this.ctx.db.get(id);
      this.profiles.set(id, read);
    }
    return read;
  }
}

// ── Facts ──────────────────────────────────────────────────────────────────────────────────────

/** Square meters as acres, or `null` when none are on file. */
export function acresOf(sqM: number | undefined): number | null {
  return sqM === undefined || !Number.isFinite(sqM) ? null : sqM / SQM_PER_ACRE;
}

/**
 * Where the body is, as a row says it: the lead town with its state, from the places the geometry
 * facts computed by today's rule (`placesOf`); else the body's states; `''` with neither.
 */
export function placeOf(body: Doc<'waterBodies'>, geo: Doc<'bodyGeoFacts'> | null): string {
  const town = townsWithStateOf(placesOf(geo))?.[0];
  if (town) return town.state ? `${town.name}, ${town.state}` : town.name;
  return (body.states ?? []).join(', ');
}

/** The body's class claims as stored, or `null` when no campaign recorded them. */
export function classClaimsOf(body: Doc<'waterBodies'>): ClassClaimView[] | null {
  if (body.classClaims === undefined) return null;
  return body.classClaims.map((c) => ({
    source: c.source,
    cls: c.value,
    token: c.token ?? null,
    acres: acresOf(c.areaSqM),
  }));
}

/** A decided task's lock facts; `null` for a task no person decided (open or left). */
export async function decidedOf(
  r: CorpusReader,
  task: Doc<'corpusTasks'>,
): Promise<CorpusDecidedState | null> {
  if (
    task.status !== 'decided' ||
    task.decision === undefined ||
    task.decisionActionId === undefined
  ) {
    return null;
  }
  const by = await r.profile(task.decidedByUserId);
  return {
    at: task.decidedAt ?? task.refreshedAt,
    by: by ? { userId: by._id, displayName: by.displayName } : null,
    decision: task.decision,
    actionId: task.decisionActionId,
    byMe: task.decidedByUserId === r.viewer._id,
  };
}

/** What a row and an item share: the task, the body's labels, `can` and the decision. */
async function rowBaseOf(
  r: CorpusReader,
  task: Doc<'corpusTasks'>,
  body: Doc<'waterBodies'>,
  geo: Doc<'bodyGeoFacts'> | null,
): Promise<RowBase> {
  return {
    taskId: task._id,
    facet: task.facet,
    filedAt: task.filedAt,
    body: {
      id: body._id,
      name: body.name,
      place: placeOf(body, geo),
      cls: body.type,
      acres: acresOf(body.surfaceAreaSqM),
    },
    can: await corpusCan(r.ctx, r.viewer, task, body),
    decided: await decidedOf(r, task),
  };
}

/**
 * A list row: the task's labels, resolved at read. `null` for a task whose body is gone (a hard
 * delete the task outlived, decided before it): there is nothing to draw or open.
 */
export async function rowOf(
  r: CorpusReader,
  task: Doc<'corpusTasks'>,
): Promise<CorpusRowView | null> {
  const body = await r.ctx.db.get(task.waterBodyId);
  if (body === null) return null;
  const geo = await geoFactsOf(r.ctx, body._id);
  const base = await rowBaseOf(r, task, body, geo);
  switch (task.lane) {
    case 'nameConflicts':
      return {
        ...base,
        lane: 'nameConflicts',
        shown: body.name,
        other: otherNameOf(body) ?? '',
      };
    case 'classConflicts':
      return {
        ...base,
        lane: 'classConflicts',
        claims: classClaimsOf(body),
        consequence: consequenceLineOf(body),
      };
  }
}

/**
 * A class conflict row's consequence line: core's `classConsequenceLine` over the claimed classes,
 * with the body as the ladder reads it (`consequenceBodyOf`); `null` with no claims recorded.
 */
export function consequenceLineOf(body: Doc<'waterBodies'>): ClassConsequenceLineView | null {
  if (body.classClaims === undefined) return null;
  return classConsequenceLine(
    consequenceBodyOf(body),
    body.type,
    body.classClaims.map((c) => c.value),
  );
}

/** The body facts a class's consequence is read from — one place, for the ladder and the row. */
function consequenceBodyOf(body: Doc<'waterBodies'>): ConsequenceBody {
  return {
    name: body.name,
    // The area the admission rules read, as the floor's prune reads it.
    surfaceAreaSqM: body.sourceAreaSqM ?? body.surfaceAreaSqM ?? null,
    includedByRequest: body.includedByRequest,
  };
}

// ── Items ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The task a ref names: a task id, or `body:<id>` — the body's open task in `lane` (any 6a lane in
 * lane order when absent), else its most recently decided one there, so the audit feed's links and
 * a decided question still open on their lock. `null` for no such task, and for a task that **left**
 * (its question went away with no decision: no list shows it, and nothing on it can be decided).
 */
export async function taskOfRef(
  ctx: QueryCtx,
  ref: string,
  lane: CorpusTaskLane | undefined,
): Promise<Doc<'corpusTasks'> | null> {
  const taskId = ctx.db.normalizeId('corpusTasks', ref);
  if (taskId !== null) {
    const task = await ctx.db.get(taskId);
    return task === null || task.status === 'left' ? null : task;
  }
  if (!ref.startsWith('body:')) return null;
  const bodyId = ctx.db.normalizeId('waterBodies', ref.slice('body:'.length));
  if (bodyId === null) return null;
  const inLane = (t: Doc<'corpusTasks'>) => lane === undefined || t.lane === lane;
  const open = (
    await ctx.db
      .query('corpusTasks')
      .withIndex('by_body_status', (q) => q.eq('waterBodyId', bodyId).eq('status', 'open'))
      .take(TASKS_PER_BODY)
  ).filter(inLane);
  if (open.length > 0) {
    const order = (t: Doc<'corpusTasks'>) => (t.lane === 'nameConflicts' ? 0 : 1);
    return [...open].sort((a, b) => order(a) - order(b))[0] ?? null;
  }
  const decided = (
    await ctx.db
      .query('corpusTasks')
      .withIndex('by_body_status', (q) => q.eq('waterBodyId', bodyId).eq('status', 'decided'))
      .order('desc')
      .take(TASKS_PER_BODY)
  ).filter(inLane);
  return [...decided].sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))[0] ?? null;
}

/**
 * The merge-or-load run of the campaign that last re-affirmed the body (and so asserted its
 * reasons) — never a by-hand pass that carries the campaign's id after it, so the day is the
 * campaign's, as the Overview's *last campaign* is.
 */
async function raisedByOf(
  ctx: QueryCtx,
  body: Doc<'waterBodies'>,
): Promise<{ campaignId: string; at: number } | null> {
  const campaignId = body.lastCampaignId;
  if (campaignId === undefined) return null;
  const run = await campaignRunOf(ctx, campaignId);
  return run === null ? null : { campaignId, at: run.startedAt };
}

/**
 * The decision this question was settled by before a campaign asked it again (D305): the newest
 * other task of the same key a person decided before this one was filed. The settle keeps its task
 * decided, and the campaign files a new one, so the two are rows of one key.
 */
async function raisedAgainOf(
  r: CorpusReader,
  task: Doc<'corpusTasks'>,
): Promise<{ previous: CorpusDecidedState } | null> {
  const earlier = await r.ctx.db
    .query('corpusTasks')
    .withIndex('by_key', (q) => q.eq('key', task.key).eq('status', 'decided'))
    .order('desc')
    .take(RAISED_AGAIN_READ);
  const previous = earlier
    .filter((t) => t._id !== task._id && (t.decidedAt ?? Number.POSITIVE_INFINITY) <= task.filedAt)
    .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))[0];
  if (previous === undefined) return null;
  const state = await decidedOf(r, previous);
  return state === null ? null : { previous: state };
}

/** What is attached to the body: reports and live landmarks counted to the cap, and its open asks. */
async function attachedOf(ctx: QueryCtx, waterBodyId: Id<'waterBodies'>) {
  const reports = await ctx.db
    .query('reports')
    .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', waterBodyId))
    .take(ATTACHED_CAP + 1);
  const landmarks = await ctx.db
    .query('bodyLandmarks')
    .withIndex('by_water_body_removed', (q) =>
      q.eq('waterBodyId', waterBodyId).eq('removedAt', undefined),
    )
    .take(ATTACHED_CAP + 1);
  // The library's own rule for a body's open asks, so the item and the library row agree.
  const asks = await openAsksFor(ctx, waterBodyId);
  return {
    reports: Math.min(reports.length, ATTACHED_CAP),
    landmarks: Math.min(landmarks.length, ATTACHED_CAP),
    asks: asks.count,
    capped: reports.length > ATTACHED_CAP || landmarks.length > ATTACHED_CAP || asks.capped,
  };
}

/**
 * The touching bodies the geometry facts stored, at most {@link NEIGHBORS_SHOWN}, in their stored
 * order; `null` before they're computed. Each with its offset from the body (`NeighborView`), from
 * facts already in hand — the body's `interiorPoint` and the neighbor's stored ring — so no read is
 * added.
 */
export function neighborsOf(
  geo: Doc<'bodyGeoFacts'> | null,
  body: Pick<Doc<'waterBodies'>, 'interiorPoint'>,
): NeighborView[] | null {
  if (geo === null || geo.neighbors === undefined) return null;
  const from = body.interiorPoint ?? null;
  return geo.neighbors.slice(0, NEIGHBORS_SHOWN).map((n) => {
    const to = from === null ? null : ringInsidePoint(n.ring);
    return {
      id: n.waterBodyId,
      name: n.name,
      offset: from === null || to === null ? null : neighborOffset(from, to),
    };
  });
}

/** Other bodies in the library with the name (its `*` rows by name key), counted to the cap. */
async function namesakesOf(
  ctx: QueryCtx,
  body: Doc<'waterBodies'>,
  value: string,
): Promise<{ count: number; capped: boolean }> {
  const nameKey = nameSortKey(value);
  if (nameKey === '') return { count: 0, capped: false };
  // One past the cap, and one more for the body's own row.
  const rows = await ctx.db
    .query('bodyLibraryRows')
    .withIndex('by_scope_name', (q) => q.eq('scope', SCOPE_ALL).eq('nameKey', nameKey))
    .take(NAMESAKES_CAP + 2);
  const others = rows.filter((row) => row.waterBodyId !== body._id).length;
  return { count: Math.min(others, NAMESAKES_CAP), capped: others > NAMESAKES_CAP };
}

/**
 * The names the body could display: each distinct spelling once (case and spacing aside), the shown
 * one first, then by the rank of its catalog. A spelling a catalog and a moderator both claim is the
 * catalog's claim (its catalogs are the evidence); one only a moderator claims is the moderator's.
 */
async function namesOf(ctx: QueryCtx, body: Doc<'waterBodies'>): Promise<NameChoiceView[]> {
  const key = (s: string) => s.trim().toLowerCase();
  const byKey = new Map<string, NameClaim>();
  for (const claim of (body.nameClaims ?? []) as NameClaim[]) {
    const k = key(claim.value);
    if (k === '') continue;
    const held = byKey.get(k);
    if (held === undefined || (held.source === 'user' && claim.source !== 'user')) {
      byKey.set(k, claim);
    }
  }
  const shownKey = key(body.name);
  const claims = [...byKey.values()].sort(
    (a, b) =>
      Number(key(b.value) === shownKey) - Number(key(a.value) === shownKey) ||
      NAME_SOURCE_RANK[a.source] - NAME_SOURCE_RANK[b.source],
  );
  const names: NameChoiceView[] = [];
  for (const claim of claims) {
    const recorded = claim.source !== 'user' && (claim.sources?.length ?? 0) > 0;
    names.push({
      value: claim.value.trim(),
      sources: recorded ? [...(claim.sources as ClaimSource[])] : [claim.source],
      sourcesRecorded: recorded,
      rankWords: nameRankWords(claim.source),
      shown: key(claim.value) === shownKey,
      suggested: false,
      namesakes: await namesakesOf(ctx, body, claim.value),
    });
  }
  return names;
}

/** The ladder's classes, in the board's order; `unclassified` only where it is the body's or a claim's. */
const LADDER: readonly WaterBodyClass[] = ['lakePond', 'wetland', 'reservoir', 'river', 'bay'];

/** *What each class would do*: a rung per class, its catalogs' tokens and core's consequence. */
export function ladderOf(body: Doc<'waterBodies'>): ClassRungView[] {
  const claims = body.classClaims ?? [];
  const classes: WaterBodyClass[] = [...LADDER];
  if (body.type === 'unclassified' || claims.some((c) => c.value === 'unclassified')) {
    classes.push('unclassified');
  }
  const consequenceBody = consequenceBodyOf(body);
  return classes.map((cls) => {
    const byCatalog: Partial<Record<ClaimSource, string>> = {};
    for (const c of claims) {
      if (c.value === cls && c.token !== undefined) byCatalog[c.source] = c.token;
    }
    return {
      cls,
      now: body.type === cls,
      suggested: false,
      byCatalog,
      consequence: classConsequence(consequenceBody, cls),
    };
  });
}

/** The body's deepest measure on file, with its source. */
function depthOf(
  body: Doc<'waterBodies'>,
): { meters: number; source: string; measure: 'max' | 'mean' } | null {
  if (body.maxDepthM !== undefined && body.maxDepthSource !== undefined) {
    return { meters: body.maxDepthM, source: body.maxDepthSource, measure: 'max' };
  }
  if (body.meanDepthM !== undefined && body.meanDepthSource !== undefined) {
    return { meters: body.meanDepthM, source: body.meanDepthSource, measure: 'mean' };
  }
  return null;
}

/** How the item's two names differ: the tab the task was filed under, else core's rule over them. */
function splitOf(task: Doc<'corpusTasks'>, body: Doc<'waterBodies'>): NameSplit {
  if (task.facet === 'different' || task.facet === 'oneLetter' || task.facet === 'qualifier') {
    return task.facet;
  }
  return nameSplit(body.name, otherNameOf(body) ?? '');
}

/** An item as its inspector draws it; `null` for a task whose body is gone. */
export async function itemOf(
  r: CorpusReader,
  task: Doc<'corpusTasks'>,
): Promise<CorpusTaskItemView | null> {
  const body = await r.ctx.db.get(task.waterBodyId);
  if (body === null) return null;
  const geo = await geoFactsOf(r.ctx, body._id);
  const base = {
    ...(await rowBaseOf(r, task, body, geo)),
    raisedBy: await raisedByOf(r.ctx, body),
    raisedAgain: await raisedAgainOf(r, task),
    attached: await attachedOf(r.ctx, body._id),
    neighbors: neighborsOf(geo, body),
  };
  switch (task.lane) {
    case 'nameConflicts':
      return {
        ...base,
        lane: 'nameConflicts',
        names: await namesOf(r.ctx, body),
        split: splitOf(task, body),
      };
    case 'classConflicts':
      return {
        ...base,
        lane: 'classConflicts',
        ladder: ladderOf(body),
        claims: classClaimsOf(body),
        depth: depthOf(body),
      };
  }
}
