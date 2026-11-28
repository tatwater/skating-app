/**
 * `run-aerial.sh`'s refusals, before any stage starts (§3.1): its whole argument list read by
 * `stages.ts`' `parseStageArgs` — the same reader every stage CLI uses — then the run rows' target
 * checked by the same rule every stage applies (`runTarget.ts`): a pilot writes them to a throwaway
 * local backend only (G-8 a), a build to dev only (F-4 a). A dry run writes no row, so its target
 * isn't checked, as no stage checks it. On success prints the stages to run, one a line.
 *
 *   tsx src/tilesRunArgs.ts <campaign> [flags…]   → exit 0 and the stages, or 64 and why not
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolveDeployment } from '@skating/run-log';
import { checkRunTarget, type DeploymentTarget, RunTargetRefusal } from './runTarget';
import { parseStageArgs, StageArgsError, stagesToRun } from './stages';

export interface RunArgsIo {
  out: (line: string) => void;
  err: (line: string) => void;
  target: () => DeploymentTarget;
}

const defaultIo: RunArgsIo = {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  target: resolveDeployment,
};

export function main(argv: readonly string[], io: RunArgsIo = defaultIo): number {
  try {
    const args = parseStageArgs(argv);
    if (!args.dryRun) checkRunTarget(args.pilot, io.target());
    for (const stage of stagesToRun(args.stage)) io.out(stage);
    return 0;
  } catch (e) {
    if (!(e instanceof StageArgsError || e instanceof RunTargetRefusal)) throw e;
    io.err(`refused: ${e.message}`);
    return 64;
  }
}

// Run as a script (`tsx src/tilesRunArgs.ts …`), not when imported by a test.
if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
