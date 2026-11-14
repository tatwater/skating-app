import * as Sentry from '@sentry/tanstackstart-react';
import { useQueries } from 'convex/react';
import {
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  getFunctionName,
} from 'convex/server';
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';

import { isConfigured } from '@/lib/env';
import { ReadFailed } from './kit-candidates/read-failed';

/**
 * **How a Body console tab reads, and reads again.** Shared by Imagery, Hazards, Standing and Links:
 * this file (the hook, the retry and the tab's boundary) and the note it draws
 * (`kit-candidates/read-failed.tsx`) are the whole read layer, kept small for the integrator to
 * fold into the console's one shared layer.
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
 *   a key (`hazards:<bodyId>`). **Nothing here assumes this hook is the only holder**: a reader
 *   outside it (the console's frame, another tab's hook) keeps a failed subscription alive, and
 *   then a retry simply shows the same failure again — still drawn as a failure, never as data.
 * - **A failure is still heard.** Each read that turns failed goes to Sentry once (only with a
 *   DSN), and a crash below a tab is caught by {@link TabReadBoundary}, which reports it and offers
 *   *Try again* too.
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
  useReportFailures(key, got);
  return { got, retry, live };
}

/**
 * Sends each read to Sentry as it turns failed — once per failure, not once per render (the client
 * may hand back a fresh `Error` each time it is asked), and again if it fails after a retry.
 */
function useReportFailures(key: string, got: Record<string, unknown>): void {
  const failing = useRef(new Set<string>());
  const failed = Object.entries(got)
    .filter(([, v]) => v instanceof Error)
    .map(([k]) => k)
    .sort()
    .join('\u0000');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on which reads failed, by name.
  useEffect(() => {
    const now = new Set(failed === '' ? [] : failed.split('\u0000'));
    for (const name of now) {
      if (failing.current.has(name) || !isConfigured.sentry) continue;
      const error = got[name];
      Sentry.captureException(error, { tags: { read: `${key}/${name}` } });
    }
    failing.current = now;
  }, [failed, key]);
}

type BoundaryProps = {
  /** The tab's reads key: Try again re-runs them, and a new key (another body) starts clean. */
  readsKey: string;
  children: ReactNode;
};

/**
 * Catches a crash below a tab and draws the failure note in its place, with *Try again*, which runs
 * the tab's reads afresh ({@link retryReads}) and draws the tab again. Whatever it catches goes to
 * Sentry (only with a DSN): a bug drawn as *couldn't be shown* is never a bug nobody hears about.
 */
export class TabReadBoundary extends Component<
  BoundaryProps,
  { failed: boolean; readsKey: string }
> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failed: false, readsKey: props.readsKey };
  }

  static getDerivedStateFromError(): { failed: true } {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: { failed: boolean; readsKey: string },
  ): { failed: false; readsKey: string } | null {
    return props.readsKey !== state.readsKey ? { failed: false, readsKey: props.readsKey } : null;
  }

  override componentDidCatch(error: unknown): void {
    if (isConfigured.sentry) Sentry.captureException(error);
  }

  private readonly retry = () => {
    retryReads(this.props.readsKey);
    this.setState({ failed: false });
  };

  override render(): ReactNode {
    return this.state.failed ? (
      <ReadFailed data-slot="tab-failed" onRetry={this.retry}>
        This tab couldn’t be shown
      </ReadFailed>
    ) : (
      this.props.children
    );
  }
}

/** Forget every pause (tests start clean). */
export function resetReadPauses(): void {
  paused.clear();
}
