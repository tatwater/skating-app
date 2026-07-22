/**
 * Denormalized contribution counters (`profiles.reportCount` / `commentCount`).
 *
 * A public profile shows the true number of an author's currently-**visible** reports/comments (D13).
 * Counting them on the read path would `.collect()` an author's whole history, so instead we keep a
 * denormalized counter and adjust it by ±1 on every state transition that changes visibility:
 *   - create a report/comment (born `visible`) → +1
 *   - a moderator hide/remove, or an author self-remove, of a `visible` item → −1
 *   - a moderator restore back to `visible` → +1
 *
 * The delta is driven by `visibleDelta`, which compares the before/after `moderationStatus`, so a
 * no-op transition (visible→visible, hidden→removed) correctly moves the counter by 0. Counters are
 * clamped at 0 so a legacy row that predates the counter (undefined → treated as 0) can never go
 * negative — `backfillContributionCounts` seeds real values once, after which every path stays exact.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/** Which profile counter a target type feeds. */
export type ContributionField = 'reportCount' | 'commentCount';

/** A moderation status counts toward the public total only when it's `visible`. */
function isVisible(status: Doc<'reports'>['moderationStatus']): boolean {
  return status === 'visible';
}

/**
 * The counter delta for a moderation-status transition: +1 when it becomes visible, −1 when it leaves
 * visible, 0 otherwise. Pure — the single source of truth for both the create and moderation paths.
 */
export function visibleDelta(
  prior: Doc<'reports'>['moderationStatus'] | undefined,
  next: Doc<'reports'>['moderationStatus'],
): number {
  return Number(isVisible(next)) - Number(prior !== undefined && isVisible(prior));
}

/** Adjust an author's contribution counter by `delta`, clamped at 0. A missing author is a no-op. */
export async function bumpContributionCount(
  ctx: MutationCtx,
  authorId: Id<'profiles'>,
  field: ContributionField,
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  const author = await ctx.db.get(authorId);
  if (!author) return;
  const current = author[field] ?? 0;
  await ctx.db.patch(authorId, { [field]: Math.max(0, current + delta) });
}
