import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createLatestPick, useLatestPick } from './latestPick';

/** A write the test answers: resolved, or refused with the server's words. */
type Deferred = { value: string; ok: () => void; fail: (why: string) => void };

function harness(initial: string) {
  let server = initial;
  const inFlight: Deferred[] = [];
  const sent: string[] = [];
  const errors: string[] = [];
  const pick = createLatestPick<string>(
    (value) =>
      new Promise<void>((resolve, reject) => {
        sent.push(value);
        inFlight.push({
          value,
          ok: () => {
            server = value;
            resolve();
          },
          fail: (why) => reject(new Error(why)),
        });
      }),
    {
      onError: (why, value) => errors.push(`${value}: ${why}`),
      onChange: () => {},
    },
  );
  return {
    pick,
    inFlight,
    sent,
    errors,
    get server() {
      return server;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('a pick whose write is in flight — the latest press wins', () => {
  it('Auto → Never → Auto before the first answer ends on Auto, each press sent once in order', async () => {
    const h = harness('auto');
    h.pick.press('never', h.server);
    expect(h.pick.shown(h.server)).toBe('never');
    h.pick.press('auto', h.server);
    // Shown at once, though the server still says auto and the first write hasn't answered.
    expect(h.pick.shown(h.server)).toBe('auto');
    await settle();
    h.inFlight.shift()?.ok();
    await settle();
    expect(h.pick.shown(h.server)).toBe('auto');
    h.inFlight.shift()?.ok();
    await settle();
    expect(h.sent).toEqual(['never', 'auto']);
    expect(h.server).toBe('auto');
    expect(h.pick.shown(h.server)).toBe('auto');
  });

  it('a refused last press says so and falls back to what the server holds', async () => {
    const h = harness('auto');
    h.pick.press('never', h.server);
    await settle();
    h.inFlight.shift()?.fail('Not allowed');
    await settle();
    expect(h.errors).toEqual(['never: Not allowed']);
    expect(h.pick.shown(h.server)).toBe('auto');
  });

  // Each step: press a value, or answer the write in flight (landed or refused).
  type Op = { kind: 'press'; value: string } | { kind: 'answer'; ok: boolean };
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      kind: fc.constant('press' as const),
      value: fc.constantFrom('auto', 'never', 'always'),
    }),
    fc.record({ kind: fc.constant('answer' as const), ok: fc.boolean() }),
  );

  it('over any presses and answers, a refusal anywhere: shown is the last press, stored the last landed', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 14 }), async (ops) => {
        const h = harness('auto');
        // What the model expects: every press that changed the shown value is sent, once, in order.
        const pressed: string[] = [];
        let lastLanded = 'auto';
        let failures = 0;
        for (const o of ops) {
          if (o.kind === 'press') {
            const before = h.pick.shown(h.server);
            h.pick.press(o.value, h.server);
            if (o.value !== before) pressed.push(o.value);
            expect(h.pick.shown(h.server)).toBe(o.value);
          } else {
            await settle();
            const d = h.inFlight.shift();
            if (d === undefined) continue;
            if (o.ok) {
              d.ok();
              lastLanded = d.value;
            } else {
              d.fail('refused');
              failures++;
            }
          }
          await settle();
          // While anything is unanswered, the latest press shows.
          if (pressed.length > 0 && h.pick.pending() > 0) {
            expect(h.pick.shown(h.server)).toBe(pressed.at(-1));
          }
        }
        // Answer the rest, all landing.
        for (let i = 0; i < 40 && (h.inFlight.length > 0 || h.pick.pending() > 0); i++) {
          await settle();
          const d = h.inFlight.shift();
          if (d !== undefined) {
            d.ok();
            lastLanded = d.value;
          }
          await settle();
        }
        expect(h.sent).toEqual(pressed);
        expect(h.server).toBe(lastLanded);
        expect(h.pick.shown(h.server)).toBe(h.server);
        expect(h.errors).toHaveLength(failures);
      }),
      { numRuns: 120 },
    );
  });
});

function Probe({ server, send }: { server: string; send: (v: string) => Promise<void> }) {
  const { shown, press, error } = useLatestPick(server, send);
  return (
    <div>
      {['auto', 'never'].map((v) => (
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
    await act(async () => {
      answers.shift()?.();
      await settle();
    });
    expect(screen.getByRole('button', { name: 'auto' })).toHaveAttribute('aria-pressed', 'true');
  });
});
