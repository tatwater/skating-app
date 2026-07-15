/**
 * Report/comment read-access (D13/D32). There is **no per-report visibility** — every report is
 * public (D13) — so the only thing that hides a report from a viewer is a **block** (D32). The
 * author always sees their own content. Safety-sensitive (a bug could surface blocked content), so
 * it's covered by example + property tests.
 */

/**
 * The viewer's relationship to the author. The only dimension is whether a **block** exists in
 * either direction (D32). Blocks land in Phase 3; until then callers pass `{ blocked: false }`.
 */
export interface ViewerRelationship {
  blocked: boolean
}

/**
 * Can `viewerId` see content authored by `authorId`? All reports are public (D13), so the only
 * gate is a block — except the author, who always sees their own content.
 */
export function canViewReport(
  viewerId: string,
  authorId: string,
  rel: ViewerRelationship,
): boolean {
  if (viewerId === authorId) return true
  return !rel.blocked
}

/**
 * Comment access mirrors its parent report (D21) — a comment is viewable exactly when the report
 * it hangs on is.
 */
export function canViewComment(
  viewerId: string,
  reportAuthorId: string,
  rel: ViewerRelationship,
): boolean {
  return canViewReport(viewerId, reportAuthorId, rel)
}
