import * as Sentry from '@sentry/tanstackstart-react';
import { useQueries } from 'convex/react';
import {
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  getFunctionName,
} from 'convex/server';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { isConfigured } from '@/lib/env';

/**
 * **The Body console's reads, each with its own state.** Every block of the console draws one of
 * three things for its read — the read on its way (`undefined`, a skeleton), the read failed (a
 * {@link ReadFailure}: a note with *Try again*), or what the read returned — so a read that fails
 * takes down its own block, never the console.
 *
 * Convex's `useQueries` hands a failed read back as an `Error` rather than throwing it, and keeps
 * the failure while the subscription lives — and one subscription per read is shared by every
 * block holding it (the frame and the open tab both read the bays, the extras and the touching
 * bodies). *Try again* lets go of the read **everywhere it is held** for one commit, then every
 * holder subscribes afresh, so the server runs the read again.
 *
 * The reads are keyed on their **values** — the function's name and its arguments — never on an
 * object rebuilt each render: a new object every render re-subscribes every render, which crashed a
 * page with "Too many re-renders".
 */

/** A read that failed, and the way to run it again. Stable while the same failure stands. */
export interface ReadFailure {
  readonly failed: true;
  readonly retry: () => void;
}

/** What a block draws from: the read on its way, failed, or its answer. */
export type Loadable<T> = T | undefined | ReadFailure;

export function isFailed(value: unknown): value is ReadFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { failed?: unknown }).failed === true &&
    typeof (value as { retry?: unknown }).retry === 'function'
  );
}

/** A loaded value, or `undefined` while it loads or after it failed. */
export function loaded<T>(value: Loadable<T>): T | undefined {
  return isFailed(value) ? undefined : (value as T | undefined);
}

/** Maps a loaded value; loading and failure pass through as they are. */
export function mapLoadable<T, U>(value: Loadable<T>, map: (v: T) => U): Loadable<U> {
  if (value === undefined) return undefined;
  if (isFailed(value)) return value;
  return map(value as T);
}

type AnyQuery = FunctionReference<'query'>;

/** One read: a query and its arguments. */
export interface ReadSpec<Q extends AnyQuery = AnyQuery> {
  query: Q;
  args: FunctionArgs<Q>;
}

/** A read, typed by its query: the arguments must be the query's own. */
export function read<Q extends AnyQuery>(query: Q, args: FunctionArgs<Q>): ReadSpec<Q> {
  return { query, args };
}

/** The reads a block asks for, by name; `null` is a read not asked for (skipped). */
export type ReadSpecs = Record<string, ReadSpec | null>;

type ResultOf<S> = S extends ReadSpec<infer Q> ? FunctionReturnType<Q> : never;

/** Each read's state: `undefined` while it loads (or was skipped), a failure, or its answer. */
export type Reads<S extends ReadSpecs> = { [K in keyof S]: Loadable<ResultOf<S[K]>> };

/** Reports a failed read to Sentry once (only with a DSN): a failure drawn as a note is still heard. */
const reported = new WeakSet<Error>();
function report(error: Error): void {
  if (reported.has(error)) return;
  reported.add(error);
  if (isConfigured.sentry) Sentry.captureException(error);
}

// ── The reads let go of for a Try again ─────────────────────────────────────────────────────
//
// By the read's identity (its function and arguments), across every hook holding it: the client
// re-runs a failed subscription only once every holder has let go of it.

const paused = new Set<string>();
let pauseVersion = 0;
const pauseListeners = new Set<() => void>();

function emitPause(): void {
  pauseVersion++;
  for (const listener of pauseListeners) listener();
}

function subscribePause(listener: () => void): () => void {
  pauseListeners.add(listener);
  return () => {
    pauseListeners.delete(listener);
  };
}

const pauseSnapshot = () => pauseVersion;

/** How long a read stays let go if no holder takes it back (its one holder unmounted mid-retry). */
const PAUSE_LIMIT_MS = 1_000;

/** A read's identity: its function and its arguments, as values. */
const readIdOf = (spec: ReadSpec): string =>
  JSON.stringify([getFunctionName(spec.query), spec.args]);

/** Let go of a read in every hook holding it; the holders take it back after that commit. */
function pauseRead(id: string): void {
  if (paused.has(id)) return;
  paused.add(id);
  emitPause();
  setTimeout(() => resumeReads([id]), PAUSE_LIMIT_MS);
}

function resumeReads(ids: Iterable<string>): void {
  let any = false;
  for (const id of ids) if (paused.delete(id)) any = true;
  if (any) emitPause();
}

export function useConsoleReads<S extends ReadSpecs>(specs: S): Reads<S> {
  // Every holder renders again when a read is let go of or taken back.
  useSyncExternalStore(subscribePause, pauseSnapshot, pauseSnapshot);
  const ids = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) {
    if (spec !== null) ids.set(name, readIdOf(spec));
  }
  const key = JSON.stringify(
    Object.keys(specs).map((name) => {
      const id = ids.get(name);
      return [name, id === undefined || paused.has(id) ? null : id];
    }),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the reads' value, not the object.
  const queries = useMemo(() => {
    const out: Parameters<typeof useQueries>[0] = {};
    for (const [name, spec] of Object.entries(specs)) {
      const id = ids.get(name);
      if (spec !== null && id !== undefined && !paused.has(id)) {
        out[name] = { query: spec.query, args: spec.args };
      }
    }
    return out;
  }, [key]);
  const got = useQueries(queries) as Record<string, unknown>;

  // Declared after `useQueries`, so this holder has dropped the read by the time it runs; taken
  // back a task later, once every other holder has committed its drop too, so the client lets go
  // of the subscription and the next one is asked afresh.
  const letGo = [...ids.values()].filter((id) => paused.has(id));
  const letGoKey = letGo.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on which reads are let go, by value.
  useEffect(() => {
    if (letGo.length === 0) return;
    const timer = setTimeout(() => resumeReads(letGo), 0);
    return () => clearTimeout(timer);
  }, [letGoKey]);

  // A failure keeps its identity while the same error stands, so a block's props don't churn.
  const failures = useRef(new Map<string, { error: Error; failure: ReadFailure }>());
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(specs)) {
    const value = got[name];
    const id = ids.get(name);
    if (value instanceof Error && id !== undefined) {
      let held = failures.current.get(name);
      if (held === undefined || held.error !== value) {
        held = { error: value, failure: { failed: true, retry: () => pauseRead(id) } };
        failures.current.set(name, held);
      }
      out[name] = held.failure;
    } else {
      failures.current.delete(name);
      out[name] = value;
    }
  }

  const errors = Object.values(got).filter((v): v is Error => v instanceof Error);
  useEffect(() => {
    for (const e of errors) report(e);
  });

  return out as Reads<S>;
}
