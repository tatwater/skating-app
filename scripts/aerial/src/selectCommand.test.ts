import {
  AERIAL_ENTRY_POINT,
  type AerialRunOptions,
  aerialRebuildCommand,
  NAIP_STATES,
} from '@skating/core';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { parseStageArgs, stageArgsToOptions } from './stages';

/** A POSIX shell's word splitting, for what `aerialRebuildCommand` writes: bare words and '…'. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      word = (word ?? '') + line.slice(i + 1, end);
      i = end;
    } else if (c === '\\') {
      word = (word ?? '') + line[++i];
    } else if (c === ' ') {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

const pilotName = fc
  .array(fc.stringMatching(/^[a-z0-9]{1,6}$/), { minLength: 1, maxLength: 3 })
  .map((parts) => parts.join('-'));
const path = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.startsWith('--'));

/** Options `parseStageArgs` accepts, with the campaign they go with. */
const runArb: fc.Arbitrary<{ campaign: string; options: AerialRunOptions }> = fc.oneof(
  fc
    .record({
      pilot: fc.option(pilotName, { nil: undefined }),
      stage: fc.constantFrom('select', 'tiles', 'assemble', 'verify', 'all', undefined),
      narrow: fc.oneof(
        fc.constant({}),
        fc.record({ states: fc.uniqueArray(fc.constantFrom(...NAIP_STATES), { minLength: 1 }) }),
        fc.record({ cells: path }),
      ),
      fromCurrent: fc.option(fc.constant(true), { nil: undefined }),
      dryRun: fc.option(fc.constant(true), { nil: undefined }),
    })
    .map(({ pilot, stage, narrow, fromCurrent, dryRun }) => {
      // A pilot takes --cells only, and its select (alone or in `all`) needs them.
      const selects = stage === 'select' || stage === 'all' || stage === undefined;
      const area =
        pilot === undefined || 'cells' in narrow
          ? narrow
          : selects
            ? { cells: 'pilot-cells.txt' }
            : {};
      return {
        campaign: pilot === undefined ? 'naip-20270712' : 'naip-pilot-20270712',
        options: { stage, pilot, fromCurrent, dryRun, ...area } as AerialRunOptions,
      };
    }),
  fc
    .record({
      pilot: fc.option(pilotName, { nil: undefined }),
      dryRun: fc.option(fc.constant(true), { nil: undefined }),
    })
    .map(({ pilot, dryRun }) => ({
      campaign: pilot === undefined ? 'naip-20270712' : 'naip-pilot-20270712',
      options: {
        stage: 'cleanup' as const,
        pilot,
        dryRun,
        old:
          pilot === undefined
            ? 'dev/naip/naip-summer-20261212.pmtiles'
            : `dev/naip/pilot/${pilot}/naip-summer-20261212.pmtiles`,
      },
    })),
);

/** What `stageArgsToOptions` gives back for these options: the defaults filled, the absent dropped. */
function normalized(o: AerialRunOptions): AerialRunOptions {
  const out: AerialRunOptions = { stage: o.stage ?? 'all' };
  if (o.states !== undefined) out.states = [...new Set(o.states)].sort();
  if (o.cells !== undefined) out.cells = o.cells;
  if (o.fromCurrent) out.fromCurrent = true;
  if (o.pilot !== undefined) out.pilot = o.pilot;
  if (o.dryRun) out.dryRun = true;
  if (o.old !== undefined) out.old = o.old;
  return out;
}

describe("aerialRebuildCommand, read back by run-aerial.sh's parser", () => {
  test('round-trips every option set the entry point accepts (a property)', () => {
    fc.assert(
      fc.property(runArb, ({ campaign, options }) => {
        const [entry, ...argv] = shellWords(aerialRebuildCommand(campaign, options));
        expect(entry).toBe(AERIAL_ENTRY_POINT);
        const read = parseStageArgs(argv);
        expect(read.campaign).toBe(campaign);
        expect(stageArgsToOptions(read)).toEqual(normalized(options));
      }),
    );
  });

  test('a path with a quote in it survives the shell', () => {
    const line = aerialRebuildCommand('naip-20270712', { cells: "/tmp/it's cells.txt" });
    expect(parseStageArgs(shellWords(line).slice(1)).cells).toBe("/tmp/it's cells.txt");
  });
});
