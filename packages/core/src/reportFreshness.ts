/**
 * The shared report-freshness primitive (D59, Phase 8) — **the report is the unit of decay**.
 *
 * A GPS path has no freshness of its own: it is a report's trusted extent
 * (`reports.activityId → gpsActivities.path`), so how faded it draws must be a pure function of how
 * fresh its *report* is. Keeping two copies of "recency × usefulness × weather-since" is exactly the
 * kind of duplication that drifts, so both consumers read **one** number from here.
 *
 * Three things share this module:
 *
 * 1. **`reportFreshness`** → `0..1`, the blended decay a report's own display and its path's opacity
 *    both consume. Same report, same instant ⇒ provably the same number.
 * 2. **`pathOpacity`** → `reportFreshness` clamped to a **min-opacity floor** (D3): a stale path fades
 *    but never vanishes, because an empty stretch of lake reads as "all clear" and we never assert that.
 * 3. **The bounded primitives** (`netThumbsBoost`) that `bounties.ts` also calls. Bounties keep their
 *    own *policy* — a bounty answers "does anyone need fresh eyes here?", not "how faded is this
 *    path" — but they no longer carry a private copy of the thumbs math (D59).
 *
 * Every tunable lives in `reputationConfig.ts` and is surfaced read-only in `/admin/tuning`
 * (edit-and-redeploy, the Phase 7 posture — no runtime `appConfig` table).
 */

import {
  NET_THUMBS_MAX,
  NET_THUMBS_MIN,
  PATH_MIN_OPACITY,
  REPORT_FRESHNESS_HALF_LIFE_HOURS,
  REPORT_FRESHNESS_MAX_EXTENSION,
  REPORT_FRESHNESS_PER_CORROBORATION,
  REPORT_FRESHNESS_PER_THUMB,
  REPORT_FRESHNESS_WEATHER_MULTIPLIER,
  REPORT_MAX_CORROBORATION,
} from './reputationConfig';

const HOUR_MS = 60 * 60 * 1000;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * The **bounded** net-thumbs signal (helpful − unhelpful), shared by bounty freshness and report
 * freshness. Clamped both ways so neither a brigade of helpful thumbs nor a pile-on of unhelpful ones
 * can run the window away from what elapsed time says. Asymmetric on purpose: usefulness extends
 * further up than down, because a corroborated read genuinely stays relevant longer while an
 * unpopular one is still a first-hand observation (D50 is boost-only).
 */
export function clampedNetThumbs(netThumbs: number): number {
  return clamp(netThumbs, NET_THUMBS_MIN, NET_THUMBS_MAX);
}

/**
 * How much the community's reaction extends a report's freshness window, as a fraction of the base.
 * `perThumb` is passed by the caller so each consumer keeps its own weighting (bounties value a thumb
 * at ¼ of their base window) while sharing the bound.
 */
export function netThumbsBoost(netThumbs: number, perThumb: number): number {
  return clampedNetThumbs(netThumbs) * perThumb;
}

/** The signals that decide how fresh a report reads. Every one is optional except the skate time. */
export interface ReportFreshnessSignals {
  /** When the skater left the ice (D28) — the freshest read the report describes. */
  skateEndTime: number;
  /** helpful − unhelpful across the report's thumbs (`ratings.tallyThumbs`). Defaults to 0. */
  netThumbs?: number;
  /** Independent in-window agreeing reports (`pointEvents.by_ref`, `report_corroborated`). Defaults to 0. */
  corroborationCount?: number;
  /**
   * Whether a meaningful freeze/thaw has happened since the skate (`weather.weatherExplainsIceChange`).
   * `true` means the report describes ice that may no longer exist, so it ages sharply — but **not** to
   * zero: weather is evidence about the ice, never a reason to stop showing what someone saw.
   * `undefined` (no weather data) is fail-open — treated as "can't tell", no penalty.
   */
  weatherExplainsIceChange?: boolean;
}

/**
 * How fresh a report reads **right now**, on `0..1` — 1 at the moment the skater left the ice, decaying
 * by half every `REPORT_FRESHNESS_HALF_LIFE_HOURS`.
 *
 * Usefulness (thumbs + corroboration) **stretches the half-life** rather than adding to the output, so
 * the result stays a genuine decay curve: strictly decreasing in age no matter what the community
 * signals say. A corroborated report stays current longer; it never becomes *fresher* than a brand-new
 * one, and it never stops aging.
 *
 * A `skateEndTime` in the future (clock skew, or a report filed mid-skate) reads as 1 rather than
 * amplifying past full.
 *
 * Range is `[0, 1]`, not `(0, 1]`: past roughly a thousand half-lives the exponential underflows to a
 * true 0 in float64. That is fine and deliberate — the never-hide guarantee is **`pathOpacity`'s
 * floor**, not a nonzero freshness, so it holds at any age (see `pathOpacity`).
 */
export function reportFreshness(signals: ReportFreshnessSignals, now: number): number {
  const ageHours = (now - signals.skateEndTime) / HOUR_MS;
  if (!(ageHours > 0)) return 1; // future / just now / NaN-safe

  const thumbs = netThumbsBoost(signals.netThumbs ?? 0, REPORT_FRESHNESS_PER_THUMB);
  const corroboration =
    clamp(signals.corroborationCount ?? 0, 0, REPORT_MAX_CORROBORATION) *
    REPORT_FRESHNESS_PER_CORROBORATION;
  // Bounded like the bounty window: usefulness can stretch the half-life, never unboundedly — and
  // **floored at 0, so the stretch is boost-only**. This is a deliberate divergence from
  // `bountyFreshWindowHours`, where net-unhelpful thumbs *shorten* the window: there, shortening
  // summons fresh eyes sooner (safety-positive), while here it would let downvotes fade a person's
  // path off the map. Unhelpful marks route to moderation (`AUTO_LOW_QUALITY_NET_UNHELPFUL`), not to
  // making safety content disappear faster (D3/D50).
  const extension = clamp(thumbs + corroboration, 0, REPORT_FRESHNESS_MAX_EXTENSION);
  const halfLife = REPORT_FRESHNESS_HALF_LIFE_HOURS * (1 + extension);

  const decayed = 0.5 ** (ageHours / halfLife);
  // Weather that plausibly changed the ice ages the report hard (the same signal that reopens a
  // bounty) — but multiplicatively, so it can never zero out a first-hand observation.
  const weathered = signals.weatherExplainsIceChange
    ? decayed * REPORT_FRESHNESS_WEATHER_MULTIPLIER
    : decayed;
  return clamp(weathered, 0, 1);
}

/**
 * Map a report's freshness to the opacity its GPS path draws at (D58/D59).
 *
 * Floored at `PATH_MIN_OPACITY` — the same never-hide invariant the hazard and report layers carry
 * (D3). A months-old track still shows faintly: "someone skated here a while ago" is information; a
 * blank lake is a claim we have no business making.
 */
export function pathOpacity(freshness: number): number {
  const f = Number.isFinite(freshness) ? clamp(freshness, 0, 1) : 0;
  return PATH_MIN_OPACITY + (1 - PATH_MIN_OPACITY) * f;
}
