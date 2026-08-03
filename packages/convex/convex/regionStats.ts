/**
 * Per-state distribution basis for the derived caption (N6c Workstream A5).
 *
 * One row per state holding the 10th–90th percentiles of depth, elevation, surface area and long
 * axis. See the `regionStats` table comment for why this is deciles-per-state rather than a stored
 * percentile per body.
 *
 * **Recomputed as a consequence of a pass, not as a rider on one** — the deciles are derived *from*
 * the loaded values, so this runs after the canonical re-import and the depth/elevation run, never
 * between them. Running it early is not harmful, just wrong: it would describe the corpus as it was.
 */

import {
  computeDeciles,
  type DecileBlock,
  isKnownStateCode,
  KNOWN_STATE_CODES,
} from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation, internalQuery, query } from './_generated/server';
import { isListed } from './lib/listing';

/** The metrics a caption can compare against. Keep in step with the `regionStats.metrics` object. */
const METRICS = ['maxDepthM', 'meanDepthM', 'elevationM', 'surfaceAreaSqM', 'longAxisM'] as const;
type Metric = (typeof METRICS)[number];

/**
 * One page of the values the recompute accumulates.
 *
 * **Returns raw numbers rather than whole documents** — the action holds every value in memory to
 * sort them, so shipping polygons through would be the difference between a few megabytes and a
 * few hundred. At 116,070 bodies × 5 metrics this is ~4 MB of doubles, which is comfortable.
 *
 * **Unlisted bodies are excluded.** A removed body (a landowner takedown, D48) is not part of the
 * population a skater is comparing against, and leaving it in would let content we have agreed to
 * hide still influence a sentence we render.
 */
export const pageMetricValues = internalQuery({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, batchSize }) => {
    const numItems = Math.min(2000, Math.max(1, batchSize ?? 1000));
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });
    const rows = page.page
      .filter((body) => isListed(body))
      .map((body) => ({
        states: body.states ?? [],
        maxDepthM: body.maxDepthM,
        meanDepthM: body.meanDepthM,
        elevationM: body.elevationM,
        surfaceAreaSqM: body.surfaceAreaSqM,
        longAxisM: body.longAxisM,
      }));
    return { rows, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/** Replace one state's row wholesale. Deciles are derived, so there is nothing to merge. */
export const upsertState = internalMutation({
  args: {
    state: v.string(),
    metrics: v.any(),
    bodiesScanned: v.number(),
  },
  handler: async (ctx, { state, metrics, bodiesScanned }) => {
    const existing = await ctx.db
      .query('regionStats')
      .withIndex('by_state', (q) => q.eq('state', state))
      .unique();
    const doc = { state, metrics, bodiesScanned, updatedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, doc);
    else await ctx.db.insert('regionStats', doc);
  },
});

/**
 * Recompute every state's decile basis from the current corpus.
 *
 * Run after a pass: `pnpm exec convex run regionStats:recompute`.
 *
 * An **action** rather than a mutation because deciles need every value at once to sort, and
 * 116,070 bodies cannot be read inside one transaction (Convex's 4,096-read cap, the N1 lesson).
 * The action pages through `pageMetricValues`, accumulates in memory, and writes one small mutation
 * per state — so the only unbounded thing is the action's own heap, which a few million doubles
 * sits comfortably inside.
 */
export const recompute = internalAction({
  args: { batchSize: v.optional(v.number()), campaignId: v.optional(v.string()) },
  handler: async (ctx, { batchSize, campaignId }) => {
    // Run history (N6c F2). This is the one pass that isn't a script, and it earns a row for the
    // same reason the loaders do: it walks 116,070 bodies, it can die halfway, and the deciles it
    // leaves behind after a partial pass describe a corpus that never existed.
    const runId = await ctx.runMutation(internal.importRuns.start, {
      kind: 'region_stats',
      label: 'regionStats deciles',
      campaignId,
      deployment: process.env.CONVEX_CLOUD_URL ?? 'unknown',
      // An action has no view of which deployment it is: it *is* the deployment. A prod row is
      // therefore identified by its own URL rather than by a `--prod` flag nobody passed.
      isProd: !(process.env.CONVEX_CLOUD_URL ?? '').includes('agile-bee-397'),
      stages: [
        {
          name: 'scan',
          detail:
            'pageMetricValues — raw numbers only, never whole documents; unlisted bodies excluded from the population',
        },
      ],
    });

    // Inline rather than extracted into a helper, deliberately. A helper taking `ActionCtx` and
    // returning an inferred type closes a circle — `ActionCtx` → the generated API → this action's
    // return type → the helper — and TypeScript breaks that circle by degrading `DataModel` to the
    // union of every table, which showed up as ~375 errors in unrelated *test* files and nothing at
    // all here. Annotate the return type or keep it inline; this keeps it inline.
    try {
      // state → metric → values
      const byState = new Map<string, Map<Metric, number[]>>();
      const scanned = new Map<string, number>();

      let cursor: string | undefined;
      let isDone = false;
      let total = 0;
      while (!isDone) {
        const page: {
          rows: Array<{ states: string[] } & Partial<Record<Metric, number>>>;
          cursor: string;
          isDone: boolean;
        } = await ctx.runQuery(internal.regionStats.pageMetricValues, {
          ...(cursor ? { cursor } : {}),
          ...(batchSize ? { batchSize } : {}),
        });
        cursor = page.cursor;
        isDone = page.isDone;
        total += page.rows.length;

        for (const row of page.rows) {
          for (const state of row.states) {
            // Defence in depth against a bad tag reaching the caption as a region name.
            if (!isKnownStateCode(state)) continue;
            scanned.set(state, (scanned.get(state) ?? 0) + 1);
            let metrics = byState.get(state);
            if (!metrics) {
              metrics = new Map();
              byState.set(state, metrics);
            }
            for (const metric of METRICS) {
              const value = row[metric];
              if (typeof value !== 'number') continue;
              const bucket = metrics.get(metric);
              if (bucket) bucket.push(value);
              else metrics.set(metric, [value]);
            }
          }
        }
      }

      const written: Array<{ state: string; bodiesScanned: number; metrics: string[] }> = [];
      for (const state of KNOWN_STATE_CODES) {
        const metrics = byState.get(state);
        if (!metrics) continue;
        const blocks: Partial<Record<Metric, DecileBlock>> = {};
        for (const metric of METRICS) {
          // `computeDeciles` returns null below MIN_DECILE_SAMPLE, and an absent block is what makes
          // the caption stay silent rather than compare against noise.
          const block = computeDeciles(metrics.get(metric) ?? []);
          if (block) blocks[metric] = block;
        }
        const bodiesScanned = scanned.get(state) ?? 0;
        await ctx.runMutation(internal.regionStats.upsertState, {
          state,
          metrics: blocks,
          bodiesScanned,
        });
        written.push({ state, bodiesScanned, metrics: Object.keys(blocks) });
      }

      await ctx.runMutation(internal.importRuns.finish, {
        runId,
        status: 'succeeded',
        counts: [
          { name: 'bodiesRead', value: total },
          { name: 'statesWritten', value: written.length },
          ...written.map((w) => ({ name: `${w.state}.bodiesScanned`, value: w.bodiesScanned })),
        ],
        stages: [
          {
            name: 'write',
            detail: 'one small row per state — deciles are a property of the corpus, not of a body',
            counts: written.map((w) => ({ name: `${w.state}.metrics`, value: w.metrics.length })),
          },
        ],
        // A state whose sample was too thin to produce ANY block is a real finding — its captions will
        // stay silent — and it looks identical to a healthy state if you only count rows written.
        notes: written
          .filter((w) => w.metrics.length < METRICS.length)
          .map(
            (w) =>
              `${w.state}: only ${w.metrics.length}/${METRICS.length} metrics had a large enough sample (${w.metrics.join(', ') || 'none'})`,
          ),
      });

      return { bodiesRead: total, states: written };
    } catch (err) {
      await ctx.runMutation(internal.importRuns.finish, {
        runId,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        notes: ['Partial pass — the deciles on file may describe a corpus slice, not the corpus.'],
      });
      throw err;
    }
  },
});

/**
 * Every state's decile basis, for the clients to hold alongside a lake.
 *
 * Public and unauthenticated: it is five rows of aggregate statistics over public geography, with
 * nothing per-user and nothing per-report in it. Small enough to fetch whole rather than per-state,
 * which keeps the caption a pure function of `(body, basis)` on both clients.
 */
export const list = query({
  args: {},
  handler: async (ctx) => ctx.db.query('regionStats').collect(),
});
