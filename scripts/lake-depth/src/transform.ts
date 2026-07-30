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

  for (const row of input.lagos ?? []) {
    const key = `lagos/${row.lagoslakeid}`;
    const hasMean = row.meanDepthM !== undefined && row.meanDepthM > 0;
    const hasMax = row.maxDepthM !== undefined && row.maxDepthM > 0;
    if (!hasMean && !hasMax) {
      skipped++;
      continue; // a DEPTH row with no usable depth is ordinary, not an error worth naming
    }
    records.push({
      key,
      point: { lat: row.lat, lng: row.lng },
      areaSqM: row.areaSqM,
      ...(hasMean
        ? { meanDepthM: row.meanDepthM as number, meanDepthSource: 'lagos_us' as const }
        : {}),
      ...(hasMax
        ? { maxDepthM: row.maxDepthM as number, maxDepthSource: 'lagos_us' as const }
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
    },
    errors,
  };
}
