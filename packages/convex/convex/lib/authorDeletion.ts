/**
 * An author's deletion is final (D248, founder ruling 2026-11-13): "Any author-deleted content
 * should not be able to come back, no moderator should be able to restore it." Posts, Reports and
 * Comments carry `authorDeletedAt`, set by the author's own delete and never cleared; every restore
 * path reads it through here, and every refusal is worded here, so a writer, an undo and History
 * give the same answer.
 */
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { authorOf } from './ownContent';
import { photoWithdrawnAt } from './photoAccess';

type ContentDoc = Doc<'reports'> | Doc<'posts'> | Doc<'comments'> | Doc<'hazards'>;

/** The reason an author's own takedown carries — there is no free text to ask for. */
export const AUTHOR_DELETE_REASON = 'Deleted by the author';

/** A restore of something its author deleted (founder ruling, 2026-11-13). */
export const AUTHOR_DELETED_RESTORE = "Its author deleted this, so it can't be restored.";
/** Anything else a moderator tries on it: it is already down, and stays as its author left it. */
export const AUTHOR_DELETED_ALREADY = 'Its author deleted this, so it stays as they left it.';
/** The same refusal, for an undo. */
export const AUTHOR_DELETED_UNDO = "Its author deleted this since, so undoing can't bring it back.";
/** An undo of a verdict recorded on content already deleted: the reversal is an overturn (D248). */
export const AUTHOR_DELETED_OVERTURN =
  'Its author had deleted this. Overturn the verdict to take it off their record.';

/** The tables whose rows an author can withdraw, by audit target type. */
export const WITHDRAWABLE_TABLE = {
  report: 'reports',
  post: 'posts',
  comment: 'comments',
  // Since 2026-11-13: an author may withdraw a hazard no other skater has said is there.
  hazard: 'hazards',
} as const;
export type Withdrawable = keyof typeof WITHDRAWABLE_TABLE;

export function isWithdrawable(targetType: string): targetType is Withdrawable {
  return Object.hasOwn(WITHDRAWABLE_TABLE, targetType);
}

/** When its author deleted it, if they did — `undefined` for anything they haven't (or can't). */
export function authorDeletedAtOf(target: ContentDoc): number | undefined {
  return 'authorDeletedAt' in target ? target.authorDeletedAt : undefined;
}

/**
 * An audit row's target as the undo engine weighs it, in one read: when its author deleted it
 * (`undefined` for a target no author can withdraw, or one they haven't), and who wrote it (`null`
 * for a target with no author, or gone) — a moderator never decides their own (D269).
 */
export async function contentFactsOn(
  ctx: QueryCtx,
  targetType: string,
  targetId: string,
): Promise<{ authorDeletedAt: number | undefined; authorId: Id<'profiles'> | null }> {
  if (targetType === 'photo') {
    // A photo (B01-5e): its uploader is its author (D269), and their withdrawal of a held photo is on
    // its audit rows, not its document (`lib/photoAccess.photoWithdrawnAt`).
    const photoId = ctx.db.normalizeId('photos', targetId);
    const photo = photoId ? await ctx.db.get(photoId) : null;
    if (!photo) return { authorDeletedAt: undefined, authorId: null };
    const withdrawn = await photoWithdrawnAt(ctx, photo._id);
    return { authorDeletedAt: withdrawn ?? undefined, authorId: photo.uploaderId };
  }
  const table = isWithdrawable(targetType)
    ? WITHDRAWABLE_TABLE[targetType]
    : targetType === 'accessAlert'
      ? 'accessAlerts'
      : null;
  if (table === null) return { authorDeletedAt: undefined, authorId: null };
  const id = ctx.db.normalizeId(table, targetId);
  const target = id ? await ctx.db.get(id) : null;
  if (!target) return { authorDeletedAt: undefined, authorId: null };
  return {
    authorDeletedAt: isWithdrawable(targetType)
      ? authorDeletedAtOf(target as ContentDoc)
      : undefined,
    authorId: authorOf(target),
  };
}

/** Why content its author deleted can't be moved to `status` — by a verdict, or by an undo. */
export function authorDeletedRefusal(
  status: 'visible' | 'hidden' | 'removed',
  asUndo: boolean,
): string {
  if (status !== 'visible') return AUTHOR_DELETED_ALREADY;
  return asUndo ? AUTHOR_DELETED_UNDO : AUTHOR_DELETED_RESTORE;
}
