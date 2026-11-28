/**
 * `pnpm --filter @skating/aerial verify <campaign> [--pilot <name>] [--dry-run]` — the verify stage
 * (B05 §2.5), on the operator's laptop. A shell over `verify.ts` and `verifyReport.ts`.
 *
 * Reads the archive, its index and its manifest from the **public URL** (`R2_PUBLIC_BASE_URL`, the
 * basemap's name for the bucket's public origin), and the shards and the assembly record from the
 * private bucket through `rclone serve http` on localhost (`R2_REMOTE`, default `r2`, and
 * `R2_BUCKET`). Writes the report to `scripts/aerial/.scratch/<campaign>/report/` and, unless
 * `--dry-run`, an `aerial_assemble` row (label `verify …`) with a heartbeat per check. Exits 1 on any
 * refusal: the build is then not published.
 *
 * Every value is read by name; nothing here prints one (the report names public keys only).
 */

import { join } from 'node:path';
import process from 'node:process';
import { parseNaipCellIndex, quarterQuadAt, quarterQuadCell, quarterQuadsIn } from '@skating/core';
import { PMTiles } from 'pmtiles';
import { storeSource } from '../assemble/archiveRead';
import { runProcess } from '../assemble/process';
import { httpStore } from '../assemble/stores';
import { serveHttp } from '../assemble/upload';
import { archiveKey, archiveName, indexKey, scratchPaths } from '../keys';
import type { VerifyPlan } from '../preflight';
import { outcomeWord } from '../refusals';
import { runVerifyStage } from '../stage/verifyStage';
import type { StageArgs } from '../stages';
import { pmtilesCliCheck, publicUrl, verifyBuild } from '../verify';
import { writeReport } from '../verifyReport';
import { writeViewer } from '../viewer/page';
import type { RunRow } from '../world';
import { realWorld } from './world';

async function main(): Promise<number> {
  return runVerifyStage(process.argv.slice(2), realWorld(), checkAll);
}

async function checkAll(args: StageArgs, plan: VerifyPlan, logger: RunRow | null): Promise<number> {
  const { campaign } = args;
  const { base } = plan;
  const pilot = args.pilot ?? undefined;
  const server = await serveHttp(plan.target, 8789);
  try {
    const published = httpStore(base);
    const indexUrl = publicUrl(
      base,
      campaign,
      args.pilot,
      indexKey(campaign, pilot).split('/').pop() as string,
    );
    const outcome = await verifyBuild(campaign, args.pilot, {
      published,
      build: httpStore(server.baseUrl),
      cellsIn: quarterQuadsIn,
      parseIndex: parseNaipCellIndex,
      indexHeaders: async () => {
        const res = await fetch(indexUrl, {
          method: 'HEAD',
          headers: { 'accept-encoding': 'gzip' },
        });
        return Object.fromEntries(res.headers);
      },
      onCheck: (c) => {
        process.stderr.write(
          `[verify] ${c.name}: ${c.problems.length === 0 ? 'passed' : `${c.problems.length} problems`}\n`,
        );
        logger?.count(`${c.name.replace(/\s+/g, '')}Problems`, c.problems.length);
        for (const [k, v] of Object.entries(c.counts)) logger?.count(k, v);
        logger?.flush();
      },
    });
    // The pmtiles CLI over the public URL, when it is installed: a second reader of the header.
    const cli = await pmtilesCliCheck(
      runProcess,
      publicUrl(base, campaign, args.pilot, archiveName(campaign)),
    );
    if (cli !== null) {
      if (cli.problems.length > 0) outcome.ok = false;
      outcome.checks.push(cli);
    }
    const report = scratchPaths(campaign).report;
    const title = `Summer aerial ${campaign}${pilot ? ` (pilot ${pilot})` : ''}`;
    const sheets = await writeReport(report, outcome, {
      archive: new PMTiles(storeSource(published, archiveKey(campaign, pilot))),
      grid: { cellBox: quarterQuadCell, cellAt: quarterQuadAt },
      title,
    });
    await writeViewer(join(report, 'viewer'), {
      archiveUrl: publicUrl(base, campaign, args.pilot, archiveName(campaign)),
      archiveName: archiveName(campaign),
      title,
    });
    logger?.count('seamsSampled', sheets.seams);
    logger?.count('cellsUnder99', sheets.lowCoverage);
    if (outcome.ok) logger?.succeed([`report ${report}`]);
    else
      logger?.failed(
        new Error(
          outcome.checks
            .flatMap((c) => c.problems)
            .slice(0, 3)
            .join('; '),
        ),
      );
    process.stdout.write(`${outcome.ok ? 'passed' : 'refused'}: report in ${report}\n`);
    return outcome.ok ? 0 : 1;
  } finally {
    server.stop();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${outcomeWord(e)}: ${(e as Error).message}\n`);
    process.exit(1);
  },
);
