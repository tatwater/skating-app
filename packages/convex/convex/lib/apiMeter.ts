/**
 * Outbound third-party API metering (N6h / **D158**).
 *
 * ## Why this exists
 *
 * D158 makes buying Open-Meteo's paid plan conditional on *"sustained free-tier use above ~7,000
 * calls/day"* — a trigger that could not fire, because **nothing in the weather path counted
 * anything**. No token bucket, no rate limiter, no metric. N6h adds a corpus-wide daily cron on top
 * of the existing drawer-open fetches, which is exactly the change that makes the ceiling reachable,
 * so the counter ships with it rather than after it.
 *
 * ## It is a meter, not a limiter — and that is a decision, not an omission
 *
 * Nothing blocks on these numbers. A limiter that silently dropped weather fetches at some threshold
 * would degrade the app to protect a budget the founder would rather simply pay, and it would do so
 * invisibly: blank strips, stale decay, a filter quietly missing lakes. Counting surfaces the
 * decision and leaves it to a human, which is the same posture as the bounty gate that had to stop
 * throwing so suppressed events would still be visible (Phase 7).
 *
 * ## Weighted vs raw
 *
 * Open-Meteo bills fractionally — roughly `ceil(days / 14) × (variables / 10)` — so one 92-day
 * backfill with 11 variables is ~7 billed calls in a single HTTP request. Recording both means the
 * trigger reads the number the provider actually counts, while the raw count stays available for
 * "are we hammering someone" questions that are about request rate rather than billing.
 */

import { internal } from '../_generated/api';
import type { ActionCtx, MutationCtx } from '../_generated/server';

const DAY_MS = 86_400_000;

/** Open-Meteo's own weighting thresholds, from their pricing page. */
const BILLED_DAYS_PER_CALL = 14;
const BILLED_VARS_PER_CALL = 10;

/** UTC midnight — a *billing* day, which is not the lake's local day and must not be confused with it. */
export function apiCallDayMs(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS;
}

/**
 * Open-Meteo's fractional call weight for one request.
 *
 * `ceil` on the day term because their published example — *"2 weeks of data with 15 weather
 * variables will be calculated as 1.5 API calls, while 4 weeks of data equals 3.0"* — steps at each
 * two-week boundary rather than scaling smoothly. The variable term does scale smoothly, and a
 * request under ten variables is never cheaper than one call.
 */
export function openMeteoCallWeight(variableCount: number, dayCount: number): number {
  const dayTerm = Math.max(1, Math.ceil(dayCount / BILLED_DAYS_PER_CALL));
  const varTerm = Math.max(1, variableCount / BILLED_VARS_PER_CALL);
  return dayTerm * varTerm;
}

/**
 * Add one metered request to today's row for `provider`.
 *
 * ⚠ **Read-modify-write inside a mutation, which is safe here and would not be everywhere.** Convex
 * mutations are serializable, so two concurrent fetches cannot interleave a lost update on the same
 * row. The cost is that every metered call contends on one document per provider per day; at the
 * volumes D158 is watching for (single-digit thousands a day) that is nothing, and if it ever became
 * hot the fix is sharding the row by hour, not abandoning the count.
 */
export async function recordApiCall(
  ctx: MutationCtx,
  provider: string,
  weightedCalls: number,
  nowMs: number,
): Promise<void> {
  const dayMs = apiCallDayMs(nowMs);
  const existing = await ctx.db
    .query('externalApiCalls')
    .withIndex('by_provider_day', (q) => q.eq('provider', provider).eq('dayMs', dayMs))
    .first();
  if (existing) {
    await ctx.db.patch(existing._id, {
      calls: existing.calls + 1,
      weightedCalls: existing.weightedCalls + weightedCalls,
      updatedAt: nowMs,
    });
    return;
  }
  await ctx.db.insert('externalApiCalls', {
    provider,
    dayMs,
    calls: 1,
    weightedCalls,
    updatedAt: nowMs,
  });
}

/**
 * Count an Open-Meteo request from inside an **action** (the only context that can fetch).
 *
 * Shared by every Open-Meteo call site — `weather.ts`'s cached hourly fetch and `conditions.ts`'s
 * uncached point lookup — so D158's trigger reads *all* of our traffic rather than the subset that
 * happened to be interesting. The backing mutation lives in `weather.ts` because `lib/` holds
 * helpers, not registered functions.
 *
 * ⚠ **Metering must never take the fetch down with it.** A failure here loses a data point on a
 * budget dashboard; a failure that propagated would blank a weather strip. So it swallows, loudly.
 */
export async function meterOpenMeteo(
  ctx: ActionCtx,
  variableCount: number,
  dayCount: number,
): Promise<void> {
  try {
    await ctx.runMutation(internal.weather.recordOpenMeteoCallMutation, {
      weightedCalls: openMeteoCallWeight(variableCount, dayCount),
      nowMs: Date.now(),
    });
  } catch (err) {
    console.warn('externalApiCalls metering failed (fetch continues)', err);
  }
}
