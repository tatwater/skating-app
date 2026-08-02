/**
 * Lake surface elevation (N6c Workstream A1) — the source list, plausibility bounds, and the
 * framing rules for showing it.
 *
 * ## Why elevation earns a field
 *
 * It is a real freeze-**order** signal in the Northeast and an underrated one: a 1,700 ft pond in
 * the Greens is skateable weeks before a valley lake twenty minutes away, and skaters already
 * reason this way informally. It is also the cheapest signal in this phase — one keyless lookup per
 * body against an endpoint we already use for weather.
 *
 * ## Why one source and not a ladder (D68's shape, deliberately not reused)
 *
 * Depth needed a five-rung ladder because measured bathymetry is scarce and wildly uneven. Elevation
 * is not scarce: a 90 m global DEM covers every body we hold, at a precision far inside what a
 * freeze-order signal needs. A ladder here would be ceremony. What survives from D68 is the *
 * precedence discipline* — an operator value wins and the loader refuses to overwrite it — because
 * that is about authority, not about scarcity.
 *
 * ## What it is actually worth, measured
 *
 * Open-Meteo's elevation endpoint serves **Copernicus GLO-90**, a 90 m radar-derived surface model.
 * Checked against published lake-surface figures at build time:
 *
 * | Lake | GLO-90 | Published |
 * |---|---|---|
 * | Willoughby | 1,171 ft | ~1,148 ft |
 * | Champlain | 89 ft | ~95 ft |
 * | Morey | 413 ft | ~432 ft |
 * | Shelburne Pond | 328 ft | ~269 ft |
 *
 * Three within ~5%, one **20 m high**. That is the expected behaviour of a radar *surface* model
 * over water, where returns are noisy and small ponds are not flattened to their waterline. It is
 * fine for freeze order, where the differences that matter are hundreds of feet — and it is the
 * reason the copy must never put a lake's elevation next to a second lake's and imply the gap is
 * meaningful at tens of feet.
 *
 * **Sample at the interior point, not the shoreline.** A DEM read taken on a bank is biased
 * *upward* by the bank, systematically. `waterBodies.interiorPoint` exists for exactly this class
 * of problem (see the schema note); the loader uses it and falls back to `centroid`.
 */

/**
 * Where a body's elevation came from.
 *
 * - `operator` — entered by a moderator. Wins over everything; the loader refuses to overwrite it.
 * - `dem_glo90` — Copernicus GLO-90 via Open-Meteo's elevation endpoint.
 */
export const ELEVATION_SOURCES = ['operator', 'dem_glo90'] as const;
export type ElevationSource = (typeof ELEVATION_SOURCES)[number];

/**
 * Lowest elevation we will accept for a body, in metres.
 *
 * Our five states bottom out at sea level, so anything meaningfully below it is a no-data sentinel
 * or a bad join rather than a lake. Kept slightly under zero rather than at it, because a tidal
 * or near-sea-level coastal pond can legitimately read a metre or two negative on a DEM.
 */
export const MIN_PLAUSIBLE_ELEVATION_M = -20;

/**
 * Highest elevation we will accept for a body, in metres.
 *
 * Mount Washington is 1,917 m and is the highest ground in the region; a *lake surface* sits far
 * below any summit. 1,600 m is generous by roughly a factor of two against the highest ponds in
 * the Adirondacks and Whites, which is the right direction for a backstop: it exists to catch a
 * sentinel value or a transposed coordinate, not to adjudicate a real reading.
 */
export const MAX_PLAUSIBLE_ELEVATION_M = 1600;

/**
 * Is this a usable elevation reading? Rejects non-finite values and anything outside the regional
 * plausibility window — the same backstop discipline `parseOsmDepthMeters` applies, and for the
 * same reason: a wrong number here is worse than no number, because it will be rendered as a fact.
 */
export function isPlausibleElevationM(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_PLAUSIBLE_ELEVATION_M &&
    value <= MAX_PLAUSIBLE_ELEVATION_M
  );
}

/**
 * May an automated source write over this body's existing elevation?
 *
 * **No when a moderator set it** — the D68 precedence rule, carried across unchanged. A human who
 * typed a surveyed elevation has better information than a 90 m DEM, and a loader that quietly
 * reverted them would make the override field useless the next time the pass ran.
 */
export function canOverwriteElevation(existingSource: ElevationSource | undefined): boolean {
  return existingSource !== 'operator';
}
