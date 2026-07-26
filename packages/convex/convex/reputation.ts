/**
 * Reputation backfill (D50, Phase 6) — recompute every denormalized total from the `pointEvents` ledger
 * + live rows, so a mid-alpha weight/threshold change in `@skating/core`'s `reputationConfig` is a
 * **replay, not a migration** (D40). Mirrors `profiles.backfillContributionCounts`.
 *
 * The ledger is the source of truth: `reputationPoints` = clamped sum of every trust-reason delta,
 * `bountyPoints` = clamped sum of `bounty_fulfilled` deltas, `badges` = `deriveEarnedBadges` over live
 * stats. Idempotent — re-running rewrites the same values. `collect()` per profile suits dev's handful
 * of rows + prod's uninitialized state; a large corpus would page.
 * Run: `pnpm exec convex run reputation:backfillReputation`.
 */

import { deriveEarnedBadges } from '@skating/core';
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { computeBadgeStats } from './lib/reputation';

export const backfillReputation = internalMutation({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, batchSize }) => {
    // Small pages on purpose: `computeBadgeStats` reads five lifetime histories per profile, so the
    // per-profile cost dominates (N1).
    const page = await ctx.db
      .query('profiles')
      .paginate({ cursor: cursor ?? null, numItems: Math.min(200, Math.max(1, batchSize ?? 50)) });
    const profiles = page.page;
    let patched = 0;
    for (const p of profiles) {
      const events = await ctx.db
        .query('pointEvents')
        .withIndex('by_user', (q) => q.eq('userId', p._id))
        .collect();
      // `bounty_fulfilled` is the lone bounty-currency reason; everything else feeds reputation.
      let reputation = 0;
      let bounty = 0;
      for (const e of events) {
        if (e.reason === 'bounty_fulfilled') bounty += e.delta;
        else reputation += e.delta;
      }
      const reputationPoints = Math.max(0, reputation);
      const bountyPoints = Math.max(0, bounty);
      const badges = deriveEarnedBadges(await computeBadgeStats(ctx, p._id));

      const current = p.badges ?? [];
      const badgesChanged =
        badges.length !== current.length || badges.some((b, i) => b !== current[i]);
      if (
        p.reputationPoints !== reputationPoints ||
        (p.bountyPoints ?? 0) !== bountyPoints ||
        badgesChanged
      ) {
        await ctx.db.patch(p._id, { reputationPoints, bountyPoints, badges });
        patched++;
      }
    }
    return { patched, total: profiles.length, cursor: page.continueCursor, isDone: page.isDone };
  },
});
