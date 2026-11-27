/**
 * ETL run history (A06c Workstream §6.2) — the durable home for the summary every loader used to
 * print to a terminal that scrolls.
 *
 * The write path is **internal only** and is called by the loaders under `scripts/` through
 * `pnpm exec convex run`, the same admin-credentialed channel `importCanonical` uses. The read path
 * is admin-gated: a run row names source URLs, deployment targets and file checksums, which is
 * operator detail rather than anything a skater has a reason to see.
 *
 * See the `importRuns` table comment in `schema.ts` for the shape and why it is one row per run.
 */

import { CORPUS_RUN_KINDS } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx, query } from './_generated/server';
import { requireCapability } from './lib/auth';
import { IMPORT_RUN_KINDS, IMPORT_RUN_SCOPES, WEATHER_CELL_INVALIDATING_KINDS } from './lib/enums';
import { literals } from './lib/validators';
import { insertRunLines } from './runEvents';
import { RECONCILE_DEBOUNCE_MS } from './weatherArchive';

/**
 * How many itemized failures one run stores.
 *
 * **Bounded on purpose, and reported as bounded.** A run that declines 8,000 features would
 * otherwise put 8,000 sub-documents in a single row and hit Convex's 1 MB document cap — turning an
 * observability feature into the thing that fails the import. 200 is enough to see every *distinct*
 * reason (the reason vocabulary is small; it is the repetition that is large), and `failuresTotal`
 * carries the real number so the sample can never be mistaken for the whole.
 */
export const MAX_STORED_FAILURES = 200;

const countValidator = v.object({ name: v.string(), value: v.number() });

const stageValidator = v.object({
  name: v.string(),
  detail: v.optional(v.string()),
  command: v.optional(v.string()),
  input: v.optional(v.string()),
  output: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  bytes: v.optional(v.number()),
  sha256: v.optional(v.string()),
  md5: v.optional(v.string()),
  checksumVerified: v.optional(v.boolean()),
  sourceAt: v.optional(v.number()),
  counts: v.optional(v.array(countValidator)),
});

const failureValidator = v.object({
  stage: v.string(),
  key: v.optional(v.string()),
  reason: v.string(),
});

const coverageValidator = v.object({
  unit: v.string(),
  eligible: v.number(),
  covered: v.number(),
  omissions: v.array(v.object({ reason: v.string(), count: v.number() })),
});

/** What the run set out to cover (D218) — see the `importRuns.scope` schema note. */
const scopeValidator = v.object({
  pass: literals(IMPORT_RUN_SCOPES),
  states: v.optional(v.array(v.string())),
  complete: v.boolean(),
});

/**
 * The note a dry run's row ends with (`scripts/run-log`'s `DRY_RUN_NOTE`, the same words): the
 * server's one way to tell a run that wrote nothing.
 */
export const DRY_RUN_NOTE = 'dry run — nothing written';

/** Whether a run row is a dry run (it changed nothing, so it invalidates nothing). */
export const isDryRunRow = (run: Pick<Doc<'importRuns'>, 'notes'>): boolean =>
  (run.notes ?? []).includes(DRY_RUN_NOTE);

/** A campaign's flags and planned passes, bounded at the write (no array past a few dozen). */
export const MAX_CAMPAIGN_FLAGS = 64;
export const MAX_CAMPAIGN_PLAN = 32;
/** A flag's, a pass name's and a skip reason's length. */
export const MAX_CAMPAIGN_WORD = 200;

/** What `run-corpus.sh` was asked, stated once at `start` (D341); its close comes at `finish`. */
const campaignStartValidator = v.object({
  flags: v.array(v.string()),
  plan: v.array(
    v.object({
      pass: v.string(),
      by: literals(['script', 'hand']),
      skipped: v.optional(v.string()),
    }),
  ),
});

/** How a campaign ended: the script's exit status and the pass it was in. */
const campaignCloseValidator = v.object({
  exitCode: v.number(),
  lastPass: v.optional(v.string()),
});

function checkCampaignWords(campaign: {
  flags: string[];
  plan: { pass: string; skipped?: string }[];
}) {
  if (campaign.flags.length > MAX_CAMPAIGN_FLAGS) {
    throw new ConvexError(`A campaign records at most ${MAX_CAMPAIGN_FLAGS} flags.`);
  }
  if (campaign.plan.length > MAX_CAMPAIGN_PLAN) {
    throw new ConvexError(`A campaign records at most ${MAX_CAMPAIGN_PLAN} passes.`);
  }
  const words = [
    ...campaign.flags,
    ...campaign.plan.flatMap((p) => [p.pass, ...(p.skipped !== undefined ? [p.skipped] : [])]),
  ];
  if (words.some((w) => w.length > MAX_CAMPAIGN_WORD)) {
    throw new ConvexError(
      `A campaign's flags and pass names are at most ${MAX_CAMPAIGN_WORD} characters.`,
    );
  }
}

/**
 * The campaign a pass ran under, as `start` keeps it: the row named, if it exists and is a campaign.
 * A parent that is gone or isn't a campaign is dropped, so the pass lists on its own rather than
 * hiding inside nothing.
 */
async function parentCampaign(
  ctx: MutationCtx,
  parentRunId: Id<'importRuns'> | undefined,
): Promise<Id<'importRuns'> | undefined> {
  if (parentRunId === undefined) return undefined;
  const parent = await ctx.db.get(parentRunId);
  return parent?.kind === 'corpus_campaign' ? parent._id : undefined;
}

/**
 * The Machinery list a run with no parent is a row of (D341): `corpus` for a corpus kind
 * (`CORPUS_RUN_KINDS`), else none yet — each pipeline's page widens it as it lands.
 */
export function listedInOf(
  kind: string,
  parentRunId: Id<'importRuns'> | undefined,
): 'corpus' | undefined {
  if (parentRunId !== undefined) return undefined;
  return CORPUS_RUN_KINDS.includes(kind) ? 'corpus' : undefined;
}

/**
 * Open a run.
 *
 * Written **before** the first batch rather than after the last, which is the whole difference
 * between this and a printed summary: a loader killed halfway leaves a `running` row naming what it
 * was doing, instead of leaving nothing at all.
 */
export const start = internalMutation({
  args: {
    kind: literals(IMPORT_RUN_KINDS),
    label: v.string(),
    campaignId: v.optional(v.string()),
    deployment: v.string(),
    isProd: v.boolean(),
    stages: v.optional(v.array(stageValidator)),
    notes: v.optional(v.array(v.string())),
    /** What the run set out to cover — stated once, here, by the writer that knows it (D218). */
    scope: v.optional(scopeValidator),
    /** The campaign row this pass runs under (D341, `RUN_CORPUS_PARENT`). */
    parentRunId: v.optional(v.id('importRuns')),
    /** `run-corpus.sh`'s name for the pass (D341, `RUN_CORPUS_PASS`). */
    campaignPass: v.optional(v.string()),
    /** On a `corpus_campaign` row only: the flags and the planned passes (D341). */
    campaign: v.optional(campaignStartValidator),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    if (args.campaign !== undefined) {
      if (args.kind !== 'corpus_campaign') {
        throw new ConvexError('Only a corpus campaign row records flags and a plan.');
      }
      checkCampaignWords(args.campaign);
    }
    if (args.campaignPass !== undefined && args.campaignPass.length > MAX_CAMPAIGN_WORD) {
      throw new ConvexError(`A pass name is at most ${MAX_CAMPAIGN_WORD} characters.`);
    }
    const parentRunId = await parentCampaign(ctx, args.parentRunId);
    const listedIn = listedInOf(args.kind, parentRunId);
    return await ctx.db.insert('importRuns', {
      kind: args.kind,
      label: args.label,
      campaignId: args.campaignId,
      deployment: args.deployment,
      isProd: args.isProd,
      status: 'running',
      startedAt: now,
      // The first beat: a loader killed before its first flush is silent from its start.
      progressAt: now,
      counts: [],
      stages: args.stages ?? [],
      failures: [],
      failuresTotal: 0,
      notes: args.notes,
      ...(args.scope !== undefined && { scope: args.scope }),
      ...(parentRunId !== undefined && { parentRunId }),
      ...(args.campaignPass !== undefined && { campaignPass: args.campaignPass }),
      ...(listedIn !== undefined && { listedIn }),
      ...(args.campaign !== undefined && { campaign: args.campaign }),
    });
  },
});

/**
 * Merge progress into an open run.
 *
 * **Counts are replaced by name, not accumulated.** The loader already holds running totals, and
 * making the server add would mean a retried progress call double-counts — the one arithmetic bug
 * an observability table cannot afford, because nothing downstream would contradict it.
 *
 * Failures append up to the cap while `failuresTotal` keeps counting past it.
 *
 * **Every call is a heartbeat** (D218): `progressAt` is stamped here, by the server's clock, so a
 * loader needs no change to have one and cannot send a wrong one. A call carrying nothing new still
 * beats — a run that is alive and between counts is not stalled.
 */
export const progress = internalMutation({
  args: {
    runId: v.id('importRuns'),
    counts: v.optional(v.array(countValidator)),
    stages: v.optional(v.array(stageValidator)),
    failures: v.optional(v.array(failureValidator)),
    /**
     * Total failures the loader has seen, when it knows better than the sample it is sending
     * (a transform that declined 300 features but only forwards the first 200).
     */
    failuresTotal: v.optional(v.number()),
    coverage: v.optional(coverageValidator),
  },
  handler: async (ctx, { runId, counts, stages, failures, failuresTotal, coverage }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error(`importRuns row ${runId} not found`);
    const patch = mergeInto(run, { counts, stages, failures, failuresTotal, coverage });
    await ctx.db.patch(runId, { ...patch, progressAt: Date.now() });
  },
});

/**
 * Close a run.
 *
 * Takes the same merge as `progress` plus the terminal status, so a loader that never called
 * `progress` can write everything in one call and a loader that did can finish with a delta.
 */
export const finish = internalMutation({
  args: {
    runId: v.id('importRuns'),
    status: v.union(v.literal('succeeded'), v.literal('failed')),
    counts: v.optional(v.array(countValidator)),
    stages: v.optional(v.array(stageValidator)),
    failures: v.optional(v.array(failureValidator)),
    failuresTotal: v.optional(v.number()),
    coverage: v.optional(coverageValidator),
    error: v.optional(v.string()),
    notes: v.optional(v.array(v.string())),
    /**
     * `false` for a dry run (D258): it changed nothing, so it invalidates nothing — no reconcile is
     * scheduled for it. Absent means a run that applied what it did, as every loader's does.
     */
    applied: v.optional(v.boolean()),
    /** On a `corpus_campaign` row: the script's exit status and the pass it was in (D341). */
    campaign: v.optional(campaignCloseValidator),
  },
  handler: async (
    ctx,
    {
      runId,
      status,
      counts,
      stages,
      failures,
      failuresTotal,
      coverage,
      error,
      notes,
      applied,
      campaign,
    },
  ) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error(`importRuns row ${runId} not found`);
    if (campaign?.lastPass !== undefined && campaign.lastPass.length > MAX_CAMPAIGN_WORD) {
      throw new ConvexError(`A pass name is at most ${MAX_CAMPAIGN_WORD} characters.`);
    }
    const now = Date.now();
    // The script's close lands on the campaign object it opened with. A row that has none (a
    // campaign opened before `start` took one) keeps its exit status only in its close line: an
    // empty plan written here would read as a campaign that planned nothing.
    const campaignPatch =
      campaign !== undefined && run.campaign !== undefined
        ? {
            campaign: {
              ...run.campaign,
              exitCode: campaign.exitCode,
              ...(campaign.lastPass !== undefined && { lastPass: campaign.lastPass }),
            },
          }
        : {};
    const merged = mergeInto(run, { counts, stages, failures, failuresTotal, coverage });

    if (run.markedFailed !== undefined) {
      // ⚠ **A late finish never erases a hand mark** (D342, ruling 12). The run was marked failed in
      // the console; the loader's own close is kept beside the mark as `loaderFinish` — the status,
      // the finish time and the mark stay as the person left them, and the page says what the loader
      // reported. Its counts and path still merge, and its heartbeat still moves: a run that was
      // alive after all says so. *Undo* on the mark (`reopenRun`) puts this close in its place.
      await ctx.db.patch(runId, {
        ...merged,
        progressAt: now,
        notes: notes ?? run.notes,
        ...campaignPatch,
        loaderFinish: {
          status,
          at: now,
          ...(error !== undefined && { error }),
          ...(applied !== undefined && { applied }),
        },
      });
      await insertRunLines(
        ctx,
        runId,
        [
          {
            kind: 'close',
            text:
              status === 'succeeded'
                ? 'The loader closed the run itself: succeeded'
                : `The loader closed the run itself: failed${error ? `: ${error}` : ''}`,
            loggedAt: now,
          },
        ],
        now,
      );
    } else {
      await ctx.db.patch(runId, {
        ...merged,
        status,
        finishedAt: now,
        // The last beat is the close: a finished row's heartbeat never trails its finish.
        progressAt: now,
        error,
        notes: notes ?? run.notes,
        ...campaignPatch,
      });
    }

    // ⚠ **A finished corpus import is what invalidates the weather cell registry (A06h / D152).**
    //
    // `weatherCells` is a projection of `waterBodies`, and the daily Tier-B sweep pages it — so a
    // body imported into a previously-unoccupied cell is absent from weather discovery until
    // something re-derives the registry. Before this trigger the only thing that did was a weekly
    // cron, which made the *cadence* an accuracy decision; it should never have been one. The
    // corpus changes in operator-run bursts, so the honest signal is this event, and the cron is
    // demoted to a safety net.
    //
    // Debounced rather than immediate: a campaign is several loaders and each `finish` would
    // otherwise request its own full corpus walk. See `RECONCILE_DEBOUNCE_MS`.
    //
    // Success only. A failed run is retried, and the retry's success fires this; firing on failure
    // would spend a walk per attempt on a loader stuck in a retry loop.
    //
    // Keyed on the **loader's** outcome, never on a hand mark (D342): a marked run whose loader later
    // closes it succeeded did change the bodies, so it schedules the walk as any success does.
    if (
      status === 'succeeded' &&
      applied !== false &&
      WEATHER_CELL_INVALIDATING_KINDS.includes(run.kind)
    ) {
      await requestCellReconcile(ctx);
    }
  },
});

/** Ask for the debounced weather-cell walk (`maybeSyncWeatherCells`): see `finish`'s note. */
export async function requestCellReconcile(ctx: MutationCtx): Promise<void> {
  await ctx.scheduler.runAfter(
    RECONCILE_DEBOUNCE_MS,
    internal.weatherArchive.maybeSyncWeatherCells,
    { requestedAt: Date.now() },
  );
}

/**
 * **Whether a run marked failed by hand changed the bodies** (D342, the founder's ruling on fork 2):
 * a kind that invalidates the weather cells, not a dry run, and at least one batch applied. A load
 * counts its batches (`batchesApplied`); a kind that counts none is taken to have applied what it
 * did — the error the enum's note says to make (a spurious walk is cheap; a missed one is a week).
 */
export function markChangedBodies(
  run: Pick<Doc<'importRuns'>, 'kind' | 'notes' | 'counts'>,
): boolean {
  if (!WEATHER_CELL_INVALIDATING_KINDS.includes(run.kind)) return false;
  if (isDryRunRow(run)) return false;
  const batches = run.counts.find((c) => c.name === 'batchesApplied');
  return batches === undefined || batches.value > 0;
}

/**
 * Correct a run's timestamps after the fact.
 *
 * **Only for recording a run that already happened.** `start` and `finish` stamp the server clock,
 * which is right for a live loader and wrong for a backfill — the raw archives were populated on
 * 2026-07-31, long before this table existed, and their manifests carry the real `fetchedAt`. A row
 * that says a historical fetch happened this afternoon is worse than no row: it would make the
 * archive look fresh, which is precisely the question ("when did we last populate this?") the row
 * exists to answer honestly.
 *
 * Deliberately not part of `finish`, so the ordinary path cannot set its own clock.
 */
export const restamp = internalMutation({
  args: {
    runId: v.id('importRuns'),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  },
  handler: async (ctx, { runId, startedAt, finishedAt }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error(`importRuns row ${runId} not found`);
    // The heartbeat moves with the times it describes: a historical fetch must not read as having
    // reported this afternoon, the same lie this mutation exists to stop telling about `startedAt`.
    await ctx.db.patch(runId, { startedAt, finishedAt, progressAt: finishedAt ?? startedAt });
  },
});

/** Shared merge for `progress` / `finish` — see each for why counts replace and failures append. */
function mergeInto(
  run: Doc<'importRuns'>,
  delta: {
    counts?: { name: string; value: number }[];
    stages?: Doc<'importRuns'>['stages'];
    failures?: { stage: string; key?: string; reason: string }[];
    failuresTotal?: number;
    coverage?: Doc<'importRuns'>['coverage'];
  },
) {
  const counts = new Map(run.counts.map((c) => [c.name, c.value]));
  for (const c of delta.counts ?? []) counts.set(c.name, c.value);

  // Stages replace by name too — a stage is re-sent when its counts firm up (the load stage's
  // batch tally), and appending would render the same step twice with different numbers.
  const stages = [...run.stages];
  for (const stage of delta.stages ?? []) {
    const at = stages.findIndex((s) => s.name === stage.name);
    if (at === -1) stages.push(stage);
    else stages[at] = stage;
  }

  const incoming = delta.failures ?? [];
  const room = Math.max(0, MAX_STORED_FAILURES - run.failures.length);
  const failures = [...run.failures, ...incoming.slice(0, room)];
  const seen = run.failuresTotal + incoming.length;

  return {
    counts: [...counts].map(([name, value]) => ({ name, value })),
    stages,
    failures,
    // The loader's own total wins when it sends one — it can see failures it chose not to forward.
    failuresTotal: Math.max(seen, delta.failuresTotal ?? 0),
    // Coverage replaces wholesale rather than merging: it is one coherent statement about a run,
    // and a half-updated denominator would be worse than a stale one.
    coverage: delta.coverage ?? run.coverage,
  };
}

/**
 * Newest runs first, optionally narrowed to one loader or one campaign.
 *
 * Returns whole rows: a run is a bounded document by construction (see `MAX_STORED_FAILURES`), so
 * there is no page-two problem to solve and the detail view needs no second round trip.
 */
export const list = query({
  args: {
    kind: v.optional(literals(IMPORT_RUN_KINDS)),
    campaignId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { kind, campaignId, limit }) => {
    await requireCapability(ctx, 'machinery.read');
    const take = Math.min(200, Math.max(1, limit ?? 50));
    if (campaignId !== undefined) {
      return await ctx.db
        .query('importRuns')
        .withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
        .order('desc')
        .take(take);
    }
    if (kind !== undefined) {
      return await ctx.db
        .query('importRuns')
        .withIndex('by_kind_started', (q) => q.eq('kind', kind))
        .order('desc')
        .take(take);
    }
    return await ctx.db.query('importRuns').withIndex('by_started').order('desc').take(take);
  },
});

/**
 * Minimal `(kind, label, startedAt)` triples, for the archive backfill's idempotence check.
 *
 * Internal and deliberately thin: the backfill needs only enough to know what it has already
 * written, and shipping whole rows through a subprocess to answer that would be silly.
 */
export const listForBackfill = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('importRuns').withIndex('by_started').order('desc').take(500);
    return rows.map((r) => ({ kind: r.kind, label: r.label, startedAt: r.startedAt }));
  },
});

/** One run, with its full stage path. */
export const get = query({
  args: { runId: v.id('importRuns') },
  handler: async (ctx, { runId }) => {
    await requireCapability(ctx, 'machinery.read');
    return await ctx.db.get(runId);
  },
});
