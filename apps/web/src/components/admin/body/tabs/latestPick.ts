import { useRef, useState } from 'react';

/**
 * **A pick whose write is in flight: the latest press wins.** A segmented control or radio that
 * writes on press shows the latest value pressed at once — never the server's last answer, which a
 * newer press would be compared against and dropped (Auto → Never → Auto, the second Auto ignored
 * because the server still said Auto). Each press that changes what's shown is sent, once, in press
 * order (one at a time, so the last one sent is the last one stored). Once every write has answered
 * the control shows the server again: the last press if it landed, else the last one that did. A
 * refused write is said (`onError`, the server's words) and changes nothing else.
 */
export type LatestPick<T> = {
  /** What the control shows, given the server's value. */
  shown: (server: T) => T;
  /** A press. Sends when it changes what's shown. */
  press: (value: T, server: T) => void;
  /** Writes not yet answered. */
  pending: () => number;
};

export function createLatestPick<T>(
  send: (value: T) => Promise<unknown>,
  {
    onError,
    onChange,
  }: {
    /** A refusal: the server's words, and the value it refused (so it never reads as a later press's). */
    onError: (why: string, value: T) => void;
    onChange: () => void;
  },
): LatestPick<T> {
  let requested: { value: T } | null = null;
  let pending = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const shown = (server: T) => (requested === null ? server : requested.value);
  return {
    shown,
    pending: () => pending,
    press: (value, server) => {
      if (Object.is(value, shown(server))) return;
      requested = { value };
      pending += 1;
      onChange();
      chain = chain.then(async () => {
        try {
          await send(value);
        } catch (err) {
          onError(err instanceof Error ? err.message : String(err), value);
        } finally {
          pending -= 1;
          // Every press answered: the server's value is the truth again.
          if (pending === 0) requested = null;
          onChange();
        }
      });
    },
  };
}

/**
 * {@link createLatestPick} for a component: `shown` to draw, `press` from the control, `error` the
 * latest refusal with the value it refused (cleared by the next press). `send` throws the server's
 * words on a refusal.
 */
export function useLatestPick<T>(
  server: T,
  send: (value: T) => Promise<unknown>,
): { shown: T; press: (value: T) => void; error: { why: string; value: T } | null } {
  const [, redraw] = useState(0);
  const [error, setError] = useState<{ why: string; value: T } | null>(null);
  const latest = useRef(send);
  latest.current = send;
  const pick = useRef<LatestPick<T> | null>(null);
  if (pick.current === null) {
    pick.current = createLatestPick<T>((value) => latest.current(value), {
      onError: (why, value) => setError({ why, value }),
      onChange: () => redraw((n) => n + 1),
    });
  }
  const core = pick.current;
  return {
    shown: core.shown(server),
    press: (value) => {
      setError(null);
      core.press(value, server);
    },
    error,
  };
}
