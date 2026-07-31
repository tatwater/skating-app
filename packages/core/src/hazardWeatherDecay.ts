/**
 * Weather-driven hazard decay (D56, extends D52). Layered *on top of* the base per-type decay
 * (`hazardDecay.ts`, which stays weather-free): it modulates how fast confidence in a hazard erodes
 * based on what the weather has *done since it was last confirmed*.
 *
 * **Decay is confidence, not safety (D3 — the invariant this module inherits).** The multiplier scales
 * *confidence loss*, never a safety claim:
 *   - `multiplier > 1` → lose confidence faster (fade toward `aging`/`stale` sooner — "conditions changed
 *     a lot, this report may not reflect reality, go re-check").
 *   - `multiplier < 1` → stay confident longer (persist — "weather preserved this").
 *   - `multiplier = 1` → no weather effect / **fail-open** (missing or empty weather).
 *
 * `effectiveAge = elapsed × multiplier`, then `deriveHazardFreshness` runs on `effectiveAge`.
 *
 * **The three sign-flips a naïve "colder → safer" model gets dangerously wrong (locked in D52 §5):**
 *  1. `thawed_rotten` must NOT heal on cold — cold never earns it a *persistence discount* (`≥ 1`); it
 *     ages on its short base clock, and the never-hide bound keeps the pin visible. Only a human clears it.
 *  2. Ridges *escalate* in thaws — `pressure_ridge`/`ice_heave` get a thaw multiplier `≥ 1` (a ridge can
 *     melt to open water in a 2-day warm spell, so the old pin is unreliable → fade to prompt a recheck).
 *  3. Snow **lowers confidence, never accelerates decay** — snowfall only *dampens* cold's acceleration
 *     (snow insulates → refreeze less certain) and sets a `snowHidden` flag; it can never push m above 1.
 *
 * **Never-hide invariant (D56):** weather-acceleration may age a pin (fresh→aging) but can **never** push
 * it past `aging` into hidden/`stale` — only real elapsed time (+ a human `fully_healed`) retires a pin.
 * Enforced in `weatherAdjustedFreshness`. Weather-*deceleration* (persisting a pin) is always allowed — it
 * only makes a hazard *more* visible, never less.
 *
 * Magnitudes are literature/anecdote defaults (Ashton's ~1″ ice per 15 freezing-degree-days; thaw ~30%
 * faster) and are **explicitly tunable** — admin-liftable in Phase 7 (D49), refittable once real hazard
 * rows exist. The signs are locked; the numbers are not. See `plans/phase-9-hazard-research.md` §5 and
 * `plans/phase-10-weather.md` §4.
 */

import { deriveHazardFreshness, type HazardFreshness } from './hazardDecay';
import type { HazardType } from './types';
import type { WeatherSinceSummary } from './weather';

/**
 * How a hazard type responds to weather — a distinct axis from the A/B/C/D base-decay tiers.
 *   - `refreeze_healed` — volatile: cold likely refroze it (fade faster), thaw keeps it open (persist).
 *   - `structural` — ridges/heaves: thaw escalates/melts them (fade to recheck), cold just persists.
 *   - `rotten` — thawed_rotten: thaw worsens it (persist the warning), cold never preserves it (≥1).
 *   - `weather_insensitive` — springs/gas/reef holes: genuinely ≈×1 regardless of weather (D53 candidates).
 */
export type HazardWeatherResponse =
  | 'refreeze_healed'
  | 'structural'
  | 'rotten'
  | 'weather_insensitive';

/** Weather-response class per hazard type. Exhaustive by construction (a new type is a compile error). */
export const HAZARD_WEATHER_RESPONSE: Record<HazardType, HazardWeatherResponse> = {
  // Volatile refreeze-healed — refreeze in cold, re-open in wind/thaw.
  open_water: 'refreeze_healed',
  thin_ice: 'refreeze_healed',
  overflow_slush: 'refreeze_healed',
  drain_hole: 'refreeze_healed',
  wind_hole: 'refreeze_healed',
  slush_hole: 'refreeze_healed',
  wet_crack: 'refreeze_healed', // working cracks reopen nightly, close/refreeze by day
  drilled_hole: 'refreeze_healed', // re-skins overnight in cold
  shell_area: 'refreeze_healed', // forms after a thaw; consolidates in cold
  // Rotten — the #1 killer; its own rule (sign-flip 1).
  thawed_rotten: 'rotten',
  // Structural — thaw escalates (sign-flip 2).
  pressure_ridge: 'structural',
  ice_heave: 'structural',
  ridge_crossing: 'structural', // a ridge passage marker — same physics, thaw changes it fast
  // Weather-insensitive permanent sources.
  spring_current: 'weather_insensitive',
  gas_hole: 'weather_insensitive',
  reef_hole: 'weather_insensitive',
};

export interface WeatherDecayOptions {
  /** Freezing-degree-hours for a "full" cold signal (normFDH = 1). ~5 freezing-degree-days. Default 120. */
  fdhScaleHours?: number;
  /** Thaw-degree-hours for a "full" thaw signal. Smaller than FDH (thaw ~30% faster). Default 90. */
  tdhScaleHours?: number;
  /** Cold-acceleration strength for refreeze-healed types. Default 1.0. */
  refreezeColdK?: number;
  /** Thaw-persistence strength for refreeze-healed types. Default 0.5. */
  refreezeThawK?: number;
  /** Thaw-escalation strength for structural types (ridges). Default 0.75. */
  structuralThawK?: number;
  /** Cold-acceleration strength for rotten (MILD — needs lots of cold to age). Default 0.25. */
  rottenColdK?: number;
  /** Rotten's cold signal uses this × the base FDH scale (so it needs even more cold). Default 3. */
  rottenColdScaleMult?: number;
  /** Thaw-persistence strength for rotten (a thaw worsens rot → keep the warning up). Default 0.5. */
  rottenThawK?: number;
  /** Snowfall (cm) since report that fully damps cold's signal toward `snowDampMin`. Default 10. */
  snowDampFullCm?: number;
  /** Cold signal is never damped below this fraction by snow. Default 0.3. */
  snowDampMin?: number;
  /** Snowfall (cm) since report at/above which a hazard is flagged "possibly snow-hidden". Default 1. */
  snowHideCm?: number;
  /** Lower clamp on the multiplier (most persistence) for non-structural types. Default 0.5. */
  multiplierFloor?: number;
  /** Upper clamp on the multiplier (most acceleration) for volatile/structural types. Default 2.0. */
  multiplierCap?: number;
  /** Upper clamp for rotten — milder, so only lots of extended cold ages it. Default 1.5. */
  rottenMultiplierCap?: number;
  /**
   * How much a **shallow** body amplifies the thaw term (D69). 1 = no effect; default 1.5 = a thaw
   * counts half again as much on a shallow sheet. Never applied to a cold term — see `BodyDecayContext`.
   */
  shallowThawK?: number;
}

/**
 * Facts about the **body** the hazard sits on, as distinct from the tuning knobs in
 * `WeatherDecayOptions`. Kept a separate parameter on purpose: `WeatherDecayOptions` is the set the
 * Phase 7b tuning page enumerates as "the magnitudes we might refit", and a fact about a lake is not a
 * magnitude. All fields optional ⇒ every existing call site is unchanged and reads as "not shallow".
 */
export interface BodyDecayContext {
  /**
   * Whether this body is shallow — its depth says so (`isShallowDepth`) **or** a moderator flagged it
   * with the `shallow_early_thaw` `bodyFeature`. Shallow water melts from the bottom and goes out
   * early, so a thaw counts for more here.
   *
   * **It amplifies the thaw term only, never the cold term (D69).** Shallow water also *freezes* earlier,
   * so a symmetric "more volatile" amplifier was the obvious model — and its cold half would have sped
   * confidence loss toward `stale` on exactly the small ponds where a skater is least protected.
   *
   * What the one-sided version guarantees, stated per response class because that is the honest form: a
   * shallow `structural` multiplier is **≥** its deep counterpart (thaw is added — prompt the recheck
   * sooner), a shallow `refreeze_healed`/`rotten` multiplier is **≤** its deep counterpart (thaw is
   * subtracted — persist the warning longer), `weather_insensitive` is identical, and with no thaw at all
   * nothing changes for any type. It therefore cannot flip any of the three locked sign-flips.
   *
   * *Not* guaranteed: that the multiplier only moves further from 1. In mixed weather where cold wins
   * narrowly, a deep body can read just above 1 while a shallow one reads just below — and that crossing
   * is the correct answer, since the same period nets "refreezing" for a deep lake and "thawing" for a
   * shallow one. Recorded because the plan claimed the stronger invariant and a property test refuted it.
   */
  isShallow?: boolean;
}

export interface WeatherDecaySignal {
  /** effectiveAge = elapsed × multiplier. Confidence-loss scale (see module note). Always finite, > 0. */
  multiplier: number;
  /** Snowfall-since suggests the hazard may be snow-covered — a confidence caveat, never a decay change. */
  snowHidden: boolean;
}

/**
 * The shallow thaw amplifier's default (D69), exported because the Phase 7b tuning page shows the value
 * that is actually running — every other magnitude in `DEFAULTS` is only ever read through the options
 * object, but this one has a card. One constant, referenced by `DEFAULTS` below, so they can't diverge.
 */
export const SHALLOW_THAW_K = 1.5;

const DEFAULTS: Required<WeatherDecayOptions> = {
  fdhScaleHours: 120,
  tdhScaleHours: 90,
  refreezeColdK: 1.0,
  refreezeThawK: 0.5,
  structuralThawK: 0.75,
  rottenColdK: 0.25,
  rottenColdScaleMult: 3,
  rottenThawK: 0.5,
  snowDampFullCm: 10,
  snowDampMin: 0.3,
  snowHideCm: 1,
  multiplierFloor: 0.5,
  multiplierCap: 2.0,
  rottenMultiplierCap: 1.5,
  shallowThawK: SHALLOW_THAW_K,
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Whether snowfall-since suggests the hazard may be snow-covered ("possibly snow-hidden"). Type-independent
 * (snow can cap a gas hole, bury a folded ridge, or hide thin ice alike). Never affects the multiplier —
 * it is a confidence caveat only (sign-flip 3).
 */
export function isSnowHidden(
  weather: WeatherSinceSummary,
  opts: WeatherDecayOptions = {},
): boolean {
  if (weather.hours === 0) return false;
  const snowHideCm = opts.snowHideCm ?? DEFAULTS.snowHideCm;
  return weather.snowfallCm >= snowHideCm;
}

/**
 * The full weather signal for a hazard type: the confidence-loss `multiplier` + the `snowHidden` caveat.
 * Fail-open: empty weather (`hours === 0`) ⇒ `{ multiplier: 1, snowHidden: false }`.
 */
export function weatherDecaySignal(
  type: HazardType,
  weather: WeatherSinceSummary,
  opts: WeatherDecayOptions = {},
  body: BodyDecayContext = {},
): WeatherDecaySignal {
  if (weather.hours === 0) return { multiplier: 1, snowHidden: false };

  const o = { ...DEFAULTS, ...opts };
  const response = HAZARD_WEATHER_RESPONSE[type];
  const snowHidden = isSnowHidden(weather, o);

  if (response === 'weather_insensitive') {
    return { multiplier: 1, snowHidden };
  }

  const fdh = Math.max(0, weather.freezingDegreeHours);
  const tdh = Math.max(0, weather.thawDegreeHours);
  const snow = Math.max(0, weather.snowfallCm);

  // Snow insulates → refreeze is less certain → damp the cold contribution (never below `snowDampMin`).
  // This is the ONLY thing snow does to the multiplier, and it can only *reduce* cold's acceleration.
  const snowDamp = clamp(1 - snow / o.snowDampFullCm, o.snowDampMin, 1);

  // A shallow body's thaw counts for more — and ONLY its thaw (D69). Applied as a factor on each
  // branch's `thawTerm` rather than on the finished multiplier, which is what makes it structurally
  // impossible for shallowness to touch a cold term or to change any sign: whatever direction the
  // type's thaw response already pointed, this scales the distance travelled in it.
  const shallowK = body.isShallow ? Math.max(0, o.shallowThawK) : 1;

  let multiplier: number;
  switch (response) {
    case 'refreeze_healed': {
      const coldTerm = o.refreezeColdK * (fdh / o.fdhScaleHours) * snowDamp; // ≥ 0 → fade faster
      const thawTerm = o.refreezeThawK * (tdh / o.tdhScaleHours) * shallowK; // ≥ 0 → persist
      multiplier = clamp(1 + coldTerm - thawTerm, o.multiplierFloor, o.multiplierCap);
      break;
    }
    case 'structural': {
      // Thaw escalates (fade to recheck); cold just persists → floored at 1, never a discount.
      const thawTerm = o.structuralThawK * (tdh / o.tdhScaleHours) * shallowK;
      multiplier = clamp(1 + thawTerm, 1, o.multiplierCap);
      break;
    }
    case 'rotten': {
      // Cold never preserves it (coldTerm ≥ 0 ⇒ cold-only never drops below 1); a thaw worsens the rot so
      // the warning persists (thawTerm can pull it below 1). Cold acceleration is MILD and needs a lot of
      // freezing to matter (bigger scale) — so it ages on its short base clock, not on a cold snap.
      const coldTerm = o.rottenColdK * (fdh / (o.fdhScaleHours * o.rottenColdScaleMult)) * snowDamp;
      const thawTerm = o.rottenThawK * (tdh / o.tdhScaleHours) * shallowK;
      multiplier = clamp(1 + coldTerm - thawTerm, o.multiplierFloor, o.rottenMultiplierCap);
      break;
    }
  }

  return { multiplier, snowHidden };
}

/**
 * The confidence-loss multiplier alone (what §6 stores on the hazard row and `effectiveElapsedMs` uses).
 * Building block for `weatherAdjustedFreshness`; property-tested for the three sign-flips.
 */
export function decayMultiplier(
  type: HazardType,
  weather: WeatherSinceSummary,
  opts: WeatherDecayOptions = {},
  body: BodyDecayContext = {},
): number {
  return weatherDecaySignal(type, weather, opts, body).multiplier;
}

/** `effectiveAge = elapsed × multiplier`, floored at 0 (clock skew reads as fresh). */
export function effectiveElapsedMs(elapsedMs: number, multiplier: number): number {
  return Math.max(0, elapsedMs) * multiplier;
}

export interface WeatherAdjustedFreshness {
  freshness: HazardFreshness;
  multiplier: number;
  snowHidden: boolean;
}

/**
 * Weather-adjusted freshness with the **never-hide bound** applied (D56): weather-acceleration may age a
 * pin but can never push it past `aging` into hidden/`stale` — only raw elapsed time can. Deceleration
 * (persisting a pin fresher) is always allowed. This is the function the app + the decay cron call.
 */
export function weatherAdjustedFreshness(
  type: HazardType,
  lastConfirmedAt: number,
  now: number,
  weather: WeatherSinceSummary,
  opts: WeatherDecayOptions = {},
  body: BodyDecayContext = {},
): WeatherAdjustedFreshness {
  const { multiplier, snowHidden } = weatherDecaySignal(type, weather, opts, body);
  return {
    freshness: freshnessWithMultiplier(type, lastConfirmedAt, now, multiplier),
    multiplier,
    snowHidden,
  };
}

/**
 * Apply a **pre-computed** multiplier to freshness with the never-hide bound. This is what the online
 * read path (`hazards.ts` `toView`, a query that can't fetch) calls with the multiplier the decay cron
 * stored on the hazard row (§6): time-independent, so the query recomputes the live bucket from the
 * always-current `elapsed`. A missing multiplier ⇒ pass `1` (fail-open = plain base decay).
 */
export function freshnessWithMultiplier(
  type: HazardType,
  lastConfirmedAt: number,
  now: number,
  multiplier: number,
): HazardFreshness {
  const baseline = deriveHazardFreshness(type, lastConfirmedAt, now);
  const effElapsed = effectiveElapsedMs(Math.max(0, now - lastConfirmedAt), multiplier);
  let freshness = deriveHazardFreshness(type, now - effElapsed, now);
  // Never-hide: weather alone can't reach `stale`. Only real elapsed time (baseline stale) can.
  if (baseline !== 'stale' && freshness === 'stale') freshness = 'aging';
  return freshness;
}
