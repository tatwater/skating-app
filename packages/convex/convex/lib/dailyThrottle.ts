/**
 * Once per key per New York day, or busy until a time (A06i) — operator alerts use the first, the
 * full history fill the second.
 */

import type { MutationCtx } from '../_generated/server';
import { newYorkDate } from './seasonWatchEmails';

/** Whether `key` is still unused today (New York); marks it used if so. */
export async function firstToday(ctx: MutationCtx, key: string): Promise<boolean> {
  const today = newYorkDate(Date.now());
  const row = await ctx.db
    .query('dailyThrottle')
    .withIndex('by_key', (q) => q.eq('key', key))
    .unique();
  if (row?.lastOn === today) return false;
  if (row) await ctx.db.patch(row._id, { lastOn: today });
  else await ctx.db.insert('dailyThrottle', { key, lastOn: today });
  return true;
}

/** Until when `key` is busy, or `null`. */
export async function busyUntil(ctx: MutationCtx, key: string): Promise<number | null> {
  const row = await ctx.db
    .query('dailyThrottle')
    .withIndex('by_key', (q) => q.eq('key', key))
    .unique();
  return row?.until ?? null;
}

export async function setBusyUntil(ctx: MutationCtx, key: string, until: number): Promise<void> {
  const row = await ctx.db
    .query('dailyThrottle')
    .withIndex('by_key', (q) => q.eq('key', key))
    .unique();
  if (row) await ctx.db.patch(row._id, { until });
  else await ctx.db.insert('dailyThrottle', { key, until });
}
