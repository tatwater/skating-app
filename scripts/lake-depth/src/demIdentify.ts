/**
 * Asking 3DEP **every** raster's opinion of a point, not just its favourite — the pure half.
 *
 * ## The mistake this exists to catch
 *
 * > **Founder, 2026-08-26:** *"the fact that our depth readings can get the bottom of the lake…
 * > that's not good! Does that mean lots of lakes in our corpus could be tens of feet too low?"*
 *
 * Almost never, and the reason is that USGS lidar DEMs are **hydro-flattened**: a lake is rendered
 * as one constant surface, and that surface is the water. Measured on the live service, Seneca —
 * 188 m deep — reads **135.107 m at three points 20 km apart**, which is its published surface. If
 * the DEM held bathymetry there it would read about −53 m.
 *
 * But *sometimes*, and in two ways that look identical from a single reading:
 *
 * - **Coastal topobathymetry.** 3DEP deliberately maps the sea floor in tidal areas. A polygon on
 *   the Fore River in Portland reads **−22.94 m**, which is a correct description of a channel and
 *   a nonsense description of a lake surface.
 * - **Dredged channels folded into the seamless NED.** An unnamed body near Albany reads
 *   **−10.6 m** — and the federal navigation channel to Albany is maintained at 32 ft ≈ 9.8 m.
 *
 * ⚠ **The trigger for both is a void, not a bug.** Water absorbs the near-infrared lidar pulse, so
 * lakes usually return nothing — which is *why* hydro-flattening is in the spec at all. At both
 * points above, the 1 m lidar rasters return `NoData`, so the service falls back to a coarser
 * seamless product, and coarse seamless products are where bathymetry lives.
 *
 * ## Why the fix is a different endpoint rather than more requests
 *
 * The instinct is to sample neighbouring points and compare. That cannot work from one reading: you
 * have no way to know a reading is worth re-checking until you have already re-checked it, so the
 * cost lands on all 25,000 bodies to catch a handful.
 *
 * `identify` with `returnCatalogItems=true` answers instead with **every overlapping raster's value
 * at the same point**, in one request — a multi-sample in *products* rather than in space, for the
 * request count we already spend. Measured on the live service, that is the whole discriminator:
 *
 * | body | readings | |
 * | --- | --- | --- |
 * | Seneca | `135.107 · 135.107 · 135.107` | unanimous |
 * | Winnipesaukee | `153.11 × 4` | unanimous |
 * | Champlain | `29.6921 · 29.6928` | agree to 0.7 mm |
 * | Portland tidal polygon | `−48.88 · −22.94 · −22.94 · −22.94` | **26 m of spread** |
 * | Albany body | `−10.62 · −10.24` | agree, and both under the sea |
 *
 * ⚠ **So it takes two rules, not one, and Albany is why.** Disagreement catches Portland. Albany's
 * rasters *agree* — a consensus about a river bottom is still a river bottom — and only the sign
 * catches it. Either rule alone leaves half the problem in the corpus.
 *
 * ## ⚠ Overviews are not opinions
 *
 * Most of what `identify` returns is the pyramid: `Ov_i02_L01_…` tiles at 75 m and coarser, whose
 * values are averages over land and water together. At Portland they read 17.7, 20.7, 21.9, 35.1 —
 * positive numbers that would silently outvote the real rasters and make a tidal channel look like a
 * hillside. They are excluded by `DEM_Type`, which the real datasets carry and the pyramid does not.
 */

/** The image service behind EPQS — the same data, asked a question EPQS has no parameter for. */
export const IDENTIFY_URL =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/identify';

/**
 * How far two rasters may disagree before the reading is refused, in metres.
 *
 * **Not zero, because a lake's surface genuinely moves.** Rasters are flown years apart and a
 * reservoir's drawdown or a lake's seasonal range is a real difference between two correct
 * readings — Champlain alone varies by about a metre and a half across a year. Three metres is
 * comfortably above that and far below the 26 m that exposed Portland.
 *
 * ⚠ Tuned against the *measured* spread of healthy lakes, which is essentially nil (Seneca and
 * Winnipesaukee unanimous, Champlain 0.7 mm), rather than against a guess at how much slack a
 * surface needs. If a real reservoir is ever refused for drawdown it will show up as a named
 * omission in the run's coverage report, which is the failure direction we want.
 */
export const MAX_RASTER_SPREAD_M = 3;

/**
 * Below this, a reading is a channel bottom rather than a water surface.
 *
 * **Measured, not chosen.** Of 153 sub-zero readings in the archive, **152 fall between −2.84 m and
 * zero** — coastal Maine and Cape Cod freshwater ponds sitting either side of NAVD 88's datum,
 * which is a geodetic surface rather than local mean sea level. The 153rd is the Albany channel at
 * −10.6 m. There is nothing in between, and the gap is where this sits.
 *
 * ⚠ **This is deliberately much tighter than `MIN_PLAUSIBLE_ELEVATION_M` (−20 m)** and does *not*
 * replace it. That constant is a backstop against sentinels and transposed coordinates, applied to
 * a single number with no context. This one is applied where there is context — a set of rasters
 * that agree — and its job is the narrower question of whether they are agreeing about water or
 * about the ground under it.
 */
export const MIN_SURFACE_ELEVATION_M = -3;

/** One raster's answer at the point. `null` where that raster has no data there — a lidar void. */
export interface RasterReading {
  /** The dataset's own name, e.g. `ME_SouthCoastal_2020_A20`. Kept for triage, never for logic. */
  name: string;
  /** Ground sample distance in metres, as the catalogue reports it. */
  groundSampleM: number | undefined;
  elevationM: number | null;
}

/** What the rasters, taken together, are willing to say. */
export type IdentifyVerdict =
  | {
      readonly ok: true;
      readonly elevationM: number;
      readonly spreadM: number;
      readonly used: number;
    }
  /** Every raster returned `NoData` — a void with no fallback, which is not a number to refuse. */
  | { readonly ok: false; readonly reason: 'no-data'; readonly spreadM: 0; readonly used: 0 }
  /** The rasters disagree: at least one of them is describing something other than the surface. */
  | {
      readonly ok: false;
      readonly reason: 'disputed';
      readonly spreadM: number;
      readonly used: number;
    }
  /** They agree, and agree on a depth — a consensus about a river bottom is still a river bottom. */
  | {
      readonly ok: false;
      readonly reason: 'below-surface';
      readonly elevationM: number;
      readonly spreadM: number;
      readonly used: number;
    };

/** The request URL for one point. */
export function identifyUrl(lat: number, lng: number): string {
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    returnCatalogItems: 'true',
    returnGeometry: 'false',
    f: 'json',
  });
  return `${IDENTIFY_URL}?${params.toString()}`;
}

/**
 * Pull the real rasters out of an `identify` response, dropping the overview pyramid.
 *
 * The service returns `properties.Values` and `catalogItems.features` as **parallel arrays**, which
 * is the only thing tying a number to the raster that produced it — there is no id on the value. A
 * length mismatch therefore means the pairing cannot be trusted at all, and the honest read of the
 * response is none of it.
 */
export function parseIdentify(body: unknown): RasterReading[] {
  if (body === null || typeof body !== 'object') return [];
  const root = body as {
    properties?: { Values?: unknown };
    catalogItems?: { features?: unknown };
  };
  const values = root.properties?.Values;
  const features = root.catalogItems?.features;
  if (!Array.isArray(values) || !Array.isArray(features)) return [];
  if (values.length !== features.length) return [];

  const readings: RasterReading[] = [];
  for (const [i, feature] of features.entries()) {
    const attributes = (feature as { attributes?: Record<string, unknown> } | null)?.attributes;
    if (!attributes) continue;
    // ⚠ The pyramid, excluded. See the note on overviews: its averages are positive over a tidal
    // channel and would outvote the rasters that actually measured it.
    if (attributes.DEM_Type === null || attributes.DEM_Type === undefined) continue;

    const raw = values[i];
    const parsed =
      typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
    const groundSampleM = typeof attributes.LowPS === 'number' ? attributes.LowPS : undefined;
    readings.push({
      name: typeof attributes.Name === 'string' ? attributes.Name : '',
      groundSampleM,
      elevationM: Number.isFinite(parsed) ? parsed : null,
    });
  }
  return readings;
}

/**
 * What to believe, given every raster that has an opinion.
 *
 * **The median rather than the finest**, which is the other half of the change. EPQS answers with
 * the highest-resolution raster that has data, and at both problem points that is precisely the one
 * carrying bathymetry — the 1 m lidar voids over water, so "best available" selects *down* into a
 * coarse product that mapped the bottom. A median cannot be dragged by one outlier, and where the
 * rasters agree it is the same number the finest one would have given.
 *
 * ## ⚠ A dissenter is not a dispute, and the probe is what taught us the difference
 *
 * The first cut refused on the **full range** — any two rasters more than `MAX_RASTER_SPREAD_M`
 * apart and the point was thrown away. Run against 200 archived points it refused exactly one:
 *
 *     44.36450,-70.05632   86.40@n45w071 · 86.40@n45w071 · 86.40@ME_SouthCoastal_2020_A20
 *                          · 81.64@ME_SouthernArea_2012
 *
 * Three rasters agree to the centimetre and a 2012 survey dissents by 4.8 m. The median was already
 * *right*, and the range test discarded it anyway — a rule that gets stricter every time USGS adds
 * another survey, which is backwards.
 *
 * So the question is not "do all the rasters agree" but **"does the median have support"**: how many
 * readings sit within tolerance of it. One old survey cannot outvote three; and if no majority forms,
 * there is genuinely no consensus to report and refusing is right.
 *
 * ⚠ **Which leaves the sign rule carrying Portland on its own, and that is fine — it always was.**
 * Under a majority test Portland's `−48.88 · −22.94 · −22.94 · −22.94` now *agrees* at −22.94, so
 * only `minSurfaceM` refuses it. That was already true of Albany, whose rasters never disagreed. The
 * two rules were never redundant; the range test was just failing loudly enough to look load-bearing.
 */
export function judgeReadings(
  readings: readonly RasterReading[],
  {
    maxSpreadM = MAX_RASTER_SPREAD_M,
    minSurfaceM = MIN_SURFACE_ELEVATION_M,
  }: { maxSpreadM?: number; minSurfaceM?: number } = {},
): IdentifyVerdict {
  const values = readings
    .map((r) => r.elevationM)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  if (values.length === 0) return { ok: false, reason: 'no-data', spreadM: 0, used: 0 };

  const spreadM = (values.at(-1) as number) - (values[0] as number);
  const mid = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 1
      ? (values[mid] as number)
      : ((values[mid - 1] as number) + (values[mid] as number)) / 2;

  // Support for the median, not agreement across the whole set. A lone reading is its own majority:
  // one raster cannot contradict itself, and "only one product covers this point" is an ordinary
  // state rather than a dispute.
  const agreeing = values.filter((v) => Math.abs(v - median) <= maxSpreadM).length;
  if (agreeing * 2 <= values.length && values.length > 1) {
    return { ok: false, reason: 'disputed', spreadM, used: values.length };
  }
  if (median < minSurfaceM) {
    return { ok: false, reason: 'below-surface', elevationM: median, spreadM, used: values.length };
  }
  return { ok: true, elevationM: median, spreadM, used: values.length };
}
