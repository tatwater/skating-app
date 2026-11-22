/**
 * **Is an unmerge still running on this body?** (B01-5d, R10-A) — the one reader every merge asks
 * before it offers or runs (`waterBodies.mergePairRefusal`, for both bodies of a pair: `merge`,
 * `inboxWrites.mergeDrawn`, the Shape tab's preview, the Drawn item's `can.mergeDrawn`), and the
 * unmerge's receipt and resume read.
 *
 * An unmerge pages across transactions (`convex/unmerge.ts`): its first page makes the loser live
 * again, and its later pages move the rest back from the survivor. A body merged again in between
 * would strand those rows on the survivor for good, so the unmerge marks **both** bodies
 * (`waterBodies.unmergeActionId`, set by its first transaction, cleared by its last) and neither takes
 * a merge until it is done. A read of the body document every merge path already holds: no index, no
 * bound, both roles.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

/** The sentence every merge of a body mid-unmerge is refused with. */
export const UNMERGING_REFUSAL = 'This body is still being unmerged. Merge it once that finishes.';

/** The unmerge's row still running on this body (as loser or survivor), or `null` when none is. */
export function unmergeRunningOn(
  body: Pick<Doc<'waterBodies'>, 'unmergeActionId'>,
): Id<'moderationActions'> | null {
  return body.unmergeActionId ?? null;
}

/** {@link unmergeRunningOn} by id, for a caller without the document; a body gone runs none. */
export async function unmergeRunningOnId(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
): Promise<Id<'moderationActions'> | null> {
  const body = await ctx.db.get(waterBodyId);
  return body ? unmergeRunningOn(body) : null;
}
