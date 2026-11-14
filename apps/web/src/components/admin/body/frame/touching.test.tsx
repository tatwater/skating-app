import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The bodies that touch this one, each read by id: loading until every read lands, one failure for
 * any that failed (its *Try again* re-runs each), a body no longer listed left out, and a list that
 * keeps its identity while its reads do.
 */

const mocks = vi.hoisted(() => ({ results: new Map<string, unknown>() }));

vi.mock('convex/react', () => ({
  useQueries: (queries: Record<string, { args: { waterBodyId: string } }>) =>
    Object.fromEntries(
      Object.entries(queries).map(([k, q]) => [k, mocks.results.get(q.args.waterBodyId)]),
    ),
}));

import { isFailed, type ReadFailure } from '@/components/admin/reads/consoleReads';
import { MASCOMA_RECORD, NEIGHBOR_POLYGON } from './bodyFixtures';
import { type TouchingFacts, useNeighbors } from './touching';

const body = (id: string, name: string) => ({
  available: true,
  body: { ...MASCOMA_RECORD, _id: id, name, polygon: NEIGHBOR_POLYGON },
});
const facts = (ids: string[] | null): TouchingFacts => ({
  touchingBodyIds: ids,
  touchingCapped: false,
});

beforeEach(() => mocks.results.clear());

describe('useNeighbors', () => {
  it('reads nothing until the touching test is in, and is empty when nothing touches', () => {
    const { result, rerender } = renderHook(({ f }) => useNeighbors(f), {
      initialProps: { f: undefined as TouchingFacts | undefined },
    });
    expect(result.current).toBeUndefined();
    rerender({ f: facts([]) });
    expect(result.current).toEqual([]);
    rerender({ f: facts(null) });
    expect(result.current).toEqual([]);
  });

  it('waits for every neighbor, then names each one still listed', () => {
    mocks.results.set('a', body('a', 'Crystal Lake'));
    const f = facts(['a', 'b']);
    const { result, rerender } = renderHook(() => useNeighbors(f));
    expect(result.current).toBeUndefined();
    mocks.results.set('b', { available: false });
    rerender();
    expect(result.current).toEqual([{ id: 'a', name: 'Crystal Lake', polygon: NEIGHBOR_POLYGON }]);
  });

  it('keeps the list’s identity while its reads keep theirs', () => {
    mocks.results.set('a', body('a', 'Crystal Lake'));
    const f = facts(['a']);
    const { result, rerender } = renderHook(() => useNeighbors(f));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    mocks.results.set('a', body('a', 'Crystal Pond'));
    rerender();
    expect(result.current).not.toBe(first);
  });

  it('fails as one when any neighbor’s read fails, and tries each failed one again', () => {
    mocks.results.set('a', new Error('down'));
    mocks.results.set('b', body('b', 'B'));
    const f = facts(['a', 'b']);
    const { result } = renderHook(() => useNeighbors(f));
    expect(isFailed(result.current)).toBe(true);
    mocks.results.set('a', body('a', 'A'));
    vi.useFakeTimers();
    try {
      act(() => (result.current as ReadFailure).retry());
      // Let go of for a commit, then asked again.
      act(() => {
        vi.runOnlyPendingTimers();
      });
    } finally {
      vi.useRealTimers();
    }
    expect(result.current).toEqual([
      { id: 'a', name: 'A', polygon: NEIGHBOR_POLYGON },
      { id: 'b', name: 'B', polygon: NEIGHBOR_POLYGON },
    ]);
  });
});
