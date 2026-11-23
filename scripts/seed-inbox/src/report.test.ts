import type { RunAs } from '@skating/run-log';
import { describe, expect, test } from 'vitest';
import { applyAndReport, clearAndReport, type Out } from './report';
import type { Call, ClearAnswer, SeedCall, SeedState } from './seed';

/** The terminal and the kept log, as the run left them. */
function recorder() {
  const lines: string[] = [];
  const logs: string[] = [];
  const out: Out = {
    say: (line) => lines.push(line),
    writeLog: (_mode, record) => {
      logs.push(JSON.stringify(record));
      return 'runs/x.json';
    },
    target: 'dev:happy-cat-123',
  };
  return { out, lines, logs };
}

const ADMIN = {
  created: [],
  existing: [],
  applied: true,
  operator: { role: 'admin', status: 'active' },
};
const photo = (key: string): SeedCall => ({
  key,
  label: key,
  as: 'gus',
  clerkUserId: 'seed_inbox_7',
  fn: 'photos:create',
  args: { caption: key, placeOnMap: false },
  upload: true,
});
const state = (ready: SeedCall[], extra: Partial<SeedState> = {}): SeedState => ({
  people: [],
  bodies: [],
  done: [],
  ready,
  waiting: [],
  unavailable: [],
  ...extra,
});

/**
 * A deployment whose `photos:create` refuses and whose cleanup fails (or not), and whose plan read
 * after the first wave does `after` — throws, or answers nothing more.
 */
function server(opts: { cleanupFails: boolean; after: 'throw' | 'end'; unavailable?: boolean }) {
  let reads = 0;
  const call: Call = <T>(fn: string, _args: unknown, _runAs?: RunAs): T => {
    if (fn === 'inboxSeed:ensurePeople') return ADMIN as T;
    if (fn === 'inboxSeed:state') {
      reads++;
      if (reads === 1) {
        return state([photo('ph-1')], {
          ...(opts.unavailable
            ? {
                unavailable: [
                  { key: 'r-photos', label: 'r', missing: 'a caspian body on this deployment' },
                ],
              }
            : {}),
        }) as T;
      }
      if (opts.after === 'throw') throw new Error('Uncaught Error: the deployment went away');
      return state([]) as T;
    }
    if (fn === 'photos:removeBlob') {
      if (opts.cleanupFails) throw new Error('Uncaught Error: not reachable');
      return null as T;
    }
    throw new Error('Uncaught ConvexError: Minors cannot post');
  };
  return call;
}
const upload = () => ({ storageId: 'kg-full', thumbStorageId: 'kg-thumb' });
const idLines = (lines: string[]) => lines.filter((l) => l.startsWith('left on the deployment'));

describe('applyAndReport', () => {
  test('cleanup fails, then the next plan read throws: the ids printed at the step and again at the end, in no log', async () => {
    const { out, lines, logs } = recorder();
    await expect(
      applyAndReport(
        server({ cleanupFails: true, after: 'throw' }),
        'user_op',
        upload,
        () => false,
        out,
      ),
    ).rejects.toThrow('the deployment went away');
    const ids = idLines(lines);
    expect(ids).toHaveLength(4); // two files, each said at the step and in the summary
    expect(ids[0]).toContain('file kg-full');
    expect(ids[1]).toContain('file kg-thumb');
    expect(ids.slice(2)).toEqual(ids.slice(0, 2));
    // Said before the call that threw: the step's lines come first.
    expect(lines.indexOf(ids[0] as string)).toBeLessThan(lines.lastIndexOf(ids[0] as string));
    expect(lines.indexOf(ids[0] as string)).toBe(1); // right after the step's own line
    expect(lines.at(-1)).toBe(
      'the run stopped on an error; what it filed stays — apply again to finish it',
    );
    expect(logs).toEqual([]);
  });

  test('cleanup fails, then Ctrl-C: the same — at the step, at the end, never in the kept log', async () => {
    const { out, lines, logs } = recorder();
    const code = await applyAndReport(
      server({ cleanupFails: true, after: 'end' }),
      'user_op',
      upload,
      () => true,
      out,
    );
    expect(code).toBe(1);
    expect(idLines(lines)).toHaveLength(4);
    expect(lines).toContain('interrupted: the run stopped early; apply again to finish it');
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain('kg-');
    expect(JSON.parse(logs[0] as string).stranded).toEqual([{ key: 'ph-1', as: 'gus', files: 2 }]);
  });

  test('nothing stranded: no such line, and the failed step’s server sentence said at once', async () => {
    const { out, lines } = recorder();
    const code = await applyAndReport(
      server({ cleanupFails: false, after: 'end' }),
      'user_op',
      upload,
      () => false,
      out,
    );
    expect(code).toBe(1);
    expect(idLines(lines)).toEqual([]);
    expect(lines[0]).toMatch(/^FAILED ph-1 +photos:create as gus — .*Minors cannot post$/);
    expect(lines.some((l) => l.startsWith('interrupted') || l.startsWith('the run stopped'))).toBe(
      false,
    );
  });

  test('the unavailable steps’ reasons survive a throw', async () => {
    const { out, lines } = recorder();
    await expect(
      applyAndReport(
        server({ cleanupFails: false, after: 'throw', unavailable: true }),
        'user_op',
        upload,
        () => false,
        out,
      ),
    ).rejects.toThrow();
    expect(lines).toContain('unavailable r-photos — needs a caspian body on this deployment');
  });

  test('a clean run: each step said as filed, exit 0, nothing to act on', async () => {
    const { out, lines, logs } = recorder();
    let reads = 0;
    const call = (<T>(fn: string): T => {
      if (fn === 'inboxSeed:ensurePeople') return ADMIN as T;
      if (fn === 'inboxSeed:state')
        return (++reads === 1 ? state([photo('ph-1')]) : state([])) as T;
      if (fn === 'photos:create') return { photoId: 'p1' } as T;
      throw new Error(`unexpected ${fn}`);
    }) as Call;
    expect(await applyAndReport(call, 'user_op', upload, () => false, out)).toBe(0);
    expect(lines[0]).toMatch(/^filed {2}ph-1 +photos:create as gus$/);
    expect(lines.some((l) => l.startsWith('FAILED') || l.startsWith('left on'))).toBe(false);
    expect(lines.some((l) => /stopped|interrupted/.test(l))).toBe(false);
    expect(logs).toHaveLength(1);
  });

  test('a run that throws before any plan read: only the error line of its own', async () => {
    const { out, lines } = recorder();
    const call: Call = <T>(): T => {
      throw new Error('no deployment');
    };
    await expect(applyAndReport(call, 'user_op', upload, () => false, out)).rejects.toThrow();
    expect(lines).toEqual([
      'the run stopped on an error; what it filed stays — apply again to finish it',
    ]);
  });
});

describe('clearAndReport', () => {
  const clearing = (answers: (ClearAnswer | Error)[]): Call =>
    (<T>(): T => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('called past the end');
      return next as T;
    }) as Call;

  test('a throw mid-clear: what it removed, and what it was waiting on, still said', () => {
    const { out, lines, logs } = recorder();
    const call = clearing([
      { done: false, removed: { photos: 3 } },
      { done: false, removed: {}, waiting: 1, readyBy: 0 },
      new Error('Uncaught Error: the deployment went away'),
    ]);
    expect(() => clearAndReport(call, out, () => {})).toThrow('went away');
    expect(lines).toEqual([
      'waiting on 1 seed photo(s) whose file is being moved, over by 1970-01-01T00:00:00.000Z',
      'removed: photos 3',
      'still waiting on 1 seed photo(s) whose file is being moved, over by 1970-01-01T00:00:00.000Z',
      'the clear is not done; run it again to finish it',
    ]);
    expect(logs).toEqual([]);
  });

  test('a clear that runs out of calls while still removing: exit 1, its log, and the run-again line', () => {
    const { out, lines, logs } = recorder();
    const call = (<T>(fn: string): T => {
      if (fn !== 'inboxSeed:clear') throw new Error(`unexpected ${fn}`);
      return { done: false, removed: { photos: 1 } } as T;
    }) as Call;
    expect(clearAndReport(call, out, () => {})).toBe(1);
    expect(logs).toHaveLength(1);
    expect(lines.at(-1)).toBe('the clear is not done; run it again to finish it');
  });

  test('a clear that finishes: its log, and what it removed', () => {
    const { out, lines, logs } = recorder();
    const call = clearing([
      { done: false, removed: {}, waiting: 1 },
      { done: true, removed: { photos: 4, profiles: 8 } },
    ]);
    expect(clearAndReport(call, out, () => {})).toBe(0);
    expect(lines.slice(-2)).toEqual(['run log runs/x.json', 'removed: photos 4 · profiles 8']);
    expect(logs).toHaveLength(1);
  });
});
