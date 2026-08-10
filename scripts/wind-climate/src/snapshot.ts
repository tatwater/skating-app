/**
 * **Fetch once, archive forever** — the expensive half of the wind lane (N7-3).
 *
 *   pnpm --filter @skating/wind-climate snapshot --dry-run     # scope only, no requests
 *   pnpm --filter @skating/wind-climate snapshot [--import-floor] [--limit=N] [--campaign=<id>]
 *
 * Qualifies bodies, folds them onto the WIND Toolkit's native 2 km grid, and writes **one gzipped
 * file per response** under `.raw/<gridKey>/<year>.csv.gz` with a manifest per cell. It computes
 * nothing: `derive` does that, from the archive, offline, in minutes.
 *
 * ## Why the split is the whole point
 *
 * The previous loader fetched and computed in one pass, which meant the only artifact of 5,225
 * requests was sixteen normalised frequencies per body. It had also been requesting wind **speed**
 * on every one of those requests and discarding it — so adding sustained-wind capture, which should
 * have been a local recompute, became a second 7.7-hour fetch. See `archive.ts`.
 *
 * ## Resumable by construction, and this one has to be
 *
 * 7.7 hours is long enough that being interrupted is the expected case rather than the exception.
 * `missingResponses` diffs the wanted cell-years against what is on disk, so re-running the same
 * command continues; nothing is ever re-fetched, and a completed archive makes this a no-op.
 *
 * ⚠ **Never overwrites without `--refresh`.** The archive's value is that it does not change under
 * the transform being iterated on.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { WIND_ARCHIVE_MIN_FETCH_M } from '@skating/core';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import {
  type ArchivedResponse,
  type CellManifest,
  estimateFetchMinutes,
  formatBytes,
  manifestPath,
  missingResponses,
  redactApiKey,
  responsePath,
  WTK_LICENCE,
  WTK_MEASURED_LATENCY_MS,
} from './archive';
import {
  fetchCellYear,
  gridKey,
  pointForGridKey,
  sleep,
  WTK_REQUEST_DELAY_MS,
  WTK_YEARS,
  wtkUrl,
} from './wtk';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = resolve(HERE, '../.raw');

interface Target {
  waterBodyId: string;
  lat: number;
  lng: number;
}

/** Responses between manifest writes. A killed run should lose one cell's bookkeeping, not a day's. */
const CHECKPOINT_EVERY = 25;

function readEnvFile(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(url, 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match?.[1]) out[match[1]] = (match[2] ?? '').trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** Every response already on disk, as archive-relative paths. */
function archivedPaths(): Set<string> {
  const have = new Set<string>();
  if (!existsSync(RAW_DIR)) return have;
  for (const cell of readdirSync(RAW_DIR, { withFileTypes: true })) {
    if (!cell.isDirectory()) continue;
    for (const file of readdirSync(join(RAW_DIR, cell.name))) {
      if (file.endsWith('.csv.gz')) have.add(`${cell.name}/${file}`);
    }
  }
  return have;
}

function readManifest(gridKey_: string): CellManifest | undefined {
  const path = join(RAW_DIR, manifestPath(gridKey_));
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CellManifest;
  } catch {
    // A half-written manifest is bookkeeping, not data. The responses beside it are still valid, so
    // this rebuilds rather than refusing — the opposite call to a truncated NDJSON archive, because
    // there the file IS the data.
    return undefined;
  }
}

function writeManifest(manifest: CellManifest): void {
  mkdirSync(join(RAW_DIR, manifest.gridKey), { recursive: true });
  writeFileSync(
    join(RAW_DIR, manifestPath(manifest.gridKey)),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const refresh = args.includes('--refresh');
  const importFloorOnly = args.includes('--import-floor');
  const limit = Number(args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length));
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);

  const env = { ...readEnvFile(new URL('../.env.local', import.meta.url)), ...process.env };
  const apiKey = env.WIND_TOOLKIT_API_KEY;
  const email = env.WIND_TOOLKIT_EMAIL;
  if (!dryRun && (!apiKey || !email)) {
    process.stderr.write(
      '[wind] missing WIND_TOOLKIT_API_KEY / WIND_TOOLKIT_EMAIL.\n' +
        '[wind] cp .env.example .env.local and get a free key at https://developer.nlr.gov/signup/\n',
    );
    process.exit(1);
  }

  // ── Qualify, and fold onto the grid ────────────────────────────────────────
  //
  // **The dedupe is the affordability argument.** A rose is a property of a 2 km cell, not of a
  // lake, and the API snaps a requested point to its own grid anyway — so two lakes in one cell
  // would otherwise cost two requests for byte-identical data.
  const cells = new Map<string, Target[]>();
  let scanned = 0;
  let belowFloor = 0;
  let cursor: string | undefined;
  let isDone = false;
  while (!isDone) {
    const page = convexRun<{
      targets: Target[];
      scanned: number;
      belowFloor?: number;
      cursor: string;
      isDone: boolean;
    }>('waterBodies:listNeedingWindRose', {
      ...(cursor ? { cursor } : {}),
      // The archive is keyed on the cell, so "which bodies still lack a rose" is the wrong question
      // for a fetch — a cell already archived is skipped by `missingResponses` regardless.
      refresh: true,
      // **The same constant `derive` scopes itself with**, never a flag. See
      // `WIND_ARCHIVE_MIN_FETCH_M`: a fetch and a derive that disagree about scope produce a derive
      // that refuses on missing cells, or a coverage figure quoted over whatever happened to be
      // archived.
      minFetchM: WIND_ARCHIVE_MIN_FETCH_M,
      ...(importFloorOnly ? { importFloorOnly: true } : {}),
    });
    cursor = page.cursor;
    isDone = page.isDone;
    scanned += page.scanned;
    belowFloor += page.belowFloor ?? 0;
    for (const t of page.targets) {
      const key = gridKey(t);
      const bucket = cells.get(key);
      if (bucket) bucket.push(t);
      else cells.set(key, [t]);
    }
  }

  const bodies = [...cells.values()].reduce((n, list) => n + list.length, 0);
  const have = refresh ? new Set<string>() : archivedPaths();
  let wanted = missingResponses([...cells.keys()], WTK_YEARS, have);
  if (Number.isFinite(limit) && limit > 0) wanted = wanted.slice(0, limit);

  // **Estimated from a MEASURED latency, not from the pacing delay.** The old loader printed
  // "~96 min at 1/s" for a job that takes 7.7 hours, because it counted only the deliberate pause
  // and ignored the 5.3 s response.
  const minutes = estimateFetchMinutes(
    wanted.length,
    WTK_MEASURED_LATENCY_MS,
    WTK_REQUEST_DELAY_MS,
  );
  process.stderr.write(
    `[wind] ${scanned} bodies scanned · ${belowFloor} below the import floor · ` +
      `${bodies} qualify · ${cells.size} distinct 2 km cells\n` +
      `[wind] ${cells.size * WTK_YEARS.length} cell-years wanted · ${have.size} already archived · ` +
      `${wanted.length} to fetch\n` +
      `[wind] estimate ${minutes} min (${(minutes / 60).toFixed(1)} h) at a measured ` +
      `${(WTK_MEASURED_LATENCY_MS / 1000).toFixed(1)} s/request plus ${WTK_REQUEST_DELAY_MS} ms pacing\n`,
  );
  if (bodies > 0) {
    process.stderr.write(
      `[wind] the grid dedupe saves ${bodies * WTK_YEARS.length - cells.size * WTK_YEARS.length} requests\n`,
    );
  }
  if (dryRun) {
    process.stderr.write('[wind] --dry-run: no requests made, nothing written.\n');
    return;
  }
  if (wanted.length === 0) {
    process.stderr.write(
      '[wind] archive already complete for every qualifying cell. Nothing to do.\n',
    );
    return;
  }

  const logger = new RunLogger({
    kind: 'wind_climate',
    label: 'WTK response archive (snapshot)',
    campaignId,
    target: resolveDeployment(),
    call: convexRun,
    stages: [
      {
        name: 'qualify',
        detail:
          "bodies whose longest fetch clears the caption's floor, folded onto the WIND Toolkit's " +
          'native 2 km grid',
        counts: [
          { name: 'scanned', value: scanned },
          { name: 'qualified', value: bodies },
          { name: 'distinctCells', value: cells.size },
        ],
      },
      {
        name: 'fetch',
        detail:
          `NREL WIND Toolkit — ${WTK_YEARS.length} winters (${WTK_YEARS[0]}–${WTK_YEARS.at(-1)}) ` +
          'per cell. Direction AND speed, both archived byte-faithfully; nothing is computed here.',
        sourceUrl: 'https://developer.nlr.gov/api/wind-toolkit/',
      },
      { name: 'archive', detail: '.raw/<gridKey>/<year>.csv.gz + manifest.json', output: RAW_DIR },
    ],
  });
  logger.start();

  const totals = { fetched: 0, failed: 0, rawBytes: 0, gzipBytes: 0, rows: 0 };
  let consecutiveFailures = 0;
  /** Per cell, so a manifest is written whole rather than appended to under interruption. */
  const pending = new Map<string, CellManifest>();

  const flushManifests = () => {
    for (const manifest of pending.values()) writeManifest(manifest);
    pending.clear();
  };

  try {
    for (const [index, { gridKey: key, year }] of wanted.entries()) {
      const point = pointForGridKey(key);
      try {
        const csv = await fetchCellYear(point, year, apiKey as string, email as string);
        const raw = Buffer.from(csv, 'utf8');
        const gz = gzipSync(raw, { level: 9 });
        mkdirSync(join(RAW_DIR, key), { recursive: true });
        writeFileSync(join(RAW_DIR, responsePath(key, year)), gz);

        const response: ArchivedResponse = {
          gridKey: key,
          year,
          // Redacted: the manifest is the field most likely to be shared, and the resolved URL is
          // the most useful thing in it. Those two facts collide exactly here.
          url: redactApiKey(wtkUrl(point, year, apiKey as string, email as string)),
          fetchedAt: new Date().toISOString(),
          sha256: createHash('sha256').update(raw).digest('hex'),
          gzipBytes: gz.byteLength,
          rawBytes: raw.byteLength,
          // Two header lines before the data — a site-metadata row, then the column names.
          rows: Math.max(0, csv.split('\n').filter((l) => l.length > 0).length - 2),
        };
        totals.fetched++;
        totals.rawBytes += response.rawBytes;
        totals.gzipBytes += response.gzipBytes;
        totals.rows += response.rows;
        consecutiveFailures = 0;

        const manifest = pending.get(key) ??
          readManifest(key) ?? {
            gridKey: key,
            point,
            yearsRequested: [...WTK_YEARS],
            responses: [],
            archive: 'nrel-wind-toolkit' as const,
            licence: WTK_LICENCE,
            attributes: 'winddirection_10m,windspeed_10m',
          };
        manifest.responses = [...manifest.responses.filter((r) => r.year !== year), response].sort(
          (a, b) => a.year - b.year,
        );
        pending.set(key, manifest);
      } catch (err) {
        totals.failed++;
        consecutiveFailures++;
        const message = err instanceof Error ? err.message : String(err);
        logger.fail({ stage: 'fetch', key: `${key} ${year}`, reason: message });
        process.stderr.write(
          `[wind] ${key} ${year} FAILED (${consecutiveFailures} in a row): ${message}\n`,
        );
        // A streak is systemic — an expired key, a daily quota, the host moving again — and every
        // further request spends quota to learn the same thing. An isolated failure is one
        // cell-year, and `missingResponses` will offer it again on the next run.
        if (consecutiveFailures >= 10) {
          throw new Error(`10 consecutive fetch failures — last: ${message}`);
        }
      }

      if ((index + 1) % CHECKPOINT_EVERY === 0 || index === wanted.length - 1) {
        flushManifests();
        const done = index + 1;
        const left = estimateFetchMinutes(
          wanted.length - done,
          WTK_MEASURED_LATENCY_MS,
          WTK_REQUEST_DELAY_MS,
        );
        process.stderr.write(
          `[wind] ${done}/${wanted.length} · ${formatBytes(totals.gzipBytes)} archived · ` +
            `${totals.failed} failed · ~${left} min left\n`,
        );
        for (const [name, value] of Object.entries(totals)) logger.count(name, value);
        logger.flush();
      }
      await sleep(WTK_REQUEST_DELAY_MS);
    }
  } catch (err) {
    // Whatever landed is still worth keeping — that is the entire premise of an archive.
    flushManifests();
    logger.failed(err);
    throw err;
  }

  flushManifests();
  process.stderr.write(
    `[wind] archive: ${totals.fetched} responses · ${totals.rows.toLocaleString()} rows · ` +
      `${formatBytes(totals.gzipBytes)} gzipped (${formatBytes(totals.rawBytes)} raw)\n`,
  );
  logger.coverage({
    unit: 'cell-years',
    eligible: wanted.length,
    covered: totals.fetched,
    omissions: totals.failed > 0 ? [{ reason: 'fetch failed', count: totals.failed }] : [],
  });
  logger.succeed([
    `${totals.fetched} responses archived at ${RAW_DIR}`,
    'mirror with scripts/wind-climate/mirror-r2.sh push — THEN derive',
    'derive with: pnpm --filter @skating/wind-climate derive --campaign=<id>',
  ]);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[wind] SNAPSHOT FAILED: ${err instanceof Error ? err.message : String(err)}\n` +
      '[wind] Re-running is safe and resumes: archived responses are never re-fetched.\n',
  );
  process.exit(1);
});
