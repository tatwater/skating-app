import { act, render } from '@testing-library/react';
import { ConvexError } from 'convex/values';
import fc from 'fast-check';
import { useLayoutEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

const toasts = vi.hoisted(() => [] as { title: string }[]);
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: { title: string }) => toasts.push(t),
}));

import { ListWritersProvider, sameList, useListWriter } from '../tabs/listWriter';
import { BodyTabHost } from './BodyConsoleRoute';
import { listChanged, sendFor, useBodyHold } from './currentBody';
import type { BodyTabProps } from './tabRegistry';

/**
 * **A pressed save completes against its own body; a result names its body** — proved over any
 * session, on the real `BodyBindingProvider`, `BodyTabHost`, `ListWritersProvider`, queue and
 * `sendFor`. A route-like shell mounts the console's binding above its loading and tab branches;
 * the queues live above the route, as the admin shell mounts them. Over arbitrary sequences of
 * opening a body (cached, uncached, failing), its read arriving, switching tab, typing a draft,
 * pressing one save or several, a save answered late (landed or refused), another moderator's
 * change underneath, leaving and coming back, and remounting the route:
 *
 * - every pressed save reaches the body it was composed for exactly once (or its refusal is said)
 *   — none is dropped, none is sent twice, nothing is resurrected on return;
 * - a draft never pressed never reaches any body; a pressed one only its own;
 * - no receipt or refusal surfaces without naming its body unless its own console is on screen.
 */

const NAMES: Record<string, string> = { A: 'Lake Alpha', B: 'Bravo Pond', C: 'Crystal Lake' };
type Instance = { body: string; gen: number };

type World = {
  gen: number;
  live: Instance | null;
  /** Each body's stored list, and its writes on their way. */
  server: Record<string, string[]>;
  pending: { body: string; next: string[]; base: string[]; settle: (ok: boolean) => void }[];
  /** Every save pressed: its body, and how it ended. */
  pressed: Map<string, { body: string; landed: number; refusedSaid: boolean }>;
  violations: string[];
  type: ((text: string) => void) | null;
  press: ((n: number) => void) | null;
  one: (() => void) | null;
  saves: number;
  /** The server checks `expected` (every whole-list write has it now; one example turns it off). */
  cas: boolean;
};
const world: World = {
  gen: 0,
  live: null,
  server: {},
  pending: [],
  pressed: new Map(),
  violations: [],
  type: null,
  press: null,
  one: null,
  saves: 0,
  cas: true,
};

const onScreen = (me: Instance) =>
  world.live !== null && world.live.body === me.body && world.live.gen === me.gen;

/** A result put on screen: its body named, or its own console the one on screen. */
function surface(me: Instance, subject: string | undefined, what: string) {
  if (subject !== NAMES[me.body] && !onScreen(me)) {
    world.violations.push(`${what} for ${me.body} surfaced unnamed while it is not on screen`);
  }
}

/** An off-screen refusal is said only by a toast naming its body, raised since `from`. */
function toasted(from: number, body: string): boolean {
  const said = toasts.slice(from).some((t) => t.title.includes(NAMES[body] as string));
  if (!said) world.violations.push(`a refusal for ${body} off its console was swallowed`);
  return said;
}

/** The server: a whole-list write for one body, refused when its base moved (`expected`). */
function write(body: string, next: string[], base: string[]): Promise<void> {
  for (const id of next) {
    // Another moderator's own items ride along on a list re-applied on top of theirs.
    if (id.startsWith('other#')) continue;
    const p = world.pressed.get(id);
    if (p === undefined) world.violations.push(`${body} was sent ${id}, which nobody pressed`);
    else if (p.body !== body)
      world.violations.push(`${id}, composed for ${p.body}, was sent to ${body}`);
  }
  return new Promise<void>((resolve, reject) => {
    world.pending.push({
      body,
      next,
      base,
      settle: (ok) => {
        const stored = world.server[body] ?? [];
        if (!ok) return reject(new ConvexError('refused'));
        if (world.cas && !sameList(base, stored)) {
          return reject(
            new ConvexError({ code: 'list_changed', message: 'moved', current: stored }),
          );
        }
        for (const id of next) {
          const p = world.pressed.get(id);
          if (p !== undefined && !stored.includes(id)) p.landed++;
        }
        world.server[body] = next;
        resolve();
      },
    });
  });
}

function ProbeTab({ bodyId }: BodyTabProps) {
  const [me] = useState<Instance>(() => ({ body: bodyId, gen: ++world.gen }));
  const hold = useBodyHold();
  const [draft, setDraft] = useState<string | null>(null);
  const said = (ids: readonly string[]) => (subject: string | undefined) => {
    surface(me, subject, 'a refusal');
    for (const id of ids) {
      const p = world.pressed.get(id);
      if (p !== undefined) p.refusedSaid = true;
    }
  };
  const push = useListWriter<string>(
    `probe:${bodyId}`,
    world.server[bodyId] ?? [],
    async (next, base) => {
      let landed = false;
      const from = toasts.length;
      try {
        await sendFor(hold, {
          body: bodyId,
          write: () =>
            write(bodyId, [...next], [...base]).then(() => {
              landed = true;
            }),
          receipt: async (subject) => surface(me, subject, 'a receipt'),
          what: 'The list',
        });
        // Resolved but not landed: refused off its console, and said in a toast (checked below).
        if (!landed && toasted(from, bodyId)) {
          said(next.filter((id) => !base.includes(id)))(NAMES[bodyId]);
        }
        return landed;
      } catch (err) {
        const current = listChanged(err);
        if (current !== null) return { current: current as string[] };
        // Said in place: this console is on screen (`sendFor` throws only then).
        said(next.filter((id) => !base.includes(id)))(NAMES[bodyId]);
        return false;
      }
    },
  );
  useLayoutEffect(() => {
    world.live = me;
    world.type = (text) => setDraft(`${me.body}:${text}`);
    return () => {
      if (world.live === me) world.live = null;
      world.type = null;
    };
  }, [me]);
  // Re-registered each render, so a press takes the draft as it stands now.
  world.press = (n) => {
    for (let i = 0; i < n; i++) {
      const id = `${draft ?? me.body}#${++world.saves}`;
      world.pressed.set(id, { body: me.body, landed: 0, refusedSaid: false });
      void push((base) => [...base, id]);
    }
    setDraft(null);
  };
  world.one = () => {
    const id = `${me.body}:one#${++world.saves}`;
    world.pressed.set(id, { body: me.body, landed: 0, refusedSaid: false });
    let landed = false;
    const from = toasts.length;
    const base = [...(world.server[bodyId] ?? [])];
    void sendFor(hold, {
      body: bodyId,
      write: () =>
        write(bodyId, [...base, id], base).then(() => {
          landed = true;
        }),
      receipt: async (subject) => surface(me, subject, 'a receipt'),
      what: 'The change',
    }).then(
      () => {
        if (!landed && toasted(from, bodyId)) said([id])(NAMES[bodyId]);
      },
      () => said([id])(NAMES[bodyId]),
    );
  };
  return null;
}
const OtherTab = (props: BodyTabProps) => <ProbeTab {...props} />;

type Shell = {
  body: string | null;
  state: 'ready' | 'loading' | 'failed';
  tab: 'a' | 'b';
  shell: number;
};

function Route({ body, state, tab }: Omit<Shell, 'shell'>) {
  if (body === null) return <p>Elsewhere in the console</p>;
  if (state === 'loading') return <p>Loading</p>;
  if (state === 'failed') return <p>This body couldn’t be read</p>;
  return (
    <BodyTabHost
      key={tab}
      Wiring={tab === 'a' ? ProbeTab : OtherTab}
      bodyId={body}
      name={NAMES[body]}
    />
  );
}
const Root = ({ s }: { s: Shell }) => (
  <ListWritersProvider>
    <Route key={s.shell} body={s.body} state={s.state} tab={s.tab} />
  </ListWritersProvider>
);

type Op =
  | { kind: 'open'; body: 'A' | 'B' | 'C'; as: 'cached' | 'uncached' | 'fails' }
  | { kind: 'arrive' }
  | { kind: 'tab' }
  | { kind: 'type' }
  | { kind: 'press'; n: number }
  | { kind: 'one' }
  | { kind: 'answer'; ok: boolean }
  | { kind: 'other'; body: 'A' | 'B' }
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
  fc.record({ kind: fc.constant('type' as const) }),
  fc.record({ kind: fc.constant('press' as const), n: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ kind: fc.constant('one' as const) }),
  fc.record({ kind: fc.constant('answer' as const), ok: fc.boolean() }),
  fc.record({ kind: fc.constant('answer' as const), ok: fc.constant(true) }),
  fc.record({
    kind: fc.constant('other' as const),
    body: fc.constantFrom('A' as const, 'B' as const),
  }),
  fc.record({ kind: fc.constant('away' as const) }),
  fc.record({ kind: fc.constant('back' as const) }),
  fc.record({ kind: fc.constant('remount' as const) }),
);

const settle = () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });

async function session(ops: readonly Op[]): Promise<string[]> {
  Object.assign(world, {
    gen: 0,
    live: null,
    server: {},
    pending: [],
    pressed: new Map(),
    violations: [],
    type: null,
    press: null,
    one: null,
    saves: 0,
    cas: true,
  });
  toasts.length = 0;
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
      } else if (o.kind === 'type' && world.live !== null) {
        await act(async () => world.type?.('draft'));
      } else if (o.kind === 'press' && world.live !== null) {
        await act(async () => world.press?.(o.n));
        await settle();
      } else if (o.kind === 'one' && world.live !== null) {
        await act(async () => world.one?.());
        await settle();
      } else if (o.kind === 'answer') {
        world.pending.shift()?.settle(o.ok);
        await settle();
      } else if (o.kind === 'other') {
        // Another moderator's write to that body's list.
        world.server[o.body] = [...(world.server[o.body] ?? []), `other#${++world.saves}`];
        await settle();
      } else if (o.kind === 'away') {
        await show({ ...s, body: null });
      } else if (o.kind === 'back' && last !== null) {
        await show({ ...s, body: last, state: 'ready' });
      } else if (o.kind === 'remount') {
        await show({ ...s, shell: s.shell + 1 });
      }
    }
    // Everything still on its way lands.
    for (let i = 0; i < 60 && world.pending.length > 0; i++) {
      world.pending.shift()?.settle(true);
      await settle();
    }
  } finally {
    unmount();
  }
  for (const [id, p] of world.pressed) {
    if (p.landed > 1) world.violations.push(`${id} landed ${p.landed} times`);
    if (p.landed === 0 && !p.refusedSaid) world.violations.push(`${id} was pressed and dropped`);
  }
  // A refusal said off its console names its body.
  for (const t of toasts) {
    if (!Object.values(NAMES).some((n) => t.title.includes(n))) {
      world.violations.push(`a toast said "${t.title}" without its body`);
    }
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
const TAB_SWITCH: Op[] = [
  { kind: 'open', body: 'A', as: 'cached' },
  { kind: 'press', n: 2 },
  { kind: 'tab' },
  { kind: 'answer', ok: true },
  { kind: 'answer', ok: true },
];

describe('a pressed save completes against its own body (fast-check, model-based)', () => {
  it('Greptile’s sequence: two saves queued on A, then an uncached B — both reach A', async () => {
    expect(await session(GREPTILE)).toEqual([]);
    expect(world.server.A).toHaveLength(2);
    expect(world.server.B ?? []).toEqual([]);
  });

  it('a tab switch on the same body loses no pressed save', async () => {
    expect(await session(TAB_SWITCH)).toEqual([]);
    expect(world.server.A).toHaveLength(2);
  });

  it('A, then a body that fails to load: A’s refusal is said, naming A', async () => {
    const ops: Op[] = [
      { kind: 'open', body: 'A', as: 'cached' },
      { kind: 'press', n: 1 },
      { kind: 'open', body: 'C', as: 'fails' },
      { kind: 'answer', ok: false },
    ];
    expect(await session(ops)).toEqual([]);
    expect(toasts.map((t) => t.title)).toEqual(['Not saved · Lake Alpha']);
  });

  it('A, leave the Bodies area, come back: the queue is the same one — nothing sent twice', async () => {
    const ops: Op[] = [
      { kind: 'open', body: 'A', as: 'cached' },
      { kind: 'press', n: 3 },
      { kind: 'away' },
      { kind: 'back' },
      { kind: 'press', n: 1 },
    ];
    expect(await session(ops)).toEqual([]);
    expect(world.server.A).toHaveLength(4);
  });

  it('another moderator’s change underneath: the save is re-applied on top, never lost', async () => {
    const ops: Op[] = [
      { kind: 'open', body: 'A', as: 'cached' },
      { kind: 'press', n: 1 },
      { kind: 'other', body: 'A' },
      { kind: 'open', body: 'B', as: 'uncached' },
    ];
    expect(await session(ops)).toEqual([]);
    expect(world.server.A).toHaveLength(2);
  });

  it('one queue per body above the pages: on a list with no compare-and-set, a save pressed on a tab opened since never overwrites one still on its way', async () => {
    // Two queues for one body (one per tab instance) would each build on the list they last saw:
    // the later write, built before the earlier landed, would drop it. The queue is the body's.
    const ops: Op[] = [
      { kind: 'open', body: 'A', as: 'cached' },
      { kind: 'press', n: 1 },
      { kind: 'tab' },
      { kind: 'press', n: 1 },
    ];
    const run = session(ops);
    world.cas = false;
    expect(await run).toEqual([]);
    expect(world.server.A).toHaveLength(2);
  });

  it('a draft typed on A and never pressed reaches no body', async () => {
    const ops: Op[] = [
      { kind: 'open', body: 'A', as: 'cached' },
      { kind: 'type' },
      { kind: 'open', body: 'B', as: 'cached' },
      { kind: 'press', n: 1 },
    ];
    expect(await session(ops)).toEqual([]);
    expect(world.server.B).toEqual([expect.stringMatching(/^B#/)]);
  });

  it('over any session: every pressed save reaches its own body once, and every result names its body', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 24 }), async (ops) => {
        expect(await session(ops)).toEqual([]);
      }),
      { numRuns: 100, examples: [[GREPTILE], [TAB_SWITCH]] },
    );
  });
});
