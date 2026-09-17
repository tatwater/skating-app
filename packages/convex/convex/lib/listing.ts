/**
 * `listed` — **is this body reachable at all?** (D48/D5, re-scoped by A07b.)
 *
 * A listed body has rows in the cell index (`./cellIndex`), can be opened by id, and can be resolved
 * from a coordinate — by the map at some zoom, by a tap, by a recorded track. It is the predicate for
 * *existence on the map*, and since A07b it is deliberately **not** the predicate for *being pushed*:
 * that is `isActive` (`@skating/core`'s `standing.ts`), which every notification, digest, discovery
 * card, recommended strip and enrichment pass gates on instead.
 *
 * A body is **listed unless** reads must not reach it:
 *  - `reviewStatus === 'rejected'` — a moderator rejected a user-drawn body (D37).
 *  - `dedupStatus === 'merged'` — it lost a dedup merge; reads follow the survivor (D36).
 *
 * **`removedAt` no longer unlists** (founder call, 2026-09-16). A removed body — a landowner takedown,
 * a curation call — draws at the dormant rung (z16, dimmed, with the reason in the drawer), is absent
 * from search and from every push surface, and *is* found by someone standing on it. That last
 * property is why: the landowner skating their own pond, or a resident of a private lake, records a
 * track — and it must attach to the row that carries the takedown rather than mint a fresh public
 * body over it (D48's deferred edge (a), closed).
 *
 * Kept as a pure helper (no `ctx`) so `importCanonical` can re-derive it on re-import.
 */

import { isReachable } from '@skating/core';
import type { DEDUP_STATUSES, REVIEW_STATUSES } from './enums';

type ReviewStatus = (typeof REVIEW_STATUSES)[number];
type DedupStatus = (typeof DEDUP_STATUSES)[number];

/** The subset of a `waterBodies` doc that listing is derived from. */
export interface ListableBody {
  reviewStatus?: ReviewStatus;
  dedupStatus: DedupStatus;
  /** Accepted and ignored — a removed body is listed (A07b). Here so `{ ...body, removedAt }` typechecks. */
  removedAt?: number;
}

/** Whether a water body is reachable — cell-indexed, openable, coordinate-resolvable (D48/A07b). */
export function isListed(body: ListableBody): boolean {
  return isReachable(body);
}
