/**
 * **The Corpus tasks' reads** (B01-6a): the lanes' counts, a lane's page, and one task's item.
 *
 * PLACEHOLDER (S3's): the T0 stub. The arguments, validators and return types are the briefs'
 * canonical snippets (*The reads*), so the web compiles against `api.corpusTasks.*` now; every read
 * answers empty and `pending: true` until S3 replaces this file (it may move the view types into
 * `lib/corpusTaskViews.ts` and re-export them here).
 */

import {
  type ClaimSource,
  CORPUS_TASK_LANES,
  type CorpusTaskDecision,
  type CorpusTaskLane,
  type WaterBodyClass,
} from '@skating/core';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { query } from './_generated/server';
import { requireCapability } from './lib/auth';
import type { CorpusCan } from './lib/corpusRules';
import { literals } from './lib/validators';

// ── The views (the briefs' snippets; S3's) ───────────────────────────────────────────────────────────

/** `lanes({ now })`: exact counts from the count rows — no cap. */
export type CorpusLanesView = {
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
  token: string | null;
  acres: number | null;
};

type RowBase = {
  taskId: Id<'corpusTasks'>;
  facet: string;
  filedAt: number;
  body: {
    id: Id<'waterBodies'>;
    name: string;
    place: string;
    cls: WaterBodyClass;
    acres: number | null;
  };
  can: CorpusCan;
  decided: CorpusDecidedState | null;
};

export type CorpusRowView = RowBase &
  (
    | { lane: 'nameConflicts'; shown: string; other: string }
    // `claims: null`: not recorded (a body imported before its campaign carried them).
    | { lane: 'classConflicts'; claims: ClassClaimView[] | null }
  );

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
  /** Other listed bodies with the name, "50+" past fifty. */
  namesakes: { count: number; capped: boolean };
};

/** One rung of *What each class would do*. */
export type ClassRungView = {
  cls: WaterBodyClass;
  now: boolean;
  suggested: boolean;
  /** Each catalog's token for this class. */
  byCatalog: Partial<Record<ClaimSource, string>>;
  /** Core's `classConsequence`. */
  consequence: { kind: 'stays' | 'leaves' | 'waitsForParent'; words: string };
};

type ItemBase = RowBase & {
  /** The campaign that last asserted the reason: the body's `lastCampaignId`'s run. */
  raisedBy: { campaignId: string; at: number } | null;
  /** Asked again after a settle, because its evidence changed (D305). */
  raisedAgain: { previous: CorpusDecidedState } | null;
  attached: { reports: number; landmarks: number; asks: number; capped: boolean };
  /** At most 3, from the stored geometry facts. */
  neighbors: { id: Id<'waterBodies'>; name: string }[];
};

export type CorpusTaskItemView = ItemBase &
  (
    | {
        lane: 'nameConflicts';
        names: NameChoiceView[];
        split: 'different' | 'oneLetter' | 'qualifier';
      }
    | {
        lane: 'classConflicts';
        ladder: ClassRungView[];
        claims: ClassClaimView[] | null;
        depth: { meters: number; source: string } | null;
      }
  );

/** `item({ ref, lane?, now })`: `item: null` is *No such task*. */
export type CorpusTaskItemRead = { item: CorpusTaskItemView | null; pending: boolean };

// ── The reads ────────────────────────────────────────────────────────────────────────────────────────

const nowArg = { now: v.optional(v.number()) };

/** Every task lane's open count and each facet's. PLACEHOLDER (S3's): zeros, `pending: true`. */
export const lanes = query({
  args: { ...nowArg },
  handler: async (ctx): Promise<CorpusLanesView> => {
    await requireCapability(ctx, 'corpus.read');
    const empty = Object.fromEntries(
      CORPUS_TASK_LANES.map((lane) => [lane, { open: 0, facets: {} }]),
    ) as CorpusLanesView['lanes'];
    return { lanes: empty, pending: true };
  },
});

/** A lane's page: a facet's or *All*'s open tasks, or its decided tab, newest first. PLACEHOLDER (S3's): empty, `pending: true`. */
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
  handler: async (ctx): Promise<CorpusListPage> => {
    await requireCapability(ctx, 'corpus.read');
    return { rows: [], isDone: true, continueCursor: '', scanBudgetSpent: false, pending: true };
  },
});

/** One task: `ref` a task id, or `body:<id>` with `lane`. PLACEHOLDER (S3's): `item: null`, `pending: true`. */
export const item = query({
  args: { ref: v.string(), lane: v.optional(literals(CORPUS_TASK_LANES)), ...nowArg },
  handler: async (ctx): Promise<CorpusTaskItemRead> => {
    await requireCapability(ctx, 'corpus.read');
    return { item: null, pending: true };
  },
});
