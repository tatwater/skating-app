/**
 * Auto-flag bundling (N2) — one row per recurring problem, carrying a count, instead of a stream of
 * identical rows.
 *
 * Two callers file system-generated flags: `ratings.maybeAutoFlag` (a target crossed the
 * net-unhelpful threshold, D50) and `contradictions.flagContradictionPattern` (a contributor crossed
 * the weather-unexplained contradiction threshold, D56 §7b). Both had the identical dedup — *one open
 * flag per (target, reason)* — written out twice, with `contradictions.ts` saying so in its own
 * comment. So the mechanism belongs on `contentFlags`, not in either caller.
 *
 * **The trap this had to avoid.** The obvious implementation is to reopen the resolved flag: flip
 * `status` back to `open` and bump a counter. That would corrupt a Phase-7b rollup.
 * `contentFlags.by_status_resolved_at` was built on the stated premise that *"`actioned`/`dismissed`
 * accumulate forever"* — the day-sliced flag-resolution chart reads terminal rows in a date range, so
 * flipping one back out of `actioned` retroactively changes a past day's count. A number that was
 * true when it was computed silently becomes false. Terminal rows are therefore **never** patched:
 * a recurrence after a resolution files a *new* row that carries the running count forward and points
 * back with `supersedesFlagId`.
 *
 * What a moderator gets is the thing a stream of identical rows was hiding: "4th occurrence · last
 * dismissed 6d ago", which is the actual input to the D57 posting-permission decision.
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { FLAG_REASONS, FLAG_TARGET_TYPES } from './enums';

type FlagTargetType = (typeof FLAG_TARGET_TYPES)[number];
type FlagReason = (typeof FLAG_REASONS)[number];

/**
 * How long after a resolution a fresh occurrence still counts as *the same problem recurring* rather
 * than a new one.
 *
 * 30 days is an opening number, and it belongs in the control room next to the chart that would say
 * whether it's right (the repeat-flag interval distribution). Too short and a chronic contributor
 * looks like a series of first offences; too long and someone who genuinely corrected course carries
 * a count forward from last season.
 */
export const AUTO_FLAG_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Occurrence counts at which the D38 operator alert re-fires.
 *
 * The point of bundling is that a recurrence does *not* email the founder every time — that's the
 * noise it exists to remove. But silence forever is the opposite failure: a contributor quietly
 * accumulating occurrences behind an already-open flag is exactly who the D57 lever is for. So the
 * alert fires on the first occurrence and then at widening intervals.
 */
export function shouldAlertAt(occurrences: number): boolean {
  return occurrences === 1 || occurrences === 3 || occurrences % 10 === 0;
}

/**
 * Terminal rows probed per status when looking for the most recent disposition.
 *
 * The index orders by creation, and the question is about *resolution* time — usually the same
 * order, not necessarily. A handful from each terminal status, picked over by `resolvedAt`, makes the
 * answer right without turning a decision into an unbounded read. Nothing is silently dropped: a row
 * older than these was, by construction, created before ten more recent dispositions of the same
 * kind, and the cooldown question it would answer is already answered by them.
 */
const TERMINAL_PROBE = 10;

export interface AutoFlagResult {
  flagId: Id<'contentFlags'>;
  /** How many times this problem has now been recorded, across superseding rows. */
  occurrences: number;
  /** True when a *new* row was filed (fresh problem, or a recurrence after a resolution). */
  filed: boolean;
  /** Set when this row carries a count forward from a resolved predecessor. */
  supersededFlagId?: Id<'contentFlags'>;
  /** Whether the caller should raise the D38 operator alert for this occurrence. */
  alert: boolean;
}

/**
 * File a system-generated flag, or bump the one that's already tracking this problem.
 *
 * Three outcomes, in the order they're checked:
 *  1. an **open** flag for this `(target, reason)` → bump its `occurrences` and `lastOccurrenceAt`;
 *  2. the most recent prior is **resolved** and inside the cooldown → file a new row carrying the
 *     count forward, with `supersedesFlagId` set. **The resolved row is not touched.**
 *  3. otherwise → a fresh row at `occurrences: 1`.
 */
export async function fileOrBumpAutoFlag(
  ctx: MutationCtx,
  args: {
    targetType: FlagTargetType;
    targetId: string;
    reason: FlagReason;
    /** Whose action crossed the line — `reason`/`note` are what mark the row system-generated. */
    flaggerId: Id<'profiles'>;
    note?: string;
    now?: number;
    cooldownMs?: number;
    /**
     * Does this call represent a **distinct** recurrence of the problem, or just the same one being
     * re-observed? Default `true`, which is right for an event-shaped caller like the contradiction
     * settle. `false` means "file a flag if there isn't one, but don't count this against an open
     * row" — the shape a *state*-shaped caller needs, where the same underlying situation can be
     * re-evaluated many times.
     *
     * `ratings.maybeAutoFlag` is that caller and the reason this argument exists: it runs on every
     * verdict change to `unhelpful`, so one rater flipping helpful↔unhelpful would otherwise bump the
     * count on each flip. `occurrences` is the number a moderator reads to judge the D57 lever, so a
     * user being able to inflate it about someone else's content is the whole problem. Counting only
     * a rater's *first* unhelpful makes the number mean "how many people pushed this over the line".
     */
    countsAsOccurrence?: boolean;
  },
): Promise<AutoFlagResult> {
  const now = args.now ?? Date.now();
  const cooldown = args.cooldownMs ?? AUTO_FLAG_COOLDOWN_MS;
  const countsAsOccurrence = args.countsAsOccurrence ?? true;

  /** The (target, reason) slice of one status, in index order — the read both halves are built on. */
  const byStatus = (status: 'open' | 'reviewing' | 'actioned' | 'dismissed') =>
    ctx.db
      .query('contentFlags')
      .withIndex('by_target_status_reason', (q) =>
        q
          .eq('targetType', args.targetType)
          .eq('targetId', args.targetId)
          .eq('status', status)
          .eq('reason', args.reason),
      );

  // **Read by status, not by scanning the target's history.** This used to be a 100-row cap over
  // `by_target` filtered in JS, which is the one shape `lib/scan.ts` warns about: the cap decided
  // whether to bump or file, and terminal rows bury the open one from whichever end you scan. The
  // schema note on `by_target_status_reason` has the full argument.
  //
  // `.first()` takes the *oldest* open row, deliberately: it's the one that has been accumulating the
  // count, so the bump stays on a stable row rather than hopping to whichever was filed last.
  const open = (await byStatus('open').first()) ?? (await byStatus('reviewing').first());
  if (open) {
    const occurrences = open.occurrences ?? 1;
    // Already tracked, and this isn't a new occurrence: leave the row exactly as it is. No patch at
    // all, so a re-observation can't even move `lastOccurrenceAt` — the same no-op the pre-bundling
    // `if (existing) return` had.
    if (!countsAsOccurrence) {
      return { flagId: open._id, occurrences, filed: false, alert: false };
    }
    const bumped = occurrences + 1;
    await ctx.db.patch(open._id, { occurrences: bumped, lastOccurrenceAt: now });
    return { flagId: open._id, occurrences: bumped, filed: false, alert: shouldAlertAt(bumped) };
  }

  // Newest terminal row wins: the count follows the most recent disposition, not the oldest one.
  // Each terminal status is probed newest-first and the two candidate sets picked over by
  // `resolvedAt`, because the index orders by creation and the question is about resolution — nearly
  // always the same order, and this doesn't rely on it being so.
  const terminal = (
    await Promise.all(
      (['actioned', 'dismissed'] as const).map((status) =>
        byStatus(status).order('desc').take(TERMINAL_PROBE),
      ),
    )
  ).flat();
  const resolved = terminal.sort(
    (a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt),
  )[0];
  const recent = resolved && now - (resolved.resolvedAt ?? resolved.createdAt) <= cooldown;
  const occurrences = recent ? (resolved.occurrences ?? 1) + 1 : 1;

  const flagId = await ctx.db.insert('contentFlags', {
    flaggerId: args.flaggerId,
    targetType: args.targetType,
    targetId: args.targetId,
    reason: args.reason,
    ...(args.note !== undefined ? { note: args.note } : {}),
    status: 'open',
    occurrences,
    lastOccurrenceAt: now,
    ...(recent && resolved ? { supersedesFlagId: resolved._id } : {}),
    createdAt: now,
  });
  return {
    flagId,
    occurrences,
    filed: true,
    ...(recent && resolved ? { supersededFlagId: resolved._id } : {}),
    alert: shouldAlertAt(occurrences),
  };
}
