import { createContext, useCallback, useContext, useState, useSyncExternalStore } from 'react';

import { toast } from '@/components/kit/toast';

/**
 * **A pick whose write is in flight: the latest press wins** — the rule for every control that
 * writes on press (a segmented control, a radio, a ruling button, a slider let go). It shows the
 * latest value pressed at once — never the server's last answer, which a newer press would be
 * compared against and dropped (Auto → Never → Auto, the second Auto ignored because the server
 * still said Auto). One write is in flight at a time; a press while one is out waits, and a newer
 * press replaces the one waiting — so writes reach the server in press order and the last one it
 * receives is the last press. Once every write has answered the control shows the server again: the
 * last press if it landed, else what the server holds.
 *
 * **Who owns a queue: the store, never the tab** (Greptile on #136). A write and the press waiting
 * behind it outlive the tab that pressed them — another tab, another body, the narrow page's way
 * back, leaving the console — so the queue lives in a {@link PickStore}, keyed by the control and
 * its body (`names-class:<body>`), beside the list queues (`ListWritersProvider` mounts both, in the
 * admin shell). A tab that mounts joins the queue already there: it shows the press on its way and a
 * new press joins the same queue, never a second sender. An entry leaves the store once its queue
 * has drained, so nothing grows across a sitting. Two browser windows on one body each have their
 * own store: between them the server's last write wins, as between two moderators (out of scope).
 *
 * **A refusal never vanishes.** A write's `send` is the latest mounted page's (its closures name the
 * body and say a result in its words: `sendFor` says one in a toast naming the body once its
 * console has gone). A refusal thrown back to the queue is handed to the controls mounted for that
 * key, to say in place; with none mounted, it is said in a toast.
 */

type Send<T, R, N> = (value: T, note: N | undefined) => Promise<R>;

type Watcher = { change: () => void; error: (why: string, value: unknown) => void };

type Entry = {
  /** What the control shows: the newest press not yet settled. */
  requested: { value: unknown };
  /** The write on its way, with what travels with it (a confirmed reason) and its answer. */
  inFlight: { value: unknown; note: unknown; answer: Promise<unknown> } | null;
  /** The one press waiting behind the write in flight, with its note and its own answer's hook. */
  waiting: { value: unknown; note: unknown; settle: (answer: Promise<unknown>) => void } | null;
  /** The latest mounted page's sender; once its page has gone, the last one stands. */
  send: Send<unknown, unknown, unknown>;
};

export type PickStore = {
  /** What a control keyed `key` shows, given the server's value. */
  shown: <T>(key: string, server: T) => T;
  /**
   * The newest press not yet settled for `key`, or `undefined` with nothing out: the same object
   * until the next press or the queue drains (a snapshot for `useSyncExternalStore`).
   */
  requested: (key: string) => { value: unknown } | undefined;
  /**
   * A press: sends (or waits behind the write in flight) when it changes what's shown, resolving
   * with its own write's answer (`undefined` when refused, or replaced before it was sent); `null`
   * when nothing was sent.
   */
  press: <T, R, N>(
    key: string,
    value: T,
    server: T,
    note: N | undefined,
    send: Send<T, R, N>,
  ) => Promise<R | undefined> | null;
  /** Hands an existing queue the latest page's sender (a page mounted, or rendered again). */
  adopt: (key: string, send: Send<unknown, unknown, unknown>) => void;
  /** A mounted control's interest in `key`: its redraw, and where a refusal is said in place. */
  watch: (key: string, watcher: Watcher) => () => void;
  /** Keys with a queue not yet drained. */
  size: () => number;
  /** Writes in flight for `key` (0 or 1). */
  inFlight: (key: string) => number;
};

export function createPickStore({
  unwatchedError = (why: string) => toast({ title: 'Not saved', description: why, tone: 'bad' }),
}: {
  /** A refusal with no control mounted to say it in place. */
  unwatchedError?: (why: string, value: unknown, key: string) => void;
} = {}): PickStore {
  const entries = new Map<string, Entry>();
  const watchers = new Map<string, Set<Watcher>>();
  const notify = (key: string) => {
    for (const w of watchers.get(key) ?? []) w.change();
  };
  const refused = (key: string, why: string, value: unknown) => {
    const here = watchers.get(key);
    if (here === undefined || here.size === 0) unwatchedError(why, value, key);
    else for (const w of here) w.error(why, value);
  };

  const dispatch = (key: string, entry: Entry, value: unknown, note: unknown): Promise<unknown> => {
    const answer = (async () => {
      try {
        return await entry.send(value, note);
      } catch (err) {
        refused(key, err instanceof Error ? err.message : String(err), value);
        return undefined;
      } finally {
        entry.inFlight = null;
        const next = entry.waiting;
        entry.waiting = null;
        if (next !== null) next.settle(dispatch(key, entry, next.value, next.note));
        // Every press answered: the server's value is the truth again, and the queue leaves.
        else if (entries.get(key) === entry) entries.delete(key);
        notify(key);
      }
    })();
    entry.inFlight = { value, note, answer };
    return answer;
  };

  return {
    shown: <T>(key: string, server: T) => {
      const entry = entries.get(key);
      return entry === undefined ? server : (entry.requested.value as T);
    },
    requested: (key) => entries.get(key)?.requested,
    press: <T, R, N>(
      key: string,
      value: T,
      server: T,
      note: N | undefined,
      send: Send<T, R, N>,
    ): Promise<R | undefined> | null => {
      const found = entries.get(key);
      const shown = found === undefined ? server : found.requested.value;
      if (Object.is(value, shown)) return null;
      const sender = send as Send<unknown, unknown, unknown>;
      const entry: Entry = found ?? {
        requested: { value },
        inFlight: null,
        waiting: null,
        send: sender,
      };
      if (found === undefined) entries.set(key, entry);
      else {
        entry.send = sender;
        entry.requested = { value };
      }
      let answer: Promise<unknown>;
      if (entry.inFlight === null) {
        answer = dispatch(key, entry, value, note);
      } else {
        // A press replaced before it was sent was never a write: its own answer is "not sent".
        entry.waiting?.settle(Promise.resolve(undefined));
        entry.waiting = null;
        if (Object.is(value, entry.inFlight.value) && Object.is(note, entry.inFlight.note)) {
          // Back to what is already on its way, with what travels with it: nothing more to send.
          // (A new reason for the same verdict is a new write: it waits, and is sent after.)
          answer = entry.inFlight.answer;
        } else {
          let settle: (a: Promise<unknown>) => void = () => {};
          answer = new Promise<unknown>((resolve) => {
            settle = (a) => resolve(a);
          });
          entry.waiting = { value, note, settle };
        }
      }
      notify(key);
      return answer as Promise<R | undefined>;
    },
    adopt: (key, send) => {
      const entry = entries.get(key);
      if (entry !== undefined) entry.send = send;
    },
    watch: (key, watcher) => {
      let set = watchers.get(key);
      if (set === undefined) {
        set = new Set();
        watchers.set(key, set);
      }
      set.add(watcher);
      return () => {
        set.delete(watcher);
        if (set.size === 0 && watchers.get(key) === set) watchers.delete(key);
      };
    },
    size: () => entries.size,
    inFlight: (key) => (entries.get(key)?.inFlight ? 1 : 0),
  };
}

/** The shell's store (`ListWritersProvider` provides it, beside the list queues). */
export const PickStoreContext = createContext<PickStore | null>(null);

/**
 * Outside a provider (a story, a test of one view): one store for the page, never a component's —
 * a queue never lives in the tab that pressed it. Tests start it afresh (`resetLatestPicks`).
 */
let loose = createPickStore();

/** Test support: a fresh store outside any provider (the unit suite's setup calls it after each test). */
export function resetLatestPicks(): void {
  loose = createPickStore();
}

/**
 * The queue `key` (the control and its body, `names-class:<body>`) for a component: `shown` to draw,
 * `press` from the control (its own answer, for a dialog that waits on it), `error` the latest
 * refusal said here, with the value it refused (cleared by the next press). `send` throws the
 * server's words on a refusal to be said in place.
 */
export function useLatestPick<T, R = unknown, N = undefined>(
  key: string,
  server: T,
  send: Send<T, R, N>,
): {
  shown: T;
  press: (value: T, note?: N) => Promise<R | undefined> | null;
  error: { why: string; value: T } | null;
} {
  const store = useContext(PickStoreContext) ?? loose;
  const [error, setError] = useState<{ why: string; value: T } | null>(null);
  // The latest page's sender, for a queue this page joined (its own presses hand it over too).
  store.adopt(key, send as Send<unknown, unknown, unknown>);
  const subscribe = useCallback(
    (change: () => void) =>
      store.watch(key, {
        change,
        error: (why, value) => setError({ why, value: value as T }),
      }),
    [store, key],
  );
  // Read through `useSyncExternalStore`, never a redraw subscribed in an effect: a queue that moves
  // between this control's first render and its subscription (a write answering as a tab comes
  // back) is read again once subscribed, so a drained queue never leaves its press drawn.
  const snapshot = () => store.requested(key);
  const requested = useSyncExternalStore(subscribe, snapshot, snapshot);
  return {
    shown: requested === undefined ? server : (requested.value as T),
    press: (value, note) => {
      setError(null);
      return store.press(key, value, server, note, send);
    },
    error,
  };
}
