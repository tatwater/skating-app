import { act, render } from '@testing-library/react';
import fc from 'fast-check';
import { useLayoutEffect, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { sameList, useListWriter } from '../tabs/listWriter';
import { BodyTabHost } from './BodyConsoleRoute';
import { BodyBindingProvider, sendFor, useBodyBound } from './currentBody';
import type { BodyTabProps } from './tabRegistry';

/**
 * **The binding, proved over any run of a session** — not by example. A route-like shell mounts the
 * real `BodyBindingProvider` above its loading and tab branches and the real `BodyTabHost` for the
 * open tab; each tab instance queues saves through the real `useListWriter` and sends through the
 * real `sendFor`, bound by the real `useBodyBound`. Over arbitrary sequences of opening a body
 * (cached, uncached, failing), its read arriving, switching tab, pressing one save or several, a
 * save resolving or failing late, leaving and coming back, and remounting the shell:
 *
 * - no write is ever sent unless the tab instance that composed it is the one mounted now;
 * - a queued save whose console went away is dropped, never sent — and coming back to its body
 *   (a new console) never resurrects it;
 * - no receipt or error is surfaced unless the tab instance it belongs to is the one on screen.
 */

type Instance = { body: string; gen: number };
type World = {
  gen: number;
  live: Instance | null;
  pending: { resolve: (ok: boolean) => void }[];
  violations: string[];
  sent: number;
  surfaced: number;
  press: ((n: number) => void) | null;
  one: (() => void) | null;
};

const world: World = {
  gen: 0,
  live: null,
  pending: [],
  violations: [],
  sent: 0,
  surfaced: 0,
  press: null,
  one: null,
};

const sameInstance = (a: Instance | null, b: Instance) =>
  a !== null && a.body === b.body && a.gen === b.gen;

/** The server: a write is checked against the tab mounted now, then waits for the test's answer. */
function server(from: Instance): Promise<void> {
  world.sent++;
  if (!sameInstance(world.live, from)) {
    world.violations.push(
      `sent for ${from.body}#${from.gen} while ${world.live ? `${world.live.body}#${world.live.gen}` : 'no console'} is mounted`,
    );
  }
  return new Promise<void>((resolve, reject) => {
    world.pending.push({ resolve: (ok) => (ok ? resolve() : reject(new Error('refused'))) });
  });
}

/** A receipt, an error or an Undo put on screen: checked against the tab on screen now. */
function surface(from: Instance, what: string) {
  world.surfaced++;
  if (!sameInstance(world.live, from)) {
    world.violations.push(
      `${what} for ${from.body}#${from.gen} surfaced while ${world.live ? `${world.live.body}#${world.live.gen}` : 'no console'} is on screen`,
    );
  }
}

/** A tab with a queue (as Links and Places' spellings) and a one-shot write (as Standing's form). */
function ProbeTab({ bodyId }: BodyTabProps) {
  const [me] = useState<Instance>(() => ({ body: bodyId, gen: ++world.gen }));
  const here = useBodyBound();
  const bound = () =>
    sendFor(
      here,
      () => server(me),
      async () => surface(me, 'receipt'),
    ).catch(() => {
      // `sendFor` throws only while the binding holds: the tab shows the refusal.
      surface(me, 'error');
    });
  const push = useListWriter<string>(
    [],
    async () => {
      try {
        await sendFor(
          here,
          () => server(me),
          async () => surface(me, 'receipt'),
        );
        return true;
      } catch {
        surface(me, 'error');
        return false;
      }
    },
    sameList,
    here,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: registered once, for this instance's life
  useLayoutEffect(() => {
    world.live = me;
    let k = 0;
    world.press = (n) => {
      for (let i = 0; i < n; i++) void push((base) => [...base, `${me.body}#${me.gen}:${++k}`]);
    };
    world.one = () => void bound();
    return () => {
      if (world.live === me) world.live = null;
      world.press = null;
      world.one = null;
    };
  }, []);
  return null;
}
const OtherTab = (props: BodyTabProps) => <ProbeTab {...props} />;

type Shell = {
  body: string | null;
  state: 'ready' | 'loading' | 'failed';
  tab: 'a' | 'b';
  shell: number;
};

/** The route's shape: the console's binding above its branches, the open tab in its host. */
function Route({ body, state, tab }: Omit<Shell, 'shell'>) {
  if (body === null) return <p>Elsewhere in the console</p>;
  return (
    <BodyBindingProvider bodyId={body}>
      {state === 'loading' ? (
        <p>Loading</p>
      ) : state === 'failed' ? (
        <p>This body couldn’t be read</p>
      ) : (
        <BodyTabHost key={tab} Wiring={tab === 'a' ? ProbeTab : OtherTab} bodyId={body} />
      )}
    </BodyBindingProvider>
  );
}
const Root = ({ s }: { s: Shell }) => (
  <Route key={s.shell} body={s.body} state={s.state} tab={s.tab} />
);

type Op =
  | { kind: 'open'; body: 'A' | 'B' | 'C'; as: 'cached' | 'uncached' | 'fails' }
  | { kind: 'arrive' }
  | { kind: 'tab' }
  | { kind: 'press'; n: number }
  | { kind: 'one' }
  | { kind: 'answer'; ok: boolean }
  | { kind: 'away' }
  | { kind: 'back' }
  | { kind: 'remount' };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('open' as const),
    body: fc.constantFrom('A' as const, 'B' as const, 'C' as const),
    as: fc.constantFrom('cached' as const, 'uncached' as const, 'fails' as const),
  }),
  fc.record({ kind: fc.constant('arrive' as const) }),
  fc.record({ kind: fc.constant('tab' as const) }),
  fc.record({ kind: fc.constant('press' as const), n: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ kind: fc.constant('one' as const) }),
  fc.record({ kind: fc.constant('answer' as const), ok: fc.boolean() }),
  fc.record({ kind: fc.constant('answer' as const), ok: fc.constant(true) }),
  fc.record({ kind: fc.constant('away' as const) }),
  fc.record({ kind: fc.constant('back' as const) }),
  fc.record({ kind: fc.constant('remount' as const) }),
);

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

/** Runs one session; returns what it violated. */
async function session(ops: readonly Op[]): Promise<string[]> {
  Object.assign(world, {
    gen: 0,
    live: null,
    pending: [],
    violations: [],
    sent: 0,
    surfaced: 0,
    press: null,
    one: null,
  });
  let s: Shell = { body: null, state: 'ready', tab: 'a', shell: 0 };
  let last: string | null = null;
  const { rerender, unmount } = render(<Root s={s} />);
  const show = async (next: Shell) => {
    s = next;
    rerender(<Root s={s} />);
    await settle();
  };
  try {
    for (const o of ops) {
      if (o.kind === 'open') {
        last = o.body;
        await show({
          ...s,
          body: o.body,
          state: o.as === 'cached' ? 'ready' : o.as === 'uncached' ? 'loading' : 'failed',
        });
      } else if (o.kind === 'arrive' && s.state === 'loading') {
        await show({ ...s, state: 'ready' });
      } else if (o.kind === 'tab' && s.body !== null && s.state === 'ready') {
        await show({ ...s, tab: s.tab === 'a' ? 'b' : 'a' });
      } else if (o.kind === 'press') {
        world.press?.(o.n);
        await settle();
      } else if (o.kind === 'one') {
        world.one?.();
        await settle();
      } else if (o.kind === 'answer') {
        const p = world.pending.shift();
        p?.resolve(o.ok);
        await settle();
      } else if (o.kind === 'away') {
        await show({ ...s, body: null });
      } else if (o.kind === 'back' && last !== null) {
        await show({ ...s, body: last, state: 'ready' });
      } else if (o.kind === 'remount') {
        await show({ ...s, shell: s.shell + 1 });
      }
    }
    // Whatever is still on its way lands, and whatever a dead queue held stays dropped.
    for (let i = 0; i < 40 && world.pending.length > 0; i++) {
      world.pending.shift()?.resolve(true);
      await settle();
    }
  } finally {
    unmount();
  }
  return [...world.violations];
}

/** Greptile's sequence: two saves queued on A, then an uncached B. */
const GREPTILE: Op[] = [
  { kind: 'open', body: 'A', as: 'cached' },
  { kind: 'press', n: 2 },
  { kind: 'open', body: 'B', as: 'uncached' },
  { kind: 'answer', ok: true },
  { kind: 'answer', ok: true },
];

describe('the body binding, over any session (fast-check, model-based)', () => {
  it('Greptile’s sequence: two saves queued on A, then an uncached B — the second is never sent', async () => {
    expect(await session(GREPTILE)).toEqual([]);
    // The first save was on its way and landed; the queued second never went out.
    expect(world.sent).toBe(1);
    expect(world.surfaced).toBe(0);
  });

  it('A, then a body that fails to load: A’s queue dies there', async () => {
    const ops: Op[] = [
      { kind: 'open', body: 'A', as: 'cached' },
      { kind: 'press', n: 2 },
      { kind: 'open', body: 'C', as: 'fails' },
      { kind: 'answer', ok: false },
      { kind: 'answer', ok: true },
    ];
    expect(await session(ops)).toEqual([]);
    expect(world.sent).toBe(1);
  });

  it('A, leave the Bodies area, come back to A: the old queue is not resurrected', async () => {
    const ops: Op[] = [
      { kind: 'open', body: 'A', as: 'cached' },
      { kind: 'press', n: 3 },
      { kind: 'away' },
      { kind: 'back' },
      { kind: 'answer', ok: true },
      { kind: 'answer', ok: true },
      { kind: 'answer', ok: true },
    ];
    expect(await session(ops)).toEqual([]);
    expect(world.sent).toBe(1);
  });

  it('a one-shot write (Standing’s form) started on A says nothing over an uncached B', async () => {
    const ops: Op[] = [
      { kind: 'open', body: 'A', as: 'cached' },
      { kind: 'one' },
      { kind: 'open', body: 'B', as: 'uncached' },
      { kind: 'arrive' },
      { kind: 'answer', ok: false },
    ];
    expect(await session(ops)).toEqual([]);
    expect(world.surfaced).toBe(0);
  });

  it('over any session, nothing is sent or surfaced for a console that is not on screen', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 24 }), async (ops) => {
        expect(await session(ops)).toEqual([]);
      }),
      { numRuns: 200, examples: [[GREPTILE]] },
    );
  });
});
