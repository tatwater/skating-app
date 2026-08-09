/**
 * **New Hampshire's depth-band polygons — max *and* a computed mean** (founder, 2026-08-09).
 *
 * ## What this source is, and why we had been reading the wrong half of it
 *
 * NH GRANIT publishes `EDP_Bathymetry_Lakes` as two layers. N6b read layer 0, the contour **lines**,
 * and drew them. Layer 1 is the same survey as **polygons** — one per depth band, carrying
 * `depthmin`, `depthmax` and `acres` — 7,351 rows over **636 assessment units**. That is a
 * hypsographic curve per lake, published, and nothing had ever read it.
 *
 * It gives two things the lines cannot:
 *
 * - **A real maximum.** The innermost polygon's `depthmax` is the deepest reading in that basin
 *   (Beaver Pond's is `40–47`), not the deepest round-numbered isobath. So NH's max stops being a
 *   lower bound, which is what a contour-derived one always is.
 * - **A mean depth**, by integrating the curve — see `meanDepthFt`.
 *
 * **So NH's depth comes from here and not from `scripts/bathymetry`'s contour lanes.** Two producers
 * writing the same rung for the same lake is the ambiguity this file exists to remove; `exportDepths`
 * skips `nh-granit-contours` by name and says why.
 *
 * ## The founder's constraint, and what it rules out
 *
 * *"Yes for NH's published bands, no for our surfaces"* (2026-08-09). The arithmetic below runs over
 * **the agency's own published areas**. Integrating our N6b interpolated surface would produce a mean
 * for every contoured lake in four states — and it would be our model wearing an agency's label,
 * which is a weaker claim than it looks. This does not do that.
 *
 * ## Two properties of the data that the code depends on, both measured (2026-08-09)
 *
 * 1. **The bands are disjoint and sum to the lake.** Horn Pond's three bands total 226.1 acres
 *    against a published surface area of ~226. That is what makes `Σ acres` usable as both the
 *    denominator of the mean and the area the join corroborates against.
 * 2. **A lake with no bathymetry is present anyway**, as a single `0–0` row with `bathy_int = 0`
 *    (Jones Pond, 3.1 acres). Read naively that is a lake with a maximum depth of zero.
 *
 * ⚠ **The layer also carries Maine assessment units** — Great East Lake and Horn Pond straddle the
 * border and are filed `MELAK…`. They are kept: the join is spatial, so which agency filed a lake
 * decides nothing, and refusing them would drop two real lakes to tidy up a prefix.
 */

/** One published band polygon, as the layer serves it. */
export interface NhBandRow {
  /** NHDES assessment-unit id — the per-lake key. */
  auId: string;
  lakeName: string;
  /** Shallow edge of the band, in **feet**. */
  depthMinFt: number;
  /** Deep edge, in feet. For the innermost polygon this is the deepest reading in the basin. */
  depthMaxFt: number;
  /** Plan area of the band, in acres. */
  acres: number;
  /** The band polygon's centroid, WGS84. */
  lat: number;
  lng: number;
  /** The survey's stated contour interval. `0` marks a lake with no bathymetry at all. */
  intervalFt?: number | undefined;
}

/** One lake's depth, integrated from its bands. */
export interface NhLakeDepth {
  auId: string;
  name: string;
  maxDepthFt: number;
  meanDepthFt: number;
  /** Σ of the band areas — the surveyed lake area, and the join's area corroboration. */
  areaAcres: number;
  /** Centroid of the **deepest** band: a disk rather than an annulus, so the point is on water. */
  lat: number;
  lng: number;
  bandCount: number;
}

/** Why a lake in the layer produced no depth. Named, never a silent filter. */
export type NhBandSkip =
  /** Every band was `0–0`: the lake is listed but was never sounded. */
  | 'no-bathymetry'
  /** Areas summed to zero, so there is no denominator for a mean. */
  | 'no-area'
  /** The integrated mean came out deeper than the maximum — arithmetically impossible. */
  | 'inverted';

export const MAX_PLAUSIBLE_NH_DEPTH_FT = 700;

/**
 * Mean depth, by the **frustum rule over the published hypsographic curve** — not by averaging the
 * band midpoints.
 *
 * A band's plan area is an annulus, and the naive estimate `Σ area × (d1 + d2) / 2` treats the water
 * over it as a prism. Checked against a cone, where the true mean is exactly `maxDepth / 3`:
 *
 * | method | cone, contours every 10 ft to 30 ft |
 * | --- | --- |
 * | band midpoints | 10.56 — **5.6% high** |
 * | frustum over cumulative areas | 9.997 |
 * | truth | 10 |
 *
 * So the frustum it is. `V = Σ h/3 × (A₁ + A₂ + √(A₁A₂))` between successive contour levels, where
 * `A(d)` is the area of everything **at least** `d` deep — recovered from the band areas, since a
 * band is the difference between two such areas. The final step runs from the deepest contour to the
 * deepest reading, where the lower area is zero and the frustum degenerates to a cone.
 *
 * **The levels are the distinct `depthMinFt` values, and that matters for lakes with more than one
 * basin.** Beaver Pond publishes both `10–15` and `10–20`: two lobes off the same contour, one of
 * which bottoms out shallower. Keying on the *shallow* edge keeps them in one curve instead of
 * inventing a 15 ft contour the survey never drew.
 */
export function meanDepthFt(bands: readonly NhBandRow[]): number {
  const totalArea = bands.reduce((sum, b) => sum + b.acres, 0);
  if (!(totalArea > 0)) return 0;

  const levels = [...new Set(bands.map((b) => b.depthMinFt))].sort((a, b) => a - b);
  const deepest = Math.max(...bands.map((b) => b.depthMaxFt));
  /** Area at least `d` deep — the cumulative curve, read off the band areas. */
  const areaAtOrBelow = (d: number) =>
    bands.reduce((sum, b) => (b.depthMinFt >= d ? sum + b.acres : sum), 0);

  let volume = 0;
  for (const [i, level] of levels.entries()) {
    const next = levels[i + 1] ?? deepest;
    const h = next - level;
    if (h <= 0) continue;
    const a1 = areaAtOrBelow(level);
    // At the deepest step the lower face is the deepest point, so the frustum becomes a cone.
    const a2 = i + 1 < levels.length ? areaAtOrBelow(next) : 0;
    volume += (h / 3) * (a1 + a2 + Math.sqrt(a1 * a2));
  }
  return volume / totalArea;
}

export type NhLakeOutcome =
  | { readonly ok: true; readonly lake: NhLakeDepth }
  | { readonly ok: false; readonly reason: NhBandSkip };

/** One assessment unit's bands → its depth, or a named refusal. */
export function nhLakeDepth(auId: string, bands: readonly NhBandRow[]): NhLakeOutcome {
  const sounded = bands.filter((b) => b.depthMaxFt > 0);
  if (sounded.length === 0) return { ok: false, reason: 'no-bathymetry' };

  const areaAcres = sounded.reduce((sum, b) => sum + b.acres, 0);
  if (!(areaAcres > 0)) return { ok: false, reason: 'no-area' };

  const maxDepthFt = Math.max(...sounded.map((b) => b.depthMaxFt));
  if (maxDepthFt > MAX_PLAUSIBLE_NH_DEPTH_FT) return { ok: false, reason: 'inverted' };

  const meanDepthFt_ = meanDepthFt(sounded);
  // Arithmetically impossible, and the signature of two columns read across each other — the same
  // check `parseAlscReport` makes, for the same reason.
  if (!(meanDepthFt_ > 0) || meanDepthFt_ > maxDepthFt) return { ok: false, reason: 'inverted' };

  // **The deepest band, because it is a disk rather than an annulus.** Every shallower band is a
  // ring whose centroid can land in its own hole — i.e. on an island, or on the deeper water it
  // encircles. The innermost one has no hole.
  let deepest = sounded[0] as NhBandRow;
  for (const b of sounded) if (b.depthMaxFt > deepest.depthMaxFt) deepest = b;

  return {
    ok: true,
    lake: {
      auId,
      name: sounded[0]?.lakeName ?? auId,
      maxDepthFt,
      meanDepthFt: meanDepthFt_,
      areaAcres,
      lat: deepest.lat,
      lng: deepest.lng,
      bandCount: sounded.length,
    },
  };
}

export interface NhBandResult {
  lakes: NhLakeDepth[];
  skipped: Record<NhBandSkip, number>;
  skippedKeys: { auId: string; reason: NhBandSkip }[];
}

/** Every band row → one depth per assessment unit, with the refusals counted and named. */
export function nhLakeDepths(rows: readonly NhBandRow[]): NhBandResult {
  const byLake = new Map<string, NhBandRow[]>();
  for (const row of rows) {
    const existing = byLake.get(row.auId);
    if (existing) existing.push(row);
    else byLake.set(row.auId, [row]);
  }

  const lakes: NhLakeDepth[] = [];
  const skipped: Record<NhBandSkip, number> = { 'no-bathymetry': 0, 'no-area': 0, inverted: 0 };
  const skippedKeys: { auId: string; reason: NhBandSkip }[] = [];
  for (const [auId, bands] of byLake) {
    const outcome = nhLakeDepth(auId, bands);
    if (outcome.ok) lakes.push(outcome.lake);
    else {
      skipped[outcome.reason]++;
      skippedKeys.push({ auId, reason: outcome.reason });
    }
  }
  return { lakes, skipped, skippedKeys };
}

/** The layer, and the fields we ask for by name. */
export const NH_BANDS_SERVICE_URL =
  'https://granit24a.sr.unh.edu/hosting/rest/services/Hosted/EDP_Bathymetry_Lakes/FeatureServer/1';

export const NH_BANDS_FIELDS = [
  'au_id',
  'lake',
  'depthmin',
  'depthmax',
  'acres',
  'bathy_int',
] as const;

/** Rows per request. The service advertises 2,000 and the layer is 7,351. */
export const NH_BANDS_PAGE_SIZE = 2000;

export function nhBandsQueryUrl(offset: number, pageSize: number = NH_BANDS_PAGE_SIZE): string {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: NH_BANDS_FIELDS.join(','),
    // **Centroid, not geometry.** We need one point per band and the rings are the render payload
    // N6b already fetched; asking for them again would multiply the archive for nothing.
    returnGeometry: 'false',
    returnCentroid: 'true',
    outSR: '4326',
    orderByFields: 'fid',
    resultOffset: String(offset),
    resultRecordCount: String(pageSize),
    f: 'json',
  });
  return `${NH_BANDS_SERVICE_URL}/query?${params.toString()}`;
}

function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The layer's "no assessment unit" sentinel — **a string, so it groups like a real key.**
 *
 * One row carries it today (`JONES BROOK POND`, 1.4 acres, unsounded), which is why nothing has gone
 * wrong yet. But `auId` is the grouping key, so a second such row would be merged into the first and
 * the two ponds would share one integrated depth curve. Same shape as GNIS's `0,0` null island and
 * NHD's `gnis_id = -1`, both of which this campaign has already been bitten by: a sentinel read as a
 * value is silent, and it is silent in the direction of confidently wrong.
 */
const NO_ASSESSMENT_UNIT = /^no\s*au_?id$/i;

/** One ArcGIS feature → a band row, or `undefined` when it carries nothing usable. */
export function parseNhBandFeature(feature: {
  attributes?: Record<string, unknown>;
  centroid?: { x?: unknown; y?: unknown } | null;
}): NhBandRow | undefined {
  const a = feature.attributes ?? {};
  const auId = typeof a.au_id === 'string' ? a.au_id.trim() : '';
  const depthMinFt = num(a.depthmin);
  const depthMaxFt = num(a.depthmax);
  const acres = num(a.acres);
  const lng = num(feature.centroid?.x);
  const lat = num(feature.centroid?.y);
  if (
    auId.length === 0 ||
    NO_ASSESSMENT_UNIT.test(auId) ||
    depthMinFt === undefined ||
    depthMaxFt === undefined ||
    acres === undefined ||
    lat === undefined ||
    lng === undefined
  ) {
    return undefined;
  }
  return {
    auId,
    lakeName: typeof a.lake === 'string' ? a.lake.trim() : '',
    depthMinFt,
    depthMaxFt,
    acres,
    lat,
    lng,
    ...(num(a.bathy_int) !== undefined ? { intervalFt: num(a.bathy_int) } : {}),
  };
}
