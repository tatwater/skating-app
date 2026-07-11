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
  /**
   * Whether the author's profile is public — the inverse of the account-level
   * `requireFollowApproval` "locked" setting (D13). This is the user's *stored* privacy
   * setting; it is deliberately NOT a live age check (see below).
   */
  profilePublic: boolean
}

/**
 * The pre-selected default visibility for a new report (D41):
 * public profile → `public`; locked/private profile → `followers`.
 *
 * Derived purely from the user's stored privacy setting, **never from a live minor
 * check**, so a post default never changes on a user's birthday. Minor protection is
 * applied by seeding `requireFollowApproval` (locked) at signup and persisting it past
 * 18: a minor is always locked → never *defaults* to public, and turning 18 leaves the
 * setting untouched → the default is unchanged until they choose to unlock. (Corollary:
 * the profile-settings mutation must not let a minor unlock — the age check belongs at
 * the moment of *changing the setting*, not at post time.)
 */
export function deriveDefaultVisibility(input: DefaultVisibilityInput): Visibility {
  return input.profilePublic ? 'public' : 'followers'
}
