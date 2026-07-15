/**
 * Shared pure helper for the map lake-search box (Phase 2.5). Kept in core so both apps gate the
 * `waterBodies.searchByName` query identically, without a Convex/router harness.
 */

export type LakeSearchArgs = { query: string; limit: number }

/**
 * The `waterBodies.searchByName` argument for the current raw input — or the Convex `'skip'`
 * token when the trimmed input is under the 2-char floor (don't issue a pointless index scan on
 * an empty/one-char box).
 */
export function searchQueryArg(raw: string, limit = 8): LakeSearchArgs | 'skip' {
  const query = raw.trim()
  return query.length >= 2 ? { query, limit } : 'skip'
}
