/**
 * Pure badge derivation (D50 decision 6) — cosmetic achievements over a stats bag, no Convex. Every
 * count-based badge **gates on a quality signal** (a helpful thumb, a confirmation, a corroboration,
 * a measured reading), never raw volume — the whole point is to reward accurate/appreciated/safe
 * activity, not sheer output (D50). Safety-culture reporting counts too: `straight_shooter` rewards an
 * honest "don't skate" report the community found helpful, so "great ice!" isn't the only path to a
 * badge (D3).
 *
 * Thresholds live in `reputationConfig.ts`. The badge stored in `profiles.badges` is just the family
 * name (earned once, at the first tier); the *tier count* is derived from live stats for display, so
 * retuning `step` never orphans a stored badge.
 */

import { BADGE_LABELS, BADGE_THRESHOLDS, BADGE_TYPES, type BadgeType } from './reputationConfig';

/**
 * Human label for a stored badge slug. Stored `profiles.badges` entries are always known `BadgeType`s,
 * but this stays defensive: an unknown slug (e.g. a retired family from an older build) falls back to a
 * title-cased form rather than throwing, so the badge row never crashes on legacy data.
 */
export function badgeLabel(badge: string): string {
  if (badge in BADGE_LABELS) return BADGE_LABELS[badge as BadgeType];
  return badge
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The quality-gated counts each badge family reads. Every field is already a *qualifying* count — e.g.
 * `reportsWithHelpfulThumbs` is reports that cleared the ≥2-thumb bar, not all reports — so the badge
 * logic here is a pure threshold check with no re-gating.
 */
export interface BadgeStats {
  /** Reports with ≥2 helpful thumbs (or past a trust threshold) → `trusted_reporter`. */
  reportsWithHelpfulThumbs: number;
  /** Bounties fulfilled with a qualifying report → `bounty_hunter`. */
  bountiesFulfilled: number;
  /** Helpful thumbs received across reports **and** hazards → `appreciated`. */
  helpfulThumbsReceived: number;
  /** Your hazards confirmed **and** thumbed helpful by ≥2 people → `hazard_spotter`. */
  hazardsConfirmedHelpful: number;
  /** Hazards reported by **other** people that you confirmed or thumbed → `watchdog`. */
  othersHazardsActedOn: number;
  /** Times your report independently corroborated an accurate report → `corroborator`. */
  reportsCorroborated: number;
  /** Honest **negative** ("don't skate") reports marked helpful → `straight_shooter`. */
  negativeReportsHelpful: number;
  /** Reports carrying **measured** (not estimated) thickness readings → `measured`. */
  measuredReports: number;
}

/** Which stat each badge family thresholds against. */
const BADGE_STAT: Record<BadgeType, keyof BadgeStats> = {
  trusted_reporter: 'reportsWithHelpfulThumbs',
  bounty_hunter: 'bountiesFulfilled',
  appreciated: 'helpfulThumbsReceived',
  hazard_spotter: 'hazardsConfirmedHelpful',
  watchdog: 'othersHazardsActedOn',
  corroborator: 'reportsCorroborated',
  straight_shooter: 'negativeReportsHelpful',
  measured: 'measuredReports',
};

/**
 * How many tiers of a "first, then every `step`" badge a count has reached: `0` if below `first`, else
 * `1 + floor((count − first) / step)`. So `{ first: 10, step: 15 }` gives tier 1 at 10, tier 2 at 25,
 * tier 3 at 40. A non-positive `step` collapses to a single tier at `first` (defensive against a bad
 * Phase-7 config value).
 */
export function badgeTierCount(count: number, threshold: { first: number; step: number }): number {
  if (count < threshold.first) return 0;
  if (threshold.step <= 0) return 1;
  return 1 + Math.floor((count - threshold.first) / threshold.step);
}

/**
 * The badge families a user has earned (tier ≥ 1), in the stable `BADGE_TYPES` order so the stored
 * `profiles.badges` set is deterministic. Pure over the stats bag — the Convex `checkAndAwardBadges`
 * recomputes the bag from live rows and patches the profile, so this is replayable/backfillable (D40).
 */
export function deriveEarnedBadges(stats: BadgeStats): BadgeType[] {
  return BADGE_TYPES.filter(
    (badge) => badgeTierCount(stats[BADGE_STAT[badge]], BADGE_THRESHOLDS[badge]) >= 1,
  );
}
