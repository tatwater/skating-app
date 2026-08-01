/**
 * Anisotropic gridding along a lake's own axis (N6b).
 *
 * ## The problem
 *
 * A lake bed is not isotropic. A glacially-scoured basin varies gradually **along** its length and
 * sharply **across** it — that is what makes it a trough rather than a bowl. An interpolator that
 * treats distance the same in every direction does not know this, and on sparse data it produces a
 * characteristic failure: the deep readings, which sit far apart along the axis, get out-pulled by
 * shallow near-shore readings that happen to sit closer in plain 2-D distance. The continuous trough
 * breaks into a row of isolated pits.
 *
 * Measured on MIDAS 1100 (Pleasant Lake, 90 soundings over 4.8 km), the long-axis depth profile runs
 * **44–64 ft continuously across half the lake** — a real, connected trough — while consecutive deep
 * readings are ~300 m apart along it and shallow shore readings are ~100 m away across it. The fit
 * split what the data says is joined.
 *
 * ## The fix, and what it does and does not assume
 *
 * Rotate into the lake's own frame, **compress the along-axis coordinate**, grid, then expand and
 * rotate back. Compressing the axis makes two points 300 m apart along it look 300/ratio apart to the
 * interpolator, so the along-axis connection competes fairly with the across-axis pull.
 *
 * This is a **smoothness prior, not a data claim**, and the distinction is the whole justification:
 *
 * - It changes the shape of the fit **between** measurements, where the isotropic alternative was not
 *   neutral either — it was asserting that the bed varies as fast lengthwise as it does across, which
 *   is a claim about lake morphology too, just a worse one.
 * - It **cannot override a measurement**. `gmt surface` interpolates: it fits through the data
 *   subject to tension. So a genuine shallow reading between two deep ones remains a sill, and a lake
 *   with two troughs separated by a real ridge keeps both troughs and the ridge. What gets connected
 *   is deeps with *nothing measured in between* — which is exactly the case where an isotropic fit was
 *   inventing a rise that nobody sounded.
 *
 * That last property is why this is defensible on a phase whose opening argument is about not drawing
 * what we did not measure. Every interpolator embeds a prior; this replaces an implicit and wrong one
 * with an explicit and better-founded one.
 */

/** A point in the lake's local metric frame: `along` the axis, `across` it, both in metres. */
export interface LocalPoint {
  along: number;
  across: number;
}

export interface Frame {
  /** Origin in lng/lat — the centroid the rotation is about. */
  originLng: number;
  originLat: number;
  /** Principal-axis bearing, radians, measured from east in the local metric plane. */
  angle: number;
  /** Metres per degree of longitude at this latitude. */
  mPerLng: number;
}

const M_PER_DEG_LAT = 111_320;

/**
 * The principal axis of a point cloud, by the eigenvector of its covariance matrix.
 *
 * Computed in a **locally metric** frame rather than raw degrees: at 45°N a degree of longitude is
 * about 0.7 of a degree of latitude, so a lake running east–west would otherwise appear ~40% longer
 * than it is and the axis would be pulled toward east–west on every lake in the corpus.
 */
export function principalFrame(points: readonly { lng: number; lat: number }[]): Frame {
  let sumLng = 0;
  let sumLat = 0;
  for (const p of points) {
    sumLng += p.lng;
    sumLat += p.lat;
  }
  const n = Math.max(1, points.length);
  const originLng = sumLng / n;
  const originLat = sumLat / n;
  const mPerLng = M_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180);

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const x = (p.lng - originLng) * mPerLng;
    const y = (p.lat - originLat) * M_PER_DEG_LAT;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  // The eigenvector angle of a symmetric 2×2 covariance. `atan2` rather than `atan` so a vertical
  // axis (sxx === syy) resolves rather than dividing by zero.
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { originLng, originLat, angle, mPerLng };
}

/** lng/lat → the lake's local frame. */
export function toLocal(point: { lng: number; lat: number }, frame: Frame): LocalPoint {
  const x = (point.lng - frame.originLng) * frame.mPerLng;
  const y = (point.lat - frame.originLat) * M_PER_DEG_LAT;
  const cos = Math.cos(frame.angle);
  const sin = Math.sin(frame.angle);
  return { along: x * cos + y * sin, across: -x * sin + y * cos };
}

/** The lake's local frame → lng/lat. Exactly inverts `toLocal`. */
export function fromLocal(local: LocalPoint, frame: Frame): { lng: number; lat: number } {
  const cos = Math.cos(frame.angle);
  const sin = Math.sin(frame.angle);
  const x = local.along * cos - local.across * sin;
  const y = local.along * sin + local.across * cos;
  return {
    lng: frame.originLng + x / frame.mPerLng,
    lat: frame.originLat + y / M_PER_DEG_LAT,
  };
}

/**
 * How much more slowly the bed is assumed to vary along the lake's axis than across it.
 *
 * **Tunable, and deliberately the most adjustable number in this pipeline** (founder call,
 * 2026-08-01: *"I want to see what things look like if we really try it. But if it ends up making
 * things look silly, I'd love to be able to adjust it back."*).
 *
 * `1` is the isotropic behaviour this replaces. Higher values connect deeps more readily. It cannot
 * be pushed into fabricating a trough through measured shallow water — `surface` fits through its
 * data whatever this is set to — so the failure mode of an over-large value is a lake that looks
 * more channel-like than it is *in the gaps between soundings*, not one that contradicts a reading.
 */
export const THALWEG_ANISOTROPY = 4;

/**
 * Apply the anisotropy: compress along-axis distance so it competes fairly with across-axis distance.
 *
 * Separated from the frame maths so the pipeline can grid in compressed space and expand the
 * resulting contours by the exact inverse — a mismatch between the two would rotate and stretch every
 * lake in the corpus by a factor nobody would spot in a thumbnail.
 */
export function compressAlong(local: LocalPoint, ratio: number): LocalPoint {
  return { along: local.along / ratio, across: local.across };
}

export function expandAlong(local: LocalPoint, ratio: number): LocalPoint {
  return { along: local.along * ratio, across: local.across };
}
