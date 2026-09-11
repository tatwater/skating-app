/**
 * The weather grid cell — the two-tier cache key (N6h / **D152**).
 *
 * ## Why this replaced a rounded coordinate
 *
 * The key this supersedes was `` `${lat.toFixed(3)},${lng.toFixed(3)}` `` — roughly 110 m. Measured
 * against the merged corpus that produced **24,832 distinct keys for 24,948 bodies**: one fetch per
 * lake, no sharing at all. It stayed invisible only because both weather actions were drawer-open
 * only, so the hour bucket collapsed concurrent viewers of the *same* lake and nothing ever asked for
 * two.
 *
 * It was also buying nothing. Open-Meteo's US best-match resolves at ~3 km (HRRR) to ~13 km (GFS): a
 * 110 m key asks a model with roughly three thousand distinct answers for twenty-five thousand of
 * them.
 *
 * ## Two tiers, because they answer different questions
 *
 * - **`browse`** — `0.05°` (~5.6 × 4.0 km at 44°N) plus a **100 m elevation band**. What a drawer
 *   asks for, on demand. ~8,221 cells over the corpus, ~9,500–10,500 once banded.
 * - **`filter`** — `0.1°` (~11 × 8 km), no elevation. What the corpus-wide cron populates so
 *   cross-body weather queries (D159) can run without scanning 25,000 bodies. **3,043 cells.**
 *
 * A key fine enough for the detail panel cannot be afforded corpus-wide; a key cheap enough
 * corpus-wide is too coarse for the panel. The cheap one is allowed to be wrong in ways that only
 * change *which* lakes you look at, never what the panel then says about them.
 *
 * ## The elevation band is load-bearing, and so is snapping the *request*
 *
 * Open-Meteo lapse-rate-downscales temperature to whatever `elevation` you pass. The corpus is at
 * ~99.5% elevation coverage after N7-3, and in the Greens, the Adirondacks and the Whites a valley
 * lake can sit 400 m below its grid cell's mean elevation — an error of several degrees, *across
 * freezing*, which is the only threshold this app cares about. Passing the real elevation fixes it;
 * banding the key is what stops that fix from fragmenting the cache back to one-key-per-lake.
 * Measured cost of banding: **~1.16× at 100 m** (~1.08× at 200 m, and 200 m was already within ~1% of
 * 300 m — the elevation axis is coarse-grained by nature in this terrain, so 100 m buys real fidelity
 * for almost nothing).
 *
 * **⚠ The returned `lat`/`lng`/`elevationM` are the values to send to Open-Meteo — not the body's
 * own.** Keying on a cell while requesting the body's exact coordinates would mean two bodies sharing
 * a cache entry whose contents describe whichever of them fetched first. Snap the request, not just
 * the key. This is the same lesson `imageryTiles.ts` learned from NAIP, where an unsnapped bbox
 * turned a 0.08 s cache hit into a 29 s cold render.
 */

/** The two grids. `browse` is what a drawer asks for; `filter` is what the corpus-wide cron fills. */
export const WEATHER_TIERS = ['browse', 'filter'] as const;
export type WeatherTier = (typeof WEATHER_TIERS)[number];

export interface WeatherTierSpec {
  /** Cell size in degrees, applied to both axes. */
  cellDeg: number;
  /** Elevation band width in metres, or `null` when this tier does not band by elevation. */
  elevationBandM: number | null;
}

export const WEATHER_TIER_SPECS: Record<WeatherTier, WeatherTierSpec> = {
  browse: { cellDeg: 0.05, elevationBandM: 100 },
  filter: { cellDeg: 0.1, elevationBandM: null },
};

/**
 * A resolved cell: the cache key, and the exact coordinates and elevation that must be sent to
 * Open-Meteo for the key to describe what comes back.
 */
export interface WeatherCell {
  /** Cache key. Encodes the tier, so keys from two tiers can never collide. */
  key: string;
  /** Cell-centre latitude — send this, not the body's. */
  lat: number;
  /** Cell-centre longitude — send this, not the body's. */
  lng: number;
  /**
   * Band-centre elevation in metres, or `undefined` when this tier does not band or the body has no
   * elevation. `undefined` means "send no `elevation` param and let Open-Meteo use its own model
   * elevation" — which is exactly what the key records, so the two stay in agreement either way.
   */
  elevationM?: number;
}

/**
 * Snap a coordinate to its cell index. `Math.round` rather than `Math.floor` so a cell is centred on
 * its representative point: index `k` covers `[k·d − d/2, k·d + d/2)`, and the value sent to
 * Open-Meteo is `k·d`, the middle of the cell rather than its corner.
 */
function cellIndex(value: number, cellDeg: number): number {
  return Math.round(value / cellDeg);
}

/**
 * Resolve a point (and optionally an elevation) to its cell on `tier`.
 *
 * `elevationM` is ignored on tiers that do not band. When a banding tier is given no elevation — the
 * ~0.5% of the corpus without one, or any caller that genuinely has none — the cell falls back to
 * *unbanded*, keyed with a `-` in the elevation slot so it can never collide with a banded key for
 * the same cell. Those two rows describe genuinely different requests (one passes `elevation`, one
 * does not), so they must not share an entry.
 */
export function weatherCellFor(
  tier: WeatherTier,
  lat: number,
  lng: number,
  elevationM?: number | null,
): WeatherCell {
  const spec = WEATHER_TIER_SPECS[tier];
  const latIdx = cellIndex(lat, spec.cellDeg);
  const lngIdx = cellIndex(lng, spec.cellDeg);
  // Re-derive the centre from the index rather than carrying the caller's float through: two callers
  // a metre apart must produce byte-identical request params, not merely the same key.
  const cellLat = roundCoord(latIdx * spec.cellDeg);
  const cellLng = roundCoord(lngIdx * spec.cellDeg);

  const bandM = spec.elevationBandM;
  const canBand = bandM !== null && typeof elevationM === 'number' && Number.isFinite(elevationM);
  if (!canBand) {
    return { key: `${tier[0]}:${latIdx}:${lngIdx}:-`, lat: cellLat, lng: cellLng };
  }
  const bandIdx = Math.round(elevationM / bandM);
  const bandCentreM = bandIdx * bandM;
  return {
    key: `${tier[0]}:${latIdx}:${lngIdx}:${bandIdx}`,
    lat: cellLat,
    lng: cellLng,
    elevationM: bandCentreM,
  };
}

/**
 * Kill float noise in the snapped centre. `874 * 0.05` is `43.7 00000000000005` in IEEE-754, and that
 * tail would reach Open-Meteo as a different URL for the same cell depending on which multiply
 * produced it — the cache-key-agrees-with-request invariant broken by arithmetic rather than by
 * logic. Six decimals is ~11 cm, far finer than any grid here.
 */
function roundCoord(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Does a key belong to `tier`? Used by readers that must not accidentally serve a `filter`-tier row
 * to a `browse`-tier caller — the coarser row is a legitimate *fallback* (D161's recovery ladder step
 * 2) but only when the caller has asked for one.
 */
export function isWeatherCellKeyForTier(key: string, tier: WeatherTier): boolean {
  return key.startsWith(`${tier[0]}:`);
}
