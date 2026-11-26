/**
 * **The one argument contract** (B05 §3.1): `run-aerial.sh` and every stage CLI read their arguments
 * through `parseStageArgs`, so a flag can't mean one thing to the entry point and another to the
 * stage it starts.
 *
 * ```text
 * run-aerial.sh <campaign> [--stage select|tiles|assemble|verify|cleanup|all]
 *               [--states NH,VT] [--cells <file>] [--from-current] [--pilot <name>] [--dry-run]
 *               [--old <key>]
 * ```
 *
 * Both `--flag value` and `--flag=value` are read. Everything else is refused before any work starts:
 * a cheap argument must never fail an expensive build at its last step (`run-corpus.sh`'s lesson).
 */

import {
  AERIAL_STAGES,
  type AerialRunOptions,
  type AerialStage,
  isNaipState,
  type NaipState,
} from '@skating/core';
import { isPilotName, parseArchiveKey, parseCampaign } from './keys';

export { AERIAL_STAGES, type AerialStage };

/** A stage a CLI runs on its own: every stage but `all`. */
export type AerialStageName = Exclude<AerialStage, 'all'>;

/** What `all` runs, in order, stopping at the first refusal. `cleanup` is never part of it. */
export const ALL_STAGES: readonly AerialStageName[] = ['select', 'tiles', 'assemble', 'verify'];

export const AERIAL_USAGE = [
  'usage: run-aerial.sh <campaign> [--stage select|tiles|assemble|verify|cleanup|all]',
  '                     [--states NH,VT] [--cells <file>] [--from-current] [--pilot <name>]',
  '                     [--dry-run] [--old <key>]',
].join('\n');

/** A refused argument list. The message says what was wrong; `AERIAL_USAGE` says what is right. */
export class StageArgsError extends Error {
  override name = 'StageArgsError';
}

/** The arguments, read and checked. Absent flags are `null` or `false`, never `undefined`. */
export interface StageArgs {
  campaign: string;
  stage: AerialStage;
  states: NaipState[] | null;
  cells: string | null;
  fromCurrent: boolean;
  pilot: string | null;
  dryRun: boolean;
  old: string | null;
}

const VALUE_FLAGS = ['stage', 'states', 'cells', 'pilot', 'old'] as const;
const SWITCHES = ['from-current', 'dry-run'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];
type Switch = (typeof SWITCHES)[number];

const isValueFlag = (name: string): name is ValueFlag =>
  (VALUE_FLAGS as readonly string[]).includes(name);
const isSwitch = (name: string): name is Switch => (SWITCHES as readonly string[]).includes(name);

function refuse(message: string): never {
  throw new StageArgsError(message);
}

/**
 * Reads `argv` (the process's, past the script: `process.argv.slice(2)`). A stage CLI passes its own
 * stage as `forStage`: `--stage` is then optional and must name it.
 */
export function parseStageArgs(argv: readonly string[], forStage?: AerialStageName): StageArgs {
  const [campaign, ...rest] = argv;
  if (campaign === undefined || campaign.startsWith('-')) refuse('the campaign comes first');
  try {
    parseCampaign(campaign);
  } catch (e) {
    refuse((e as Error).message);
  }

  const values = new Map<ValueFlag, string>();
  const switches = new Set<Switch>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (!arg.startsWith('--')) refuse(`unexpected argument ${JSON.stringify(arg)}`);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (isSwitch(name)) {
      if (eq !== -1) refuse(`--${name} takes no value`);
      if (switches.has(name)) refuse(`--${name} given twice`);
      switches.add(name);
      continue;
    }
    if (!isValueFlag(name)) refuse(`unknown flag --${name}`);
    if (values.has(name)) refuse(`--${name} given twice`);
    let value: string | undefined;
    if (eq === -1) {
      value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) refuse(`--${name} needs a value`);
      i++;
    } else {
      value = arg.slice(eq + 1);
    }
    if (value === '') refuse(`--${name} needs a value`);
    values.set(name, value);
  }

  const stageFlag = values.get('stage');
  if (stageFlag !== undefined && !(AERIAL_STAGES as readonly string[]).includes(stageFlag)) {
    refuse(`unknown stage ${JSON.stringify(stageFlag)}`);
  }
  if (forStage !== undefined && stageFlag !== undefined && stageFlag !== forStage) {
    refuse(`this is the ${forStage} stage; --stage ${stageFlag} belongs to run-aerial.sh`);
  }
  const stage = (forStage ?? stageFlag ?? 'all') as AerialStage;

  const statesFlag = values.get('states');
  let states: NaipState[] | null = null;
  if (statesFlag !== undefined) {
    const codes = statesFlag.split(',').map((s) => s.trim().toUpperCase());
    for (const code of codes) {
      if (!isNaipState(code)) refuse(`--states: ${JSON.stringify(code)} is not one of the seven`);
    }
    states = [...new Set(codes as NaipState[])].sort();
  }
  const cells = values.get('cells') ?? null;
  if (states !== null && cells !== null) {
    refuse('--states and --cells both narrow the build; give one');
  }

  const pilot = values.get('pilot') ?? null;
  if (pilot !== null && !isPilotName(pilot)) {
    refuse(`--pilot ${JSON.stringify(pilot)} is not lowercase words joined by hyphens`);
  }
  const read = parseCampaign(campaign);
  if (read.pilot && pilot === null) refuse(`${campaign} is a pilot campaign: give --pilot <name>`);
  if (!read.pilot && pilot !== null) {
    refuse(`--pilot needs a pilot campaign (naip-pilot-<YYYYMMDD>), not ${campaign}`);
  }

  const old = values.get('old') ?? null;
  if (stage === 'cleanup') {
    if (old === null) refuse('cleanup needs --old <key>: the archive to delete');
    try {
      parseArchiveKey(old);
    } catch (e) {
      refuse(`--old: ${(e as Error).message}`);
    }
    if (states !== null || cells !== null || switches.has('from-current')) {
      refuse('cleanup takes --old, --pilot and --dry-run only');
    }
  } else if (old !== null) {
    refuse('--old belongs to --stage cleanup');
  }

  return {
    campaign,
    stage,
    states,
    cells,
    fromCurrent: switches.has('from-current'),
    pilot,
    dryRun: switches.has('dry-run'),
    old,
  };
}

/** The stages a run executes, in order: `all`'s four, or the one named. */
export function stagesToRun(stage: AerialStage): readonly AerialStageName[] {
  return stage === 'all' ? ALL_STAGES : [stage];
}

/** The read arguments as core's options, for `aerialRebuildCommand` (absent flags left out). */
export function stageArgsToOptions(args: StageArgs): AerialRunOptions {
  const options: AerialRunOptions = { stage: args.stage };
  if (args.states !== null) options.states = args.states;
  if (args.cells !== null) options.cells = args.cells;
  if (args.fromCurrent) options.fromCurrent = true;
  if (args.pilot !== null) options.pilot = args.pilot;
  if (args.dryRun) options.dryRun = true;
  if (args.old !== null) options.old = args.old;
  return options;
}

const CELL_KEY = /^\d{7}(?:ne|nw|se|sw)$/;

/**
 * A `--cells` file's text: one quarter-quad key per line; blank lines and `#` comments skipped.
 * Returns the keys sorted and deduplicated; throws, naming the line, on anything not shaped like a
 * key (whether the key is on the grid is core's `quarterQuadCell`).
 */
export function parseCellList(text: string): string[] {
  const keys = new Set<string>();
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') return;
    if (!CELL_KEY.test(line)) {
      throw new StageArgsError(`--cells line ${i + 1}: ${JSON.stringify(line)} is not a cell key`);
    }
    keys.add(line);
  });
  if (keys.size === 0) throw new StageArgsError('--cells lists no cell');
  return [...keys].sort();
}
