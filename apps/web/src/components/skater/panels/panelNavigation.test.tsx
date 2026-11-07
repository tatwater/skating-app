import { render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChromeStore } from '@/stores/chromeStore';

import { fakes, resetFakes } from '../testMocks';
import { panelFakes, panelRouter, resetPanelFakes } from './panelTestMocks';

vi.mock('@tanstack/react-router', () => panelRouter);
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));

import {
  escBelongsElsewhere,
  focusReturnTarget,
  LAKE_SIDEBAR_SELECTOR,
  panelLinkState,
  panelSourceOf,
  panelTriggerKey,
  panelTriggerProps,
  resolvePanelSource,
  restoreFocus,
  useClosePanel,
  usePanelViewed,
} from './panelNavigation';

beforeEach(() => {
  resetFakes();
  resetPanelFakes();
  useChromeStore.setState({ overlay: null });
});
afterEach(() => {
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
});

describe('the door a card came through', () => {
  it('reads back what a door passed, and nothing else', () => {
    expect(panelSourceOf(panelLinkState('water_body'))).toBe('water_body');
    expect(panelSourceOf({ panelSource: 'notification', __TSR_index: 3 })).toBe('notification');
    expect(panelSourceOf({ panelSource: 'somewhere' })).toBeUndefined();
    expect(panelSourceOf({ panelSource: 3 })).toBeUndefined();
    expect(panelSourceOf(null)).toBeUndefined();
    expect(panelSourceOf('water_body')).toBeUndefined();
  });

  it('counts a card with no door and no history as deep-linked, and an unnamed in-app door as nothing', () => {
    expect(resolvePanelSource(undefined, false)).toBe('deep_link');
    expect(resolvePanelSource({}, true)).toBeNull();
    expect(resolvePanelSource(panelLinkState('map'), true)).toBe('map');
    expect(resolvePanelSource(panelLinkState('map'), false)).toBe('map');
  });

  it('keys the rows that open a card', () => {
    expect(panelTriggerKey('hazard', 'h1')).toBe('hazard:h1');
    expect(panelTriggerProps('report', 'r1')).toEqual({ 'data-panel-trigger': 'report:r1' });
  });
});

describe('useClosePanel', () => {
  const lake = { bodyId: 'w1' };

  it('steps back when it was opened from the lake it names, with history to pop', () => {
    panelFakes.canGoBack = true;
    panelFakes.state = panelLinkState('water_body');
    const { result } = renderHook(() => useClosePanel(lake));
    result.current();
    expect(panelFakes.back).toHaveBeenCalledOnce();
    expect(panelFakes.navigate).not.toHaveBeenCalled();
  });

  it('replaces to the lake on a deep link — never history.back()', () => {
    const { result } = renderHook(() => useClosePanel({ bodyId: 'w1', subAreaId: 's1' }));
    result.current();
    expect(panelFakes.back).not.toHaveBeenCalled();
    expect(panelFakes.navigate).toHaveBeenCalledWith({
      to: '/water/$id',
      params: { id: 'w1' },
      search: { sub: 's1' },
      replace: true,
    });
  });

  it('replaces to the lake when the in-app door was somewhere else', () => {
    panelFakes.canGoBack = true;
    panelFakes.state = panelLinkState('notification');
    const { result } = renderHook(() => useClosePanel(lake));
    result.current();
    expect(panelFakes.back).not.toHaveBeenCalled();
    expect(panelFakes.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/water/$id', search: {}, replace: true }),
    );
  });

  it('goes to Explore when the lake is unknown', () => {
    panelFakes.canGoBack = true;
    panelFakes.state = panelLinkState('water_body');
    const { result } = renderHook(() => useClosePanel(null));
    result.current();
    expect(panelFakes.back).not.toHaveBeenCalled();
    expect(panelFakes.navigate).toHaveBeenCalledWith({ to: '/', replace: true });
  });
});

describe('usePanelViewed', () => {
  it('fires once per card, with the door', () => {
    panelFakes.state = panelLinkState('water_body');
    panelFakes.canGoBack = true;
    const { rerender } = renderHook(({ id }) => usePanelViewed('report_viewed', id), {
      initialProps: { id: 'r1' },
    });
    rerender({ id: 'r1' });
    expect(fakes.capture).toHaveBeenCalledTimes(1);
    expect(fakes.capture).toHaveBeenCalledWith('report_viewed', { source: 'water_body' });
    rerender({ id: 'r2' });
    expect(fakes.capture).toHaveBeenCalledTimes(2);
  });

  it('says deep_link with no door and no history', () => {
    renderHook(() => usePanelViewed('hazard_viewed', 'h1'));
    expect(fakes.capture).toHaveBeenCalledWith('hazard_viewed', { source: 'deep_link' });
  });

  it('counts nothing for an in-app door that didn’t say', () => {
    panelFakes.canGoBack = true;
    renderHook(() => usePanelViewed('bounty_viewed', 'b1'));
    expect(fakes.capture).not.toHaveBeenCalled();
  });
});

describe('escBelongsElsewhere', () => {
  it('yields Esc to an open top-bar plate', () => {
    expect(escBelongsElsewhere()).toBe(false);
    useChromeStore.setState({ overlay: 'search' });
    expect(escBelongsElsewhere()).toBe(true);
  });

  it('yields Esc to the report sheet open over the card', () => {
    window.history.replaceState(null, '', '/report/r1?post=new');
    expect(escBelongsElsewhere()).toBe(true);
  });
});

describe('focus return', () => {
  const sync = (fn: () => void) => fn();

  it('prefers the opener when it survived, then the row, then the sidebar', () => {
    render(
      <div>
        <button type="button">opener</button>
        <a href="/report/r1" data-panel-trigger="report:r1">
          row
        </a>
        <aside data-slot="lake-sidebar">sidebar</aside>
      </div>,
    );
    const opener = document.querySelector('button') as HTMLElement;
    const row = document.querySelector('a') as HTMLElement;
    const sidebar = document.querySelector(LAKE_SIDEBAR_SELECTOR) as HTMLElement;
    expect(focusReturnTarget({ opener, key: 'report:r1' })).toBe(opener);
    expect(focusReturnTarget({ opener: null, key: 'report:r1' })).toBe(row);
    expect(focusReturnTarget({ opener: null, key: 'report:r2' })).toBe(sidebar);
    sidebar.remove();
    expect(focusReturnTarget({ opener: null, key: 'report:r2' })).toBeNull();
  });

  it('focuses the row once it appears, giving the region a programmatic stop', () => {
    const queue: Array<() => void> = [];
    restoreFocus({ opener: null, key: 'report:r1' }, { schedule: (fn) => queue.push(fn) });
    // The lake page hasn't rendered its rows yet: keep looking.
    queue.shift()?.();
    expect(queue).toHaveLength(1);
    render(<aside data-slot="lake-sidebar">sidebar</aside>);
    queue.shift()?.();
    const sidebar = document.querySelector(LAKE_SIDEBAR_SELECTOR) as HTMLElement;
    expect(document.activeElement).toBe(sidebar);
    expect(sidebar).toHaveAttribute('tabindex', '-1');
  });

  it('settles on the page when nothing better arrives', () => {
    render(
      <main data-slot="skater-page" tabIndex={-1}>
        page
      </main>,
    );
    restoreFocus({ opener: null, key: 'report:r1' }, { frames: 2, schedule: sync });
    expect(document.activeElement).toBe(document.querySelector('main'));
  });

  it('leaves focus alone when the page already placed it', () => {
    render(
      <div>
        <input aria-label="search" />
        <a href="/report/r1" data-panel-trigger="report:r1">
          row
        </a>
      </div>,
    );
    const input = document.querySelector('input') as HTMLElement;
    input.focus();
    restoreFocus({ opener: null, key: 'report:r1' }, { schedule: sync });
    expect(document.activeElement).toBe(input);
  });

  it('runs on animation frames by default', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn) => {
      fn(0);
      return 0;
    });
    render(
      <a href="/hazard/h1" data-panel-trigger="hazard:h1">
        row
      </a>,
    );
    restoreFocus({ opener: null, key: 'hazard:h1' });
    expect(document.activeElement).toBe(document.querySelector('a'));
    raf.mockRestore();
  });
});
