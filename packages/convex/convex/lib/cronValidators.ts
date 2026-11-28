/**
 * Validators for a chained cron run (D349, B01-8c) — shared by `schema.ts` (`cronRuns.chain`,
 * `cronRuns.causes`) and `cronRuns.chainStep`'s arguments, so a stored shape and an argument shape
 * cannot drift apart. Each mirrors its core type field for field.
 */

import { v } from 'convex/values';
import { CRON_FAILURE_CAUSES } from './enums';
import { literals } from './validators';

/** Core's `ChainState`: a run that continues past its tick. */
export const cronChain = v.object({
  /** Branches still running; 0 = closed. */
  open: v.number(),
  /** Batches reported so far. */
  steps: v.number(),
  /** The last step's end. */
  progressAt: v.number(),
  /** Lines kept so far (the cap's counter, core's `CHAIN_LINES_MAX`). */
  lines: v.number(),
  linesDropped: v.optional(v.number()),
});

/**
 * Core's `CronCauseTally`: one cause, its count and its first sample. `sampleKey` is a cell key, a
 * state code or a hazard id — never content; `sampleText` is trimmed to core's
 * `CRON_CAUSE_SAMPLE_MAX`.
 */
export const cronCauseTally = v.object({
  cause: literals(CRON_FAILURE_CAUSES),
  count: v.number(),
  sampleKey: v.optional(v.string()),
  sampleText: v.string(),
  sampleAt: v.number(),
});

/** Core's `CronReportLine`: one line of a cron run's log. */
export const cronReportLine = v.object({
  kind: literals(['line', 'warn', 'fail', 'stage'] as const),
  text: v.string(),
  loggedAt: v.number(),
});
