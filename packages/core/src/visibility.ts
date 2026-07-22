/**
 * Report / comment read-access (D3/D13/D32).
 *
 * The load-bearing Phase-3 change (2026-07-16): a **block never hides a report** (D3, safety-first).
 * Report reads gate on **moderation status only**. The block set instead (a) hides **comments** by a
 * blocked author, (b) hides **profiles** both ways, and (c) de-emphasizes a blocked author's report
 * line with a "Blocked" chip. This reverses the Phase-2 stub, where a block hid the report itself —
 * an interpersonal block must never pull a safety observation off the shared map/feed.
 *
 * Safety-sensitive (a bug could remove a safety observation from the commons, or leak blocked
 * content), so it's covered by example + property tests — including the explicit invariant
 * "blocks never hide a report".
 */

/** Moderation state of a report/comment (mirrors the backend `MODERATION_STATUSES`; D32). */
export type ModerationStatus = 'visible' | 'hidden' | 'removed';

/** Content is publicly readable by moderation status alone — the *only* gate on a report (D3/D32). */
export function isModerationVisible(status: ModerationStatus): boolean {
  return status === 'visible';
}

/**
 * The viewer's relationship to a piece of content's author — the block set, unioned across both
 * directions (I blocked them OR they blocked me), resolved by the caller (`loadBlockedAuthorIds`).
 */
export interface ViewerRelationship {
  viewerId: string;
  authorId: string;
  blockedAuthorIds: ReadonlySet<string>;
}

/**
 * Is `authorId` blocked from `viewerId`'s vantage (D32)? You are never blocked from yourself, so your
 * own content is never self-hidden. Drives comment + profile hiding and the report author-line
 * "Blocked" chip — but it does **not** hide a report (see {@link canViewReport}).
 */
export function isAuthorBlocked(
  viewerId: string,
  authorId: string,
  blockedAuthorIds: ReadonlySet<string>,
): boolean {
  if (viewerId === authorId) return false;
  return blockedAuthorIds.has(authorId);
}

/**
 * Can the viewer read a report? **Moderation-visible only** — a block NEVER hides a report (D3). The
 * block relationship is accepted so this invariant is explicit and property-testable, but it is
 * deliberately ignored: an interpersonal block must never remove a safety observation from the
 * commons. (A blocked author's report is still de-emphasized with a "Blocked" chip — a display
 * concern, not a read gate; see {@link isAuthorBlocked}.)
 */
export function canViewReport(
  moderationStatus: ModerationStatus,
  _rel?: ViewerRelationship,
): boolean {
  return isModerationVisible(moderationStatus);
}

/**
 * Can the viewer read a comment (D21/D32)? Moderation-visible **AND** the author isn't blocked.
 * Unlike a report, a blocked author's comment *is* hidden — a thread is interpersonal, the map is the
 * commons. A moderation-hidden or blocked comment that still has visible replies is kept as a
 * `[hidden]` placeholder by {@link buildCommentThread} so its children don't disappear.
 */
export function canViewComment(
  viewerId: string,
  authorId: string,
  moderationStatus: ModerationStatus,
  blockedAuthorIds: ReadonlySet<string>,
): boolean {
  return (
    isModerationVisible(moderationStatus) && !isAuthorBlocked(viewerId, authorId, blockedAuthorIds)
  );
}
