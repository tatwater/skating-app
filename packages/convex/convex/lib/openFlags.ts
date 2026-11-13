/**
 * **Open flags, one definition** (B01, the governor's ruling of 2026-11-13). A flag a moderator has
 * opened but not decided — `reviewing` — is still open: it counts on the Overview's Inbox card, its
 * heads row, Metrics' *Open flags* and *Oldest open flag*, and the `flag_queue_depth` rollup. Every
 * count of open flags reads them through {@link readOpenFlags}, so the places can't disagree again.
 *
 * (`moderation.listFlags` and `lib/autoFlag.ts` already read both statuses on their own; they adopt
 * this when their files are next open.)
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

/** The statuses a flag waits in. `actioned` and `dismissed` are decided. */
export const OPEN_FLAG_STATUSES = ['open', 'reviewing'] as const;

/**
 * Every open flag, oldest first, read through `by_status` one status at a time and capped: each
 * status reads at most `cap + 1` rows, and `capped` says the true count is larger than `flags`
 * holds. `flags` is at most `cap` long.
 */
export async function readOpenFlags(
  ctx: QueryCtx,
  cap: number,
): Promise<{ flags: Doc<'contentFlags'>[]; capped: boolean }> {
  const rows: Doc<'contentFlags'>[] = [];
  let capped = false;
  for (const status of OPEN_FLAG_STATUSES) {
    const page = await ctx.db
      .query('contentFlags')
      .withIndex('by_status', (q) => q.eq('status', status))
      .take(cap + 1);
    capped ||= page.length > cap;
    rows.push(...page);
  }
  rows.sort((a, b) => a.createdAt - b.createdAt);
  return { flags: rows.slice(0, cap), capped: capped || rows.length > cap };
}

/**
 * The body a flag is about, for a row that names where ("Mascoma Lake"): the body itself, or the
 * body the flagged report, post, comment, photo, hazard or access alert is on. `null` for a flag on a
 * person, or on something since deleted. At most three point reads.
 */
export async function flagBodyId(
  ctx: QueryCtx,
  flag: Pick<Doc<'contentFlags'>, 'targetType' | 'targetId'>,
): Promise<Id<'waterBodies'> | null> {
  const reportBody = async (id: Id<'reports'> | null | undefined) =>
    id ? ((await ctx.db.get(id))?.waterBodyId ?? null) : null;
  switch (flag.targetType) {
    case 'waterbody':
      return ctx.db.normalizeId('waterBodies', flag.targetId);
    case 'report':
      return reportBody(ctx.db.normalizeId('reports', flag.targetId));
    case 'post': {
      const id = ctx.db.normalizeId('posts', flag.targetId);
      const post = id ? await ctx.db.get(id) : null;
      return reportBody(post?.reportIds[0]);
    }
    case 'comment': {
      const id = ctx.db.normalizeId('comments', flag.targetId);
      return reportBody(id ? (await ctx.db.get(id))?.reportId : null);
    }
    case 'photo': {
      const id = ctx.db.normalizeId('photos', flag.targetId);
      return reportBody(id ? (await ctx.db.get(id))?.reportId : null);
    }
    case 'hazard': {
      const id = ctx.db.normalizeId('hazards', flag.targetId);
      return id ? ((await ctx.db.get(id))?.waterBodyId ?? null) : null;
    }
    case 'accessAlert': {
      const id = ctx.db.normalizeId('accessAlerts', flag.targetId);
      return id ? ((await ctx.db.get(id))?.waterBodyId ?? null) : null;
    }
    case 'user':
      return null;
  }
}
