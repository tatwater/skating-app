/**
 * Elevation loader (glue) — **reads the 3DEP archive, not a metered API** (D127, N7-3).
 *
 *   pnpm --filter @skating/lake-depth load-elevation --compare        # D101, and run this FIRST
 *   pnpm --filter @skating/lake-depth load-elevation [--import-floor] [--campaign=<id>] [--prod]
 *
 * ## What changed, and why the old lane is gone rather than kept as a fallback
 *
 * This used to walk the corpus against Open-Meteo's elevation endpoint, 100 coordinates per request
 * against a free tier that counts each **coordinate** — about twelve days of allowance for one pass,
 * shared with the product's own weather crons, and it stopped on a daily quota at page 86 of ~248.
 * D127 replaced it with **USGS 3DEP** (`epqs.nationalmap.gov`): no key, no shared quota, 25,044
 * readings in ~1.5 hours, and **98.2% of them at 1 m LiDAR** against GLO-90's 90 m.
 *
 * That archive is on disk and mirrored. So this file is now a **reader**, and the fetching half
 * lives in `snapshotElevation.ts` — the same split the wind lane is being rebuilt to have, and for
 * the same reason: after the one fetch, changing anything downstream costs minutes.
 *
 * **The Open-Meteo module was deleted rather than left in place.** A fetcher nothing calls is the
 * mirror of the finding that started this campaign — an archive nothing reads is not a source — and
 * keeping a second, worse elevation path around invites somebody to run it.
 *
 * ## `--compare` exists because D101 asked for it, and it is easy to skip
 *
 * *"A source swap that silently changes a datum would move every decile in `regionStats` and look
 * like a data-quality improvement."* 5,692 rows are already stamped `dem_glo90`. So the first thing
 * to do is not to load: it is to read the signed deltas against those rows and decide what they say.
 * **A one-sided distribution is a datum shift. A two-sided one is an accuracy improvement.**
 * `--compare` writes nothing and exits non-zero on nothing; it prints and stops.
 *
 * All real logic lives in `./elevationArchive` and `./epqs` (both tested) and in the two Convex
 * functions (tested); this is subprocess + loop, and is excluded from coverage.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import { type ElevationArchiveEntry, elevationDeltas, resolutionBands } from './elevationArchive';
import { coordinateKey } from './epqs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHIVE = resolve(HERE, '../.raw-elevation/readings.ndjson');

/** Rows written per mutation. Four small scalars per row, so the read cap binds long before bytes. */
const WRITE_BATCH_SIZE = 200;

/** Targets named on the run row when the archive cannot answer them. Enough to chase, not to bury. */
const MISSING_SAMPLE_CAP = 10;

/**
 * Delta bands for `--compare`, in metres.
 *
 * Chosen against what the two sources *are* rather than by taste: GLO-90 is a 90 m posting, so a
 * lake surface read off it is routinely a few metres from a 1 m LiDAR reading of the same point
 * with no datum shift involved at all. The question the bands have to answer is whether the
 * disagreement is **centred on zero**.
 */
const DELTA_BANDS = [1, 3, 10, 30] as const;

interface Target {
  waterBodyId: string;
  lat: number;
  lng: number;
  storedElevationM?: number;
  storedSource?: string;
}

function readArchive(): Map<string, ElevationArchiveEntry> {
  if (!existsSync(ARCHIVE)) {
    throw new Error(
      `no 3DEP archive at ${ARCHIVE}. Run \`pnpm --filter @skating/lake-depth snapshot-elevation\`, ` +
        'or pull the mirrored copy with `scripts/lake-depth/mirror-elevation-r2.sh pull`. This ' +
        'loader deliberately cannot fetch: a reader that quietly hits the network is how an archive ' +
        'stops being the source of truth.',
    );
  }
  const byKey = new Map<string, ElevationArchiveEntry>();
  for (const [index, line] of readFileSync(ARCHIVE, 'utf8').split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let entry: ElevationArchiveEntry;
    try {
      entry = JSON.parse(trimmed) as ElevationArchiveEntry;
    } catch {
      throw new Error(
        `3DEP archive: line ${index + 1} is not JSON — a truncated or half-written file. Re-pull it ` +
          'from the mirror rather than loading what survived.',
      );
    }
    byKey.set(entry.key, entry);
  }
  return byKey;
}

/** Every page of the corpus this pass is in scope for. */
function* pages(
  refresh: boolean,
  importFloorOnly: boolean,
): Generator<{
  targets: Target[];
  scanned: number;
  belowFloor: number;
}> {
  let cursor: string | undefined;
  for (;;) {
    const page = convexRun<{
      targets: Target[];
      scanned: number;
      belowFloor?: number;
      cursor: string;
      isDone: boolean;
    }>('waterBodies:listNeedingElevation', {
      ...(cursor ? { cursor } : {}),
      ...(refresh ? { refresh: true } : {}),
      ...(importFloorOnly ? { importFloorOnly: true } : {}),
    });
    yield { targets: page.targets, scanned: page.scanned, belowFloor: page.belowFloor ?? 0 };
    if (page.isDone) return;
    cursor = page.cursor;
  }
}

/** D101's comparison: what the swap does to the rows already stamped. Writes nothing. */
function compare(archive: Map<string, ElevationArchiveEntry>, importFloorOnly: boolean): void {
  const stored: { elevationM: number; lat: number; lng: number; source: string }[] = [];
  let scanned = 0;
  // `refresh` so bodies that already carry a reading are returned — they are the whole subject.
  for (const page of pages(true, importFloorOnly)) {
    scanned += page.scanned;
    for (const t of page.targets) {
      if (t.storedElevationM === undefined) continue;
      stored.push({
        elevationM: t.storedElevationM,
        lat: t.lat,
        lng: t.lng,
        source: t.storedSource ?? 'unknown',
      });
    }
    process.stderr.write(
      `[elevation] compare: scanned ${scanned}, ${stored.length} stamped rows\n`,
    );
  }

  const deltas = elevationDeltas(stored, archive, coordinateKey);
  if (deltas.length === 0) {
    process.stderr.write(
      '[elevation] compare: NOTHING COMPARABLE. Either no row carries an elevation yet, or no ' +
        'stored coordinate resolves to an archived key — check the second before believing the ' +
        'first, because a key mismatch produces exactly this output and looks like a clean result.\n',
    );
    return;
  }

  const signed = deltas.map((d) => d.deltaM).sort((a, b) => a - b);
  const at = (q: number) => signed[Math.min(signed.length - 1, Math.floor(signed.length * q))] ?? 0;
  const mean = signed.reduce((a, b) => a + b, 0) / signed.length;
  const above = signed.filter((d) => d > 0).length;

  process.stderr.write(
    `\n[elevation] ── D101 datum comparison: 3DEP minus stored, over ${signed.length} bodies ──\n` +
      `  mean ${mean.toFixed(2)} m · median ${at(0.5).toFixed(2)} m\n` +
      `  p05 ${at(0.05).toFixed(2)} · p25 ${at(0.25).toFixed(2)} · p75 ${at(0.75).toFixed(2)} · ` +
      `p95 ${at(0.95).toFixed(2)} m\n` +
      `  ${above} of ${signed.length} (${((above / signed.length) * 100).toFixed(1)}%) read HIGHER on 3DEP\n`,
  );
  for (const band of DELTA_BANDS) {
    const within = signed.filter((d) => Math.abs(d) <= band).length;
    process.stderr.write(
      `  |Δ| ≤ ${String(band).padStart(2)} m: ${String(within).padStart(6)} ` +
        `(${((within / signed.length) * 100).toFixed(1)}%)\n`,
    );
  }
  process.stderr.write(
    '\n  Read it this way: a distribution centred near zero with both tails is GLO-90 being coarse,\n' +
      '  which is an accuracy improvement. A distribution displaced off zero — most bodies moving\n' +
      '  the same way by a similar amount — is a DATUM shift, and every `regionStats` decile moves\n' +
      '  with it. Do not load until this reads as the first one.\n\n',
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowNonDev = args.includes('--prod');
  const refresh = args.includes('--refresh');
  const comparing = args.includes('--compare');
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);
  /**
   * `--import-floor` — only stamp bodies the canonical import keeps (`belongsInCorpus`).
   *
   * **Quota is no longer the argument**, since the archive is local and free to read. Correctness
   * is: `pruneBelowAreaFloor` deletes the rest, so stamping them writes rows about to be removed.
   * A switch rather than a threshold, because a threshold here is a second copy of a rule that has
   * already drifted once — see the server-side note on `listNeedingElevation`.
   */
  const importFloorOnly = args.includes('--import-floor');

  const target = resolveDeployment();
  process.stderr.write(`[elevation] target deployment: ${target.label}\n`);
  if (!target.isDev && !allowNonDev) {
    process.stderr.write(
      '[elevation] refusing: target is not a dev deployment. Confirm, then re-run with --prod.\n',
    );
    process.exit(1);
  }

  const archive = readArchive();
  process.stderr.write(
    `[elevation] archive: ${archive.size.toLocaleString()} 3DEP readings · ` +
      `${JSON.stringify(resolutionBands([...archive.values()]))}\n`,
  );

  if (comparing) {
    compare(archive, importFloorOnly);
    return;
  }

  const logger = new RunLogger({
    kind: 'elevation',
    label: refresh ? '3DEP elevation (refresh)' : '3DEP elevation',
    campaignId,
    target,
    call: convexRun,
    stages: [
      {
        name: 'archive · read',
        detail:
          `${archive.size} USGS 3DEP readings from .raw-elevation/readings.ndjson — no network. ` +
          'Public domain (17 U.S.C. § 105).',
        sourceUrl: 'https://epqs.nationalmap.gov/v1/json',
      },
      {
        name: 'write',
        detail:
          'waterBodies:importElevations at the `dem_3dep` rung — D68 precedence re-checked at write ' +
          'time, so a moderator override is never overwritten, and the raster id travels with the ' +
          'reading so a coarse cohort can be re-stamped later (D104).',
        output: target.label,
      },
    ],
  });
  logger.start();

  const totals = {
    scanned: 0,
    /**
     * In-scope bodies this pass found **without** an elevation — the work it set out to do.
     *
     * Counted because it is the only honest denominator for an incremental pass, and its absence was
     * actively misleading: see the rate below.
     */
    targets: 0,
    inArchive: 0,
    notInArchive: 0,
    updated: 0,
    operatorHeld: 0,
    implausible: 0,
    missing: 0,
    /** Walked past deliberately by `--import-floor`, so a filtered run isn't read as a failure. */
    belowFloor: 0,
  };
  const missingSamples: string[] = [];
  let pageCount = 0;

  try {
    for (const page of pages(refresh, importFloorOnly)) {
      totals.scanned += page.scanned;
      totals.belowFloor += page.belowFloor;
      pageCount++;

      totals.targets += page.targets.length;

      const records: {
        waterBodyId: string;
        elevationM: number;
        resolutionM?: number;
        rasterId?: number;
      }[] = [];
      for (const t of page.targets) {
        const entry = archive.get(coordinateKey(t.lat, t.lng));
        if (entry === undefined) {
          totals.notInArchive++;
          if (missingSamples.length < MISSING_SAMPLE_CAP) {
            missingSamples.push(`${t.waterBodyId} @ ${coordinateKey(t.lat, t.lng)}`);
          }
          continue;
        }
        totals.inArchive++;
        records.push({
          waterBodyId: t.waterBodyId,
          elevationM: entry.elevationM,
          ...(entry.resolutionM !== undefined ? { resolutionM: entry.resolutionM } : {}),
          ...(entry.rasterId !== undefined ? { rasterId: entry.rasterId } : {}),
        });
      }

      for (let i = 0; i < records.length; i += WRITE_BATCH_SIZE) {
        const result = convexRun<{
          updated: number;
          operatorHeld: number;
          implausible: number;
          missing: number;
        }>('waterBodies:importElevations', {
          elevations: records.slice(i, i + WRITE_BATCH_SIZE),
          source: 'dem_3dep',
        });
        totals.updated += result.updated;
        totals.operatorHeld += result.operatorHeld;
        totals.implausible += result.implausible;
        totals.missing += result.missing;
      }

      process.stderr.write(
        `[elevation] page ${pageCount}: scanned ${totals.scanned}, ` +
          `resolved ${totals.inArchive}, wrote ${totals.updated}\n`,
      );
      for (const [name, value] of Object.entries(totals)) logger.count(name, value);
      logger.count('pages', pageCount);
      logger.flush();
    }
  } catch (err) {
    logger.failed(err);
    throw err;
  }

  // A coverage RATE, not a count, and **the denominator is the bodies in scope** — with
  // `--import-floor` the pass deliberately walks past most of the corpus, and dividing by
  // everything it scanned reports a 14% success rate for a run that covered 100% of its target.
  const inScope = Math.max(0, totals.scanned - totals.belowFloor);

  /**
   * ⚠ **Two numbers, because "how did this run do" and "how covered is the corpus" are different
   * questions and one denominator cannot answer both.**
   *
   * This printed `updated / inScope` — which is right for the *first* pass over a fresh region and
   * wrong for every pass after it. An incremental run finds a handful of gaps, fills all of them,
   * and reports **`4/24839 stamped (0.0%)`**: a total success rendered as a total failure. Seen on
   * 2026-08-26, and the danger is not the cosmetics — it is that the line a person checks after
   * importing a new region cannot distinguish "nothing needed doing" from "nothing worked".
   *
   * So: the *rate* is against what the pass actually set out to do, and the number that matters for
   * a new region — **how many in-scope bodies still have no elevation** — is stated outright rather
   * than left to be inferred from a percentage.
   */
  const residual = Math.max(0, totals.targets - totals.updated);
  const rate = totals.targets > 0 ? ((totals.updated / totals.targets) * 100).toFixed(1) : '100.0';
  process.stderr.write(
    `[elevation] complete: ${totals.updated}/${totals.targets} gaps filled (${rate}%) over ` +
      `${pageCount} page(s), ${inScope} in-scope bodies scanned\n` +
      `[elevation] still without elevation: ${residual}` +
      (residual > 0
        ? ` — ${totals.notInArchive} not in the archive · ` +
          `${totals.implausible} outside the plausible window · ${totals.missing} rows gone\n`
        : '\n') +
      `[elevation] ${totals.operatorHeld} left alone: a moderator's value, which is not a gap\n`,
  );
  if (totals.notInArchive > 0) {
    // **The archive is keyed on the interior point, and the corpus moves.** A body re-drawn by a
    // later merge gets a new interior point and therefore a new key, so this number is the corpus
    // having changed under the archive rather than 3DEP having failed. Re-run `snapshot-elevation`
    // to fill them; it is incremental and asks only for what is missing.
    process.stderr.write(
      `[elevation] ${totals.notInArchive} target(s) the archive cannot answer — re-run ` +
        'snapshot-elevation, which fetches only the difference. e.g. ' +
        `${missingSamples.join(', ')}\n`,
    );
  }

  /**
   * ⚠ **Coverage is a claim about the corpus, so `covered` counts bodies that HAVE an elevation —
   * not bodies this run wrote one to.**
   *
   * `covered: totals.updated` made an incremental pass report 4 of 24,839 covered, which as a
   * corpus statement is off by four orders of magnitude and lands in the admin's coverage history
   * as a catastrophic regression. Everything in scope that this pass did not have to touch was
   * already covered — that is what "did not have to touch" means.
   *
   * ⚠ **And a moderator's override is not an omission.** It was listed as one, which was wrong on
   * the facts, not just on the framing: there is no path in the schema that produces `operator`
   * provenance *without* a number — `importElevations` requires `elevationM` and refuses the
   * operator rung outright, the merge only inherits `elevationSource` alongside a defined
   * `elevationM`, and no mutation sets elevation from the editor at all. So an operator-held row
   * has a value by construction; counting it as missing inflated the gap with rows that are not
   * merely fine but *better* than what this pass would have written.
   */
  logger.coverage({
    unit: 'bodies',
    eligible: inScope,
    covered: Math.max(0, inScope - residual),
    omissions: [
      { reason: 'not in the 3DEP archive', count: totals.notInArchive },
      { reason: 'outside the plausible window', count: totals.implausible },
      { reason: 'row deleted mid-pass', count: totals.missing },
    ].filter((o) => o.count > 0),
  });
  logger.succeed([
    `${totals.updated} bodies stamped from USGS 3DEP`,
    ...(missingSamples.length > 0 ? [`unanswered keys: ${missingSamples.join(', ')}`] : []),
  ]);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[elevation] FAILED: ${err instanceof Error ? err.message : String(err)}\n` +
      '[elevation] Re-running is safe and resumes: stamped rows are skipped server-side.\n',
  );
  process.exit(1);
});
