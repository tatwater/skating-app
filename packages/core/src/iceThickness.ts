/**
 * The Stefan ice-thickness estimator — **an admin calibration instrument, and it ships dark**
 * (N6h / **D160**).
 *
 * ## Read this before wiring it to anything
 *
 * This module computes a number in inches that a reader will interpret as *"is the ice safe"*. It is
 * the most counsel-shaped quantity this codebase can produce, and [D3](../../plans/01-decisions.md)
 * says we never issue a safety verdict. So three rules bind every use of it, and none is optional:
 *
 * 1. **Structurally operator-only.** The output never enters a payload a skater client receives.
 *    Role-gate it at the query, not by rendering-and-hiding.
 * 2. **It never feeds anything.** Not hazard decay, not bounty freshness, not trust, not reports. It
 *    is measured *against* the world and nothing reads it back. The moment a derived thickness
 *    becomes an input it acquires authority it has not earned.
 * 3. **Graduating it to a skater surface needs its own decision.** D160 authorises a dark instrument
 *    and nothing more.
 *
 * ## Why build it at all, then
 *
 * Because `reports.iceThickness` carries a `method` discriminator separating a **measurement** from
 * an estimate, so a season of computed-vs-measured pairs is a real calibration dataset — and it can
 * only be collected by a season passing. Start it late and the answer arrives a year later.
 *
 * ## The model, and its honest limits
 *
 * The classic Stefan solution for ice growing on still water:
 *
 * > `h = α · √(FDD)`
 *
 * where `FDD` is accumulated freezing degree-days (°C·day) and `α` bundles every physical constant
 * into one fitted coefficient. The textbook range for `α` on lake ice is roughly 1.4–3.0 cm/√(°C·day),
 * with ~2.0 for "average lake with snow" and higher for windswept clear ice. We ship **2.0** as a
 * starting guess whose entire purpose is to be replaced by a fit.
 *
 * **It will probably perform poorly, and that is the finding we are after.** Air-temperature FDD
 * ignores snow insulation (which can halve growth), wind, water depth, current, springs and inflow —
 * the same variables that make the never-hide invariant necessary in the first place. Learning *how*
 * poorly, with numbers, is worth a season. Learning it privately is what makes it safe to learn.
 */

/** Freezing-degree-hours → freezing-degree-days. The reducers accumulate hours; Stefan wants days. */
const HOURS_PER_DAY = 24;

/** cm per √(°C·day). Textbook lake-ice range ~1.4–3.0; 2.0 ≈ "average lake with some snow cover". */
export const STEFAN_ALPHA_DEFAULT = 2.0;

/** Below this the model is not merely imprecise, it is meaningless — a skim of ice is not "growth". */
export const STEFAN_MIN_FDD = 1;

const CM_PER_INCH = 2.54;

export interface IceThicknessEstimate {
  /** Accumulated freezing degree-days (°C·day) the estimate was built from. */
  freezingDegreeDays: number;
  /** The coefficient used, so a stored estimate can be re-derived after `α` is retuned. */
  alpha: number;
  /** Estimated thickness in centimetres, or `null` when below {@link STEFAN_MIN_FDD}. */
  thicknessCm: number | null;
  /** The same value in inches, the unit every calibration report will actually be read in. */
  thicknessIn: number | null;
}

/**
 * Estimate thickness from accumulated freezing-degree-**hours** (what the reducers produce).
 *
 * ⚠ **This is a growth model, not a state model.** It answers *"how much ice would form on still
 * open water exposed to this much cold"*, which is not the same question as *"how thick is the ice on
 * this lake"* — it has no idea what was there when the window opened, and thaw does not appear in it
 * at all. `thawDegreeHours` is accepted only so a caller can *refuse* to estimate through a
 * significant thaw rather than quietly reporting growth that melted.
 */
export function estimateIceThickness(
  freezingDegreeHours: number,
  options: { alpha?: number } = {},
): IceThicknessEstimate {
  const alpha = options.alpha ?? STEFAN_ALPHA_DEFAULT;
  const fdd = Math.max(0, freezingDegreeHours) / HOURS_PER_DAY;
  if (fdd < STEFAN_MIN_FDD) {
    return { freezingDegreeDays: fdd, alpha, thicknessCm: null, thicknessIn: null };
  }
  const thicknessCm = alpha * Math.sqrt(fdd);
  return {
    freezingDegreeDays: fdd,
    alpha,
    thicknessCm,
    thicknessIn: thicknessCm / CM_PER_INCH,
  };
}

/**
 * Fit `α` by least squares through the origin against observed thicknesses:
 * `α = Σ(hᵢ·√FDDᵢ) / Σ(FDDᵢ)`.
 *
 * Through the origin because zero cold must predict zero ice — an intercept would let the fit buy
 * accuracy by asserting ice exists before any freezing happened, which is the one error this model
 * must not be allowed to make.
 *
 * Returns `null` when there is nothing to fit. **Feed it measurements only** — fitting to other
 * people's estimates fits the model to a guess and then reports the agreement as validation.
 */
export function fitStefanAlpha(
  samples: readonly { freezingDegreeHours: number; observedCm: number }[],
): { alpha: number; n: number; rmseCm: number } | null {
  let num = 0;
  let den = 0;
  const usable: { fdd: number; observedCm: number }[] = [];
  for (const s of samples) {
    const fdd = Math.max(0, s.freezingDegreeHours) / HOURS_PER_DAY;
    if (fdd < STEFAN_MIN_FDD || !(s.observedCm > 0)) continue;
    usable.push({ fdd, observedCm: s.observedCm });
    num += s.observedCm * Math.sqrt(fdd);
    den += fdd;
  }
  if (usable.length === 0 || den === 0) return null;
  const alpha = num / den;
  let sq = 0;
  for (const u of usable) {
    const predicted = alpha * Math.sqrt(u.fdd);
    sq += (predicted - u.observedCm) ** 2;
  }
  return { alpha, n: usable.length, rmseCm: Math.sqrt(sq / usable.length) };
}

// Unit conversion deliberately lives in `units.ts` (`cmToInches` / `inchesToCm` /
// `formatThicknessInches`) — this module owns the model, not the presentation.
