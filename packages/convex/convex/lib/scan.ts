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
 *
 * **A cap is only as good as the scan order it caps.** This helper bounds the read and logs it, but
 * it can't know which end of the index the caller needs — `take(n)` keeps the rows the index reaches
 * first, which is ascending unless you say otherwise. Three of N1's own caps got that wrong before
 * review caught them: the bounty freshness gate kept the *oldest* reports when it wanted the newest
 * (fixed with `.order('desc')`), and the hazard-weather cron re-read one fixed prefix every tick so
 * the backlog behind it never refreshed (fixed with an index whose order rotates as rows are
 * processed). Before capping a scan, say which end matters and check the index runs that way.
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

/**
 * Read at most `cap` rows, and say whether the cap is what stopped us.
 *
 * It asks for `cap + 1` and returns `cap`. Without that extra row, "I got exactly `cap`" is
 * ambiguous — it means *either* the set is exactly that size *or* there's more behind it — and every
 * caller has to guess. Guessing "truncated" cries wolf on a complete answer; guessing "complete"
 * hides a real truncation, which is the failure this module exists to prevent. One row buys the
 * distinction outright (Greptile PR #27).
 *
 * That matters most where the flag decides something rather than just logging: `bounties`
 * `evaluateFreshness` blocks a bounty when its scan saturates, so reading the boundary case as
 * truncated would reject perfectly valid requests on a body with exactly `cap` reports.
 */
export async function takeCappedResult<T>(
  query: { take(n: number): Promise<T[]> },
  cap: number,
  what: string,
): Promise<{ rows: T[]; truncated: boolean }> {
  const probed = await query.take(cap + 1);
  const truncated = probed.length > cap;
  if (truncated) {
    console.warn(`${what}: hit the ${cap}-row scan cap — results are truncated (D5/N1).`);
  }
  return { rows: truncated ? probed.slice(0, cap) : probed, truncated };
}

/** {@link takeCappedResult} for the callers that only need the rows. */
export async function takeCapped<T>(
  query: { take(n: number): Promise<T[]> },
  cap: number,
  what: string,
): Promise<T[]> {
  return (await takeCappedResult(query, cap, what)).rows;
}
