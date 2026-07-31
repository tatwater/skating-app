/**
 * Lake-depth transform (N6a) — parse three sources, resolve the D68 ladder per lake, emit one
 * normalized record each. **No matching happens here**: the spatial join runs in Convex, where the N1
 * cell index lives (`waterBodies.matchAndImportDepths`), because resolving ~8k source lakes against an
 * index is cheap and exporting 116,070 polygons to do it locally is not.
 *
 * The one thing this file is careful about beyond parsing is **provenance**. Each source contributes at a
 * known rung, HydroLAKES contributes at one of *two* rungs depending on `Vol_src`, and a value with no
 * rung is dropped rather than stored — a depth whose origin we can't name can't be displayed honestly
 * (D68/D3), so it isn't worth carrying.
 *
 * Column names for the CSV sources are matched **case-insensitively against a candidate list**, because
 * these are third-party files whose exact headers we verify on the first real run rather than guess at
 * from a paper. An unrecognized header is a hard, named error — silently reading zero depths out of a
 * 17,675-row file is the failure this design is avoiding.
 */

import {
  type DepthSource,
  surfaceAreaSqM as geodesicAreaSqM,
  representativePoint,
  SHALLOW_MAX_DEPTH_M,
  SHALLOW_MEAN_DEPTH_M,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import type {
  DepthRecord,
  GlobathyRow,
  HydroLakesFeature,
  LagosDepthRow,
  TransformError,
  TransformSummary,
} from './types';

/** `Lake_area` is km² in HydroLAKES; everything downstream is m². */
const SQ_KM_TO_SQ_M = 1_000_000;

/** Hectares → m², for LAGOS-US, which reports lake area in hectares. */
const HA_TO_SQ_M = 10_000;

// --- CSV ---

/**
 * Split one CSV line, honoring double-quoted fields and doubled quotes inside them. Deliberately small:
 * these files are machine-generated exports with no embedded newlines, and pulling in a CSV library for
 * a manually-run one-off ETL is a dependency to maintain forever for one afternoon's work. If a source
 * ever ships embedded newlines, this will produce a short row and `requireColumn` will say so loudly.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/** Index of the first header matching any candidate, case- and separator-insensitively. */
export function findColumn(header: readonly string[], candidates: readonly string[]): number {
  const norm = (s: string) => s.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  const wanted = candidates.map(norm);
  return header.findIndex((h) => wanted.includes(norm(h)));
}

function requireColumn(
  header: readonly string[],
  candidates: readonly string[],
  file: string,
): number {
  const index = findColumn(header, candidates);
  if (index < 0) {
    throw new Error(
      `${file}: no column matching any of [${candidates.join(', ')}]. Headers present: ` +
        `[${header.join(', ')}]. Third-party exports rename columns between versions — update the ` +
        `candidate list rather than letting the run read zero depths.`,
    );
  }
  return index;
}

/** Parse a numeric cell, treating blanks / `NA` / `NULL` / non-numerics as absent rather than 0. */
export function parseNumber(cell: string | undefined): number | undefined {
  if (cell === undefined) return undefined;
  const trimmed = cell.trim();
  if (trimmed === '' || /^(na|n\/a|null|nan|-9999(\.0*)?)$/i.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

// --- Sources ---

/**
 * GLOBathy's basic-parameters CSV → `Hylak_id` → max depth. GLOBathy publishes several `Dmax` estimates
 * (four geometric shapes plus two empirical methods); we take the **random-forest** column, which is the
 * one the paper validates at 1,503 waterbodies (NSE 0.97) and the one the dataset presents as its
 * headline estimate.
 */
export function parseGlobathy(csv: string): GlobathyRow[] {
  const lines = csv.split('\n').filter((l) => l.trim().length > 0);
  const header = splitCsvLine(lines[0] ?? '');
  const idCol = requireColumn(header, ['Hylak_id', 'hylakid', 'lake_id'], 'GLOBathy');
  const depthCol = requireColumn(
    header,
    ['Dmax_use', 'Dmax_RF', 'Dmax', 'max_depth', 'maxdepth'],
    'GLOBathy',
  );
  const rows: GlobathyRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const hylakId = cells[idCol]?.trim();
    const maxDepthM = parseNumber(cells[depthCol]);
    if (!hylakId || maxDepthM === undefined || maxDepthM <= 0) continue;
    rows.push({ hylakId, maxDepthM });
  }
  return rows;
}

/**
 * LAGOS-US DEPTH's CSV → observed depths with their own coordinates. Both depth columns are optional
 * *per row* by design: the module holds 17,675 maxima and 6,137 means, so most rows are max-only.
 */
export function parseLagosDepth(csv: string): LagosDepthRow[] {
  const lines = csv.split('\n').filter((l) => l.trim().length > 0);
  const header = splitCsvLine(lines[0] ?? '');
  const idCol = requireColumn(header, ['lagoslakeid', 'lagos_lake_id'], 'LAGOS-US DEPTH');
  const latCol = requireColumn(
    header,
    ['lake_lat_decdeg', 'lake_latitude', 'latitude', 'lat'],
    'LAGOS-US DEPTH',
  );
  const lngCol = requireColumn(
    header,
    ['lake_lon_decdeg', 'lake_longitude', 'longitude', 'lon', 'lng'],
    'LAGOS-US DEPTH',
  );
  // Area and both depths are genuinely optional columns — a version that omits them still loads.
  const areaCol = findColumn(header, ['lake_waterarea_ha', 'lake_area_ha', 'lake_totalarea_ha']);
  const maxCol = findColumn(header, [
    'lake_maxdepth_m',
    'lake_maxdepth',
    'maxdepth_m',
    'max_depth_m',
  ]);
  const meanCol = findColumn(header, [
    'lake_meandepth_m',
    'lake_meandepth',
    'meandepth_m',
    'mean_depth_m',
  ]);
  if (maxCol < 0 && meanCol < 0) {
    throw new Error(
      `LAGOS-US DEPTH: found neither a max- nor a mean-depth column. Headers: [${header.join(', ')}].`,
    );
  }

  const rows: LagosDepthRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const lagoslakeid = cells[idCol]?.trim();
    const lat = parseNumber(cells[latCol]);
    const lng = parseNumber(cells[lngCol]);
    if (!lagoslakeid || lat === undefined || lng === undefined) continue;
    const areaHa = areaCol >= 0 ? parseNumber(cells[areaCol]) : undefined;
    rows.push({
      lagoslakeid,
      lat,
      lng,
      areaSqM: areaHa === undefined ? undefined : areaHa * HA_TO_SQ_M,
      maxDepthM: maxCol >= 0 ? parseNumber(cells[maxCol]) : undefined,
      meanDepthM: meanCol >= 0 ? parseNumber(cells[meanCol]) : undefined,
    });
  }
  return rows;
}

/**
 * Which rung a HydroLAKES `Depth_avg` earns. `Vol_src` 1/2 mean the volume it divides was **reported**;
 * 3 means modelled. Anything unexpected is treated as modelled — the conservative reading, since
 * claiming a measurement we can't substantiate is the error that matters here.
 */
export function hydroLakesRung(volSrc: number | undefined): DepthSource {
  return volSrc === 1 || volSrc === 2 ? 'hydrolakes_reported' : 'hydrolakes_modeled';
}

/** A HydroLAKES feature's geometry, or `undefined` if it isn't an area (raw third-party data). */
function areaGeometry(feature: HydroLakesFeature): Polygon | MultiPolygon | undefined {
  const type = feature.geometry?.type;
  if (type === 'Polygon' || type === 'MultiPolygon') {
    return feature.geometry as Polygon | MultiPolygon;
  }
  return undefined;
}

// --- LAGOS-US: many records, one lake ---

/** One lake's worth of LAGOS-US records, after the merge below. */
export interface MergedLagosLake {
  lagoslakeid: string;
  lat: number;
  lng: number;
  areaSqM?: number;
  meanDepthM?: number;
  maxDepthM?: number;
  /** How many source rows fed this lake. `1` for the ordinary case. */
  rowCount: number;
  /** Every usable reading, kept for the contested check and the named error. */
  means: number[];
  maxima: number[];
  /** Readings straddle `SHALLOW_MEAN_DEPTH_M` (or `SHALLOW_MAX_DEPTH_M` with no mean). */
  contested: boolean;
}

/** Median. Even counts take the lower of the two middles — a real reading, never a fabricated one. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/**
 * Collapse LAGOS-US DEPTH rows to one record per `lagoslakeid`.
 *
 * **Why this exists at all:** LAGOS-US DEPTH is *compiled* from ~65 agency, university and
 * monitoring-program sources, so a well-studied lake can plausibly carry several records. Emitting them
 * all worked — they land on the same body at the same rung — but `winsLadder` accepts an equal rank, so
 * the value stored was whichever row the file happened to list last. Arbitrary, and invisible.
 *
 * **The two measurements merge differently, because they mean different things.**
 *  - A **max is an extremum**: two surveys reporting 5 m and 9 m together say the lake reaches ≥ 9 m, so
 *    the deepest reading is the honest one and the shallower is simply a survey that missed the hole.
 *  - A **mean is a basin property** with no combining rule, so take the **median** — robust to one bad
 *    record, and always a number somebody actually reported. Never the average, which would publish a
 *    depth no source measured.
 *
 * **The rejected shortcut:** since D69 makes a false "shallow" the cheap error, one could just take the
 * shallowest reading everywhere and let the safety signal win. But this number is *displayed* to skaters
 * as well as fed to the decay model, and biasing a published depth toward shallow is exactly the D3
 * violation the provenance work exists to prevent. The measurement stays honest; the conservatism lives
 * in the threshold, where `SHALLOW_MAX_DEPTH_M`'s deliberately generous 7 m already puts it.
 *
 * **What is never silently merged is a disagreement that crosses a threshold.** If some records say the
 * lake is shallow and others say it isn't, the merge still picks a number, but the pick has decided a
 * safety classification rather than a display detail — so it is counted and named for review.
 *
 * Location and area come from the first row carrying them: these are per-*lake* attributes in LAGOS-US,
 * so rows of one lake should agree, and the geometric match is gated on area anyway.
 */
export function mergeLagosRows(rows: readonly LagosDepthRow[]): {
  lakes: MergedLagosLake[];
  merged: number;
  contested: number;
} {
  const byId = new Map<string, LagosDepthRow[]>();
  for (const row of rows) {
    const existing = byId.get(row.lagoslakeid);
    if (existing) existing.push(row);
    else byId.set(row.lagoslakeid, [row]);
  }

  const lakes: MergedLagosLake[] = [];
  let merged = 0;
  let contested = 0;
  for (const [lagoslakeid, group] of byId) {
    const usable = (pick: (r: LagosDepthRow) => number | undefined) =>
      group.map(pick).filter((v): v is number => v !== undefined && v > 0 && Number.isFinite(v));
    const means = usable((r) => r.meanDepthM);
    const maxima = usable((r) => r.maxDepthM);

    const meanDepthM = means.length > 0 ? median(means) : undefined;
    const maxDepthM = maxima.length > 0 ? Math.max(...maxima) : undefined;

    // The mean decides shallowness whenever we have one, so it is the reading whose disagreement
    // matters; the max threshold only applies to lakes with no mean at all (`isShallowDepth`).
    const straddles = (values: number[], threshold: number) =>
      values.some((v) => v <= threshold) && values.some((v) => v > threshold);
    const isContested =
      means.length > 0
        ? straddles(means, SHALLOW_MEAN_DEPTH_M)
        : straddles(maxima, SHALLOW_MAX_DEPTH_M);

    if (group.length > 1) merged += group.length - 1;
    if (isContested) contested++;
    const located = group.find((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng)) ?? group[0];
    lakes.push({
      lagoslakeid,
      lat: (located as LagosDepthRow).lat,
      lng: (located as LagosDepthRow).lng,
      areaSqM: group.find((r) => r.areaSqM !== undefined)?.areaSqM,
      meanDepthM,
      maxDepthM,
      rowCount: group.length,
      means,
      maxima,
      contested: isContested,
    });
  }
  return { lakes, merged, contested };
}

// --- The join ---

export interface TransformInput {
  /** HydroLAKES polygons, clipped to our region and converted to GeoJSONSeq. */
  hydroLakes?: readonly HydroLakesFeature[];
  /** GLOBathy `Dmax` rows, joined to HydroLAKES by `Hylak_id`. */
  globathy?: readonly GlobathyRow[];
  /** LAGOS-US DEPTH rows — independent of the other two. */
  lagos?: readonly LagosDepthRow[];
}

export interface TransformResult {
  records: DepthRecord[];
  summary: TransformSummary;
  errors: TransformError[];
}

/**
 * Normalize every source into `DepthRecord`s.
 *
 * **HydroLAKES and GLOBathy fold into one record per lake** (GLOBathy has no geometry of its own — it is
 * an attribute table keyed on `Hylak_id` — so a Dmax with no HydroLAKES polygon has nowhere to be
 * matched and is dropped with a named error). **LAGOS-US stays a separate record** even for the same
 * physical lake: it carries its own coordinates, and the server-side ladder is what reconciles two
 * records that land on the same body. Doing that reconciliation here would mean re-implementing the
 * ladder in a second place, which is precisely what `applyDepthLadder` exists to prevent.
 */
export function transformDepths(input: TransformInput): TransformResult {
  const records: DepthRecord[] = [];
  const errors: TransformError[] = [];
  let skipped = 0;

  const globathyByHylakId = new Map<string, number>();
  for (const row of input.globathy ?? []) globathyByHylakId.set(row.hylakId, row.maxDepthM);
  const matchedHylakIds = new Set<string>();

  for (const feature of input.hydroLakes ?? []) {
    const hylakId = feature.properties?.Hylak_id;
    const key = `hylak/${hylakId ?? '?'}`;
    const geometry = areaGeometry(feature);
    if (hylakId === undefined || hylakId === null || !geometry) {
      skipped++;
      errors.push({
        key,
        message: !geometry ? 'not a Polygon/MultiPolygon' : 'no Hylak_id',
      });
      continue;
    }
    const id = String(hylakId);
    matchedHylakIds.add(id);

    const meanDepthM = parseNumber(String(feature.properties?.Depth_avg ?? ''));
    const volSrc = parseNumber(String(feature.properties?.Vol_src ?? ''));
    const maxDepthM = globathyByHylakId.get(id);
    if (meanDepthM === undefined && maxDepthM === undefined) {
      skipped++;
      errors.push({ key, message: 'no depth from either HydroLAKES or GLOBathy' });
      continue;
    }

    // Prefer the source's own reported area over our geodesic recomputation of its polygon: it is what
    // the depth was derived from, so it is the number the area gate should compare against.
    const reportedAreaKm2 = parseNumber(String(feature.properties?.Lake_area ?? ''));
    const areaSqM =
      reportedAreaKm2 !== undefined ? reportedAreaKm2 * SQ_KM_TO_SQ_M : geodesicAreaSqM(geometry);

    records.push({
      key,
      point: representativePoint(geometry),
      areaSqM,
      ...(meanDepthM !== undefined && meanDepthM > 0
        ? { meanDepthM, meanDepthSource: hydroLakesRung(volSrc) }
        : {}),
      ...(maxDepthM !== undefined && maxDepthM > 0
        ? { maxDepthM, maxDepthSource: 'globathy' as const }
        : {}),
    });
  }

  // A Dmax whose lake isn't in our clipped HydroLAKES extract has no geometry and no way to be matched.
  // Counted rather than ignored: a large number here means the clip and the CSV disagree about region.
  for (const id of globathyByHylakId.keys()) {
    if (matchedHylakIds.has(id)) continue;
    skipped++;
    errors.push({
      key: `globathy/${id}`,
      message: 'no HydroLAKES polygon for this Hylak_id (outside the clipped extract?)',
    });
  }

  const lagos = mergeLagosRows(input.lagos ?? []);
  for (const merged of lagos.lakes) {
    const key = `lagos/${merged.lagoslakeid}`;
    if (merged.meanDepthM === undefined && merged.maxDepthM === undefined) {
      skipped++;
      continue; // a DEPTH row with no usable depth is ordinary, not an error worth naming
    }
    if (merged.contested) {
      errors.push({
        key,
        message: `${merged.rowCount} records disagree across a shallow threshold (means ${fmt(merged.means)}, maxima ${fmt(merged.maxima)}) — merged, but the shallow classification is a judgement call here`,
      });
    }
    records.push({
      key,
      point: { lat: merged.lat, lng: merged.lng },
      areaSqM: merged.areaSqM,
      ...(merged.meanDepthM !== undefined
        ? { meanDepthM: merged.meanDepthM, meanDepthSource: 'lagos_us' as const }
        : {}),
      ...(merged.maxDepthM !== undefined
        ? { maxDepthM: merged.maxDepthM, maxDepthSource: 'lagos_us' as const }
        : {}),
    });
  }

  return {
    records,
    summary: {
      hydroLakesRead: input.hydroLakes?.length ?? 0,
      globathyRead: input.globathy?.length ?? 0,
      lagosRead: input.lagos?.length ?? 0,
      emitted: records.length,
      skipped,
      lagosMerged: lagos.merged,
      lagosContested: lagos.contested,
    },
    errors,
  };
}

const fmt = (values: number[]) => `[${values.map((v) => v.toFixed(1)).join(', ')}]`;
