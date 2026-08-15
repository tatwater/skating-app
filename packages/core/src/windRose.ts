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
  // `null` is accepted as well as `undefined` because `normalizeRose` returns `number[] | null`,
  // and making every call site launder that into `undefined` is friction with no safety in it —
  // both mean "no rose", and both must produce no sentence.
  rose: readonly number[] | null | undefined,
  fetchProfileM: readonly number[] | null | undefined,
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
  rose: readonly number[] | null | undefined,
  fetchProfileM: readonly number[] | null | undefined,
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

// ─────────────────────────────────────────────────────────────────────────────
// Sustained wind — the speed question a rose cannot answer (N7-3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## Why any of this exists
 *
 * `windRose` is sixteen **frequencies**. It says which way the wind comes from and nothing about
 * how hard it blows — and the WTK fetch has been requesting `windspeed_10m` all along and
 * discarding it, reading `cells[5]` (direction) and never `cells[6]`.
 *
 * That matters because the two wind hazards on a lake are different questions:
 *
 * - **Pressure ridges** are a *fetch* problem. Frequency × fetch, which `mostExposedSector` answers,
 *   and which is why `MIN_FETCH_CLAUSE_M` gates that clause at a kilometre.
 * - **Wind holes** are a *speed* problem. They are driven by sustained strong wind and have **no
 *   comparable fetch minimum** — so the 1 km gate is meaningful for the first and must not be
 *   assumed meaningful for the second (founder, 2026-08-02).
 */

/**
 * The speed at or above which an hour counts as strong, in m/s. **8.94 m/s is 20 mph.**
 *
 * WTK's `windspeed_10m` is measured at 10 m, which is standard anemometer height — so this compares
 * directly with a reported wind speed and needs no conversion fudge. Somebody will otherwise wonder.
 *
 * **Changing it requires a recompute**, because the counts are accumulated at this threshold. After
 * the snapshot/derive split that recompute is a local `derive` over the archive rather than a
 * 7.7-hour re-fetch — which is the entire point of the archive. The value used is stored alongside
 * the counts (`strongWindMinMps`) so a row is self-describing and a mixed-threshold corpus is
 * detectable rather than silent.
 */
export const STRONG_WIND_MIN_MPS = 8.94;

/**
 * The longest-fetch bar a body must clear to get a WTK cell fetched at all. **250 m** (founder,
 * 2026-08-09).
 *
 * ## Why this is not `MIN_FETCH_CLAUSE_M`, and must never be collapsed into it
 *
 * `MIN_FETCH_CLAUSE_M` (1 km) gates the *wind-exposure caption clause*, and it is right for that:
 * pressure ridges are a fetch problem, so a lake with no fetch has no ridge to warn about. It was
 * also, for one campaign, doing a second job it was never chosen for — deciding which bodies got a
 * rose **fetched**. Wind holes are a speed problem with no comparable fetch minimum, so gating the
 * fetch at the caption's bar under-served the wind-hole lane by construction.
 *
 * Two separate numbers, because they answer two separate questions. A body between 250 m and 1 km
 * now carries strong-wind hours and no exposure clause, which is the correct pair of answers.
 *
 * ## Why 250 and not 0, measured against the loaded corpus (2026-08-09)
 *
 * | min fetch | bodies | 2 km cells | requests | fetch hours |
 * | --- | --- | --- | --- | --- |
 * | 1000 m (the old bar) | 1,193 | 1,182 | 5,910 | 10.5 |
 * | **250 m** | **11,121** | **9,555** | **47,775** | **~85** |
 * | 0 (everything) | 24,956 | 18,355 | 91,775 | ~163 |
 *
 * 250 m reaches 45% of the corpus for roughly half the wall clock of taking everything, and the
 * bodies it walks past are ponds under about six acres of open water in their longest direction —
 * where a wind hole is not the hazard that decides whether the ice is safe.
 *
 * **The cost is one-time and the archive is what makes it so.** `snapshot` writes every response to
 * `.raw/` and mirrors it to R2, so widening this again later re-fetches only the *difference*
 * (`missingResponses` diffs against what is on disk), and re-deriving at a different speed threshold
 * costs minutes and zero requests.
 *
 * ⚠ **A constant, deliberately, rather than a `--min-fetch` flag on either command.** `snapshot` and
 * `derive` both scope themselves with it, and `derive` **refuses** when a cell it wants is absent
 * from the archive — so a flag that could be passed to one and not the other turns a scope decision
 * into a failed run, or worse, a coverage figure quoted over the cells that happened to be there.
 * The same reasoning retired `--min-area-acres=N` in favour of `meetsAreaFloor`: a parameter invites
 * a caller to invent a floor; a shared constant cannot drift.
 */
export const WIND_ARCHIVE_MIN_FETCH_M = 250;

/**
 * How many strong-wind hours in an average winter make a sector worth calling out. Default **3**.
 *
 * **Applied at read time, which is the strongest form of "configurable" available**: changing it
 * needs no recompute at all, where changing the speed needs a `derive`. That asymmetry is why the
 * two thresholds live in different places.
 *
 * ⚠ **This is a rate, not an episode length, and the difference is not cosmetic.** The founder's
 * decision was that strict consecutiveness is not required — *"if the wind dies down for an hour and
 * picks back up I bet it would do just as much damage"* — which is what makes storing plain counts
 * sufficient and rules out run-length detection. But it also means nothing stored here can answer
 * *"was there a three-hour blow"*; the honest question the counts can answer is *"how much strong
 * wind does this shore get in a season"*. Read `windHoleSectors` with that in mind, and treat the
 * default as a magnitude to refit rather than a number with outside support.
 */
export const WIND_HOLE_MIN_HOURS = 3;

/** What a body stores about sustained wind. All three travel together or not at all. */
export interface SustainedWind {
  /** Winter hours at or above the threshold, by the same 16 sectors as `windRose`. Absolute. */
  strongWindHours?: readonly number[] | undefined;
  /** Total winter hours the counts were accumulated from — the honest denominator. */
  sampledWindHours?: number | undefined;
  /** The m/s threshold those counts were taken at. Self-describing; see `STRONG_WIND_MIN_MPS`. */
  strongWindMinMps?: number | undefined;
}

/**
 * Is this a usable stored strong-hour array?
 *
 * **Counts, not frequencies** — deliberately the opposite of `windRose`, and so the sum check that
 * validates a rose would be wrong here. What can be checked is that no sector claims more strong
 * hours than the total sample contained, which is the shape a units error or a mixed-threshold
 * merge would take.
 */
export function isPlausibleStrongWindHours(wind: SustainedWind): boolean {
  const { strongWindHours, sampledWindHours } = wind;
  if (!Array.isArray(strongWindHours) || strongWindHours.length !== WIND_ROSE_SECTORS) return false;
  if (typeof sampledWindHours !== 'number' || !Number.isFinite(sampledWindHours)) return false;
  if (sampledWindHours <= 0) return false;
  let total = 0;
  for (const hours of strongWindHours) {
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0) return false;
    total += hours;
  }
  return total <= sampledWindHours;
}

export interface WindHoleSector {
  /** Index into the 16 compass points — the direction wind blows FROM. */
  sector: number;
  /** Strong-wind hours per winter from this sector, averaged over the sampled record. */
  hoursPerWinter: number;
  /** Share of all sampled winter hours that are strong from this sector, in `[0, 1]`. */
  share: number;
}

/** Winter hours in a Dec–Mar season, for turning a multi-winter total into a per-winter rate. */
const HOURS_PER_WINTER = 24 * (31 + 31 + 28 + 31);

/**
 * Sectors delivering at least `minHours` of strong wind in an average winter, **worst first**.
 *
 * Returns `[]` rather than `null` for a body with no sustained-wind data, because "no sectors
 * qualify" and "we never measured" are the same *action* — say nothing — and a caller forced to
 * distinguish them would have to handle a null it has no use for. The distinction is available from
 * `isPlausibleStrongWindHours` where it matters.
 *
 * ⚠ **Deliberately no copy, and this is settled (D145, 2026-08-15): nowhere.** Not the caption, not
 * the profile. D82 settled that bathymetry is context rather than counsel, and this is the same class
 * of number wearing a scarier name — sharper, because the number really is predictive and "wind hole"
 * really is frightening, which is precisely why an always-on clause would over-warn all winter to be
 * right a few days of it.
 *
 * The distinction is a **climatology versus a condition**: these counts describe Januaries in
 * general, and a skater on the ice is asking about today. The intended eventual home is a
 * *conditional* profile banner — right season, right conditions, this body's climatology, and no
 * report or hazard already documenting it — not a permanent label. Not built.
 *
 * So this function has **no production caller on purpose.** If you are wiring it into copy, read D145
 * first; it is unread by design rather than by oversight.
 */
export function windHoleSectors(
  wind: SustainedWind,
  minHours: number = WIND_HOLE_MIN_HOURS,
): WindHoleSector[] {
  if (!isPlausibleStrongWindHours(wind)) return [];
  const hours = wind.strongWindHours as readonly number[];
  const sampled = wind.sampledWindHours as number;
  const winters = sampled / HOURS_PER_WINTER;
  if (!(winters > 0)) return [];
  const out: WindHoleSector[] = [];
  for (let k = 0; k < WIND_ROSE_SECTORS; k++) {
    const total = hours[k] as number;
    const hoursPerWinter = total / winters;
    if (hoursPerWinter < minHours) continue;
    out.push({ sector: k, hoursPerWinter, share: total / sampled });
  }
  // Ties break toward the lower sector index — arbitrary and stable, the same rule
  // `mostExposedSector` uses and for the same reason.
  return out.sort((a, b) => b.hoursPerWinter - a.hoursPerWinter || a.sector - b.sector);
}
