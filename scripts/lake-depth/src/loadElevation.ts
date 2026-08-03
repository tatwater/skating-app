/**
 * Elevation loader (glue) — N6c Workstream A1.
 *
 * Walks the corpus through `waterBodies.listNeedingElevation`, looks each page up against the
 * Open-Meteo Elevation API 100 coordinates at a time, and writes the results back through
 * `waterBodies.importElevations`. Loads the **dev** deployment by default; refuses a non-dev target
 * unless `--prod` is passed, matching the other three loaders.
 *
 *   pnpm --filter @skating/lake-depth load-elevation [--prod] [--refresh] [--limit=N]
 *
 * **Resumable by construction, and that is not incidental.** The server-side query skips rows that
 * already carry a reading, so an interrupted run continues where it stopped rather than restarting
 * a 116,070-body pass — and re-running it is a cheap no-op. `--refresh` re-reads rows that already
 * have one (for the day the DEM changes); it is not the normal path. An `operator` elevation is
 * never returned and never overwritten (D68's precedence rule, re-checked at write time because the
 * read and the write are separate transactions).
 *
 * All real logic lives in `./elevation` (tested) and in the two Convex functions (tested); this is
 * subprocess + loop, and is excluded from coverage.
 */

import process from 'node:process';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import {
  batchTargets,
  ELEVATION_REQUEST_DELAY_MS,
  type ElevationRecord,
  type ElevationTarget,
  fetchElevationBatch,
  sleep,
} from './elevation';

/** Rows written per mutation. Two small scalars per row, so the read cap binds long before bytes. */
const WRITE_BATCH_SIZE = 200;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowNonDev = args.includes('--prod');
  const refresh = args.includes('--refresh');
  const limit = Number(args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length));
  const campaignId = args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length);
  /**
   * `--import-floor` — only look up bodies the canonical import keeps (`meetsAreaFloor`).
   *
   * Open-Meteo's free tier counts each **coordinate**, not each request, so batching at 100 saves
   * HTTP overhead and no quota at all: the whole corpus is ~116,070 calls against a 10,000/day
   * allowance, or about twelve days. Restricting to what survives the floor is a fraction of that —
   * and it is the *correct* set regardless of quota, because `pruneBelowAreaFloor` deletes the rest.
   *
   * **A switch, not a number.** It was briefly `--min-area-acres=N`, which meant this file carried
   * its own copy of the rule — and the rule changed under it the same day. The server now applies
   * `meetsAreaFloor` directly, so "the current floor" is true by construction rather than by
   * somebody remembering to update two places.
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
  if (importFloorOnly) {
    process.stderr.write(
      '[elevation] floor: only bodies the canonical import keeps (meetsAreaFloor)\n',
    );
  }
  if (refresh) {
    process.stderr.write(
      '[elevation] --refresh: re-reading bodies that already carry a DEM elevation.\n',
    );
  }

  // Run history (N6c F2). Opened before the first page so a killed pass still leaves a record.
  const logger = new RunLogger({
    kind: 'elevation',
    label: refresh ? 'elevation (refresh)' : 'elevation',
    campaignId,
    target,
    call: convexRun,
    stages: [
      {
        name: 'lookup',
        detail:
          'Open-Meteo Elevation API — free and keyless, batched at exactly 100 coordinates per request (its hard cap)',
        sourceUrl: 'https://open-meteo.com/en/docs/elevation-api',
      },
      {
        name: 'write',
        detail:
          "waterBodies:importElevations — D68 precedence re-checked at write time, so a moderator's override is never overwritten",
        output: target.label,
      },
    ],
  });
  logger.start();

  const totals = {
    scanned: 0,
    looked: 0,
    updated: 0,
    operatorHeld: 0,
    implausible: 0,
    missing: 0,
    /** Walked past deliberately by `--import-floor`, so a filtered run isn't read as a failure. */
    belowFloor: 0,
  };
  let cursor: string | undefined;
  let isDone = false;
  let pages = 0;

  try {
    while (!isDone) {
      const page = convexRun<{
        targets: ElevationTarget[];
        scanned: number;
        belowFloor?: number;
        cursor: string;
        isDone: boolean;
      }>('waterBodies:listNeedingElevation', {
        ...(cursor ? { cursor } : {}),
        ...(refresh ? { refresh: true } : {}),
        ...(importFloorOnly ? { importFloorOnly: true } : {}),
      });
      cursor = page.cursor;
      isDone = page.isDone;
      totals.scanned += page.scanned;
      totals.belowFloor += page.belowFloor ?? 0;
      pages++;

      const records: ElevationRecord[] = [];
      for (const batch of batchTargets(page.targets)) {
        const { records: got, implausible } = await fetchElevationBatch(batch);
        records.push(...got);
        totals.implausible += implausible;
        totals.looked += batch.length;
        await sleep(ELEVATION_REQUEST_DELAY_MS);
      }

      for (let i = 0; i < records.length; i += WRITE_BATCH_SIZE) {
        const result = convexRun<{
          updated: number;
          operatorHeld: number;
          implausible: number;
          missing: number;
        }>('waterBodies:importElevations', { elevations: records.slice(i, i + WRITE_BATCH_SIZE) });
        totals.updated += result.updated;
        totals.operatorHeld += result.operatorHeld;
        totals.implausible += result.implausible;
        totals.missing += result.missing;
      }

      process.stderr.write(
        `[elevation] page ${pages}: scanned ${totals.scanned}, looked up ${totals.looked}, wrote ${totals.updated}\n`,
      );
      for (const [name, value] of Object.entries(totals)) logger.count(name, value);
      logger.count('pages', pages);
      logger.flush();

      if (Number.isFinite(limit) && totals.looked >= limit) {
        process.stderr.write(`[elevation] stopping early at --limit=${limit}\n`);
        // A bounded run must say it was bounded — a `--limit` pass and a complete one produce the
        // same-shaped row, and only this note distinguishes them once the terminal is gone.
        logger.stage({
          name: 'lookup',
          detail: `stopped early at --limit=${limit} — this run did NOT cover the corpus`,
        });
        break;
      }
    }
  } catch (err) {
    logger.failed(err);
    throw err;
  }

  // A coverage RATE, not a count, for the same reason the depth loader prints one: a pass that
  // stamped 60% of what it scanned reads exactly like a complete one if you only print totals.
  // **The denominator is the bodies in scope, not the bodies scanned.** With `--import-floor` the
  // pass deliberately walks past most of the corpus, and dividing by everything it *looked at*
  // reports a 14% success rate for a run that covered 100% of its target. That is the same
  // misleading-denominator shape the depth join's coverage block was rebuilt to avoid; it does not
  // get to reappear here just because this loader prints rather than stores.
  const inScope = Math.max(0, totals.scanned - totals.belowFloor);
  const rate = inScope > 0 ? ((totals.updated / inScope) * 100).toFixed(1) : '0.0';
  process.stderr.write(
    `[elevation] complete: ${totals.updated}/${inScope} in-scope bodies stamped (${rate}%) over ${pages} page(s)\n`,
  );
  if (totals.belowFloor > 0) {
    process.stderr.write(
      `[elevation] ${totals.belowFloor} body(s) walked past below the import floor — not failures, ` +
        'not eligible, and about to be removed by the canonical re-import\n',
    );
  }
  // The numbers that are expected to be non-zero and wrong if LARGE — and none of which is visible
  // from the rate alone, which is the shape of every silent-cap bug this repo has hit before.
  process.stderr.write(
    `[elevation] of those: ${totals.operatorHeld} held by a moderator's override · ` +
      `${totals.implausible} readings outside the plausible window · ` +
      `${totals.missing} rows vanished mid-pass\n`,
  );

  for (const [name, value] of Object.entries(totals)) logger.count(name, value);
  logger.count('pages', pages);
  logger.stage({
    name: 'write',
    detail:
      "waterBodies:importElevations — D68 precedence re-checked at write time, so a moderator's override is never overwritten",
    output: target.label,
    counts: [
      { name: 'updated', value: totals.updated },
      { name: 'operatorHeld', value: totals.operatorHeld },
      { name: 'implausible', value: totals.implausible },
      { name: 'missing', value: totals.missing },
    ],
  });
  logger.coverage({
    unit: 'bodies',
    eligible: inScope,
    covered: totals.updated,
    omissions: [
      { reason: "held by a moderator's override (D68)", count: totals.operatorHeld },
      { reason: 'reading outside the plausible window', count: totals.implausible },
      { reason: 'row vanished mid-pass', count: totals.missing },
      // Everything scanned but never looked up — the shape a silent cap takes.
      { reason: 'scanned but never looked up', count: Math.max(0, totals.scanned - totals.looked) },
    ].filter((o) => o.count > 0),
  });
  logger.succeed([
    `coverage: ${totals.updated}/${inScope} in-scope bodies stamped (${rate}%)`,
    ...(totals.belowFloor > 0
      ? [`${totals.belowFloor} walked past below the canonical import floor (meetsAreaFloor)`]
      : []),
  ]);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[elevation] FAILED: ${err instanceof Error ? err.message : String(err)}\n` +
      '[elevation] Re-running is safe and resumes: rows already stamped are skipped server-side.\n',
  );
  process.exit(1);
});
