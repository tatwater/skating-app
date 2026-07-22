/**
 * Phase-6 reputation / bounty / recommended-feed tuning surface (D50/D10/D17/D44) — **one file**.
 *
 * Everything a non-engineer might retune lives here so the Phase-7 admin UI can bind controls to a
 * single module (the way D49's display curve is single-sourced in `display.ts`). The pure logic in
 * `reputation.ts` / `badges.ts` / `bounties.ts` / `recommended.ts` reads these constants; the Convex
 * layer takes them as the defaults for the ledger writes and gates. The **backfill script** recomputes
 * every derived value (`reputationPoints` / `bountyPoints` / `badges`) from the `pointEvents` ledger,
 * so changing a weight or threshold mid-alpha is a replay, not a migration (D40).
 *
 * These are **approved starting points** (founder, 2026-07-21), not measured optima — calibrate once
 * alpha shows the real point/age distribution.
 *
 * The three vocabularies (`TRUST_CLASSES`, `BADGE_TYPES`, `RATING_TARGET_TYPES`) live here rather than
 * in the backend `lib/enums.ts` because the *pure* derivations (`deriveTrustClass`, `deriveEarnedBadges`)
 * reference them and `@skating/core` cannot import from Convex — and the web/mobile trust chip, badge
 * row, and thumbs control all render them (the same "shared vocab ⇒ core" rule that moved
 * `THICKNESS_METHODS` here).
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ─────────────────────────────────────────────────────────────────────────────
// Trust classes (D50 decision 5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The cosmetic reputation tiers, ascending. Rendered as a chip on the profile and as a colored ring +
 * corner badge everywhere else (never a raw number, except to admins). `null` (no class) is a real
 * fourth state — a below-`trusted` account past the New window shows no chip at all; since the model is
 * boost-only, scores never go negative, so there is no "distrusted" tier (D50).
 */
export const TRUST_CLASSES = ['new', 'trusted', 'expert', 'leader'] as const;
export type TrustClass = (typeof TRUST_CLASSES)[number];

/**
 * Point floors for each class (inclusive). Checked top-down, so a fast earner who crosses `expert` in
 * their first week is `expert`, not `new` — points always win over account age.
 */
export const TRUST_CLASS_THRESHOLDS: Record<Exclude<TrustClass, 'new'>, number> = {
  trusted: 15,
  expert: 60,
  leader: 150,
};

/**
 * A fresh account shows the `new` chip for this long even with zero qualifying signals — a welcome, not
 * a verdict. Past this window and still below `trusted`, the chip disappears (decision 5: we never
 * render "Not trusted").
 */
export const NEW_ACCOUNT_WINDOW_MS = 14 * DAY_MS;

/** Chip / ring color per class — hex so both web (CSS) and mobile (RN) consume it unchanged. */
export const TRUST_CLASS_COLORS: Record<TrustClass, string> = {
  new: '#64748b', // slate-500
  trusted: '#3b82f6', // blue-500
  expert: '#8b5cf6', // violet-500
  leader: '#f59e0b', // amber-500
};

/** Human labels for the chip. */
export const TRUST_CLASS_LABELS: Record<TrustClass, string> = {
  new: 'New',
  trusted: 'Trusted',
  expert: 'Expert',
  leader: 'Leader',
};

// ─────────────────────────────────────────────────────────────────────────────
// Point weights (D50 decision 2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ledger deltas per trust `reason`, all bumping `reputationPoints`. Peer/quality signals
 * (`helpful_thumb`, corroboration) deliberately outweigh raw volume (`report_submitted`) — reputation is
 * earned from the community's reaction, not from posting a lot (D50). `unhelpful` never appears here
 * (boost-only). `bounty_fulfilled` is intentionally absent: it is a *separate currency* that bumps
 * `bountyPoints`, valued per-bounty by `bounties.rewardPoints` (decision 11), defaulted below.
 */
export const POINT_WEIGHTS = {
  report_submitted: 2, // baseline observation; cheap on purpose
  photo_evidence: 3, // report carries ≥1 photo; once per report — self-verifying evidence
  measured_thickness: 2, // report carries ≥1 measured (not estimated) reading; once per report — take-my-word rigor, so below photo
  helpful_thumb: 5, // a peer thumbed your report or hazard helpful
  report_corroborated: 4, // independent in-window same-body agreement (both authors)
  hazard_confirmed: 1, // the confirmer's helpful act
  hazard_corroborated: 4, // your hazard confirmed by ≥2 peers (author side)
} as const;

export type TrustPointReason = keyof typeof POINT_WEIGHTS;

/** Default `bountyPoints` reward for fulfilling a bounty — the separate achievement currency (D17). */
export const DEFAULT_BOUNTY_REWARD_POINTS = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Corroboration (D50 decision 3)
// ─────────────────────────────────────────────────────────────────────────────

/** Agreeing reports over a freeze cycle reinforce trust, so the agreement window is generous. */
export const CORROBORATION_WINDOW_MS = 7 * DAY_MS;

/**
 * Cap on how many prior reports a **single** `create` may corroborate — bounding one submission's
 * one-shot `report_corroborated` gain (≤ 3 × the weight) so a burst of reports on a lake can't hand a new
 * reporter a windfall. This bounds the *submitter's* per-create fan-out only: a prior report still accrues
 * one corroboration per later agreeing report over time (unbounded by design — that accumulation IS the
 * corroboration signal the recommended feed reads via `pointEvents.by_ref`).
 */
export const CORROBORATION_MAX_PER_REPORT = 3;

/** A hazard's `confirmCount` (peers, author excluded) must reach this for the author's `hazard_corroborated` boost. */
export const HAZARD_CORROBORATION_MIN_CONFIRMS = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Ratings / moderation (D50 decision 4)
// ─────────────────────────────────────────────────────────────────────────────

/** What a thumb can target — the polymorphic `reportRatings` discriminator (decision 4). */
export const RATING_TARGET_TYPES = ['report', 'hazard'] as const;
export type RatingTargetType = (typeof RATING_TARGET_TYPES)[number];

/**
 * Net-unhelpful (unhelpful − helpful) at or beyond which a target is routed to the mod queue via an
 * `auto_low_quality` content flag. It is **never hidden** — visibility of safety content is not gated by
 * score (D3); the flag just surfaces it for a human (Phase 7 queue).
 */
export const AUTO_LOW_QUALITY_NET_UNHELPFUL = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Badges (D50 decision 6) — every count-based badge gates on a quality signal, never raw volume
// ─────────────────────────────────────────────────────────────────────────────

/** The cosmetic badge vocabulary (`profiles.badges` is a free-form `string[]`; this is its schema). */
export const BADGE_TYPES = [
  'trusted_reporter',
  'bounty_hunter',
  'appreciated',
  'hazard_spotter',
  'watchdog',
  'corroborator',
  'straight_shooter',
  'measured',
] as const;
export type BadgeType = (typeof BADGE_TYPES)[number];

/** Human labels for the badge row (title-cased; the raw slug is never shown). */
export const BADGE_LABELS: Record<BadgeType, string> = {
  trusted_reporter: 'Trusted Reporter',
  bounty_hunter: 'Bounty Hunter',
  appreciated: 'Appreciated',
  hazard_spotter: 'Hazard Spotter',
  watchdog: 'Watchdog',
  corroborator: 'Corroborator',
  straight_shooter: 'Straight-Shooter',
  measured: 'Measured',
};

/**
 * Count thresholds a stat must reach to earn each tiered badge. A "first, then every N" family is
 * expressed as `{ first, step }`: earned at `first`, then again at `first + step`, `first + 2·step`, …
 * The pure `deriveEarnedBadges` returns one entry per family (highest tier reached); the tier count is
 * derived, not enumerated, so retuning a step never orphans a stored badge.
 */
export const BADGE_THRESHOLDS: Record<BadgeType, { first: number; step: number }> = {
  trusted_reporter: { first: 1, step: 5 }, // reports with ≥2 helpful thumbs
  bounty_hunter: { first: 1, step: 5 }, // bounties fulfilled with a qualifying report
  appreciated: { first: 10, step: 15 }, // helpful thumbs across reports + hazards (10/25/40/…)
  hazard_spotter: { first: 1, step: 5 }, // hazards confirmed AND thumbed helpful by ≥2 people
  watchdog: { first: 10, step: 10 }, // hazards (of others) you confirmed or thumbed
  corroborator: { first: 1, step: 5 }, // your report independently corroborated an accurate report
  straight_shooter: { first: 1, step: 5 }, // an honest "don't skate" report marked helpful
  measured: { first: 3, step: 5 }, // reports carrying measured (not estimated) thickness
};

// ─────────────────────────────────────────────────────────────────────────────
// Bounties (D10/D17/D44 decisions 7–12)
// ─────────────────────────────────────────────────────────────────────────────

/** A bounty is blocked on a body with a visible report this fresh — "no fresh eyes lately" (decision 8). */
export const FRESH_REPORT_HOURS = 48;

/** Max open bounties one requester may hold in a rolling 24h — the only junk control (decision 7). */
export const MAX_OPEN_BOUNTIES_PER_DAY = 3;

/** The rolling window the daily-open cap is measured over. */
export const BOUNTY_DAILY_WINDOW_MS = DAY_MS;

/** Default bounty lifetime before the expiry sweep flips `open → expired` (decision 12; Phase-7 field). */
export const DEFAULT_BOUNTY_LIFETIME_MS = 30 * DAY_MS;

/** Eligibility fan-out looks back this far for "skated here recently" authors on create (decision 9). */
export const BOUNTY_ELIGIBILITY_WINDOW_HOURS = 72;

// ─────────────────────────────────────────────────────────────────────────────
// Recommended feed (decisions 13–15)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The "exceptional" bar (decision 14). It breaks distance / quality / thickness filters but never
 * recency, blocks, or moderation. The gate is trust + corroboration, **not** a lone great report (D3) —
 * otherwise we amplify one unverified claim and build a machine for wasted trips.
 */
export const RECOMMENDED_MIN_CORROBORATION = 3; // corroborationCount > 2
export const RECOMMENDED_MIN_TRUST_CLASS: TrustClass = 'expert';
export const RECOMMENDED_MIN_PHOTOS = 2;
export const RECOMMENDED_RECENCY_HOURS = 48;

/** Frequency cap + dedup (decision 15): ≤ this many unique bodies recommended to a user per day. */
export const RECOMMENDED_MAX_BODIES_PER_DAY = 2;

/** When multiple reports qualify for the same body, bundle at most this many into one card (decision 15). */
export const RECOMMENDED_BUNDLE_SIZE = 2;
