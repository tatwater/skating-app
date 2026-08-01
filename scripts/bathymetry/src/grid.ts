/**
 * The gridding plan for one lake (N6b) — every number GMT is handed, computed in one place.
 *
 * This is the arithmetic the phase doc warns about most directly: *"every failure here was invisible
 * in code review and obvious on a render."* It is extracted from the CLI so it can be tested without
 * GMT installed, because the failures it can produce are silent by construction:
 *
 * - The **solve region** is in the lake's compressed frame and the **real region** is not. They differ
 *   by exactly one factor of `ratio` on the along-axis coordinate, applied to both ends. Get the
 *   factor backwards and every lake in the corpus is stretched or squashed by 2–4×, which looks
 *   entirely plausible in a thumbnail of a lake you have never seen.
 * - The **filter width** is in real metres while the grid increment is in compressed ones, so it
 *   carries the `ratio` and the increment does not. Miss that and the Gaussian is 4× too narrow along
 *   the axis — which does not fail, it just stops removing the artifact it exists to remove.
 * - The **mask radius** is in compressed units because `surface -M` runs before `grdedit`. A circle in
 *   the compressed frame is an along-axis ellipse in the real one, which is the *intended* behaviour
 *   (the anisotropy prior says we will extrapolate further along the axis than across it) but is worth
 *   stating, because it looks like a bug until you know it isn't.
 *
 * Everything here is a pure function of the soundings, the frame and the tunables. No file I/O, no
 * subprocesses, no clock.
 */

import { MAX_GAP_RATIO } from './density';
import { compressAlong, type Frame, type LocalPoint, toLocal } from './thalweg';

/**
 * Grid cells across the lake's long axis.
 *
 * 500 keeps a contour smooth at drawer zoom without making `surface` iterate for minutes on
 * Champlain — which at 174 km across is the case that sets this ceiling rather than a typical pond.
 */
export const GRID_CELLS = 500;

/**
 * Spline tension, 0 (minimum curvature) to 1 (harmonic).
 *
 * GMT's own guidance for bathymetry and steep topography is ~0.25: unconstrained minimum-curvature
 * splines oscillate around sharp gradients, which on a lake bed means ringing around a drop-off — the
 * same class of invented structure as IDW's bullseyes, arriving from the opposite direction.
 */
export const TENSION = 0.25;

/**
 * Gaussian filter width, in grid cells, applied to the surface before contouring.
 *
 * Three sits firmly between the two scales that matter: wider than the raster tracing artifact it
 * exists to remove, and far narrower than the sounding spacing, so it cannot smooth away a feature the
 * survey actually resolved. A filter approaching the data spacing would invent a smoother lake than
 * was measured.
 */
export const SMOOTH_CELLS = 3;

/** Metres per degree of latitude. Matches `thalweg.ts`. */
const M_PER_DEG_LAT = 111_320;

/** Pad the solve region by this fraction of its long side, so the mask isn't clipped by the frame. */
const REGION_PAD = 0.02;

export interface GridPlan {
  /** Anisotropy actually applied — the configured ratio capped by the lake's own elongation. */
  ratio: number;
  /** `-R` for the solve, in the compressed local frame. */
  region: string;
  /** `-R` for `grdedit`, relabelling the solved grid back to real metres. */
  realRegion: string;
  /** `-I`, the cell size, square in the compressed frame. */
  increment: string;
  /** `-M` for `surface`, in compressed units. */
  maskRadius: number;
  /** `-Fg` for `grdfilter`, in real metres. */
  filterWidthM: number;
  /** Shoreline resampling interval, real metres — roughly one grid cell. */
  shoreSpacingM: number;
  /** Bounds of the compressed cloud, for callers that need the extent. */
  bounds: { minAlong: number; maxAlong: number; minAcross: number; maxAcross: number };
}

/** Bounds of a set of local points. Exported for the tests, which assert on it directly. */
export function localBounds(points: readonly LocalPoint[]): GridPlan['bounds'] {
  let minAlong = Number.POSITIVE_INFINITY;
  let maxAlong = Number.NEGATIVE_INFINITY;
  let minAcross = Number.POSITIVE_INFINITY;
  let maxAcross = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.along < minAlong) minAlong = p.along;
    if (p.along > maxAlong) maxAlong = p.along;
    if (p.across < minAcross) minAcross = p.across;
    if (p.across > maxAcross) maxAcross = p.across;
  }
  return { minAlong, maxAlong, minAcross, maxAcross };
}

/** The widest span of a lng/lat cloud, in degrees — used to size the shoreline resampling. */
export function spanDegrees(points: readonly { lng: number; lat: number }[]): number {
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return 0;
  return Math.max(maxLng - minLng, maxLat - minLat);
}

/**
 * Every number GMT needs for one lake.
 *
 * `cloud` is the full compressed set — soundings **and** shoreline — because the region has to contain
 * both. Sizing it on the soundings alone leaves the shore constraint outside the frame on any lake
 * whose survey stopped short of the bank, which is most of them.
 */
export function gridPlan(
  cloud: readonly LocalPoint[],
  ratio: number,
  options: { gridCells?: number; smoothCells?: number; maxGapRatio?: number } = {},
): GridPlan {
  const gridCells = options.gridCells ?? GRID_CELLS;
  const smoothCells = options.smoothCells ?? SMOOTH_CELLS;
  const maxGapRatio = options.maxGapRatio ?? MAX_GAP_RATIO;

  const bounds = localBounds(cloud);
  const spanAlong = bounds.maxAlong - bounds.minAlong;
  const spanAcross = bounds.maxAcross - bounds.minAcross;
  const longSide = Math.max(spanAlong, spanAcross);
  const pad = longSide * REGION_PAD;
  const increment = longSide / gridCells;

  // **The region must be a whole number of cells on both axes**, or `blockmedian` refuses the job
  // with *"(x_max-x_min) must equal (NX + eps) * x_inc"*. A padded bbox almost never is: the pad is a
  // fraction of the long side, so the short axis lands mid-cell. Two of twenty-five real lakes failed
  // exactly here, and the failure is per-lake and data-dependent — which is why it survived a run that
  // drew twenty-three others correctly.
  //
  // Snapped outward, never inward: growing the frame adds empty margin, whereas shrinking it would
  // crop a sounding or a stretch of shoreline out of the solve.
  const snap = (low: number, high: number): [number, number] => {
    const cells = Math.max(1, Math.ceil((high - low) / increment));
    return [low, low + cells * increment];
  };
  const [loAlong, hiAlong] = snap(bounds.minAlong - pad, bounds.maxAlong + pad);
  const [loAcross, hiAcross] = snap(bounds.minAcross - pad, bounds.maxAcross + pad);
  const lo = { along: loAlong, across: loAcross };
  const hi = { along: hiAlong, across: hiAcross };

  return {
    ratio,
    region: `-R${lo.along}/${hi.along}/${lo.across}/${hi.across}`,
    // Expanded on the along axis only, and on BOTH ends — `grdedit -R` relabels the coordinate range
    // without touching a value, so this is the exact inverse of the compression the solver saw.
    realRegion: `-R${lo.along * ratio}/${hi.along * ratio}/${lo.across}/${hi.across}`,
    increment: `-I${increment}`,
    maskRadius: longSide * maxGapRatio,
    // Real metres: the along span is un-compressed here because `grdfilter` runs after `grdedit`.
    filterWidthM: (Math.max(spanAlong * ratio, spanAcross) / gridCells) * smoothCells,
    shoreSpacingM: Math.max(5, (longSide * ratio) / gridCells),
    bounds,
  };
}

/**
 * Build the compressed cloud the solver is fed: soundings at their depth, shoreline vertices at zero.
 *
 * Kept beside `gridPlan` because the two must agree about what "the cloud" is — a plan sized on a
 * different set than the one written to the `.xyz` is the failure this pairing exists to prevent.
 */
export function compressedCloud(
  points: readonly { lng: number; lat: number; depthFt: number }[],
  shore: readonly { lng: number; lat: number }[],
  frame: Frame,
  ratio: number,
): (LocalPoint & { depthFt: number })[] {
  return [
    ...points.map((p) => ({ ...compressAlong(toLocal(p, frame), ratio), depthFt: p.depthFt })),
    ...shore.map((p) => ({ ...compressAlong(toLocal(p, frame), ratio), depthFt: 0 })),
  ];
}

/** Degrees of longitude per metre at a latitude — for sizing a shoreline resample in degrees. */
export function metresPerLngDegree(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}
