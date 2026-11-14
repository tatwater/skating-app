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
  PENDING_HOLD_MS,
  type ReadFailure,
  read,
  resetConsoleReads,
  retryAll,
  useConsoleReadSet,
  useConsoleReads,
  useExternalRead,
} from './consoleReads';

const ID = 'j57mascoma0000000000000000000000' as Id<'waterBodies'>;
const set = (ref: Parameters<typeof getFunctionName>[0], v: unknown) =>
  mocks.results.set(getFunctionName(ref), v);

beforeEach(() => {
  resetConsoleReads();
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

  it('keeps a failure’s identity while the read stays failed, whatever Error object comes back', () => {
    set(api.waterBodies.get, new Error('boom'));
    const { result, rerender } = renderHook(() =>
      useConsoleReads({ body: read(api.waterBodies.get, { waterBodyId: ID }) }),
    );
    const first = result.current.body;
    rerender();
    expect(result.current.body).toBe(first);
    // The client hands back a fresh Error each time it is asked: still the same failure.
    set(api.waterBodies.get, new Error('again'));
    rerender();
    expect(result.current.body).toBe(first);
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
      // A commit without it (the subscription drops), the note held as pending…
      expect(mocks.calls.at(-1)).toEqual(['subAreas']);
      expect(result.current.body).toMatchObject({ failed: true, pending: true });
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
      expect(frame.result.current.body).toMatchObject({ failed: true, pending: true });
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

  it('forgets a retry whose holder left mid-retry: a later holder’s first load is a load', () => {
    set(api.waterBodies.get, new Error('boom'));
    vi.useFakeTimers();
    try {
      const first = renderHook(() =>
        useConsoleReads({ body: read(api.waterBodies.get, { waterBodyId: ID }) }),
      );
      act(() => (first.result.current.body as ReadFailure).retry());
      // The tab is left before the read comes back on its way.
      first.unmount();
      act(() => {
        vi.advanceTimersByTime(PENDING_HOLD_MS + 1_100);
      });
      // Opened again later, the read is on its way: a load, never "Trying again…".
      set(api.waterBodies.get, undefined);
      const later = renderHook(() =>
        useConsoleReadSet({ body: read(api.waterBodies.get, { waterBodyId: ID }) }),
      );
      expect(later.result.current.reads.body).toBeUndefined();
      expect(later.result.current.failed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports nothing to Sentry without a DSN', () => {
    set(api.waterBodies.get, new Error('boom'));
    renderHook(() => useConsoleReads({ body: read(api.waterBodies.get, { waterBodyId: ID }) }));
    expect(mocks.sentry).not.toHaveBeenCalled();
  });

  it('reports a failure once by the read — not once per Error object — and again only after it recovers', () => {
    mocks.sentryOn = true;
    const body = () => read(api.waterBodies.get, { waterBodyId: ID });
    set(api.waterBodies.get, new Error('boom'));
    // Held by the frame and a tab, re-rendered with a fresh Error each time: heard once.
    const frame = renderHook(() => useConsoleReads({ body: body() }));
    const tab = renderHook(() => useConsoleReads({ body: body() }));
    set(api.waterBodies.get, new Error('boom, again'));
    frame.rerender();
    tab.rerender();
    expect(mocks.sentry).toHaveBeenCalledTimes(1);
    // It answers, then fails anew: heard again.
    set(api.waterBodies.get, { available: false });
    frame.rerender();
    set(api.waterBodies.get, new Error('a new failure'));
    frame.rerender();
    tab.rerender();
    expect(mocks.sentry).toHaveBeenCalledTimes(2);
  });

  it('runs a read held by the frame and a tab once, retried from either side or both', () => {
    set(api.waterBodies.get, new Error('boom'));
    const body = () => read(api.waterBodies.get, { waterBodyId: ID });
    const frame = renderHook(() => useConsoleReads({ body: body() }));
    const tab = renderHook(() => useConsoleReads({ body: body() }));
    mocks.calls.length = 0;
    set(api.waterBodies.get, { available: false });
    vi.useFakeTimers();
    try {
      // Both notes pressed: one retry, one drop and one taking back in each holder.
      act(() => {
        (frame.result.current.body as ReadFailure).retry();
        (tab.result.current.body as ReadFailure).retry();
      });
      act(() => {
        vi.runOnlyPendingTimers();
      });
    } finally {
      vi.useRealTimers();
    }
    const asks = mocks.calls.map((c) => c.includes('body'));
    // Each holder: dropped (false) then asked again (true) — never dropped twice.
    expect(asks.filter((a) => !a)).toHaveLength(2);
    expect(asks.slice(asks.indexOf(false))).not.toContain(undefined);
    expect(frame.result.current.body).toEqual({ available: false });
    expect(tab.result.current.body).toEqual({ available: false });
  });

  it('holds a retried read as pending through a failure the client still held, until the fresh answer', () => {
    set(api.waterBodies.get, new Error('boom'));
    const { result, rerender } = renderHook(() =>
      useConsoleReads({ body: read(api.waterBodies.get, { waterBodyId: ID }) }),
    );
    vi.useFakeTimers();
    try {
      act(() => (result.current.body as ReadFailure).retry());
      // Taken back, and the client still hands back the old failure: pending, not re-shown.
      act(() => {
        vi.advanceTimersByTime(1);
      });
      rerender();
      expect(result.current.body).toMatchObject({ failed: true, pending: true });
      // The read goes back on its way, then fails afresh: that is the fresh answer.
      set(api.waterBodies.get, undefined);
      rerender();
      expect(result.current.body).toMatchObject({ failed: true, pending: true });
      set(api.waterBodies.get, new Error('still failing'));
      rerender();
      expect(result.current.body).toMatchObject({ failed: true, pending: false });
      // A second retry whose old failure never clears: shown again once the hold runs out.
      act(() => (result.current.body as ReadFailure).retry());
      act(() => {
        vi.advanceTimersByTime(1);
      });
      rerender();
      expect(result.current.body).toMatchObject({ pending: true });
      act(() => {
        vi.advanceTimersByTime(PENDING_HOLD_MS + 1_100);
      });
      rerender();
      expect(result.current.body).toMatchObject({ failed: true, pending: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets an external reader go on a retry, live again after the commit', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useExternalRead('archive:1'));
      expect(result.current.live).toBe(true);
      act(() => result.current.retry());
      expect(result.current.live).toBe(false);
      act(() => {
        vi.runOnlyPendingTimers();
      });
      expect(result.current.live).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says which reads failed, whether it is live, and retries all of them at once', () => {
    set(api.waterBodies.get, new Error('boom'));
    set(api.subAreas.listForBody, new Error('boom'));
    const { result } = renderHook(() =>
      useConsoleReadSet({
        body: read(api.waterBodies.get, { waterBodyId: ID }),
        subAreas: read(api.subAreas.listForBody, { waterBodyId: ID }),
      }),
    );
    expect(result.current.failed).toBe(true);
    expect(result.current.live).toBe(true);
    vi.useFakeTimers();
    try {
      act(() => result.current.retry());
      expect(result.current.live).toBe(false);
      expect(mocks.calls.at(-1)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes one failure of several, pending only while every one is', () => {
    const a: ReadFailure = { failed: true, pending: true, retry: vi.fn() };
    const b: ReadFailure = { failed: true, pending: false, retry: vi.fn() };
    const both = retryAll([a, b]);
    expect(both.pending).toBe(false);
    expect(retryAll([a]).pending).toBe(true);
    both.retry();
    expect(a.retry).toHaveBeenCalledTimes(1);
    expect(b.retry).toHaveBeenCalledTimes(1);
  });
});

describe('a loadable', () => {
  const failure: ReadFailure = { failed: true, pending: false, retry: () => {} };

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
