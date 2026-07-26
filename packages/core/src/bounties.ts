/**
 * Pure bounty gates (D10/D17/D44) — the two server-enforced create checks, kept here so they're
 * testable in isolation and identical wherever they run. Neither gate involves reputation: a bounty is
 * "someone wants fresh eyes on this lake," and the only junk controls are freshness (decision 8) and a
 * rolling per-requester cap (decision 7).
 *
 * Thresholds live in `reputationConfig.ts`; both functions take the tunable as a parameter so the
 * Convex layer passes the live config value (and tests can pin it).
 */

import { netThumbsBoost } from './reportFreshness';
import { REPORT_FRESHNESS_PER_THUMB, type TrustClass } from './reputationConfig';

const HOUR_MS = 60 * 60 * 1000;

/** The one report field the freshness gate reads — when the skater left the ice (D28). */
export interface FreshnessReport {
  skateEndTime: number;
}

/**
 * How much longer (as a multiple of the base window) a report from each trust class suppresses bounties —
 * a well-trusted local's read stays "fresh eyes" longer; a brand-new account's less. Tunable (Phase 7).
 */
const TRUST_WINDOW_BOOST: Record<TrustClass, number> = {
  new: -0.5,
  trusted: 0,
  expert: 0.5,
  leader: 1,
};

export interface BountyFreshnessFactors {
  /** helpful − unhelpful thumbs on the report — corroboration extends its freshness. */
  netThumbs: number;
  /** The report author's trust class (`null` ⇒ treated as the lowest, `new`). */
  trustClass: TrustClass | null;
  /**
   * When known, whether a meaningful freeze/thaw has occurred since the report (D56). `true` collapses
   * the window — warming/refreezing weather means the ice may have changed, so fresh eyes are wanted now.
   * **Deferred in v1** (the create mutation can't fetch weather); accepted here so the signal wires in
   * cleanly once it's available.
   */
  weatherChangedIceSince?: boolean;
}

/**
 * The **decay-based bounty-freshness window** (Phase 10 / §7c, D56) — replaces the hard `FRESH_REPORT_HOURS`
 * cutoff. A report suppresses bounties for `base × (1 + thumbBoost + trustBoost)` hours, so a
 * well-corroborated, trusted read holds bounties off longer than a lone stale one — and weather that
 * likely changed the ice reopens them immediately. Never negative.
 *
 * D59 refactor: the thumbs term now comes from the **shared** `netThumbsBoost` primitive that report/path
 * freshness also uses (same clamp, same ¼-per-thumb weight), so the two can't drift. The *policy* stays
 * bounty-specific and deliberately different from `reportFreshness`: a trust-class window boost (a
 * bounty asks "whose read is it?"), **no** corroboration term, and weather that changed the ice
 * **collapses the window outright** rather than multiplying it down — a bounty exists to summon fresh
 * eyes, so a changed lake should reopen it now, where a path should merely fade.
 */
export function bountyFreshWindowHours(baseHours: number, f: BountyFreshnessFactors): number {
  if (f.weatherChangedIceSince) return 0; // ice likely changed ⇒ fresh eyes wanted now
  const thumbBoost = netThumbsBoost(f.netThumbs, REPORT_FRESHNESS_PER_THUMB); // each net thumb ±¼ window, bounded
  const trustBoost = f.trustClass ? TRUST_WINDOW_BOOST[f.trustClass] : TRUST_WINDOW_BOOST.new;
  return Math.max(0, baseHours * (1 + thumbBoost + trustBoost));
}

/** Does this report still suppress a new bounty — is it inside its decay-based freshness window? */
export function reportSuppressesBounty(
  skateEndTime: number,
  now: number,
  baseHours: number,
  f: BountyFreshnessFactors,
): boolean {
  return now - skateEndTime < bountyFreshWindowHours(baseHours, f) * HOUR_MS;
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
