/**
 * Weather sample-point suggestion (N2, the deferred half of D56 §5).
 *
 * Weather doesn't vary below Open-Meteo's grid, so **every body samples at its centroid by default**
 * and only the genuinely multi-cell giants need more — Champlain is ~200 km end to end, and a single
 * sample at its middle says nothing useful about the ice at either end. The escape hatch
 * (`waterBodies.weatherSamplePoints[]`) has shipped since Phase 10 with a reader and no writer; this
 * is the arithmetic behind the writer.
 *
 * Points are **suggested, not clicked**. Hand-placing a dozen points on a 200 km lake at a spacing
 * you're eyeballing is the kind of task that looks easy and produces a bad grid — too clustered at
 * one end, a gap where the ice actually differs. A grid the operator then nudges is both faster and
 * more defensible, and the spacing becomes a number in the control room rather than a habit.
 */

import type { MultiPolygon, Polygon } from 'geojson';
import {
  type BBox,
  type LatLng,
  pointInPolygon,
  polygonBBox,
  representativePoint,
} from './geometry';

/**
 * Default spacing between suggested sample points, in km.
 *
 * Open-Meteo's high-resolution models run at roughly 2–11 km depending on region and variable, so
 * sampling finer than ~11 km buys distinct cache keys for identical forecasts — pure cost, on a free
 * tier the whole app shares. Tunable, and surfaced in the Phase-7b control room next to the other
 * weather constants.
 */
export const DEFAULT_SAMPLE_SPACING_KM = 11;

/**
 * Hard ceiling on suggested points for one body. An absurdity guard, not a product limit: a
 * mis-entered spacing (0.1 km on Champlain) would otherwise propose tens of thousands of points, each
 * of which is a forecast fetch and a cache row. At the default spacing the largest body in the corpus
 * suggests well under twenty, so this never binds in practice — and when it does bind, the caller is
 * told rather than handed a silently-truncated grid (D5).
 */
export const MAX_SUGGESTED_SAMPLE_POINTS = 64;

/** Metres per degree of latitude (WGS84 mean) — the same constant basis as `haversineMeters`. */
const M_PER_DEG_LAT = 111_320;
const DEG = Math.PI / 180;

export interface SampleSuggestion {
  points: LatLng[];
  /** True when {@link MAX_SUGGESTED_SAMPLE_POINTS} cut the grid short — never silent (D5). */
  truncated: boolean;
  /**
   * True when no grid point landed on the water and the suggestion fell back to the body's
   * representative point. Common for a long skinny river reach; the operator should know the grid
   * didn't actually apply.
   */
  fellBackToCentroid: boolean;
}

/**
 * A grid of sample points over `polygon` at `spacingKm`, keeping only the points that land **on the
 * water**, and never returning an empty set.
 *
 * **The longitude step is computed at the bbox's highest latitude**, where a degree of longitude is
 * shortest. That makes every actual gap in the grid *at least* the requested spacing rather than
 * on-average-about-it: the guarantee runs one way on purpose, because being finer than requested
 * means paying for forecasts that duplicate each other, while being slightly coarser costs nothing
 * the model can resolve. It's property-tested in that direction.
 *
 * **The grid is centred on the bbox**, not started at its corner, so a body that fits inside one
 * spacing gets a point in the middle rather than one hugging its southwest edge.
 *
 * **It never returns nothing.** A long skinny reach can slip between grid lines entirely; a body with
 * no sample points would silently fall back to its centroid at read time anyway (see
 * `lib/sampling.ts`), so returning that point explicitly — flagged — is the same behaviour said out
 * loud, and the operator can see the grid didn't take.
 */
export function suggestSamplePoints(
  polygon: Polygon | MultiPolygon,
  spacingKm: number = DEFAULT_SAMPLE_SPACING_KM,
): SampleSuggestion {
  const fallback = (): SampleSuggestion => ({
    points: [representativePoint(polygon)],
    truncated: false,
    fellBackToCentroid: true,
  });

  if (!Number.isFinite(spacingKm) || spacingKm <= 0) return fallback();
  const box: BBox = polygonBBox(polygon);

  const spacingM = spacingKm * 1000;
  const latStep = spacingM / M_PER_DEG_LAT;
  // The worst-case (shortest) degree of longitude anywhere in the box is at the latitude furthest
  // from the equator, so sizing the step there makes every other row's gap wider, never narrower.
  const worstLat = Math.max(Math.abs(box.minLat), Math.abs(box.maxLat));
  const cosWorst = Math.cos(Math.min(89.9, worstLat) * DEG);
  const lngStep = spacingM / (M_PER_DEG_LAT * Math.max(cosWorst, 1e-6));
  if (!Number.isFinite(latStep) || !Number.isFinite(lngStep) || latStep <= 0 || lngStep <= 0) {
    return fallback();
  }

  const points: LatLng[] = [];
  let truncated = false;
  // Centre the grid: how many whole steps fit, then inset by the leftover half so the row/column
  // pattern is symmetric about the body rather than anchored to its corner.
  const rows = Math.floor((box.maxLat - box.minLat) / latStep) + 1;
  const cols = Math.floor((box.maxLng - box.minLng) / lngStep) + 1;
  const latOrigin = box.minLat + (box.maxLat - box.minLat - (rows - 1) * latStep) / 2;
  const lngOrigin = box.minLng + (box.maxLng - box.minLng - (cols - 1) * lngStep) / 2;

  outer: for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const point = { lat: latOrigin + r * latStep, lng: lngOrigin + c * lngStep };
      if (!pointInPolygon(point, polygon)) continue;
      if (points.length >= MAX_SUGGESTED_SAMPLE_POINTS) {
        truncated = true;
        break outer;
      }
      points.push(point);
    }
  }

  if (points.length === 0) return fallback();
  return { points, truncated, fellBackToCentroid: false };
}
