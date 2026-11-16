import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createPickStore, useLatestPick } from './latestPick';

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A write the test answers: landed, or refused with the server's words. */
type Held = { key: string; body: string; value: string; ok: () => void; fail: () => void };

/**
 * One store, its sends recorded. A page's sender names the body it was composed for; a page coming
 * back hands the queue a new sender for the same body (`adopt`), as a remounted tab does.
 */
function harness() {
  const held: Held[] = [];
  const unwatched: string[] = [];
  const store = createPickStore({ unwatchedError: (why) => unwatched.push(why) });
  const senderFor = (key: string, body: string) => (value: string) =>
    new Promise<void>((resolve, reject) => {
      held.push({ key, body, value, ok: resolve, fail: () => reject(new Error('refused')) });
    });
  return { store, held, unwatched, senderFor };
}

describe('the pick store — the latest press wins', () => {
  it('Auto → Never → Auto before the first answer ends on Auto, one write at a time', async () => {
    const h = harness();
    let server = 'auto';
    const send = h.senderFor('k', 'a');
    h.store.press('k', 'never', server, undefined, send);
    expect(h.store.shown('k', server)).toBe('never');
    h.store.press('k', 'auto', server, undefined, send);
    // Shown at once; back to what is already… not on its way: Auto waits behind Never.
    expect(h.store.shown('k', server)).toBe('auto');
    expect(h.held.map((w) => w.value)).toEqual(['never']);
    server = 'never';
    h.held.shift()?.ok();
    await settle();
    expect(h.held.map((w) => w.value)).toEqual(['auto']);
    server = 'auto';
    h.held.shift()?.ok();
    await settle();
    expect(h.store.shown('k', server)).toBe('auto');
    expect(h.store.size()).toBe(0);
  });

  it('a press while one waits replaces it; the waiting one is never sent', async () => {
    const h = harness();
    const send = h.senderFor('k', 'a');
    h.store.press('k', 'b', 'a', undefined, send);
    const replaced = h.store.press('k', 'c', 'a', undefined, send);
    h.store.press('k', 'd', 'a', undefined, send);
    h.held.shift()?.ok();
    expect(await replaced).toBeUndefined();
    await settle();
    expect(h.held.map((w) => w.value)).toEqual(['d']);
  });

  it('a refusal with no control mounted is said, never dropped; one mounted hears it in place', async () => {
    const h = harness();
    const heard: string[] = [];
    h.store.press('k', 'b', 'a', undefined, h.senderFor('k', 'a'));
    h.held.shift()?.fail();
    await settle();
    expect(h.unwatched).toEqual(['refused']);
    const stop = h.store.watch('k', { change: () => {}, error: (why) => heard.push(why) });
    h.store.press('k', 'b', 'a', undefined, h.senderFor('k', 'a'));
    h.held.shift()?.fail();
    await settle();
    expect(heard).toEqual(['refused']);
    expect(h.unwatched).toHaveLength(1);
    stop();
    expect(h.store.size()).toBe(0);
  });

  // Each step: press a value on a body's control, leave or come back to its page, or answer the
  // oldest write out for a body (landed or refused).
  type Op =
    | { kind: 'press'; body: 'a' | 'b'; value: string }
    | { kind: 'leave' | 'return'; body: 'a' | 'b' }
    | { kind: 'answer'; body: 'a' | 'b'; ok: boolean };
  const body = fc.constantFrom('a' as const, 'b' as const);
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      kind: fc.constant('press' as const),
      body,
      value: fc.constantFrom('x', 'y', 'z'),
    }),
    fc.record({ kind: fc.constantFrom('leave' as const, 'return' as const), body }),
    fc.record({ kind: fc.constant('answer' as const), body, ok: fc.boolean() }),
  );

  /**
   * The model: over any presses, leavings, returns and answers on two bodies' controls — one
   * write in flight per key, writes in press order and only to their own body, the shown value the
   * last press while anything is out, a refusal always said, and the store empty once all answer.
   */
  const property = fc.asyncProperty(fc.array(op, { maxLength: 30 }), async (ops) => {
    const h = harness();
    type B = 'a' | 'b';
    const server: Record<B, string> = { a: 'x', b: 'x' };
    const presses: Record<B, string[]> = { a: [], b: [] };
    const received: Record<B, string[]> = { a: [], b: [] };
    const lastOk: Record<B, boolean> = { a: true, b: true };
    let refusals = 0;
    let heard = 0;
    const pages: Record<B, (() => void) | null> = { a: null, b: null };
    const sends: Record<B, (v: string) => Promise<void>> = {
      a: h.senderFor('k:a', 'a'),
      b: h.senderFor('k:b', 'b'),
    };
    const answer = async (b: B, ok: boolean) => {
      const at = h.held.findIndex((w) => w.key === `k:${b}`);
      const w = h.held[at];
      if (w === undefined) return;
      h.held.splice(at, 1);
      expect(w.body).toBe(b);
      received[b].push(w.value);
      lastOk[b] = ok;
      if (ok) {
        server[b] = w.value;
        w.ok();
      } else {
        refusals++;
        w.fail();
      }
      await settle();
    };
    for (const o of ops) {
      const key = `k:${o.body}`;
      if (o.kind === 'press') {
        h.store.press(key, o.value, server[o.body], undefined, sends[o.body]);
        presses[o.body].push(o.value);
        expect(h.store.shown(key, server[o.body])).toBe(o.value);
      } else if (o.kind === 'leave') {
        pages[o.body]?.();
        pages[o.body] = null;
      } else if (o.kind === 'return') {
        if (pages[o.body] === null) {
          pages[o.body] = h.store.watch(key, { change: () => {}, error: () => heard++ });
          // The page that comes back hands the queue its own sender, for the same body.
          sends[o.body] = h.senderFor(key, o.body);
          h.store.adopt(key, sends[o.body] as never);
        }
      } else if (o.kind === 'answer') {
        await answer(o.body, o.ok);
      }
      // Never two writes in flight for one control.
      for (const b of ['a', 'b'] as const) {
        expect(h.held.filter((w) => w.key === `k:${b}`).length).toBeLessThanOrEqual(1);
        expect(h.store.inFlight(`k:${b}`)).toBe(h.held.some((w) => w.key === `k:${b}`) ? 1 : 0);
      }
    }
    // Everything still out lands.
    for (let i = 0; i < 80 && h.held.length > 0; i++)
      await answer((h.held[0]?.key.slice(2) ?? 'a') as B, true);
    expect(h.held).toHaveLength(0);
    expect(h.store.size()).toBe(0);
    // A refusal is always said: in place where a page heard it, else in a toast.
    expect(heard + h.unwatched.length).toBe(refusals);
    for (const b of ['a', 'b'] as const) {
      // Press order: what the server received is the presses, in order, some skipped.
      let at = 0;
      for (const v of received[b]) {
        at = presses[b].indexOf(v, at);
        expect(at).toBeGreaterThanOrEqual(0);
        at += 1;
      }
      expect(h.store.shown(`k:${b}`, server[b])).toBe(server[b]);
      // The last answer landed: the server holds the last press.
      const last = presses[b].at(-1);
      if (last !== undefined && lastOk[b] && received[b].length > 0) expect(server[b]).toBe(last);
    }
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

function Probe({ server, send }: { server: string; send: (v: string) => Promise<void> }) {
  const { shown, press, error } = useLatestPick('probe:a', server, send);
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
    const send = (_: string) => new Promise<void>((r) => answers.push(r));
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

  /**
   * **The queue is never the component's** (the guard against Greptile's P1 on #136 coming back):
   * a control that unmounts while its write waits, and mounts again, joins the same queue — it shows
   * the press on its way, and its next press waits behind it rather than starting a second sender.
   */
  it('a control mounted again joins the queue its write still waits in', async () => {
    const sent: string[] = [];
    const answers: (() => void)[] = [];
    const send = (v: string) =>
      new Promise<void>((r) => {
        sent.push(v);
        answers.push(r);
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
});
