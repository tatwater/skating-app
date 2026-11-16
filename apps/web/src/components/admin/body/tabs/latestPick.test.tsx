import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The toasts the one write helper drew: a sender that threw is said by the store, through it. */
const toasts = vi.hoisted(() => [] as { title: string; description?: string }[]);
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: { title: string; description?: string }) => toasts.push(t),
}));

import {
  createPickStore,
  LANDED,
  outcomeOf,
  type PickOutcome,
  type PickSend,
  type PickStore,
  PickStoreContext,
  REFUSED,
  useLatestPick,
} from './latestPick';

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  toasts.length = 0;
});

/**
 * How a write answers: landed; refused and said by its write path (as `sendFor` says every one, in a
 * toast naming the body), answering `REFUSED`; or a sender that threw rather than answering.
 */
type Answer = 'ok' | 'refused' | 'thrown';

/** A write the test answers. */
type Held = { key: string; body: string; value: string; answer: (a: Answer) => void };

/**
 * One store, its sends recorded. A page's sender names the body it was composed for; a page coming
 * back hands the queue a new sender for the same body (`adopt`), as a remounted tab does. `said.path`
 * counts the refusals a write path said itself; the store's own are the toasts.
 */
function harness() {
  const held: Held[] = [];
  const said = { path: 0 };
  const store = createPickStore();
  const words = (why: string) => ({ title: 'Not saved · Mascoma Lake', description: why });
  const senderFor = (key: string, body: string) => (value: string) =>
    new Promise<PickOutcome>((resolve, reject) => {
      held.push({
        key,
        body,
        value,
        answer: (a) => {
          if (a === 'ok') resolve(LANDED);
          else if (a === 'thrown') reject(new Error('refused'));
          else {
            said.path++;
            resolve(REFUSED);
          }
        },
      });
    });
  const page = (key: string, body: string) => ({ send: senderFor(key, body), words });
  return { store, held, said, page };
}

describe('the pick store — the latest press wins', () => {
  it('Auto → Never → Auto before the first answer ends on Auto, one write at a time', async () => {
    const h = harness();
    let server = 'auto';
    const p = h.page('k', 'a');
    h.store.press('k', { value: 'never', server }, p);
    expect(h.store.shown('k', server)).toBe('never');
    h.store.press('k', { value: 'auto', server }, p);
    // Shown at once; Auto waits behind Never.
    expect(h.store.shown('k', server)).toBe('auto');
    expect(h.held.map((w) => w.value)).toEqual(['never']);
    server = 'never';
    h.held.shift()?.answer('ok');
    await settle();
    expect(h.held.map((w) => w.value)).toEqual(['auto']);
    server = 'auto';
    h.held.shift()?.answer('ok');
    await settle();
    expect(h.store.shown('k', server)).toBe('auto');
    expect(h.store.size()).toBe(0);
  });

  it('a press while one waits replaces it; the waiting one is never sent', async () => {
    const h = harness();
    const p = h.page('k', 'a');
    h.store.press('k', { value: 'b', server: 'a' }, p);
    const replaced = h.store.press('k', { value: 'c', server: 'a' }, p);
    h.store.press('k', { value: 'd', server: 'a' }, p);
    h.held.shift()?.answer('ok');
    expect(await replaced).toBeUndefined();
    await settle();
    expect(h.held.map((w) => w.value)).toEqual(['d']);
  });

  it.each(['refused', 'thrown'] as const)(
    'a refusal (%s) is said exactly once, and its press hears only that it did not land',
    async (how) => {
      const h = harness();
      const heard = h.store.press('k', { value: 'b', server: 'a' }, h.page('k', 'a'));
      h.held.shift()?.answer(how);
      const outcome = await heard;
      // No words reach the caller: the outcome is `{ landed: false }` and nothing else.
      expect(outcome).toEqual({ landed: false });
      expect(h.said.path + toasts.length).toBe(1);
      if (how === 'thrown') {
        // Said by the store, through the one write helper, in the page's words.
        expect(toasts).toEqual([
          expect.objectContaining({
            title: 'Not saved · Mascoma Lake',
            description: 'Something went wrong — check your connection and try again.',
          }),
        ]);
      }
      expect(h.store.size()).toBe(0);
    },
  );

  it('a write answers in one shape, which carries no words', () => {
    // @ts-expect-error — a write that resolves nothing is one whose refusal the store can't see.
    const silent: PickSend<string, undefined> = async () => {};
    // @ts-expect-error — nor a bare refusal string, the dialog's old shape.
    const words: PickSend<string, undefined> = async () => 'Not saved';
    // @ts-expect-error — nor a refusal carrying the server's words: those go only to the toast.
    const why: PickSend<string, undefined> = async () => ({ landed: false, why: 'Not allowed' });
    const one: PickSend<string, undefined> = async () => REFUSED;
    expect([silent, words, why, one]).toHaveLength(4);
  });

  it('a sendFor-shaped write in the one shape: `false` refused (and said), else landed; a throw passes on', async () => {
    expect(await outcomeOf(async () => false)).toBe(REFUSED);
    expect(await outcomeOf(async () => true)).toBe(LANDED);
    expect(await outcomeOf(() => undefined)).toBe(LANDED);
    await expect(
      outcomeOf(async () => {
        throw new Error('Not allowed');
      }),
    ).rejects.toThrow('Not allowed');
  });

  it('back to the verdict on its way with no one waiting, and its own reason: folded into it', async () => {
    const h = harness();
    const p = h.page('k', 'a');
    h.store.press('k', { value: 'none', server: 'open', note: 'Posted' }, p);
    h.store.press('k', { value: 'open', server: 'open' }, p);
    h.store.press('k', { value: 'none', server: 'open', note: 'Posted' }, p);
    h.held.shift()?.answer('ok');
    await settle();
    expect(h.held).toHaveLength(0);
  });

  it('back to the verdict on its way with a new reason: a write of its own', async () => {
    const h = harness();
    const p = h.page('k', 'a');
    h.store.press('k', { value: 'none', server: 'open', note: 'Posted' }, p);
    h.store.press('k', { value: 'open', server: 'open' }, p);
    h.store.press('k', { value: 'none', server: 'open', note: 'Gated' }, p);
    expect(h.store.shown('k', 'open')).toBe('none');
    h.held.shift()?.answer('ok');
    await settle();
    expect(h.held.map((w) => w.value)).toEqual(['none']);
  });

  it('a reason dialog pressing what is already on its way, with the same reason, hears that write’s answer', async () => {
    const h = harness();
    const p = h.page('k', 'a');
    const first = h.store.press('k', { value: 'none', server: 'open', note: 'Posted' }, p);
    h.store.press('k', { value: 'open', server: 'open' }, p);
    const again = h.store.press('k', { value: 'none', server: 'open', note: 'Posted' }, p);
    h.held.shift()?.answer('refused');
    expect(await again).toEqual({ landed: false });
    expect(await first).toEqual({ landed: false });
    // One write, one refusal, said once.
    expect(h.said.path + toasts.length).toBe(1);
    expect(h.held).toHaveLength(0);
  });

  // Each step: press a value on a body's control, leave or come back to the body's page, or answer
  // the oldest write out for a body — landed, refused and said by its write path, or thrown.
  type B = 'a' | 'b';
  type Op =
    | { kind: 'press'; body: B; value: string }
    | { kind: 'leave' | 'return'; body: B }
    | { kind: 'answer'; body: B; how: Answer };
  const body = fc.constantFrom<B>('a', 'b');
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      kind: fc.constant('press' as const),
      body,
      value: fc.constantFrom('x', 'y', 'z'),
    }),
    fc.record({ kind: fc.constantFrom('leave' as const, 'return' as const), body }),
    fc.record({
      kind: fc.constant('answer' as const),
      body,
      how: fc.constantFrom<Answer>('ok', 'refused', 'thrown'),
    }),
  );

  /**
   * The model: over any presses, leavings, returns and answers on two bodies' controls — one write in
   * flight per key, writes in press order and only to their own body, the latest press shown while
   * anything is out, the store empty at the end, and **every refusal said exactly once** (by its
   * write path, or by the store for a sender that threw) wherever the page has gone — its press
   * hearing only `{ landed: false }`, never the words.
   */
  const property = fc.asyncProperty(fc.array(op, { maxLength: 30 }), async (ops) => {
    const h = harness();
    toasts.length = 0;
    const server: Record<B, string> = { a: 'x', b: 'x' };
    const presses: Record<B, string[]> = { a: [], b: [] };
    const received: Record<B, string[]> = { a: [], b: [] };
    const lastOk: Record<B, boolean> = { a: true, b: true };
    const requested: Record<B, string | null> = { a: null, b: null };
    let refusals = 0;
    // An outcome that carried more than whether it landed (counted, never asserted in a detached
    // callback: an `expect` thrown there is an unhandled rejection, not a counterexample).
    let worded = 0;
    const pages: Record<B, (() => void) | null> = { a: null, b: null };
    const sends: Record<B, ReturnType<typeof h.page>> = {
      a: h.page('k:a', 'a'),
      b: h.page('k:b', 'b'),
    };
    const answer = async (b: B, how: Answer) => {
      const at = h.held.findIndex((w) => w.key === `k:${b}`);
      const w = h.held[at];
      if (w === undefined) return;
      h.held.splice(at, 1);
      expect(w.body).toBe(b);
      received[b].push(w.value);
      lastOk[b] = how === 'ok';
      if (how === 'ok') server[b] = w.value;
      else refusals++;
      w.answer(how);
      await settle();
    };
    for (const o of ops) {
      const key = `k:${o.body}`;
      if (o.kind === 'press') {
        const before = h.store.shown(key, server[o.body]);
        const sent = h.store.press(key, { value: o.value, server: server[o.body] }, sends[o.body]);
        void sent?.then((outcome) => {
          if (outcome !== undefined && Object.keys(outcome).join() !== 'landed') worded++;
        });
        presses[o.body].push(o.value);
        if (o.value !== before) requested[o.body] = o.value;
        expect(h.store.shown(key, server[o.body])).toBe(o.value);
      } else if (o.kind === 'leave') {
        pages[o.body]?.();
        pages[o.body] = null;
      } else if (o.kind === 'return') {
        if (pages[o.body] === null) {
          pages[o.body] = h.store.watch(key, () => {});
          // The page that comes back hands the queue its own sender, for the same body.
          sends[o.body] = h.page(key, o.body);
          h.store.adopt(key, sends[o.body] as never);
        }
      } else if (o.kind === 'answer') {
        await answer(o.body, o.how);
      }
      for (const b of ['a', 'b'] as const) {
        // Never two writes in flight for one control.
        expect(h.held.filter((w) => w.key === `k:${b}`).length).toBeLessThanOrEqual(1);
        expect(h.store.inFlight(`k:${b}`)).toBe(h.held.some((w) => w.key === `k:${b}`) ? 1 : 0);
        // While anything is out, the latest press shows.
        if (h.store.inFlight(`k:${b}`) === 1) {
          expect(h.store.shown(`k:${b}`, server[b])).toBe(requested[b]);
        }
      }
    }
    for (let i = 0; i < 80 && h.held.length > 0; i++) {
      await answer((h.held[0]?.key.slice(2) ?? 'a') as B, 'ok');
    }
    await settle();
    expect(h.held).toHaveLength(0);
    expect(h.store.size()).toBe(0);
    // Every refusal said exactly once; no outcome carried words.
    expect(h.said.path + toasts.length).toBe(refusals);
    expect(worded).toBe(0);
    for (const b of ['a', 'b'] as const) {
      // Press order: what the server received is the presses, in order, some skipped.
      let at = 0;
      for (const v of received[b]) {
        at = presses[b].indexOf(v, at);
        expect(at).toBeGreaterThanOrEqual(0);
        at += 1;
      }
      expect(h.store.shown(`k:${b}`, server[b])).toBe(server[b]);
      const last = presses[b].at(-1);
      if (last !== undefined && lastOk[b] && received[b].length > 0) expect(server[b]).toBe(last);
    }
  });

  /**
   * **The owner unmounts and remounts mid-flight** — since B01-3m only when the viewer leaves the
   * console (a role reload's splash keeps the owner). The old store's writes keep their own senders
   * and words: every refusal is still said exactly once, and every store drains. (Across a remount a
   * write from each store can be out at once — the accepted limit of leaving the console.)
   */
  type RemountOp =
    | { kind: 'press'; value: string }
    | { kind: 'remount' }
    | { kind: 'answer'; ok: boolean };
  const remountOp: fc.Arbitrary<RemountOp> = fc.oneof(
    fc.record({ kind: fc.constant('press' as const), value: fc.constantFrom('x', 'y') }),
    fc.record({ kind: fc.constant('remount' as const) }),
    fc.record({ kind: fc.constant('answer' as const), ok: fc.boolean() }),
  );
  const remounting = fc.asyncProperty(fc.array(remountOp, { maxLength: 24 }), async (ops) => {
    const h = harness();
    toasts.length = 0;
    const stores = [h.store];
    let server = 'x';
    let refusals = 0;
    const p = h.page('k', 'a');
    const answer = async (ok: boolean) => {
      const w = h.held.shift();
      if (w === undefined) return;
      if (ok) server = w.value;
      else refusals++;
      w.answer(ok ? 'ok' : 'refused');
      await settle();
    };
    for (const o of ops) {
      const store = stores.at(-1) as PickStore;
      if (o.kind === 'press') store.press('k', { value: o.value, server }, p);
      else if (o.kind === 'remount') stores.push(createPickStore());
      else await answer(o.ok);
      for (const s of stores) expect(s.inFlight('k')).toBeLessThanOrEqual(1);
    }
    for (let i = 0; i < 60 && h.held.length > 0; i++) await answer(true);
    await settle();
    for (const s of stores) expect(s.size()).toBe(0);
    // Every refusal, said exactly once — by its write path, wherever the console has gone.
    expect(h.said.path + toasts.length).toBe(refusals);
  });

  it.each([7, 99])(
    'the owner remounting mid-flight loses nothing (pinned seed %i)',
    async (seed) => {
      await fc.assert(remounting, { seed, numRuns: 60 });
    },
  );

  it('the owner remounting mid-flight loses nothing (a random seed, logged)', async () => {
    const seed = Date.now() % 2_147_483_647;
    console.info(`pick store remount model: seed ${seed}`);
    await fc.assert(remounting, { seed, numRuns: 60 });
  });

  it.each([1, 42, 2026])('the model holds (pinned seed %i)', async (seed) => {
    await fc.assert(property, { seed, numRuns: 60 });
  });

  it('the model holds (a random seed, logged)', async () => {
    const seed = Date.now() % 2_147_483_647;
    console.info(`pick store model: seed ${seed}`);
    await fc.assert(property, { seed, numRuns: 60 });
  });
});

const done = (): Promise<PickOutcome> => Promise.resolve(LANDED);
const words = (why: string) => ({ title: 'Not saved', description: why });

function Probe({ server, send }: { server: string; send: (v: string) => Promise<PickOutcome> }) {
  const { shown, press } = useLatestPick('probe:a', server, { send, words });
  return (
    <div>
      {['auto', 'never', 'on'].map((v) => (
        <button key={v} type="button" aria-pressed={shown === v} onClick={() => press(v)}>
          {v}
        </button>
      ))}
    </div>
  );
}

describe('useLatestPick', () => {
  it('shows each press at once and takes the server back once the writes are answered', async () => {
    const answers: (() => void)[] = [];
    const send = (_: string) => new Promise<PickOutcome>((r) => answers.push(() => r(LANDED)));
    render(<Probe server="auto" send={send} />);
    await userEvent.click(screen.getByRole('button', { name: 'never' }));
    expect(screen.getByRole('button', { name: 'never' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'auto' }));
    expect(screen.getByRole('button', { name: 'auto' })).toHaveAttribute('aria-pressed', 'true');
    await act(async () => {
      answers.shift()?.();
      await settle();
    });
    expect(answers).toHaveLength(1);
    await act(async () => {
      answers.shift()?.();
      await settle();
    });
    expect(screen.getByRole('button', { name: 'auto' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a refused press goes back to the server’s value, and the control prints nothing', async () => {
    render(<Probe server="auto" send={async () => REFUSED} />);
    await userEvent.click(screen.getByRole('button', { name: 'never' }));
    await act(settle);
    expect(screen.getByRole('button', { name: 'auto' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  /**
   * **The queue is never the component's** (the guard against Greptile's P1 on #136 coming back):
   * a control that unmounts while its write waits, and mounts again, joins the same queue — it shows
   * the press on its way, and its next press waits behind it rather than starting a second sender.
   */
  it('a control mounted again joins the queue its write still waits in', async () => {
    const sent: string[] = [];
    const answers: (() => void)[] = [];
    const send = (v: string) =>
      new Promise<PickOutcome>((r) => {
        sent.push(v);
        answers.push(() => r({ landed: true }));
      });
    const { unmount } = render(<Probe server="auto" send={send} />);
    await userEvent.click(screen.getByRole('button', { name: 'never' }));
    unmount();
    render(<Probe server="auto" send={send} />);
    expect(screen.getByRole('button', { name: 'never' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'on' }));
    expect(sent).toEqual(['never']);
    await act(async () => {
      answers.shift()?.();
      await settle();
    });
    expect(sent).toEqual(['never', 'on']);
  });

  /**
   * A queue that moves between a control's first render and its subscription (a write answering, or
   * another control's press, as a tab comes back) is drawn: the control reads the store again once
   * subscribed, never only on the next change it hears.
   */
  it('a queue that moves before the control subscribes is still drawn', () => {
    const waits = (_: string) => new Promise<PickOutcome>(() => {});
    const page = { send: waits, words };
    const store = createPickStore();
    store.press('probe:a', { value: 'never', server: 'auto' }, page);
    let moved = false;
    const racing: PickStore = {
      ...store,
      watch: (key, watcher) => {
        if (!moved) {
          moved = true;
          store.press(key, { value: 'on', server: 'auto' }, page);
        }
        return store.watch(key, watcher);
      },
    };
    render(
      <PickStoreContext.Provider value={racing}>
        <Probe server="auto" send={done} />
      </PickStoreContext.Provider>,
    );
    expect(screen.getByRole('button', { name: 'on' })).toHaveAttribute('aria-pressed', 'true');
  });
});
