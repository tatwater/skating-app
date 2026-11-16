import { createContext, useCallback, useContext, useState, useSyncExternalStore } from 'react';

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
 * **A refusal is said once, by someone still there** (Greptile on #136, again). Every write answers
 * the store in one shape, {@link PickOutcome} — landed, or refused in the server's words (or already
 * said by the write path, as `sendFor` says one off its console) — never a value the store can't
 * read as a refusal. A refusal goes to exactly one audience: the opening that asked (a reason
 * dialog, its {@link Asker}) while it is still there; else a control for the key that says refusals
 * in place, mounted and with its place drawn when the answer comes; else the page's own words
 * (`say`: a toast naming the body and what wasn't saved). The sender and `say` are the latest
 * mounted page's; the asker stays the press's own.
 */

/** Every answer a write gives the store. `said`: refused, and already said by the write path. */
export type PickOutcome = { landed: true } | { landed: false; why: string; said?: boolean };

/** Refused, and already said by the write path (`sendFor` off its page, naming the body). */
export const SAID: PickOutcome = Object.freeze({ landed: false, why: '', said: true });

/**
 * A `sendFor`-shaped write in the one shape: `false` is a refusal its path has already said; a throw
 * is the server's words, for the store to hand to whoever is still there; anything else landed.
 */
export async function outcomeOf(write: () => unknown): Promise<PickOutcome> {
  try {
    return (await write()) === false ? SAID : { landed: true };
  } catch (err) {
    return { landed: false, why: err instanceof Error ? err.message : String(err) };
  }
}

/** The opening that asked for a press (a reason dialog): its answer is its own while it is there. */
export type Asker = { here: () => boolean };

/** A control's write: one answer shape, so a refusal is never one the store can't see. */
export type PickSend<T, N> = (value: T, note: N | undefined) => Promise<PickOutcome>;

type Watcher = {
  change: () => void;
  error?: (why: string, value: unknown) => void;
  /** Where that error is drawn: asked when the answer comes, never "mounted". */
  here?: () => boolean;
};

type Press = { value: unknown; note: unknown; asker: Asker | undefined };

type Entry = {
  /** What the control shows: the newest press not yet settled. */
  requested: { value: unknown };
  /** The write on its way, and its answer. */
  inFlight: (Press & { answer: Promise<PickOutcome | undefined> }) | null;
  /** The one press waiting behind the write in flight, and its own answer's hook. */
  waiting: (Press & { settle: (answer: Promise<PickOutcome | undefined>) => void }) | null;
  /** The latest mounted page's sender and words; once its page has gone, the last ones stand. */
  send: PickSend<unknown, unknown>;
  say: (why: string) => void;
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
   * with its own write's outcome (`undefined` when replaced before it was sent) — a refusal said
   * elsewhere resolves `said`; `null` when nothing was sent.
   */
  press: <T, N>(
    key: string,
    press: { value: T; server: T; note?: N; asker?: Asker },
    page: { send: PickSend<T, N>; say: (why: string) => void },
  ) => Promise<PickOutcome | undefined> | null;
  /** Hands an existing queue the latest page's sender and words (a page mounted, or rendered again). */
  adopt: (
    key: string,
    page: { send: PickSend<unknown, unknown>; say: (why: string) => void },
  ) => void;
  /** A mounted control's interest in `key`: its redraw, and `error` if it says refusals in place. */
  watch: (key: string, watcher: Watcher) => () => void;
  /** Keys with a queue not yet drained. */
  size: () => number;
  /** Writes in flight for `key` (0 or 1). */
  inFlight: (key: string) => number;
};

export function createPickStore(): PickStore {
  const entries = new Map<string, Entry>();
  const watchers = new Map<string, Set<Watcher>>();
  const notify = (key: string) => {
    for (const w of watchers.get(key) ?? []) w.change();
  };
  /** A refusal no asker is there to hear: one control that says it in place, else the page's words. */
  const sayElsewhere = (key: string, entry: Entry, why: string, value: unknown) => {
    const inPlace = [...(watchers.get(key) ?? [])].find(
      (w) => w.error !== undefined && (w.here === undefined || w.here()),
    );
    if (inPlace?.error !== undefined) inPlace.error(why, value);
    else entry.say(why);
  };

  const dispatch = (key: string, entry: Entry, press: Press): Promise<PickOutcome | undefined> => {
    const answer = (async (): Promise<PickOutcome> => {
      let outcome: PickOutcome;
      try {
        outcome = await entry.send(press.value, press.note);
      } catch (err) {
        // A sender that threw rather than answering is a refusal all the same.
        outcome = { landed: false, why: err instanceof Error ? err.message : String(err) };
      }
      try {
        if (outcome.landed || outcome.said === true) return outcome;
        // The asker that is still there says it; else someone still there does, once.
        if (press.asker?.here() === true) return outcome;
        sayElsewhere(key, entry, outcome.why, press.value);
        return { ...outcome, said: true };
      } finally {
        entry.inFlight = null;
        const next = entry.waiting;
        entry.waiting = null;
        if (next !== null) next.settle(dispatch(key, entry, next));
        // Every press answered: the server's value is the truth again, and the queue leaves.
        else if (entries.get(key) === entry) entries.delete(key);
        notify(key);
      }
    })();
    entry.inFlight = { ...press, answer };
    return answer;
  };

  return {
    shown: <T>(key: string, server: T) => {
      const entry = entries.get(key);
      return entry === undefined ? server : (entry.requested.value as T);
    },
    requested: (key) => entries.get(key)?.requested,
    press: (key, { value, server, note, asker }, page) => {
      const found = entries.get(key);
      const shown = found === undefined ? server : found.requested.value;
      if (Object.is(value, shown)) return null;
      const send = page.send as PickSend<unknown, unknown>;
      const entry: Entry = found ?? {
        requested: { value },
        inFlight: null,
        waiting: null,
        send,
        say: page.say,
      };
      if (found === undefined) entries.set(key, entry);
      else {
        entry.send = send;
        entry.say = page.say;
        entry.requested = { value };
      }
      const press: Press = { value, note, asker };
      let answer: Promise<PickOutcome | undefined>;
      if (entry.inFlight === null) {
        answer = dispatch(key, entry, press);
      } else {
        // A press replaced before it was sent was never a write: its own answer is "not sent".
        entry.waiting?.settle(Promise.resolve(undefined));
        entry.waiting = null;
        const back =
          asker === undefined &&
          entry.inFlight.asker === undefined &&
          Object.is(value, entry.inFlight.value) &&
          Object.is(note, entry.inFlight.note);
        if (back) {
          // Back to what is already on its way, nobody waiting on its answer: nothing more to send.
          // (A new reason, or an opening that waits for its own answer, is a new write.)
          answer = entry.inFlight.answer;
        } else {
          let settle: (a: Promise<PickOutcome | undefined>) => void = () => {};
          answer = new Promise((resolve) => {
            settle = (a) => resolve(a);
          });
          entry.waiting = { ...press, settle };
        }
      }
      notify(key);
      return answer;
    },
    adopt: (key, page) => {
      const entry = entries.get(key);
      if (entry === undefined) return;
      entry.send = page.send;
      entry.say = page.say;
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
 * `press` from the control (its own outcome, for an opening that waits on it — pass the opening as
 * its `asker`), `error` the latest refusal said here, with the value it refused (only for a control
 * that says refusals in place, `inPlace`; cleared by the next press). `send` answers in the one
 * shape; `say` is the page's words for a refusal no one else is there to say.
 */
export function useLatestPick<T, N = undefined>(
  key: string,
  server: T,
  {
    send,
    say,
    inPlace,
  }: {
    send: PickSend<T, N>;
    say: (why: string) => void;
    /** The control that says refusals in place: its drawn place (`usePlace`). */
    inPlace?: { here: () => boolean };
  },
): {
  shown: T;
  press: (value: T, note?: N, asker?: Asker) => Promise<PickOutcome | undefined> | null;
  error: { why: string; value: T } | null;
} {
  const store = useContext(PickStoreContext) ?? loose;
  const [error, setError] = useState<{ why: string; value: T } | null>(null);
  // The latest page's sender and words, for a queue this page joined (its presses hand them over too).
  store.adopt(key, { send: send as PickSend<unknown, unknown>, say });
  const subscribe = useCallback(
    (change: () => void) =>
      store.watch(key, {
        change,
        ...(inPlace !== undefined && {
          error: (why: string, value: unknown) => setError({ why, value: value as T }),
          here: inPlace.here,
        }),
      }),
    [store, key, inPlace],
  );
  // Read through `useSyncExternalStore`, never a redraw subscribed in an effect: a queue that moves
  // between this control's first render and its subscription (a write answering as a tab comes
  // back) is read again once subscribed, so a drained queue never leaves its press drawn.
  const snapshot = () => store.requested(key);
  const requested = useSyncExternalStore(subscribe, snapshot, snapshot);
  return {
    shown: requested === undefined ? server : (requested.value as T),
    press: (value, note, asker) => {
      setError(null);
      return store.press(key, { value, server, note, asker }, { send, say });
    },
    error,
  };
}
