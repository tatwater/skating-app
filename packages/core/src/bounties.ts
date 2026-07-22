/**
 * Pure bounty gates (D10/D17/D44) — the two server-enforced create checks, kept here so they're
 * testable in isolation and identical wherever they run. Neither gate involves reputation: a bounty is
 * "someone wants fresh eyes on this lake," and the only junk controls are freshness (decision 8) and a
 * rolling per-requester cap (decision 7).
 *
 * Thresholds live in `reputationConfig.ts`; both functions take the tunable as a parameter so the
 * Convex layer passes the live config value (and tests can pin it).
 */

const HOUR_MS = 60 * 60 * 1000;

/** The one report field the freshness gate reads — when the skater left the ice (D28). */
export interface FreshnessReport {
  skateEndTime: number;
}

/**
 * Is this body **too fresh to bounty** — i.e. does it already have a visible report within
 * `freshHours` (decision 8)? A bounty means "no fresh eyes lately," so a `true` here **blocks** create.
 * Judged on `skateEndTime` (the freshest read of the ice), not report submission time, so a late-synced
 * offline report still counts by when the skater was actually on the ice.
 *
 * Phase-10 upgrade: replace this hard cutoff with a decay-based freshness score (recency × thumbs ×
 * trust × weather-since); that needs weather data to be honest, so Phase 6 uses the hard window.
 */
export function isBodyFreshForBounty(
  reports: readonly FreshnessReport[],
  now: number,
  freshHours: number,
): boolean {
  const cutoff = now - freshHours * HOUR_MS;
  return reports.some((r) => r.skateEndTime >= cutoff);
}

/**
 * May this requester open another bounty — are **fewer than `cap`** of their bounties still counting
 * against the rolling window (decision 7)? Pass the `createdAt`s of the requester's currently-**open**
 * bounties; those created within `windowMs` of `now` count toward the cap. Returns `true` when there's
 * room (strictly `< cap`), so the caller may proceed.
 */
export function withinDailyBountyLimit(
  recentCreatedAts: readonly number[],
  now: number,
  cap: number,
  windowMs: number,
): boolean {
  const cutoff = now - windowMs;
  const active = recentCreatedAts.filter((t) => t >= cutoff).length;
  return active < cap;
}
