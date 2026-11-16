import { createContext, createElement, type ReactNode, useContext, useRef, useState } from 'react';

/**
 * **One queue for a whole-list write** (Links' staff links, a landmark's or a body's other
 * spellings). A whole-list write built from the list a render held can undo a write still on its
 * way. So a tab never builds the list itself: it hands the queue a *change* — "this link goes",
 * "these keys in this order" — and the queue applies it, one write at a time, to the newest list
 * the server has acknowledged (its own last acknowledged write until the server's echo of it has
 * been seen, else the server's list as last seen, which carries any other moderator's change).
 *
 * - **Every write names the list it was built on** (`send(next, base)`, the server's `expected`):
 *   another moderator's write that landed in between is refused by the server with the current
 *   list, and the queue re-applies the change on top and sends again; a change that no longer
 *   applies (its link was removed meanwhile) answers `null`, and the queue says so (`unapplied`,
 *   `'gone'`) rather than dropping it quietly — as it does for a list that kept moving (`'moved'`).
 * - A change that changes nothing sends nothing. A refused write drops its change and nothing
 *   built on it.
 * - **The queue outlives the page that pressed it** (`ListWritersProvider`): a pressed save is sent
 *   to its body whatever the page does next.
 */
export type Change<T> = (base: readonly T[]) => readonly T[] | null;

/** What a send answers: landed, refused, or the server's current list (the base moved). */
export type SendAnswer<T> = boolean | { current: readonly T[] };

/**
 * Why a change wasn't sent: `'gone'` — it no longer applies (what it changes was removed meanwhile);
 * `'moved'` — the list kept moving under it past {@link REAPPLY} re-applications.
 */
export type Unapplied = 'gone' | 'moved';

/**
 * A chip field's new value as a change by item: what it added and removed since `shown` (the list
 * the render held), applied to whatever list the queue builds on — never the whole field's value.
 */
export function chipChange(
  shown: readonly string[],
  value: readonly string[],
): (base: readonly string[]) => string[] {
  const added = value.filter((a) => !shown.includes(a));
  const removed = shown.filter((a) => !value.includes(a));
  return (base) => [
    ...base.filter((a) => !removed.includes(a)),
    ...added.filter((a) => !base.includes(a)),
  ];
}

export type ListWriter<T> = {
  /** The server's list, each time a render reads it. */
  observe: (server: readonly T[]) => void;
  /**
   * Queue a change; resolves `true` once it is saved (or changed nothing), `false` if refused or no
   * longer applicable (after `unapplied` was called).
   */
  push: (change: Change<T>) => Promise<boolean>;
};

/** How many times a change is re-applied on a list that keeps moving before the queue gives up. */
const REAPPLY = 3;

export function createListWriter<T>(
  send: (next: readonly T[], base: readonly T[]) => Promise<SendAnswer<T>>,
  same: (a: readonly T[], b: readonly T[]) => boolean = sameList,
  /** Says a change can't be re-applied on the list as it now stands (or kept moving). */
  unapplied: (why: Unapplied) => void = () => {},
): ListWriter<T> {
  let server: readonly T[] = [];
  /**
   * The last write the server acknowledged, and the server's list as last seen when it did. A list
   * seen since that differs from `seenAtAck` is newer than the acknowledgment, so it holds the
   * write (or something later); one equal to it is a render that hasn't caught up yet.
   */
  let acked: { list: readonly T[]; seenAtAck: readonly T[] } | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    observe(list) {
      server = list;
      if (acked !== null && !same(list, acked.seenAtAck)) acked = null;
    },
    push(change) {
      const run = chain.then(async () => {
        let base = acked?.list ?? server;
        for (let attempt = 0; attempt <= REAPPLY; attempt++) {
          const next = change(base);
          if (next === null) {
            unapplied('gone');
            return false;
          }
          if (same(next, base)) return true;
          const answer = await send(next, base);
          if (typeof answer === 'object') {
            // Moved underneath: the server's list is the truth now; apply the change on top of it.
            base = answer.current;
            acked = null;
            server = answer.current;
            continue;
          }
          // Already on screen (the echo rendered before the acknowledgment): the server's list is
          // the newest, and its rows carry the ids the page draws.
          if (answer) acked = same(server, next) ? null : { list: next, seenAtAck: server };
          return answer;
        }
        unapplied('moved');
        return false;
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

type Entry = {
  writer: ListWriter<unknown>;
  send: {
    current: (next: readonly unknown[], base: readonly unknown[]) => Promise<SendAnswer<unknown>>;
  };
  unapplied: { current: (why: Unapplied) => void };
};

/**
 * **Where the queues live: above the consoles** (the admin shell mounts it), one per list — keyed by
 * its body (and, for a landmark's spellings, its landmark) — so a save pressed on a page that has
 * since gone (another tab, another body, out of the Bodies area) is still sent, and coming back
 * finds the same queue, never a second one that would send it twice.
 */
const Writers = createContext<Map<string, Entry> | null>(null);

/**
 * **What a queued change names lives as long as its queue** — the ids a page gives its list's rows
 * and the lists it sent (by which it recognizes its own saves when their echo returns). A change
 * still queued names them after the page that pressed it has gone, so they live here, beside the
 * queue, keyed by its list and a name, and a page coming back adopts them; never in a component a
 * pending write outlives.
 */
const Memories = createContext<Map<string, { current: unknown }> | null>(null);

export function ListWritersProvider({ children }: { children: ReactNode }) {
  const [writers] = useState(() => new Map<string, Entry>());
  const [memories] = useState(() => new Map<string, { current: unknown }>());
  return createElement(
    Writers.Provider,
    { value: writers },
    createElement(Memories.Provider, { value: memories }, children),
  );
}

/**
 * A value kept beside the queue `key` (its `name` tells several apart): the same object for every
 * page of that list while the shell lives. Outside a `ListWritersProvider` it is the component's own,
 * started afresh when `key` names another list — never one list's value carried to the next.
 */
export function useListMemory<T>(key: string, name: string, init: () => T): { current: T } {
  const shared = useContext(Memories);
  const own = useRef<{ at: string; held: { current: T } } | null>(null);
  const at = `${key}#${name}`;
  if (shared === null) {
    if (own.current?.at !== at) own.current = { at, held: { current: init() } };
    return own.current.held;
  }
  let held = shared.get(at) as { current: T } | undefined;
  if (held === undefined) {
    held = { current: init() };
    shared.set(at, held as { current: unknown });
  }
  return held;
}

/**
 * The queue for one list: `key` names it ("links:<body>", "aliases:<landmark>"), shown the
 * server's list on every render. `send` and `unapplied` are the latest the page gave (their
 * closures name the body and say a result in its words); once the page has gone, the last ones
 * stand. Outside a `ListWritersProvider` (a story, a test of one view) the queue is the component's.
 */
export function useListWriter<T>(
  key: string,
  server: readonly T[],
  send: (next: readonly T[], base: readonly T[]) => Promise<SendAnswer<T>>,
  same: (a: readonly T[], b: readonly T[]) => boolean = sameList,
  unapplied: (why: Unapplied) => void = () => {},
): ListWriter<T>['push'] {
  const shared = useContext(Writers);
  const own = useRef<Entry | null>(null);
  let entry = shared?.get(key) ?? own.current;
  if (entry === null || entry === undefined) {
    const made: Entry = {
      send: { current: send as Entry['send']['current'] },
      unapplied: { current: unapplied },
      writer: undefined as unknown as ListWriter<unknown>,
    };
    made.writer = createListWriter<unknown>(
      (next, base) => made.send.current(next, base),
      same as (a: readonly unknown[], b: readonly unknown[]) => boolean,
      (why) => made.unapplied.current(why),
    );
    if (shared !== null) shared.set(key, made);
    else own.current = made;
    entry = made;
  }
  entry.send.current = send as Entry['send']['current'];
  entry.unapplied.current = unapplied;
  entry.writer.observe(server);
  return entry.writer.push as ListWriter<T>['push'];
}

/** Same length, same items in the same order (`===`, or the same words for plain records). */
export function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => sameItem(x, b[i] as T));
}

function sameItem(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k])
  );
}
