import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hrefWith, useEscapeToClose } from './lakeNav';
import { exploreSearchSchema, lakeSearchSchema } from './lakeSearch';
import {
  markWaterBodyOpenSource,
  resetWaterBodyOpenSource,
  takeWaterBodyOpenSource,
} from './openSource';

describe('the Explore search params (D242)', () => {
  it('keeps a known act and drops anything else', () => {
    expect(exploreSearchSchema.parse({ act: 'request' })).toEqual({ act: 'request' });
    expect(exploreSearchSchema.parse({ act: 'nonsense' })).toEqual({});
    expect(exploreSearchSchema.parse({})).toEqual({});
  });

  it('defaults the lake to Reports and degrades every bad value', () => {
    expect(lakeSearchSchema.parse({})).toEqual({ tab: 'reports' });
    expect(
      lakeSearchSchema.parse({
        tab: 'weather',
        sub: 'bay1',
        act: 'imagery',
        band: 'vh',
        frame: '2027-01-12',
      }),
    ).toEqual({ tab: 'weather', sub: 'bay1', act: 'imagery', band: 'vh', frame: '2027-01-12' });
    expect(
      lakeSearchSchema.parse({ tab: 'x', sub: '', act: 'x', band: 'x', frame: 'tomorrow' }),
    ).toEqual({ tab: 'reports' });
  });

  it('folds the old ?hazard=true into the hazard action, and never overrides an act', () => {
    expect(lakeSearchSchema.parse({ hazard: true })).toEqual({ tab: 'reports', act: 'hazard' });
    expect(lakeSearchSchema.parse({ hazard: 'true' })).toEqual({ tab: 'reports', act: 'hazard' });
    expect(lakeSearchSchema.parse({ hazard: true, act: 'bounty' })).toEqual({
      tab: 'reports',
      act: 'bounty',
    });
    expect(lakeSearchSchema.parse({ hazard: 'yes' })).toEqual({ tab: 'reports' });
  });
});

describe('which surface opened a lake (D240)', () => {
  beforeEach(() => resetWaterBodyOpenSource());

  it('takes a fresh mark once', () => {
    markWaterBodyOpenSource('list', 1_000);
    expect(takeWaterBodyOpenSource('/water/a', { now: 2_000, entryPath: '/' })).toBe('list');
    expect(takeWaterBodyOpenSource('/water/b', { now: 3_000, entryPath: '/' })).toBe('map');
  });

  it('ignores a stale mark', () => {
    markWaterBodyOpenSource('search', 1_000);
    expect(takeWaterBodyOpenSource('/water/a', { now: 10_000, entryPath: '/' })).toBe('map');
  });

  it('calls the document’s own entry a deep link, once', () => {
    expect(takeWaterBodyOpenSource('/water/a', { now: 0, entryPath: '/water/a' })).toBe(
      'deep_link',
    );
    expect(takeWaterBodyOpenSource('/water/a', { now: 0, entryPath: '/water/a' })).toBe('map');
  });

  it('reads the entry path from the navigation timing entry', () => {
    const spy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue([{ name: 'https://gli.test/water/z?tab=about' } as PerformanceEntry]);
    expect(takeWaterBodyOpenSource('/water/z')).toBe('deep_link');
    spy.mockReturnValue([{ name: 'not a url' } as PerformanceEntry]);
    resetWaterBodyOpenSource();
    expect(takeWaterBodyOpenSource('/water/z')).toBe('map');
    spy.mockReturnValue([]);
    resetWaterBodyOpenSource();
    expect(takeWaterBodyOpenSource('/water/z')).toBe('map');
    spy.mockRestore();
  });
});

describe('navigation', () => {
  it('edits the query, keeping every param it doesn’t name', () => {
    expect(hrefWith('/water/a', '?post=new&tab=about', { tab: null, act: 'hazard' })).toBe(
      '/water/a?post=new&act=hazard',
    );
    expect(hrefWith('/water/a', '?tab=about', { tab: null })).toBe('/water/a');
  });

  describe('one Esc per screen', () => {
    afterEach(() => {
      for (const el of document.body.querySelectorAll('[role="dialog"]')) el.remove();
    });

    const esc = () => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      act(() => {
        window.dispatchEvent(event);
      });
      return event;
    };

    it('closes the view while it is open, and only then', () => {
      const close = vi.fn();
      const { rerender } = renderHook(({ on }) => useEscapeToClose(on, close), {
        initialProps: { on: true },
      });
      expect(esc().defaultPrevented).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
      rerender({ on: false });
      esc();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('stands aside for other keys, a handled Esc, and a modal over the page', () => {
      const close = vi.fn();
      renderHook(() => useEscapeToClose(true, close));
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      });
      const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      handled.preventDefault();
      act(() => {
        window.dispatchEvent(handled);
      });
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      document.body.append(dialog);
      esc();
      expect(close).not.toHaveBeenCalled();
    });
  });
});
