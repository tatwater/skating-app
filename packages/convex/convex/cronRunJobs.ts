/**
 * **The cron backbone's own jobs** (D343, D347, B01-8b).
 *
 * - `prune` — the retention sweep, itself a registered cron (daily, recorded like any other): each
 *   backbone table's `by_keep_until` range below now (`cronTicks`, `cronRuns`, and the cron lines of
 *   `runEvents`, read with `gt('keepUntil', 0)` as the floor, since an import run's lines carry none
 *   and must never be swept), {@link PRUNE_PAGE} deletes a pass, one table a pass, self-continuing.
 *   It reads the front of the due range each pass (a deleted row leaves it), so it needs no cursor
 *   and paginates nothing.
 * - `copyImageryRuns` — the one-shot backfill carrying `imageryRuns`' history into `cronRuns` under
 *   each row's cron name, so a cron's runs drawer begins where the Seasons panel's did. Dry run
 *   first; {@link COPY_PAGE} rows a pass (one `.paginate()`), self-continuing, its totals carried
 *   and logged at the end; idempotent by `cronRuns.copiedFrom` (a copy is looked for among the
 *   job's runs at the same start, one `eq`, `eq` range).
 */

import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalMutation } from './_generated/server';
import { SEASON_CRON_RETENTION } from './cronJobs';
import { IMAGERY_CRON_JOBS } from './imageryLive';
import { literals } from './lib/validators';

const DAY_MS = 86_400_000;

/** Rows a prune pass deletes: each delete reads its row (a range), so 500 is ~500 of 4,096. */
export const PRUNE_PAGE = 500;
/** Rows a copy pass reads: each also reads the job's runs at its start, one small range. */
export const COPY_PAGE = 100;

/** The tables `prune` sweeps, in the order it sweeps them. */
export const PRUNED_TABLES = ['cronTicks', 'cronRuns', 'runEvents'] as const;
type PrunedTable = (typeof PRUNED_TABLES)[number];

/** What a prune pass did. */
export type PruneResult = {
  deleted: number;
  more: boolean;
  /** The recorder's report: a pass that deleted something did work. */
  cronReport: { worked: boolean; counts: Record<string, number> };
};

/** What a copy pass did (or, on a dry run, would do). */
export type CopyImageryRunsResult = {
  dryRun: boolean;
  /** Rows copied this pass (a dry run: rows it would copy). */
  copied: number;
  /** Rows already in `cronRuns` (`copiedFrom`), skipped. */
  alreadyCopied: number;
  /** `skipped` rows (a poll that wasn't runnable): quiet ticks, never runs, so not copied. */
  quiet: number;
  more: boolean;
};

export const prune = internalMutation({
  args: { table: v.optional(literals(PRUNED_TABLES)) },
  handler: async (ctx, args): Promise<PruneResult> => {
    const table: PrunedTable = args.table ?? 'cronTicks';
    const now = Date.now();
    const due = await ctx.db
      .query(table)
      .withIndex('by_keep_until', (q) => q.gt('keepUntil', 0).lt('keepUntil', now))
      .take(PRUNE_PAGE);
    for (const row of due) await ctx.db.delete(row._id);
    const full = due.length === PRUNE_PAGE;
    const next = PRUNED_TABLES[PRUNED_TABLES.indexOf(table) + 1];
    if (full) await ctx.scheduler.runAfter(0, internal.cronRunJobs.prune, { table });
    else if (next !== undefined) {
      await ctx.scheduler.runAfter(0, internal.cronRunJobs.prune, { table: next });
    }
    return {
      deleted: due.length,
      more: full || next !== undefined,
      cronReport: { worked: due.length > 0, counts: { [table]: due.length } },
    };
  },
});

const totalsValidator = v.object({
  copied: v.number(),
  alreadyCopied: v.number(),
  quiet: v.number(),
});

/** An `imageryRuns` row as the cron run it was. */
function copyOf(
  row: Doc<'imageryRuns'>,
  outcome: Exclude<Doc<'imageryRuns'>['outcome'], 'skipped'>,
) {
  return {
    job: IMAGERY_CRON_JOBS[row.kind],
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? row.startedAt,
    outcome,
    trigger: 'cron' as const,
    season: row.season,
    ...(row.detail !== undefined ? { detail: row.detail } : {}),
    ...(row.counts !== undefined ? { counts: row.counts } : {}),
    copiedFrom: row._id,
    keepUntil: row.startedAt + SEASON_CRON_RETENTION.runDays * DAY_MS,
  };
}

export const copyImageryRuns = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    /** The passes before this one, carried so the last pass can log the whole. */
    totals: v.optional(totalsValidator),
  },
  handler: async (ctx, args): Promise<CopyImageryRunsResult> => {
    const dryRun = args.dryRun ?? false;
    const page = await ctx.db
      .query('imageryRuns')
      .withIndex('by_started')
      .paginate({ cursor: args.cursor ?? null, numItems: COPY_PAGE });
    let copied = 0;
    let alreadyCopied = 0;
    let quiet = 0;
    for (const row of page.page) {
      if (row.outcome === 'skipped') {
        quiet++;
        continue;
      }
      const job = IMAGERY_CRON_JOBS[row.kind];
      const same = await ctx.db
        .query('cronRuns')
        .withIndex('by_job_started', (q) => q.eq('job', job).eq('startedAt', row.startedAt))
        .take(16);
      if (same.some((r) => r.copiedFrom === row._id)) {
        alreadyCopied++;
        continue;
      }
      if (!dryRun) await ctx.db.insert('cronRuns', copyOf(row, row.outcome));
      copied++;
    }
    const totals = {
      copied: (args.totals?.copied ?? 0) + copied,
      alreadyCopied: (args.totals?.alreadyCopied ?? 0) + alreadyCopied,
      quiet: (args.totals?.quiet ?? 0) + quiet,
    };
    const more = !page.isDone;
    if (more) {
      await ctx.scheduler.runAfter(0, internal.cronRunJobs.copyImageryRuns, {
        dryRun,
        cursor: page.continueCursor,
        totals,
      });
    } else {
      const verb = dryRun ? 'would copy' : 'copied';
      console.log(
        `copyImageryRuns${dryRun ? ' (dry run)' : ''}: ${verb} ${totals.copied}, already copied ${totals.alreadyCopied}, quiet (not copied) ${totals.quiet}`,
      );
    }
    return { dryRun, copied, alreadyCopied, quiet, more };
  },
});
