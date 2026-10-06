/**
 * Once per key per New York day, or busy until a time (A06i) — operator alerts use the first, the
 * full history fill the second.
 */

import type { MutationCtx } from '../_generated/server';
import { newYorkDate } from './seasonWatchEmails';

async function throttleRow(ctx: MutationCtx, key: string) {
  return await ctx.db
    .query('dailyThrottle')
    .withIndex('by_key', (q) => q.eq('key', key))
    .unique();
}

async function upsert(
  ctx: MutationCtx,
  key: string,
  fields: { lastOn?: string; until?: number },
  row?: Awaited<ReturnType<typeof throttleRow>>,
) {
  const existing = row === undefined ? await throttleRow(ctx, key) : row;
  if (existing) await ctx.db.patch(existing._id, fields);
  else await ctx.db.insert('dailyThrottle', { key, ...fields });
}

/** Whether `key` is still unused today (New York); marks it used if so. */
export async function firstToday(ctx: MutationCtx, key: string): Promise<boolean> {
  const today = newYorkDate(Date.now());
  const row = await throttleRow(ctx, key);
  if (row?.lastOn === today) return false;
  await upsert(ctx, key, { lastOn: today }, row);
  return true;
}

/** Until when `key` is busy, or `null`. */
export async function busyUntil(ctx: MutationCtx, key: string): Promise<number | null> {
  return (await throttleRow(ctx, key))?.until ?? null;
}

export async function setBusyUntil(ctx: MutationCtx, key: string, until: number): Promise<void> {
  await upsert(ctx, key, { until });
}
