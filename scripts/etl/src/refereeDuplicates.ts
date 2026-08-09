/**
 * **Refereeing `RECONCILE_MIN_IOU` with the soundings** (D129, founder call 2026-08-08).
 *
 *   pnpm --filter @skating/etl referee-duplicates
 *
 * Committed rather than left in `.scratch/` because `REFEREED_DUPLICATES` cites it as the producer
 * of its nine entries, and a table whose regeneration instructions point at a gitignored file is a
 * decision with no producer — the exact shape this campaign keeps finding. Its output is that
 * table's comments, verbatim.
 *
 * Read-only: needs `.scratch/merge/duplicate-pairs.ndjson` + `bodies.ndjson` from a merge run, and
 * `scripts/bathymetry/.scratch/bakeoff/soundings.ndjson` from `export-soundings`. Excluded from
 * coverage like the other censuses — every rule it exercises lives in a covered module.
 *
 * 292 duplicate pairs sit at IoU 0.30–0.49 — below the 0.5 merge bar and above the 0.3 sweep. The
 * open question is whether that band is *one lake drawn twice* (so the bar should come down) or *a
 * bay beside its parent* (so it must not). D92 settled the geometry question against 2.4M soundings;
 * this asks the same referee a different question.
 *
 * ## The test
 *
 * A survey is taken over ONE lake. So for each pair (A, B):
 *
 * - **one lake** — a single survey's points fall substantially inside *both* A and B. Somebody rowed
 *   across the whole thing in an afternoon and called it one water body.
 * - **two lakes** — survey X covers A and a *different* survey Y covers B. Two crews, two lakes, two
 *   ids in the state's own inventory.
 * - **inconclusive** — fewer than two of the surveys reach either half. Most pairs, since the corpus
 *   is 25,000 bodies and only 2,383 are surveyed.
 *
 * Reported as a rate over the *conclusive* pairs only. A pair nobody surveyed is not evidence either
 * way, and folding it in as "not one lake" is the misleading-denominator shape this campaign keeps
 * having to correct.
 *
 * ## ⚠ Re-running it after its own findings landed reports ZERO, and that is the pass
 *
 * The verdict on 2026-08-08 was **9 one-lake / 0 two-lakes / 283 unreached**, over 292 pairs. Those
 * nine are now in `REFEREED_DUPLICATES`, so the merge joins them and they no longer appear as pairs
 * at all — a re-run against fresh artifacts sees **283 pairs and 0 conclusive**.
 *
 * That is the round trip closing, not a regression: the referee finding nothing left to find is what
 * "the nine landed" looks like from here. If it ever reports a *new* conclusive pair, the corpus or
 * the sounding archive moved and the table wants another entry.
 */
import { createReadStream, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { pointInPolygon } from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';

const HERE = dirname(fileURLToPath(import.meta.url));
const MERGE = resolve(HERE, '../.scratch/merge');
const SOUNDINGS = resolve(HERE, '../../bathymetry/.scratch/bakeoff/soundings.ndjson');
/** A survey "covers" a half when this many of its points land inside it. */
const MIN_POINTS_INSIDE = 8;

interface BBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}
const overlaps = (a: BBox, b: BBox) =>
  a.minLng <= b.maxLng && a.maxLng >= b.minLng && a.minLat <= b.maxLat && a.maxLat >= b.minLat;

// ── the pairs in the band ────────────────────────────────────────────────────
interface Pair {
  a: string;
  b: string;
  iou: number;
  aName: string;
  bName: string;
  aAcres: number;
  bAcres: number;
  sameName: boolean;
}
const pairs = readFileSync(`${MERGE}/duplicate-pairs.ndjson`, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Pair)
  .filter((p) => p.iou < 0.5);
console.log(`${pairs.length} pairs in the 0.30–0.49 band\n`);

// ── the bodies they name ─────────────────────────────────────────────────────
const wanted = new Set(pairs.flatMap((p) => [p.a, p.b]));
const geom = new Map<string, { polygon: Polygon | MultiPolygon; bbox: BBox }>();
const rl = createInterface({
  input: createReadStream(`${MERGE}/bodies.ndjson`),
  crlfDelay: Infinity,
});
for await (const line of rl) {
  if (!line.trim()) continue;
  const b = JSON.parse(line) as {
    externalId: string;
    geometrySource: string;
    polygon: Polygon | MultiPolygon;
    bbox: BBox;
  };
  const key = `${b.geometrySource}:${b.externalId}`;
  if (wanted.has(key)) geom.set(key, { polygon: b.polygon, bbox: b.bbox });
}
console.log(`${geom.size} of ${wanted.size} pair members resolved to a stored outline`);

// ── the surveys ──────────────────────────────────────────────────────────────
interface Survey {
  lakeKey: string;
  name: string;
  state: string;
  pts: [number, number][];
  bbox: BBox;
}
const surveys: Survey[] = [];
const rl2 = createInterface({ input: createReadStream(SOUNDINGS), crlfDelay: Infinity });
for await (const line of rl2) {
  if (!line.trim()) continue;
  const s = JSON.parse(line) as {
    lakeKey: string;
    name: string;
    state: string;
    /** **Flat** `[lng, lat, lng, lat, …]` at 5 decimals — see `exportSoundings.ts`. */
    pts: number[];
    polygon: Polygon | MultiPolygon;
  };
  if (!s.pts?.length) continue;
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < s.pts.length; i += 2) {
    pts.push([s.pts[i] as number, s.pts[i + 1] as number]);
  }
  const lngs = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  surveys.push({
    lakeKey: s.lakeKey,
    name: s.name,
    state: s.state,
    pts,
    bbox: {
      minLng: Math.min(...lngs),
      maxLng: Math.max(...lngs),
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
    },
  });
}
console.log(`${surveys.length} surveys loaded\n`);

// ── the verdict, per pair ────────────────────────────────────────────────────
let oneLake = 0;
let twoLakes = 0;
let inconclusive = 0;
const oneLakeExamples: string[] = [];
/** The table body, generated rather than transcribed — see `REFEREED_DUPLICATES`. */
const confirmed: string[] = [];
const twoLakeExamples: string[] = [];

for (const pair of pairs) {
  const A = geom.get(pair.a);
  const B = geom.get(pair.b);
  if (!A || !B) {
    inconclusive++;
    continue;
  }
  /** Which surveys reach each half, and how far into it. */
  const inA = new Map<string, number>();
  const inB = new Map<string, number>();
  for (const s of surveys) {
    const nearA = overlaps(s.bbox, A.bbox);
    const nearB = overlaps(s.bbox, B.bbox);
    if (!nearA && !nearB) continue;
    let a = 0;
    let b = 0;
    for (const [lng, lat] of s.pts) {
      if (nearA && pointInPolygon({ lat, lng }, A.polygon)) a++;
      if (nearB && pointInPolygon({ lat, lng }, B.polygon)) b++;
    }
    if (a >= MIN_POINTS_INSIDE) inA.set(s.lakeKey, a);
    if (b >= MIN_POINTS_INSIDE) inB.set(s.lakeKey, b);
  }
  const shared = [...inA.keys()].filter((k) => inB.has(k));
  const label =
    `${pair.aName || '(unnamed)'} ${pair.aAcres}ac ↔ ${pair.bName || '(unnamed)'} ` +
    `${pair.bAcres}ac @ ${(pair.iou * 100).toFixed(0)}%`;
  if (shared.length > 0) {
    oneLake++;
    confirmed.push(
      `  // ${pair.aName || '(unnamed)'} ${pair.aAcres} ac + ${pair.bName || '(unnamed)'} ` +
        `${pair.bAcres} ac at IoU ${(pair.iou * 100).toFixed(0)}%, one survey across both: ` +
        `${shared[0]}\n  ['${pair.a}', '${pair.b}'],`,
    );
    if (oneLakeExamples.length < 12) oneLakeExamples.push(`${label}  [survey ${shared[0]}]`);
  } else if (inA.size > 0 && inB.size > 0) {
    twoLakes++;
    if (twoLakeExamples.length < 12) {
      twoLakeExamples.push(`${label}  [${[...inA.keys()][0]} vs ${[...inB.keys()][0]}]`);
    }
  } else {
    inconclusive++;
  }
}

const conclusive = oneLake + twoLakes;
console.log('═══ the verdict ═══');
console.log(`  one lake drawn twice : ${oneLake}`);
console.log(`  two distinct lakes   : ${twoLakes}`);
console.log(`  no survey reaches it : ${inconclusive}`);
console.log(
  `\n  over the ${conclusive} CONCLUSIVE pairs: ` +
    `${((oneLake / Math.max(1, conclusive)) * 100).toFixed(1)}% would be a correct merge, ` +
    `${((twoLakes / Math.max(1, conclusive)) * 100).toFixed(1)}% would be a WRONG one`,
);
console.log(`\none lake (lowering the bar would fix these):\n  ${oneLakeExamples.join('\n  ')}`);
console.log(`\ntwo lakes (lowering the bar would BREAK these):\n  ${twoLakeExamples.join('\n  ')}`);
console.log(`\n═══ paste into REFEREED_DUPLICATES ═══\n${confirmed.join('\n')}`);
