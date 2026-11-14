import { useQueries } from 'convex/react';
import {
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  getFunctionName,
} from 'convex/server';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

/**
 * **How the Body console's tabs read** (Names, Places, Access and Water): every server read a tab
 * makes, as one `useQueries` call keyed on the reads' *values* — never on an object rebuilt each
 * render, which re-subscribes on every render and once crashed a page with "Too many re-renders".
 *
 * Each read comes back in three states and never throws into React: `undefined` while it loads,
 * {@link FAILED} when the server refused or failed it, else its value (`null` in a value is the
 * server's *not recorded*). A read passed as `null` is not made (a capability the viewer lacks).
 *
 * **Trying again.** A failed Convex subscription stays failed until nobody holds it, so `retry`
 * drops every failed read — in this hook and in every other hook holding it, the tab's map drawing
 * included (one module-level set) — for {@link RETRY_GAP_MS}, then subscribes again, and the server
 * runs it afresh. While it waits the read is loading, so the tab says so. A read the console's frame
 * also holds is re-run only once the frame lets go of it too.
 */

/** A read's state: loading (`undefined`), failed, or its value. */
export type Loaded<T> = T | undefined | typeof FAILED;

/** A read the server refused or failed. */
export const FAILED = 'failed' as const;

/** How long a read is let go before it is asked again: long enough for React to commit the drop. */
export const RETRY_GAP_MS = 50;

type AnyQuery = FunctionReference<'query'>;

/** One read: a public query and its arguments. */
export type ReadSpec<Q extends AnyQuery = AnyQuery> = { query: Q; args: FunctionArgs<Q> };

/** A read, typed by its query (so its result is too). */
export function read<Q extends AnyQuery>(query: Q, args: FunctionArgs<Q>): ReadSpec<Q> {
  return { query, args };
}

type Specs = Record<string, ReadSpec | null>;

export type ReadsOf<S extends Specs> = {
  [K in keyof S]: S[K] extends ReadSpec<infer Q> ? Loaded<FunctionReturnType<Q>> : undefined;
};

// ── The reads let go of while a retry waits ─────────────────────────────────────────────────

const paused = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => version;

/** A read's identity: its function and its arguments, as values. */
export function readId(spec: ReadSpec): string {
  return `${getFunctionName(spec.query)}:${JSON.stringify(spec.args)}`;
}

/** Let go of these reads everywhere, then ask for them again after {@link RETRY_GAP_MS}. */
export function retryReads(ids: readonly string[]): void {
  const fresh = ids.filter((id) => !paused.has(id));
  if (fresh.length === 0) return;
  for (const id of fresh) paused.add(id);
  emit();
  setTimeout(() => {
    for (const id of fresh) paused.delete(id);
    emit();
  }, RETRY_GAP_MS);
}

/**
 * The tab's reads, each `undefined` (loading), {@link FAILED} or its value, and `retry`, which asks
 * again for every read that failed. Each value keeps its identity until the server's answer
 * changes, so a memo over them holds.
 */
export function useTabReads<S extends Specs>(specs: S): { reads: ReadsOf<S>; retry: () => void } {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const entries = Object.entries(specs).flatMap(([key, spec]) =>
    spec === null ? [] : [{ key, spec, id: readId(spec) }],
  );
  const live = entries.filter((e) => !paused.has(e.id));
  const liveKey = JSON.stringify(live.map((e) => [e.key, e.id]));
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the reads' value, not on the objects rebuilt each render.
  const queries = useMemo(() => {
    const out: Parameters<typeof useQueries>[0] = {};
    for (const { key, spec } of live) out[key] = { query: spec.query, args: spec.args };
    return out;
  }, [liveKey]);
  const got = useQueries(queries) as Record<string, unknown>;
  const reads: Record<string, unknown> = {};
  const failed: string[] = [];
  for (const key of Object.keys(specs)) {
    const value = got[key];
    if (value instanceof Error) {
      reads[key] = FAILED;
      const entry = entries.find((e) => e.key === key);
      if (entry !== undefined) failed.push(entry.id);
    } else {
      reads[key] = value;
    }
  }
  const failedKey = failed.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on which reads failed, by value.
  const retry = useCallback(() => retryReads(failed), [failedKey]);
  return { reads: reads as ReadsOf<S>, retry };
}
