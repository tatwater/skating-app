/**
 * Report/comment visibility resolution (D13) and default-visibility derivation
 * (D41). This is safety- and privacy-sensitive logic — a bug here can leak a
 * private spot — so it's covered by both example and property tests.
 *
 * There is **no social graph** (D13, revised 2026-07-15): reports are either `just_me`
 * (author only) or `public` (everyone). The only relationship that narrows access is a
 * **block** (D32). Defaults derive from the author's **minor status** (D41): adults
 * default to `public`, minors are pinned to `just_me`.
 */

import type { Visibility } from './types'

/**
 * The viewer's relationship to the author. With the social graph removed (D13), the only
 * dimension left is whether a **block** exists in either direction (D32). Blocks land in
 * Phase 3; until then callers pass `{ blocked: false }`.
 */
export interface ViewerRelationship {
  blocked: boolean
}

/**
 * Can `viewerId` see a report authored by `authorId` at the given visibility?
 *
 * Rules (D13):
 * - The author always sees their own content (even `just_me`, and regardless of blocks).
 * - A block in either direction hides everything between the two users (D32).
 * - `public` → anyone · `just_me` → only the author.
 */
export function canViewReport(
  viewerId: string,
  authorId: string,
  visibility: Visibility,
  rel: ViewerRelationship,
): boolean {
  if (viewerId === authorId) return true
  if (rel.blocked) return false

  const allowed: Record<Visibility, boolean> = {
    public: true,
    just_me: false,
  }
  return allowed[visibility]
}

/**
 * Comment visibility inherits its parent report — never wider (D21). A comment is
 * viewable exactly when its parent report is.
 */
export function canViewComment(
  viewerId: string,
  reportAuthorId: string,
  reportVisibility: Visibility,
  rel: ViewerRelationship,
): boolean {
  return canViewReport(viewerId, reportAuthorId, reportVisibility, rel)
}

export interface DefaultVisibilityInput {
  /**
   * Whether the author is a minor (<18, D41), derived from their stored DOB. This is the sole
   * input: report defaults derive from age, not from profile privacy (which is an independent
   * setting, D13). Consistent with how the age gate is computed everywhere (`isMinor`).
   */
  isMinor: boolean
}

/**
 * The pre-selected default visibility for a new report (D41):
 * adult → `public` (cold-start + the community good); minor → `just_me`.
 *
 * Derived from minor status (from the stored DOB), recomputed at read time like the age gate — so
 * at 18 the `public` option simply becomes available for *future* reports; nothing already posted
 * is silently widened.
 */
export function deriveDefaultVisibility(input: DefaultVisibilityInput): Visibility {
  return input.isMinor ? 'just_me' : 'public'
}

/**
 * The **widest** visibility an author may post at (D41) — the ceiling both the report form (offered
 * options) and `reports.create` (server re-enforce, D37) clamp/reject against.
 *
 * Adults may reach `public`; minors are capped at `just_me`, so a named minor's location/time is
 * never broadcast publicly (D3). The narrower level (`just_me`) is always allowed — this only caps
 * the top.
 */
export function maxVisibilityForProfile(input: DefaultVisibilityInput): Visibility {
  return input.isMinor ? 'just_me' : 'public'
}
