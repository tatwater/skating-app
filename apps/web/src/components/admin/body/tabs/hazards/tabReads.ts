import { useQueries } from 'convex/react';
import {
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  getFunctionName,
} from 'convex/server';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

/**
 * **How a Body console tab reads, and reads again.** Shared by Imagery, Hazards, Standing and Links
 * (it belongs beside `tabParts.tsx` once the tabs are integrated).
 *
 * - **A failed read is a value, never a crash.** Each read comes back as its result, `undefined`
 *   while it is on its way, or the `Error` it failed with (Convex's `useQueries`), so a tab says in
 *   its own place what couldn't be read instead of taking the console down.
 * - **The reads are keyed on their values.** The query set is rebuilt only when a function or an
 *   argument changes — never on an object rebuilt each render, the shape that once crashed a page
 *   with "Too many re-renders".
 * - **Try again re-runs the read.** The client keeps one subscription per function and arguments,
 *   shared by every component that reads them — the tab's inspector, its map's `useData` and its
 *   dock. A failed subscription is re-run only once *every* reader lets go of it, so a retry pauses
 *   all the readers of one `key` for a commit (they read nothing, and the client drops the query),
 *   then subscribes them again: the server runs the read afresh. Readers that share a query share
 *   a key (`hazards:<bodyId>`).
 */

/** One read: a query and its arguments. Build it with {@link read} so the arguments are checked. */
export type TabRead = {
  query: FunctionReference<'query'>;
  args: FunctionArgs<FunctionReference<'query'>>;
};

/** A read's arguments typed against its function. */
export function read<F extends FunctionReference<'query'>>(
  query: F,
  args: FunctionArgs<F>,
): { query: F; args: FunctionArgs<F> } {
  return { query, args };
}

/** A read as it stands: its result, `undefined` while on its way (or skipped), or its failure. */
export type ReadResult<T> = T | undefined | Error;

type Results<S extends Record<string, TabRead | null>> = {
  [K in keyof S]: NonNullable<S[K]> extends { query: infer F extends FunctionReference<'query'> }
    ? ReadResult<FunctionReturnType<F>>
    : undefined;
};

// ── The pause a retry takes ─────────────────────────────────────────────────────────────────────

const paused = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

function emit(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

function subscribeTo(key: string) {
  return (listener: () => void) => {
    const set = listeners.get(key) ?? new Set();
    set.add(listener);
    listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(key);
    };
  };
}

/**
 * Run every read under `key` again: each reader drops its queries for one commit, then reads
 * afresh. A second call while one is under way is the same retry.
 */
export function retryReads(key: string): void {
  if (paused.has(key)) return;
  paused.add(key);
  emit(key);
}

function resume(key: string): void {
  if (!paused.delete(key)) return;
  emit(key);
}

/**
 * Whether the reads under `key` are paused for a retry, and the retry. The pause ends after the
 * commit that dropped them: each reader's effect schedules the resume, so every reader has let go
 * of its subscription before any of them takes it again.
 */
export function useReadPause(key: string): { live: boolean; retry: () => void } {
  const subscribe = useMemo(() => subscribeTo(key), [key]);
  const isPaused = useSyncExternalStore(
    subscribe,
    () => paused.has(key),
    () => false,
  );
  useEffect(() => {
    if (!isPaused) return;
    const id = setTimeout(() => resume(key), 0);
    return () => clearTimeout(id);
  }, [isPaused, key]);
  const retry = useCallback(() => retryReads(key), [key]);
  return { live: !isPaused, retry };
}

const NONE: Parameters<typeof useQueries>[0] = {};

/**
 * Read `specs` (a `null` spec is skipped and reads `undefined`), each failure as its `Error`, with
 * a retry that re-runs every read under `key` — in this component and in every other that reads
 * under it.
 */
export function useTabReads<S extends Record<string, TabRead | null>>(
  key: string,
  specs: S,
): {
  got: Results<S>;
  retry: () => void;
  /** `false` for the commit a retry pauses on: a reader outside Convex lets go too. */
  live: boolean;
} {
  const { live, retry } = useReadPause(key);
  const identity = JSON.stringify(
    Object.entries(specs).map(([k, s]) => [
      k,
      s === null ? null : getFunctionName(s.query),
      s?.args,
    ]),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the reads' value, not on the object the caller rebuilt.
  const queries = useMemo(() => {
    if (!live) return NONE;
    const out: Parameters<typeof useQueries>[0] = {};
    for (const [k, s] of Object.entries(specs)) {
      if (s !== null) out[k] = { query: s.query, args: s.args };
    }
    return out;
  }, [identity, live]);
  const got = useQueries(queries) as Results<S>;
  return { got, retry, live };
}

/** Forget every pause (tests start clean). */
export function resetReadPauses(): void {
  paused.clear();
}
