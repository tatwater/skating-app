/**
 * Zoom-scored display prominence (D49) — which water bodies draw at a given map zoom.
 *
 * A body's prominence is a derived `displayScore` (log surface area, plus an optional admin
 * `curatedBoost`), mapped to an integer `minVisibleZoom` bucket: the *widest* (lowest) map zoom at
 * which the body should appear. `waterBodies` stores `minVisibleZoom` and indexes it as a
 * geospatial filter key, so `listInViewport` filters `minVisibleZoom <= zoom` **in-query** — a wide
 * zoom then returns only the prominent bodies instead of an arbitrary read-capped slice (the fix
 * for the Phase 1 truncation stopgap).
 *
 * The area→score mapping uses **fixed** log-area reference bounds, NOT corpus-relative
 * normalization, so adding a new region later never re-scores existing bodies. The constants below
 * are a starting point tuned against the Vermont pilot corpus in Phase 2; Phase 4 lifts them behind
 * admin controls (D49) so a non-engineer can adjust them without a code change.
 */

/** Surface area (m²) mapping to display score 0 — a tiny pond. At or below this the area term is 0. */
export const DISPLAY_AREA_MIN_SQM = 100;
/** Surface area (m²) mapping to display score 1 — ~Lake Champlain, the pilot's largest. Above, caps at 1. */
export const DISPLAY_AREA_MAX_SQM = 1.1e9;

/** Widest (lowest) zoom bucket — a top-score body is visible from here (whole-region view). */
export const MIN_VISIBLE_ZOOM_WIDEST = 6;
/**
 * Discoverability floor (D49): every listed body is visible by this zoom regardless of score.
 * Matches the self-hosted Vermont basemap's max zoom (z14).
 */
export const MIN_VISIBLE_ZOOM_FLOOR = 14;

/**
 * The zoom at which named sub-area (bay) labels start drawing (N2 / D60).
 *
 * D49 already decides *which* bays are prominent enough for a given zoom, so this is not a second
 * prominence rule — it's a floor below which the layer isn't worth asking for at all. At z8 you are
 * looking at three states, and a bay outline there is noise on top of a lake that is itself two
 * pixels wide.
 *
 * It lives in `@skating/core` rather than beside the query because **both ends have to agree**: the
 * server returns nothing below it, and the clients skip the subscription entirely rather than paying
 * a round trip to be told so. Two copies of that number would eventually disagree, and the failure
 * would be a layer that quietly stops drawing at some zooms.
 */
export const SUB_AREA_MIN_RENDER_ZOOM = 10;

const LOG_AREA_MIN = Math.log(DISPLAY_AREA_MIN_SQM);
const LOG_AREA_SPAN = Math.log(DISPLAY_AREA_MAX_SQM) - LOG_AREA_MIN;

// ── Profile-richness prominence (N6c / D2) ───────────────────────────────────────────────────
//
// **Prominence rewards how much we know about a body.** The founder's starting instinct was to
// consider dropping unnamed bodies, and the corpus falsified it: 92% of the 116,070 are unnamed, so
// "drop unnamed" is very nearly "drop the corpus". The answer is additive rather than subtractive —
// a pond nobody has documented stays quiet until someone documents it, and then it surfaces, which
// also makes the map reward contribution.
//
// **Every term is a BOOST, never a penalty.** A body with no profile data keeps exactly the
// `minVisibleZoom` it has today and richer bodies rise past it. Implementing this as a subtraction
// would push already-obscure ponds below the discoverability floor, which is precisely the founder's
// stated worry ("I'd hate to not have a body someone cares about").
//
// ## The scale, which the plan got wrong by an order of magnitude
//
// N6c's D2 table proposed +1 for a name, +2 for contours, +4 for an official put-in — summing to
// +13. But `displayScore` is `normalize(log area) ∈ [0,1] + curatedBoost`, and `minVisibleZoom`
// clamps the total to [0,1] before mapping it onto z14→z6. Every curated boost on dev is exactly
// **0.3**, and boosted bodies score 0.75–1.30. A "+1 has a real name" term would therefore push all
// ~9,000 named bodies to the widest zoom bucket, and the map would read as broken while every test
// still passed. The weights below are the plan's *relative ordering* expressed on the real scale.
//
// ## Why activity dominates (founder call, 2026-08-02)
//
// > *"I would love for the real-world data of users documenting lakes well (both via more complete
// > profiles & actual reports) to completely remove the need for moderators to hand-curate
// > 'destination' lakes. Curation should exist only as a way to get us a good seed, and as a check
// > on our automated system."*
//
// So richness is deliberately allowed to **out-rank a curated boost**: static metadata is capped
// well below 0.3, while reports and hazards alone can reach it, and the total ceiling sits above it.
// A genuinely used lake overtakes a hand-seeded one, which is the retirement path stated as a
// mechanism rather than an intention. See `curatedBoostIsRedundant` for the other half.

/** One zoom level, in score units — the unit that makes every weight below legible. */
export const SCORE_PER_ZOOM_LEVEL = 1 / (14 - 6);

/** Someone cared enough to name it. Weak but real, and free — the name is already on the row. */
export const RICHNESS_NAMED = 0.02;
/** Any depth rung (N6a). Weaker than contours, because most of it is modelled. */
export const RICHNESS_DEPTH = 0.04;
/** A state surveyed it (N6b) — itself a statement that the water matters. */
export const RICHNESS_CONTOURS = 0.06;
/** Access exists and we found it (N6d, `derived`). */
export const RICHNESS_PUT_IN_DERIVED = 0.06;
/** A human confirmed you can get on the ice here (N6d, `official`). The strongest static signal. */
export const RICHNESS_PUT_IN_OFFICIAL = 0.12;
/**
 * Someone has actually been there.
 *
 * **The only term that is evidence of *use* rather than of *data***, which is why it is the largest
 * and why it alone can match a curated boost. D49 always planned for popularity to feed
 * `displayScore`; this is that, seeded conservatively.
 */
export const RICHNESS_ACTIVITY = 0.3;

/**
 * Ceiling on the static-metadata half.
 *
 * Metadata says a body is *documented*; it does not say anybody wants to skate it. Capping the
 * imported signals below `curatedBoost`'s 0.3 keeps a fully-catalogued but unvisited pond from
 * out-ranking a lake a human vouched for, while leaving activity free to do exactly that.
 */
export const RICHNESS_STATIC_CAP = 0.15;

/** Ceiling on the whole richness term — about 3.2 zoom levels, against a curated boost's 2.4. */
export const RICHNESS_TOTAL_CAP = 0.4;

/** What we know about a body, for the D2 prominence terms. All optional; absent ⇒ contributes 0. */
export interface ProfileRichness {
  /** A real name, not a blank and not a bare generic like "Pond". */
  hasName?: boolean;
  hasDepth?: boolean;
  hasContours?: boolean;
  hasDerivedPutIn?: boolean;
  hasOfficialPutIn?: boolean;
  /** Any report or hazard on record — evidence of use. */
  hasActivity?: boolean;
}

/**
 * The static (imported-metadata) half of the richness boost, capped at `RICHNESS_STATIC_CAP`.
 *
 * An official put-in supersedes a derived one rather than stacking with it: they are two rungs of
 * one fact ("you can get on the ice here"), and adding them would pay twice for one signal — the
 * same double-counting D70's `curatedBoost`-not-`isDestination` call avoided.
 */
export function staticRichness(r: ProfileRichness): number {
  let score = 0;
  if (r.hasName) score += RICHNESS_NAMED;
  if (r.hasDepth) score += RICHNESS_DEPTH;
  if (r.hasContours) score += RICHNESS_CONTOURS;
  if (r.hasOfficialPutIn) score += RICHNESS_PUT_IN_OFFICIAL;
  else if (r.hasDerivedPutIn) score += RICHNESS_PUT_IN_DERIVED;
  return Math.min(RICHNESS_STATIC_CAP, score);
}

/** The whole richness boost: static metadata plus evidence of use, capped. Never negative. */
export function profileRichness(r: ProfileRichness | undefined): number {
  if (!r) return 0;
  const total = staticRichness(r) + (r.hasActivity ? RICHNESS_ACTIVITY : 0);
  return Math.min(RICHNESS_TOTAL_CAP, Math.max(0, total));
}

/**
 * Has a body earned enough on its own that its `curatedBoost` is no longer doing anything?
 *
 * **The retirement signal** (founder call): curated boosts are a cold-start seed with a retirement
 * path, not a permanent registry. Without something that says so, a seed set in 2026 sits on the
 * row forever and nobody can tell which ones are still load-bearing. This makes that answerable —
 * the Phase 7 admin surface flags these so a moderator can clear them.
 *
 * Deliberately **advisory, never automatic**. Un-setting a boost on a body's behalf would be a
 * silent prominence change nobody reviewed, and the founder's framing keeps curation as "a check on
 * our automated system" — a check that removes itself is not one.
 */
export function curatedBoostIsRedundant(
  curatedBoost: number | undefined,
  richness: ProfileRichness | undefined,
): boolean {
  if (curatedBoost === undefined || curatedBoost <= 0) return false;
  return profileRichness(richness) >= curatedBoost;
}

export interface DisplayScoreInput {
  /** Body surface area in m². Missing or invalid (≤ 0 / non-finite) is treated as the minimum. */
  surfaceAreaSqM?: number;
  /**
   * Admin prominence nudge (D49); added directly to the score. Default 0. A positive boost forces a
   * small-but-beloved lake (Lake Morey) to draw wider; a negative one demotes.
   *
   * **A cold-start seed with a retirement path** (D2), not a permanent registry — see
   * `curatedBoostIsRedundant`.
   */
  curatedBoost?: number;
  /** What we know about the body (N6c / D2). Absent ⇒ no richness boost, same score as before. */
  richness?: ProfileRichness;
}

/**
 * Prominence score for a water body: `normalize(log area) + curatedBoost + profileRichness`. The
 * area term is clamped to [0, 1] at the fixed reference bounds; `curatedBoost` can push the total
 * above 1 (force wider) or below 0 (demote) — `minVisibleZoom` re-clamps, so out-of-range totals
 * are safe.
 */
export function displayScore({
  surfaceAreaSqM,
  curatedBoost = 0,
  richness,
}: DisplayScoreInput): number {
  const area =
    surfaceAreaSqM !== undefined && Number.isFinite(surfaceAreaSqM) && surfaceAreaSqM > 0
      ? surfaceAreaSqM
      : DISPLAY_AREA_MIN_SQM;
  const areaTerm = Math.min(1, Math.max(0, (Math.log(area) - LOG_AREA_MIN) / LOG_AREA_SPAN));
  return areaTerm + curatedBoost + profileRichness(richness);
}

/**
 * The widest (lowest) integer zoom bucket at which a body of the given score should draw — monotonic
 * **decreasing** in score (more prominent ⇒ visible at a wider zoom). Clamped to
 * [`MIN_VISIBLE_ZOOM_WIDEST`, `MIN_VISIBLE_ZOOM_FLOOR`], so every body is visible by the floor zoom
 * (the discoverability guarantee, D49) and top-score bodies never draw wider than the widest bucket.
 */
export function minVisibleZoom(score: number): number {
  const clamped = Math.min(1, Math.max(0, score));
  const span = MIN_VISIBLE_ZOOM_FLOOR - MIN_VISIBLE_ZOOM_WIDEST;
  return Math.round(MIN_VISIBLE_ZOOM_FLOOR - clamped * span);
}
