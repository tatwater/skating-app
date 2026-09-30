/**
 * The landmark ETL's transform stage (D202) — glue, excluded from coverage. Every rule it applies is
 * in `landmarkSource.ts` (what a feature is), `landmarkMatch.ts` (which body it belongs to, what is
 * one place) and `landmarkCorpus.ts` (the community's names), all at full coverage.
 *
 *   pnpm --filter @skating/etl landmarks                       # all five states
 *   pnpm --filter @skating/etl landmarks VT NH                 # some
 *   pnpm --filter @skating/etl landmarks --refresh-bodies      # re-export the body outlines
 *   pnpm --filter @skating/etl landmarks --refresh             # re-run osmium
 *   pnpm --filter @skating/etl landmarks --mentions=<mentions.csv>   # required, or --without-corpus
 *
 * Writes `.scratch/landmarks/landmarks.ndjson` — one line per body, `{ waterBodyId, landmarks }` —
 * plus `summary.json`, and the corpus names nothing matched to `corpus-unmatched.csv` (to read) and
 * `corpus-names.ndjson` (to load). Then `load-landmarks` writes the landmarks and
 * `load-landmark-names` the names, each dry unless `--apply`.
 *
 * ## The one deployment read
 *
 * Bodies are matched **here**, against `landmarks:listBodyGeometry` exported once to
 * `.scratch/landmarks/bodies.ndjson` (~45 MB, every listed body's outline), not per point in a
 * mutation. The export is cached; `--refresh-bodies` re-reads it after a campaign moves bodies.
 */

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { convexRun } from '@skating/run-log';
import type { Feature } from 'geojson';
import { osmLandmarkExportArgs, osmLandmarkFilterArgs } from './extract';
import { gnisColumnIndexes, gnisTextPath } from './gnisSource';
import { applyCorpus, corpusNameRecords, parseMentions } from './landmarkCorpus';
import { BodyIndex, type MatchBody, placeLandmarks } from './landmarkMatch';
import {
  dedupeOsmById,
  type LandmarkCandidate,
  parseGnisLandmark,
  parseOsmLandmark,
} from './landmarkSource';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OSM_DIR = join(ROOT, '.raw');
const SCRATCH = join(ROOT, '.scratch', 'landmarks');
const BODIES = join(SCRATCH, 'bodies.ndjson');
const ALL_STATES = ['vt', 'nh', 'me', 'ma', 'ny'] as const;

function log(message: string): void {
  process.stderr.write(`[landmarks] ${message}\n`);
}

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function readLines(path: string, onLine: (line: string) => void): Promise<void> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) onLine(line);
}

/** Page every listed body's outline out of the deployment, once, into the cache. */
function exportBodies(): void {
  mkdirSync(SCRATCH, { recursive: true });
  const lines: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = convexRun<{ bodies: unknown[]; cursor: string; isDone: boolean }>(
      'landmarks:listBodyGeometry',
      cursor === undefined ? {} : { cursor },
    );
    for (const body of page.bodies) lines.push(JSON.stringify(body));
    pages++;
    if (pages % 50 === 0) log(`bodies: ${pages} pages, ${lines.length.toLocaleString()} listed`);
    if (page.isDone) break;
    cursor = page.cursor;
  }
  writeFileSync(BODIES, `${lines.join('\n')}\n`);
  log(`bodies: ${lines.length.toLocaleString()} listed bodies exported`);
}

async function loadBodies(): Promise<MatchBody[]> {
  const bodies: MatchBody[] = [];
  await readLines(BODIES, (line) => {
    const b = JSON.parse(line) as {
      _id: string;
      name?: string;
      states?: string[];
      polygon: MatchBody['polygon'];
      bbox: MatchBody['bbox'];
      surfaceAreaSqM: number;
    };
    bodies.push({
      id: b._id,
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.states !== undefined ? { states: b.states } : {}),
      polygon: b.polygon,
      bbox: b.bbox,
      surfaceAreaSqM: b.surfaceAreaSqM,
    });
  });
  return bodies;
}

/** One state's landmark features through osmium, cached in `.scratch`. */
function osmFeatureFile(state: string, refresh: boolean): string {
  const out = join(SCRATCH, `osm-${state}.geojsonseq`);
  if (existsSync(out) && !refresh) return out;
  const dir = join(OSM_DIR, state);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${state}: no archived extract at ${dir}. Run \`pnpm --filter @skating/etl archive ${state.toUpperCase()}\` first.`,
    );
  }
  const { filename } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { filename: string };
  const filtered = join(SCRATCH, `osm-${state}.pbf`);
  log(`${state}: filtering landmark features…`);
  const step1 = spawnSync('osmium', osmLandmarkFilterArgs(join(dir, filename), filtered), {
    encoding: 'utf8',
  });
  if (step1.status !== 0) throw new Error(`${state}: osmium tags-filter exited ${step1.status}`);
  const step2 = spawnSync('osmium', osmLandmarkExportArgs(filtered, out), { encoding: 'utf8' });
  if (step2.status !== 0) throw new Error(`${state}: osmium export exited ${step2.status}`);
  return out;
}

async function osmCandidates(state: string, refresh: boolean): Promise<LandmarkCandidate[]> {
  const found: LandmarkCandidate[] = [];
  await readLines(osmFeatureFile(state, refresh), (line) => {
    const c = parseOsmLandmark(JSON.parse(line) as Feature);
    if (c) found.push(c);
  });
  return dedupeOsmById(found);
}

function gnisCandidates(state: string): LandmarkCandidate[] {
  const path = gnisTextPath(state.toUpperCase());
  if (!existsSync(path)) {
    throw new Error(
      `${state}: no GNIS text at ${path}. Run \`pnpm --filter @skating/etl archive-gnis\`.`,
    );
  }
  const [header, ...rows] = readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  const columns = gnisColumnIndexes((header ?? '').split('|'));
  if (!columns) throw new Error(`${state}: the GNIS header lacks a column the pass reads`);
  const found: LandmarkCandidate[] = [];
  for (const row of rows) {
    const c = parseGnisLandmark(row.split('|'), columns);
    if (c) found.push(c);
  }
  return found;
}

function csvCell(value: string | number | undefined): string {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const states = args.filter((a) => !a.startsWith('--')).map((s) => s.toLowerCase());
  const selected = states.length > 0 ? states : [...ALL_STATES];
  const refresh = args.includes('--refresh');
  const mentionsPath = flag(args, 'mentions');
  // The corpus is optional input (gitignored) but not an optional *outcome*: the loader replaces a
  // catalog row's corpus count and spellings with this run's, so a run without it must be meant.
  if (!mentionsPath && !args.includes('--without-corpus')) {
    throw new Error(
      'pass --mentions=<mentions.csv> (training_data/google_group/mentions/), or --without-corpus to build without community names',
    );
  }

  mkdirSync(SCRATCH, { recursive: true });
  if (!existsSync(BODIES) || args.includes('--refresh-bodies')) exportBodies();
  const bodies = await loadBodies();
  const index = new BodyIndex(bodies);
  log(`${bodies.length.toLocaleString()} listed bodies indexed`);

  const candidates: LandmarkCandidate[] = [];
  const bySource: Record<string, number> = {};
  for (const state of selected) {
    const osm = await osmCandidates(state, refresh);
    const gnis = gnisCandidates(state);
    bySource[`${state}.osm`] = osm.length;
    bySource[`${state}.gnis`] = gnis.length;
    log(
      `${state}: ${osm.length.toLocaleString()} OSM + ${gnis.length.toLocaleString()} GNIS candidates`,
    );
    candidates.push(...osm, ...gnis);
  }

  const started = Date.now();
  const { byBody, counts } = placeLandmarks(candidates, index);
  log(`placed in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  let corpus: ReturnType<typeof applyCorpus> | undefined;
  if (mentionsPath) {
    const places = parseMentions(readFileSync(mentionsPath, 'utf8'));
    corpus = applyCorpus(byBody, new Map(bodies.map((b) => [b.id, b])), places);
    log(
      `corpus: ${places.length} places — ${corpus.matched} matched, ${corpus.ambiguous.length} ambiguous, ${corpus.unmatched.length} unmatched`,
    );
    const header = 'name,kind,messages,skatedMessages,states,parentBody,candidateBodies';
    const rows = [
      ...corpus.unmatched.map((p) => [
        p.name,
        p.kind,
        p.messages,
        p.skatedMessages,
        p.states.join(';'),
        p.parentBody,
        '',
      ]),
      ...corpus.ambiguous.map(({ place: p, bodies: ids }) => [
        p.name,
        p.kind,
        p.messages,
        p.skatedMessages,
        p.states.join(';'),
        p.parentBody,
        ids.join(';'),
      ]),
    ].map((r) => r.map(csvCell).join(','));
    writeFileSync(join(SCRATCH, 'corpus-unmatched.csv'), `${[header, ...rows].join('\n')}\n`);
    // The same leftovers, with their lakes resolved where one answers, for `load-landmark-names` —
    // the moderator's queue on /admin/water/place-names (D202).
    // Only from a run over every state: a name another state's landmarks answer to is not a name
    // "no landmark took", and a one-state run cannot tell.
    if (ALL_STATES.every((st) => selected.includes(st))) {
      const names = corpusNameRecords(corpus, new Map(bodies.map((b) => [b.id, b])));
      writeFileSync(
        join(SCRATCH, 'corpus-names.ndjson'),
        `${names.map((r) => JSON.stringify(r)).join('\n')}\n`,
      );
    } else {
      log(
        'corpus-names.ndjson not written: the queue is built only from a run over all five states',
      );
    }
  }

  const byKind: Record<string, number> = {};
  const perBody: number[] = [];
  const out: string[] = [];
  for (const [waterBodyId, landmarks] of byBody) {
    perBody.push(landmarks.length);
    for (const l of landmarks) byKind[l.kind] = (byKind[l.kind] ?? 0) + 1;
    out.push(
      JSON.stringify({
        waterBodyId,
        landmarks: landmarks.map(({ waterBodyId: _, ...rest }) => rest),
      }),
    );
  }
  writeFileSync(join(SCRATCH, 'landmarks.ndjson'), `${out.join('\n')}\n`);
  perBody.sort((a, b) => b - a);
  const summary = {
    states: selected,
    corpusApplied: corpus !== undefined,
    bySource,
    ...counts,
    bodiesWithLandmarks: byBody.size,
    byKind,
    largestBodies: perBody.slice(0, 10),
    ...(corpus
      ? {
          corpus: {
            matched: corpus.matched,
            ambiguous: corpus.ambiguous.length,
            unmatched: corpus.unmatched.length,
          },
        }
      : {}),
  };
  writeFileSync(join(SCRATCH, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error: unknown) => {
  log(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
