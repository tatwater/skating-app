import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The console's reads, each with its own state: a read on its way is `undefined`, a failed one a
 * failure whose *Try again* drops the subscription for a render and subscribes afresh, and the
 * reads are keyed on their value so a new object each render never re-subscribes.
 */

const mocks = vi.hoisted(() => ({
  /** What each read answers, by function name. */
  results: new Map<string, unknown>(),
  /** Each call's requested names, in order. */
  calls: [] as string[][],
  /** Each distinct requests object `useQueries` was handed. */
  objects: new Set<object>(),
  sentry: vi.fn(),
  sentryOn: false,
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQueries: (queries: Record<string, { query: never; args: unknown }>) => {
      mocks.objects.add(queries);
      mocks.calls.push(Object.keys(queries));
      return Object.fromEntries(
        Object.entries(queries).map(([k, q]) => [k, mocks.results.get(getFunctionName(q.query))]),
      );
    },
  };
});
vi.mock('@sentry/tanstackstart-react', () => ({ captureException: mocks.sentry }));
vi.mock('@/lib/env', () => ({
  isConfigured: {
    get sentry() {
      return mocks.sentryOn;
    },
  },
}));

import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { getFunctionName } from 'convex/server';
import {
  isFailed,
  type Loadable,
  loaded,
  mapLoadable,
  type ReadFailure,
  read,
  useConsoleReads,
} from './consoleReads';

const ID = 'j57mascoma0000000000000000000000' as Id<'waterBodies'>;
const set = (ref: Parameters<typeof getFunctionName>[0], v: unknown) =>
  mocks.results.set(getFunctionName(ref), v);

beforeEach(() => {
  mocks.results.clear();
  mocks.calls.length = 0;
  mocks.objects.clear();
  mocks.sentry.mockClear();
  mocks.sentryOn = false;
});

describe('useConsoleReads', () => {
  it('hands each read its own state: loading, failed or its answer, and skips a null read', () => {
    set(api.bodyConsole.consoleExtras, { towns: ['Enfield, NH'] });
    set(api.bodyConsole.history, new Error('boom'));
    const { result } = renderHook(() =>
      useConsoleReads({
        extras: read(api.bodyConsole.consoleExtras, { waterBodyId: ID }),
        history: read(api.bodyConsole.history, { waterBodyId: ID }),
        body: read(api.waterBodies.get, { waterBodyId: ID }),
        skipped: null,
      }),
    );
    expect(result.current.extras).toEqual({ towns: ['Enfield, NH'] });
    expect(isFailed(result.current.history)).toBe(true);
    expect(result.current.body).toBeUndefined();
    expect(result.current.skipped).toBeUndefined();
    expect(mocks.calls.at(-1)).toEqual(['extras', 'history', 'body']);
  });

  it('keeps one requests object while the reads’ values stay the same', () => {
    const { rerender } = renderHook(() =>
      useConsoleReads({ body: read(api.waterBodies.get, { waterBodyId: ID }) }),
    );
    rerender();
    rerender();
    expect(mocks.objects.size).toBe(1);
  });

  it('keeps a failure’s identity while the same error stands', () => {
    const error = new Error('boom');
    set(api.waterBodies.get, error);
    const { result, rerender } = renderHook(() =>
      useConsoleReads({ body: read(api.waterBodies.get, { waterBodyId: ID }) }),
    );
    const first = result.current.body;
    rerender();
    expect(result.current.body).toBe(first);
    set(api.waterBodies.get, new Error('again'));
    rerender();
    expect(result.current.body).not.toBe(first);
  });

  it('tries again by dropping the read for a render, then subscribing afresh', () => {
    set(api.waterBodies.get, new Error('boom'));
    const { result } = renderHook(() =>
      useConsoleReads({
        body: read(api.waterBodies.get, { waterBodyId: ID }),
        subAreas: read(api.subAreas.listForBody, { waterBodyId: ID }),
      }),
    );
    const failure = result.current.body as ReadFailure;
    mocks.calls.length = 0;
    set(api.waterBodies.get, { available: false });
    vi.useFakeTimers();
    try {
      act(() => failure.retry());
      // A commit without it (the subscription drops)…
      expect(mocks.calls.at(-1)).toEqual(['subAreas']);
      expect(result.current.body).toBeUndefined();
      // …then it is asked for again.
      act(() => {
        vi.runOnlyPendingTimers();
      });
    } finally {
      vi.useRealTimers();
    }
    expect(mocks.calls.at(-1)).toEqual(['body', 'subAreas']);
    expect(result.current.body).toEqual({ available: false });
  });

  it('lets go of a failed read in every block holding it, so Try again reaches the server', () => {
    set(api.waterBodies.get, new Error('boom'));
    const body = () => read(api.waterBodies.get, { waterBodyId: ID });
    // The frame and the open tab hold the same read: one subscription, shared.
    const frame = renderHook(() => useConsoleReads({ body: body() }));
    const tab = renderHook(() =>
      useConsoleReads({
        body: body(),
        subAreas: read(api.subAreas.listForBody, { waterBodyId: ID }),
      }),
    );
    mocks.calls.length = 0;
    set(api.waterBodies.get, { available: false });
    vi.useFakeTimers();
    try {
      act(() => (tab.result.current.body as ReadFailure).retry());
      // Both dropped it — the frame's hook too, though its own note wasn't pressed…
      expect(mocks.calls).toContainEqual([]);
      expect(mocks.calls).toContainEqual(['subAreas']);
      expect(frame.result.current.body).toBeUndefined();
      // …then both asked for it again.
      act(() => {
        vi.runOnlyPendingTimers();
      });
    } finally {
      vi.useRealTimers();
    }
    expect(frame.result.current.body).toEqual({ available: false });
    expect(tab.result.current.body).toEqual({ available: false });
  });

  it('reports a failure to Sentry once, and only with a DSN', () => {
    const error = new Error('boom');
    set(api.waterBodies.get, error);
    const { rerender } = renderHook(() =>
      useConsoleReads({ body: read(api.waterBodies.get, { waterBodyId: ID }) }),
    );
    expect(mocks.sentry).not.toHaveBeenCalled();
    mocks.sentryOn = true;
    set(api.waterBodies.get, new Error('second'));
    rerender();
    rerender();
    expect(mocks.sentry).toHaveBeenCalledTimes(1);
  });
});

describe('a loadable', () => {
  const failure: ReadFailure = { failed: true, retry: () => {} };

  it('maps an answer and passes loading and failure through', () => {
    expect(mapLoadable<number, number>(2, (n) => n * 2)).toBe(4);
    expect(mapLoadable<number, number>(undefined, (n) => n * 2)).toBeUndefined();
    expect(mapLoadable<number, number>(failure, (n) => n * 2)).toBe(failure);
    expect(mapLoadable<number | null, string>(null, (n) => String(n))).toBe('null');
  });

  it('reads as loaded only when it is an answer', () => {
    const values: Loadable<number>[] = [3, undefined, failure];
    expect(values.map(loaded)).toEqual([3, undefined, undefined]);
    expect(isFailed({ failed: true })).toBe(false);
    expect(isFailed(null)).toBe(false);
  });
});
