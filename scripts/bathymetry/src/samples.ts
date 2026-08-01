/**
 * Render sample lakes at several density thresholds, so the gate is chosen by looking (N6b).
 *
 *   pnpm --filter @skating/bathymetry samples [--out=.scratch/samples.html]
 *
 * The founder's call on the density gate was *"show me both, then decide"*, and this is the showing.
 * It picks real Maine lakes spanning the range of coverage the sweep found, interpolates each one
 * exactly as the production lane will, and writes an HTML page of side-by-side SVGs: the soundings we
 * actually have, and the contours those soundings produce.
 *
 * The reason this is worth building rather than arguing from the sweep table: the table says *how
 * many* lakes each threshold keeps, and the only question that matters is **what the kept ones look
 * like**. A gate is a claim about when interpolation is honest, and that claim is visual.
 *
 * I/O and rendering glue over the tested `density`, `interval` and `normalize` modules.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import type { MultiPolygon, Polygon } from 'geojson';
import { listRawPages, readRawPage, SCRATCH_ROOT } from './cache';
import { assessDensity, type DensityAssessment, MAX_GAP_RATIO } from './density';
import { chooseInterval, contourLevels } from './interval';
import { groupByLake, type NormalizedSounding, normalizeMeSoundings } from './normalize';
import { densifyShoreline, ringsOf } from './shoreline';
import {
  compressAlong,
  expandAlong,
  fromLocal,
  principalFrame,
  THALWEG_ANISOTROPY,
  toLocal,
} from './thalweg';

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/**
 * The three gridding algorithms tried, and how each one fails. `{r}` is substituted with a search
 * radius scaled to the lake.
 *
 * **None of them is production-quality**, which is the finding this tool produced and the reason it
 * is worth keeping rather than deleting once the gate is chosen. Each fails differently and each
 * failure is visible at a glance, which is exactly why the samples had to be rendered rather than
 * reasoned about:
 *
 * - **`idw`** — an *exact* interpolator: it passes through every sounding, so each one becomes a local
 *   extremum ringed by tiny closed contours. Bullseyes everywhere. It also has no edge, so contours
 *   run out across dry land to the corners of the raster.
 * - **`linear`** — Delaunay TIN. Kills the bullseyes and gives a free, correct mask (a TIN is only
 *   defined inside the convex hull). But it renders the triangulation itself: angular facets, and
 *   long sliver triangles spanning the hull wherever soundings sit on near-parallel transects.
 * - **`average`** — a moving window, and the only *smoothing* option GDAL offers. No bullseyes, but
 *   it draws its own search radius: overlapping circular arcs around every cluster of readings.
 *
 * The pattern is that GDAL's gridders are built for scattered data and ours is **transect** data,
 * whose anisotropy defeats all three. The real fix is a proper interpolator — natural-neighbour, or a
 * tensioned spline (GMT's `surface`), or TIN followed by a smoothing pass — which is a focused piece
 * of cartographic work rather than a flag on this command.
 */
/**
 * Grid cells across the lake's long axis. 500 keeps a contour smooth at drawer zoom without making
 * `surface` iterate for minutes on Champlain.
 */
const GRID_CELLS = 500;

/**
 * Spline tension, 0 (minimum curvature) to 1 (harmonic).
 *
 * GMT's own guidance for bathymetry and steep topography is ~0.25: unconstrained minimum-curvature
 * splines oscillate around sharp gradients, which on a lake bed means ringing around a drop-off —
 * the same class of invented structure as IDW's bullseyes, arriving from the opposite direction.
 */
const TENSION = 0.25;

/**
 * Gaussian filter width, in grid cells, applied to the surface before contouring.
 *
 * Three is chosen to sit firmly between the two scales that matter: wider than the raster tracing
 * artifact it exists to remove, and far narrower than the sounding spacing, so it cannot smooth away
 * a feature the survey actually resolved. A filter approaching the data spacing would be inventing a
 * smoother lake than was measured.
 */
const SMOOTH_CELLS = 3;

export const ALGORITHMS: Record<string, string> = {
  gmt: 'gmt-surface',
  idw: 'invdistnn:radius={r}:max_points=12:min_points=1:power=2.0',
  linear: 'linear:radius=-1:nodata=-9999',
  average: 'average:radius={r}:min_points=1:nodata=-9999',
};

/**
 * Interpolate soundings to a grid and contour it, via GDAL.
 *
 * **`linear` — Delaunay triangulation with linear interpolation inside each triangle.** §Maine called
 * this exactly right ("natural-neighbour or TIN-based interpolation over kriging: fewer knobs, no
 * variogram to defend"), and the first attempt here ignored it in favour of inverse-distance
 * weighting. Rendering the result is what settled it, and IDW lost on two counts at once:
 *
 * 1. **Bullseyes.** IDW is an exact interpolator — it passes precisely through every data point, so
 *    each sounding becomes a local extremum with a ring of tiny closed contours around it. The sample
 *    strip was covered in them. They are the fit's arithmetic, not the basin, and drawing them is a
 *    smaller version of the mistake this whole document opens by refusing.
 * 2. **It has no edge.** IDW returns a value for every cell in the raster, so contours ran out across
 *    dry land to the corners of the bounding box. A TIN is only defined inside the convex hull of the
 *    data, so everything outside comes back as nodata — the mask falls out of the method for free,
 *    and it is the *right* mask: exactly the area the survey actually covered.
 *
 * The remaining clip — to our own water-body polygon — still has to happen in the production lane,
 * because a hull spans a concave bay the survey went around. But the hull edge is what keeps the
 * samples honest, and it is what the density gate is measuring against anyway.
 */
function interpolateAndContour(
  lakeKey: string,
  points: readonly NormalizedSounding[],
  workDir: string,
  algorithm: string,
  polygon: Polygon | MultiPolygon | undefined,
):
  | { levels: number[]; interval: number; maxDepthFt: number; contours: GeoJSON.FeatureCollection }
  | undefined {
  const xyz = join(workDir, `${lakeKey}.xyz`);
  const blocked = join(workDir, `${lakeKey}.blk`);
  const nc = join(workDir, `${lakeKey}.nc`);
  const out = join(workDir, `${lakeKey}.geojson`);

  let maxDepth = 0;
  for (const p of points) if (p.depthFt > maxDepth) maxDepth = p.depthFt;

  // Work in the lake's OWN frame: rotate to its principal axis, then compress along-axis distance so
  // a trough competes fairly with the across-axis pull toward shore. See `thalweg.ts` for why this
  // is a smoothness prior rather than a data claim — `surface` still fits through every measurement,
  // so a real sill between two troughs survives.
  const ratio = Number(process.env.THALWEG_RATIO ?? THALWEG_ANISOTROPY);
  const frame = principalFrame(points);

  const spanMaxDeg = (() => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    let loLat = Number.POSITIVE_INFINITY;
    let hiLat = Number.NEGATIVE_INFINITY;
    for (const p of points) {
      if (p.lng < lo) lo = p.lng;
      if (p.lng > hi) hi = p.lng;
      if (p.lat < loLat) loLat = p.lat;
      if (p.lat > hiLat) hiLat = p.lat;
    }
    return Math.max(hi - lo, hiLat - loLat);
  })();

  const shore = polygon
    ? densifyShoreline(polygon, Math.max(5, (spanMaxDeg / GRID_CELLS) * 111_320))
    : [];

  const local = [
    ...points.map((p) => ({ ...compressAlong(toLocal(p, frame), ratio), depthFt: p.depthFt })),
    ...shore.map((p) => ({ ...compressAlong(toLocal(p, frame), ratio), depthFt: 0 })),
  ];

  let minA = Number.POSITIVE_INFINITY;
  let maxA = Number.NEGATIVE_INFINITY;
  let minC = Number.POSITIVE_INFINITY;
  let maxC = Number.NEGATIVE_INFINITY;
  for (const l of local) {
    if (l.along < minA) minA = l.along;
    if (l.along > maxA) maxA = l.along;
    if (l.across < minC) minC = l.across;
    if (l.across > maxC) maxC = l.across;
  }
  writeFileSync(xyz, `${local.map((l) => `${l.along}\t${l.across}\t${l.depthFt}`).join('\n')}\n`);

  // Metres now, not degrees — and the cell is square in the COMPRESSED frame, which is what makes the
  // anisotropy actually reach the solver rather than being undone by the grid spacing.
  const padM = Math.max(maxA - minA, maxC - minC) * 0.02;
  const region = `-R${minA - padM}/${maxA + padM}/${minC - padM}/${maxC + padM}`;
  const increment = `-I${Math.max(maxA - minA, maxC - minC) / GRID_CELLS}`;
  const maskRadius = Math.max(maxA - minA, maxC - minC) * MAX_GAP_RATIO;
  const spanLng = maxA - minA;
  const spanLat = maxC - minC;

  const block = spawnSync('gmt', ['blockmedian', xyz, region, increment], { encoding: 'utf8' });
  if (block.status !== 0) {
    process.stderr.write(
      `  gmt blockmedian failed for ${lakeKey}: ${block.stderr?.slice(0, 300)}\n`,
    );
    return undefined;
  }
  writeFileSync(blocked, block.stdout);

  const surface = spawnSync(
    'gmt',
    [
      'surface',
      blocked,
      region,
      increment,
      `-T${TENSION}`,
      // Clamp the solution to the range actually measured. A continuous-curvature spline WILL
      // overshoot near a steep gradient, and an unclamped overshoot invents a hole deeper than
      // anything the survey found — an artifact indistinguishable, once contoured, from a discovery.
      // `-Ll0` likewise stops the fit rising above the water surface near shore.
      '-Ll0',
      `-Lu${maxDepth}`,
      `-M${maskRadius}`,
      `-G${nc}`,
    ],
    { encoding: 'utf8' },
  );
  if (surface.status !== 0) {
    process.stderr.write(`  gmt surface failed for ${lakeKey}: ${surface.stderr?.slice(0, 300)}\n`);
    return undefined;
  }

  // **Smooth the surface before contouring, not the contours after.**
  //
  // `gdal_contour` traces a raster, so its output follows cell boundaries: at 500 cells across a lake
  // that puts a kink every few metres, and the result reads as sharp pointy corners that no lake bed
  // has. Smoothing the *grid* fixes the cause; smoothing the *lines* afterwards would fix the symptom
  // and would let neighbouring contours cross each other, since each line would move independently.
  //
  // Deliberately NOT a fix for crowding. Dropping contour levels where lines bunch would make a deep
  // lake with a steep bed show fewer rings than a shallow one with a gentle bed — understating depth
  // by omission, which is the kind of misleading-by-rendering D82 exists to prevent (founder call,
  // 2026-08-01). Smoothing changes the shape of the lines and never their number.
  //
  // A Gaussian at ~3 grid cells: wide enough to remove the tracing stair-step, far narrower than the
  // sounding spacing, so it cannot invent or erase a basin feature the survey actually resolved.
  const filterWidthM = (Math.max(spanLng, spanLat) / GRID_CELLS) * SMOOTH_CELLS;
  const smoothed = join(workDir, `${lakeKey}.sm.nc`);
  const filter = spawnSync('gmt', ['grdfilter', nc, `-Fg${filterWidthM}`, '-D0', `-G${smoothed}`], {
    encoding: 'utf8',
  });
  const gridForContour = filter.status === 0 ? smoothed : nc;
  if (filter.status !== 0) {
    process.stderr.write(
      `  gmt grdfilter failed for ${lakeKey}, contouring unsmoothed: ${filter.stderr?.slice(0, 200)}\n`,
    );
  }

  const interval = chooseInterval(maxDepth);
  const levels = contourLevels(maxDepth, interval);
  if (levels.length === 0) return undefined;

  rmSync(out, { force: true });
  const contour = spawnSync(
    'gdal_contour',
    ['-a', 'depth', '-fl', ...levels.map(String), '-f', 'GeoJSON', gridForContour, out],
    { encoding: 'utf8' },
  );
  if (contour.status !== 0) {
    process.stderr.write(
      `  gdal_contour failed for ${lakeKey}: ${contour.stderr?.slice(0, 300)}\n`,
    );
    return undefined;
  }

  // Back out of the lake frame FIRST: the contours come out of gdal in the compressed local frame,
  // and everything downstream — the clip polygon, the SVG, the tiles — is lng/lat. Expand the
  // along-axis coordinate by exactly the ratio it was compressed by, then rotate. A mismatch here
  // stretches every lake in the corpus by a factor nobody would spot in a thumbnail, which is why
  // the transform is round-trip tested rather than eyeballed.
  const raw = JSON.parse(readFileSync(out, 'utf8')) as GeoJSON.FeatureCollection;
  for (const feature of raw.features) {
    const g = feature.geometry;
    const lines: number[][][] =
      g.type === 'LineString'
        ? [g.coordinates as number[][]]
        : g.type === 'MultiLineString'
          ? (g.coordinates as number[][][])
          : [];
    for (const line of lines) {
      for (const c of line) {
        const back = fromLocal(
          expandAlong({ along: c[0] as number, across: c[1] as number }, ratio),
          frame,
        );
        c[0] = back.lng;
        c[1] = back.lat;
      }
    }
  }
  const geo = join(workDir, `${lakeKey}.wgs84.geojson`);
  writeFileSync(geo, JSON.stringify(raw));

  // Then clip to the lake. The `-M` mask already trims to what the survey covered, but a mask is
  // circular around each reading and a lake is not — without this, contours spill over the shoreline
  // onto land wherever a sounding sat near the bank.
  let clipped = geo;
  if (polygon) {
    const clipFile = join(workDir, `${lakeKey}.clip.geojson`);
    writeFileSync(clipFile, JSON.stringify({ type: 'Feature', geometry: polygon, properties: {} }));
    clipped = join(workDir, `${lakeKey}.clipped.geojson`);
    rmSync(clipped, { force: true });
    const clip = spawnSync('ogr2ogr', ['-f', 'GeoJSON', '-clipsrc', clipFile, clipped, geo], {
      encoding: 'utf8',
    });
    if (clip.status !== 0 || !existsSync(clipped)) {
      process.stderr.write(`  ogr2ogr clip failed for ${lakeKey}: ${clip.stderr?.slice(0, 200)}\n`);
      clipped = geo;
    }
  }

  return {
    levels,
    interval,
    maxDepthFt: maxDepth,
    contours: JSON.parse(readFileSync(clipped, 'utf8')) as GeoJSON.FeatureCollection,
  };
}

/** One lake as an inline SVG: soundings as dots, contours as lines, deeper = darker. */
function renderSvg(
  points: readonly NormalizedSounding[],
  contours: GeoJSON.FeatureCollection,
  size = 320,
  polygon?: Polygon | MultiPolygon,
): string {
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let maxDepth = 0;
  for (const p of points) {
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.depthFt > maxDepth) maxDepth = p.depthFt;
  }
  const spanLng = maxLng - minLng || 1e-6;
  const spanLat = maxLat - minLat || 1e-6;
  const scale = Math.min(size / spanLng, size / spanLat);
  const x = (lng: number) => ((lng - minLng) * scale).toFixed(1);
  const y = (lat: number) => (size - (lat - minLat) * scale).toFixed(1);

  const paths: string[] = [];
  for (const feature of contours.features) {
    const depth = Number((feature.properties ?? {}).depth ?? 0);
    // A blue ramp, deliberately nothing like the hazard palette (D82): a depth ramp a skater could
    // mistake for a severity scale would reintroduce through colour the claim we declined in words.
    const t = maxDepth > 0 ? Math.min(1, depth / maxDepth) : 0;
    const shade = `hsl(205 70% ${72 - t * 45}%)`;
    const geometry = feature.geometry;
    const lines =
      geometry.type === 'LineString'
        ? [geometry.coordinates]
        : geometry.type === 'MultiLineString'
          ? geometry.coordinates
          : [];
    for (const line of lines) {
      const d = line
        .map((c, i) => `${i === 0 ? 'M' : 'L'}${x(c[0] as number)},${y(c[1] as number)}`)
        .join('');
      paths.push(`<path d="${d}" fill="none" stroke="${shade}" stroke-width="1.1"/>`);
    }
  }

  // The shoreline, drawn so the nesting is legible: every contour should sit inside this.
  const shoreRings = polygon
    ? ringsOf(polygon)
        .map(
          (ring) =>
            `<path d="${ring
              .map((c, i) => `${i === 0 ? 'M' : 'L'}${x(c[0] as number)},${y(c[1] as number)}`)
              .join('')}Z" fill="#f4f9fd" stroke="#94a9b8" stroke-width="1"/>`,
        )
        .join('')
    : '';

  const dots = points
    .slice(0, 1500)
    .map((p) => `<circle cx="${x(p.lng)}" cy="${y(p.lat)}" r="0.9" fill="#d1495b" opacity="0.55"/>`)
    .join('');

  return (
    `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" ` +
    `style="background:#fbfdff;border:1px solid #dde5ec;border-radius:6px">` +
    `${shoreRings}${paths.join('')}${dots}</svg>`
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const workDir = join(SCRATCH_ROOT, 'samples');
  mkdirSync(workDir, { recursive: true });
  const outPath = flag(args, 'out') ?? join(workDir, 'samples.html');
  const algorithm = flag(args, 'algo') ?? ALGORITHMS.gmt ?? '';

  // Lake polygons, keyed by the source's own lake id, fetched from our corpus. Optional: without
  // them the tool still runs, and the difference is exactly the point being demonstrated.
  const polyPath = join(workDir, 'polygons.json');
  const polygons: Record<string, Polygon | MultiPolygon> = existsSync(polyPath)
    ? (JSON.parse(readFileSync(polyPath, 'utf8')) as Record<string, Polygon | MultiPolygon>)
    : {};

  process.stderr.write('[bathymetry] reading Maine soundings from the archive…\n');
  const records: NormalizedSounding[] = [];
  for (const page of listRawPages('me-dep-soundings')) {
    const parsed = JSON.parse(readRawPage('me-dep-soundings', page)) as {
      features?: GeoJSON.Feature[];
    };
    records.push(...normalizeMeSoundings(parsed.features ?? []).records);
  }
  const groups = groupByLake(records);

  // Assess every lake once, then pick examples spanning the range of coverage — the gate is about
  // coverage, so that is the axis the samples must span.
  const assessed: { assessment: DensityAssessment; points: NormalizedSounding[] }[] = [];
  for (const [lakeKey, points] of groups) {
    if (points.length < 12) continue;
    assessed.push({ assessment: assessDensity({ lakeKey, points }), points });
  }
  assessed.sort((a, b) => a.assessment.gapRatio - b.assessment.gapRatio);

  // But size is not a free variable. Taking the first lake at each gap level produced eight ponds of
  // 6–21 ft, because tiny waters dominate the corpus — and a threshold judged on farm ponds is not
  // the threshold that governs the lakes anyone drives to. So samples are drawn from lakes big and
  // deep enough that their contours are worth rendering at all.
  const MIN_SAMPLE_EXTENT_M = 900;
  const MIN_SAMPLE_DEPTH_FT = 25;
  const eligible = assessed.filter(
    (a) =>
      Number.isFinite(a.assessment.gapRatio) &&
      a.assessment.extentM >= MIN_SAMPLE_EXTENT_M &&
      a.points.some((p) => p.depthFt >= MIN_SAMPLE_DEPTH_FT),
  );

  const only = flag(args, 'only')
    ?.split(',')
    .map((k) => k.trim());
  let picked: typeof assessed;
  if (only) {
    // Explicit lake keys — used to compare the same lakes with and without a shoreline constraint.
    picked = only
      .map((key) => assessed.find((a) => a.assessment.lakeKey === key))
      .filter((a): a is (typeof assessed)[number] => a !== undefined);
  } else {
    const wanted = [0.05, 0.08, 0.1, 0.12, 0.15, 0.18, 0.22, 0.3];
    picked = [];
    for (const target of wanted) {
      const match = eligible.find((a) => a.assessment.gapRatio >= target && !picked.includes(a));
      if (match) picked.push(match);
    }
  }

  // `--list` prints eligible lakes with their real gap ratio and centroid, so a comparison grid can
  // be assembled from measured values rather than a proxy.
  if (args.includes('--list')) {
    for (const { assessment, points } of eligible) {
      // The DEEPEST sounding, not the centroid of soundings, as the representative point.
      // A centroid is not guaranteed to be on the water — on a crescent or a horseshoe lake it lands
      // on the headland in the middle, and the join then finds nothing (or worse, the pond next
      // door). A sounding is on water by definition, and the deepest one is furthest from any shore,
      // which makes it the least likely to fall outside a shoreline drawn from a different survey.
      let deepest = points[0];
      for (const pt of points) if (deepest && pt.depthFt > deepest.depthFt) deepest = pt;
      process.stdout.write(
        `${assessment.lakeKey}\t${(assessment.gapRatio * 100).toFixed(1)}\t${assessment.pointCount}\t${Math.round(assessment.extentM)}\t${deepest?.lng.toFixed(5)}\t${deepest?.lat.toFixed(5)}\n`,
      );
    }
    return;
  }

  process.stderr.write(`[bathymetry] interpolating ${picked.length} sample lakes…\n`);
  const cards: string[] = [];
  for (const { assessment, points } of picked) {
    const polygon = polygons[assessment.lakeKey];
    const result = interpolateAndContour(assessment.lakeKey, points, workDir, algorithm, polygon);
    if (!result) continue;
    const pct = (assessment.gapRatio * 100).toFixed(0);
    cards.push(
      `<figure>${renderSvg(points, result.contours, 320, polygon)}` +
        `<figcaption><b>MIDAS ${assessment.lakeKey}</b> — gap <b>${pct}%</b><br>` +
        `${assessment.pointCount} soundings · ${Math.round(assessment.extentM)} m across<br>` +
        `worst water ${Math.round(assessment.coverageGapM)} m from a reading<br>` +
        `${result.levels.length} contours · ${result.interval} ft interval · max ${Math.round(result.maxDepthFt)} ft` +
        `</figcaption></figure>`,
    );
    process.stderr.write(`  ${assessment.lakeKey}: gap ${pct}% · ${assessment.pointCount} pts\n`);
  }

  writeFileSync(
    outPath,
    `<!doctype html><meta charset="utf-8"><title>N6b density-gate samples</title>
<style>
 body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:2rem;max-width:1200px;color:#16222c}
 h1{font-size:1.4rem} figure{margin:0;display:inline-block;text-align:center}
 figcaption{font-size:12px;color:#5a6b78;margin-top:.4rem}
 .grid{display:flex;flex-wrap:wrap;gap:1.6rem;margin-top:1.5rem}
 .note{background:#f2f7fb;border-left:3px solid #7ba7c7;padding:.8rem 1rem;border-radius:4px}
</style>
<h1>N6b — what the density gate is actually choosing between</h1>
<p class="note">Real Maine lakes, ordered by <b>coverage gap</b> — the p95 distance from water inside
the surveyed area to the nearest sounding, as a fraction of the lake's extent. Red dots are the
soundings the state published; blue lines are the contours our interpolation produces from them.
<br><br>Read left to right and pick the point where the contours stop describing a basin and start
describing the interpolator. The sweep says a 15% gate keeps 92% of Maine and a 10% gate keeps 64%.</p>
<div class="grid">${cards.join('')}</div>`,
  );
  process.stderr.write(`\n[bathymetry] wrote ${outPath}\n`);
}

main();
