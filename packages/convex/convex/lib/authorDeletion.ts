/**
 * An author's deletion is final (D248, founder ruling 2026-11-13): "Any author-deleted content
 * should not be able to come back, no moderator should be able to restore it." Posts, Reports and
 * Comments carry `authorDeletedAt`, set by the author's own delete and never cleared; every restore
 * path reads it through here.
 */
import type { Doc } from '../_generated/dataModel';

type ContentDoc = Doc<'reports'> | Doc<'posts'> | Doc<'comments'> | Doc<'hazards'>;

/** When its author deleted it, if they did — `undefined` for anything they haven't (or can't). */
export function authorDeletedAtOf(target: ContentDoc): number | undefined {
  return 'authorDeletedAt' in target ? target.authorDeletedAt : undefined;
}
