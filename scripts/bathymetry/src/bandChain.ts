/**
 * The chain that turns one lake's drawn isobaths into filled depth bands (B03 §2).
 *
 * `blockmedian` → `surface -T1` → (`grdtrack` → seed empty rings → `surface -T1`) → `gdal_contour -p`
 * → drop specks → `ogr2ogr -clipsrc`. Every number and every decision comes from `bands.ts`, where it
 * is tested; this file is subprocess and scratch-file glue, excluded from coverage like `contour.ts`.
 *
 * The input is **the line layer's own output** (`contours.geojsonl`), not the archive: the bands must
 * agree with the lines drawn over them, so they are traced from exactly those lines — same thinning,
 * same clip, same lakes.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { MultiPolygon, Polygon, Position } from 'geojson';
import {
  type BandPlan,
  type BandSpec,
  bandForLowerBound,
  bandGrid,
  bandPlan,
  boundsOf,
  densify,
  dropSpecks,
  frameFor,
  gmtRegion,
  isClosedRing,
  isDegenerateLine,
  isobandLevels,
  outsideProbes,
  pointInRing,
  type Ring,
  ringSeedDirection,
  seedDepth,
  seedLattice,
  toLngLat,
  toXY,
  type XY,
} from './bands';
import { ringsOf } from './shoreline';

const run = promisify(execFile);
const BIG = 1024 * 1024 * 1024;

export interface BandLine {
  depthFt: number;
  coordinates: Position[];
}

export interface BandFeature {
  type: 'Feature';
  properties: {
    bodyId: string;
    bandIndex: number;
    minDepthFt: number;
    maxDepthFt?: number;
    lane: 'surveyed' | 'interpolated';
  };
  geometry: MultiPolygon;
}

export interface TracedBands {
  plan: BandPlan;
  /** One per band that survived the clip, shallowest first. */
  bands: { spec: BandSpec; geometry: MultiPolygon }[];
  degenerateLines: number;
  specksDropped: number;
  seededRings: number;
  /** Empty rings at a boundary level whose surroundings did not say pit or shoal. */
  ambiguousRings: number;
  cellM: number;
  /** Set when the lake produced no bands, with the reason. */
  note?: string;
}

async function gmt(args: string[]): Promise<string> {
  const { stdout } = await run('gmt', args, { maxBuffer: BIG, encoding: 'utf8' });
  return stdout;
}

function xyzText(points: readonly { p: XY; z: number }[]): string {
  return `${points.map(({ p, z }) => `${p.x}\t${p.y}\t${z}`).join('\n')}\n`;
}

async function solve(
  xyz: string,
  grid: ReturnType<typeof bandGrid>,
  dir: string,
  name: string,
): Promise<string> {
  const { region, increment } = gmtRegion(grid);
  const input = join(dir, `${name}.xyz`);
  const blocked = join(dir, `${name}.blk`);
  const out = join(dir, `${name}.nc`);
  writeFileSync(input, xyz);
  writeFileSync(blocked, await gmt(['blockmedian', input, region, increment]));
  // **Tension 1 — a harmonic surface.** It has no maxima or minima away from its data, so it cannot
  // put an isoline anywhere the contours do not straddle that level. The line layer's sounding fit
  // uses 0.25 for the opposite reason: it is fitting a bed, and this is only re-tracing lines.
  await gmt(['surface', blocked, region, increment, '-T1', '-Ll0', `-G${out}`]);
  return out;
}

/** Read a GeoJSON polygon collection back as local-frame rings, with each feature's `amin`. */
function readIsobands(path: string): { amin: number; polygons: Ring[][] }[] {
  const fc = JSON.parse(readFileSync(path, 'utf8')) as GeoJSON.FeatureCollection;
  return fc.features.map((f) => {
    const g = f.geometry;
    const polys =
      g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    return {
      amin: Number(f.properties?.amin),
      // `gdal_contour` writes the grid's own coordinates, which ARE the local frame.
      polygons: polys.map((rings) =>
        rings.map((ring) => ring.map((c) => ({ x: c[0] as number, y: c[1] as number }))),
      ),
    };
  });
}

/**
 * Trace one lake's bands.
 *
 * `lines` are the lake's drawn isobaths (already thinned and clipped by the line build); `polygon` is
 * the water body they were clipped to. Returns the bands clipped to that polygon, or a `note`.
 */
export async function traceBands(
  label: string,
  lines: readonly BandLine[],
  polygon: Polygon | MultiPolygon,
  workRoot: string,
): Promise<TracedBands> {
  const dir = join(workRoot, label);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const shore = ringsOf(polygon);
  const frame = frameFor(shore.flat());
  const shoreXY = shore.map((r) => r.map((p) => toXY(p, frame)));

  let degenerateLines = 0;
  const local: { depthFt: number; line: XY[] }[] = [];
  for (const l of lines) {
    const line = l.coordinates.map((p) => toXY(p, frame));
    if (isDegenerateLine(line)) degenerateLines += 1;
    else local.push({ depthFt: l.depthFt, line });
  }

  const plan = bandPlan(local.map((l) => l.depthFt));
  const empty = (note: string): TracedBands => ({
    plan,
    bands: [],
    degenerateLines,
    specksDropped: 0,
    seededRings: 0,
    ambiguousRings: 0,
    cellM: 0,
    note,
  });
  if (local.length === 0) return empty('no drawable lines');
  if (plan.boundaries.length === 0) {
    return empty('no contour reaches the first band edge (5 ft) — one band would say nothing');
  }

  const grid = bandGrid(boundsOf([...shoreXY.flat(), ...local.flatMap((l) => l.line)]));
  const spacing = grid.cellM / 2;
  const data: { p: XY; z: number }[] = [];
  for (const ring of shoreXY) for (const p of densify(ring, spacing)) data.push({ p, z: 0 });
  for (const l of local) for (const p of densify(l.line, spacing)) data.push({ p, z: l.depthFt });

  let surfacePath = await solve(xyzText(data), grid, dir, 'pass1');

  // **Empty rings at a boundary level.** A harmonic surface is flat inside a ring that holds no other
  // data, so the band edge there would fall wherever rounding put it. Read which way the ring faces
  // from just outside it and seed the inside to match. Rings at a non-boundary level sit wholly inside
  // one band whichever way they face, so they are left alone.
  const boundarySet = new Set(plan.boundaries);
  const others = (exclude: XY[]) => [
    ...shoreXY.flat(),
    ...local.filter((l) => l.line !== exclude).flatMap((l) => l.line),
  ];
  const candidates = local.filter((l) => boundarySet.has(l.depthFt) && isClosedRing(l.line));
  const seeds: { p: XY; z: number }[] = [];
  let seededRings = 0;
  let ambiguousRings = 0;
  const probesByRing: { ring: { depthFt: number; line: XY[] }; probes: XY[] }[] = [];
  for (const ring of candidates) {
    const b = boundsOf(ring.line);
    const inside = others(ring.line).some(
      (p) =>
        p.x > b.xmin && p.x < b.xmax && p.y > b.ymin && p.y < b.ymax && pointInRing(p, ring.line),
    );
    if (inside) continue;
    probesByRing.push({ ring, probes: outsideProbes(ring.line, grid.cellM * 1.5) });
  }
  if (probesByRing.length > 0) {
    const probeFile = join(dir, 'probes.xy');
    writeFileSync(
      probeFile,
      `${probesByRing.flatMap((r) => r.probes.map((p) => `${p.x}\t${p.y}`)).join('\n')}\n`,
    );
    const sampled = (await gmt(['grdtrack', probeFile, `-G${surfacePath}`, '-N']))
      .trim()
      .split('\n')
      .map((row) => Number(row.split(/\s+/)[2]));
    let cursor = 0;
    for (const { ring, probes } of probesByRing) {
      const values = sampled.slice(cursor, cursor + probes.length);
      cursor += probes.length;
      const direction = ringSeedDirection(ring.depthFt, values);
      if (direction === 0) {
        ambiguousRings += 1;
        continue;
      }
      seededRings += 1;
      const z = seedDepth(ring.depthFt, direction);
      for (const p of seedLattice(ring.line, grid.cellM * 2, grid.cellM * 1.5))
        seeds.push({ p, z });
    }
    if (seeds.length > 0) {
      surfacePath = await solve(xyzText([...data, ...seeds]), grid, dir, 'pass2');
    }
  }

  const isobands = join(dir, 'isobands.geojson');
  await run(
    'gdal_contour',
    [
      '-p',
      '-amin',
      'amin',
      '-amax',
      'amax',
      '-fl',
      // Sentinels either side: `-p` traces only the intervals *between* the levels it is given, so
      // without them the shore band and the deepest band would not be traced at all.
      ...isobandLevels(plan).map(String),
      '-f',
      'GeoJSON',
      surfacePath,
      isobands,
    ],
    { maxBuffer: BIG },
  );

  // Group by band (GDAL writes one feature per interval, but nothing promises it), drop specks.
  const byBand = new Map<number, { spec: BandSpec; polygons: Ring[][] }>();
  for (const { amin, polygons } of readIsobands(isobands)) {
    const spec = bandForLowerBound(amin, plan);
    if (!spec) continue;
    const key = spec.minDepthFt;
    const entry = byBand.get(key) ?? { spec, polygons: [] };
    // A loop, not `push(...)`: a big lake's isobands run to more parts than a call has arguments.
    for (const polygon of polygons) entry.polygons.push(polygon);
    byBand.set(key, entry);
  }
  let specksDropped = 0;
  const unclipped: GeoJSON.Feature[] = [];
  for (const { spec, polygons } of byBand.values()) {
    const cleaned = dropSpecks(polygons, grid.cellM * grid.cellM * 2);
    specksDropped += cleaned.dropped;
    if (cleaned.polygons.length === 0) continue;
    unclipped.push({
      type: 'Feature',
      properties: { minDepthFt: spec.minDepthFt },
      geometry: {
        type: 'MultiPolygon',
        coordinates: cleaned.polygons.map((rings) =>
          rings.map((r) => r.map((p) => toLngLat(p, frame))),
        ),
      },
    });
  }

  // Clip to the lake. The surface covers the grid's rectangle; only the water is a band.
  const lakeFile = join(dir, 'lake.geojson');
  const lakeValid = join(dir, 'lake.valid.geojson');
  const unclippedFile = join(dir, 'bands.unclipped.geojson');
  const clippedFile = join(dir, 'bands.clipped.geojson');
  writeFileSync(lakeFile, JSON.stringify({ type: 'Feature', properties: {}, geometry: polygon }));
  await run('ogr2ogr', [
    '-f',
    'GeoJSON',
    '-makevalid',
    '-nlt',
    'MULTIPOLYGON',
    lakeValid,
    lakeFile,
  ]);
  writeFileSync(unclippedFile, JSON.stringify({ type: 'FeatureCollection', features: unclipped }));
  await run(
    'ogr2ogr',
    [
      '-f',
      'GeoJSON',
      '-makevalid',
      '-clipsrc',
      lakeValid,
      '-nlt',
      'MULTIPOLYGON',
      clippedFile,
      unclippedFile,
    ],
    { maxBuffer: BIG },
  );
  const clipped = JSON.parse(readFileSync(clippedFile, 'utf8')) as GeoJSON.FeatureCollection;
  const bands: TracedBands['bands'] = [];
  for (const f of clipped.features) {
    if (f.geometry?.type !== 'MultiPolygon' || f.geometry.coordinates.length === 0) continue;
    const spec = plan.bands.find((b) => b.minDepthFt === Number(f.properties?.minDepthFt));
    if (spec) bands.push({ spec, geometry: f.geometry });
  }
  bands.sort((a, b) => a.spec.minDepthFt - b.spec.minDepthFt);
  return {
    plan,
    bands,
    degenerateLines,
    specksDropped,
    seededRings,
    ambiguousRings,
    cellM: grid.cellM,
    note: bands.length === 0 ? 'the clip left no band' : undefined,
  };
}

/**
 * A lake's finished bands, re-clipped to a **bay** of it — the same rule `clipDrawnToBody` keeps for
 * the lines: a bay's share of its lake's basin is the lake's bands cut down, not bands traced against
 * the bay's own outline, which would force depth 0 across the bay's open mouth.
 */
export async function clipBandsToBody(
  label: string,
  bands: TracedBands['bands'],
  polygon: Polygon | MultiPolygon,
  workRoot: string,
): Promise<TracedBands['bands']> {
  const dir = join(workRoot, label);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const lakeFile = join(dir, 'bay.geojson');
  const lakeValid = join(dir, 'bay.valid.geojson');
  const inFile = join(dir, 'bands.geojson');
  const outFile = join(dir, 'bands.clipped.geojson');
  writeFileSync(lakeFile, JSON.stringify({ type: 'Feature', properties: {}, geometry: polygon }));
  await run('ogr2ogr', [
    '-f',
    'GeoJSON',
    '-makevalid',
    '-nlt',
    'MULTIPOLYGON',
    lakeValid,
    lakeFile,
  ]);
  writeFileSync(
    inFile,
    JSON.stringify({
      type: 'FeatureCollection',
      features: bands.map((b) => ({
        type: 'Feature',
        properties: { minDepthFt: b.spec.minDepthFt },
        geometry: b.geometry,
      })),
    }),
  );
  await run(
    'ogr2ogr',
    ['-f', 'GeoJSON', '-makevalid', '-clipsrc', lakeValid, '-nlt', 'MULTIPOLYGON', outFile, inFile],
    { maxBuffer: BIG },
  );
  const clipped = JSON.parse(readFileSync(outFile, 'utf8')) as GeoJSON.FeatureCollection;
  const out: TracedBands['bands'] = [];
  for (const f of clipped.features) {
    if (f.geometry?.type !== 'MultiPolygon' || f.geometry.coordinates.length === 0) continue;
    const spec = bands.find((b) => b.spec.minDepthFt === Number(f.properties?.minDepthFt))?.spec;
    if (spec) out.push({ spec, geometry: f.geometry });
  }
  return out.sort((a, b) => a.spec.minDepthFt - b.spec.minDepthFt);
}
