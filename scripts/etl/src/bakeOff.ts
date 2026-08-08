/**
 * **D92's bake-off** — which catalogue draws a better lake, decided by our own soundings (N7).
 *
 *   pnpm --filter @skating/bathymetry export-soundings   # once, produces the referee
 *   pnpm --filter @skating/etl bake-off [--input=<soundings.ndjson>] [--grid=N]
 *
 * ## The question, and why it needed a referee at all
 *
 * Every comparison taken before this one was circular. Maine's MIDAS waterbody layer carries
 * `Permanent_Identifier` and `ReachCode` — it **is** NHD — so scoring NHD against it returned a 0.1%
 * error, which is a tautology dressed as a finding. Counting features only answers *how many*. The
 * one independent number available was that OSM's median disagreement with that geometry is 2.4%,
 * which says OSM is not bad and says nothing about which is better.
 *
 * We hold something neither publisher does: **21.9 million depth measurements taken on the water.**
 * They are physical, they are ours, and neither catalogue was drawn with reference to them.
 *
 * ## Two metrics, because either alone can be gamed
 *
 * - `containedFraction` — what share of the survey falls inside the outline. **Punishes a polygon
 *   that is too small** and is completely blind to one that is too large.
 * - `probeCoverage` (D98) — probe the polygon's own area and measure how far each probe is from the
 *   nearest measurement. **Punishes a polygon that is too large**, because an over-drawn lake has
 *   probes out in the pasture with no sounding near them.
 *
 * Bounded on both sides. A polygon covering the lake and the field next to it scores a perfect 1.0 on
 * containment and loses badly on coverage; a polygon covering half the lake wins coverage and loses
 * containment.
 *
 * ## What this deliberately does not do
 *
 * **No thresholds.** Both candidates are scored against the *same* soundings, so the verdict is a
 * comparison and needs no absolute bar — which is what keeps this independent of D98's unresolved
 * `MAX_GAP_RATIO` recalibration. A margin is required before either side is called a winner, and that
 * margin is stated below rather than tuned.
 *
 * **Source geometry on both sides.** We simplify to ~5 m and NHD HR is a 1:24,000 compilation, so
 * comparing stored copies would make "shoreline vertex density" a measurement of our own transform.
 * Both candidates are read straight from the archive extracts.
 *
 * ## The bias this had to be rewritten to remove
 *
 * The first version took the OSM side from `.scratch/join/lakes.json` — the bathymetry join — and the
 * NHD side by matching against it. Both choices were rigged, and the numbers looked plausible anyway:
 *
 * 1. **The join selects for containment.** `matchBathymetryLakes` only accepts a body holding
 *    `MIN_SURVEY_CONTAINMENT = 0.5` of the survey, so every OSM polygon in that file had *already
 *    passed the exact test the bake-off was about to score it on*. Measured on the first run:
 *    `osmContained` had a hard floor at **0.524 with zero lakes below 0.5**, against 12 for NHD and 8
 *    at exactly zero. OSM could not lose the tail; the tail was where every "OSM wins" came from.
 * 2. **Anchoring the NHD lookup on the OSM polygon** then picked, out of NHD, whichever feature most
 *    resembled OSM — so the second catalogue was chosen to agree with the first.
 *
 * The fix is to anchor on **the referee itself**. Each catalogue independently supplies the smallest
 * feature containing the survey's *medoid* — a real measurement location, so it is on water by
 * construction — and neither selection rule reads either scored metric. A catalogue with no such
 * feature is a finding in its own right and is counted, not silently dropped.
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  type BBox,
  containedFraction,
  HARD_MIN_SURFACE_AREA_SQM,
  type LatLng,
  pointInPolygon,
  polygonBBox,
  probeCoverage,
  surfaceAreaSqM,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import { CELL_DEG, index, SQ_M_PER_ACRE } from './mergeRules';
import { NHD_SOURCES, nhdArchiveKey, normalizeNhdId } from './nhdArchive';

const HERE = dirname(fileURLToPath(import.meta.url));
const MERGE_SCRATCH = join(HERE, '..', '.scratch', 'merge');
const CLASSIFY_SCRATCH = join(HERE, '..', '.scratch', 'classify');
const OSM_STATES = ['me', 'nh', 'vt', 'ma', 'ny'] as const;
const RECORD_SEPARATOR = String.fromCharCode(0x1e);
const OUT_DIR = join(HERE, '..', '.scratch', 'bakeoff');
const DEFAULT_INPUT = join(
  HERE,
  '..',
  '..',
  'bathymetry',
  '.scratch',
  'bakeoff',
  'soundings.ndjson',
);

/**
 * How much better one candidate must score before it is called a winner.
 *
 * **Stated, not tuned.** 2% of containment and 10% of the coverage gap are wide enough that float
 * noise and the ~1.1 m rounding in the exported soundings cannot produce a verdict, and narrow enough
 * that a real difference in shoreline still registers. Anything inside both margins is a **tie**, and
 * a tie is a finding: D92 says explicitly that "the two are within noise" is a legitimate outcome
 * which must not be dressed up.
 */
const CONTAINMENT_MARGIN = 0.02;
const COVERAGE_MARGIN = 0.1;

function log(message: string): void {
  process.stderr.write(`[bake-off] ${message}\n`);
}

interface RefereeLake {
  lakeKey: string;
  externalId?: string;
  name: string;
  state: string;
  n: number;
  polygon?: Polygon | MultiPolygon;
  pts: number[];
}

/** One catalogue's candidate outline for a lake. Both sides are read from archive extracts. */
interface Candidate {
  id: string;
  name: string;
  polygon: Polygon | MultiPolygon;
  bbox: BBox;
  areaSqM: number;
}

/**
 * OSM water polygons at the one-acre floor, from the same cached extract the merge reads.
 *
 * **Unclassified on purpose.** The merge maps tags to a class and drops what it refuses; here that
 * would disqualify a candidate on a *taxonomic* judgement in a measurement about *geometry*, and it
 * would do so asymmetrically, since the NHD side is loaded without its classifier too. If a state
 * agency surveyed it, it is water, whatever either catalogue calls it.
 */
async function loadOsm(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const state of OSM_STATES) {
    const file = join(CLASSIFY_SCRATCH, `osm-${state}.geojsonseq`);
    if (!existsSync(file)) {
      throw new Error(`missing ${file} — run \`pnpm --filter @skating/etl merge\` first`);
    }
    const rl = createInterface({
      input: createReadStream(file, 'utf8'),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const raw of rl) {
      const t = raw.trim();
      const line = t.startsWith(RECORD_SEPARATOR) ? t.slice(1) : t;
      if (line.length === 0) continue;
      let f: {
        properties: { '@type'?: string; '@id'?: string | number; name?: string };
        geometry: Polygon | MultiPolygon | null;
      };
      try {
        f = JSON.parse(line);
      } catch {
        continue;
      }
      const p = f.properties;
      if (!p['@type'] || p['@id'] === undefined || !f.geometry) continue;
      const id = `${p['@type']}/${p['@id']}`;
      if (seen.has(id)) continue; // the five extracts overlap at every border
      seen.add(id);
      const areaSqM = surfaceAreaSqM(f.geometry);
      if (areaSqM < HARD_MIN_SURFACE_AREA_SQM) continue;
      out.push({
        id,
        name: p.name ?? '',
        polygon: f.geometry,
        bbox: polygonBBox(f.geometry),
        areaSqM,
      });
    }
  }
  return out;
}

/**
 * NHD at the one-acre floor, straight from the archive extract.
 *
 * Re-reads the `.geojsonl` the merge already produced rather than re-running `ogr2ogr`. **Source
 * geometry**: these are the polygons as published, never our simplified storage copy.
 */
function loadNhd(): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const source of NHD_SOURCES) {
    const key = nhdArchiveKey(source);
    const file = join(MERGE_SCRATCH, `nhd-${key}.geojsonl`);
    if (!existsSync(file)) {
      throw new Error(`missing ${file} — run \`pnpm --filter @skating/etl merge\` first`);
    }
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (t.length === 0) continue;
      let f: { properties: Record<string, unknown>; geometry: Polygon | MultiPolygon | null };
      try {
        f = JSON.parse(t);
      } catch {
        continue;
      }
      if (!f.geometry) continue;
      const id = normalizeNhdId(f.properties.permanent_identifier as string);
      if (!id.ok || seen.has(id.value)) continue;
      seen.add(id.value);
      out.push({
        id: id.value,
        name: (f.properties.gnis_name as string) ?? '',
        polygon: f.geometry,
        bbox: polygonBBox(f.geometry),
        areaSqM: surfaceAreaSqM(f.geometry),
      });
    }
  }
  return out;
}

/** Read the referee: one line per surveyed lake, carrying its OSM outline and its measurements. */
async function loadReferee(path: string): Promise<RefereeLake[]> {
  if (!existsSync(path)) {
    throw new Error(
      `missing ${path} — produce it first:\n` +
        '  pnpm --filter @skating/bathymetry export-soundings',
    );
  }
  const out: RefereeLake[] = [];
  const rl = createInterface({
    input: createReadStream(path, 'utf8'),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line) as RefereeLake);
  }
  return out;
}

type Verdict = 'osm' | 'nhd' | 'tie';

interface Score {
  lakeKey: string;
  name: string;
  state: string;
  osmId: string;
  nhdId: string;
  points: number;
  osmAcres: number;
  nhdAcres: number;
  osmContained: number;
  nhdContained: number;
  osmGapM: number | null;
  nhdGapM: number | null;
  containmentVerdict: Verdict;
  coverageVerdict: Verdict;
  verdict: Verdict;
}

/**
 * The survey's **medoid** — the actual measurement closest to the component-wise median position.
 *
 * A real sounding rather than a computed centroid, so it is by construction *on the water*: the
 * centroid of a crescent lake lands in the concavity, and anchoring the whole comparison on a point
 * in a farmer's field would pick the wrong lake from both catalogues at once. The component-wise
 * median (not the mean) keeps a stray point 300 km away from dragging it — which is not
 * hypothetical, since two Maine MIDAS keys hold clouds spanning 348 km.
 */
function medoid(points: readonly LatLng[]): LatLng {
  const lngs = [...points.map((p) => p.lng)].sort((a, b) => a - b);
  const lats = [...points.map((p) => p.lat)].sort((a, b) => a - b);
  const mid = {
    lng: lngs[Math.floor(lngs.length / 2)] as number,
    lat: lats[Math.floor(lats.length / 2)] as number,
  };
  let best = points[0] as LatLng;
  let bestD = Number.POSITIVE_INFINITY;
  for (const p of points) {
    const d = (p.lng - mid.lng) ** 2 + (p.lat - mid.lat) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * The candidate this catalogue offers for a survey: **the smallest feature containing its medoid.**
 *
 * Smallest, because a lake and the bay it contains both hold the medoid and the bay is the wrong
 * answer only when it does not contain the survey — but *larger* is the wrong tie-break in the other
 * direction, where NHD segments a chain into reaches and the smallest is the reach that was actually
 * sounded. Smallest-containing is the rule that agrees with `containedFraction`'s own reasoning
 * without reading it.
 *
 * **Neither scored metric appears here.** That is the whole point: selection must not optimise the
 * thing being measured, which is exactly the mistake the first version of this file made.
 */
function candidateFor(anchor: LatLng, grid: Map<string, Candidate[]>): Candidate | undefined {
  const cell = `${Math.floor(anchor.lng / CELL_DEG)}:${Math.floor(anchor.lat / CELL_DEG)}`;
  let best: Candidate | undefined;
  for (const c of grid.get(cell) ?? []) {
    if (anchor.lng < c.bbox.minLng || anchor.lng > c.bbox.maxLng) continue;
    if (anchor.lat < c.bbox.minLat || anchor.lat > c.bbox.maxLat) continue;
    if (!pointInPolygon(anchor, c.polygon)) continue;
    if (best === undefined || c.areaSqM < best.areaSqM) best = c;
  }
  return best;
}

/** Which side a single metric favours, given the margin it has to clear. */
function compare(osm: number, nhd: number, margin: number, higherWins: boolean): Verdict {
  const diff = higherWins ? osm - nhd : nhd - osm;
  const scale = higherWins ? 1 : Math.max(Math.abs(osm), Math.abs(nhd), 1);
  if (Math.abs(diff) / scale < margin) return 'tie';
  return diff > 0 ? 'osm' : 'nhd';
}

/**
 * Combine the two metrics into one verdict.
 *
 * **Agreement or nothing.** When containment and coverage point at different catalogues the honest
 * answer is that they disagree — one outline contains the survey better and the other describes the
 * water better — and picking a winner would be inventing a weighting the evidence does not support.
 * Those lakes are counted as `split` in the report and are exactly where a per-lake override would
 * have to be a human call.
 */
function combine(containment: Verdict, coverage: Verdict): Verdict | 'split' {
  if (containment === coverage) return containment;
  if (containment === 'tie') return coverage;
  if (coverage === 'tie') return containment;
  return 'split';
}

/**
 * Lakes where the two metrics point at different catalogues — one outline contains the survey better
 * and the other describes the water better. Collected rather than resolved: picking a winner would
 * mean inventing a weighting the evidence does not support.
 */
const splits: Score[] = [];

/**
 * Surveys only one catalogue has a polygon for — **the finding this whole phase started from.**
 * Named rather than counted: "NHD has lakes OSM does not" is the claim that justified the campaign,
 * and a bare count cannot be checked against Beau Lake.
 */
const soleSource: string[] = [];

async function main(): Promise<void> {
  const inputPath =
    process.argv.find((a) => a.startsWith('--input='))?.split('=')[1] ?? DEFAULT_INPUT;
  const grid = Number(process.argv.find((a) => a.startsWith('--grid='))?.split('=')[1] ?? 28);
  mkdirSync(OUT_DIR, { recursive: true });

  log('loading the referee…');
  const referee = await loadReferee(inputPath);
  log(`  ${referee.length.toLocaleString()} surveyed lakes`);

  log('loading OSM source geometry…');
  const osm = await loadOsm();
  log(`  ${osm.length.toLocaleString()} OSM features`);
  const osmGrid = index(osm);

  log('loading NHD source geometry…');
  const nhd = loadNhd();
  log(`  ${nhd.length.toLocaleString()} NHD features`);
  const nhdGrid = index(nhd);

  const scores: Score[] = [];
  const skipped = { noPoints: 0, neitherHasIt: 0, osmOnly: 0, nhdOnly: 0 };
  let done = 0;

  for (const lake of referee) {
    if (++done % 250 === 0) log(`  ${done.toLocaleString()} / ${referee.length.toLocaleString()}`);
    const points: LatLng[] = [];
    for (let i = 0; i + 1 < lake.pts.length; i += 2) {
      points.push({ lng: lake.pts[i] as number, lat: lake.pts[i + 1] as number });
    }
    if (points.length === 0) {
      skipped.noPoints++;
      continue;
    }

    // **Anchored on the survey, not on either polygon.** Each catalogue answers the same question
    // independently, so neither is chosen to resemble the other and neither is pre-screened on a
    // metric it is about to be scored on.
    const anchor = medoid(points);
    const osmPick = candidateFor(anchor, osmGrid);
    const nhdPick = candidateFor(anchor, nhdGrid);

    // A catalogue with no polygon over the survey's centre is a coverage finding, not a geometry
    // one — counted here and reported, never scored as a loss.
    if (!osmPick && !nhdPick) {
      skipped.neitherHasIt++;
      continue;
    }
    if (!nhdPick) {
      skipped.osmOnly++;
      soleSource.push(
        `OSM only  ${lake.name || '(unnamed)'} [${lake.state}] ${Math.round((osmPick?.areaSqM ?? 0) / SQ_M_PER_ACRE).toLocaleString()} ac`,
      );
      continue;
    }
    if (!osmPick) {
      skipped.nhdOnly++;
      soleSource.push(
        `NHD only  ${lake.name || '(unnamed)'} [${lake.state}] ${Math.round(nhdPick.areaSqM / SQ_M_PER_ACRE).toLocaleString()} ac`,
      );
      continue;
    }

    const osmContained = containedFraction(points, osmPick.polygon);
    const nhdContained = containedFraction(points, nhdPick.polygon);
    const osmProbe = probeCoverage(osmPick.polygon, points, { grid, areaSqM: osmPick.areaSqM });
    const nhdProbe = probeCoverage(nhdPick.polygon, points, { grid, areaSqM: nhdPick.areaSqM });

    // A polygon that cannot be probed abstains; scoring the abstention as a win would hand the
    // verdict to whichever outline was too thin to hold a probe.
    const coverageVerdict: Verdict =
      osmProbe && nhdProbe ? compare(osmProbe.gapM, nhdProbe.gapM, COVERAGE_MARGIN, false) : 'tie';

    const containmentVerdict = compare(osmContained, nhdContained, CONTAINMENT_MARGIN, true);
    const combined = combine(containmentVerdict, coverageVerdict);

    const score: Score = {
      lakeKey: lake.lakeKey,
      name: lake.name,
      state: lake.state,
      osmId: osmPick.id,
      nhdId: nhdPick.id,
      points: points.length,
      osmAcres: Math.round(osmPick.areaSqM / SQ_M_PER_ACRE),
      nhdAcres: Math.round(nhdPick.areaSqM / SQ_M_PER_ACRE),
      osmContained,
      nhdContained,
      osmGapM: osmProbe?.gapM ?? null,
      nhdGapM: nhdProbe?.gapM ?? null,
      containmentVerdict,
      coverageVerdict,
      verdict: combined === 'split' ? 'tie' : combined,
    };
    scores.push(score);
    if (combined === 'split') splits.push(score);
  }

  report(scores, skipped, grid);
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

function tally(rows: readonly Score[], pick: (s: Score) => Verdict): Record<Verdict, number> {
  const out: Record<Verdict, number> = { osm: 0, nhd: 0, tie: 0 };
  for (const r of rows) out[pick(r)]++;
  return out;
}

function pct(n: number, total: number): string {
  return total === 0 ? '  0.0%' : `${((n / total) * 100).toFixed(1).padStart(5)}%`;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function report(scores: readonly Score[], skipped: Record<string, number>, grid: number): void {
  const n = (v: number) => v.toLocaleString().padStart(7);
  const lines: string[] = [];
  const total = scores.length;

  lines.push('');
  lines.push('══ D92 bake-off — OSM vs NHD, refereed by our own soundings ═══════');
  lines.push(`  lakes judged      ${n(total)}   probe grid ${grid}×${grid}`);
  lines.push(
    `  skipped           ${n(Object.values(skipped).reduce((a, b) => a + b, 0))}   ` +
      Object.entries(skipped)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(' · '),
  );
  lines.push('');

  const c = tally(scores, (s) => s.containmentVerdict);
  const g = tally(scores, (s) => s.coverageVerdict);
  const v = tally(scores, (s) => s.verdict);
  lines.push('  metric            OSM wins    NHD wins        tie');
  const row = (label: string, t: Record<Verdict, number>) =>
    `  ${label.padEnd(16)}${n(t.osm)} ${pct(t.osm, total)}${n(t.nhd)} ${pct(t.nhd, total)}${n(t.tie)} ${pct(t.tie, total)}`;
  lines.push(row('containment', c));
  lines.push(row('coverage gap', g));
  lines.push(row('COMBINED', v));
  lines.push(
    `  the two metrics disagree on ${splits.length.toLocaleString()} lakes (${pct(splits.length, total).trim()}) — counted as ties above`,
  );
  lines.push('');

  lines.push('  medians:');
  lines.push(
    `    containment   osm ${median(scores.map((s) => s.osmContained)).toFixed(4)}   nhd ${median(scores.map((s) => s.nhdContained)).toFixed(4)}`,
  );
  const osmGaps = scores.map((s) => s.osmGapM).filter((x): x is number => x !== null);
  const nhdGaps = scores.map((s) => s.nhdGapM).filter((x): x is number => x !== null);
  lines.push(
    `    coverage gap  osm ${Math.round(median(osmGaps))} m   nhd ${Math.round(median(nhdGaps))} m`,
  );
  lines.push(
    `    acres         osm ${Math.round(median(scores.map((s) => s.osmAcres)))}   nhd ${Math.round(median(scores.map((s) => s.nhdAcres)))}`,
  );
  lines.push('');

  // Per state — D92 asks for a per-state default if the answer is not uniform.
  lines.push('  by state:');
  const states = [...new Set(scores.map((s) => s.state))].sort();
  for (const st of states) {
    const rows = scores.filter((s) => s.state === st);
    const t = tally(rows, (s) => s.verdict);
    lines.push(
      `    ${st}  ${String(rows.length).padStart(5)} lakes   osm ${pct(t.osm, rows.length)}   nhd ${pct(t.nhd, rows.length)}   tie ${pct(t.tie, rows.length)}`,
    );
  }
  lines.push('');

  // Per size band — a default that flips with lake size is a different finding from one that doesn't.
  lines.push('  by size (OSM acres):');
  const bands: [string, (a: number) => boolean][] = [
    ['   <10', (a) => a < 10],
    ['  10-50', (a) => a >= 10 && a < 50],
    [' 50-250', (a) => a >= 50 && a < 250],
    ['250-1000', (a) => a >= 250 && a < 1000],
    ['  1000+', (a) => a >= 1000],
  ];
  for (const [label, test] of bands) {
    const rows = scores.filter((s) => test(s.osmAcres));
    if (rows.length === 0) continue;
    const t = tally(rows, (s) => s.verdict);
    lines.push(
      `    ${label}  ${String(rows.length).padStart(5)} lakes   osm ${pct(t.osm, rows.length)}   nhd ${pct(t.nhd, rows.length)}   tie ${pct(t.tie, rows.length)}`,
    );
  }
  lines.push('');

  // The named fixtures the phase is checked against.
  lines.push('  named fixtures:');
  for (const needle of ['Beau', 'Moosehead', 'Champlain', 'China Lake', 'Sebago']) {
    for (const s of scores.filter((x) => x.name.includes(needle)).slice(0, 2)) {
      lines.push(
        `    ${s.name.padEnd(24)} ${s.verdict.toUpperCase().padEnd(4)}  ` +
          `osm ${s.osmAcres.toLocaleString()} ac (contain ${s.osmContained.toFixed(3)}, gap ${Math.round(s.osmGapM ?? 0)} m)  ` +
          `nhd ${s.nhdAcres.toLocaleString()} ac (contain ${s.nhdContained.toFixed(3)}, gap ${Math.round(s.nhdGapM ?? 0)} m)`,
      );
    }
  }
  lines.push('');

  // The biggest per-lake disagreements — D92's override rule is about exactly these.
  const byMargin = [...scores]
    .filter((s) => s.verdict !== 'tie')
    .sort(
      (a, b) =>
        Math.abs(b.osmContained - b.nhdContained) - Math.abs(a.osmContained - a.nhdContained),
    )
    .slice(0, 12);
  lines.push('  largest containment disagreements (candidates for a per-lake override):');
  for (const s of byMargin) {
    lines.push(
      `    ${s.verdict.toUpperCase().padEnd(4)} ${s.name.slice(0, 26).padEnd(26)} ${s.state}  ` +
        `osm ${s.osmContained.toFixed(3)} / nhd ${s.nhdContained.toFixed(3)}   ` +
        `${s.osmAcres.toLocaleString()} vs ${s.nhdAcres.toLocaleString()} ac`,
    );
  }

  if (soleSource.length > 0) {
    lines.push('');
    lines.push('  surveyed water only ONE catalogue draws:');
    for (const line of soleSource) lines.push(`    ${line}`);
  }
  lines.push('');
  lines.push(
    '  method: both sides are SOURCE geometry, each catalogue independently supplying the',
  );
  lines.push(
    "  smallest feature containing the survey's medoid. Neither selection rule reads either",
  );
  lines.push(
    '  scored metric — the first version took OSM from the bathymetry join, which had already',
  );
  lines.push('  screened it at 0.5 containment, and OSM could not lose the tail it was scored on.');

  process.stdout.write(`${lines.join('\n')}\n`);

  const out = join(OUT_DIR, 'bakeoff.ndjson');
  writeFileSync(out, `${scores.map((s) => JSON.stringify(s)).join('\n')}\n`);
  log(`per-lake scores → ${out}`);
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
