/**
 * Once per key per New York day (A06i) — operator alerts and the history fill share it.
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
