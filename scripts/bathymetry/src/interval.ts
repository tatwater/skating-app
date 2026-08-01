/**
 * Choosing a contour interval for the **sounding** lanes (N6b).
 *
 * The contour lanes (NH, MA) need none of this: the agency chose an interval when it surveyed, D83
 * says carry it natively, and we tile what they published. But Vermont and Maine give us depth
 * points, so the interval is **ours to pick** — and picking it is a real decision rather than a
 * formatting detail, because it is the resolution at which we claim to know the basin.
 *
 * Two constraints pull against each other:
 *
 * - **Too fine and we are drawing our interpolator's noise.** Five-foot contours through soundings
 *   spaced 200 m apart render the fit's wobble as though it were bathymetry — the GLOBathy mistake at
 *   a smaller scale, and this document exists because we refused it once already.
 * - **Too coarse and the layer says nothing.** Two lines on a lake is not a picture of a basin.
 *
 * The resolution: **a target number of lines, snapped to a interval a person would recognise.** A
 * skater reads a contour map by counting bands, so roughly a dozen bands is legible whether the lake
 * is 12 ft deep or 400 — and snapping to {2, 5, 10, 20, 25, 50, 100} keeps the labels readable and
 * matches the intervals the surveyed states actually publish.
 */

/**
 * Intervals a person recognises, in feet. Deliberately the set NH and MassGIS already use, so an
 * interpolated Vermont lake and a surveyed New Hampshire one look like the same kind of map even
 * though D83 keeps them separately labelled.
 */
export const NICE_INTERVALS_FT: readonly number[] = [2, 5, 10, 20, 25, 50, 100];

/**
 * How many contour bands to aim for.
 *
 * Twelve is a legibility judgement, not a measurement: enough bands to read a basin's shape, few
 * enough that the labels don't collide at drawer zoom. It is the one number here worth revisiting
 * against a real screen rather than against a rule.
 */
export const TARGET_CONTOUR_COUNT = 12;

/**
 * The interval for a lake, from the depth range its soundings actually cover.
 *
 * Driven by the **measured maximum**, never by a nominal lake depth: the deepest sounding is the
 * deepest thing we can honestly draw a line at, and contouring past it would be extrapolating into
 * water nobody sounded.
 */
export function chooseInterval(maxDepthFt: number): number {
  const fallback = NICE_INTERVALS_FT[0] ?? 2;
  if (!Number.isFinite(maxDepthFt) || maxDepthFt <= 0) return fallback;

  const ideal = maxDepthFt / TARGET_CONTOUR_COUNT;
  let best = fallback;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of NICE_INTERVALS_FT) {
    // Compared in log space so "twice as coarse as ideal" and "half as fine" are penalised equally.
    // On a linear comparison the large candidates always look further away and a 400 ft lake ends up
    // with 5 ft contours.
    const distance = Math.abs(Math.log(candidate / ideal));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * The depths to contour a lake at: every multiple of the interval strictly inside the sounded range.
 *
 * **Zero is excluded deliberately** — that is the shoreline, which the water-body polygon already
 * draws, and adding it would double-stroke every lake edge in the contour palette at exactly the
 * place D82 says a contour must lose to anything competing with it.
 *
 * The deepest sounding is excluded too unless a level falls below it: a contour *at* the maximum is a
 * closed ring around a single point, which is a rendering of where the boat happened to pass rather
 * than of the basin.
 */
export function contourLevels(maxDepthFt: number, interval: number): number[] {
  if (!Number.isFinite(maxDepthFt) || maxDepthFt <= 0 || interval <= 0) return [];
  const levels: number[] = [];
  for (let depth = interval; depth < maxDepthFt; depth += interval) {
    levels.push(Math.round(depth * 100) / 100);
  }
  return levels;
}
