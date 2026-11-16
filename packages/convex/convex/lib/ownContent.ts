/**
 * **A moderator may not act on their own content** (D269, the founder's call). A decision on a
 * Report, Post, comment, hazard or access alert is made by someone other than its author — a hide,
 * a removal, a restore, an overturn, a keep on the record, a pin of an alert, a ruling on a flag
 * about them or their content, and every undo of one. The record sheet's levers, its writes and
 * the undo engine all ask {@link ownContentRefusal}, so a lever is never drawn that its write would
 * refuse, and an undo is never offered that its write would refuse.
 */
import type { Doc, Id } from '../_generated/dataModel';

type Role = Doc<'profiles'>['role'];

/**
 * **The roles the rule does not bind** — none: every role, admins included (the founder, 2026-11-16:
 * there will always be more than one admin, so another staff member can always decide). It rests on
 * that: a console down to a single admin with no moderators would leave that admin's own flagged
 * content and alerts waiting for a second staff member.
 */
export const OWN_CONTENT_EXEMPT_ROLES: readonly Role[] = [];

/** What the lever and the write say: plain words, never a decision number. */
export const OWN_CONTENT_REFUSAL = 'This is yours, so another moderator decides on it.';

/** Who wrote a piece of content: a Report's, Post's or comment's author, a hazard's or alert's filer. */
export function authorOf(doc: object | null): Id<'profiles'> | null {
  if (doc === null) return null;
  const d = doc as { authorId?: Id<'profiles'>; createdByUserId?: Id<'profiles'> };
  return d.authorId ?? d.createdByUserId ?? null;
}

/** Why `viewer` may not decide on content `authorId` wrote — or `null` when they may. */
export function ownContentRefusal(
  viewer: { _id: Id<'profiles'>; role: Role },
  authorId: Id<'profiles'> | null | undefined,
): string | null {
  if (authorId === null || authorId === undefined || authorId !== viewer._id) return null;
  return OWN_CONTENT_EXEMPT_ROLES.includes(viewer.role) ? null : OWN_CONTENT_REFUSAL;
}
