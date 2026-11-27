/**
 * **The loaders stay visibly alive while they run** (D341, B01-8a): each pass that sends batches
 * sets its running totals and beats after every batch, so Machinery's heartbeat moves at the run
 * logger's cadence (at most once a minute) rather than only at the close. And the load counts
 * `batchesTotal` before its first batch, so a live load reads "66 of 170".
 *
 * Driven for real with small inputs in a temp directory, against a fake `@skating/run-log`: a fake
 * deployment answers each loader's mutation, and a recording run logger stands in for the real one
 * (whose cadence `runLoggerEvents.test.ts` holds).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Step = [method: string, ...args: unknown[]];

const world = vi.hoisted(() => ({
  steps: [] as Step[],
  answer: (_fn: string, _args: Record<string, unknown>): unknown => undefined,
}));

vi.mock('@skating/run-log', async (importActual) => {
  const actual = await importActual<typeof import('@skating/run-log')>();
  class RecordingLogger {
    totalFailures = 0;
    constructor(options: { kind: string }) {
      world.steps.push(['new', options.kind]);
    }
    start() {
      world.steps.push(['start']);
    }
    count(name: string, value: number) {
      world.steps.push(['count', name, value]);
    }
    stage() {}
    fail() {
      this.totalFailures++;
    }
    coverage() {}
    flush() {
      world.steps.push(['flush']);
    }
    beat(label?: string) {
      world.steps.push(['beat', label]);
    }
    succeed() {
      world.steps.push(['succeed']);
    }
    failed(error: unknown) {
      world.steps.push(['failed', String(error)]);
    }
  }
  return {
    ...actual,
    RunLogger: RecordingLogger,
    resolveDeployment: () => ({ label: 'dev:fake', isDev: true, isProd: false }),
    convexRun: (fn: string, args: Record<string, unknown>) => {
      world.steps.push(['call', fn]);
      return world.answer(fn, args);
    },
    // One body a batch, so a handful of lines makes enough batches to reach a flush.
    batchNdjson: (lines: readonly string[]) => lines.map((l) => [l]),
  };
});

let dir: string;
let argv: string[];
let stderr: ReturnType<typeof vi.spyOn>;
let stdout: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loader-beats-'));
  argv = process.argv;
  world.steps = [];
  vi.resetModules();
  stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
});
afterEach(() => {
  process.argv = argv;
  process.exitCode = undefined;
  stderr.mockRestore();
  stdout.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function ndjson(name: string, rows: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return path;
}

const named = (method: string) => world.steps.filter((s) => s[0] === method);
const firstIndex = (pred: (s: Step) => boolean) => world.steps.findIndex(pred);

describe('load (canonical water)', () => {
  it('counts the batches before the first, beats each batch, and still flushes every 25', async () => {
    const input = ndjson(
      'bodies.ndjson',
      Array.from({ length: 30 }, (_, i) => ({ externalId: `way/${i}`, states: ['VT'] })),
    );
    world.answer = (fn) =>
      fn === 'waterBodies:importCanonical' ? { inserted: 1, updated: 0 } : undefined;
    process.argv = ['node', 'load.ts', input, '--campaign=c-test'];
    const { main } = await import('./load');
    main();

    const total = firstIndex((s) => s[0] === 'count' && s[1] === 'batchesTotal');
    const firstBatch = firstIndex((s) => s[0] === 'call' && s[1] === 'waterBodies:importCanonical');
    expect(world.steps[total]).toEqual(['count', 'batchesTotal', 30]);
    expect(total).toBeLessThan(firstBatch);
    expect(named('flush')).toHaveLength(1);
    expect(named('beat')).toHaveLength(29);
    expect(named('beat')[0]).toEqual(['beat', 'batch 1 of 30']);
    expect(named('beat').at(-1)).toEqual(['beat', 'batch 30 of 30']);
    // The running totals ride every beat.
    const beforeFirstBeat = world.steps.slice(
      0,
      firstIndex((s) => s[0] === 'beat'),
    );
    expect(beforeFirstBeat).toContainEqual(['count', 'batchesApplied', 1]);
    expect(beforeFirstBeat).toContainEqual(['count', 'inserted', 1]);
    expect(world.steps.at(-1)).toEqual(['succeed']);
  });

  it('does not run on import', async () => {
    process.argv = ['node', 'load.ts'];
    await import('./load');
    expect(world.steps).toEqual([]);
  });
});

describe('load-sub-areas', () => {
  it('beats after every bay with its running totals', async () => {
    const input = ndjson(
      'sub-areas.ndjson',
      ['North Bay', 'South Bay', 'Cove'].map((name) => ({ name, polygon: {}, parentIds: {} })),
    );
    world.answer = (fn, args) =>
      fn === 'subAreas:importBaySubAreas'
        ? {
            created: 1,
            refused: 0,
            results: (args.bays as { name: string }[]).map((b) => ({ name: b.name, ok: true })),
          }
        : undefined;
    process.argv = ['node', 'loadSubAreas.ts', input, '--actor=p1'];
    await import('./loadSubAreas');

    expect(named('beat')).toEqual([
      ['beat', 'bay 1 of 3'],
      ['beat', 'bay 2 of 3'],
      ['beat', 'bay 3 of 3'],
    ]);
    const firstBeat = firstIndex((s) => s[0] === 'beat');
    expect(world.steps[firstBeat - 1]).toEqual(['count', 'batchesFailed', 0]);
    expect(world.steps.slice(0, firstBeat)).toContainEqual(['count', 'created', 1]);
    expect(world.steps.slice(0, firstBeat)).toContainEqual(['count', 'baysRead', 3]);
    expect(world.steps.at(-1)).toEqual(['succeed']);
  });
});

describe('load-landmarks', () => {
  it('beats after every batch with its running totals', async () => {
    const input = ndjson(
      'landmarks.ndjson',
      ['b1', 'b2', 'b3'].map((waterBodyId) => ({
        waterBodyId,
        landmarks: Array.from({ length: 300 }, () => ({})),
      })),
    );
    world.answer = (fn) =>
      fn === 'landmarks:importBatch' ? { created: 2, updated: 1 } : undefined;
    process.argv = ['node', 'loadLandmarks.ts', input];
    await import('./loadLandmarks');

    expect(named('beat')).toEqual([
      ['beat', 'batch 1 of 3'],
      ['beat', 'batch 2 of 3'],
      ['beat', 'batch 3 of 3'],
    ]);
    const firstBeat = firstIndex((s) => s[0] === 'beat');
    expect(world.steps.slice(0, firstBeat)).toContainEqual(['count', 'created', 2]);
    expect(world.steps.slice(0, firstBeat)).toContainEqual(['count', 'updated', 1]);
    expect(world.steps.at(-1)).toEqual(['succeed']);
  });
});

describe('load-landmark-names', () => {
  it('beats after every hundred names with its running totals', async () => {
    const input = ndjson(
      'corpus-names.ndjson',
      Array.from({ length: 250 }, (_, i) => ({ name: `Place ${i}` })),
    );
    world.answer = (fn, args) =>
      fn === 'corpusPlaceNames:importBatch'
        ? { created: (args.names as unknown[]).length, refreshed: 0, unchanged: 0, decidedHeld: 0 }
        : undefined;
    process.argv = ['node', 'loadLandmarkNames.ts', input];
    await import('./loadLandmarkNames');

    expect(named('beat')).toEqual([
      ['beat', 'names 100 of 250'],
      ['beat', 'names 200 of 250'],
      ['beat', 'names 250 of 250'],
    ]);
    expect(world.steps[firstIndex((s) => s[0] === 'beat') - 4]).toEqual(['count', 'created', 100]);
    expect(
      world.steps.slice(
        0,
        firstIndex((s) => s[0] === 'call'),
      ),
    ).toContainEqual(['count', 'namesRead', 250]);
    expect(world.steps.at(-1)).toEqual(['succeed']);
  });
});
