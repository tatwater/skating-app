/**
 * Correcting where a radar pass says the ground is (N6e open question 8).
 *
 * ## The error, and why a lake is the easy case
 *
 * A Sentinel-1 GRD does not carry a map projection. It carries **ground-control points**, computed by
 * projecting the radar geometry onto an ellipsoid at a **single average scene height**. Everything at
 * that height lands correctly. Everything else lands displaced along the **range** direction by
 *
 *     Δground = (h − h_ref) / tan(θ)
 *
 * which at IW's incidence angles is roughly **140 m for every 100 m** of height error. Sentinel-1 is
 * right-looking, so ascending passes view a lake from the east and descending from the west — and the
 * displacement therefore *flips sign between them*.
 *
 * That is not a subtle effect and it was found by looking: two islands in the north-west of Mascoma
 * visibly jumped east, then west, then east again as a skater scrubbed through alternating passes on
 * 2026-08-25.
 *
 * ## Why this is a translation rather than a terrain correction
 *
 * Full terrain correction resamples every pixel against a DEM, because real ground varies in height.
 * **A lake does not.** It is flat, at a height the corpus already knows to ~5%, which collapses the
 * per-pixel warp into a single offset — and makes the fix a few lines of trigonometry instead of a
 * SNAP dependency and a DEM download per scene.
 *
 * ⚠ **So this corrects lakes, and only lakes.** The shoreline is right, the water is right, and the
 * hillside behind it is as wrong as it ever was. That is the correct trade for an archive that exists
 * to show frozen water, and it is worth stating plainly so nobody later reads these frames as
 * terrain-corrected imagery.
 */

/** Metres of ground displacement per metre of height error, at a given incidence angle. */
export function rangeDisplacementPerMetre(incidenceDeg: number): number {
  return 1 / Math.tan((incidenceDeg * Math.PI) / 180);
}

/**
 * How far, and which way, a flat surface at `heightM` is displaced by a GRD's geocoding.
 *
 * Returns metres **east and north** — the frame the caller will apply them in — derived from the
 * range direction, which is perpendicular to the platform heading on the look side.
 *
 * ⚠ **The sign convention is the part to get right.** The GCPs place a lake as though it sat at
 * `referenceHeightM`. A lake that is *higher* than that reference is closer to the sensor, so the
 * product draws it displaced **toward** the sensor in ground range — and correcting therefore moves it
 * *away*. Getting this backwards doubles the error instead of removing it, and the result still looks
 * plausible, which is why the direction is tested against both orbit directions rather than reasoned
 * about once.
 */
export function geocodeOffsetMeters({
  heightM,
  referenceHeightM,
  incidenceDeg,
  headingDeg,
  lookRight = true,
}: {
  /** The surface's true height above the ellipsoid — a lake's `elevationM`. */
  heightM: number;
  /** The height the product's GCPs were computed at, from the annotation. */
  referenceHeightM: number;
  /** Incidence angle at the target, degrees. */
  incidenceDeg: number;
  /** Platform heading, degrees clockwise from north. */
  headingDeg: number;
  /** Sentinel-1 is right-looking. Present so the assumption is visible rather than baked in. */
  lookRight?: boolean;
}): { eastM: number; northM: number } {
  const delta = heightM - referenceHeightM;
  const magnitude = delta * rangeDisplacementPerMetre(incidenceDeg);

  // Range points 90° from heading, on the look side.
  const rangeBearing = headingDeg + (lookRight ? 90 : -90);
  const rad = (rangeBearing * Math.PI) / 180;

  // Displaced *toward* the sensor, so the correction pushes back out along range.
  return { eastM: magnitude * Math.sin(rad), northM: magnitude * Math.cos(rad) };
}

/** Metres per degree of latitude — near enough constant for a correction of a few hundred metres. */
const METRES_PER_DEG_LAT = 111_132;

/**
 * Apply a ground offset to a coordinate.
 *
 * A local flat-earth step rather than a geodesic one: these are offsets of a few hundred metres, where
 * the two agree to well under a metre, and a geodesic here would be precision the input height does
 * not have.
 */
export function shiftCoordinate(
  lat: number,
  lng: number,
  offset: { eastM: number; northM: number },
): { lat: number; lng: number } {
  const metresPerDegLng = METRES_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  return {
    lat: lat + offset.northM / METRES_PER_DEG_LAT,
    lng: lng + (metresPerDegLng === 0 ? 0 : offset.eastM / metresPerDegLng),
  };
}

/**
 * The height to geocode a granule at, given the lakes it is about to cut.
 *
 * ⚠ **One height per granule, because one raster is warped per granule.** A pass covers ~250 km and
 * the lakes under it are not all at one elevation, so this is a compromise rather than a solution —
 * the median leaves the outliers displaced, just far less than geocoding them all at the scene
 * average did.
 *
 * The **median** rather than the mean, because a single alpine tarn among a hundred valley lakes
 * should not drag the whole frame upward. `null` when nothing under the granule has a known
 * elevation, which the caller must read as "geocode as before" rather than as zero — sea level is a
 * real height and a wrong one.
 */
export function granuleGeocodeHeight(elevations: readonly (number | undefined)[]): number | null {
  const known = elevations.filter((e): e is number => typeof e === 'number').sort((a, b) => a - b);
  if (known.length === 0) return null;
  const mid = Math.floor(known.length / 2);
  return known.length % 2 === 1
    ? (known[mid] as number)
    : ((known[mid - 1] as number) + (known[mid] as number)) / 2;
}
