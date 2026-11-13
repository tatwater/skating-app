/**
 * An author's deletion is final (D248, founder ruling 2026-11-13): "Any author-deleted content
 * should not be able to come back, no moderator should be able to restore it." Posts, Reports and
 * Comments carry `authorDeletedAt`, set by the author's own delete and never cleared; every restore
 * path reads it through here, and every refusal is worded here, so a writer, an undo and History
 * give the same answer.
 */
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

type ContentDoc = Doc<'reports'> | Doc<'posts'> | Doc<'comments'> | Doc<'hazards'>;

/** The reason an author's own takedown carries — there is no free text to ask for. */
export const AUTHOR_DELETE_REASON = 'Deleted by the author';

/** A restore of something its author deleted (founder ruling, 2026-11-13). */
export const AUTHOR_DELETED_RESTORE = "Its author deleted this, so it can't be restored.";
/** Anything else a moderator tries on it: it is already down, and stays as its author left it. */
export const AUTHOR_DELETED_ALREADY = 'Its author deleted this, so it stays as they left it.';
/** The same refusal, for an undo. */
export const AUTHOR_DELETED_UNDO = "Its author deleted this since, so undoing can't bring it back.";

/** The tables whose rows an author can withdraw, by audit target type. */
export const WITHDRAWABLE_TABLE = {
  report: 'reports',
  post: 'posts',
  comment: 'comments',
} as const;
export type Withdrawable = keyof typeof WITHDRAWABLE_TABLE;

export function isWithdrawable(targetType: string): targetType is Withdrawable {
  return Object.hasOwn(WITHDRAWABLE_TABLE, targetType);
}

/** When its author deleted it, if they did — `undefined` for anything they haven't (or can't). */
export function authorDeletedAtOf(target: ContentDoc): number | undefined {
  return 'authorDeletedAt' in target ? target.authorDeletedAt : undefined;
}

/** The same, read off an audit row's target: `undefined` for a target no author can withdraw. */
export async function authorDeletedAtOn(
  ctx: QueryCtx,
  targetType: string,
  targetId: string,
): Promise<number | undefined> {
  if (!isWithdrawable(targetType)) return undefined;
  const id = ctx.db.normalizeId(WITHDRAWABLE_TABLE[targetType], targetId);
  const target = id ? await ctx.db.get(id) : null;
  return target ? authorDeletedAtOf(target) : undefined;
}

/** Why content its author deleted can't be moved to `status` — by a verdict, or by an undo. */
export function authorDeletedRefusal(
  status: 'visible' | 'hidden' | 'removed',
  asUndo: boolean,
): string {
  if (status !== 'visible') return AUTHOR_DELETED_ALREADY;
  return asUndo ? AUTHOR_DELETED_UNDO : AUTHOR_DELETED_RESTORE;
}
