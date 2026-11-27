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
 * Machinery writes through {@link insertRunLines}; the `cap` row by the server alone.
 *
 * **The cap.** A run keeps its first {@link MAX_RUN_EVENTS} lines, of whatever kind. The first line
 * past them makes the run's one `cap` row, always at `seq === MAX_RUN_EVENTS` (so it is found with
 * one `eq`, never a scan), whose `dropped` counts every ordinary line not kept from then on. `close`,
 * `mark`, `wait` and `stop` lines are kept past the cap too: they are few (a run closes once or twice,
 * and the console's lines are a person's presses), and they are the lines the page can't do without.
 */

import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { type RUN_EVENT_KINDS, RUN_EVENT_LOGGER_KINDS } from './lib/enums';
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

type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

/** The kinds kept past the cap: a run's close, and the console's own lines. */
export const RUN_EVENT_ALWAYS_KEPT: readonly RunEventKind[] = ['close', 'mark', 'wait', 'stop'];

/** One line to write: its kind, its words, and the writer's clock when it saw it. */
export type RunLine = { kind: Exclude<RunEventKind, 'cap'>; text: string; loggedAt: number };

/** The cap row's words. */
export const RUN_EVENT_CAP_TEXT =
  "This run's log reached 2,000 lines; later lines are counted, not kept.";

/**
 * A line's words cut to {@link MAX_RUN_EVENT_TEXT} characters, never through a surrogate pair (a cut
 * emoji would store half a character).
 */
export function trimRunEventText(text: string): string {
  if (text.length <= MAX_RUN_EVENT_TEXT) return text;
  const cut = text.slice(0, MAX_RUN_EVENT_TEXT);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * **Write `lines` to `runId`'s log, under the cap** — the one writer of `runEvents`, for the logger's
 * append and the console's writes alike. Reads the run's last row (one `by_run_seq` range, `first()`)
 * for the next `seq`, and the `cap` row (one `eq`) only once the run is past the cap.
 */
export async function insertRunLines(
  ctx: MutationCtx,
  runId: Id<'importRuns'>,
  lines: readonly RunLine[],
  at: number,
): Promise<{ stored: number; dropped: number }> {
  if (lines.length === 0) return { stored: 0, dropped: 0 };
  const last = await ctx.db
    .query('runEvents')
    .withIndex('by_run_seq', (q) => q.eq('runId', runId))
    .order('desc')
    .first();
  let seq = last === null ? 0 : last.seq + 1;
  let cap: Doc<'runEvents'> | null =
    seq > MAX_RUN_EVENTS
      ? await ctx.db
          .query('runEvents')
          .withIndex('by_run_seq', (q) => q.eq('runId', runId).eq('seq', MAX_RUN_EVENTS))
          .unique()
      : null;
  let stored = 0;
  let dropped = 0;
  for (const line of lines) {
    if (seq >= MAX_RUN_EVENTS && cap === null) {
      // The first line past the cap: the run's one cap row, at `seq === MAX_RUN_EVENTS`.
      const id = await ctx.db.insert('runEvents', {
        runId,
        seq,
        at,
        loggedAt: at,
        kind: 'cap',
        text: RUN_EVENT_CAP_TEXT,
        dropped: 0,
      });
      cap = (await ctx.db.get(id)) as Doc<'runEvents'>;
      seq++;
    }
    if (cap !== null && !RUN_EVENT_ALWAYS_KEPT.includes(line.kind)) {
      dropped++;
      continue;
    }
    await ctx.db.insert('runEvents', {
      runId,
      seq,
      at,
      // A clock that isn't a number (NaN from a broken formatter) reads as the server's.
      loggedAt: Number.isFinite(line.loggedAt) ? line.loggedAt : at,
      kind: line.kind,
      text: trimRunEventText(line.text),
    });
    seq++;
    stored++;
  }
  if (cap !== null && dropped > 0) {
    await ctx.db.patch(cap._id, { dropped: (cap.dropped ?? 0) + dropped });
  }
  return { stored, dropped };
}

/**
 * The stop a run should obey, if any: its own request, else its campaign's. Stamps `seenAt` on the
 * request it answers (the first time), so a withdrawal is refused once the run has acted on it.
 */
async function stopDirective(
  ctx: MutationCtx,
  run: Doc<'importRuns'>,
  at: number,
): Promise<boolean> {
  const seen = async (row: Doc<'importRuns'>) => {
    const request = row.stopRequest;
    if (request === undefined) return false;
    if (request.seenAt === undefined) {
      await ctx.db.patch(row._id, { stopRequest: { ...request, seenAt: at } });
    }
    return true;
  };
  if (await seen(run)) return true;
  if (run.parentRunId === undefined) return false;
  const parent = await ctx.db.get(run.parentRunId);
  return parent !== null && (await seen(parent));
}

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
  handler: async (ctx, { runId, events }): Promise<AppendResult> => {
    if (events.length > MAX_RUN_EVENT_APPEND) {
      throw new ConvexError(
        `At most ${MAX_RUN_EVENT_APPEND} log lines can be sent at once; this sent ${events.length}.`,
      );
    }
    const run = await ctx.db.get(runId);
    if (!run) throw new ConvexError(`importRuns row ${runId} not found`);
    const at = Date.now();
    const { stored, dropped } = await insertRunLines(ctx, runId, events, at);
    return {
      stop: await stopDirective(ctx, run, at),
      markedFailed: run.markedFailed !== undefined,
      stored,
      dropped,
    };
  },
});
