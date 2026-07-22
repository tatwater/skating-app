/**
 * `listed` — the derived boolean that decides whether a water body appears on the public
 * map (D48/D5). It's the `@convex-dev/geospatial` filter key (see `./geospatial`), set at
 * import / `create` / `approve` / `reject` / `remove`, and queried by
 * `waterBodies.listInViewport` (`listed == true`).
 *
 * A body is **listed unless** it's explicitly suppressed:
 *  - `reviewStatus === 'rejected'` — a moderator rejected a user-drawn body (D37).
 *  - `dedupStatus === 'merged'` — it lost a dedup merge; reads follow the survivor (D36).
 *  - `removedAt` set — an admin soft-delisted it (curation / landowner takedown, D48).
 *
 * So canonical (`osm`/`nhd`) bodies — which carry no `reviewStatus` — and auto-visible
 * `pending` / `approved` user bodies are all listed (the D37 auto-visible-then-review rule).
 * Kept as a pure helper (no `ctx`) so `importCanonical` can re-derive it on re-import while
 * preserving a removed state, rather than resurrecting a takedown.
 */

import type { DEDUP_STATUSES, REVIEW_STATUSES } from './enums';

type ReviewStatus = (typeof REVIEW_STATUSES)[number];
type DedupStatus = (typeof DEDUP_STATUSES)[number];

/** The subset of a `waterBodies` doc that listing is derived from. */
export interface ListableBody {
  reviewStatus?: ReviewStatus;
  dedupStatus: DedupStatus;
  removedAt?: number;
}

/** Whether a water body shows on the public map — the derived geospatial filter key (D48). */
export function isListed(body: ListableBody): boolean {
  return (
    body.reviewStatus !== 'rejected' &&
    body.dedupStatus !== 'merged' &&
    body.removedAt === undefined
  );
}
