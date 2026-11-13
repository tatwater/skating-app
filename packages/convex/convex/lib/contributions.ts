/**
 * Who contributed, read through the one rule (`contributionStands`, `@skating/core`; D253). Every
 * *contributors* figure reads these: the day's strip, the trailing week's `active_contributors`,
 * Metrics' week and first-timers. The season's walk (`seasonReach`) applies the same rule page by
 * page.
 *
 * Every read is an index range or an author's first rows, and bounded: a range read past `cap`
 * says so (`capped`), and a person whose first rows of a kind are all withdrawn reads as `unknown`
 * rather than a guess.
 */

import { CONTRIBUTION_KINDS, type ContributionKind, contributionStands } from '@skating/core';
import type { Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

/**
 * The people with a standing contribution made in `[from, to)` — a report whose skate ended in it,
 * or anything else made in it — and whether any source's read stopped short at `cap`.
 */
export async function contributorsBetween(
  ctx: QueryCtx,
  from: number,
  to: number,
  cap: number,
): Promise<{ people: Set<Id<'profiles'>>; capped: boolean }> {
  const people = new Set<Id<'profiles'>>();
  let capped = false;
  const take = <T>(rows: T[]) => {
    capped ||= rows.length > cap;
    return rows.slice(0, cap);
  };

  for (const r of take(
    await ctx.db
      .query('reports')
      .withIndex('by_moderation_and_skate_end_time', (q) =>
        q.eq('moderationStatus', 'visible').gte('skateEndTime', from).lt('skateEndTime', to),
      )
      .take(cap + 1),
  )) {
    if (contributionStands.report(r)) people.add(r.authorId);
  }
  for (const h of take(
    await ctx.db
      .query('hazards')
      .withIndex('by_created_at', (q) => q.gte('createdAt', from).lt('createdAt', to))
      .take(cap + 1),
  )) {
    if (contributionStands.hazard(h)) people.add(h.createdByUserId);
  }
  for (const a of take(
    await ctx.db
      .query('accessAlerts')
      .withIndex('by_created_at', (q) => q.gte('createdAt', from).lt('createdAt', to))
      .take(cap + 1),
  )) {
    if (contributionStands.accessAlert(a)) people.add(a.createdByUserId);
  }
  for (const f of take(
    await ctx.db
      .query('contentFlags')
      .withIndex('by_reason_created', (q) =>
        q.eq('reason', 'no_public_access').gte('createdAt', from).lt('createdAt', to),
      )
      .take(cap + 1),
  )) {
    if (contributionStands.noPublicAccess(f)) people.add(f.flaggerId);
  }
  for (const p of take(
    await ctx.db
      .query('putIns')
      .withIndex('by_source_created', (q) =>
        q.eq('source', 'official').gte('createdAt', from).lt('createdAt', to),
      )
      .take(cap + 1),
  )) {
    if (contributionStands.putIn(p) && p.createdByUserId !== undefined) {
      people.add(p.createdByUserId);
    }
  }
  for (const r of take(
    await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_created_at', (q) => q.gte('createdAt', from).lt('createdAt', to))
      .take(cap + 1),
  )) {
    if (contributionStands.corpusRequest(r)) people.add(r.requesterId);
  }
  return { people, capped };
}

/** How many of a person's first rows of each kind are looked through for one that stands. */
export const FIRST_PROBE = 10;

/**
 * When `userId` first made a contribution that stands — the earliest across every kind — or `null`
 * if they never have, or `unknown` when a kind's first {@link FIRST_PROBE} rows were all withdrawn
 * or not contributions (so an earlier standing one can't be ruled out).
 */
export async function firstContributionAt(
  ctx: QueryCtx,
  userId: Id<'profiles'>,
): Promise<number | null | 'unknown'> {
  const firsts: Record<ContributionKind, Array<{ at: number; stands: boolean }>> = {
    report: (
      await ctx.db
        .query('reports')
        .withIndex('by_author_skate_end_time', (q) => q.eq('authorId', userId))
        .take(FIRST_PROBE)
    ).map((r) => ({ at: r.skateEndTime, stands: contributionStands.report(r) })),
    hazard: (
      await ctx.db
        .query('hazards')
        .withIndex('by_author_created', (q) => q.eq('createdByUserId', userId))
        .take(FIRST_PROBE)
    ).map((h) => ({ at: h.createdAt, stands: contributionStands.hazard(h) })),
    accessAlert: (
      await ctx.db
        .query('accessAlerts')
        .withIndex('by_author', (q) => q.eq('createdByUserId', userId))
        .take(FIRST_PROBE)
    ).map((a) => ({ at: a.createdAt, stands: contributionStands.accessAlert(a) })),
    noPublicAccess: (
      await ctx.db
        .query('contentFlags')
        .withIndex('by_flagger_reason_created', (q) =>
          q.eq('flaggerId', userId).eq('reason', 'no_public_access'),
        )
        .take(FIRST_PROBE)
    ).map((f) => ({ at: f.createdAt, stands: contributionStands.noPublicAccess(f) })),
    putIn: (
      await ctx.db
        .query('putIns')
        .withIndex('by_created_by', (q) => q.eq('createdByUserId', userId))
        .take(FIRST_PROBE)
    ).map((p) => ({ at: p.createdAt, stands: contributionStands.putIn(p) })),
    corpusRequest: (
      await ctx.db
        .query('waterBodyRequests')
        .withIndex('by_requester_created', (q) => q.eq('requesterId', userId))
        .take(FIRST_PROBE)
    ).map((r) => ({ at: r.createdAt, stands: contributionStands.corpusRequest(r) })),
  };
  let earliest: number | null = null;
  for (const kind of CONTRIBUTION_KINDS) {
    const rows = firsts[kind];
    const standing = rows.filter((r) => r.stands);
    if (standing.length === 0) {
      if (rows.length >= FIRST_PROBE) return 'unknown';
      continue;
    }
    const at = Math.min(...standing.map((r) => r.at));
    earliest = earliest === null ? at : Math.min(earliest, at);
  }
  return earliest;
}
