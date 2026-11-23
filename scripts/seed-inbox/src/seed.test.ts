import type { RunAs } from '@skating/run-log';
import { describe, expect, test } from 'vitest';
import {
  applyClear,
  applySeed,
  type Call,
  type ClearAnswer,
  describePlan,
  errorLine,
  MAX_CLEAR_CALLS,
  MAX_PHOTO_WAITS,
  MAX_WAVES,
  operatorRefusal,
  PHOTO_WAIT_MS,
  planSeed,
  runAsFor,
  runLogName,
  type SeedCall,
  type SeedState,
  sleepSync,
  tally,
  waitingOn,
} from './seed';

/** A step of the fake plan: what it needs first, and whether filing it throws. */
interface FakeStep {
  key: string;
  as: string;
  after?: string[];
  fails?: boolean;
}

/** A stand-in for the deployment: the server's protocol over an in-memory plan. */
function fakeServer(
  steps: FakeStep[],
  opts: {
    unavailable?: string[];
    neverSettles?: boolean;
    operator?: { role: string; status: string } | null;
  } = {},
) {
  const done = new Set<string>();
  let peopleMade = false;
  const calls: { fn: string; args: unknown; runAs?: RunAs }[] = [];
  const state = (): SeedState => {
    const ready: SeedCall[] = [];
    const waiting: SeedState['waiting'] = [];
    for (const s of steps) {
      if (done.has(s.key)) continue;
      const pending = (s.after ?? []).find((k) => !done.has(k));
      if (pending) {
        waiting.push({ key: s.key, label: s.key, on: pending });
        continue;
      }
      ready.push({
        key: s.key,
        label: `label ${s.key}`,
        as: s.as,
        fn: `mod:${s.key}`,
        args: { k: s.key },
        ...(s.as !== 'operator' && s.as !== 'bare' ? { clerkUserId: `seed_inbox_${s.as}` } : {}),
      });
    }
    return {
      people: [
        { key: 'ada', displayName: 'Ada Test-Lindqvist', profileId: peopleMade ? 'p1' : null },
      ],
      bodies: [
        { role: 'mascoma', name: 'Mascoma Lake' },
        { role: 'removed', name: null },
      ],
      done: [...done],
      ready,
      waiting,
      unavailable: (opts.unavailable ?? []).map((key) => ({
        key,
        label: key,
        missing: 'a removed body',
      })),
    };
  };
  const call: Call = <T>(fn: string, args: unknown, runAs?: RunAs): T => {
    calls.push({ fn, args, ...(runAs ? { runAs } : {}) });
    if (fn === 'inboxSeed:ensurePeople') {
      const apply = (args as { apply?: boolean }).apply === true;
      const created = peopleMade ? [] : ['Ada Test-Lindqvist'];
      if (apply) peopleMade = true;
      const asked = (args as { operator?: string }).operator !== undefined;
      const operator =
        opts.operator === undefined ? { role: 'admin', status: 'active' } : opts.operator;
      return {
        created,
        existing: peopleMade && !apply ? ['Ada Test-Lindqvist'] : [],
        applied: apply,
        ...(asked ? { operator } : {}),
      } as T;
    }
    if (fn === 'inboxSeed:state') return state() as T;
    const step = steps.find((s) => `mod:${s.key}` === fn);
    if (!step) throw new Error(`no such function ${fn}`);
    if (step.fails) throw new Error(`Uncaught ConvexError: refused ${step.key}\n    at handler`);
    if (!opts.neverSettles) done.add(step.key);
    return `id_${step.key}` as T;
  };
  return { call, calls, done };
}

const PLAN: FakeStep[] = [
  { key: 'r1', as: 'ada' },
  { key: 'f1', as: 'ben', after: ['r1'] },
  { key: 'hide', as: 'operator', after: ['f1'] },
  { key: 'track', as: 'bare' },
];

describe('runAsFor', () => {
  const step = (as: string, clerkUserId?: string): SeedCall => ({
    key: 'k',
    label: 'l',
    as,
    fn: 'f',
    args: {},
    ...(clerkUserId ? { clerkUserId } : {}),
  });
  test('a fake person goes out as their seed subject, via seed-inbox', () => {
    expect(runAsFor(step('ada', 'seed_inbox_1'), 'user_op')).toEqual({
      as: 'seed_inbox_1',
      via: 'seed-inbox',
    });
  });
  test('a moderator act goes out as the operator', () => {
    expect(runAsFor(step('operator'), 'user_op')).toEqual({ as: 'user_op', via: 'seed-inbox' });
  });
  test('an internal call goes out bare', () => {
    expect(runAsFor(step('bare'), 'user_op')).toBeUndefined();
  });
  test('a step with no one to file it as is refused', () => {
    expect(() => runAsFor(step('operator'), undefined)).toThrow(/No one to file/);
    expect(() => runAsFor(step('ada'), 'user_op')).toThrow(/No one to file/);
  });
});

describe('planSeed — the dry run', () => {
  test('asks who would be created and reads the plan, and writes nothing', () => {
    const server = fakeServer(PLAN);
    const { people, state } = planSeed(server.call);
    expect(people.created).toEqual(['Ada Test-Lindqvist']);
    expect(state.ready.map((c) => c.key)).toEqual(['r1', 'track']);
    expect(server.calls.map((c) => c.fn)).toEqual(['inboxSeed:ensurePeople', 'inboxSeed:state']);
    expect(server.calls[0]?.args).toEqual({});
    expect(server.done.size).toBe(0);
  });

  test('describePlan prints the people, the bodies and every step', () => {
    const server = fakeServer(PLAN, { unavailable: ['restore'] });
    const { people, state } = planSeed(server.call);
    const lines = describePlan(people, state);
    expect(lines[0]).toBe('would create 1 fake people: Ada Test-Lindqvist');
    expect(lines).toContain('body removed    — none on this deployment');
    expect(lines.some((l) => l.startsWith('ready       r1'))).toBe(true);
    expect(lines.some((l) => l.startsWith('waiting     f1') && l.includes('on r1'))).toBe(true);
    expect(
      lines.some((l) => l.startsWith('unavailable restore') && l.includes('a removed body')),
    ).toBe(true);
    expect(describePlan({ created: [], existing: ['A', 'B'], applied: false }, state)[0]).toBe(
      'the 2 fake people exist',
    );
  });
});

describe('applySeed', () => {
  test('files every step in waves, each as its actor, until nothing is ready', () => {
    const server = fakeServer(PLAN);
    const seen: string[] = [];
    const run = applySeed(server.call, 'user_op', (f) => seen.push(f.key));
    expect(run.waves.map((w) => w.map((f) => f.key))).toEqual([['r1', 'track'], ['f1'], ['hide']]);
    expect(seen).toEqual(['r1', 'track', 'f1', 'hide']);
    expect(run.counts).toEqual({
      filed: 4,
      failed: 0,
      done: 4,
      waiting: 0,
      unavailable: 0,
      ready: 0,
    });
    expect(run.people.created).toEqual(['Ada Test-Lindqvist']);
    const as = Object.fromEntries(
      server.calls.filter((c) => c.fn.startsWith('mod:')).map((c) => [c.fn, c.runAs]),
    );
    expect(as).toEqual({
      'mod:r1': { as: 'seed_inbox_ada', via: 'seed-inbox' },
      'mod:track': undefined,
      'mod:f1': { as: 'seed_inbox_ben', via: 'seed-inbox' },
      'mod:hide': { as: 'user_op', via: 'seed-inbox' },
    });
    expect(run.waves[0]?.[0]?.result).toBe('id_r1');
  });

  test('a second run files nothing new — its counts are zero', () => {
    const server = fakeServer(PLAN);
    applySeed(server.call, 'user_op');
    const again = applySeed(server.call, 'user_op');
    expect(again.waves).toEqual([]);
    expect(again.counts).toMatchObject({ filed: 0, failed: 0, done: 4 });
    expect(again.people.created).toEqual([]);
  });

  test('a step that fails is recorded with its first line, tried once, and what waits on it waits', () => {
    const server = fakeServer([
      { key: 'r1', as: 'ada', fails: true },
      { key: 'f1', as: 'ben', after: ['r1'] },
      { key: 't1', as: 'ada' },
    ]);
    const run = applySeed(server.call, 'user_op');
    expect(run.waves).toHaveLength(1);
    expect(run.waves[0]?.find((f) => f.key === 'r1')?.error).toBe(
      'Uncaught ConvexError: refused r1',
    );
    expect(run.counts).toMatchObject({ filed: 1, failed: 1, waiting: 1, ready: 1 });
    expect(server.calls.filter((c) => c.fn === 'mod:r1')).toHaveLength(1);
  });

  test('a plan that never settles stops at the wave cap', () => {
    const server = fakeServer([{ key: 'r1', as: 'ada' }], { neverSettles: true });
    const run = applySeed(server.call, 'user_op');
    // Tried once; on the next wave it is ready again but already tried, so the loop stops.
    expect(run.waves).toHaveLength(1);
    expect(MAX_WAVES).toBeGreaterThan(5);
  });

  test('the wave cap bounds a plan that keeps offering new steps', () => {
    let n = 0;
    const call: Call = <T>(fn: string): T => {
      if (fn === 'inboxSeed:ensurePeople') {
        return {
          created: [],
          existing: [],
          applied: true,
          operator: { role: 'admin', status: 'active' },
        } as T;
      }
      if (fn === 'inboxSeed:state') {
        n++;
        return {
          people: [],
          bodies: [],
          done: [],
          ready: [{ key: `s${n}`, label: 'x', as: 'bare', fn: 'mod:x', args: {} }],
          waiting: [],
          unavailable: [],
        } as T;
      }
      return 'ok' as T;
    };
    expect(applySeed(call, 'user_op').waves).toHaveLength(MAX_WAVES);
  });
});

describe('the operator check, before anything is written', () => {
  test('an admin runs; the check asks about them and writes nothing first', () => {
    const server = fakeServer(PLAN);
    applySeed(server.call, 'user_op');
    expect(server.calls[0]).toEqual({
      fn: 'inboxSeed:ensurePeople',
      args: { operator: 'user_op' },
    });
    expect(server.calls[1]?.args).toEqual({ apply: true });
  });

  test.each([
    ['a moderator', { role: 'moderator', status: 'active' }, /must be an admin/],
    ['a member', { role: 'member', status: 'active' }, /must be an admin/],
    ['a suspended admin', { role: 'admin', status: 'suspended' }, /suspended, not active/],
    ['no one', null, /names no one/],
  ] as const)(
    '%s is refused with a plain sentence, and nothing is filed',
    (_, operator, message) => {
      const server = fakeServer(PLAN, { operator });
      expect(() => applySeed(server.call, 'user_op')).toThrow(message);
      expect(server.calls.map((c) => c.fn)).toEqual(['inboxSeed:ensurePeople']);
      expect(server.done.size).toBe(0);
    },
  );

  test('a run with no operator at all is refused the same way', () => {
    const server = fakeServer(PLAN);
    expect(() => applySeed(server.call, undefined)).toThrow(/names no one/);
    expect(server.calls.map((c) => c.fn)).toEqual(['inboxSeed:ensurePeople']);
    expect(operatorRefusal({ role: 'admin', status: 'active' })).toBeNull();
  });
});

describe('applyClear', () => {
  const answers = (list: ClearAnswer[]) => {
    const sent: unknown[] = [];
    const call: Call = <T>(fn: string, args: unknown): T => {
      expect(fn).toBe('inboxSeed:clear');
      sent.push(args);
      const next = list.shift();
      if (!next) throw new Error('called past the end');
      return next as T;
    };
    return { call, sent };
  };

  test('calls until done and adds up what it removed', () => {
    const { call, sent } = answers([
      { done: false, removed: { contentFlags: 3 } },
      { done: false, removed: { contentFlags: 1, reports: 2 } },
      { done: true, removed: { profiles: 8 } },
    ]);
    const seen: ClearAnswer[] = [];
    const run = applyClear(call, (a) => seen.push(a));
    expect(run).toEqual({
      calls: 3,
      removed: { contentFlags: 4, reports: 2, profiles: 8 },
      done: true,
    });
    expect(sent).toEqual([{}, {}, {}]);
    expect(seen).toHaveLength(3);
  });

  test('a call that removes nothing stops the run, said plainly', () => {
    const { call } = answers([
      { done: false, removed: { reports: 1 } },
      { done: false, removed: { reports: 0 } },
    ]);
    expect(() => applyClear(call)).toThrow(/stopped making progress after 2 calls/);
  });

  test('stops at its call cap and says it is not done', () => {
    const call: Call = <T>(): T => ({ done: false, removed: { reports: 1 } }) as T;
    expect(applyClear(call)).toMatchObject({ calls: MAX_CLEAR_CALLS, done: false });
  });

  test('a photo whose file is being moved: waited for, never counted as no progress', () => {
    const { call } = answers([
      { done: false, removed: {}, waiting: 1 },
      { done: false, removed: {}, waiting: 1 },
      { done: true, removed: { photos: 4 } },
    ]);
    const waits: number[] = [];
    const run = applyClear(
      call,
      () => {},
      (ms) => waits.push(ms),
    );
    expect(run).toEqual({ calls: 3, removed: { photos: 4 }, done: true });
    expect(waits).toEqual([PHOTO_WAIT_MS, PHOTO_WAIT_MS]);
  });

  test('a rotation that never lands: the clear gives up after its waits, said plainly', () => {
    const call: Call = <T>(): T => ({ done: false, removed: {}, waiting: 1 }) as T;
    const waits: number[] = [];
    expect(() =>
      applyClear(
        call,
        () => {},
        (ms) => waits.push(ms),
      ),
    ).toThrow(
      'After 10 minutes the clear is still waiting on 1 seed photo(s) whose file is being moved. Nothing was skipped: run the clear again once that is done.',
    );
    expect(waits).toHaveLength(MAX_PHOTO_WAITS);
  });

  test('what a waiting clear waits on, in words: a rotation (and when it ends), an owed file', () => {
    expect(
      waitingOn({ done: false, removed: {}, waiting: 2, readyBy: Date.UTC(2026, 10, 23, 6, 10) }),
    ).toBe('2 seed photo(s) whose file is being moved, over by 2026-11-23T06:10:00.000Z');
    expect(waitingOn({ done: false, removed: {}, waiting: 1, owed: 1 })).toBe(
      "1 seed photo(s) with a file whose delete failed and is owed (Machinery's photoRotation job retries it)",
    );
    expect(waitingOn({ done: false, removed: {}, waiting: 3, owed: 1, readyBy: 0 })).toBe(
      "2 seed photo(s) whose file is being moved, over by 1970-01-01T00:00:00.000Z; 1 seed photo(s) with a file whose delete failed and is owed (Machinery's photoRotation job retries it)",
    );
  });

  test('sleepSync blocks for about the time asked', () => {
    const start = Date.now();
    sleepSync(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });
});

describe('a photo step', () => {
  test('its files uploaded as its person first, their ids passed; the run log holds only the result', () => {
    const calls: { fn: string; args: unknown; runAs?: RunAs }[] = [];
    let served = false;
    const call: Call = <T>(fn: string, args: unknown, runAs?: RunAs): T => {
      calls.push({ fn, args, ...(runAs ? { runAs } : {}) });
      if (fn === 'inboxSeed:ensurePeople')
        return {
          created: [],
          existing: ['gus'],
          applied: true,
          operator: { role: 'admin', status: 'active' },
        } as T;
      if (fn === 'inboxSeed:state') {
        const ready: SeedCall[] = served
          ? []
          : [
              {
                key: 'ph-1',
                label: 'a photo',
                as: 'gus',
                clerkUserId: 'seed_inbox_gus',
                fn: 'photos:create',
                args: { caption: 'c', placeOnMap: false },
                upload: true,
              },
            ];
        served = true;
        return { people: [], bodies: [], done: [], ready, waiting: [], unavailable: [] } as T;
      }
      return 'photo-1' as T;
    };
    const uploads: { key: string; runAs?: RunAs }[] = [];
    const run = applySeed(
      call,
      'user_op',
      () => {},
      (step, runAs) => {
        uploads.push({ key: step.key, ...(runAs ? { runAs } : {}) });
        return { storageId: 's-full', thumbStorageId: 's-thumb' };
      },
    );
    expect(uploads).toEqual([{ key: 'ph-1', runAs: { as: 'seed_inbox_gus', via: 'seed-inbox' } }]);
    expect(calls.find((c) => c.fn === 'photos:create')).toEqual({
      fn: 'photos:create',
      args: { caption: 'c', placeOnMap: false, storageId: 's-full', thumbStorageId: 's-thumb' },
      runAs: { as: 'seed_inbox_gus', via: 'seed-inbox' },
    });
    expect(run.waves[0]).toEqual([
      { key: 'ph-1', label: 'a photo', as: 'gus', fn: 'photos:create', result: 'photo-1' },
    ]);
  });

  test('without an uploader a photo step fails by name, and the rest go on', () => {
    let served = false;
    const call: Call = <T>(fn: string): T => {
      if (fn === 'inboxSeed:ensurePeople')
        return {
          created: [],
          existing: [],
          applied: true,
          operator: { role: 'admin', status: 'active' },
        } as T;
      if (fn === 'inboxSeed:state') {
        const ready = served
          ? []
          : [
              {
                key: 'ph-1',
                label: 'p',
                as: 'gus',
                clerkUserId: 'seed_inbox_gus',
                fn: 'photos:create',
                args: {},
                upload: true,
              },
            ];
        served = true;
        return { people: [], bodies: [], done: [], ready, waiting: [], unavailable: [] } as T;
      }
      return null as T;
    };
    const run = applySeed(call, 'user_op');
    expect(run.waves[0]?.[0]?.error).toBe('ph-1 uploads photos, and this run has no uploader.');
  });
});

describe('the small pieces', () => {
  test('errorLine takes the first non-blank line, from an error or anything thrown', () => {
    expect(errorLine(new Error('\n  first\nsecond'))).toBe('first');
    expect(errorLine('plain')).toBe('plain');
    expect(errorLine(new Error(''))).toBe('unknown error');
  });

  test('an error from anything thrown is bounded to a sentence', () => {
    expect(errorLine(new Error('y'.repeat(500)))).toHaveLength(300);
  });

  test('tally prints what moved, or nothing', () => {
    expect(tally({ reports: 2, comments: 0, profiles: 8 })).toBe('reports 2 · profiles 8');
    expect(tally({})).toBe('nothing');
  });

  test('a run log is named by its moment and mode, sortably', () => {
    expect(runLogName('apply', new Date('2026-11-21T01:02:03.456Z'))).toBe(
      '2026-11-21T01-02-03-456Z-apply.json',
    );
  });
});
