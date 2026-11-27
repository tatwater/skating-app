/**
 * **The foliage score** (B05 §2.1.4, D319): how green a frame's vegetation is, read from the
 * catalog's 200-px thumbnail, so a September frame already in autumn color or brown can be put in
 * front of the founder for striking.
 *
 * **A score is a prompt for review, never a verdict.** The selection reads only the reviewed list
 * (core's `NAIP_FOLIAGE_STRIKES`); a score under the threshold makes a frame a *candidate* on the
 * review sheet (`foliageSheet.ts`) and nothing else.
 *
 * The measure, per pixel of 8-bit RGB (the analyst's, 2026-11-26, ported exactly):
 *
 * - **nodata** — every band at most 8 (past a frame's edge);
 * - **water** — darker than 30, or blue at least as bright as red and green, or darker than 55 with
 *   blue at least red;
 * - **neutral** — the bands within 12 of each other, or every band at least 175 (roads, roofs, rock,
 *   cloud, bare ground);
 * - **vegetation** — every other valid pixel: colored land;
 * - **green** — a vegetation pixel whose green–red index `(G − R) / (G + R)` is over 0.02 (GRVI,
 *   Motohka et al. 2010: it crosses zero as leaves color).
 *
 * The score is the green share of the vegetation pixels. It has no verdict when a thumbnail holds too
 * little vegetation to say (under 200 pixels, or under a quarter of the valid ones: open water, a
 * city). Every comparison is in integers — `49·G > 51·R` is GRVI over 0.02 — so the score is exact
 * and the same on every machine for the same decoded pixels.
 *
 * **Known misses**, stated on the sheet: cities read as not green (pavement and roofs with a few
 * street trees), so a city frame can score as turned in high summer; some partly yellowed frames
 * pass (a frame half turned can still be 60% green); and dull July frames aren't judged at all, since
 * only frames flown from 1 September are scored.
 */

/** A thumbnail's pixel counts: the score is derived from these, never stored rounded. */
export interface FoliageScore {
  /** Pixels that are image (not past the frame's edge). */
  valid: number;
  /** Valid pixels that are vegetation (not water, not neutral). */
  veg: number;
  /** Vegetation pixels that are clearly green. */
  green: number;
}

/** A frame whose green share is under this reads as turned (the founder, 2026-11-27: 0.6). */
export const FOLIAGE_TURNED_BELOW = 0.6;

/** A frame from `FOLIAGE_TURNED_BELOW` up to this is borderline: kept, and shown on its own. */
export const FOLIAGE_BORDERLINE_BELOW = 0.7;

/**
 * Frames flown on or after this month and day are scored. Earlier ones aren't judged at all — a dull
 * July frame isn't autumn, and a June frame's pale new leaves would read as turned.
 */
export const FOLIAGE_SCORED_FROM = '09-01';

/** Fewer vegetation pixels than this: no verdict. */
export const FOLIAGE_MIN_VEG_PIXELS = 200;

/** Vegetation under this share of the valid pixels: no verdict (water, a city). */
export const FOLIAGE_MIN_VEG_SHARE = 0.25;

/** Is a frame flown on `acquired` (`YYYY-MM-DD`) one the foliage screen judges? */
export function isFoliageScored(acquired: string): boolean {
  return acquired.slice(5) >= FOLIAGE_SCORED_FROM;
}

/** Counts a thumbnail's pixels, RGB triples. A trailing partial triple is ignored. */
export function foliagePixels(rgb: Uint8Array): FoliageScore {
  const pixels = Math.floor(rgb.length / 3);
  let valid = 0;
  let veg = 0;
  let green = 0;
  for (let p = 0; p < pixels * 3; p += 3) {
    const r = rgb[p] as number;
    const g = rgb[p + 1] as number;
    const b = rgb[p + 2] as number;
    const hi = Math.max(r, g, b);
    if (hi <= 8) continue;
    valid++;
    if (hi < 30 || b >= Math.max(r, g) || (hi < 55 && b >= r)) continue; // water
    const lo = Math.min(r, g, b);
    if (hi - lo < 12 || lo >= 175) continue; // neutral
    veg++;
    if (49 * g > 51 * r) green++; // (g − r) / (g + r) > 0.02
  }
  return { valid, veg, green };
}

/**
 * The green share of the vegetation, 0–1; `null` when there is too little vegetation to say.
 */
export function greenShare(score: FoliageScore): number | null {
  if (score.veg < FOLIAGE_MIN_VEG_PIXELS) return null;
  if (score.veg < FOLIAGE_MIN_VEG_SHARE * score.valid) return null;
  return score.green / score.veg;
}

/** What the screen says of one scored frame. */
export type FoliageVerdict = 'turned' | 'borderline' | 'green' | 'noVerdict';

/**
 * The screen's reading of a score: under `threshold` turned; under `FOLIAGE_BORDERLINE_BELOW`
 * borderline (kept); green above; `noVerdict` without enough vegetation. `null` (unscored: no
 * thumbnail) is `noVerdict` too — never turned by default.
 */
export function foliageVerdict(
  score: FoliageScore | null | undefined,
  threshold: number = FOLIAGE_TURNED_BELOW,
): FoliageVerdict {
  const share = score == null ? null : greenShare(score);
  if (share === null) return 'noVerdict';
  if (share < threshold) return 'turned';
  if (share < Math.max(threshold, FOLIAGE_BORDERLINE_BELOW)) return 'borderline';
  return 'green';
}
