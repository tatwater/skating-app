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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { listRawPages, readRawPage, SCRATCH_ROOT } from './cache';
import { assessDensity, type DensityAssessment } from './density';
import { chooseInterval, contourLevels } from './interval';
import { groupByLake, type NormalizedSounding, normalizeMeSoundings } from './normalize';

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
export const ALGORITHMS: Record<string, string> = {
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
):
  | { levels: number[]; interval: number; maxDepthFt: number; contours: GeoJSON.FeatureCollection }
  | undefined {
  const csv = join(workDir, `${lakeKey}.csv`);
  const vrt = join(workDir, `${lakeKey}.vrt`);
  const tif = join(workDir, `${lakeKey}.tif`);
  const out = join(workDir, `${lakeKey}.geojson`);

  writeFileSync(
    csv,
    `lng,lat,depth\n${points.map((p) => `${p.lng},${p.lat},${p.depthFt}`).join('\n')}\n`,
  );
  writeFileSync(
    vrt,
    `<OGRVRTDataSource><OGRVRTLayer name="${lakeKey}">` +
      `<SrcDataSource>${csv}</SrcDataSource>` +
      `<GeometryType>wkbPoint</GeometryType>` +
      `<LayerSRS>EPSG:4326</LayerSRS>` +
      `<GeometryField encoding="PointFromColumns" x="lng" y="lat" z="depth"/>` +
      `</OGRVRTLayer></OGRVRTDataSource>\n`,
  );

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

  // A moving-average window sized to the lake, not to a fixed distance. `average` is deliberately a
  // SMOOTHING interpolator rather than an exact one — it does not pass through the data points, which
  // is precisely what kills the bullseyes, and it is honest about what we are doing: fitting a
  // low-detail surface through readings whose spacing is the resolution limit.
  const spanDeg = Math.max(maxLng - minLng, maxLat - minLat);
  const smoothRadius = spanDeg * 0.06;

  const grid = spawnSync(
    'gdal_grid',
    [
      '-a',
      algorithm.replace('{r}', String(smoothRadius)),
      '-txe',
      String(minLng),
      String(maxLng),
      '-tye',
      String(minLat),
      String(maxLat),
      '-outsize',
      '700',
      '700',
      '-of',
      'GTiff',
      '-ot',
      'Float32',
      '-l',
      lakeKey,
      vrt,
      tif,
    ],
    { encoding: 'utf8' },
  );
  if (grid.status !== 0) {
    process.stderr.write(`  gdal_grid failed for ${lakeKey}: ${grid.stderr?.slice(0, 300)}\n`);
    return undefined;
  }

  const interval = chooseInterval(maxDepth);
  const levels = contourLevels(maxDepth, interval);
  if (levels.length === 0) return undefined;

  rmSync(out, { force: true });
  const contour = spawnSync(
    'gdal_contour',
    ['-a', 'depth', '-fl', ...levels.map(String), '-f', 'GeoJSON', tif, out],
    { encoding: 'utf8' },
  );
  if (contour.status !== 0) {
    process.stderr.write(
      `  gdal_contour failed for ${lakeKey}: ${contour.stderr?.slice(0, 300)}\n`,
    );
    return undefined;
  }

  return {
    levels,
    interval,
    maxDepthFt: maxDepth,
    contours: JSON.parse(readFileSync(out, 'utf8')) as GeoJSON.FeatureCollection,
  };
}

/** One lake as an inline SVG: soundings as dots, contours as lines, deeper = darker. */
function renderSvg(
  points: readonly NormalizedSounding[],
  contours: GeoJSON.FeatureCollection,
  size = 320,
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

  const dots = points
    .slice(0, 1500)
    .map((p) => `<circle cx="${x(p.lng)}" cy="${y(p.lat)}" r="0.9" fill="#d1495b" opacity="0.55"/>`)
    .join('');

  return (
    `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" ` +
    `style="background:#fbfdff;border:1px solid #dde5ec;border-radius:6px">` +
    `${paths.join('')}${dots}</svg>`
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const workDir = join(SCRATCH_ROOT, 'samples');
  mkdirSync(workDir, { recursive: true });
  const outPath = flag(args, 'out') ?? join(workDir, 'samples.html');
  const algorithm = flag(args, 'algo') ?? ALGORITHMS.linear ?? 'linear:radius=-1:nodata=-9999';

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

  const wanted = [0.05, 0.08, 0.1, 0.12, 0.15, 0.18, 0.22, 0.3];
  const picked: typeof assessed = [];
  for (const target of wanted) {
    const match = eligible.find((a) => a.assessment.gapRatio >= target && !picked.includes(a));
    if (match) picked.push(match);
  }

  process.stderr.write(`[bathymetry] interpolating ${picked.length} sample lakes…\n`);
  const cards: string[] = [];
  for (const { assessment, points } of picked) {
    const result = interpolateAndContour(assessment.lakeKey, points, workDir, algorithm);
    if (!result) continue;
    const pct = (assessment.gapRatio * 100).toFixed(0);
    cards.push(
      `<figure>${renderSvg(points, result.contours)}` +
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
