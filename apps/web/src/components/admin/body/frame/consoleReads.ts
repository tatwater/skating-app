import * as Sentry from '@sentry/tanstackstart-react';
import { useQueries } from 'convex/react';
import {
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  getFunctionName,
} from 'convex/server';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isConfigured } from '@/lib/env';

/**
 * **The Body console's reads, each with its own state.** Every block of the console draws one of
 * three things for its read — the read on its way (`undefined`, a skeleton), the read failed (a
 * {@link ReadFailure}: a note with *Try again*), or what the read returned — so a read that fails
 * takes down its own block, never the console.
 *
 * Convex's `useQueries` hands a failed read back as an `Error` rather than throwing it, and keeps
 * the failure while the subscription lives. *Try again* drops that one subscription for a render
 * and subscribes afresh, so the server runs the read again. (Another block subscribed to the same
 * read keeps it alive; it re-runs when what it read changes, as every Convex read does.)
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

export function useConsoleReads<S extends ReadSpecs>(specs: S): Reads<S> {
  // Reads to drop for one render, so the next subscribes afresh (*Try again*).
  const [paused, setPaused] = useState<ReadonlySet<string>>(() => new Set());
  const key = JSON.stringify(
    Object.entries(specs).map(([name, spec]) => [
      name,
      spec === null || paused.has(name) ? null : [getFunctionName(spec.query), spec.args],
    ]),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the reads' value, not the object.
  const queries = useMemo(() => {
    const out: Parameters<typeof useQueries>[0] = {};
    for (const [name, spec] of Object.entries(specs)) {
      if (spec !== null && !paused.has(name)) out[name] = { query: spec.query, args: spec.args };
    }
    return out;
  }, [key]);
  const got = useQueries(queries) as Record<string, unknown>;

  // Declared after `useQueries`, so the paused render's subscription has dropped the read before
  // this puts it back.
  useEffect(() => {
    if (paused.size > 0) setPaused(new Set());
  }, [paused]);

  const retry = useCallback((name: string) => {
    setPaused((now) => new Set([...now, name]));
  }, []);

  // A failure keeps its identity while the same error stands, so a block's props don't churn.
  const failures = useRef(new Map<string, { error: Error; failure: ReadFailure }>());
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(specs)) {
    const value = got[name];
    if (value instanceof Error) {
      let held = failures.current.get(name);
      if (held === undefined || held.error !== value) {
        held = { error: value, failure: { failed: true, retry: () => retry(name) } };
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
