/**
 * The chain that turns one lake into contour lines (N6b).
 *
 * `blockmedian` → `surface` → `grdedit` → `grdfilter` → `gdal_contour` → clip, for the sounding lanes;
 * a thinning and a clip for the contour lanes. Extracted from the sample renderer so the **tiler and
 * the sample page run the same code** — a second notion of "how we draw a lake" is exactly what the
 * rest of this package is organised to avoid, and it is the notion where a divergence would be least
 * visible: the samples would keep looking right while the tiles quietly drifted.
 *
 * The whole sounding chain runs in the lake's own frame with the along-axis coordinate compressed for
 * the solve. The compression is undone by `grdedit -R`, which relabels the solved grid's coordinate
 * range without touching a value — so the solver sees a squashed lake, which is what makes a trough
 * connect, and the filter, the mask and the contour tracer all see real distances. Every number handed
 * to GMT comes from `gridPlan`, where it is tested.
 *
 * Subprocess and scratch-file glue; excluded from coverage. The arithmetic it composes is not.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import type { MultiPolygon, Polygon, Position } from 'geojson';
import { SCRATCH_ROOT } from './cache';
import { MAX_SHORE_SHARE, shoreShare } from './density';
import { compressedCloud, gridCellsFor, gridPlan, TENSION } from './grid';
import { BASE_INTERVAL_FT, chooseInterval, thinPublishedLevels } from './interval';
import { type ArchivedLake, maxDepthFt } from './lakes';
import { densifyShoreline, perimeterMeters, shoreSpacingFor } from './shoreline';
import { effectiveAnisotropy, fromLocal, principalFrame, THALWEG_ANISOTROPY } from './thalweg';

const WORK_DIR = join(SCRATCH_ROOT, 'contour');
// Created here rather than by a caller: this module owns its scratch, and when it did not, the
// builder dropped all 621 NH lakes with an ENOENT that read like a chain failure.
mkdirSync(WORK_DIR, { recursive: true });

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** `<source>:<lakeKey>`, the key everything downstream is filed under. */
export function lakeId(lake: ArchivedLake): string {
  return `${lake.sourceKey}:${lake.lakeKey}`;
}

/** Filesystem-safe scratch name for a lake. */
function scratchLabel(lake: ArchivedLake): string {
  return lakeId(lake).replace(/[^\w.-]+/g, '_');
}

/** `--ungated` draws lakes the shore-share gate would refuse, so the gate can be judged by looking. */
let UNGATED = false;
export function setUngated(value: boolean): void {
  UNGATED = value;
}

export interface Drawn {
  lines: Position[][];
  depths: number[];
  interval?: number;
  levels?: number[];
  ratio?: number;
  /** Set when the ladder had to step up, and by which of the two ceilings. */
  coarsenedBy?: 'depth' | 'data support';
  /** Fraction of the solved grid constrained by our own outline rather than the state's readings. */
  shoreShare?: number;
  gridCells?: number;
  clippedAway?: number;
  /** Published levels a contour lane declined to draw, so the thinning is never silent. */
  thinnedAway?: number;
  note?: string;
}

/** Distinct grid cells a point set occupies, at this plan's resolution — what `blockmedian` leaves. */
function occupiedCells(
  cloud: readonly { along: number; across: number }[],
  plan: { increment: string },
): number {
  const inc = Number(plan.increment.slice(2));
  if (!(inc > 0)) return cloud.length;
  const cells = new Set<string>();
  for (const p of cloud) cells.add(`${Math.floor(p.along / inc)},${Math.floor(p.across / inc)}`);
  return cells.size;
}

function gmt(args: string[], label: string): boolean {
  const result = spawnSync('gmt', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    log(`    gmt ${args[0]} failed for ${label}: ${result.stderr?.slice(0, 200)}`);
    return false;
  }
  return true;
}

/** Pull line geometries out of a GeoJSON FeatureCollection, with their `depth` attribute. */
function linesOf(collection: GeoJSON.FeatureCollection): { lines: Position[][]; depths: number[] } {
  const lines: Position[][] = [];
  const depths: number[] = [];
  for (const feature of collection.features) {
    const depth = Number(feature.properties?.depth ?? 0);
    const geometry = feature.geometry;
    const parts =
      geometry.type === 'LineString'
        ? [geometry.coordinates]
        : geometry.type === 'MultiLineString'
          ? geometry.coordinates
          : [];
    for (const part of parts) {
      lines.push(part);
      depths.push(depth);
    }
  }
  return { lines, depths };
}

/** Clip a line collection to our polygon. Returns undefined if the clip failed. */
function clipToPolygon(
  inputPath: string,
  polygon: Polygon | MultiPolygon,
  workDir: string,
  label: string,
): GeoJSON.FeatureCollection | undefined {
  const clipFile = join(workDir, `${label}.clip.geojson`);
  const clipped = join(workDir, `${label}.clipped.geojson`);
  writeFileSync(clipFile, JSON.stringify({ type: 'Feature', geometry: polygon, properties: {} }));
  rmSync(clipped, { force: true });
  const result = spawnSync('ogr2ogr', ['-f', 'GeoJSON', '-clipsrc', clipFile, clipped, inputPath], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || !existsSync(clipped)) {
    log(`    ogr2ogr clip failed for ${label}: ${result.stderr?.slice(0, 200)}`);
    return undefined;
  }
  return JSON.parse(readFileSync(clipped, 'utf8')) as GeoJSON.FeatureCollection;
}

/**
 * Interpolate soundings and contour the result: `blockmedian` → `surface` → `grdedit` → `grdfilter`
 * → `gdal_contour` → clip.
 *
 * The whole chain runs in the lake's own frame with the along-axis coordinate compressed for the
 * solve. The compression is undone by `grdedit -R`, which relabels the solved grid's coordinate range
 * without touching a value — so the solver sees a squashed lake, which is what makes a trough connect,
 * and the filter, the mask and the contour tracer all see real distances. Every number handed to GMT
 * comes from `gridPlan`, where it is tested.
 */
export function interpolate(
  lake: ArchivedLake,
  polygon: Polygon | MultiPolygon | undefined,
  extentM: number,
): Drawn {
  const points = lake.soundings ?? [];
  const label = scratchLabel(lake);
  const maxDepth = maxDepthFt(lake);

  const configured = Number(process.env.THALWEG_RATIO ?? THALWEG_ANISOTROPY);
  const frame = principalFrame(points);
  // Capped by the lake's own elongation: a curved or round basin asks for less on its own.
  const ratio = effectiveAnisotropy(points, frame, configured);

  // Resolution follows the lake's real size, not a constant cell count — 500 cells is 349 m on
  // Champlain and 1.9 m on a farm pond, and only one of those is a resolution the data supports.
  const gridCells = gridCellsFor(extentM);

  // Two passes, because the shoreline budget needs the cell size and the cell size needs a region
  // that contains the shoreline. The first pass sizes the grid from the soundings alone; the second
  // rebuilds it with the shore placed against that budget. Cheap, and it is what stops the outline
  // outvoting the measurements on a sparse lake.
  const soundingsOnly = gridPlan(compressedCloud(points, [], frame, ratio), ratio, { gridCells });
  const cellSizeM = Number(soundingsOnly.increment.slice(2)) * ratio;
  const shore = polygon
    ? densifyShoreline(
        polygon,
        shoreSpacingFor({
          perimeterM: perimeterMeters(polygon),
          soundingCells: occupiedCells(compressedCloud(points, [], frame, ratio), soundingsOnly),
          cellSizeM,
          maskRadiusM: soundingsOnly.maskRadius * ratio,
        }),
      )
    : [];
  const cloud = compressedCloud(points, shore, frame, ratio);
  const plan = gridPlan(cloud, ratio, { gridCells });

  const soundCells = occupiedCells(compressedCloud(points, [], frame, ratio), plan);
  const shoreCells = occupiedCells(compressedCloud([], shore, frame, ratio), plan);
  const share = shoreShare(soundCells, shoreCells);

  // **The second gate.** `MAX_GAP_RATIO` asks how far the nearest measurement is; this asks how much
  // of the fit is measurement at all. Past the threshold the surface is mostly a distance transform
  // from our own outline, which is the thing this phase opens by refusing — so we draw nothing and
  // say why, exactly as the density gate does. `--ungated` renders it anyway, for the same reason the
  // density gate was chosen by looking: a gate you cannot see the far side of cannot be judged.
  if (share > MAX_SHORE_SHARE && !UNGATED) {
    return {
      lines: [],
      depths: [],
      shoreShare: share,
      gridCells,
      note:
        `shore-share gate: ${(share * 100).toFixed(0)}% of this fit would be our own outline ` +
        `(${soundCells} sounding cells against ${shoreCells} shoreline cells)`,
    };
  }

  const xyz = join(WORK_DIR, `${label}.xyz`);
  const blocked = join(WORK_DIR, `${label}.blk`);
  const solvedGrid = join(WORK_DIR, `${label}.nc`);
  const realGrid = join(WORK_DIR, `${label}.real.nc`);
  const smoothed = join(WORK_DIR, `${label}.sm.nc`);
  const contoured = join(WORK_DIR, `${label}.geojson`);

  writeFileSync(xyz, `${cloud.map((c) => `${c.along}\t${c.across}\t${c.depthFt}`).join('\n')}\n`);

  // `blockmedian` writes the decimated cloud to **stdout**, and node's default 1 MB capture kills the
  // process when it overflows — with an empty stderr and a null status, so it presents as "GMT failed
  // for no reason." It cost two of the densest Vermont lakes on the first full run: 68,000 soundings
  // reduce to tens of thousands of cell medians, which is megabytes of text.
  const block = spawnSync('gmt', ['blockmedian', xyz, plan.region, plan.increment], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (block.status !== 0) {
    const why = block.stderr?.trim() || block.error?.message || `exit ${String(block.status)}`;
    return { lines: [], depths: [], note: `blockmedian failed: ${why.slice(0, 160)}` };
  }
  writeFileSync(blocked, block.stdout);

  const solved = gmt(
    [
      'surface',
      blocked,
      plan.region,
      plan.increment,
      `-T${TENSION}`,
      // Clamp to the range actually measured. A continuous-curvature spline WILL overshoot near a
      // steep gradient, and an unclamped overshoot invents a hole deeper than anything the survey
      // found — an artifact indistinguishable, once contoured, from a discovery.
      '-Ll0',
      `-Lu${maxDepth}`,
      `-M${plan.maskRadius}`,
      `-G${solvedGrid}`,
    ],
    label,
  );
  if (!solved) return { lines: [], depths: [], note: 'surface failed' };

  spawnSync('cp', [solvedGrid, realGrid]);
  const relabelled = gmt(['grdedit', realGrid, plan.realRegion], label);
  const grid = relabelled ? realGrid : solvedGrid;

  // Smooth the SURFACE, not the contours. `gdal_contour` traces a raster, so its output follows cell
  // boundaries — at 500 cells across a lake that is a kink every few metres, and reads as pointy
  // corners no lake bed has. Smoothing the lines instead would let neighbours cross, since each would
  // move independently. Deliberately NOT a fix for crowding: it changes the shape of the lines and
  // never their number, because dropping bunched levels would understate depth by omission (D82).
  const filtered = gmt(
    ['grdfilter', grid, `-Fg${plan.filterWidthM}`, '-D0', `-G${smoothed}`],
    label,
  );
  const toContour = filtered ? smoothed : grid;

  // The ladder, and how much of it this lake can carry. `soundCells` rather than the raw reading
  // count: that is what survives `blockmedian`, and it is what a band has to be traced from.
  const { intervalFt, levels, coarsenedBy } = chooseInterval(maxDepth, soundCells);
  if (levels.length === 0) return { lines: [], depths: [], note: 'no contour levels in range' };

  rmSync(contoured, { force: true });
  const contour = spawnSync(
    'gdal_contour',
    ['-a', 'depth', '-fl', ...levels.map(String), '-f', 'GeoJSON', toContour, contoured],
    { encoding: 'utf8' },
  );
  if (contour.status !== 0) {
    return { lines: [], depths: [], note: `gdal_contour failed: ${contour.stderr?.slice(0, 120)}` };
  }

  // Out of the lake frame FIRST — everything downstream is lng/lat. `grdedit` already un-compressed
  // the along axis, so this is a rotation only.
  const raw = JSON.parse(readFileSync(contoured, 'utf8')) as GeoJSON.FeatureCollection;
  for (const feature of raw.features) {
    const geometry = feature.geometry;
    const parts =
      geometry.type === 'LineString'
        ? [geometry.coordinates as number[][]]
        : geometry.type === 'MultiLineString'
          ? (geometry.coordinates as number[][][])
          : [];
    for (const part of parts) {
      for (const c of part) {
        const back = fromLocal({ along: c[0] as number, across: c[1] as number }, frame);
        c[0] = back.lng;
        c[1] = back.lat;
      }
    }
  }
  const wgs84 = join(WORK_DIR, `${label}.wgs84.geojson`);
  writeFileSync(wgs84, JSON.stringify(raw));

  // Then clip to the lake. The `-M` mask already trims to what the survey covered, but a mask is
  // circular around each reading and a lake is not — without this, contours spill over the shoreline
  // wherever a sounding sat near the bank.
  const before = raw.features.length;
  const clipped = polygon ? clipToPolygon(wgs84, polygon, WORK_DIR, label) : undefined;
  const final = clipped ?? raw;
  const { lines, depths } = linesOf(final);
  return {
    lines,
    depths,
    interval: intervalFt,
    levels,
    ratio,
    coarsenedBy,
    shoreShare: share,
    gridCells,
    clippedAway: clipped ? before - clipped.features.length : undefined,
  };
}

/** A contour lane: the agency already drew the isobaths, so this is clip and nothing else. */
export function publishedContours(
  lake: ArchivedLake,
  polygon: Polygon | MultiPolygon | undefined,
): Drawn {
  const label = scratchLabel(lake);

  // The contour lanes' half of the fixed ladder. We choose which SURVEYED levels to show and never
  // move or add one, so a source coarser than the ladder (NH at 10 ft) comes back untouched and a
  // source finer than it (MassGIS's 2/3/4/5 ft shallows) is thinned toward 5 ft. D83's rule was never
  // "don't choose which surveyed lines to show" — it was "don't draw a line where no sounder went."
  const published = (lake.contours ?? []).map((c) => c.depthFt);
  const keep = new Set(thinPublishedLevels(published));
  const dropped = published.length - published.filter((d) => keep.has(d)).length;
  const collection: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: (lake.contours ?? [])
      .filter((contour) => keep.has(contour.depthFt))
      .map((contour) => ({
        type: 'Feature' as const,
        properties: { depth: contour.depthFt },
        geometry: contour.geometry,
      })),
  };
  const laneInfo = {
    interval: BASE_INTERVAL_FT,
    levels: [...keep].sort((a, b) => a - b),
    thinnedAway: dropped > 0 ? dropped : undefined,
  };
  if (!polygon) return { ...linesOf(collection), ...laneInfo };

  const path = join(WORK_DIR, `${label}.published.geojson`);
  writeFileSync(path, JSON.stringify(collection));
  const before = collection.features.length;
  const clipped = clipToPolygon(path, polygon, WORK_DIR, label);
  const final = clipped ?? collection;
  return {
    ...linesOf(final),
    ...laneInfo,
    clippedAway: clipped ? before - clipped.features.length : undefined,
  };
}
