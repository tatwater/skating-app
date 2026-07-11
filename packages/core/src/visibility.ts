/**
 * Report/comment visibility resolution (D13) and default-visibility derivation
 * (D41). This is safety- and privacy-sensitive logic — a bug here can leak a
 * private spot — so it's covered by both example and property tests.
 */

import type { Visibility } from './types'

/**
 * The viewer's relationship to the author, as resolved from the `follows` and
 * `blocks` tables. `blocked` is true if a block exists in **either** direction.
 * Only *accepted* follows count (pending follows do not grant visibility).
 */
export interface ViewerRelationship {
  viewerFollowsAuthor: boolean
  authorFollowsViewer: boolean
  blocked: boolean
}

/**
 * Can `viewerId` see a report authored by `authorId` at the given visibility?
 *
 * Rules (D13):
 * - The author always sees their own content (even `just_me`, and regardless of blocks).
 * - A block in either direction hides everything between the two users.
 * - `public` → anyone · `followers` → viewer follows author · `friends` → mutual ·
 *   `just_me` → only the author.
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
    followers: rel.viewerFollowsAuthor,
    friends: rel.viewerFollowsAuthor && rel.authorFollowsViewer,
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
  /** Whether the author's profile is public (vs. locked / private-account). */
  profilePublic: boolean
  /** Whether the author self-attested as under 18 (D41). */
  isMinor: boolean
}

/**
 * The pre-selected default visibility for a new report (D41):
 * - under-18 accounts never *default* to public;
 * - locked/private profiles default to followers;
 * - otherwise (adult + public profile) default to public.
 */
export function deriveDefaultVisibility(input: DefaultVisibilityInput): Visibility {
  if (input.isMinor) return 'followers'
  if (!input.profilePublic) return 'followers'
  return 'public'
}
