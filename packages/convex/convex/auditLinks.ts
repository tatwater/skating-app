/**
 * **Linking the audit log to its bodies** (B01-3b): the backfill that writes `auditBodyLinks` for the
 * audit rows written before `writeAudit` linked them. New rows are linked at the write.
 *
 * ## After deploy
 *
 * `auditLinks:backfill` — the whole log, oldest first, chaining itself page by page. Resumable (pass
 * the cursor it logs) and idempotent (a row already linked is skipped). Until it finishes, a body's
 * History holds only the rows linked so far.
 */

import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation } from './_generated/server';
import { bodiesOfTarget, LOT_LINK_CAP, linkAuditRow } from './lib/bodyLibrary';

/** Audit rows one page links at most. */
const PAGE = 100;
/** Read budget a page keeps back; below it the page stops and is re-run smaller from its cursor. */
const BYTES_RESERVE = 4 * 1024 * 1024;

/**
 * One page of the audit log, oldest first: each row linked to every body it concerns (the resolver
 * the library refresh uses). A row whose target can't be resolved is skipped and counted, never
 * blocking the page; a page that runs low on read budget stops before its writes and is re-run at
 * half the size from the same cursor (linking is idempotent, so no row is skipped or doubled).
 */
export const backfill = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    pageSize: v.optional(v.number()),
    chain: v.optional(v.boolean()),
  },
  handler: async (ctx, { cursor, pageSize, chain = true }) => {
    const size =
      pageSize !== undefined && Number.isFinite(pageSize)
        ? Math.min(PAGE, Math.max(1, Math.floor(pageSize)))
        : PAGE;
    const page = await ctx.db
      .query('moderationActions')
      .withIndex('by_created_at')
      .paginate({ cursor: cursor ?? null, numItems: size });
    const resolved: {
      row: (typeof page.page)[number];
      bodies: Awaited<ReturnType<typeof bodiesOfTarget>>['bodies'];
    }[] = [];
    let unresolved = 0;
    for (const row of page.page) {
      const m = await ctx.meta.getTransactionMetrics();
      if (m.bytesRead.remaining < BYTES_RESERVE && size > 1) {
        await ctx.scheduler.runAfter(0, internal.auditLinks.backfill, {
          ...(cursor !== undefined ? { cursor } : {}),
          pageSize: Math.floor(size / 2),
          chain,
        });
        return { linked: 0, unresolved: 0, isDone: false, rerunAt: Math.floor(size / 2) };
      }
      try {
        const { bodies } = await bodiesOfTarget(ctx, row.targetType, row.targetId, LOT_LINK_CAP);
        resolved.push({ row, bodies });
      } catch (err) {
        unresolved++;
        console.warn(
          `auditLinks.backfill: a ${row.targetType} row could not be resolved (${err instanceof Error ? err.name : 'unknown'})`,
        );
      }
    }
    let linked = 0;
    for (const { row, bodies } of resolved) {
      linked += await linkAuditRow(
        ctx,
        {
          actionId: row._id,
          action: row.action,
          targetType: row.targetType,
          targetId: row.targetId,
          createdAt: row.createdAt,
        },
        bodies,
      );
    }
    if (!page.isDone && chain) {
      await ctx.scheduler.runAfter(0, internal.auditLinks.backfill, {
        cursor: page.continueCursor,
        chain,
      });
    }
    return {
      linked,
      unresolved,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      rerunAt: null,
    };
  },
});
