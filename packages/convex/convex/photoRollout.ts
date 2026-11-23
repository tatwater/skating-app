/**
 * **The photo axis' rollout** (B01-5e, D222): widen → deploy → backfill → narrow. `photos.moderationStatus`
 * landed optional (absent reads as `visible` through `lib/photoAccess.photoVisible`); this stamps
 * `visible` on every row that lacks it, so the field can narrow to required, as every other content
 * table has it. The narrowing waits until {@link countUnstamped} reads zero on the deployment — the
 * precondition #172's preference narrowing used. **Narrowed at the Inbox wave's close** (dev counted
 * 0 unstamped); the module stays, and its count is the check a fresh deployment can still run.
 *
 * - **Paged and bounded:** one `paginate` a transaction ({@link BACKFILL_PAGE} rows; a row is at most a
 *   few KiB — the caption is capped at 500 characters), each page patching only the rows it finds
 *   lacking the field, then scheduling the next page with its cursor.
 * - **Restartable:** idempotent — a row already stamped is left alone — so a chain that dies is
 *   restarted from the start (or from a cursor), and writes nothing twice.
 * - **Counted:** {@link unstampedPage} counts a page of rows still lacking the field; the action
 *   {@link countUnstamped} walks every page and sums them — the zero the narrowing waits for.
 *
 * Run: `convex run photoRollout:backfillModerationStatus '{}'`, then
 * `convex run photoRollout:countUnstamped '{}'` until it answers `{ unstamped: 0 }`.
 */
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation, internalQuery } from './_generated/server';

/** Rows one page reads at most — and so patches at most. */
export const BACKFILL_PAGE = 400;

const clampPage = (n: number | undefined) =>
  Math.min(Math.max(Math.floor(n ?? BACKFILL_PAGE), 1), BACKFILL_PAGE);

/**
 * Stamp `moderationStatus: 'visible'` on one page of photos that lack it, and schedule the next page.
 * `dryRun` counts without writing (and doesn't continue).
 */
export const backfillModerationStatus = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    /** Test seam: rows a page reads (clamped to `BACKFILL_PAGE`). */
    pageSize: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { cursor, pageSize, dryRun }) => {
    const page = await ctx.db
      .query('photos')
      .paginate({ cursor: cursor ?? null, numItems: clampPage(pageSize) });
    let stamped = 0;
    for (const photo of page.page) {
      if (photo.moderationStatus !== undefined) continue;
      stamped++;
      if (dryRun !== true) await ctx.db.patch(photo._id, { moderationStatus: 'visible' });
    }
    if (!page.isDone && dryRun !== true) {
      await ctx.scheduler.runAfter(0, internal.photoRollout.backfillModerationStatus, {
        cursor: page.continueCursor,
        ...(pageSize !== undefined ? { pageSize } : {}),
      });
    }
    return { scanned: page.page.length, stamped, isDone: page.isDone };
  },
});

/** One page of photos, and how many of them still lack `moderationStatus`. */
export const unstampedPage = internalQuery({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, { cursor, pageSize }) => {
    const page = await ctx.db
      .query('photos')
      .paginate({ cursor: cursor ?? null, numItems: clampPage(pageSize) });
    return {
      scanned: page.page.length,
      unstamped: page.page.filter((p) => p.moderationStatus === undefined).length,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * **Photos still lacking `moderationStatus`, every page summed** — the narrowing's precondition. An
 * action, so the walk is many bounded queries rather than one unbounded one.
 */
export const countUnstamped = internalAction({
  args: { pageSize: v.optional(v.number()) },
  handler: async (ctx, { pageSize }): Promise<{ unstamped: number; scanned: number }> => {
    let cursor: string | null = null;
    let unstamped = 0;
    let scanned = 0;
    for (;;) {
      const page: { scanned: number; unstamped: number; continueCursor: string; isDone: boolean } =
        await ctx.runQuery(internal.photoRollout.unstampedPage, {
          cursor,
          ...(pageSize !== undefined ? { pageSize } : {}),
        });
      unstamped += page.unstamped;
      scanned += page.scanned;
      if (page.isDone) return { unstamped, scanned };
      cursor = page.continueCursor;
    }
  },
});
