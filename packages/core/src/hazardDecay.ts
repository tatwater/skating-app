/**
 * Per-type hazard decay (D52, extends D15; calibrated 2026-07-21).
 *
 * Freshness is *derived at read time* from `type` + `lastConfirmedAt` — never stored — so the map
 * always reflects real elapsed time.
 *
 * **The invariant this module exists to protect (D3): decay is _confidence_, not _safety_.**
 * Decay fades a pin toward "unverified — may have changed", never toward "clear". A refrozen lead *is*
 * thin ice; a thawed sheet with a cold overnight skin *is* still rotten. So:
 *   - a `stale` hazard still renders (faded, behind "show older") — it never disappears, and
 *   - no label produced anywhere in the app may imply a decayed hazard is skateable.
 * The second half is enforced in `hazardCopy.ts`, which is the only place allowed to turn a freshness
 * into words.
 *
 * Constants are **hours** (admin-tunable integers, Phase 7 / D49), converted to ms only at the
 * comparison boundary — so tuning stays human-legible and the math stays trivial.
 *
 * Calibration evidence for every row: `plans/phase-9-hazard-research.md` §1–§2 (lakeice.info +
 * a 1,197-post regional corpus). These are literature+community defaults, explicitly refittable once
 * real hazard rows exist.
 */

import { HAZARD_TYPES, type HazardType, isPassageMarker } from './types';

/** Freshness tiers: full strength · lighter · faded-behind-a-toggle. */
export type HazardFreshness = 'fresh' | 'aging' | 'stale';

/**
 * Decay tier. A/B/C/D are the research's behavioral groupings, kept on the row so the admin surface
 * (Phase 7) and the copy layer can reason about *why* a type decays as it does:
 *   A — volatile (refreeze/re-open within a day)      C — structural (persist, often grow)
 *   B — semi-persistent (re-skins, weak spot lingers) D — effectively permanent (bodyFeature candidates)
 * Tier A also carries a "very volatile" sub-case (A*) expressed purely as shorter hours, not a 5th tier.
 */
export type HazardDecayTier = 'A' | 'B' | 'C' | 'D';

export interface HazardDecay {
  tier: HazardDecayTier;
  /** elapsed < freshH → fresh */
  freshH: number;
  /** freshH ≤ elapsed < agingH → aging; ≥ agingH → stale */
  agingH: number;
}

const HOUR_MS = 3_600_000;

/** Hours → milliseconds. The single conversion boundary (see the module note on units). */
export function hoursToMs(hours: number): number {
  return hours * HOUR_MS;
}

/**
 * TUNABLE DEFAULTS — admin-editable in Phase 7 (D49). Durations in HOURS.
 *
 * Keyed by every `HazardType`, so adding a type is a compile error until its decay is decided. That is
 * deliberate: a hazard type with no considered decay rate is a safety gap, not a default.
 */
export const HAZARD_DECAY: Record<HazardType, HazardDecay> = {
  // ── Tier A — volatile. A cold snap or a thaw flips these within a day; refreeze is often overnight.
  // Note the bimodality (research §2): these types both heal *and* re-open fast, which is exactly why
  // their decay is short in both directions and why a refrozen pin must stay on the map.
  open_water: { tier: 'A', freshH: 24, agingH: 72 },
  thin_ice: { tier: 'A', freshH: 24, agingH: 72 },
  overflow_slush: { tier: 'A', freshH: 24, agingH: 72 },
  drain_hole: { tier: 'A', freshH: 24, agingH: 72 },
  wind_hole: { tier: 'A', freshH: 24, agingH: 72 },
  slush_hole: { tier: 'A', freshH: 24, agingH: 72 },

  // ── Tier A* — very volatile. Same-day information only.
  // `thawed_rotten` is the #1 fatality cause (lakeice: ~half of ice fatalities involve thaw conditions).
  // ⚠ Phase 10 must NOT let cold weather heal it — a thawed sheet grows a deceptive hard skin overnight
  // and collapses midday (the "overnight-ice trap"). Its cold multiplier is floored at ≥1; only a human
  // clears it. See research §5, sign-flip 1.
  thawed_rotten: { tier: 'A', freshH: 12, agingH: 36 },
  // A passage marker, not a danger (see `isPassageMarker`). Most volatile of all: "a ridge reasonable to
  // cross in the morning may be a mess a couple hours later" (lakeice).
  ridge_crossing: { tier: 'A', freshH: 12, agingH: 36 },

  // ── Tier B — semi-persistent. Re-skins or consolidates, but the weak spot lingers days.
  wet_crack: { tier: 'B', freshH: 72, agingH: 168 },
  drilled_hole: { tier: 'B', freshH: 72, agingH: 168 },
  shell_area: { tier: 'B', freshH: 72, agingH: 168 },

  // ── Tier C — structural. Don't heal within a season; often grow.
  // ⚠ Phase 10 sign-flip 2: warmth ESCALATES these (a ridge can melt into open water in a 2-day windy
  // warm spell), so their thaw multiplier is ≥1 — the old "structural = weather-insensitive ×1" was
  // wrong. A ridge also rarely reaches "fully healed & safe": it heals into *ice sharks* (a line of
  // refrozen blocks — still a trip/sail hazard), which is a `healing_unsafe` outcome, not removal.
  pressure_ridge: { tier: 'C', freshH: 168, agingH: 504 },
  ice_heave: { tier: 'C', freshH: 168, agingH: 504 },

  // ── Tier D — effectively permanent. Present every season regardless of cold; genuinely
  // weather-insensitive (≈×1 in Phase 10). Strong `bodyFeatures` promotion candidates (D53) so they
  // stop needing re-marking at all.
  spring_current: { tier: 'D', freshH: 336, agingH: 1080 },
  gas_hole: { tier: 'D', freshH: 336, agingH: 1080 },
  reef_hole: { tier: 'D', freshH: 336, agingH: 1080 },
};

/**
 * Freshness for a hazard, given its type, last confirmation and the current time (both epoch ms).
 *
 * A "still here" confirmation resets `lastConfirmedAt`, so this returns `fresh` again. A
 * `lastConfirmedAt` in the future (clock skew) reads as `fresh` rather than throwing — a skewed clock
 * must not make a hazard vanish.
 */
export function deriveHazardFreshness(
  type: HazardType,
  lastConfirmedAt: number,
  now: number,
): HazardFreshness {
  const { freshH, agingH } = HAZARD_DECAY[type];
  const elapsed = now - lastConfirmedAt;
  if (elapsed < hoursToMs(freshH)) return 'fresh';
  if (elapsed < hoursToMs(agingH)) return 'aging';
  return 'stale';
}

/**
 * Stale hazards are hidden behind a "show older" toggle — **hidden, never removed** (D3). The pin still
 * exists and still renders once the toggle is on; this only governs the default view.
 *
 * ⚠ For a **passage marker** this is only half the answer — see {@link isPassageExpired}, the one
 * place in the app where a pin leaves the map on time alone.
 */
export function isHazardVisibleByDefault(freshness: HazardFreshness): boolean {
  return freshness !== 'stale';
}

/**
 * How long a **suggested crossing** survives without anyone saying they got across (D64). Hours.
 *
 * Its own constant rather than the `agingH: 36` above, and the difference is the decision: reusing the
 * freshness tier would make "faded" and "gone" the same instant, so a crossing marked on Saturday
 * morning would stop rendering on Monday evening whether or not a soul had been near the lake. Longer
 * than `agingH` so the marker fades first and expires later; far shorter than any hazard's life,
 * because it is the pin that says *you can go this way*.
 */
export const PASSAGE_EXPIRY_H = 72;

/**
 * **The one place a pin leaves the map on time alone** (D64), and it needs to be conspicuous precisely
 * because it contradicts the rule beside it.
 *
 * A hazard fades to a visible floor and never disappears: absence of evidence *keeps it alive*, because
 * assuming a danger is still there is the recoverable mistake. A `ridge_crossing` is not a danger, it is
 * a **passage marker** — "reported crossable" — and there the same rule points the other way. A marker
 * placed in November still saying "you can get across here" in March, with nobody having looked since,
 * walks a skater onto ice no one has checked. So for passage markers, and only for them, absence of
 * evidence **kills the pin**.
 *
 * Getting a crossing wrong in the *remove* direction costs a longer walk. Getting it wrong in the *keep*
 * direction can cost a life. The bias has to fall toward the recoverable one, which is the opposite bias
 * from every other pin in the app.
 *
 * Returns `false` for anything that isn't a passage marker — a hazard never expires.
 */
export function isPassageExpired(type: HazardType, lastConfirmedAt: number, now: number): boolean {
  if (!isPassageMarker(type)) return false;
  return now - lastConfirmedAt >= hoursToMs(PASSAGE_EXPIRY_H);
}

/** All hazard types in a decay tier — for the Phase 7 admin surface and for grouped UI. */
export function hazardTypesInTier(tier: HazardDecayTier): HazardType[] {
  return HAZARD_TYPES.filter((t) => HAZARD_DECAY[t].tier === tier);
}
