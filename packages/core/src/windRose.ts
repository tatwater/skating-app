/**
 * Winter wind climatology (N6c A4b) — how often wind actually blows from each compass sector at a
 * lake, and what that means when combined with the fetch profile.
 *
 * ## Why this exists: fetch alone names the wrong direction
 *
 * The fetch profile answers *"how much open water lies in each direction"*. That is a fact about
 * the lake and it is not, on its own, a statement about exposure — a direction with five miles of
 * fetch that wind never blows from is not an exposed shore.
 *
 * The founder caught this on **Lake Willoughby**, whose longest fetch runs SSE and which sits in a
 * glacial trough between Mount Pisgah and Mount Hor: *"I am almost certain Lake Willoughby never
 * gets wind out of the south… terrain (mountains) around lakes drastically impact the chance that
 * wind could come from particular directions."*
 *
 * **The reasoning was right and the specific prediction was wrong, which is why we went and looked.**
 * NREL's WIND Toolkit at 2 km, winter hours only, puts Willoughby at 19.4% SE and 16.1% SSE, with a
 * second lobe of 18.6% NW — a strongly **bimodal rose aligned with the trough**, and almost nothing
 * from the E or NE quadrant that the ridges block. That is exactly the terrain channelling the
 * founder described; it just funnels wind *along* the valley rather than excluding the southerly
 * half of it.
 *
 * So the honest exposure signal is the **product**, not either factor:
 *
 * > `exposure[k] = winterFrequency[k] × fetchM[k]`
 *
 * On Willoughby that still picks SSE — but now because wind genuinely comes from there *and*
 * crosses 2.8 miles, rather than by geometry alone. On a lake whose long axis runs across the
 * prevailing wind it overturns the fetch-only answer, which is the case worth being right about.
 *
 * ## Why 2 km is enough, given the question
 *
 * The Global Wind Atlas resolves 250 m and would see more terrain, but it publishes **no documented
 * API** — its site is a JS application and its data comes out through interactive downloads, so
 * building a pipeline on it means depending on an undocumented endpoint with no stability promise.
 * Against that, the question here is *"which way does wind come down this valley"*, which is a
 * valley-scale question, and the Willoughby rose demonstrates 2 km WRF answers it. 250 m matters
 * for siting a turbine on a ridge; it does not change this sentence.
 */

/**
 * Where a wind rose came from. One source, like elevation and for the same reason — this is a
 * modelled climatology, not a scarce measurement, so a precedence ladder would be ceremony. The
 * literal exists so a second source (a finer downscaling, a longer record) can be added without
 * making every stored rose ambiguous.
 */
export const WIND_ROSE_SOURCES = ['wtk_2km'] as const;
export type WindRoseSource = (typeof WIND_ROSE_SOURCES)[number];

/** Sectors in a rose — the same 16 compass points the fetch profile is indexed by. */
export const WIND_ROSE_SECTORS = 16;

/**
 * The months a rose is built from: **December through March**.
 *
 * The skating season, and nothing else. An annual rose averages in summer patterns that have no
 * bearing on ice, and the two differ materially in this region. This is also the one thing the
 * WIND Toolkit gives us that the Global Wind Atlas cannot — GWA publishes an annual climatology.
 */
export const WIND_ROSE_MONTHS = [12, 1, 2, 3] as const;

/**
 * Turn per-sector hour counts into frequencies summing to 1.
 *
 * Returns `null` for an empty or malformed sample rather than a rose of zeros, because a rose of
 * zeros would multiply through `exposureIndex` to a confident "no exposure anywhere".
 */
export function normalizeRose(counts: readonly number[]): number[] | null {
  if (counts.length !== WIND_ROSE_SECTORS) return null;
  let total = 0;
  for (const c of counts) {
    if (!Number.isFinite(c) || c < 0) return null;
    total += c;
  }
  if (total <= 0) return null;
  return counts.map((c) => c / total);
}

/**
 * Is this a usable stored rose? Sixteen finite non-negative numbers summing to about 1.
 *
 * The sum check is the one that matters: a rose stored as raw counts rather than frequencies would
 * still be sixteen plausible numbers, and would silently scale every exposure index by the number
 * of hours sampled — which changes nothing about the *ranking* and everything about any threshold
 * applied to the value.
 */
export function isPlausibleWindRose(rose: unknown): rose is number[] {
  if (!Array.isArray(rose) || rose.length !== WIND_ROSE_SECTORS) return false;
  let total = 0;
  for (const value of rose) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
    total += value;
  }
  return Math.abs(total - 1) < 0.01;
}

/**
 * Per-sector exposure: how often wind comes from a direction, times how much water it crosses.
 *
 * Returns `null` unless **both** inputs are present and well-formed. There is deliberately no
 * fallback to fetch-alone: that fallback is the exact claim this module exists to stop making, and
 * a silent degradation to it would be invisible in the rendered sentence.
 */
export function exposureIndex(
  rose: readonly number[] | undefined,
  fetchProfileM: readonly number[] | undefined,
): number[] | null {
  if (!isPlausibleWindRose(rose)) return null;
  if (!fetchProfileM || fetchProfileM.length !== WIND_ROSE_SECTORS) return null;
  const out: number[] = [];
  for (let k = 0; k < WIND_ROSE_SECTORS; k++) {
    const fetchM = fetchProfileM[k];
    if (typeof fetchM !== 'number' || !Number.isFinite(fetchM) || fetchM < 0) return null;
    out.push((rose[k] as number) * fetchM);
  }
  return out;
}

/** The sector a lake is most exposed on, by frequency × fetch. */
export interface WindExposure {
  /** Index into the 16 compass points — the direction wind blows FROM. */
  sector: number;
  /** Share of winter hours wind blows from this sector, in `[0, 1]`. */
  frequency: number;
  /** Open water in that direction, metres. */
  fetchM: number;
}

/**
 * The most-exposed sector, or `null` when either input is missing.
 *
 * Ties break toward the lower sector index, which is arbitrary and stable — the alternative is a
 * caption that changes wording between runs on a perfectly symmetric pond.
 */
export function mostExposedSector(
  rose: readonly number[] | undefined,
  fetchProfileM: readonly number[] | undefined,
): WindExposure | null {
  const index = exposureIndex(rose, fetchProfileM);
  if (!index) return null;
  let best = -1;
  let bestValue = 0;
  for (let k = 0; k < index.length; k++) {
    if ((index[k] as number) > bestValue) {
      bestValue = index[k] as number;
      best = k;
    }
  }
  if (best < 0) return null;
  return {
    sector: best,
    frequency: (rose as readonly number[])[best] as number,
    fetchM: (fetchProfileM as readonly number[])[best] as number,
  };
}
