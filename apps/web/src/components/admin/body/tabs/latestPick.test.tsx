import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type Asker,
  createPickStore,
  outcomeOf,
  type PickOutcome,
  type PickSend,
  type PickStore,
  PickStoreContext,
  SAID,
  useLatestPick,
} from './latestPick';

const settle = () => new Promise((r) => setTimeout(r, 0));

/** How a write answers: landed; refused (returned, or thrown); or refused and said by its path. */
type Answer = 'ok' | 'returned' | 'thrown' | 'said';

/** A write the test answers. */
type Held = { key: string; body: string; value: string; answer: (a: Answer) => void };

/**
 * One store, its sends recorded. A page's sender names the body it was composed for; a page coming
 * back hands the queue a new sender for the same body (`adopt`), as a remounted tab does. `said`
 * counts the refusals the page's own words said (`say`), and the ones a write path said itself.
 */
function harness() {
  const held: Held[] = [];
  const said = { page: 0, path: 0 };
  const store = createPickStore();
  const say = () => {
    said.page++;
  };
  const senderFor = (key: string, body: string) => (value: string) =>
    new Promise<PickOutcome>((resolve, reject) => {
      held.push({
        key,
        body,
        value,
        answer: (a) => {
          if (a === 'ok') resolve({ landed: true });
          else if (a === 'returned') resolve({ landed: false, why: 'refused' });
          else if (a === 'thrown') reject(new Error('refused'));
          else {
            said.path++;
            resolve({ landed: false, why: '', said: true });
          }
        },
      });
    });
  const page = (key: string, body: string) => ({ send: senderFor(key, body), say });
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

  it.each(['returned', 'thrown'] as const)(
    'a refusal %s is one thing: the asker there hears it; gone, a control in place; else the page',
    async (how) => {
      const h = harness();
      const p = h.page('k', 'a');
      const asker = { alive: true };
      const ask: Asker = { here: () => asker.alive };
      const heard = h.store.press('k', { value: 'b', server: 'a', asker: ask }, p);
      h.held.shift()?.answer(how);
      expect(await heard).toEqual({ landed: false, why: 'refused' });
      expect(h.said.page).toBe(0);
      // The asker gone, a control mounted that says refusals in place hears it.
      const inPlace: string[] = [];
      const stop = h.store.watch('k', { change: () => {}, error: (why) => inPlace.push(why) });
      asker.alive = false;
      const gone = h.store.press('k', { value: 'b', server: 'a', asker: ask }, p);
      h.held.shift()?.answer(how);
      expect(await gone).toMatchObject({ landed: false, said: true });
      expect(inPlace).toEqual(['refused']);
      stop();
      // No one there at all: the page's words.
      h.store.press('k', { value: 'b', server: 'a' }, p);
      h.held.shift()?.answer(how);
      await settle();
      expect(h.said.page).toBe(1);
      expect(h.store.size()).toBe(0);
    },
  );

  it('a write answers in one shape: one that answers nothing does not compile', () => {
    // @ts-expect-error — a write that resolves nothing is one whose refusal the store can't see.
    const silent: PickSend<string, undefined> = async () => {};
    // @ts-expect-error — nor a bare refusal string, the dialog's old shape.
    const words: PickSend<string, undefined> = async () => 'Not saved';
    const one: PickSend<string, undefined> = async () => ({ landed: false, why: 'Not allowed' });
    expect([silent, words, one]).toHaveLength(3);
  });

  it('a sendFor-shaped write in the one shape: `false` said, a throw the words, else landed', async () => {
    expect(await outcomeOf(async () => false)).toBe(SAID);
    expect(await outcomeOf(async () => true)).toEqual({ landed: true });
    expect(await outcomeOf(() => undefined)).toEqual({ landed: true });
    expect(
      await outcomeOf(async () => {
        throw new Error('Not allowed');
      }),
    ).toEqual({ landed: false, why: 'Not allowed' });
    expect(
      await outcomeOf(() => {
        throw 'plain';
      }),
    ).toEqual({ landed: false, why: 'plain' });
  });

  it('a refusal its write path already said is said by no one else', async () => {
    const h = harness();
    const heard = h.store.press(
      'k',
      { value: 'b', server: 'a', asker: { here: () => true } },
      h.page('k', 'a'),
    );
    h.held.shift()?.answer('said');
    expect(await heard).toMatchObject({ landed: false, said: true });
    expect(h.said).toEqual({ page: 0, path: 1 });
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

  it('back to the verdict on its way with a new reason, or an asker waiting: a write of its own', async () => {
    const h = harness();
    const p = h.page('k', 'a');
    h.store.press('k', { value: 'none', server: 'open', note: 'Posted' }, p);
    h.store.press('k', { value: 'none', server: 'open', note: 'Gated' }, p);
    expect(h.store.shown('k', 'open')).toBe('none');
    h.store.press('k', { value: 'open', server: 'open' }, p);
    h.store.press(
      'k',
      { value: 'none', server: 'open', note: 'Posted', asker: { here: () => true } },
      p,
    );
    h.held.shift()?.answer('ok');
    await settle();
    expect(h.held.map((w) => w.value)).toEqual(['none']);
  });

  // Each step: press a value on a body's control (from an opening that waits on its answer, or
  // not), close that opening, leave or come back to the body's page, or answer the oldest write
  // out for a body — landed, refused returned or thrown, or refused and said by its write path.
  type B = 'a' | 'b';
  type Op =
    | { kind: 'press'; body: B; value: string; asked: boolean }
    | { kind: 'close' | 'leave' | 'return'; body: B }
    | { kind: 'answer'; body: B; how: Answer };
  const body = fc.constantFrom<B>('a', 'b');
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      kind: fc.constant('press' as const),
      body,
      value: fc.constantFrom('x', 'y', 'z'),
      asked: fc.boolean(),
    }),
    fc.record({
      kind: fc.constantFrom('close' as const, 'leave' as const, 'return' as const),
      body,
    }),
    fc.record({
      kind: fc.constant('answer' as const),
      body,
      how: fc.constantFrom<Answer>('ok', 'returned', 'thrown', 'said'),
    }),
  );

  /**
   * The model: over any presses, openings closed, leavings, returns and answers on two bodies'
   * controls — one write in flight per key, writes in press order and only to their own body, the
   * latest press shown while anything is out, and **every refusal said exactly once, by an audience
   * still there** (the asker while open; else body a's control, which says refusals in place, while
   * mounted; else the page's words; or the write path that said it) — and the store empty at the end.
   */
  const property = fc.asyncProperty(fc.array(op, { maxLength: 30 }), async (ops) => {
    const h = harness();
    const server: Record<B, string> = { a: 'x', b: 'x' };
    const presses: Record<B, string[]> = { a: [], b: [] };
    const received: Record<B, string[]> = { a: [], b: [] };
    const lastOk: Record<B, boolean> = { a: true, b: true };
    const requested: Record<B, string | null> = { a: null, b: null };
    let refusals = 0;
    let heardByAsker = 0;
    let heardInPlace = 0;
    // A refusal handed to an audience no longer there: the asker gone, or a page that has left.
    let misheard = 0;
    // Body a's control says refusals in place while mounted; body b's has no place to say one.
    const pages: Record<B, (() => void) | null> = { a: null, b: null };
    const askers: Record<B, { alive: boolean }[]> = { a: [], b: [] };
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
        const asker = { alive: true };
        if (o.asked) askers[o.body].push(asker);
        const sent = h.store.press(
          key,
          {
            value: o.value,
            server: server[o.body],
            ...(o.asked && { asker: { here: () => asker.alive } }),
          },
          sends[o.body],
        );
        void sent?.then((outcome) => {
          if (outcome !== undefined && !outcome.landed && outcome.said !== true) {
            // Heard by the asker: it was there. (Counted, never asserted here: an `expect` thrown in
            // a detached callback is an unhandled rejection, not a counterexample fast-check sees.)
            if (o.asked && asker.alive) heardByAsker++;
            else misheard++;
          }
        });
        presses[o.body].push(o.value);
        if (o.value !== before) requested[o.body] = o.value;
        expect(h.store.shown(key, server[o.body])).toBe(o.value);
      } else if (o.kind === 'close') {
        const last = askers[o.body].pop();
        if (last !== undefined) last.alive = false;
      } else if (o.kind === 'leave') {
        pages[o.body]?.();
        pages[o.body] = null;
        for (const a of askers[o.body]) a.alive = false;
        askers[o.body] = [];
      } else if (o.kind === 'return') {
        if (pages[o.body] === null) {
          pages[o.body] = h.store.watch(key, {
            change: () => {},
            ...(o.body === 'a' && {
              error: () => {
                if (pages.a !== null) heardInPlace++;
                else misheard++;
              },
            }),
          });
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
    // Every refusal, exactly one audience — and that one still there.
    expect(misheard).toBe(0);
    expect(heardByAsker + heardInPlace + h.said.page + h.said.path).toBe(refusals);
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
    const stores = [h.store];
    let server = 'x';
    let refusals = 0;
    const p = h.page('k', 'a');
    const answer = async (ok: boolean) => {
      const w = h.held.shift();
      if (w === undefined) return;
      if (ok) server = w.value;
      else refusals++;
      w.answer(ok ? 'ok' : 'returned');
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
    // No page is mounted in this model: every refusal is the page's words, said exactly once.
    expect(h.said.page).toBe(refusals);
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

const done = (): Promise<PickOutcome> => Promise.resolve({ landed: true });

function Probe({
  server,
  send,
  say = () => {},
}: {
  server: string;
  send: (v: string) => Promise<PickOutcome>;
  say?: (why: string) => void;
}) {
  const { shown, press, error } = useLatestPick('probe:a', server, { send, say, inPlace: true });
  return (
    <div>
      {['auto', 'never', 'on'].map((v) => (
        <button key={v} type="button" aria-pressed={shown === v} onClick={() => press(v)}>
          {v}
        </button>
      ))}
      {error !== null && <p role="alert">{error.why}</p>}
    </div>
  );
}

describe('useLatestPick', () => {
  it('shows each press at once and takes the server back once the writes are answered', async () => {
    const answers: (() => void)[] = [];
    const send = (_: string) =>
      new Promise<PickOutcome>((r) => answers.push(() => r({ landed: true })));
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

  it('a control that says refusals in place says one there, and the page’s words stay quiet', async () => {
    const said: string[] = [];
    render(
      <Probe
        server="auto"
        send={async () => ({ landed: false, why: 'Not allowed' })}
        say={(why) => said.push(why)}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'never' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not allowed');
    expect(said).toEqual([]);
    expect(screen.getByRole('button', { name: 'auto' })).toHaveAttribute('aria-pressed', 'true');
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
    const page = { send: waits, say: () => {} };
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
