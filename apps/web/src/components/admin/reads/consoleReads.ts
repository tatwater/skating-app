import * as Sentry from '@sentry/tanstackstart-react';
import { useQueries } from 'convex/react';
import {
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  getFunctionName,
} from 'convex/server';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { isConfigured } from '@/lib/env';

/**
 * **The console's one read layer** — the Bodies list's counts and preview, and the Body console's
 * frame, Shape, every tab and each tab's map (`useData`) read through it, so one read is one thing
 * wherever it is held. (The list's paginated read stays on Convex's paginated hook, under the kit
 * `ReadBoundary`.)
 *
 * - **Three states, never a throw.** Each read is `undefined` while on its way (a skeleton), a
 *   {@link ReadFailure} when the server refused or failed it (a note with *Try again*), or its value
 *   (`null` inside a value is the server's *not recorded*). Convex's `useQueries` hands a failure
 *   back as an `Error` rather than throwing it, so a failed read takes down its own block, never
 *   the console. A read passed as `null` is not made (a capability the viewer lacks).
 * - **Keyed on values.** The reads are rebuilt only when a function or an argument changes — never
 *   on an object rebuilt each render, the shape that once crashed a page with "Too many
 *   re-renders".
 * - **Try again lets go everywhere.** The client keeps one subscription per function and arguments,
 *   shared by every holder — the frame, the open tab, its map — and re-runs a failed one only once
 *   *every* holder has let go of it. So a retry is recorded in **one registry of paused reads**, by
 *   the read's identity: every holder drops it for a commit, then takes it back, and the server
 *   runs it afresh. A reader outside Convex (Imagery's archive) joins the same registry through
 *   {@link useExternalRead} and lets go too.
 * - **Pending, not the old failure.** From *Try again* until the fresh answer lands, the read is a
 *   failure marked `pending`: the note holds (*Trying again…*) rather than flashing the old failure
 *   again — the client can still hand back the failure it held for a moment after the read is
 *   taken back. A failure seen once the read has been back on its way (or after
 *   {@link PENDING_HOLD_MS}) is the fresh answer.
 * - **Heard once.** A failed read goes to Sentry (only with a DSN) once per failure, by the read's
 *   identity — the client hands back a fresh `Error` every time it is asked, so an `Error` object is
 *   no key — and again only after the read has recovered and failed anew.
 */

// ── Reads and their states ──────────────────────────────────────────────────────────────────

/** A read that failed, and the way to run it again. Stable while the same failure stands. */
export interface ReadFailure {
  readonly failed: true;
  /** *Try again* was pressed and the fresh answer hasn't landed: hold the note, don't re-show it. */
  readonly pending: boolean;
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

/** One failure for several reads: *Try again* runs each again; pending while every one is. */
export function retryAll(failures: readonly ReadFailure[]): ReadFailure {
  return {
    failed: true,
    pending: failures.length > 0 && failures.every((f) => f.pending),
    retry: () => {
      for (const f of failures) f.retry();
    },
  };
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

/** A read's identity: its function and its arguments, as values. */
export function readId(spec: ReadSpec): string {
  return JSON.stringify([getFunctionName(spec.query), spec.args]);
}

// ── The registry: reads let go of for a Try again, and what each is waiting for ─────────────

/** How long a read stays let go if no holder takes it back (its one holder unmounted mid-retry). */
const PAUSE_LIMIT_MS = 1_000;
/** How long a failure seen straight after a retry is held as pending before it counts as fresh. */
export const PENDING_HOLD_MS = 3_000;

const paused = new Set<string>();
/** Reads let go of that some holder has rendered without: its own effect will take them back. */
const dropped = new Set<string>();
/** How many mounted holders hold each read. */
const holders = new Map<string, number>();
/** Reads tried again whose fresh answer hasn't landed: whether they've been back on their way. */
const retrying = new Map<string, { sawLoading: boolean; until: number }>();
/** The failures that have gone to Sentry, by read: cleared when the read answers again. */
const reported = new Set<string>();
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

/**
 * Try these reads again: let go of each in every holder for a commit (the holders take it back
 * once each has committed its drop), and hold each as pending until its fresh answer lands.
 */
export function retryReads(ids: Iterable<string>): void {
  const now = Date.now();
  let any = false;
  for (const id of ids) {
    if (paused.has(id)) continue;
    paused.add(id);
    retrying.set(id, { sawLoading: false, until: now + PAUSE_LIMIT_MS + PENDING_HOLD_MS });
    any = true;
    dropped.delete(id);
    setTimeout(() => limit(id), PAUSE_LIMIT_MS);
  }
  if (!any) return;
  emit();
  // A failure still held when the wait runs out is the fresh answer: draw it.
  setTimeout(emit, PAUSE_LIMIT_MS + PENDING_HOLD_MS + 1);
}

/**
 * The pause's limit: let go of a read no mounted holder is there to take back (its holder unmounted
 * mid-retry). A holder still mounted that hasn't rendered its drop yet (a slow render) keeps the
 * pause — lifting it unseen would mean no holder ever dropped the read, and the server would never
 * run it again — and the limit waits again.
 */
function limit(id: string): void {
  if (!paused.has(id)) return;
  if (!dropped.has(id) && (holders.get(id) ?? 0) > 0) {
    setTimeout(() => limit(id), PAUSE_LIMIT_MS);
    return;
  }
  resume([id]);
}

function resume(ids: Iterable<string>): void {
  let any = false;
  for (const id of ids) if (paused.delete(id)) any = true;
  if (any) emit();
}

/** Forget every pause, wait and report (tests start clean). */
export function resetConsoleReads(): void {
  paused.clear();
  dropped.clear();
  retrying.clear();
  reported.clear();
}

/** One failure object per read and retry state, so a block's props don't churn. */
const failures = new Map<string, ReadFailure>();
function failureOf(id: string, pending: boolean): ReadFailure {
  const key = `${pending ? 'p' : 'f'}${id}`;
  let failure = failures.get(key);
  if (failure === undefined) {
    failure = { failed: true, pending, retry: () => retryReads([id]) };
    failures.set(key, failure);
  }
  return failure;
}

/**
 * A retry's wait, unless no holder was there to see it through: a wait whose read was never seen
 * back on its way before its hold ran out had its holders unmount mid-retry, so it is forgotten —
 * a holder mounted later sees its first load as a load, never as *Trying again…* (a live holder
 * marks `sawLoading` within a task of the read being taken back, long before the hold ends).
 */
function liveWait(id: string): { sawLoading: boolean; until: number } | undefined {
  const wait = retrying.get(id);
  if (wait !== undefined && !wait.sawLoading && !paused.has(id) && Date.now() >= wait.until) {
    retrying.delete(id);
    return undefined;
  }
  return wait;
}

/**
 * What a holder draws for one read, given what the client handed back. While a retry waits, the
 * read is a pending failure — through the pause, through its loading, and through a failure the
 * client still held — until a value lands, or a failure seen after the read was back on its way.
 */
function stateOf(id: string, value: unknown): { state: unknown; settled: boolean } {
  const wait = liveWait(id);
  if (wait === undefined) {
    return { state: value instanceof Error ? failureOf(id, false) : value, settled: false };
  }
  if (paused.has(id) || value === undefined) return { state: failureOf(id, true), settled: false };
  if (value instanceof Error && !wait.sawLoading && Date.now() < wait.until) {
    return { state: failureOf(id, true), settled: false };
  }
  return { state: value instanceof Error ? failureOf(id, false) : value, settled: true };
}

// ── The hooks ───────────────────────────────────────────────────────────────────────────────

/**
 * The reads `specs` names, each in its state, with `retry` (every read here that failed, tried
 * again), `live` (`false` while one of them is let go of for a retry), whether any failed, and
 * whether every failure is `pending` (tried again, the fresh answer not in).
 */
export function useConsoleReadSet<S extends ReadSpecs>(
  specs: S,
): { reads: Reads<S>; retry: () => void; live: boolean; failed: boolean; pending: boolean } {
  // Every holder renders again when a read is let go of, taken back, or its wait runs out.
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const ids = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) {
    if (spec !== null) ids.set(name, readId(spec));
  }
  const asked = JSON.stringify(
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
  }, [asked]);
  const got = useQueries(queries) as Record<string, unknown>;

  const reads: Record<string, unknown> = {};
  const loading: string[] = [];
  const settled: string[] = [];
  const failedIds: string[] = [];
  const answered: string[] = [];
  const errors: Array<{ id: string; error: Error }> = [];
  for (const name of Object.keys(specs)) {
    const id = ids.get(name);
    const value = got[name];
    if (id === undefined) {
      reads[name] = undefined;
      continue;
    }
    const { state, settled: done } = stateOf(id, value);
    reads[name] = state;
    if (done) settled.push(id);
    if (retrying.has(id) && !paused.has(id) && value === undefined) loading.push(id);
    if (isFailed(state)) failedIds.push(id);
    if (value instanceof Error && isFailed(state) && !state.pending)
      errors.push({ id, error: value });
    if (value !== undefined && !(value instanceof Error)) answered.push(id);
  }

  // Declared after `useQueries`, so this holder has dropped a paused read by the time it runs;
  // taken back a task later, once every other holder has committed its drop too.
  const letGo = [...ids.values()].filter((id) => paused.has(id));
  const letGoKey = letGo.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on which reads are let go, by value.
  useEffect(() => {
    if (letGo.length === 0) return;
    for (const id of letGo) dropped.add(id);
    const timer = setTimeout(() => resume(letGo), 0);
    return () => clearTimeout(timer);
  }, [letGoKey]);

  // Which reads this holder holds while mounted: the pause's limit never lets go of one unseen.
  const heldKey = [...ids.values()].join('\n');
  useEffect(() => {
    const held = heldKey === '' ? [] : heldKey.split('\n');
    for (const id of held) holders.set(id, (holders.get(id) ?? 0) + 1);
    return () => {
      for (const id of held) {
        const n = (holders.get(id) ?? 1) - 1;
        if (n <= 0) holders.delete(id);
        else holders.set(id, n);
      }
    };
  }, [heldKey]);

  // The wait's bookkeeping, after the commit: a read back on its way, a fresh answer landed.
  const bookKey = JSON.stringify([loading, settled]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the reads' progress, by value.
  useEffect(() => {
    for (const id of loading) {
      const wait = retrying.get(id);
      if (wait !== undefined) wait.sawLoading = true;
    }
    if (settled.length > 0) {
      for (const id of settled) retrying.delete(id);
      emit();
    }
  }, [bookKey]);

  // Heard once per failure, by the read; a read that answers again may be heard again.
  const heardKey = JSON.stringify([errors.map((e) => e.id), answered]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on which reads failed or answered.
  useEffect(() => {
    for (const id of answered) reported.delete(id);
    for (const { id, error } of errors) {
      if (reported.has(id)) continue;
      reported.add(id);
      if (isConfigured.sentry) Sentry.captureException(error, { tags: { read: id } });
    }
  }, [heardKey]);

  const failedKey = failedIds.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on which reads failed, by value.
  const retry = useCallback(() => retryReads(failedIds), [failedKey]);
  return {
    reads: reads as Reads<S>,
    retry,
    live: letGo.length === 0,
    failed: failedIds.length > 0,
    // Tried again, and every failed read is still waiting on its fresh answer.
    pending:
      failedIds.length > 0 &&
      Object.values(reads).every((r) => !isFailed(r) || (r as ReadFailure).pending),
  };
}

/** The reads `specs` names, each in its state (see {@link useConsoleReadSet}). */
export function useConsoleReads<S extends ReadSpecs>(specs: S): Reads<S> {
  return useConsoleReadSet(specs).reads;
}

/**
 * A reader outside Convex (Imagery's archive) in the same registry, under its own `id`: `live` is
 * `false` for the commit a retry lets go of it — the reader drops what it holds and asks again — and
 * `retry` lets go of it everywhere it is held.
 */
export function useExternalRead(id: string): { live: boolean; retry: () => void } {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const isPaused = paused.has(id);
  useEffect(() => {
    if (!isPaused) return;
    const timer = setTimeout(() => resume([id]), 0);
    return () => clearTimeout(timer);
  }, [isPaused, id]);
  const retry = useCallback(() => {
    retryReads([id]);
    // An external reader's fresh answer is its own to say: no pending wait is held for it.
    retrying.delete(id);
  }, [id]);
  return { live: !isPaused, retry };
}
