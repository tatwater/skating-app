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
 *
 * ## ✅ Measured against a real ascending/descending pair — 2026-08-25
 *
 * The geometry above was written before it had ever met a granule. It has now: two Sentinel-1 passes
 * over Mascoma **24 hours apart** (ascending `…20260213T224345`, descending `…20260212T105656`), whose
 * range bearings are 76° and 284° — nearly opposite, which is exactly why the islands jumped.
 *
 * For each pass, the lake mask was scanned along that pass's own range direction to find the offset
 * at which the polygon covers the darkest pixels — i.e. where the water actually is in the product:
 *
 * | pass | predicted (this file) | predicted, negated | measured | |
 * |---|---|---|---|---|
 * | ascending | −162 m | **+162 m** | **+150 m** | error 12 m — under half a pixel |
 * | descending | −129 m | **+129 m** | **+150 m** | error 21 m — under one pixel |
 *
 * Against the un-negated figures the errors are **312 m and 279 m**, about eleven pixels. So the
 * magnitude and the physics are confirmed, and so is the direction — **but only once it is clear which
 * direction the returned offset is in.** See {@link maskOffsetMeters}, which exists so that nobody has
 * to rediscover this the way it was discovered here.
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

/**
 * The same displacement, in the direction a **mask** has to move.
 *
 * ## ⚠ Read this before applying either function, because they point opposite ways
 *
 * {@link geocodeOffsetMeters} answers *"where should this lake's pixels be drawn?"* — it is a
 * correction to the **imagery**. A caller who is instead asking *"where are this lake's pixels, so I
 * can measure them?"* wants the **negation**, because the product has already displaced them.
 *
 * Both are one line, both look right, and choosing wrong does not halve the correction — it **doubles
 * the error** and leaves a number that is still a plausible backscatter. Measured on the Mascoma pair
 * (see the module note): the right direction lands within 12–21 m, the wrong one within 279–312 m.
 *
 * So the two directions are two named functions rather than one function and a minus sign at each
 * call site. Use this one to move a zone polygon, a mask, or anything else being pushed *onto* the
 * pixels; use {@link geocodeOffsetMeters} to move the pixels themselves.
 */
export function maskOffsetMeters(
  params: Parameters<typeof geocodeOffsetMeters>[0],
): { eastM: number; northM: number } {
  const { eastM, northM } = geocodeOffsetMeters(params);
  return { eastM: -eastM, northM: -northM };
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
