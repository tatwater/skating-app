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
import { takeCapped } from './scan';

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

/** Flags on one target that a bundling decision has to look at. Bounded: this is per-target. */
const TARGET_FLAG_SCAN_CAP = 100;

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
  },
): Promise<AutoFlagResult> {
  const now = args.now ?? Date.now();
  const cooldown = args.cooldownMs ?? AUTO_FLAG_COOLDOWN_MS;

  // Scoped to one target by the index, so this is a fact about that row rather than about the
  // corpus; capped anyway, because a much-flagged target is exactly where an unbounded read would
  // first bite. `takeCapped`'s `cap + 1` probe matters here: this scan *decides* whether to bump or
  // file, so "exactly the cap" being misread as truncated would file a duplicate.
  const priors = (
    await takeCapped(
      ctx.db
        .query('contentFlags')
        .withIndex('by_target', (q) =>
          q.eq('targetType', args.targetType).eq('targetId', args.targetId),
        ),
      TARGET_FLAG_SCAN_CAP,
      `autoFlag(${args.targetType}:${args.targetId})`,
    )
  ).filter((flag) => flag.reason === args.reason);

  const open = priors.find((flag) => flag.status === 'open' || flag.status === 'reviewing');
  if (open) {
    const occurrences = (open.occurrences ?? 1) + 1;
    await ctx.db.patch(open._id, { occurrences, lastOccurrenceAt: now });
    return { flagId: open._id, occurrences, filed: false, alert: shouldAlertAt(occurrences) };
  }

  // Newest terminal row wins: the count follows the most recent disposition, not the oldest one.
  const resolved = priors
    .filter((flag) => flag.status === 'actioned' || flag.status === 'dismissed')
    .sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt))[0];
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
