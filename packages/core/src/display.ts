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

export interface DisplayScoreInput {
  /** Body surface area in m². Missing or invalid (≤ 0 / non-finite) is treated as the minimum. */
  surfaceAreaSqM?: number;
  /**
   * Admin prominence nudge (D49); added directly to the score. Default 0. A positive boost forces a
   * small-but-beloved lake (Lake Morey) to draw wider; a negative one demotes. Popularity terms
   * join this later (Phase 3+).
   */
  curatedBoost?: number;
}

/**
 * Prominence score for a water body: `normalize(log area) + curatedBoost`. The area term is clamped
 * to [0, 1] at the fixed reference bounds; `curatedBoost` can push the total above 1 (force wider)
 * or below 0 (demote) — `minVisibleZoom` re-clamps, so out-of-range totals are safe.
 */
export function displayScore({ surfaceAreaSqM, curatedBoost = 0 }: DisplayScoreInput): number {
  const area =
    surfaceAreaSqM !== undefined && Number.isFinite(surfaceAreaSqM) && surfaceAreaSqM > 0
      ? surfaceAreaSqM
      : DISPLAY_AREA_MIN_SQM;
  const areaTerm = Math.min(1, Math.max(0, (Math.log(area) - LOG_AREA_MIN) / LOG_AREA_SPAN));
  return areaTerm + curatedBoost;
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
