/**
 * **A run's log, line by line** (D341, B01-8a): the `runEvents` table's writer for the run logger.
 *
 * The logger (`scripts/run-log`) buffers a line for each call it already receives — start, stages,
 * the counts at each flush, failures, beats, close — and sends the buffer here at each flush, after
 * `importRuns:progress`, through the same admin-credentialed `pnpm exec convex run` channel. Its
 * answer carries the console's directives back to the laptop: whether the run (or its campaign) was
 * asked to stop, and whether it was marked failed.
 *
 * A separate function rather than a widened `progress`, so an older deployment refuses only the
 * lines, never the counts. The console's own lines (`mark`, `wait`, `stop`) are written by the
 * Machinery writes; the `cap` row by the server alone.
 *
 * PLACEHOLDER (B01-8a T0): the contract is the seam; the body is S1's.
 */

import { ConvexError, v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { RUN_EVENT_LOGGER_KINDS } from './lib/enums';
import { literals } from './lib/validators';

/** The ordinary lines a run keeps; past it, one `cap` row counts the rest. */
export const MAX_RUN_EVENTS = 2_000;
/** A line's length, trimmed by the server. */
export const MAX_RUN_EVENT_TEXT = 500;
/** The lines one append may carry; the argument is refused beyond. */
export const MAX_RUN_EVENT_APPEND = 200;

/** What `append` tells the logger. */
export type AppendResult = {
  /** The run, or its parent campaign, was asked to stop (stamps `stopRequest.seenAt`). */
  stop: boolean;
  markedFailed: boolean;
  stored: number;
  /** Past `MAX_RUN_EVENTS`; counted on the run's `cap` row. */
  dropped: number;
};

export const append = internalMutation({
  args: {
    runId: v.id('importRuns'),
    // At most MAX_RUN_EVENT_APPEND (200); refused beyond.
    events: v.array(
      v.object({
        kind: literals(RUN_EVENT_LOGGER_KINDS),
        text: v.string(),
        loggedAt: v.number(),
      }),
    ),
  },
  returns: v.object({
    stop: v.boolean(),
    markedFailed: v.boolean(),
    stored: v.number(),
    dropped: v.number(),
  }),
  handler: async (_ctx, _args): Promise<AppendResult> => {
    // PLACEHOLDER (B01-8a T0): S1 writes the append.
    throw new ConvexError('runEvents.append is not built yet');
  },
});
