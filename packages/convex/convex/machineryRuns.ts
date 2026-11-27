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
 * **Every campaign is a stored row.** A campaign from before B01-8a has a reconstructed
 * `corpus_campaign` row (`campaign.reconstructed`, written by `importRunJobs`' backfill), drawn as
 * history: its liveness is always finished, its missing facts (flags, plan, exit status) absent, and
 * `recorded: false` on its views. Until that backfill has run, an old pass has neither a campaign
 * row nor `listedIn`, so it simply isn't listed — `listPage` says `indexed: false` — and no read
 * ever assembles a campaign from its runs. The switch is {@link isReconstructed}.
 *
 * **What each read touches** (a live campaign re-runs these on every flush and beat):
 * `lanes` — one `by_listed_started` row, and for a campaign one `by_parent` range of at most
 * {@link CAMPAIGN_PASS_LIMIT}. `listPage` — one `.paginate()` of at most {@link LIST_PAGE_SIZE},
 * one bounded range per campaign row on it, and one `by_listed_started` range of
 * {@link INDEXED_PROBE} rows for `indexed`. `campaign` — the row, one `by_parent` range, one
 * `by_campaign` range of {@link CAMPAIGN_RUNS_LIMIT}, the newest event of the running pass, and
 * at most two profiles. `run` — the row, its parent, its passes if it is a campaign, two
 * profiles. `events` — one `.paginate()` of at most {@link EVENTS_PAGE_SIZE}.
 */

import {
  CORPUS_HAND_PASSES,
  CORPUS_RUN_KINDS,
  CORPUS_RUN_PLAN,
  callerNow,
  campaignLiveness,
  LEGACY_RETIRE_LABEL_PREFIX,
  passOfRun,
  type RunLiveness,
  type RunLivenessInput,
  runLiveness,
} from '@skating/core';
import { type PaginationResult, paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type QueryCtx, query } from './_generated/server';
import { isDryRunRow } from './importRuns';
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
  /**
   * A by-hand pass that ran, wrote and was not marked: the list's *applied* (a script pass's is
   * *succeeded*). Always sent; optional so an older fixture still reads.
   */
  applied?: boolean;
  marked: boolean;
  scope: ScopeView;
  startedAt: number;
  finishedAt: number | null;
  /**
   * What core's rule reads to say this row's liveness — the row's own input and (a campaign) its
   * passes' — so a page re-reads it on its own clock by the same rule, and the list and the run page
   * never disagree. `null` for a row that can't come alive again (ended, marked, or rebuilt), whose
   * `liveness` is final. Always sent; optional so an older fixture still reads.
   */
  livenessInputs?: LivenessInputs | null;
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

/** A row's input to core's rule, and its passes' (a campaign's; none for a pass). */
export type LivenessInputs = { self: RunLivenessInput; passes: RunLivenessInput[] };

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
  /** The deployment the campaign's row was written to, as its writer named it. */
  deployment?: string;
  isProd?: boolean;
};

export type RunView = {
  doc: Doc<'importRuns'>;
  /** The run wrote nothing (its notes end with `importRuns`' `DRY_RUN_NOTE`). */
  dryRun?: boolean;
  liveness: LivenessView;
  /** As a list row's. */
  livenessInputs?: LivenessInputs | null;
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

// ── Bounds ─────────────────────────────────────────────────────────────────────────────────────

const MINUTE = 60_000;
/** How far the caller's clock may sit from the server's: one minute, the rounding it sends. */
const CLOCK_SLACK_MS = MINUTE;
/** The run list's page. */
export const LIST_PAGE_SIZE = 25;
/** A log page. */
export const EVENTS_PAGE_SIZE = 200;
/** A campaign's passes under it (`by_parent`): the script runs seven, so this is a loop gone wrong. */
export const CAMPAIGN_PASS_LIMIT = 20;
/** The rows carrying a campaign's id (`by_campaign`): its passes, the by-hand ones, retries. */
export const CAMPAIGN_RUNS_LIMIT = 50;
/** The newest unlisted rows `listPage` looks through to say whether the backfill has run. */
export const INDEXED_PROBE = 25;
/** The failure keys the campaign page names. */
const FAILURE_KEYS = 5;
/** A writer's clock this far from the server's is named on the page. */
const CLOCK_SKEW_SHOWN_MS = MINUTE;

const CORPUS_KINDS: ReadonlySet<string> = new Set(CORPUS_RUN_KINDS);
const HAND_PASSES: ReadonlySet<string> = new Set(CORPUS_HAND_PASSES);

// ── Facts of a row ─────────────────────────────────────────────────────────────────────────────

type Run = Doc<'importRuns'>;

/**
 * **The fork's switch**: a campaign row the backfill wrote for a campaign from before B01-8a
 * (`importRuns.campaign.reconstructed`). Only a stored `true` counts.
 */
export function isReconstructed(run: Pick<Run, 'campaign'>): boolean {
  return run.campaign?.reconstructed === true;
}

export const isCampaignRow = (run: Pick<Run, 'kind'>) => run.kind === 'corpus_campaign';

/** A dry run's row (its notes end with `importRuns`' `DRY_RUN_NOTE`). */
export const isDryRun = isDryRunRow;

/** What core's rule reads of a row. */
export function livenessInput(run: Run): RunLivenessInput {
  return {
    kind: run.kind,
    status: run.status,
    ...(run.progressAt === undefined ? {} : { progressAt: run.progressAt }),
    ...(run.markedFailed === undefined ? {} : { markedFailed: run.markedFailed }),
    ...(run.stallWait === undefined ? {} : { stallWaitUntil: run.stallWait.until }),
  };
}

/** The rule's input as the web is sent it: a mark is only its presence. */
function wireInput(run: Run): RunLivenessInput {
  const { markedFailed, ...rest } = livenessInput(run);
  return markedFailed === undefined ? rest : { ...rest, markedFailed: true };
}

/**
 * The inputs that re-read to `liveness` ({@link livenessOfRun}, {@link livenessOfCampaign}), or
 * `null` for a row whose verdict is final: not running, marked, or a rebuilt campaign.
 */
export function livenessInputsOf(run: Run, passes: readonly Run[]): LivenessInputs | null {
  if (run.status !== 'running' || run.markedFailed !== undefined || isReconstructed(run)) {
    return null;
  }
  return {
    self: wireInput(run),
    passes: isCampaignRow(run) ? passes.map(wireInput) : [],
  };
}

/** One pass's liveness (a campaign row's is {@link livenessOfCampaign}). */
export function livenessOfRun(run: Run, now: number): RunLiveness {
  return runLiveness(livenessInput(run), now);
}

/** A campaign's (its running pass's, or its own between passes); a reconstructed one is history. */
export function livenessOfCampaign(row: Run, passes: readonly Run[], now: number): RunLiveness {
  if (isReconstructed(row)) return { state: 'finished' };
  return campaignLiveness(livenessInput(row), passes.map(livenessInput), now);
}

const countOf = (run: Run, name: string) => run.counts.find((c) => c.name === name)?.value;

/** A campaign's passes under it, oldest first. */
async function passesUnder(ctx: QueryCtx, row: Run): Promise<Run[]> {
  return await ctx.db
    .query('importRuns')
    .withIndex('by_parent', (q) => q.eq('parentRunId', row._id))
    .take(CAMPAIGN_PASS_LIMIT);
}

/** Every row carrying a campaign's id, oldest first (none when the row has no id). */
async function runsOfCampaignId(ctx: QueryCtx, campaignId: string | undefined): Promise<Run[]> {
  if (campaignId === undefined) return [];
  return await ctx.db
    .query('importRuns')
    .withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
    .take(CAMPAIGN_RUNS_LIMIT);
}

/**
 * A campaign row's passes for its list row and its liveness: the rows under it; for a
 * reconstructed campaign (whose old passes may carry no parent), the script passes sharing its id.
 */
async function campaignPassesForRow(ctx: QueryCtx, row: Run): Promise<Run[]> {
  if (!isReconstructed(row)) return await passesUnder(ctx, row);
  const all = await ctx.db
    .query('importRuns')
    .withIndex('by_campaign', (q) => q.eq('campaignId', row.campaignId ?? ''))
    .take(CAMPAIGN_PASS_LIMIT);
  return all.filter((r) => isScriptPassOf(r, row));
}

/** A run that is one of a campaign's script passes: under it, or (no parent) sharing its id. */
function isScriptPassOf(run: Run, row: Run): boolean {
  if (run._id === row._id || isCampaignRow(run)) return false;
  if (run.parentRunId !== undefined) return run.parentRunId === row._id;
  if (run.campaignId === undefined || run.campaignId !== row.campaignId) return false;
  const pass = passOfRun(run);
  return pass !== null && !HAND_PASSES.has(pass);
}

/** A row's title: the campaign id, the pass's name, or (a load by hand, an unknown kind) its label. */
export function titleOf(run: Run): string {
  if (isCampaignRow(run)) return run.campaignId ?? run.label;
  const known = run.campaignPass !== undefined && passOfRun(run) === run.campaignPass;
  // `run-canonical.sh`'s single-state loads are `canonical_water` with no pass: their label says
  // which state ("VT canonical water"), where *load* would not.
  if (
    !known &&
    run.kind === 'canonical_water' &&
    !run.label.startsWith(LEGACY_RETIRE_LABEL_PREFIX)
  ) {
    return run.label;
  }
  return passOfRun(run) ?? run.label;
}

/** The headline count of a pass's sub-line, by kind, the first one present. */
const HEADLINE: Readonly<Record<string, readonly string[]>> = {
  region_masks: ['maskFeatures', 'states'],
  corpus_merge: ['emitted', 'kept', 'groups'],
  canonical_water: ['retired', 'inserted', 'imported', 'bodiesRead'],
  sub_area_seed: ['created', 'baysRead'],
  landmark_match: ['bodiesWithLandmarks', 'corpusMatched'],
  landmark_seed: ['landmarksRead', 'namesRead', 'bodies'],
  floor_prune: ['demoted', 'scanned'],
  standing_seed: ['demoted', 'scanned'],
  absorbed_retire: ['retired', 'scanned'],
  dedup_resolve: ['deleted', 'considered'],
  seed_destinations: ['applied', 'matched'],
};

export function headlineOf(run: Run): { name: string; value: number } | null {
  for (const name of HEADLINE[run.kind] ?? []) {
    const value = countOf(run, name);
    if (value !== undefined) return { name, value };
  }
  return null;
}

/** Bodies a load wrote: inserted plus updated, `null` when it counted neither. */
function bodiesLoadedOf(load: Run | undefined): number | null {
  if (load === undefined) return null;
  const inserted = countOf(load, 'inserted');
  const updated = countOf(load, 'updated');
  if (inserted === undefined && updated === undefined) return null;
  return (inserted ?? 0) + (updated ?? 0);
}

function scopeOf(run: Run): ScopeView {
  if (run.scope === undefined) return null;
  return { pass: run.scope.pass, states: run.scope.states ?? null, complete: run.scope.complete };
}

const isLive = (l: RunLiveness) => l.state !== 'finished';

/** The newest of the runs that are live, by start. */
function newestLive(passes: readonly Run[], now: number): Run | null {
  let found: Run | null = null;
  for (const p of passes) {
    if (isLive(livenessOfRun(p, now)) && (found === null || p.startedAt >= found.startedAt))
      found = p;
  }
  return found;
}

/** A by-hand pass that ran to its end, wrote, and was not marked failed. */
export function isAppliedHandPass(run: Run): boolean {
  if (isCampaignRow(run) || run.status !== 'succeeded' || run.markedFailed !== undefined) {
    return false;
  }
  if (isDryRun(run)) return false;
  return HAND_PASSES.has(passOfRun(run) ?? run.campaignPass ?? '');
}

/** A run list row. `passes` are a campaign row's (ignored for a pass). */
export function rowView(run: Run, passes: readonly Run[], now: number): RunRowView {
  const campaignRow = isCampaignRow(run);
  const base = {
    id: run._id,
    title: titleOf(run),
    campaignId: run.campaignId ?? null,
    status: run.status,
    dryRun: isDryRun(run),
    applied: isAppliedHandPass(run),
    marked: run.markedFailed !== undefined,
    scope: scopeOf(run),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
  };
  if (!campaignRow) {
    return {
      ...base,
      kind: 'pass',
      liveness: livenessOfRun(run, now),
      livenessInputs: livenessInputsOf(run, []),
      line: { kind: 'pass', headline: headlineOf(run) },
    };
  }
  const reconstructed = isReconstructed(run);
  const plan = run.campaign?.plan;
  const current = reconstructed ? null : newestLive(passes, now);
  const load = [...passes].reverse().find((p) => passOfRun(p) === 'load');
  return {
    ...base,
    kind: 'campaign',
    liveness: livenessOfCampaign(run, passes, now),
    livenessInputs: livenessInputsOf(run, passes),
    line: {
      kind: 'campaign',
      passesDone: passes.filter((p) => p.status === 'succeeded' && p.markedFailed === undefined)
        .length,
      passesPlanned: reconstructed || plan === undefined || plan.length === 0 ? null : plan.length,
      current: current === null ? null : (passOfRun(current) ?? current.campaignPass ?? null),
      stoppedAt: run.status === 'failed' ? (run.campaign?.lastPass ?? null) : null,
      bodiesLoaded: bodiesLoadedOf(load),
      recorded: !reconstructed,
    },
  };
}

// ── People ─────────────────────────────────────────────────────────────────────────────────────

async function personOf(ctx: QueryCtx, id: Id<'profiles'>): Promise<PersonView> {
  const p = await ctx.db.get(id);
  const gone = p === null || p.status === 'deleted' || p.deletionRequestedAt !== undefined;
  return {
    id,
    name: p?.displayName ?? '',
    avatarUrl: gone ? null : (p.profileImageUrl ?? null),
  };
}

async function markedOf(ctx: QueryCtx, run: Run): Promise<MarkedView | null> {
  if (run.markedFailed === undefined) return null;
  return {
    by: await personOf(ctx, run.markedFailed.byUserId),
    at: run.markedFailed.at,
    reason: run.markedFailed.reason,
    loaderFinish: run.loaderFinish ?? null,
  };
}

/** A wait still holding (`now < until`); an expired one is no longer the page's to show. */
async function waitingOf(ctx: QueryCtx, run: Run, now: number): Promise<WaitingView | null> {
  if (run.stallWait === undefined || now >= run.stallWait.until) return null;
  return {
    by: await personOf(ctx, run.stallWait.byUserId),
    at: run.stallWait.at,
    until: run.stallWait.until,
  };
}

// ── The lane's tail (shared with the Overview's card) ──────────────────────────────────────────

/** The newest listed corpus run and its verdict, or `null` when nothing is listed. */
export async function corpusTail(
  ctx: QueryCtx,
  now: number,
): Promise<{ run: Run; liveness: RunLiveness } | null> {
  const run = await ctx.db
    .query('importRuns')
    .withIndex('by_listed_started', (q) => q.eq('listedIn', 'corpus'))
    .order('desc')
    .first();
  if (run === null) return null;
  const liveness = isCampaignRow(run)
    ? livenessOfCampaign(run, await campaignPassesForRow(ctx, run), now)
    : livenessOfRun(run, now);
  return { run, liveness };
}

/** A tail from a run and its verdict: a finished run is failed (a mark included) or ok. */
export function laneTailOf(run: Run, liveness: RunLiveness): LaneTail {
  if (liveness.state === 'finished') {
    const failed = run.status === 'failed' || run.markedFailed !== undefined;
    return { state: failed ? 'failed' : 'ok', at: run.finishedAt ?? run.startedAt };
  }
  return { state: liveness.state, at: run.progressAt ?? run.startedAt };
}

// ── The reads ──────────────────────────────────────────────────────────────────────────────────

/** The sidebar's tail: one entry per built page; B01-8a's only key is `corpus`. */
export const lanes = query({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ corpus: LaneTail }> => {
    await requireCapability(ctx, 'machinery.read');
    const now = callerNow(args.now, Date.now(), CLOCK_SLACK_MS);
    const tail = await corpusTail(ctx, now);
    return {
      corpus: tail === null ? { state: 'never', at: null } : laneTailOf(tail.run, tail.liveness),
    };
  },
});

/**
 * Whether the listing backfill has run: no row among the newest unlisted ones is a corpus run with
 * no parent (every run started after the deploy is listed by `start`; every older one by the
 * backfill, which leaves an old pass either listed or under its reconstructed campaign).
 */
async function isIndexed(ctx: QueryCtx): Promise<boolean> {
  const unlisted = await ctx.db
    .query('importRuns')
    .withIndex('by_listed_started', (q) => q.eq('listedIn', undefined))
    .order('desc')
    .take(INDEXED_PROBE);
  return !unlisted.some((r) => r.parentRunId === undefined && CORPUS_KINDS.has(r.kind));
}

/** A page of a lane's runs, newest first, 25 a page; `indexed` false until the backfill has run. */
export const listPage = query({
  args: {
    // Widened to a union as each pipeline's page lands.
    lane: v.literal('corpus'),
    paginationOpts: paginationOptsValidator,
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<PaginationResult<RunRowView> & { indexed: boolean }> => {
    await requireCapability(ctx, 'machinery.read');
    const now = callerNow(args.now, Date.now(), CLOCK_SLACK_MS);
    const result = await ctx.db
      .query('importRuns')
      .withIndex('by_listed_started', (q) => q.eq('listedIn', args.lane))
      .order('desc')
      .paginate({
        ...args.paginationOpts,
        numItems: Math.max(1, Math.min(LIST_PAGE_SIZE, args.paginationOpts.numItems)),
      });
    const page: RunRowView[] = [];
    for (const run of result.page) {
      const passes = isCampaignRow(run) ? await campaignPassesForRow(ctx, run) : [];
      page.push(rowView(run, passes, now));
    }
    return { ...result, page, indexed: await isIndexed(ctx) };
  },
});

/** The *Passes* table: the plan merged with the runs, then the by-hand passes. */
export function passRows(row: Run, runs: readonly Run[], now: number): PassRowView[] {
  const reconstructed = isReconstructed(row);
  const live = !reconstructed && isLive(livenessOfRun(row, now));
  const passOf = (r: Run) => passOfRun(r) ?? r.campaignPass ?? null;
  const newestOf = (pass: string): Run | null => {
    let found: Run | null = null;
    for (const r of runs) {
      if (passOf(r) === pass && (found === null || r.startedAt >= found.startedAt)) found = r;
    }
    return found;
  };

  // The script's passes: the stored plan, or (none stored) the passes found, in the script's order.
  const stored = row.campaign?.plan.filter((p) => p.by === 'script');
  const script =
    stored !== undefined && stored.length > 0
      ? stored.map((p) => ({ pass: p.pass, skipped: p.skipped ?? null }))
      : CORPUS_RUN_PLAN.filter((p) => p.by === 'script' && newestOf(p.pass) !== null).map((p) => ({
          pass: p.pass as string,
          skipped: null,
        }));

  const merge = newestOf('merge');
  const absorbed = merge === null ? 0 : (countOf(merge, 'absorbedPairs') ?? 0);
  const retired = runs.some(
    (r) => passOf(r) === 'retire-absorbed' && r.status === 'succeeded' && !isDryRun(r),
  );

  const view = (pass: string, by: 'script' | 'hand', skipped: string | null): PassRowView => {
    const run = newestOf(pass);
    const does = CORPUS_RUN_PLAN.find((p) => p.pass === pass)?.does ?? '';
    let state: PassRowView['state'];
    if (pass === 'retire-absorbed' && absorbed > 0 && !retired) state = 'required';
    else if (run === null)
      state = skipped !== null ? 'skipped' : by === 'script' && live ? 'waiting' : 'notRun';
    else state = passState(run, now);
    return {
      pass,
      does,
      by,
      state,
      skipped,
      run:
        run === null
          ? null
          : {
              id: run._id,
              startedAt: run.startedAt,
              finishedAt: run.finishedAt ?? null,
              inUp: inUpOf(run),
              failed: run.failuresTotal,
            },
    };
  };
  return [
    ...script.map((p) => view(p.pass, 'script', p.skipped)),
    ...CORPUS_HAND_PASSES.map((pass) => view(pass, 'hand', null)),
  ];
}

/**
 * A run's state in the table. A stall held by *Wait 30 minutes* still reads `stalled` here (the
 * table's `waiting` is a pass not started yet, the board's word); the wait is the page's head. A
 * running row with no heartbeat reads `late`: it needs a look, and nothing says it died.
 */
function passState(run: Run, now: number): PassRowView['state'] {
  const l = livenessOfRun(run, now);
  switch (l.state) {
    case 'finished':
      if (run.status === 'failed' || run.markedFailed !== undefined) return 'failed';
      return isDryRun(run) ? 'dryRun' : 'done';
    case 'waiting':
      return 'stalled';
    case 'notRecorded':
      return 'late';
    default:
      return l.state;
  }
}

function inUpOf(run: Run): { in: number; up: number } | null {
  const inserted = countOf(run, 'inserted');
  const updated = countOf(run, 'updated');
  if (inserted === undefined && updated === undefined) return null;
  return { in: inserted ?? 0, up: updated ?? 0 };
}

function currentOf(run: Run): NonNullable<CampaignView['current']> {
  const applied = countOf(run, 'batchesApplied');
  return {
    runId: run._id,
    pass: passOfRun(run) ?? run.campaignPass ?? run.label,
    counts: run.counts,
    progressAt: run.progressAt ?? null,
    batches:
      applied === undefined ? null : { applied, total: countOf(run, 'batchesTotal') ?? null },
    failures: {
      stored: run.failures.length,
      total: run.failuresTotal,
      keys: run.failures
        .flatMap((f) => (f.key === undefined ? [] : [f.key]))
        .slice(0, FAILURE_KEYS),
    },
  };
}

/** The newest line's writer clock against the server's, when they differ by over a minute. */
async function clockSkewOf(ctx: QueryCtx, runId: Id<'importRuns'>): Promise<number | null> {
  const line = await ctx.db
    .query('runEvents')
    .withIndex('by_run_seq', (q) => q.eq('runId', runId))
    .order('desc')
    .first();
  if (line === null) return null;
  const skew = line.loggedAt - line.at;
  return Math.abs(skew) > CLOCK_SKEW_SHOWN_MS ? skew : null;
}

/** The campaign row a campaign id names: its newest, when the script was run twice under one id. */
async function campaignRowById(ctx: QueryCtx, campaignId: string): Promise<Run | null> {
  const rows = await runsOfCampaignId(ctx, campaignId);
  let found: Run | null = null;
  for (const r of rows)
    if (isCampaignRow(r) && (found === null || r.startedAt >= found.startedAt)) found = r;
  return found;
}

/** The campaign page, by its row or by its campaign id. `null` for no such campaign row. */
export const campaign = query({
  args: {
    runId: v.optional(v.id('importRuns')),
    campaignId: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<CampaignView | null> => {
    await requireCapability(ctx, 'machinery.read');
    const now = callerNow(args.now, Date.now(), CLOCK_SLACK_MS);
    let row: Run | null = null;
    if (args.runId !== undefined) row = await ctx.db.get(args.runId);
    else if (args.campaignId !== undefined) row = await campaignRowById(ctx, args.campaignId);
    if (row === null || !isCampaignRow(row)) return null;

    const under = await passesUnder(ctx, row);
    const byId = await runsOfCampaignId(ctx, row.campaignId);
    const seen = new Set(under.map((r) => r._id));
    const self = row;
    // Its own passes, then what shares its id without a parent: the by-hand passes (and, for a
    // reconstructed campaign, its old script passes).
    const runs = [
      ...under,
      ...byId.filter((r) => !seen.has(r._id) && r.parentRunId === undefined && !isCampaignRow(r)),
    ];
    const scriptPasses = runs.filter((r) => isScriptPassOf(r, self));
    const reconstructed = isReconstructed(row);
    const liveness = livenessOfCampaign(row, scriptPasses, now);
    const running = reconstructed ? null : newestLive(scriptPasses, now);
    const shown =
      running ??
      scriptPasses.reduce<Run | null>(
        (a, r) => (a === null || r.startedAt >= a.startedAt ? r : a),
        null,
      );
    const merge = [...scriptPasses].reverse().find((r) => passOfRun(r) === 'merge');
    const heldBy = running ?? row;
    return {
      row: rowView(row, scriptPasses, now),
      recorded: !reconstructed,
      flags: reconstructed || row.campaign === undefined ? null : row.campaign.flags,
      passes: passRows(row, runs, now),
      liveness,
      current: shown === null ? null : currentOf(shown),
      path: merge?.stages ?? [],
      marked: await markedOf(ctx, row),
      waiting: await waitingOf(ctx, heldBy, now),
      clockSkewMs: running === null ? null : await clockSkewOf(ctx, running._id),
      deployment: row.deployment,
      isProd: row.isProd,
    };
  },
});

/** One run, whole, with its liveness, its parent, and the mark and wait. */
export const run = query({
  args: { runId: v.id('importRuns'), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<RunView | null> => {
    await requireCapability(ctx, 'machinery.read');
    const now = callerNow(args.now, Date.now(), CLOCK_SLACK_MS);
    const doc = await ctx.db.get(args.runId);
    if (doc === null) return null;
    const passes = isCampaignRow(doc) ? await campaignPassesForRow(ctx, doc) : [];
    const liveness = isCampaignRow(doc)
      ? livenessOfCampaign(doc, passes, now)
      : livenessOfRun(doc, now);
    const parentDoc = doc.parentRunId === undefined ? null : await ctx.db.get(doc.parentRunId);
    return {
      doc,
      dryRun: isDryRun(doc),
      liveness,
      livenessInputs: livenessInputsOf(doc, passes),
      parent: parentDoc === null ? null : { id: parentDoc._id, title: titleOf(parentDoc) },
      marked: await markedOf(ctx, doc),
      waiting: await waitingOf(ctx, doc, now),
    };
  },
});

/** A run's lines, newest first, 200 a page; the web reverses each page. */
export const events = query({
  args: { runId: v.id('importRuns'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<PaginationResult<RunEventView>> => {
    await requireCapability(ctx, 'machinery.read');
    const result = await ctx.db
      .query('runEvents')
      .withIndex('by_run_seq', (q) => q.eq('runId', args.runId))
      .order('desc')
      .paginate({
        ...args.paginationOpts,
        numItems: Math.max(1, Math.min(EVENTS_PAGE_SIZE, args.paginationOpts.numItems)),
      });
    return {
      ...result,
      page: result.page.map((e) => ({
        seq: e.seq,
        loggedAt: e.loggedAt,
        kind: e.kind,
        text: e.text,
        dropped: e.dropped ?? null,
      })),
    };
  },
});
