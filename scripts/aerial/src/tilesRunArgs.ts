/**
 * `run-aerial.sh`'s refusals, before any stage starts (§3.1): its whole argument list read by
 * `stages.ts`' `parseStageArgs` — the same reader every stage CLI uses — then the run rows' target
 * checked: a pilot writes them to a throwaway local backend only (G-8 a), and no summer aerial run
 * writes prod's (the founder, F-4 a: dev only). On success prints the stages to run, one a line.
 *
 *   tsx src/tilesRunArgs.ts <campaign> [flags…]   → exit 0 and the stages, or 64 and why not
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolveDeployment } from '@skating/run-log';
import { parseStageArgs, StageArgsError, stagesToRun } from './stages';
import { checkPilotTarget } from './tiles';

export interface RunArgsIo {
  out: (line: string) => void;
  err: (line: string) => void;
  target: () => { label: string; isProd: boolean };
}

const defaultIo: RunArgsIo = {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  target: resolveDeployment,
};

export function main(argv: readonly string[], io: RunArgsIo = defaultIo): number {
  try {
    const args = parseStageArgs(argv);
    const target = io.target();
    if (target.isProd) {
      throw new StageArgsError('the summer aerial is built for dev only; this targets prod');
    }
    try {
      checkPilotTarget(args.pilot, target);
    } catch (e) {
      throw new StageArgsError((e as Error).message);
    }
    for (const stage of stagesToRun(args.stage)) io.out(stage);
    return 0;
  } catch (e) {
    if (!(e instanceof StageArgsError)) throw e;
    io.err(`refused: ${e.message}`);
    return 64;
  }
}

// Run as a script (`tsx src/tilesRunArgs.ts …`), not when imported by a test.
if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
