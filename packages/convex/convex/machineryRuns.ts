/**
 * **Machinery › Corpus's reads** (D341, B01-8a): the sidebar's tail, the run list, the campaign
 * page, one run, and a run's log lines.
 *
 * Each gated `machinery.read` (admin; a moderator's read throws, and the rail never draws the mode
 * for them), each taking the caller's `now` through `callerNow` (minute-rounded, clamped), as
 * `machinery.overviewJobs` does: a run falling late is a change in the clock, not in any row. Every
 * verdict is core's `runLiveness` / `campaignLiveness`, so the page, the Overview's card and Inbox
 * Zero's line can't disagree. Every read is one `.paginate()` or a bounded `.take()`; `listedIn` and
 * `parentRunId` are optional, so their indexes are read with `eq` on a defined value only.
 *
 * PLACEHOLDER (B01-8a T0): the contracts are the seam (the web derives its types from `api`, so the
 * stubs return these shapes); every body is S2's, and each returns the empty answer until then.
 */

import type { RunLiveness } from '@skating/core';
import { type PaginationResult, paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { query } from './_generated/server';
import { requireCapability } from './lib/auth';

type RunState = Doc<'importRuns'>['status'];
/** Core's union, verbatim. */
export type LivenessView = RunLiveness;
export type PersonView = { id: Id<'profiles'>; name: string; avatarUrl: string | null };
export type ScopeView = { pass: string; states: string[] | null; complete: boolean } | null;

/** A row of the run list: a campaign, or a pass listed on its own. */
export type RunRowView = {
  id: Id<'importRuns'>;
  kind: 'campaign' | 'pass';
  /** The campaign id, or the pass's name. */
  title: string;
  campaignId: string | null;
  status: RunState;
  liveness: LivenessView;
  dryRun: boolean;
  marked: boolean;
  scope: ScopeView;
  startedAt: number;
  finishedAt: number | null;
  /** The sub-line's facts; the words are the web's. */
  line:
    | {
        kind: 'campaign';
        passesDone: number;
        passesPlanned: number | null;
        current: string | null;
        stoppedAt: string | null;
        bodiesLoaded: number | null;
        recorded: boolean;
      }
    | { kind: 'pass'; headline: { name: string; value: number } | null };
};

/** The sidebar's tail for one lane. */
export type LaneTail = {
  state: LivenessView['state'] | 'failed' | 'ok' | 'never';
  at: number | null;
};

/** A row of the campaign page's *Passes* table: a planned pass merged with its run. */
export type PassRowView = {
  /** `corpusRunPlan`'s name. */
  pass: string;
  /** The board's *What it does*. */
  does: string;
  by: 'script' | 'hand';
  state:
    | 'done'
    | 'running'
    | 'late'
    | 'stalled'
    | 'waiting'
    | 'failed'
    | 'skipped'
    | 'notRun'
    | 'required'
    | 'dryRun';
  skipped: string | null;
  run: {
    id: Id<'importRuns'>;
    startedAt: number;
    finishedAt: number | null;
    inUp: { in: number; up: number } | null;
    failed: number;
  } | null;
};

/** A run marked failed in the console, and the loader's own close if one came after. */
export type MarkedView = {
  by: PersonView;
  at: number;
  reason: string;
  loaderFinish: Doc<'importRuns'>['loaderFinish'] | null;
};

/** A stalled run held by *Wait 30 minutes*. */
export type WaitingView = { by: PersonView; at: number; until: number };

export type CampaignView = {
  row: RunRowView;
  /** false: assembled from its runs (no campaign row was kept). */
  recorded: boolean;
  flags: string[] | null;
  passes: PassRowView[];
  liveness: LivenessView;
  current: {
    runId: Id<'importRuns'>;
    pass: string;
    counts: { name: string; value: number }[];
    progressAt: number | null;
    batches: { applied: number; total: number | null } | null;
    failures: { stored: number; total: number; keys: string[] };
  } | null;
  /** The merge's. */
  path: Doc<'importRuns'>['stages'];
  marked: MarkedView | null;
  waiting: WaitingView | null;
  /** The newest line's `loggedAt − at`, when over a minute. */
  clockSkewMs: number | null;
};

export type RunView = {
  doc: Doc<'importRuns'>;
  liveness: LivenessView;
  parent: { id: Id<'importRuns'>; title: string } | null;
  marked: MarkedView | null;
  waiting: WaitingView | null;
};

export type RunEventView = {
  seq: number;
  loggedAt: number;
  kind: string;
  text: string;
  dropped: number | null;
};

/** The sidebar's tail: one entry per built page; B01-8a's only key is `corpus`. */
export const lanes = query({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, _args): Promise<{ corpus: LaneTail }> => {
    await requireCapability(ctx, 'machinery.read');
    // PLACEHOLDER (B01-8a T0): S2 writes it.
    return { corpus: { state: 'never', at: null } };
  },
});

/** A page of a lane's runs, newest first, 25 a page; `indexed` false until the backfill has run. */
export const listPage = query({
  args: {
    // Widened to a union as each pipeline's page lands.
    lane: v.literal('corpus'),
    paginationOpts: paginationOptsValidator,
    now: v.optional(v.number()),
  },
  handler: async (ctx, _args): Promise<PaginationResult<RunRowView> & { indexed: boolean }> => {
    await requireCapability(ctx, 'machinery.read');
    // PLACEHOLDER (B01-8a T0): S2 writes it.
    return { page: [], isDone: true, continueCursor: '', indexed: false };
  },
});

/** The campaign page, by its row or (for a campaign with no row) by its campaign id. */
export const campaign = query({
  args: {
    runId: v.optional(v.id('importRuns')),
    campaignId: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, _args): Promise<CampaignView | null> => {
    await requireCapability(ctx, 'machinery.read');
    // PLACEHOLDER (B01-8a T0): S2 writes it.
    return null;
  },
});

/** One run, whole, with its liveness, its parent, and the mark and wait. */
export const run = query({
  args: { runId: v.id('importRuns'), now: v.optional(v.number()) },
  handler: async (ctx, _args): Promise<RunView | null> => {
    await requireCapability(ctx, 'machinery.read');
    // PLACEHOLDER (B01-8a T0): S2 writes it.
    return null;
  },
});

/** A run's lines, newest first, 200 a page; the web reverses each page. */
export const events = query({
  args: { runId: v.id('importRuns'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, _args): Promise<PaginationResult<RunEventView>> => {
    await requireCapability(ctx, 'machinery.read');
    // PLACEHOLDER (B01-8a T0): S2 writes it.
    return { page: [], isDone: true, continueCursor: '' };
  },
});
