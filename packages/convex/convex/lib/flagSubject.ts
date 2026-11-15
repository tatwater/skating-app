/**
 * Whose a flag is (B01; the founder's ruling of 2026-11-14: "flagged" means the person or their
 * content). Stamped on the flag when it is filed — by a person (`contentFlags.flag`) or by the system
 * (`lib/autoFlag`) — and by the backfill for older rows, so a person's flags are one index range
 * (`contentFlags.by_subject_status`) and the Overview's flagged figure and the People lane group the
 * open queue by one field.
 *
 * - A flag on a person is theirs; on a report, post or comment its author's; on a hazard or access
 *   alert its creator's; on a photo its uploader's.
 * - A body has no author (the person who drew an outline did not claim the lake was private), so a
 *   flag on one is nobody's: `null`. So is a flag whose content is gone.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

type FlagTargetType = Doc<'contentFlags'>['targetType'];

/** The person behind a flagged item already read, or `null`. */
export function subjectOfTarget(
  targetType: FlagTargetType,
  targetId: string,
  target: unknown,
): Id<'profiles'> | null {
  if (target === null || target === undefined) return null;
  const doc = target as Record<string, unknown>;
  switch (targetType) {
    case 'user':
      return targetId as Id<'profiles'>;
    case 'report':
    case 'post':
    case 'comment':
      return (doc.authorId as Id<'profiles'> | undefined) ?? null;
    case 'hazard':
    case 'accessAlert':
      return (doc.createdByUserId as Id<'profiles'> | undefined) ?? null;
    case 'photo':
      return (doc.uploaderId as Id<'profiles'> | undefined) ?? null;
    case 'waterbody':
      return null;
  }
}

const TABLE = {
  report: 'reports',
  post: 'posts',
  comment: 'comments',
  hazard: 'hazards',
  accessAlert: 'accessAlerts',
  photo: 'photos',
  user: 'profiles',
} as const;

/** The person behind a flagged item, read by id: one `get`, none for a body. */
export async function flagSubjectOf(
  ctx: QueryCtx,
  targetType: FlagTargetType,
  targetId: string,
): Promise<Id<'profiles'> | null> {
  if (targetType === 'waterbody') return null;
  const id = ctx.db.normalizeId(TABLE[targetType], targetId);
  if (!id) return null;
  return subjectOfTarget(targetType, targetId, await ctx.db.get(id));
}

/**
 * The person an open flag counts against, read off the row: a flag on a person names them by its
 * target even before the backfill stamps it. `undefined` means not yet known (a content flag the
 * backfill hasn't reached); `null` means nobody.
 */
export function flagSubject(
  flag: Pick<Doc<'contentFlags'>, 'targetType' | 'targetId' | 'subjectUserId'>,
): Id<'profiles'> | null | undefined {
  if (flag.targetType === 'user') return flag.targetId as Id<'profiles'>;
  if (flag.targetType === 'waterbody') return null;
  return flag.subjectUserId;
}

/**
 * The table a flag's content target lives in, for a reader that names it (the person page's open
 * flags): `null` for a person or a body, which have their own labels (`auditTargetLabel`).
 */
export function flagTargetTable(targetType: FlagTargetType) {
  return targetType === 'user' || targetType === 'waterbody' ? null : TABLE[targetType];
}
