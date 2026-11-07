import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { convexReact, fakes, resetFakes } from '@/components/skater/testMocks';
import { FEED_FILTERS_STORAGE_KEY } from './feedFilters';

vi.mock('convex/react', () => convexReact);

const { resetFeedFiltersStoreForTests, useFeedFilters } = await import('./feedFiltersStore');

const stored = () => JSON.parse(window.localStorage.getItem(FEED_FILTERS_STORAGE_KEY) ?? 'null');

beforeEach(() => {
  resetFakes();
  resetFeedFiltersStoreForTests();
  window.localStorage.clear();
});

describe('useFeedFilters (D166)', () => {
  it('loads the local working copy once and shares it with every reader', () => {
    window.localStorage.setItem(FEED_FILTERS_STORAGE_KEY, JSON.stringify({ noSnow: true }));
    const feed = renderHook(() => useFeedFilters());
    const map = renderHook(() => useFeedFilters());
    expect(feed.result.current.value).toEqual({ noSnow: true });
    act(() => feed.result.current.set({ recencyHours: 24 }));
    // The map reads the feed's row, not a copy of its own.
    expect(map.result.current.value).toEqual({ recencyHours: 24 });
    expect(stored()).toEqual({ recencyHours: 24 });
  });

  it('reconciles once against the profile: a local row wins, an empty one takes the server’s', () => {
    fakes.queries.set('profiles:current', { feedFilterPrefs: { recencyHours: 48 } });
    const { result } = renderHook(() => useFeedFilters());
    expect(result.current.value).toEqual({ recencyHours: 48 });
    expect(stored()).toEqual({ recencyHours: 48 });

    // Once per session: a later reader doesn't reconcile again over the row the skater changed.
    act(() => result.current.set({}));
    renderHook(() => useFeedFilters());
    expect(result.current.value).toEqual({});
  });

  it('syncs a change to the server when signed in, and only locally when not', () => {
    fakes.queries.set('profiles:current', { feedFilterPrefs: undefined });
    const signedIn = renderHook(() => useFeedFilters());
    act(() => signedIn.result.current.set({ noSnow: true }));
    expect(fakes.mutations.get('profiles:setFeedFilterPrefs')).toHaveBeenCalledWith({
      filters: { noSnow: true },
    });

    resetFakes();
    resetFeedFiltersStoreForTests();
    fakes.queries.set('profiles:current', null);
    const signedOut = renderHook(() => useFeedFilters());
    act(() => signedOut.result.current.set({ recencyHours: 6 }));
    expect(fakes.mutations.get('profiles:setFeedFilterPrefs')).not.toHaveBeenCalled();
    expect(stored()).toEqual({ recencyHours: 6 });
  });

  it('waits for the profile before reconciling, and keeps a local row over the server’s', () => {
    window.localStorage.setItem(FEED_FILTERS_STORAGE_KEY, JSON.stringify({ noSnow: true }));
    const { result, rerender } = renderHook(() => useFeedFilters());
    expect(result.current.value).toEqual({ noSnow: true });
    fakes.queries.set('profiles:current', { feedFilterPrefs: { recencyHours: 48 } });
    rerender();
    expect(result.current.value).toEqual({ noSnow: true });
    expect(fakes.mutations.get('profiles:setFeedFilterPrefs')).not.toHaveBeenCalled();
  });
});
