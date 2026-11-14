import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The tabs' reads: one `useQueries` keyed on the reads' values, three states per read, and Try
 * again letting go of every failed read — everywhere it is held — then asking again.
 */

const mocks = vi.hoisted(() => ({
  /** What the server answers, by function name. */
  results: new Map<string, unknown>(),
  /** Every queries object `useQueries` was handed, in order. */
  seen: [] as Array<Record<string, { query: unknown; args: unknown }>>,
  /** What went to Sentry, and whether a DSN is set. */
  exceptions: [] as unknown[],
  sentry: true,
}));

vi.mock('@sentry/tanstackstart-react', () => ({
  captureException: (e: unknown) => mocks.exceptions.push(e),
}));
vi.mock('@/lib/env', () => ({
  isConfigured: {
    get sentry() {
      return mocks.sentry;
    },
  },
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQueries: (queries: Record<string, { query: never; args: unknown }>) => {
      mocks.seen.push(queries);
      return Object.fromEntries(
        Object.entries(queries).map(([key, { query }]) => [
          key,
          mocks.results.get(getFunctionName(query)),
        ]),
      );
    },
  };
});

import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { getFunctionName } from 'convex/server';

import { FAILED, RETRY_GAP_MS, read, readId, useTabReads } from './useTabReads';

const waterBodyId = 'wb1' as Id<'waterBodies'>;
const PLACES = getFunctionName(api.bodyConsole.places);
const EXTRAS = getFunctionName(api.bodyConsole.consoleExtras);

beforeEach(() => {
  mocks.results.clear();
  mocks.seen.length = 0;
  mocks.exceptions.length = 0;
  mocks.sentry = true;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const useBoth = ({ skipExtras = false }: { skipExtras?: boolean } = {}) =>
  useTabReads({
    places: read(api.bodyConsole.places, { waterBodyId }),
    extras: skipExtras ? null : read(api.bodyConsole.consoleExtras, { waterBodyId }),
  });

describe('useTabReads', () => {
  it('gives each read in its state: loading, its value, or failed — and skips a null read', () => {
    const towns = { towns: ['Enfield'], counties: [], states: ['NH'] };
    mocks.results.set(PLACES, towns);
    mocks.results.set(EXTRAS, new Error('down'));
    const { result, rerender } = renderHook((p: { skipExtras?: boolean }) => useBoth(p), {
      initialProps: {},
    });
    expect(result.current.reads.places).toBe(towns);
    expect(result.current.reads.extras).toBe(FAILED);
    rerender({ skipExtras: true });
    expect(result.current.reads.extras).toBeUndefined();
    expect(Object.keys(mocks.seen.at(-1) ?? {})).toEqual(['places']);
  });

  it('hands useQueries the same object while the reads’ values stay the same', () => {
    const { rerender } = renderHook(() => useBoth());
    rerender();
    rerender();
    expect(new Set(mocks.seen).size).toBe(1);
  });

  it('lets go of a failed read for a moment on Try again, everywhere it is held, then asks again', () => {
    mocks.results.set(PLACES, new Error('down'));
    mocks.results.set(EXTRAS, { hasBathymetry: true });
    const tab = renderHook(() => useBoth());
    // Another hook holding the same read — the tab's map drawing.
    const map = renderHook(() =>
      useTabReads({ places: read(api.bodyConsole.places, { waterBodyId }) }),
    );
    act(() => tab.result.current.retry());
    // Dropped in both; the read that didn't fail is kept.
    expect(Object.keys(mocks.seen.at(-1) ?? {})).toEqual([]);
    expect(tab.result.current.reads.places).toBeUndefined();
    expect(map.result.current.reads.places).toBeUndefined();
    expect(tab.result.current.reads.extras).toEqual({ hasBathymetry: true });
    mocks.results.set(PLACES, { towns: [], counties: [], states: [] });
    act(() => {
      vi.advanceTimersByTime(RETRY_GAP_MS);
    });
    expect(tab.result.current.reads.places).toEqual({ towns: [], counties: [], states: [] });
    expect(map.result.current.reads.places).toEqual({ towns: [], counties: [], states: [] });
  });

  it('tells Sentry of a failed read once, however many hold it, and again if Try again fails', () => {
    const down = new Error('down');
    // A read this file's other tests never fail, so its report is this test's alone.
    const useDam = () =>
      useTabReads({
        dam: read(api.bodyConsole.places, { waterBodyId: 'wb-dam' as Id<'waterBodies'> }),
      });
    mocks.results.set(PLACES, down);
    const tab = renderHook(useDam);
    renderHook(useDam);
    tab.rerender();
    expect(mocks.exceptions).toEqual([down]);
    act(() => tab.result.current.retry());
    act(() => {
      vi.advanceTimersByTime(RETRY_GAP_MS);
    });
    expect(mocks.exceptions).toEqual([down, down]);
  });

  it('tells Sentry nothing without a DSN, and still says the read failed', () => {
    mocks.sentry = false;
    mocks.results.set(PLACES, new Error('down'));
    const { result } = renderHook(() =>
      useTabReads({
        quiet: read(api.bodyConsole.places, { waterBodyId: 'wb-quiet' as Id<'waterBodies'> }),
      }),
    );
    expect(result.current.reads.quiet).toBe(FAILED);
    expect(mocks.exceptions).toEqual([]);
  });

  it('does nothing on Try again when nothing failed', () => {
    mocks.results.set(PLACES, { towns: [], counties: [], states: [] });
    const { result } = renderHook(() => useBoth());
    const before = mocks.seen.length;
    act(() => result.current.retry());
    expect(mocks.seen.length).toBe(before);
  });
});

describe('the helpers', () => {
  it('names a read by its function and arguments', () => {
    expect(readId(read(api.bodyConsole.places, { waterBodyId }))).toBe(
      `${PLACES}:{"waterBodyId":"wb1"}`,
    );
  });
});
