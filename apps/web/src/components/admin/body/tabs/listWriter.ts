import { useRef } from 'react';

/**
 * **One queue for a tab's whole-list writes** (Links' staff links, a landmark's other spellings).
 * A whole-list write built from the list a render held can undo a write still on its way: a
 * reorder saving while Remove is pressed, the remove built from the old order, lands second and
 * puts the old order back. So a tab never builds the list itself. It hands the queue a *change* —
 * "this link goes", "these keys in this order" — and the queue applies it, one write at a time, to
 * the newest list the server has acknowledged:
 *
 * - the queue's own last acknowledged write, until the server's echo of it has been seen (an
 *   acknowledgment can land a beat before the render that shows it);
 * - otherwise the server's list as last seen, which carries any other moderator's change — and
 *   always once that list already shows the write when it is acknowledged (the console's usual
 *   order: Convex shows a write before its promise resolves, and the receipt is a further round
 *   trip), so a tab's own ids for the rows it draws are the ones its next change names.
 *
 * A change that changes nothing sends nothing. A refused write drops its change and nothing built
 * on it — the next change applies to what the server holds.
 *
 * **The one race it can't close.** Another moderator's write that commits while one of ours is in
 * flight is overwritten by ours, which was built before it: the server's writers take whole lists
 * and no version to compare against. That is the server's to close (a compare-and-set), and the
 * phase doc's server register asks for it.
 */
export type ListWriter<T> = {
  /** The server's list, each time a render reads it. */
  observe: (server: readonly T[]) => void;
  /** Queue a change; resolves `true` once it is saved (or changed nothing), `false` if refused. */
  push: (change: (base: readonly T[]) => readonly T[]) => Promise<boolean>;
};

export function createListWriter<T>(
  send: (next: readonly T[]) => Promise<boolean>,
  same: (a: readonly T[], b: readonly T[]) => boolean = sameList,
  /**
   * The console's binding (`frame/currentBody`): checked before every step — before a queued
   * change is taken up, before it is sent, before its answer is taken in — so a queue whose console
   * has gone sends nothing more and says nothing. The binding never revives.
   */
  alive: () => boolean = () => true,
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
        if (!alive()) return false;
        const base = acked?.list ?? server;
        const next = change(base);
        if (same(next, base)) return true;
        if (!alive()) return false;
        const ok = await send(next);
        if (!alive()) return false;
        // Already on screen (the echo rendered before the acknowledgment): the server's list is the
        // newest, and its rows carry the ids the page draws. Holding `next` instead would keep
        // building on ids no row has — a row added here, then edited, would change nothing.
        if (ok) acked = same(server, next) ? null : { list: next, seenAtAck: server };
        return ok;
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

/**
 * The hook: one writer for the component's life, shown the server's list on every render. `same`
 * says when two lists save the same (Links' rows carry page-only ids, which it must ignore).
 */
export function useListWriter<T>(
  server: readonly T[],
  send: (next: readonly T[]) => Promise<boolean>,
  same: (a: readonly T[], b: readonly T[]) => boolean = sameList,
  alive: () => boolean = () => true,
): ListWriter<T>['push'] {
  // The latest `send` (its closure holds the latest props), reached through a ref so the writer
  // and its queue outlive renders.
  const sendRef = useRef(send);
  sendRef.current = send;
  const writer = useRef<ListWriter<T> | null>(null);
  if (writer.current === null)
    writer.current = createListWriter<T>((next) => sendRef.current(next), same, alive);
  writer.current.observe(server);
  return writer.current.push;
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
