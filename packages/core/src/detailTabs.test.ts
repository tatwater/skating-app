import { describe, expect, it, vi } from 'vitest';
import {
  createDetailTabStore,
  DEFAULT_DETAIL_TAB,
  DETAIL_TAB_LABELS,
  DETAIL_TABS,
  isDetailTab,
} from './detailTabs';

describe('detail tab vocabulary', () => {
  it('has a label for every tab and the default is one of them', () => {
    for (const tab of DETAIL_TABS) expect(DETAIL_TAB_LABELS[tab]).toBeTruthy();
    expect(isDetailTab(DEFAULT_DETAIL_TAB)).toBe(true);
    expect(DETAIL_TABS[0]).toBe(DEFAULT_DETAIL_TAB);
  });

  it('rejects anything that is not a tab id', () => {
    expect(isDetailTab('planning')).toBe(true);
    expect(isDetailTab('Planning')).toBe(false);
    expect(isDetailTab('weather')).toBe(false);
    expect(isDetailTab(undefined)).toBe(false);
    expect(isDetailTab(0)).toBe(false);
  });
});

describe('createDetailTabStore', () => {
  it('starts on the default and remembers a choice', () => {
    const store = createDetailTabStore();
    expect(store.get()).toBe(DEFAULT_DETAIL_TAB);
    store.set('planning');
    expect(store.get()).toBe('planning');
  });

  it('ignores an unknown value instead of throwing — a stale deep link is not an error', () => {
    const store = createDetailTabStore('reporting');
    store.set('weather');
    store.set(null);
    expect(store.get()).toBe('reporting');
  });

  it('notifies subscribers only on a real change, and stops after unsubscribe', () => {
    const store = createDetailTabStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.set(DEFAULT_DETAIL_TAB); // no-op: same tab
    expect(listener).not.toHaveBeenCalled();
    store.set('planning');
    expect(listener).toHaveBeenCalledTimes(1);
    store.set('bogus'); // ignored, so no notification either
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    store.set('reporting');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('returns a stable snapshot between changes', () => {
    // `useSyncExternalStore` re-renders whenever `get()` returns a new reference; a string is
    // compared by value, so two reads with no change in between must be `Object.is`-equal.
    const store = createDetailTabStore();
    expect(Object.is(store.get(), store.get())).toBe(true);
  });
});
