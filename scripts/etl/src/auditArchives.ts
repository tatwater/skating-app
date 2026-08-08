/**
 * Audit the acquired archives before anything is built on them (N7).
 *
 *   pnpm --filter @skating/etl audit-archives [--campaign=<id>]
 *
 * ## Why this runs before step 2 and not after step 12
 *
 * Every downstream layer — reconciliation, the corpus, depth, bathymetry, wind — keys off identifiers
 * that come out of these archives. A wrong id rule does not produce an error; it produces an **empty
 * join**, which reads as "these catalogues have nothing in common". This phase met that failure four
 * separate times in one session:
 *
 * - `normalizeNhdId` accepted only GUIDs, and **84.4%** of the corpus is numeric.
 * - GNIS ids joined raw matched **0 of 3,031** because NHD zero-pads and 3DHP does not.
 * - NHD's field names are lower-case in the geodatabase and upper-case from the REST service.
 * - `ogr2ogr -spat` read a degrees envelope as Albers metres and clipped an empty file, exit 0.
 *
 * So this pass re-derives every rule **from the archives themselves** and asserts the result against
 * the census stored beside the rule. If the source changes shape or someone widens a rule without
 * re-measuring, it fails here — loudly, with the offending values — rather than three passes later as
 * a coverage number nobody can explain.
 *
 * ## What it checks
 *
 * 1. **Format census** for `permanent_identifier` and `gnis_id`, against `NHD_ID_CENSUS` /
 *    `GNIS_ID_CENSUS`, through `DropLedger` so every rejection is counted under a named reason.
 * 2. **Duplicates.** The five state geodatabases overlap heavily — NH's reaches 46.09°N, into Maine
 *    and Québec — so the same lake appears in several files. That is only safe if the copies *agree*:
 *    this asserts that a shared `permanent_identifier` never carries a different area, which is what
 *    makes dedup lossless rather than a coin flip.
 * 3. **Conflicts.** A `permanent_identifier` appearing twice inside **one** file would be a real
 *    duplicate rather than overlap, and there should be none.
 * 4. **3DHP primary key** — `id3dhp` must be unique.
 * 5. **GNIS fan-out** — how many GNIS ids resolve to more than one body, which is the measured reason
 *    GNIS is a candidate generator and not a join key.
 *
 * Read-only. Touches no Convex data beyond its own run row.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  convexRun,
  DropLedger,
  expectAcceptance,
  formatLedger,
  RunLogger,
  resolveDeployment,
} from '@skating/run-log';
import { ONE_ACRE_SQ_KM } from './extract';
import {
  GNIS_ID_CENSUS,
  NHD_ID_CENSUS,
  NHD_SOURCES,
  nhdArchiveKey,
  normalizeGnisId,
  normalizeNhdId,
} from './nhdArchive';
import { THREE_DHP_WATERBODY_LAYER } from './threeDhpArchive';

const HERE = dirname(fileURLToPath(import.meta.url));
const NHD_DIR = join(HERE, '..', '.raw-nhd');
const CLIP_DIR = join(HERE, '..', '.raw-3dhp', 'waterbody');

/**
 * The floor the audit measures at — **the same one the merge extracts at, imported not restated**
 * (second audit, 2026-08-06).
 *
 * It was `0.020234` km², which is *five* acres, while `merge.ts` has extracted at **one** since the
 * lanes were unified. So the census this file produces described a set 2.6× smaller than the one the
 * pipeline actually reads — 53,130 rows against the merge's 138,555 — and the merge printed the two
 * side by side as though they were comparable:
 *
 * ```
 * nhdId: 138,555/138,555 accepted
 *     census expected 53,130 post-floor rows, 40,928 distinct
 * ```
 *
 * The acceptance *rate* was still asserted correctly, so nothing broke; what was lost is the census's
 * actual job. It exists as a tripwire for "the source changed shape", and a tripwire strung across a
 * different set cannot detect that.
 *
 * This is the very drift `extract.ts` was created to end, and its docstring names this exact pair —
 * *"`merge.ts` extracts NHD at the one-acre floor while the standalone reconciler exported at five
 * acres"* — while this file went on restating the number locally. So it now imports it.
 */
const FLOOR_SQKM = ONE_ACRE_SQ_KM;

/**
 * How much of a *present, non-sentinel* identifier we require to parse.
 *
 * 98% rather than 100% so a handful of genuinely odd rows in a 53,000-row archive does not block a
 * campaign — but high enough that the historical failure (15.6% accepted) is nowhere near it. This is
 * a claim about the data; `NHD_ID_CENSUS` is the measurement behind it.
 */
const MIN_ID_ACCEPTANCE = 0.98;

function log(message: string): void {
  process.stderr.write(`[audit] ${message}\n`);
}

interface Row {
  pid: string;
  gnis: string;
  name: string;
  area: number;
}

/** Read one state's post-floor waterbodies out of the archived geodatabase, as CSV via ogr2ogr. */
function readState(state: string): Row[] {
  const key = nhdArchiveKey({ state, slug: '', expectedBytes: 0 });
  const manifestPath = join(NHD_DIR, key, 'manifest.json');
  if (!existsSync(manifestPath))
    throw new Error(`${state}: no archive — run \`archive-nhd\` first`);
  const { filename } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { filename: string };
  const zip = join(NHD_DIR, key, filename);

  const out = spawnSync(
    'ogr2ogr',
    [
      '-f',
      'CSV',
      '/vsistdout/',
      `/vsizip/${zip}`,
      'NHDWaterbody',
      '-select',
      'permanent_identifier,gnis_id,gnis_name,areasqkm',
      '-where',
      `areasqkm >= ${FLOOR_SQKM}`,
    ],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  if (out.status !== 0) throw new Error(`${state}: ogr2ogr exited ${out.status}`);

  const lines = (out.stdout ?? '').split('\n');
  const header = (lines[0] ?? '').split(',').map((h) => h.replace(/"/g, '').trim());
  const at = (n: string) => header.indexOf(n);
  const rows: Row[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    // The only quoted fields here are the id and the name; a lake name can contain a comma.
    const cells = line.match(/("([^"]*)"|[^,]*)/g)?.filter((_, i) => i % 2 === 0) ?? [];
    const cell = (i: number) => (cells[i] ?? '').replace(/^"|"$/g, '');
    const area = Number(cell(at('areasqkm')));
    if (!Number.isFinite(area)) continue;
    rows.push({
      pid: cell(at('permanent_identifier')),
      gnis: cell(at('gnis_id')),
      name: cell(at('gnis_name')),
      area,
    });
  }
  return rows;
}

async function main(): Promise<void> {
  const campaignId = process.argv
    .slice(2)
    .find((a) => a.startsWith('--campaign='))
    ?.split('=')[1];
  const logger = new RunLogger({
    kind: 'raw_archive',
    label: 'archive audit (identifiers, duplicates, conflicts)',
    campaignId,
    target: resolveDeployment(),
    call: convexRun,
    notes: [
      'Read-only. Re-derives every identifier rule from the archives and asserts it against the census stored beside the rule.',
    ],
  });
  logger.start();

  try {
    const nhdIds = new DropLedger('nhdId');
    const gnisIds = new DropLedger('gnisId');
    /** pid → every (state, area) that carries it, for the duplicate/conflict checks. */
    const byPid = new Map<string, { state: string; area: number; name: string }[]>();
    /** gnis → distinct pids, for the fan-out measure. */
    const byGnis = new Map<string, Set<string>>();
    let rowCount = 0;

    for (const source of NHD_SOURCES) {
      const rows = readState(source.state);
      rowCount += rows.length;
      log(`${source.state}: ${rows.length.toLocaleString()} post-floor rows`);
      for (const row of rows) {
        const id = nhdIds.normalize(row.pid, (raw) => normalizeNhdId(raw as string));
        const g = gnisIds.normalize(row.gnis, (raw) => normalizeGnisId(raw as string));
        if (id.ok) {
          const list = byPid.get(id.value) ?? [];
          list.push({ state: source.state, area: row.area, name: row.name });
          byPid.set(id.value, list);
          if (g.ok)
            (byGnis.get(g.value) ?? byGnis.set(g.value, new Set()).get(g.value))?.add(id.value);
        }
      }
    }

    log(formatLedger(nhdIds.report()));
    log(formatLedger(gnisIds.report()));

    // (1) The rules must still fit the archives. This is the check that would have caught the
    //     GUID-only rule at 15.6% instead of letting it ship.
    expectAcceptance(nhdIds.report(), MIN_ID_ACCEPTANCE);
    expectAcceptance(gnisIds.report(), MIN_ID_ACCEPTANCE);

    // (2)+(3) Duplicates: overlap between state files is expected; a repeat inside one file is not,
    //     and a shared id whose copies disagree on area would make dedup a coin flip.
    let crossFile = 0;
    let sameFile = 0;
    const disagreements: string[] = [];
    for (const [pid, entries] of byPid) {
      if (entries.length < 2) continue;
      const states = new Set(entries.map((e) => e.state));
      if (states.size === entries.length) crossFile++;
      else sameFile++;
      if (new Set(entries.map((e) => Math.round(e.area * 1e6))).size > 1) {
        if (disagreements.length < 5) {
          disagreements.push(`${pid} (${entries.map((e) => `${e.state}:${e.area}`).join(' vs ')})`);
        }
      }
    }
    log(`distinct nhdIds ${byPid.size.toLocaleString()} from ${rowCount.toLocaleString()} rows`);
    log(`  duplicated across state files (expected overlap): ${crossFile.toLocaleString()}`);
    log(`  duplicated within a single file (a conflict):     ${sameFile.toLocaleString()}`);

    if (disagreements.length > 0) {
      throw new Error(
        `${disagreements.length}+ shared permanent_identifiers carry DIFFERENT areas — dedup would ` +
          `silently pick one at random: ${disagreements.join('; ')}`,
      );
    }
    if (sameFile > 0) {
      throw new Error(
        `${sameFile} permanent_identifier(s) appear twice inside ONE state geodatabase. That is a ` +
          'real duplicate rather than the known cross-file overlap, and reconciliation would key ' +
          'two rows to one lake.',
      );
    }

    // (4) 3DHP's primary key.
    let dhpRows = 0;
    let dhpDistinct = 0;
    const clipManifest = join(CLIP_DIR, 'manifest.json');
    if (existsSync(clipManifest)) {
      const { filename } = JSON.parse(readFileSync(clipManifest, 'utf8')) as { filename: string };
      const gpkg = join(CLIP_DIR, filename);
      if (existsSync(gpkg)) {
        const res = spawnSync(
          'ogrinfo',
          [
            '-q',
            '-sql',
            `SELECT COUNT(*) AS n, COUNT(DISTINCT id3dhp) AS d FROM ${THREE_DHP_WATERBODY_LAYER}`,
            gpkg,
          ],
          { encoding: 'utf8' },
        );
        const nums = [...(res.stdout ?? '').matchAll(/=\s*(\d+)/g)].map((m) => Number(m[1]));
        [dhpRows = 0, dhpDistinct = 0] = nums;
        log(
          `3DHP: ${dhpRows.toLocaleString()} rows, ${dhpDistinct.toLocaleString()} distinct id3dhp`,
        );
        if (dhpRows !== dhpDistinct) {
          throw new Error(
            `id3dhp is not unique: ${dhpRows - dhpDistinct} duplicate(s). It is 3DHP's primary key ` +
              'and the divergence monitor joins on it.',
          );
        }
      }
    } else {
      log('3DHP clip absent — skipping its checks (run `archive-3dhp`)');
    }

    // (5) GNIS fan-out: measured, not asserted. It is why GNIS proposes and polygonIoU adjudicates.
    const fanout = [...byGnis.values()].filter((s) => s.size > 1).length;
    log(
      `GNIS: ${byGnis.size.toLocaleString()} distinct ids · ${fanout.toLocaleString()} resolve to >1 body (${((100 * fanout) / Math.max(byGnis.size, 1)).toFixed(1)}%)`,
    );

    for (const c of [...nhdIds.counts_(), ...gnisIds.counts_()]) logger.count(c.name, c.value);
    logger.count('nhdIds.distinct', byPid.size);
    logger.count('nhdIds.duplicatedAcrossStates', crossFile);
    logger.count('gnis.distinct', byGnis.size);
    logger.count('gnis.multiBody', fanout);
    if (dhpRows) logger.count('threeDhp.rows', dhpRows);

    // Drift against the stored census is a warning, not a failure: a new annual release legitimately
    // changes these numbers. The FAILURE condition is the acceptance floor above, which is about the
    // rule fitting the data rather than about the data being identical to last year.
    if (rowCount !== NHD_ID_CENSUS.postFloorRows) {
      log(
        `! post-floor row count moved: ${rowCount.toLocaleString()} vs census ${NHD_ID_CENSUS.postFloorRows.toLocaleString()} — update NHD_ID_CENSUS if this is a new release`,
      );
    }
    if (gnisIds.report().byReason.sentinel !== GNIS_ID_CENSUS.sentinel) {
      log(
        `! GNIS sentinel count moved: ${gnisIds.report().byReason.sentinel} vs census ${GNIS_ID_CENSUS.sentinel}`,
      );
    }

    log('✓ archives audit clean');
    logger.succeed();
  } catch (err) {
    logger.fail({
      stage: 'audit',
      key: 'archives',
      reason: err instanceof Error ? err.message : String(err),
    });
    logger.failed(err);
    throw err;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[audit] FAILED: ${(error as Error).message}\n`);
  process.exit(1);
});
