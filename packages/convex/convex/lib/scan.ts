/**
 * Bounded scans (N1) — the one way this codebase reads "all the rows matching X".
 *
 * `.collect()` reads however many rows exist. That's correct and cheap when the index scopes it to
 * one user or one report, and it's a latent crash when the set grows with the corpus: Convex caps a
 * function at 4,096 document reads, and passing that is an error, not a slow page. The read path
 * learned this twice (PRs #10/#11) before N1 replaced the mechanism outright.
 *
 * `takeCapped` is for the middle case — a set that *should* be small, but whose size isn't
 * structurally guaranteed. It bounds the read and **says so when it bites**, because the failure
 * this exists to prevent isn't slowness, it's a query quietly returning a subset that reads like the
 * whole answer (D5: truncation is logged, never silent).
 *
 * When truncation would be a *wrong answer* rather than a partial one — notification fan-out, a
 * migration — page instead: `paginate()` with a cursor, self-continuing. See
 * `notifications.fanOutNearbyNotifications` and `waterBodies.backfillCells` for that shape.
 */

/**
 * **The triage (N1, 2026-07-26).** Every `.collect()` in `convex/` was reviewed. What's left is
 * scoped by an index to one entity, so its size is a fact about *that* row, not about the corpus:
 *
 *  - *per viewer* — `blocks` (both directions), `waterBodyFavorites`, `activityConnections`;
 *  - *per water body* — `hazards`, `bodyFeatures`, `putIns`, that body's favorites, its open
 *    bounties, and (≤ 4 rows by construction) its `waterBodyCells`;
 *  - *per report / per hazard* — `comments`, `hazardConfirmations`;
 *  - *per requester* — their open bounties.
 *
 * Three of those could in principle grow past comfort and are knowingly left alone, because a cap
 * would change an answer rather than a cost: a viral report's comment thread, a much-confirmed
 * hazard's confirmation list, and `waterBodies.merge` repointing every report/hazard/bounty from the
 * loser body (rare, admin-only, and a duplicate body has few rows by definition — a partial merge
 * would be worse than a slow one). Revisit if any of them ever shows up in a read-limit error.
 */

/** Read at most `cap` rows, logging (never silently) when the cap is what stopped us. */
export async function takeCapped<T>(
  query: { take(n: number): Promise<T[]> },
  cap: number,
  what: string,
): Promise<T[]> {
  const rows = await query.take(cap);
  if (rows.length === cap) {
    console.warn(`${what}: hit the ${cap}-row scan cap — results are truncated (D5/N1).`);
  }
  return rows;
}
