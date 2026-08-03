/**
 * ETL run history (N6c Workstream F2) — the durable home for the summary every loader used to
 * print to a terminal that scrolls.
 *
 * The write path is **internal only** and is called by the loaders under `scripts/` through
 * `pnpm exec convex run`, the same admin-credentialed channel `importCanonical` uses. The read path
 * is admin-gated: a run row names source URLs, deployment targets and file checksums, which is
 * operator detail rather than anything a skater has a reason to see.
 *
 * See the `importRuns` table comment in `schema.ts` for the shape and why it is one row per run.
 */

import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalMutation, internalQuery, query } from './_generated/server';
import { requireRole } from './lib/auth';
import { IMPORT_RUN_KINDS } from './lib/enums';
import { literals } from './lib/validators';

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
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('importRuns', {
      kind: args.kind,
      label: args.label,
      campaignId: args.campaignId,
      deployment: args.deployment,
      isProd: args.isProd,
      status: 'running',
      startedAt: Date.now(),
      counts: [],
      stages: args.stages ?? [],
      failures: [],
      failuresTotal: 0,
      notes: args.notes,
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
    await ctx.db.patch(runId, patch);
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
  },
  handler: async (
    ctx,
    { runId, status, counts, stages, failures, failuresTotal, coverage, error, notes },
  ) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error(`importRuns row ${runId} not found`);
    await ctx.db.patch(runId, {
      ...mergeInto(run, { counts, stages, failures, failuresTotal, coverage }),
      status,
      finishedAt: Date.now(),
      error,
      notes: notes ?? run.notes,
    });
  },
});

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
    await ctx.db.patch(runId, { startedAt, finishedAt });
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
    await requireRole(ctx, 'admin');
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
    await requireRole(ctx, 'admin');
    return await ctx.db.get(runId);
  },
});
