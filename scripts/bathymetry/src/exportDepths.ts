/**
 * Give `state_agency` a producer — the archives already on disk, as loadable depth (N7-3).
 *
 *   pnpm --filter @skating/bathymetry export-depths [--out=path] [--campaign=<id>]
 *   pnpm --filter @skating/lake-depth load scripts/bathymetry/.scratch/state-agency-depths.ndjson
 *
 * ## Why the export is a file and the load is another package's command
 *
 * The same seam `exportSoundings.ts` argues for, and for the same reason: the archives and their unit
 * traps live here, the ladder and the spatial join live in `@skating/lake-depth` and Convex, and a
 * file between them is what every other stage of this campaign already uses. Making either package
 * depend on the other would couple the contour ETL to the depth ETL permanently, for one hand-off.
 *
 * ## What this is worth
 *
 * Rung 1 of D68's ladder had **zero rows** in the corpus on 2026-08-09, while 298 MB of measured
 * state survey data sat in `.raw/` feeding the contour layer alone. Every depth those lakes carried
 * came from LAGOS-US or from a model. This is not only a coverage win — for a lake that already has a
 * modelled depth it is a **provenance upgrade**, which the caption reads and which D3 exists for.
 *
 * Thin: argv, `readAllLakes()`, the tested rules in `lakeDepths.ts`, a file, and a run row.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import { agencyDepths, depthsBySource } from './lakeDepths';
import { readAllLakes } from './lakeSources';
import { SOURCES } from './sources';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, '..', '.scratch', 'state-agency-depths.ndjson');

/** Skipped lakes named on the run row. Enough to recognise a pattern, small enough for a row. */
const SKIP_SAMPLE_CAP = 15;

function log(message: string): void {
  process.stderr.write(`[export-depths] ${message}\n`);
}

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outPath = flag(args, 'out') ?? DEFAULT_OUT;

  const logger = new RunLogger({
    kind: 'lake_depth',
    label: 'state-agency max depth, from the bathymetry archives',
    campaignId: flag(args, 'campaign'),
    target: resolveDeployment(),
    call: convexRun,
    stages: [
      ...SOURCES.map((source) => ({
        name: `${source.key} · read`,
        detail: `${source.agency} (${source.state}), ${source.kind}, depths in ${source.unit}`,
        sourceUrl: source.sourceUrl,
      })),
      {
        name: 'max depth',
        detail:
          'deepest positive reading per lake. A sounding lane gives a measurement; a contour lane ' +
          'gives the deepest published isobath, which is a LOWER BOUND on the real maximum.',
        output: outPath,
      },
    ],
  });
  logger.start();

  try {
    log('reading every archived lake…');
    const lakes = await readAllLakes();
    log(`${lakes.length.toLocaleString()} archived lakes`);

    const { depths, skipped, skippedKeys } = agencyDepths(lakes);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      depths.length > 0 ? `${depths.map((d) => JSON.stringify(d.record)).join('\n')}\n` : '',
    );

    const contourDerived = depths.filter((d) => d.understatesMax).length;
    log(`${depths.length.toLocaleString()} lakes with a maximum depth → ${outPath}`);
    log(
      `  ${depths.length - contourDerived} from soundings (a measurement) · ` +
        `${contourDerived} from the deepest contour (a lower bound)`,
    );
    for (const row of depthsBySource(depths)) {
      log(
        `  ${row.sourceKey.padEnd(30)} ${row.state}  ${String(row.lakes).padStart(5)} lakes  ` +
          `deepest ${row.deepestM.toFixed(1)} m`,
      );
    }
    for (const [reason, n] of Object.entries(skipped)) {
      if (n > 0) log(`  skipped ${n} · ${reason}`);
    }

    logger.count('archivedLakes', lakes.length);
    logger.count('withMaxDepth', depths.length);
    logger.count('fromSoundings', depths.length - contourDerived);
    logger.count('fromContours', contourDerived);
    for (const row of depthsBySource(depths)) logger.count(`source.${row.sourceKey}`, row.lakes);
    for (const [reason, n] of Object.entries(skipped)) {
      if (n > 0) logger.count(`skipped.${reason}`, n);
    }
    logger.coverage({
      unit: 'archived lakes',
      eligible: lakes.length,
      covered: depths.length,
      omissions: Object.entries(skipped)
        .filter(([, n]) => n > 0)
        .map(([reason, count]) => ({ reason, count })),
    });
    logger.succeed([
      `${depths.length} state-agency depths at ${outPath}`,
      'load with: pnpm --filter @skating/lake-depth load <that file> --campaign=<id>',
      // Named rather than counted: a gap you can look up is a gap somebody chases.
      ...(skippedKeys.length > 0
        ? [
            `skipped: ${skippedKeys
              .slice(0, SKIP_SAMPLE_CAP)
              .map((s) => `${s.key} (${s.reason})`)
              .join(', ')}`,
          ]
        : []),
    ]);
  } catch (err) {
    logger.failed(err);
    throw err;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[export-depths] FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
