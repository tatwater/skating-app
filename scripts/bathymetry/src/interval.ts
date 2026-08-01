/**
 * Choosing which depths to draw a line at (N6b).
 *
 * ## The rule, and why it changed
 *
 * This module used to target **~12 bands per lake**, snapping to a recognisable interval. Checked
 * against the agencies' own charts on 2026-08-01, that turned out to be backwards in the way that
 * matters: it made the interval a function of *depth alone*, so Washington Pond (36 ft, **105
 * soundings**) got a 2 ft interval and seventeen levels while Lake Morey (42 ft, **68,139 soundings**)
 * got 5 ft. The sparse lake was given the fine interval and the dense one the coarse.
 *
 * The founder's call replaced it (2026-08-01):
 *
 * > *"I'd rather see contours every 5 ft and therefore only get 3 contours in one lake and 10 in
 * > another. But I don't want to just make it up and end up with a very inaccurate depiction."*
 *
 * So: **a fixed ladder, not a per-lake target.** Every lake is drawn on the same 5 ft ladder, and the
 * number of rings is therefore a direct readout of how deep the lake is — three rings on a 17 ft pond,
 * eleven on a 59 ft one. Depth is legible *across* lakes rather than only within one.
 *
 * ## The one direction the ladder may move, and why only one
 *
 * **Coarser, never finer.** The interval can step up to 10, 25 or 50 ft, and each of those is a whole
 * multiple of the base, so every level drawn anywhere is a member of the same 5 ft ladder and rings
 * from two lakes always nest. Two things move it:
 *
 * - **Depth**, so Champlain does not get 79 rings.
 * - **Data support**, which is the *"don't just make it up"* half. A band needs measurements around it
 *   to be traced from rather than invented, so a lake with few independent samples gets fewer, coarser
 *   rings. It can never gain rings it has no data for.
 *
 * Refusing to go finer than the base is what keeps this honest: the failure mode we were shipping was
 * *too many* lines on *too little* data, and no lake gets a denser picture than the standard.
 *
 * ## Why this is not the "drop bunched contours" idea the founder rejected
 *
 * That earlier proposal dropped levels **where lines crowded together on the map**, which would have
 * made ring count depend on how steep the bed is — *"a deep lake with a steep bed would then show
 * fewer rings than a shallow one with a gentle bed, understating depth by omission"* (D82). A fixed
 * depth ladder is the opposite: spacing is uniform in **depth**, never in map distance, so a deeper
 * lake always shows more rings. It settles that open question rather than reopening it.
 *
 * *(Spatial crowding on a steep bed is untouched by any of this and remains open — it is a rendering
 * problem, not a level-selection one.)*
 */

/**
 * The ladder everything is drawn on, in feet.
 *
 * Five because it is what the agencies themselves reach for — Maine IF&W's charts are labelled in
 * 5 ft and 10 ft, and MassGIS steps in 5 ft below the shallows — and because a skater reads "every
 * five feet" without a legend. It is a judgement, but it is not an arbitrary one.
 */
export const BASE_INTERVAL_FT = 5;

/**
 * Steps up from the base. Each is a whole multiple, so every drawn level anywhere is on the same
 * ladder and two lakes' rings always nest.
 */
export const INTERVAL_MULTIPLES: readonly number[] = [1, 2, 5, 10];

/**
 * The most rings any lake gets, however deep.
 *
 * A legibility ceiling rather than a data one: past about twenty the lines stop being countable at
 * drawer zoom and the picture reads as shading. Champlain at 399 ft would otherwise draw 79.
 */
export const MAX_BANDS = 20;

/**
 * Independent measurements a band needs before it is traced rather than invented.
 *
 * **Independent** is the load-bearing word, and it is why the caller passes a *cell* count rather than
 * a point count: `blockmedian` reduces the input to one value per grid cell before the spline sees
 * anything, so a sonar transect with 1,387 readings clustered into 24 cells carries 24 measurements'
 * worth of information, not 1,387. Five is deliberately generous — the point is to stop a lake with
 * two dozen readings claiming a dozen bands, not to be precise about a number nobody can calibrate.
 */
export const MIN_SAMPLES_PER_BAND = 5;

export interface IntervalChoice {
  intervalFt: number;
  levels: number[];
  /** Why it is not the base interval, when it isn't. Rendered on the card and in the drop log. */
  coarsenedBy?: 'depth' | 'data support';
}

/**
 * The depths to contour at: every multiple of the interval strictly inside the sounded range.
 *
 * **Zero is excluded deliberately** — that is the shoreline, which the water-body polygon already
 * draws, and adding it would double-stroke every lake edge in the contour palette at exactly the place
 * D82 says a contour must lose to anything competing with it.
 *
 * The deepest sounding is excluded too unless a level falls below it: a contour *at* the maximum is a
 * closed ring around a single point, which draws where the boat happened to pass rather than the basin.
 */
export function contourLevels(maxDepthFt: number, interval: number): number[] {
  if (!Number.isFinite(maxDepthFt) || maxDepthFt <= 0 || interval <= 0) return [];
  const levels: number[] = [];
  for (let depth = interval; depth < maxDepthFt; depth += interval) {
    levels.push(Math.round(depth * 100) / 100);
  }
  return levels;
}

/**
 * The interval and levels for a **sounding** lane, from the depth range and the data behind it.
 *
 * `independentSamples` is the number of distinct grid cells the soundings occupy — what survives
 * `blockmedian` — and not the raw reading count. Passing the raw count would defeat the whole gate on
 * exactly the lanes it exists for, since transect logs are enormous and clustered.
 */
export function chooseInterval(
  maxDepthFt: number,
  independentSamples = Number.POSITIVE_INFINITY,
): IntervalChoice {
  const base = BASE_INTERVAL_FT;
  if (!Number.isFinite(maxDepthFt) || maxDepthFt <= 0) {
    return { intervalFt: base, levels: [] };
  }

  const affordable = Number.isFinite(independentSamples)
    ? Math.floor(Math.max(0, independentSamples) / MIN_SAMPLES_PER_BAND)
    : Number.POSITIVE_INFINITY;

  let choice: IntervalChoice | undefined;
  for (const multiple of INTERVAL_MULTIPLES) {
    const intervalFt = base * multiple;
    const levels = contourLevels(maxDepthFt, intervalFt);
    if (levels.length > MAX_BANDS) continue;
    if (levels.length > affordable) continue;
    // The first multiple that clears both ceilings, so we are always as fine as the lake can carry
    // and never finer.
    choice = {
      intervalFt,
      levels,
      ...(multiple === 1
        ? {}
        : {
            // Which ceiling actually bit, for the caption. Depth is reported when the base interval
            // would have exceeded the legibility ceiling on its own; otherwise the data is the limit.
            coarsenedBy:
              contourLevels(maxDepthFt, base).length > MAX_BANDS
                ? ('depth' as const)
                : ('data support' as const),
          }),
    };
    break;
  }

  if (choice) return choice;

  // Nothing on the ladder fits — a very deep lake with almost no readings. Draw at the coarsest step
  // and let the levels fall where they fall; the alternative is drawing nothing, and the caller's
  // density gate is the thing that decides whether this lake should be drawn at all.
  const coarsest = base * (INTERVAL_MULTIPLES[INTERVAL_MULTIPLES.length - 1] ?? 1);
  return {
    intervalFt: coarsest,
    levels: contourLevels(maxDepthFt, coarsest),
    coarsenedBy: 'data support',
  };
}

/**
 * Thin an agency's **published** levels toward the ladder, using only levels it actually surveyed.
 *
 * This is the contour lanes' half of the founder's call — *"maybe drop every-other contour from some
 * lakes that sampled super close together so that it's close to every 5 ft"* — and it is a subtraction
 * only. For each rung of the ladder we take the nearest published level within half a rung, and
 * otherwise take nothing. **No level is ever moved or invented**, which is what keeps D83 intact: the
 * rule was never *"don't choose which surveyed lines to show"*, it was *"don't draw a line where no
 * depth-sounder went."*
 *
 * Two consequences worth naming:
 *
 * - **A source coarser than the ladder is left alone.** NH publishes at 10 ft, so the 5 ft and 15 ft
 *   rungs find nothing within tolerance and its own levels come back untouched. We never add.
 * - **A source finer than the ladder is thinned.** MassGIS's 2/3/4/5 ft shallows collapse to the 5 ft
 *   rung, which is the case this exists for.
 *
 * **The deepest published level is always kept**, whichever rung it lands near. Found by running this
 * over the real corpus: a lake published at 2/4/6/8/10/12 ft thinned to 4/10 and *lost its 12 ft ring*
 * — the innermost one, the only line that says where the deep water is. Dropping it is precisely the
 * "understating depth by omission" that D82 refused when the founder rejected the drop-bunched-levels
 * proposal, arriving by a different route. The deepest ring is not a rung on a ladder; it is the
 * answer to the question the layer is being looked at for.
 */
export function thinPublishedLevels(
  published: readonly number[],
  intervalFt: number = BASE_INTERVAL_FT,
): number[] {
  if (intervalFt <= 0) return [...new Set(published)].sort((a, b) => a - b);
  const available = [...new Set(published.filter((d) => Number.isFinite(d) && d > 0))].sort(
    (a, b) => a - b,
  );
  if (available.length === 0) return [];

  const tolerance = intervalFt / 2;
  const deepest = available[available.length - 1] as number;
  // The innermost ring, always. See the note above: thinning it away understates depth by omission.
  const kept = new Set<number>([deepest]);
  for (let rung = intervalFt; rung <= deepest + tolerance; rung += intervalFt) {
    let best: number | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const level of available) {
      const distance = Math.abs(level - rung);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = level;
      }
    }
    if (best !== undefined && bestDistance <= tolerance) kept.add(best);
  }
  return [...kept].sort((a, b) => a - b);
}
