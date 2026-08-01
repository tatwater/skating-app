/**
 * Per-source feature normalization (N6b) — five agencies' schemas → two common shapes.
 *
 * This is where the phase's real complexity lives. The five datasets agree on nothing: not the depth
 * column's name, not its sign, not its unit, not whether a lake has an id, not whether the shoreline is
 * a row. Downstream — the density gate, the interpolation, the tiler, the depth ladder — should see one
 * shape, and every per-agency oddity should be *here*, named, with the evidence that motivated it.
 *
 * The rule the whole module follows: **normalize representation, never magnitude.** Sign conventions,
 * column names and float round-trip noise are serialization accidents and get fixed. A depth value
 * itself is never adjusted toward what we expect — the one place that would be tempting (Maine's
 * 0.58%-shallow feet) is handled by reading the column that *isn't* corrupted, not by scaling the one
 * that is.
 */

import type { Feature, Geometry, LineString, MultiLineString } from 'geojson';

import { SHORELINE_DEPTH } from './sources';

/** Feet per metre. The real one — see `ME_FEET_PER_METRE` for the one Maine used. */
const FEET_PER_METRE = 3.28084;

/**
 * Maine converted feet to metres with **two different constants**, and which one a row used has to be
 * decided per row.
 *
 * Some rows were built with a sloppy **3.3** ft/m: `DEPTHM 3.0303 × 3.3 = 10.0` exactly, where the
 * true constant gives 9.94. Most were built with the correct **3.28084**. Across a 40,000-row sample:
 *
 * | rows landing on a whole foot under… | count |
 * | --- | --- |
 * | 3.28084 only | 31,375 |
 * | either (small depths, difference under tolerance) | 4,482 |
 * | 3.3 only | 2,086 |
 * | neither (genuine fractional readings) | 1,659 |
 *
 * **This corrected an earlier version of this module that applied 3.3 to every `depthmap` row.** That
 * came from a 400-row sample taken off the first archived page, which happened to sit in the 2,086
 * minority — a reminder that a page of an ordered export is not a sample of the export. Applying 3.3
 * blanket-fashion inflated ~94% of Maine's depths by 0.58%.
 *
 * So the constant is chosen by evidence rather than assumed: whichever one lands the value on a whole
 * foot wins, and the value is snapped to it, recovering the surveyor's original reading exactly. When
 * neither does, the row is a genuine fractional measurement and gets the physically correct constant.
 * When both do, the correct one wins — they only agree where the depth is small enough that the 0.58%
 * difference is below the tolerance anyway.
 */
const ME_SLOPPY_FEET_PER_METRE = 3.3;

/**
 * How close to a whole foot counts as "this was originally a whole foot".
 *
 * 0.02 ft is about 6 mm — far tighter than any depth sounder resolves, so it cannot accidentally
 * capture a genuine fractional reading, and far looser than the float noise a metre round-trip
 * introduces.
 */
const WHOLE_FOOT_TOLERANCE = 0.02;

/**
 * Recover a Maine depth in feet.
 *
 * The GPS lanes (`gpscarrier`, `gpsrec`) are depth-sounder tracks — genuine metre readings — and are
 * converted normally. Only the digitised map lane is ambiguous, because only it was converted *from*
 * feet in the first place.
 */
function maineDepthFt(metres: number, method: string): number {
  if (method !== 'depthmap') return metres * FEET_PER_METRE;
  const correct = metres * FEET_PER_METRE;
  const sloppy = metres * ME_SLOPPY_FEET_PER_METRE;
  if (Math.abs(correct - Math.round(correct)) < WHOLE_FOOT_TOLERANCE) return Math.round(correct);
  if (Math.abs(sloppy - Math.round(sloppy)) < WHOLE_FOOT_TOLERANCE) return Math.round(sloppy);
  return correct;
}

/**
 * How much rounding recovers a round-tripped value.
 *
 * NH's `depth` has been through metres and back with mismatched constants, so it holds `2.00000006`
 * where the survey said `2`. The error is ~3e-8 relative, which means rounding to a hundredth of a
 * foot recovers the original exactly while leaving any genuine sub-foot precision (Maine's GPS rows
 * carry real fractional depths) untouched. Rounding to whole feet would destroy that.
 */
function cleanDepth(feet: number): number {
  return Math.round(feet * 100) / 100;
}

/** A contour line, normalized. One per source feature that survives the filters. */
export interface NormalizedContour {
  /** Depth below surface, **positive**, in feet. */
  depthFt: number;
  /** Stable per-lake key within this source — an agency lake id where one exists. */
  lakeKey: string;
  /** Best available lake name, for the join and for logs. Empty when the source carries none. */
  lakeName: string;
  geometry: LineString | MultiLineString;
}

/** A measured sounding, normalized. */
export interface NormalizedSounding {
  lng: number;
  lat: number;
  /** Depth below surface, **positive**, in feet. */
  depthFt: number;
  lakeKey: string;
  lakeName: string;
  /**
   * Sub-source provenance, where one source mixes collection methods. Maine's single layer holds both
   * digitised IF&W map soundings and DEP GPS depth-sounder tracks; nothing else sets this.
   */
  method?: string;
}

export interface NormalizeResult<T> {
  records: T[];
  /** Named, counted reasons a feature was dropped. Never a silent filter. */
  skipped: Record<string, number>;
}

function skip(skipped: Record<string, number>, reason: string): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
}

/** Read a numeric property, tolerating the string-typed numbers some services emit. */
function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isLineGeometry(
  geometry: Geometry | null | undefined,
): geometry is LineString | MultiLineString {
  return geometry?.type === 'LineString' || geometry?.type === 'MultiLineString';
}

/**
 * NH GRANIT contour lines.
 *
 * **`meters` is not a depth.** The field list reads `depth`, `meters`, `length`, `shape_leng`, and it
 * is very natural to pair the first two — but `length: 8238.96` / `meters: 2511.24` is exactly
 * 8238.96 ÷ 3.28084, so `meters` is the *line's length*, and `depth` (feet) is the only depth in the
 * row. This doc's own source table and this ETL's first registry note both got that wrong; it is
 * recorded here because reading it off the schema gives the wrong answer and only arithmetic on real
 * values gives the right one.
 *
 * `au_id` is NHDES's assessment-unit id and is the per-lake key; `lake` is the display name.
 */
export function normalizeNhContours(
  features: readonly Feature[],
): NormalizeResult<NormalizedContour> {
  const records: NormalizedContour[] = [];
  const skipped: Record<string, number> = {};

  for (const feature of features) {
    const p = feature.properties ?? {};
    const depth = num(p.depth);
    if (depth === undefined) {
      skip(skipped, 'no depth value');
      continue;
    }
    if (depth <= SHORELINE_DEPTH) {
      // A 0 ft contour is the shoreline, which the water-body polygon already draws.
      skip(skipped, 'shoreline (depth <= 0)');
      continue;
    }
    if (!isLineGeometry(feature.geometry)) {
      skip(skipped, `unexpected geometry (${feature.geometry?.type ?? 'none'})`);
      continue;
    }
    const lakeKey = str(p.au_id) || str(p.lake);
    if (!lakeKey) {
      skip(skipped, 'no lake identifier');
      continue;
    }
    records.push({
      depthFt: cleanDepth(depth),
      lakeKey,
      lakeName: str(p.lake),
      geometry: feature.geometry,
    });
  }
  return { records, skipped };
}

/**
 * MassGIS / MassWildlife contour lines.
 *
 * `SHORE = 1` marks the shoreline explicitly, at `DEPTH = 0`. Both tests are applied rather than one,
 * because a source that flags a thing two ways will eventually flag it only one way.
 *
 * `PALIS_ID` is the state's lake id and is a float in the payload (`31044.0`), so it is keyed as an
 * integer string — a `String(31044)` and a `String(31044.0)` must not become two different lakes.
 */
export function normalizeMaContours(
  features: readonly Feature[],
): NormalizeResult<NormalizedContour> {
  const records: NormalizedContour[] = [];
  const skipped: Record<string, number> = {};

  for (const feature of features) {
    const p = feature.properties ?? {};
    if (num(p.SHORE) === 1) {
      skip(skipped, 'shoreline (SHORE = 1)');
      continue;
    }
    const depth = num(p.DEPTH);
    if (depth === undefined) {
      skip(skipped, 'no depth value');
      continue;
    }
    if (depth <= SHORELINE_DEPTH) {
      skip(skipped, 'shoreline (depth <= 0)');
      continue;
    }
    if (!isLineGeometry(feature.geometry)) {
      skip(skipped, `unexpected geometry (${feature.geometry?.type ?? 'none'})`);
      continue;
    }
    const palis = num(p.PALIS_ID);
    const lakeKey = palis !== undefined ? String(Math.round(palis)) : str(p.NAME);
    if (!lakeKey) {
      skip(skipped, 'no lake identifier');
      continue;
    }
    records.push({
      depthFt: cleanDepth(depth),
      lakeKey,
      lakeName: str(p.NAME),
      geometry: feature.geometry,
    });
  }
  return { records, skipped };
}

/** Pull a Point's coordinates, rejecting anything else. */
function pointCoords(geometry: Geometry | null | undefined): [number, number] | undefined {
  if (geometry?.type !== 'Point') return undefined;
  const [lng, lat] = geometry.coordinates;
  if (typeof lng !== 'number' || typeof lat !== 'number') return undefined;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return undefined;
  return [lng, lat];
}

/**
 * VCGI / NOAA Lake Champlain soundings.
 *
 * `DEPTH_FT` is **negative** (a depth below a surface, signed as an elevation), so it is flipped to a
 * positive depth-below-surface like every other source. One lake, so the key is a constant — and that
 * constant covers the entire New York shore, which is our only NY coverage.
 */
export const CHAMPLAIN_LAKE_KEY = 'champlain';

export function normalizeChamplainSoundings(
  features: readonly Feature[],
): NormalizeResult<NormalizedSounding> {
  const records: NormalizedSounding[] = [];
  const skipped: Record<string, number> = {};

  for (const feature of features) {
    const coords = pointCoords(feature.geometry);
    if (!coords) {
      skip(skipped, 'not a point');
      continue;
    }
    const raw = num(feature.properties?.DEPTH_FT);
    if (raw === undefined) {
      skip(skipped, 'no depth value');
      continue;
    }
    const depthFt = -raw;
    if (depthFt <= SHORELINE_DEPTH) {
      // The 2010 shoreline replacement put a ring of 0 ft points around the lake. They describe the
      // outline we already draw, and as interpolation input they are the depth-0 boundary constraint
      // rather than a sounding — so they are dropped here and re-added deliberately by the gridder.
      skip(skipped, 'shoreline or above surface (depth <= 0)');
      continue;
    }
    records.push({
      lng: coords[0],
      lat: coords[1],
      depthFt: cleanDepth(depthFt),
      lakeKey: CHAMPLAIN_LAKE_KEY,
      lakeName: 'Lake Champlain',
    });
  }
  return { records, skipped };
}

/**
 * Maine DEP *Depth Points*.
 *
 * Two datasets in one schema, told apart by `FMSRC`: `depthmap` rows are digitised IF&W lake-survey
 * maps (the ones the plan believed were still PDFs), `gpscarrier`/`gpsrec` rows are DEP depth-sounder
 * tracks. The distinction is carried through as `method` because it is a provenance difference, not a
 * formatting one.
 *
 * Depth comes from `DEPTHM` with the constant that undoes Maine's own conversion error — see
 * `ME_FEET_PER_METRE`. `DEPTHF` is never read: it is the corrupted column.
 *
 * `MIDAS` is Maine's lake id, so the per-lake split needs no spatial work at all.
 */
export function normalizeMeSoundings(
  features: readonly Feature[],
): NormalizeResult<NormalizedSounding> {
  const records: NormalizedSounding[] = [];
  const skipped: Record<string, number> = {};

  for (const feature of features) {
    const p = feature.properties ?? {};
    const coords = pointCoords(feature.geometry);
    if (!coords) {
      skip(skipped, 'not a point');
      continue;
    }
    const metres = num(p.DEPTHM);
    if (metres === undefined) {
      skip(skipped, 'no depth value');
      continue;
    }
    const midas = num(p.MIDAS);
    if (midas === undefined || midas <= 0) {
      // Without a MIDAS there is no lake to attach the sounding to, and guessing one spatially would
      // be inventing an association the state didn't make.
      skip(skipped, 'no MIDAS lake id');
      continue;
    }
    const method = str(p.FMSRC).toLowerCase();
    const depthFt = cleanDepth(maineDepthFt(metres, method));
    if (depthFt <= SHORELINE_DEPTH) {
      skip(skipped, 'shoreline or above surface (depth <= 0)');
      continue;
    }
    records.push({
      lng: coords[0],
      lat: coords[1],
      depthFt,
      lakeKey: String(Math.round(midas)),
      lakeName: '',
      method: method || undefined,
    });
  }
  return { records, skipped };
}

/**
 * VT ANR BioBase soundings — a CSV, not GeoJSON, and the only source that isn't an ArcGIS layer.
 *
 * `Longitude,Latitude,DepthInFeet,LakeName`, 2.4 million rows, depths **negative**. Parsed as a plain
 * split rather than with a CSV library: the file has four columns, no quoting and no embedded commas
 * across all 2,442,512 rows, and pulling a dependency in for that would be the larger risk.
 *
 * Streaming line-by-line rather than taking a string: the expanded CSV is 134 MB and building a
 * 2.4M-element array of split results alongside it is how this becomes an out-of-memory bug on a
 * laptop that has other things open.
 */
export function normalizeVtSoundingLine(
  line: string,
  columns: { lng: number; lat: number; depth: number; name: number },
): NormalizedSounding | { skipReason: string } {
  const parts = line.split(',');
  const lng = num(parts[columns.lng]);
  const lat = num(parts[columns.lat]);
  if (lng === undefined || lat === undefined) return { skipReason: 'unparseable coordinate' };
  const raw = num(parts[columns.depth]);
  if (raw === undefined) return { skipReason: 'no depth value' };
  const depthFt = -raw;
  if (depthFt <= SHORELINE_DEPTH) return { skipReason: 'shoreline or above surface (depth <= 0)' };
  const name = str(parts[columns.name]);
  if (!name) return { skipReason: 'no lake name' };
  return {
    lng,
    lat,
    depthFt: cleanDepth(depthFt),
    lakeKey: name.toUpperCase(),
    lakeName: name,
  };
}

/**
 * Locate the four columns in the BioBase header rather than assuming their order.
 *
 * The file is republished (its `last-modified` moved to 2026-06-01 under a 2020 filename), and a
 * column reorder is exactly the kind of change that keeps parsing and silently swaps latitude for
 * depth. Throws with the headers it actually found — the same discipline N6a's transform uses.
 */
export function vtSoundingColumns(headerLine: string): {
  lng: number;
  lat: number;
  depth: number;
  name: number;
} {
  const headers = headerLine.split(',').map((h) => h.trim().toLowerCase());
  const find = (...candidates: string[]): number => {
    const index = headers.findIndex((h) => candidates.includes(h));
    if (index < 0) {
      throw new Error(
        `VT BioBase CSV: no column matching ${candidates.join('/')}. Found: ${headers.join(', ')}`,
      );
    }
    return index;
  };
  return {
    lng: find('longitude', 'lon', 'lng', 'x'),
    lat: find('latitude', 'lat', 'y'),
    depth: find('depthinfeet', 'depth_ft', 'depth'),
    name: find('lakename', 'lake_name', 'lake'),
  };
}

/** Group normalized records by their per-lake key. */
export function groupByLake<T extends { lakeKey: string }>(
  records: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const existing = groups.get(record.lakeKey);
    if (existing) existing.push(record);
    else groups.set(record.lakeKey, [record]);
  }
  return groups;
}

/**
 * The distinct depths present for one lake, cleaned and sorted — the input to any interval label.
 *
 * Exists because **contour interval is a per-lake property, not a per-state one**, which is the
 * correction that made D83's example label (*"NH GRANIT, 10 ft contours"*) unwritable. NH's set spans
 * 1–180 ft and MassGIS mixes 2/3/4/5 ft in the shallows with 5 ft steps below, so any honest label has
 * to be derived from the values a given lake actually carries.
 */
export function depthsForLake(records: readonly { depthFt: number }[]): number[] {
  return [...new Set(records.map((r) => r.depthFt))].sort((a, b) => a - b);
}

/**
 * The interval of a lake's contour set, or `undefined` when it doesn't have one.
 *
 * Returns a number only when the spacing is genuinely uniform, because "10 ft contours" is a claim
 * about the whole set and a set that steps 2, 3, 4, 5, 10 has no such property. Under D82 the layer
 * makes no claim anyway, so declining to state an interval costs the skater nothing — where stating a
 * wrong one would be the first interpretive thing this feature said.
 */
export function contourInterval(depths: readonly number[]): number | undefined {
  if (depths.length < 2) return undefined;
  const first = depths[0];
  const second = depths[1];
  if (first === undefined || second === undefined) return undefined;
  const step = cleanDepth(second - first);
  if (step <= 0) return undefined;
  for (let i = 2; i < depths.length; i += 1) {
    const previous = depths[i - 1];
    const current = depths[i];
    if (previous === undefined || current === undefined) return undefined;
    if (cleanDepth(current - previous) !== step) return undefined;
  }
  return step;
}
